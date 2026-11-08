const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cleanup", {
  scan: (keepDays) => ipcRenderer.invoke("cleanup:scan", keepDays),
  trash: (ids) => ipcRenderer.invoke("cleanup:trash", ids),
  reveal: (id) => ipcRenderer.invoke("cleanup:reveal", id),
});
