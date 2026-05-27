const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcherApi", {
  detectJava: () => ipcRenderer.invoke("detect-java"),
  launchProfile: (profile) => ipcRenderer.invoke("launch-profile", profile),
  runningInstances: () => ipcRenderer.invoke("running-instances"),
  killInstance: (instanceId) => ipcRenderer.invoke("kill-instance", instanceId),
  openPath: (target) => ipcRenderer.invoke("open-path", target),
  microsoftLogin: (clientId) => ipcRenderer.invoke("microsoft-login", clientId),
  microsoftReauth: (accountId, clientId) => ipcRenderer.invoke("microsoft-reauth", accountId, clientId),
  searchMods: (options) => ipcRenderer.invoke("search-mods", options),
  installProject: (options) => ipcRenderer.invoke("install-project", options),
  listProfileContent: (profile) => ipcRenderer.invoke("list-profile-content", profile),
  toggleProfileContent: (options) => ipcRenderer.invoke("toggle-profile-content", options),
  deleteProfileContent: (options) => ipcRenderer.invoke("delete-profile-content", options),
  skinProfile: (account) => ipcRenderer.invoke("skin-profile", account),
  importMinecraft: (options) => ipcRenderer.invoke("import-minecraft", options),
  minecraftVersions: () => ipcRenderer.invoke("minecraft-versions"),
  onMicrosoftDeviceCode: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("microsoft-device-code", listener);
    return () => ipcRenderer.removeListener("microsoft-device-code", listener);
  },
  onLaunchLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on("launch-log", listener);
    return () => ipcRenderer.removeListener("launch-log", listener);
  }
});
