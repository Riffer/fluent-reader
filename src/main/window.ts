import windowStateKeeper = require("electron-window-state")
import { BrowserWindow, nativeTheme, app, ipcMain, session, webContents } from "electron"
import path from 'path';
import { setThemeListener } from "./settings"
import { setUtilsListeners } from "./utils"
import { setupArticleExtractorHandlers } from "./article-extractor"
import { setupDatabaseIPC, initDatabase, closeDatabase } from "./db-sqlite"
import {
    loadCookiesForHost,
    saveCookiesForHost,
    deleteCookiesForHost,
    getCookiesFromSession,
    setCookiesToSession,
    extractHost,
    listSavedHosts
} from "./cookie-persist"
import { getContentViewManager, destroyContentViewManager } from "./content-view-manager"

/**
 * Set up cookies to bypass consent dialogs and age gates
 */
async function setupBypassCookies() {
    const defaultSession = session.defaultSession
    
    // Reddit: EU Cookie Consent + Over 18 verification
    await defaultSession.cookies.set({
        url: 'https://www.reddit.com',
        name: 'eu_cookie',
        value: '%7B%22opted%22%3Atrue%2C%22nonessential%22%3Atrue%7D', // {"opted":true,"nonessential":true}
        domain: '.reddit.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax'
    }).catch(err => console.error('[cookies] Failed to set eu_cookie:', err))
    
    // Reddit: Confirm over 18 for NSFW content
    await defaultSession.cookies.set({
        url: 'https://www.reddit.com',
        name: 'over18',
        value: '1',
        domain: '.reddit.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax'
    }).catch(err => console.error('[cookies] Failed to set over18:', err))
}

export class WindowManager {
    mainWindow: BrowserWindow = null
    private mainWindowState: windowStateKeeper.State

    constructor() {
        this.init()
    }

    private init = () => {
        // Unterdrücke ERR_ABORTED und ERR_FAILED Fehler die beim schnellen Artikelwechsel auftreten
        process.on('unhandledRejection', (reason: any) => {
            // ERR_ABORTED (-3): Navigation wurde abgebrochen
            // ERR_FAILED (-2): Allgemeiner Fehler (oft bei schnellem Wechsel)
            if (reason?.code === 'ERR_ABORTED' || reason?.errno === -3 ||
                reason?.code === 'ERR_FAILED' || reason?.errno === -2) {
                // Ignoriere diese Fehler - treten auf wenn Navigation während des Ladens abgebrochen wird
                return
            }
            console.error('Unhandled rejection:', reason)
        })
        
        // Filtere Electron-interne GUEST_VIEW_MANAGER_CALL Fehler aus console.error
        const originalConsoleError = console.error
        console.error = (...args: any[]) => {
            // Konvertiere args zu String für Prüfung
            const message = args.map(a => String(a)).join(' ')
            // Filtere ERR_ABORTED und ERR_FAILED Fehler bei GUEST_VIEW_MANAGER_CALL
            if (message.includes('GUEST_VIEW_MANAGER_CALL') && 
                (message.includes('ERR_ABORTED') || message.includes('ERR_FAILED'))) {
                return // Ignoriere diese Fehler
            }
            originalConsoleError.apply(console, args)
        }
        
        app.on("ready", async () => {
            // Set bypass cookies before anything else
            await setupBypassCookies()
            
            this.mainWindowState = windowStateKeeper({
                defaultWidth: 1200,
                defaultHeight: 700,
            })
            this.setListeners()
            this.createWindow()
        })

        // Close database cleanly on app quit
        app.on("before-quit", () => {
            // Destroy content view manager first
            destroyContentViewManager()
            closeDatabase()
        })
    }

