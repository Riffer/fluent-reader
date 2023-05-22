import { contextBridge } from "electron"
import settingsBridge from "./bridges/settings"
import utilsBridge from "./bridges/utils"
//import { ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("settings", settingsBridge)
contextBridge.exposeInMainWorld("utils", utilsBridge)

/*
document.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.send('webview-disable-external-navigate', true);
});
window.onbeforeunload = function () {
    ipcRenderer.send('webview-disable-external-navigate', false);
}
*/
