import { ipcRenderer } from "electron"
import {
    TouchBarTexts,
    WindowStateListenerType,
} from "../schema-types"
import { IObjectWithKey } from "@fluentui/react"

const utilsBridge = {
    platform: process.platform,

    getVersion: (): string => {
        return ipcRenderer.sendSync("get-version")
    },

    openExternal: (url: string, background = false) => {
        console.log("openExternal!")
        ipcRenderer.invoke("open-external", url, background)
    },

    openInReaderWindow: (url: string, title?: string) => {
        console.log("openInReaderWindow:", url)
        ipcRenderer.invoke("open-in-reader-window", url, title)
    },

    showErrorBox: (title: string, content: string, copy?: string) => {
        ipcRenderer.invoke("show-error-box", title, content, copy)
    },

    showMessageBox: async (
        title: string,
        message: string,
        confirm: string,
        cancel: string,
        defaultCancel = false,
        type = "none"
    ) => {
        return (await ipcRenderer.invoke(
            "show-message-box",
            title,
            message,
            confirm,
            cancel,
            defaultCancel,
            type
        )) as boolean
    },

    showSaveDialog: async (filters: Electron.FileFilter[], path: string) => {
        let result = (await ipcRenderer.invoke(
            "show-save-dialog",
            filters,
            path
        )) as boolean
        if (result) {
            return (result: string, errmsg: string) => {
                ipcRenderer.invoke("write-save-result", result, errmsg)
            }
        } else {
            return null
        }
    },

    showOpenDialog: async (filters: Electron.FileFilter[]) => {
        return (await ipcRenderer.invoke("show-open-dialog", filters)) as string
    },

    getCacheSize: async (): Promise<number> => {
        return await ipcRenderer.invoke("get-cache")
    },

    clearCache: async () => {
        await ipcRenderer.invoke("clear-cache")
    },

    addMainContextListener: (
        callback: (pos: [number, number], text: string) => any
    ) => {
        ipcRenderer.removeAllListeners("window-context-menu")
        ipcRenderer.on("window-context-menu", (_, pos, text) => {
            callback(pos, text)
        })
    },

    // Note: WebView listeners removed - ContentView uses window.contentView.on* instead
    // See bridges/content-view.ts for onContextMenu, onInput, onError

    writeClipboard: (text: string) => {
        ipcRenderer.invoke("write-clipboard", text)
    },

    closeWindow: () => {
        ipcRenderer.invoke("close-window")
    },
    minimizeWindow: () => {
        ipcRenderer.invoke("minimize-window")
    },
    maximizeWindow: () => {
        ipcRenderer.invoke("maximize-window")
    },
    isMaximized: () => {
        return ipcRenderer.sendSync("is-maximized") as boolean
    },
    isFullscreen: () => {
        return ipcRenderer.sendSync("is-fullscreen") as boolean
    },
    toggleFullscreen: () => {
        ipcRenderer.invoke("toggle-fullscreen")
    },
    isFocused: () => {
        return ipcRenderer.sendSync("is-focused") as boolean
    },
    focus: () => {
        ipcRenderer.invoke("request-focus")
    },
    requestAttention: () => {
        ipcRenderer.invoke("request-attention")
    },
    addWindowStateListener: (
        callback: (type: WindowStateListenerType, state: boolean) => any
    ) => {
        ipcRenderer.removeAllListeners("maximized")
        ipcRenderer.on("maximized", () => {
            callback(WindowStateListenerType.Maximized, true)
        })
        ipcRenderer.removeAllListeners("unmaximized")
        ipcRenderer.on("unmaximized", () => {
            callback(WindowStateListenerType.Maximized, false)
        })
        ipcRenderer.removeAllListeners("enter-fullscreen")
        ipcRenderer.on("enter-fullscreen", () => {
            callback(WindowStateListenerType.Fullscreen, true)
        })
        ipcRenderer.removeAllListeners("leave-fullscreen")
        ipcRenderer.on("leave-fullscreen", () => {
            callback(WindowStateListenerType.Fullscreen, false)
        })
        ipcRenderer.removeAllListeners("window-focus")
        ipcRenderer.on("window-focus", () => {
            callback(WindowStateListenerType.Focused, true)
        })
        ipcRenderer.removeAllListeners("window-blur")
        ipcRenderer.on("window-blur", () => {
            callback(WindowStateListenerType.Focused, false)
        })
    },

    addTouchBarEventsListener: (callback: (IObjectWithKey) => any) => {
        ipcRenderer.removeAllListeners("touchbar-event")
        ipcRenderer.on("touchbar-event", (_, key: string) => {
            callback({ key: key })
        })
    },
    initTouchBar: (texts: TouchBarTexts) => {
        ipcRenderer.invoke("touchbar-init", texts)
    },
    destroyTouchBar: () => {
        ipcRenderer.invoke("touchbar-destroy")
    },

    initFontList: (): Promise<Array<string>> => {
        return ipcRenderer.invoke("init-font-list")
    },

    // ===== Power Events =====
    
    /**
     * Registriert einen Listener für System-Resume Events (Aufwachen aus Standby)
     * Wird verwendet um Feeds automatisch zu aktualisieren
     */
    addPowerResumeListener: (callback: () => void) => {
        ipcRenderer.removeAllListeners("power-resume")
        ipcRenderer.on("power-resume", () => {
            console.log("[PowerMonitor] System resumed from sleep - triggering callback")
            callback()
        })
    },

    // ===== Cookie Persistence =====
    
    /**
     * Lädt gespeicherte Cookies für eine URL und setzt sie in die Session
     */
    loadPersistedCookies: async (url: string): Promise<{ success: boolean; count: number }> => {
        return await ipcRenderer.invoke("load-persisted-cookies", url)
    },

    /**
     * Speichert aktuelle Session-Cookies für eine URL
     */
    savePersistedCookies: async (url: string): Promise<{ success: boolean; count?: number }> => {
        return await ipcRenderer.invoke("save-persisted-cookies", url)
    },

    /**
     * Löscht gespeicherte Cookies für eine URL
     */
    deletePersistedCookies: async (url: string): Promise<{ success: boolean }> => {
        return await ipcRenderer.invoke("delete-persisted-cookies", url)
    },

    /**
     * Listet alle Hosts mit gespeicherten Cookies auf
     */
    listPersistedCookieHosts: async (): Promise<{ hosts: string[] }> => {
        return await ipcRenderer.invoke("list-persisted-cookie-hosts")
    },
}

declare global {
    interface Window {
        utils: typeof utilsBridge
        fontList: Array<string>
    }
}

export default utilsBridge
