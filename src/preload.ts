import { contextBridge, ipcRenderer } from "electron"
import settingsBridge from "./bridges/settings"
import utilsBridge from "./bridges/utils"
import dbBridge from "./bridges/db"
import { createArticleExtractorBridge } from "./bridges/article-extractor"
import { p2pBridge } from "./bridges/p2p"
import { p2pLanBridge } from "./bridges/p2p-lan"
import { contentViewBridge } from "./bridges/content-view"

contextBridge.exposeInMainWorld("settings", settingsBridge)
contextBridge.exposeInMainWorld("db", dbBridge)
contextBridge.exposeInMainWorld("utils", utilsBridge)
contextBridge.exposeInMainWorld("p2p", p2pBridge)
contextBridge.exposeInMainWorld("p2pLan", p2pLanBridge)
contextBridge.exposeInMainWorld("contentView", contentViewBridge)

// ipcRenderer für Webview-Zoom-Kommunikation (eingeschränkt auf benötigte Channels)
const limitedIpcRenderer = {
    // Vom Renderer an den Main-Prozess
    send: (channel: string, ...args: any[]) => {
        const allowedSendChannels = [
            "webview-zoom-changed", 
            "set-webview-zoom", 
            "set-zoom-overlay-setting", 
            "set-global-mobile-mode",
            // Content View channels
            "content-view-set-bounds",
            "content-view-set-visible",
            "content-view-send",
            "content-view-set-visual-zoom",
            "content-view-set-user-agent",
        ]
        if (allowedSendChannels.includes(channel)) {
            ipcRenderer.send(channel, ...args)
        }
    },
    // Vom Main-Prozess an den Renderer
    on: (channel: string, listener: Function) => {
        const allowedOnChannels = [
            "set-webview-zoom", 
            "webview-zoom-changed", 
            "set-zoom-overlay-setting", 
            "power-resume",
            // Content View channels
            "content-view-loading",
            "content-view-loaded",
            "content-view-error",
            "content-view-navigated",
            "content-view-title",
            "content-view-context-menu",
        ]
        if (allowedOnChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
        }
    },
    removeAllListeners: (channel: string) => {
        ipcRenderer.removeAllListeners(channel)
    },
    removeListener: (channel: string, listener: Function) => {
        ipcRenderer.removeListener(channel, listener as any)
    },
    // Article extraction via IPC
    invoke: (channel: string, ...args: any[]) => {
        const allowedInvokeChannels = [
            "extract-article", 
            "extract-article-html", 
            "get-app-path", 
            "toggle-app-devtools", 
            "enable-device-emulation", 
            "disable-device-emulation",
            // Content View channels
            "content-view-navigate",
            "content-view-execute-js",
            "content-view-get-id",
            "content-view-open-devtools",
            "content-view-reload",
            "content-view-go-back",
            "content-view-go-forward",
        ]
        if (allowedInvokeChannels.includes(channel)) {
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


