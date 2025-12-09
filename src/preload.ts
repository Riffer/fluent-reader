import { contextBridge, ipcRenderer } from "electron"
import settingsBridge from "./bridges/settings"
import utilsBridge from "./bridges/utils"
import dbBridge from "./bridges/db"
import { createArticleExtractorBridge } from "./bridges/article-extractor"
import { p2pBridge } from "./bridges/p2p"
import { p2pLanBridge } from "./bridges/p2p-lan"

contextBridge.exposeInMainWorld("settings", settingsBridge)
contextBridge.exposeInMainWorld("db", dbBridge)
contextBridge.exposeInMainWorld("utils", utilsBridge)
contextBridge.exposeInMainWorld("p2p", p2pBridge)
contextBridge.exposeInMainWorld("p2pLan", p2pLanBridge)

// ipcRenderer für Webview-Zoom-Kommunikation (eingeschränkt auf benötigte Channels)
const limitedIpcRenderer = {
    // Vom Renderer an den Main-Prozess
    send: (channel: string, ...args: any[]) => {
        if (["webview-zoom-changed", "set-webview-zoom", "set-zoom-overlay-setting", "set-global-mobile-mode"].includes(channel)) {
            ipcRenderer.send(channel, ...args)
        }
    },
    // Vom Main-Prozess an den Renderer
    on: (channel: string, listener: Function) => {
        if (["set-webview-zoom", "webview-zoom-changed", "set-zoom-overlay-setting"].includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
        }
    },
    removeAllListeners: (channel: string) => {
        ipcRenderer.removeAllListeners(channel)
    },
    // Article extraction via IPC
    invoke: (channel: string, ...args: any[]) => {
        if (["extract-article", "extract-article-html", "get-app-path", "toggle-app-devtools", "enable-device-emulation", "disable-device-emulation"].includes(channel)) {
            return ipcRenderer.invoke(channel, ...args)
        }
    },
}

contextBridge.exposeInMainWorld("ipcRenderer", limitedIpcRenderer)

// Create article extractor bridge with access to ipcRenderer
const articleExtractorBridge = createArticleExtractorBridge(limitedIpcRenderer)
contextBridge.exposeInMainWorld("articleExtractor", articleExtractorBridge)

// Deaktiviere Standard-Zoom-Shortcuts im Hauptfenster
// Der Zoom wird nur in WebView-Tags über deren Preload-Script verwaltet
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey) {
            // Blockiere Standard-Zoom-Shortcuts
            if (e.key === '+' || e.key === '=' || e.key === 'Add') {
                e.preventDefault()
            } else if (e.key === '-' || e.key === 'Subtract') {
                e.preventDefault()
            } else if (e.key === '0' || e.key === 'Numpad0') {
                e.preventDefault()
            }
        }
    }, true)
}