    private setListeners = () => {
        setThemeListener(this)
        setUtilsListeners(this)
        setupArticleExtractorHandlers()
        
        // Initialize SQLite database and IPC handlers
        initDatabase()
        setupDatabaseIPC()

        // Weiterleitung von Zoom-Änderungen aus Webviews -> Renderer
        ipcMain.on("webview-zoom-changed", (_event, zoom: number) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send("webview-zoom-changed", zoom)
            }
        })

        // App DevTools öffnen/schließen (stabiler als Webview-DevTools)
        ipcMain.handle("toggle-app-devtools", () => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                if (this.mainWindow.webContents.isDevToolsOpened()) {
                    this.mainWindow.webContents.closeDevTools()
                } else {
                    this.mainWindow.webContents.openDevTools()
                }
            }
        })

        // Speichert für welche webContentsIds die Emulation bereits aktiviert wurde
        const emulatedWebContentsIds = new Set<number>()

        // Device Emulation für Webviews aktivieren (Mobile Mode)
        ipcMain.handle("enable-device-emulation", (_event, webContentsId: number, params: any) => {
            // Deduplizierung: Nur einmal pro webContentsId aktivieren
            if (emulatedWebContentsIds.has(webContentsId)) {
                console.log('[DeviceEmulation] Skipping (already enabled for webContentsId:', webContentsId, ')')
                return true
            }
            
            console.log('[DeviceEmulation] Request received for webContentsId:', webContentsId)
            try {
                const wc = webContents.fromId(webContentsId)
                if (wc && !wc.isDestroyed()) {
                    // User-Agent ändern wenn angegeben
                    if (params.userAgent) {
                        wc.setUserAgent(params.userAgent)
                        console.log('[DeviceEmulation] User-Agent set')
                    }
                    
                    const emulationParams = {
                        screenPosition: params.screenPosition || "mobile",
                        screenSize: params.screenSize || { width: 390, height: 844 },
                        viewPosition: params.viewPosition || { x: 0, y: 0 },
                        deviceScaleFactor: params.deviceScaleFactor || 3,
                        viewSize: params.viewSize || { width: 390, height: 844 },
                        scale: params.scale || 1
                    }
                    console.log('[DeviceEmulation] Applying emulation:', JSON.stringify(emulationParams))
                    wc.enableDeviceEmulation(emulationParams)
                    emulatedWebContentsIds.add(webContentsId)
                    console.log('[DeviceEmulation] SUCCESS - Enabled for webContentsId:', webContentsId)
                    return true
                }
                console.log('[DeviceEmulation] FAILED - webContents not found or destroyed')
                return false
            } catch (e) {
                console.error('[DeviceEmulation] Error:', e)
                return false
            }
        })

        // Device Emulation für Webviews deaktivieren
        ipcMain.handle("disable-device-emulation", (_event, webContentsId: number) => {
            try {
                emulatedWebContentsIds.delete(webContentsId)  // Aus dem Set entfernen
                const wc = webContents.fromId(webContentsId)
                if (wc && !wc.isDestroyed()) {
                    wc.disableDeviceEmulation()
                    // User-Agent zurücksetzen auf Standard
                    wc.setUserAgent('')  // Leerer String = Standard-User-Agent
                    console.log('[DeviceEmulation] Disabled for webContentsId:', webContentsId)
                    return true
                }
                return false
            } catch (e) {
                console.error('[DeviceEmulation] Error:', e)
                return false
            }
        })

        // ===== Cookie Persistence IPC Handlers =====

        // Cookies für einen Host laden und in Session setzen
        // WICHTIG: Die Webview nutzt partition="sandbox" (ohne persist:)
        ipcMain.handle("load-persisted-cookies", async (_event, url: string) => {
            const host = extractHost(url)
            if (!host) {
                console.log("[CookiePersist] Invalid URL, cannot load cookies:", url)
                return { success: false, count: 0 }
            }

            const cookies = await loadCookiesForHost(host)
            if (cookies.length === 0) {
                return { success: true, count: 0 }
            }

            // Webview verwendet partition="sandbox" (ohne persist: prefix!)
            const sandboxSession = session.fromPartition("sandbox")
            const count = await setCookiesToSession(sandboxSession, host, cookies)
            return { success: true, count }
        })

        // Cookies für einen Host aus Session holen und speichern
        // WICHTIG: Die Webview nutzt partition="sandbox" (ohne persist:)
        ipcMain.handle("save-persisted-cookies", async (_event, url: string) => {
            const host = extractHost(url)
            if (!host) {
                console.log("[CookiePersist] Invalid URL, cannot save cookies:", url)
                return { success: false }
            }

            // Webview verwendet partition="sandbox" (ohne persist: prefix!)
            const sandboxSession = session.fromPartition("sandbox")
            const cookies = await getCookiesFromSession(sandboxSession, host)
            if (cookies.length === 0) {
                console.log("[CookiePersist] No cookies to save for host:", host)
                return { success: true, count: 0 }
            }

            const success = await saveCookiesForHost(host, cookies)
            return { success, count: cookies.length }
        })

        // Gespeicherte Cookies für einen Host löschen
        ipcMain.handle("delete-persisted-cookies", async (_event, url: string) => {
            const host = extractHost(url)
            if (!host) {
                console.log("[CookiePersist] Invalid URL, cannot delete cookies:", url)
                return { success: false }
            }

            const success = await deleteCookiesForHost(host)
            return { success }
        })

        // Liste aller Hosts mit gespeicherten Cookies
        ipcMain.handle("list-persisted-cookie-hosts", async () => {
            const hosts = listSavedHosts()
            return { hosts }
        })

        app.on("second-instance", () => {
            if (this.mainWindow !== null) {
                this.mainWindow.focus()
            }
        })

        app.on("activate", () => {
            if (this.mainWindow === null) {
                this.createWindow()
            }
        })
    }

    createWindow = () => {
        if (!this.hasWindow()) {
            this.mainWindow = new BrowserWindow({
                title: "Fluent Reader",
                backgroundColor:
                    process.platform === "darwin"
                        ? "#00000000"
                        : nativeTheme.shouldUseDarkColors
                        ? "#282828"
                        : "#faf9f8",
                vibrancy: "sidebar",
                x: this.mainWindowState.x,
                y: this.mainWindowState.y,
                width: this.mainWindowState.width,
                height: this.mainWindowState.height,
                minWidth: 992,
                minHeight: 600,
                frame: process.platform === "darwin",
                titleBarStyle: "hiddenInset",
                fullscreenable: process.platform === "darwin",
                show: false,
                webPreferences: {
                    webviewTag: true,
                    contextIsolation: true,
                    spellcheck: false,
                    // GPU-Optimierungen für geschmeidiges Scrollen und Hardware-Beschleunigung
                    v8CacheOptions: "bypassHeatCheck",
                    preload: path.join(
                        app.getAppPath(),
                        (app.isPackaged ? "dist/" : "") + "preload.js"
                    ),
                    // GPU-Unterstützung aktivieren für bessere Rendering-Performance
                    // @ts-ignore - neuere Electron API für GPU-Aktualisierung
                    gpuPreference: 'high-performance',
                    enablePlugins: false,
                } as any,
            })
            
            // Zoom wird ausschließlich in den WebView-Tags verwaltet (via Preload-Script)
            // NICHT auf dem Hauptfenster setzen!
            this.mainWindowState.manage(this.mainWindow)
            this.mainWindow.on("ready-to-show", () => {
                this.mainWindow.show()
                this.mainWindow.focus()
                if (!app.isPackaged) this.mainWindow.webContents.openDevTools()
                
                // Initialize ContentViewManager after window is ready
                const contentViewManager = getContentViewManager()
                contentViewManager.initialize(this.mainWindow)
            })
            this.mainWindow.loadFile(
                (app.isPackaged ? "dist/" : "") + "index.html"
            )
            
            this.mainWindow.on("maximize", () => {
                this.mainWindow.webContents.send("maximized")
            })
            this.mainWindow.on("unmaximize", () => {
                this.mainWindow.webContents.send("unmaximized")
            })
            this.mainWindow.on("enter-full-screen", () => {
                this.mainWindow.webContents.send("enter-fullscreen")
            })
            this.mainWindow.on("leave-full-screen", () => {
                this.mainWindow.webContents.send("leave-fullscreen")
            })
            this.mainWindow.on("focus", () => {
                this.mainWindow.webContents.send("window-focus")
            })
            this.mainWindow.on("blur", () => {
                this.mainWindow.webContents.send("window-blur")
            })
            this.mainWindow.webContents.on("context-menu", (_, params) => {
                if (params.selectionText) {
                    this.mainWindow.webContents.send(
                        "window-context-menu",
                        [params.x, params.y],
                        params.selectionText
                    )
                }
            })
            
            // Cleanup content view manager when window closes
            this.mainWindow.on("closed", () => {
                destroyContentViewManager()
            })
        }
    }

    zoom = () => {
        if (this.hasWindow()) {
            if (this.mainWindow.isMaximized()) {
                this.mainWindow.unmaximize()
            } else {
                this.mainWindow.maximize()
            }
        }
    }

    hasWindow = () => {
        return this.mainWindow !== null && !this.mainWindow.isDestroyed()
    }
}

