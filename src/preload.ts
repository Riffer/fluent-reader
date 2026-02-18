import { contextBridge, ipcRenderer } from "electron"
import settingsBridge from "./bridges/settings"
import utilsBridge from "./bridges/utils"
import dbBridge from "./bridges/db"
import { createArticleExtractorBridge } from "./bridges/article-extractor"
import { p2pBridge } from "./bridges/p2p"
import { p2pLanBridge } from "./bridges/p2p-lan"
import { contentViewPoolBridge } from "./bridges/content-view-pool"
import translationBridge from "./bridges/translation"

contextBridge.exposeInMainWorld("settings", settingsBridge)
contextBridge.exposeInMainWorld("db", dbBridge)
contextBridge.exposeInMainWorld("utils", utilsBridge)
contextBridge.exposeInMainWorld("p2p", p2pBridge)
contextBridge.exposeInMainWorld("p2pLan", p2pLanBridge)
// Pool is now the only ContentView implementation
contextBridge.exposeInMainWorld("contentViewPool", contentViewPoolBridge)
contextBridge.exposeInMainWorld("translation", translationBridge)

// ipcRenderer for ContentView Pool communication (restricted to required channels)
const limitedIpcRenderer = {
    // From Renderer to Main process
    send: (channel: string, ...args: any[]) => {
        const allowedSendChannels = [
            "content-view-zoom-changed",
            "content-view-set-css-zoom", 
            "set-zoom-overlay-setting", 
            "set-global-mobile-mode",
            // Content View Pool channels
            "cvp-prefetch",
            "cvp-prefetch-info",
            "cvp-set-bounds",
            "cvp-set-visibility",
            "cvp-set-reading-direction",
            "cvp-set-zoom-factor",
            "cvp-set-css-zoom",
            "cvp-zoom-step",
            "cvp-zoom-reset",
            "cvp-set-visual-zoom",
            "cvp-send",
            "cvp-clear",
            "cvp-focus",
            "cvp-set-mobile-mode",
            "cvp-set-user-agent",
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
            // Content View Pool channels (forwarded from active view)
            "content-view-loading",
            "content-view-error",
            "content-view-navigated",
            "content-view-context-menu",
            "content-view-input",
            "content-view-js-dialog",
            "content-view-video-fullscreen",
            // Window state events (for ContentView bounds updates)
            "maximized",
            "unmaximized",
            "enter-fullscreen",
            "leave-fullscreen",
            // Content View Pool channels
            "cvp-navigation-complete",
            "cvp-request-prefetch-info",
            "cvp-error",
            "cvp-prefetch-status",  // Prefetch status for traffic light indicator
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
            // Content View Pool channels
            "cvp-navigate",
            "cvp-navigate-with-settings",
            "cvp-get-status",
            "cvp-execute-js",
            "cvp-get-id",
            "cvp-open-devtools",
            "cvp-is-devtools-opened",
            "cvp-close-devtools",
            "cvp-reload",
            "cvp-get-url",
            "cvp-get-css-zoom-level-async",
            "cvp-go-back",
            "cvp-go-forward",
            "cvp-can-go-back",
            "cvp-can-go-forward",
            "cvp-get-zoom-factor",
            "cvp-load-html",
            "cvp-navigate-via-js",
            "cvp-stop",
            "cvp-capture-screen",
            "cvp-recreate",
            "cvp-nuke",
            // Cookie persistence for Pool
            "cvp-get-cookies-for-host",
            "cvp-get-all-cookies",
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


