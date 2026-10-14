// Appended verbatim to ZCode's preload bundle (out/preload/index.cjs inside app.asar).
// Runs in the preload world of every ZCode window and exposes the read-only query
// bridge to the page. The dashboard panel itself is plain renderer-side JS.
;(function () {
  try {
    var electron = require('electron');
    if (!electron || !electron.contextBridge || !electron.ipcRenderer) throw new Error('electron bridge unavailable');
    electron.contextBridge.exposeInMainWorld('__zcodeTokenUsage', {
      version: '__TOKEN_USAGE_VERSION__',
      query: function () {
        return electron.ipcRenderer.invoke('zcode-token-usage:query');
      },
    });
  } catch (e) {
    console.error('[token-usage] preload bridge failed:', e);
  }
})();