// Preload-Pfad für Webviews
const getWebviewPreloadPath = () => {
  return path.join(
    app.getAppPath(),
    app.isPackaged ? "dist/webview-preload.js" : "src/renderer/webview-preload.js"
  );
};

// Globale IPC oder Funktion exportieren, damit React/Renderer den Pfad abfragen kann
app.on('ready', () => {
  // Speichere den Pfad in einer globalen Variable für den Renderer-Prozess
  (global as any).webviewPreloadPath = getWebviewPreloadPath();
});

// ===== Mobile Mode: Globaler Status und Auto-Aktivierung für neue WebViews =====

// Globaler Mobile-Mode Status (wird vom Renderer gesetzt)
let globalMobileMode = false
// Standard-Parameter für Mobile-Emulation (768px = Tablet/Mobile Breakpoint)
let globalMobileEmulationParams: any = {
    screenPosition: "mobile",
    screenSize: { width: 768, height: 844 },
    deviceScaleFactor: 1,
    viewSize: { width: 768, height: 844 },
    fitToView: false,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
}

// IPC: Renderer teilt uns den Mobile-Mode-Status mit
ipcMain.on("set-global-mobile-mode", (_event, enabled: boolean, params?: any) => {
    console.log('[MobileMode] Global status set to:', enabled, 'viewport:', params?.screenSize?.width, 'x', params?.screenSize?.height)
    globalMobileMode = enabled
    if (params) {
        globalMobileEmulationParams = params
    }
})

