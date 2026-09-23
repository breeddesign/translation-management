const { contextBridge, ipcRenderer } = require("electron");

// Minimale Brücke: das Setup-Fenster darf ausschließlich den API-Key speichern.
contextBridge.exposeInMainWorld("setup", {
  save: (apiKey) => ipcRenderer.send("setup:save", apiKey),
});
