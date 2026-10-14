// Minimal asar reader/writer — no dependencies.
//
// Layout (reverse-engineered + verified against file integrity hashes):
//   u32[0]  = 4                       (size of the size field itself)
//   u32[4]  = base - 8                (payload size)
//   u32[8]  = base - 12
//   u32[12] = J                       (byte length of the JSON header, unpadded)
//   [16 .. 16+J)  JSON header, then zero padding up to
//   base = align4(16 + J), from where every file's `offset` is counted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HEAD = 16;

function align4(n) {
  return n + ((4 - (n % 4)) % 4);
}

function parseHeader(text) {
  const end = text.lastIndexOf('}');
  if (end < 0) throw new Error('asar: malformed header (no JSON object)');
  return JSON.parse(text.slice(0, end + 1));
}

export function openAsar(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(HEAD);
  fs.readSync(fd, head, 0, HEAD, 0);
  const jsonLen = head.readUInt32LE(12);
  if (head.readUInt32LE(0) !== 4) throw new Error(`asar: unexpected size field ${head.readUInt32LE(0)}`);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, HEAD);
  const header = parseHeader(jb.toString('utf8'));
  const base = align4(HEAD + jsonLen);
  const size = fs.statSync(file).size;
  return {
    file,
    fd,
    header,
    base,
    size,
    read(entry) {
      const buf = Buffer.alloc(entry.size);
      const n = fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
      if (n !== entry.size) throw new Error(`asar: short read for entry (${n}/${entry.size})`);
      return buf;
    },
    entry(p) {
      let cur = header;
      for (const seg of p.split('/')) {
        if (!cur.files || !cur.files[seg]) return null;
        cur = cur.files[seg];
      }
      return cur;
    },
    readPath(p) {
      const e = this.entry(p);
      if (!e) throw new Error(`asar: no such entry ${p}`);
      if (e.files) throw new Error(`asar: ${p} is a directory`);
      if (e.unpacked) throw new Error(`asar: ${p} is stored unpacked`);
      return this.read(e);
    },
    listFiles() {
      const out = [];
      (function walk(node, prefix) {
        for (const [name, val] of Object.entries(node.files || {})) {
          const p = prefix ? `${prefix}/${name}` : name;
          if (val.files) walk(val, p);
          else out.push(p);
        }
      })(header, '');
      return out;
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

// asar convention (verified against the shipped archive): `hash` is the SHA256 of the
// whole file, `blocks` holds one SHA256 per 4 MiB chunk.
function integrityFull(buf) {
  const blockSize = 4194304;
  const blocks = [];
  for (let off = 0; off < buf.length || off === 0; off += blockSize) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(off, off + blockSize)).digest('hex'));
  }
  return { algorithm: 'SHA256', hash: crypto.createHash('sha256').update(buf).digest('hex'), blockSize, blocks };
}

function setPath(root, p, value) {
  const segs = p.split('/');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur.files = cur.files || {};
    if (!cur.files[segs[i]]) cur.files[segs[i]] = { files: {} };
    cur = cur.files[segs[i]];
    if (!cur.files) throw new Error(`asar: ${segs.slice(0, i + 1).join('/')} is a file, cannot nest ${p}`);
  }
  cur.files = cur.files || {};
  cur.files[segs[segs.length - 1]] = value;
}

function getPath(root, p) {
  let cur = root;
  for (const seg of p.split('/')) {
    if (!cur.files || !cur.files[seg]) return null;
    cur = cur.files[seg];
  }
  return cur;
}

export function verify(archive, limit = 0) {
  const files = archive.listFiles();
  let checked = 0;
  const bad = [];
  for (const p of files) {
    const e = archive.entry(p);
    if (!e.integrity || e.unpacked) continue;
    if (limit && checked >= limit) break;
    const buf = archive.read(e);
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (h !== e.integrity.hash) bad.push(p);
    checked++;
  }
  return { checked, bad, total: files.length };
}

/**
 * Rewrite an asar applying { set: {path: Buffer}, add: {path: Buffer} }.
 * Untouched files keep their original bytes; every file's offset, size and
 * SHA256 integrity entry is recomputed.
 */
export function repack(archive, dest, changes = {}) {
  const { set = {}, add = {} } = changes;
  const files = archive.listFiles();
  const forUnknown = Object.keys(set).filter((p) => !files.includes(p));
  if (forUnknown.length) throw new Error(`asar: set() target missing: ${forUnknown.join(', ')}`);
  const dup = Object.keys(add).filter((p) => files.includes(p));
  if (dup.length) throw new Error(`asar: add() target already exists: ${dup.join(', ')}`);

  const header = JSON.parse(JSON.stringify(archive.header));
  for (const p of Object.keys(set)) {
    const buf = set[p];
    const e = getPath(header, p);
    e.size = buf.length;
    e.integrity = integrityFull(buf);
  }
  for (const p of Object.keys(add)) {
    const buf = add[p];
    setPath(header, p, { size: buf.length, offset: '0', integrity: integrityFull(buf) });
  }

  const order = [];
  (function collect(node, prefix) {
    for (const [name, val] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (val.files) collect(val, p);
      else order.push([p, val]);
    }
  })(header, '');

  // Content is laid out in the archive's original byte order (new files go last) so a
  // no-op repack reproduces the original file byte for byte. Offsets are settled from
  // sizes alone, then the payload is streamed — a 300 MB archive never sits in memory.
  const seq = order.map(([p, entry], i) => {
    const prev = files.includes(p) ? archive.entry(p) : null;
    return { p, entry, i, at: prev && !prev.unpacked ? Number(prev.offset) : Number.MAX_SAFE_INTEGER, prev };
  });
  seq.sort((x, y) => (x.at === y.at ? x.i - y.i : x.at - y.at));

  let offset = 0;
  for (const { p, entry, prev } of seq) {
    if (entry.unpacked) continue;
    const next = set[p] || add[p];
    entry.size = next ? next.length : prev.size;
    entry.offset = String(offset);
    offset += entry.size;
  }

  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = align4(16 + json.length) - 8;
  const base = payloadSize + 8;

  const fd = fs.openSync(dest, 'w');
  const pre = Buffer.alloc(HEAD);
  pre.writeUInt32LE(4, 0);
  pre.writeUInt32LE(payloadSize, 4);
  pre.writeUInt32LE(payloadSize - 4, 8);
  pre.writeUInt32LE(json.length, 12);
  fs.writeSync(fd, pre);
  fs.writeSync(fd, json);
  const pad = Buffer.alloc(base - HEAD - json.length);
  if (pad.length) fs.writeSync(fd, pad);

  const COPY = 8 * 1024 * 1024;
  const copyBuf = Buffer.allocUnsafe(COPY);
  for (const { p, entry, prev } of seq) {
    if (entry.unpacked) continue;
    const next = set[p] || add[p];
    if (next) {
      fs.writeSync(fd, next);
      continue;
    }
    if (!prev) throw new Error(`asar: no content for ${p}`);
    let src = base === 0 ? 0 : archive.base + Number(prev.offset);
    let left = prev.size;
    while (left > 0) {
      const n = Math.min(left, COPY);
      const got = fs.readSync(archive.fd, copyBuf, 0, n, src);
      if (got !== n) throw new Error(`asar: short read while copying ${p}`);
      fs.writeSync(fd, copyBuf, 0, n);
      src += n;
      left -= n;
    }
  }
  fs.closeSync(fd);
  return { files: order.length, bytes: base + offset, headerBytes: base };
}

export { align4 };
