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

// ipcRenderer for ContentView zoom communication (restricted to required channels)
const limitedIpcRenderer = {
    // From Renderer to Main process
    send: (channel: string, ...args: any[]) => {
        const allowedSendChannels = [
            "content-view-zoom-changed",
            "content-view-set-css-zoom", 
            "set-zoom-overlay-setting", 
            "set-global-mobile-mode",
            // Content View channels
            "content-view-set-bounds",
            "content-view-set-visible",
            "content-view-clear",
            "content-view-send",
            "content-view-set-visual-zoom",
            "content-view-set-user-agent",
            "content-view-set-mobile-mode",
            "content-view-focus",
            "content-view-set-zoom-factor",
        ]
        if (allowedSendChannels.includes(channel)) {
            ipcRenderer.send(channel, ...args)
        }
    },
    // From Main process to Renderer
    on: (channel: string, listener: Function) => {
        const allowedOnChannels = [
            "content-view-set-css-zoom",
            "content-view-zoom-changed", 
            "set-zoom-overlay-setting", 
            "power-resume",
            // Content View channels
            "content-view-loading",
            "content-view-loaded",
            "content-view-error",
            "content-view-navigated",
            "content-view-title",
            "content-view-context-menu",
            "content-view-input",
            "content-view-js-dialog",  // JavaScript alert/confirm/prompt from articles
            "content-view-video-fullscreen",  // Video fullscreen state changes
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
            "content-view-load-html",
            "content-view-can-go-back",
            "content-view-can-go-forward",
            "content-view-get-url",
            "content-view-stop",
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

// Disable default zoom shortcuts in main window
// Zoom is managed via ContentView preload script
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


