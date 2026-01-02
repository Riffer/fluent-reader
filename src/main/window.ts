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
// ContentViewPool is now the only implementation
import { initializeContentViewPool, destroyContentViewPool, getContentViewPool } from "./content-view-pool"

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
        // Suppress ERR_ABORTED and ERR_FAILED errors that occur during fast article switching
        process.on('unhandledRejection', (reason: any) => {
            // ERR_ABORTED (-3): Navigation was aborted
            // ERR_FAILED (-2): General error (often during fast switching)
            if (reason?.code === 'ERR_ABORTED' || reason?.errno === -3 ||
                reason?.code === 'ERR_FAILED' || reason?.errno === -2) {
                // Ignore these errors - occur when navigation is aborted during loading
                return
            }
            console.error('Unhandled rejection:', reason)
        })
        
        // Filter Electron-internal GUEST_VIEW_MANAGER_CALL errors from console.error
        const originalConsoleError = console.error
        console.error = (...args: any[]) => {
            // Convert args to string for checking
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
            // Destroy content view pool
            destroyContentViewPool()
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

        // Forward zoom changes from ContentView -> Renderer
        ipcMain.on("content-view-zoom-changed", (_event, zoom: number) => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send("content-view-zoom-changed", zoom)
            }
        })

        // Open/close App DevTools
        ipcMain.handle("toggle-app-devtools", () => {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                if (this.mainWindow.webContents.isDevToolsOpened()) {
                    this.mainWindow.webContents.closeDevTools()
                } else {
                    this.mainWindow.webContents.openDevTools()
                }
            }
        })

        // Stores which webContentsIds have emulation already enabled
        const emulatedWebContentsIds = new Set<number>()

        // Enable Device Emulation for WebContents (Mobile Mode)
        // Note: ContentViewManager handles its own emulation, this is for legacy support
        ipcMain.handle("enable-device-emulation", (_event, webContentsId: number, params: any) => {
            // Deduplication: Only enable once per webContentsId
            if (emulatedWebContentsIds.has(webContentsId)) {
                return true
            }
            
            try {
                const wc = webContents.fromId(webContentsId)
                if (wc && !wc.isDestroyed()) {
                    // Change User-Agent if specified
                    if (params.userAgent) {
                        wc.setUserAgent(params.userAgent)
                    }
                    
                    const emulationParams = {
                        screenPosition: params.screenPosition || "mobile",
                        screenSize: params.screenSize || { width: 390, height: 844 },
                        viewPosition: params.viewPosition || { x: 0, y: 0 },
                        deviceScaleFactor: params.deviceScaleFactor || 3,
                        viewSize: params.viewSize || { width: 390, height: 844 },
                        scale: params.scale || 1
                    }
                    wc.enableDeviceEmulation(emulationParams)
                    emulatedWebContentsIds.add(webContentsId)
                    return true
                }
                return false
            } catch (e) {
                console.error('[DeviceEmulation] Error:', e)
                return false
            }
        })

        // Disable Device Emulation for WebContents
        ipcMain.handle("disable-device-emulation", (_event, webContentsId: number) => {
            try {
                emulatedWebContentsIds.delete(webContentsId)  // Remove from set
                const wc = webContents.fromId(webContentsId)
                if (wc && !wc.isDestroyed()) {
                    wc.disableDeviceEmulation()
                    // Reset User-Agent to default
                    wc.setUserAgent('')  // Empty string = default User-Agent
                    return true
                }
                return false
            } catch (e) {
                console.error('[DeviceEmulation] Error:', e)
                return false
            }
        })

        // ===== Cookie Persistence IPC Handlers =====

        // Load cookies for a host and set them in session
        // IMPORTANT: ContentView uses partition="sandbox" (without persist:)
        ipcMain.handle("load-persisted-cookies", async (_event, url: string) => {
            const host = extractHost(url)
            if (!host) {
                return { success: false, count: 0 }
            }

            const cookies = await loadCookiesForHost(host)
            if (cookies.length === 0) {
                return { success: true, count: 0 }
            }

            // ContentView verwendet partition="sandbox" (ohne persist: prefix!)
            const sandboxSession = session.fromPartition("sandbox")
            const count = await setCookiesToSession(sandboxSession, host, cookies)
            return { success: true, count }
        })

        // Get cookies for a host from session and save them
        // IMPORTANT: Try to get cookies from ContentViewPool first (uses actual WebContentsView session)
        // Falls back to session.fromPartition("sandbox") if pool is not available
        // NOTE: We save ALL session cookies because of cross-domain cookies (e.g., .threads.com for threads.net)
        ipcMain.handle("save-persisted-cookies", async (_event, url: string) => {
            console.log(`[CookiePersist] save-persisted-cookies called for: ${url}`)
            const host = extractHost(url)
            if (!host) {
                console.log(`[CookiePersist] Could not extract host from URL`)
                return { success: false }
            }

            // Try to get cookies from ContentViewPool first
            const pool = getContentViewPool()
            let cookies: Electron.Cookie[] = []
            let viewSession: Electron.Session | null = null
            
            if (pool) {
                // Get active view's webContents session
                const activeView = pool.getActiveView()
                const wc = activeView?.getWebContents()
                if (wc && !wc.isDestroyed()) {
                    viewSession = wc.session
                    console.log(`[CookiePersist] Using Pool's active view session`)
                } else {
                    console.log(`[CookiePersist] Pool active view not available, falling back to sandbox session`)
                    viewSession = session.fromPartition("sandbox")
                }
            } else {
                // Fallback: ContentView verwendet partition="sandbox"
                console.log(`[CookiePersist] Pool not available, using sandbox session`)
                viewSession = session.fromPartition("sandbox")
            }
            
            // Get ALL cookies from the session (not filtered by host)
            // This handles cross-domain cookies (e.g., .threads.com for threads.net)
            try {
                cookies = await viewSession.cookies.get({})
                console.log(`[CookiePersist] Total cookies in session: ${cookies.length}`)
                cookies.forEach(c => {
                    console.log(`[CookiePersist]   - ${c.name} @ ${c.domain}`)
                })
            } catch (e) {
                console.log(`[CookiePersist] Error getting cookies:`, e)
                return { success: false }
            }
            
            if (cookies.length === 0) {
                console.log(`[CookiePersist] No cookies to save`)
                return { success: true, count: 0 }
            }

            // Save ALL cookies under the host key (they will be restored to the session on next visit)
            const success = await saveCookiesForHost(host, cookies)
            console.log(`[CookiePersist] Saved ${cookies.length} cookies for ${host}, success: ${success}`)
            return { success, count: cookies.length }
        })

        // Delete saved cookies for a host
        ipcMain.handle("delete-persisted-cookies", async (_event, url: string) => {
            const host = extractHost(url)
            if (!host) {
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
                fullscreenable: true,  // Enable fullscreen for video playback on all platforms
                show: false,
                webPreferences: {
                    webviewTag: true,
                    contextIsolation: true,
                    spellcheck: false,
                    // GPU optimizations for smooth scrolling and hardware acceleration
                    v8CacheOptions: "bypassHeatCheck",
                    preload: path.join(
                        app.getAppPath(),
                        (app.isPackaged ? "dist/" : "") + "preload.js"
                    ),
                    // Enable GPU support for better rendering performance
                    // @ts-ignore - newer Electron API for GPU updates
                    gpuPreference: 'high-performance',
                    enablePlugins: false,
                } as any,
            })
            
            // Zoom is managed exclusively in ContentView (via content-preload.js)
            // DO NOT set on main window!
            this.mainWindowState.manage(this.mainWindow)
            this.mainWindow.on("ready-to-show", () => {
                this.mainWindow.show()
                this.mainWindow.focus()
                if (!app.isPackaged) this.mainWindow.webContents.openDevTools()
                
                // Initialize ContentViewPool
                console.log('[WindowManager] Initializing ContentViewPool (Pool mode)...')
                initializeContentViewPool(this.mainWindow)
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
            
            // Cleanup content view pool when window closes
            this.mainWindow.on("closed", () => {
                destroyContentViewPool()
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

// Note: WebView preload path and global mobile mode handlers have been removed.
// ContentView now handles all article display via ContentViewManager.
// See src/main/content-view-manager.ts for the new implementation.
