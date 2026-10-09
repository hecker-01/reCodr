const { contextBridge, ipcRenderer, webUtils } = require("electron");

const INVOKE_CHANNELS = new Set([
  "get-binary-config",
  "verify-binary-config",
  "save-binary-config",
  "get-language-prefs",
  "save-language-prefs",
  "get-settings",
  "save-settings",
  "reset-settings",
  "get-video-info",
  "detect-encoders",
  "select-input-files",
  "select-output-folder",
  "file-status",
  "load-queue",
  "save-queue",
  "open-path",
  "open-external",
  "get-app-version",
  "encode-video",
  "encode-custom",
  "encode-sample",
  "cancel-encode",
]);
const EVENT_CHANNELS = new Set([
  "encode-progress",
  "encode-stderr",
  "encode-notice",
]);

contextBridge.exposeInMainWorld(
  "recodr",
  Object.freeze({
    invoke(channel, ...args) {
      if (!INVOKE_CHANNELS.has(channel)) {
        return Promise.reject(
          new Error(`IPC channel is not allowed: ${String(channel)}`),
        );
      }
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel, callback) {
      if (!EVENT_CHANNELS.has(channel))
        throw new Error(`IPC event is not allowed: ${String(channel)}`);
      if (typeof callback !== "function")
        throw new TypeError("Event listener must be a function.");
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    filePath(file) {
      if (!file) return null;
      try {
        if (webUtils && typeof webUtils.getPathForFile === "function") {
          const filePath = webUtils.getPathForFile(file);
          if (typeof filePath === "string" && filePath) return filePath;
        }
      } catch (_) {
        // Electron versions before webUtils exposed File.path directly.
      }
      return typeof file.path === "string" && file.path ? file.path : null;
    },
  }),
);
