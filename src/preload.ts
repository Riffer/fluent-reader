import { contextBridge, ipcRenderer } from "electron"
import settingsBridge from "./bridges/settings"
import utilsBridge from "./bridges/utils"

contextBridge.exposeInMainWorld("settings", settingsBridge)
contextBridge.exposeInMainWorld("utils", utilsBridge)

// ipcRenderer für Webview-Zoom-Kommunikation (eingeschränkt auf benötigte Channels)
contextBridge.exposeInMainWorld("ipcRenderer", {
    // Vom Renderer an den Main-Prozess
    send: (channel: string, ...args: any[]) => {
        if (["webview-zoom-changed", "set-webview-zoom"].includes(channel)) {
            ipcRenderer.send(channel, ...args)
        }
    },
    // Vom Main-Prozess an den Renderer
    on: (channel: string, listener: Function) => {
        if (["set-webview-zoom", "webview-zoom-changed"].includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
        }
    },
    removeAllListeners: (channel: string) => {
        ipcRenderer.removeAllListeners(channel)
    },
})