// Listener für neue WebViews - aktiviert Emulation BEVOR Navigation beginnt
app.on('web-contents-created', (_event, contents) => {
    // Nur für webview-Tags (type === 'webview')
    if (contents.getType() === 'webview') {
        const webContentsId = contents.id;
        console.log('[MobileMode] New webview created, id:', webContentsId, 'globalMobileMode:', globalMobileMode);
        
        // did-attach feuert wenn der webview an ein BrowserWindow attached wird
        // Das ist der frühestmögliche Zeitpunkt für Emulation
        // Note: 'did-attach' is a webview-specific event not in standard Electron types
        (contents as any).on('did-attach', () => {
            if (globalMobileMode && globalMobileEmulationParams) {
                console.log('[MobileMode] Applying emulation on did-attach for webContentsId:', webContentsId)
                try {
                    // User-Agent setzen
                    if (globalMobileEmulationParams.userAgent) {
                        contents.setUserAgent(globalMobileEmulationParams.userAgent)
                    }
                    // Device Emulation aktivieren
                    const emulationParams = {
                        screenPosition: globalMobileEmulationParams.screenPosition || "mobile",
                        screenSize: globalMobileEmulationParams.screenSize || { width: 390, height: 844 },
                        viewPosition: globalMobileEmulationParams.viewPosition || { x: 0, y: 0 },
                        deviceScaleFactor: globalMobileEmulationParams.deviceScaleFactor || 3,
                        viewSize: globalMobileEmulationParams.viewSize || { width: 390, height: 844 },
                        scale: globalMobileEmulationParams.scale || 1
                    }
                    contents.enableDeviceEmulation(emulationParams)
                    console.log('[MobileMode] Emulation enabled on did-attach')
                } catch (e) {
                    console.error('[MobileMode] Failed to enable emulation on did-attach:', e)
                }
            }
        })
    }
})
