const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexRefit", {
  onRescan(callback) {
    ipcRenderer.on("codex-refit:rescan", callback);
  },
});
