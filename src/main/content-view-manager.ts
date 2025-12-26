/**
 * ContentViewManager - Manages WebContentsView for article content
 * 
 * This module handles the WebContentsView that displays article content,
 * enabling true visual zoom (pinch-to-zoom) via enableDeviceEmulation().
 * 
 * Architecture:
 * - Main UI runs in BrowserWindow (React app)
 * - Article content runs in WebContentsView (attached to main window)
 * - Communication via IPC between renderer and content view
 */
import { WebContentsView, ipcMain, app, session, Input, Menu, clipboard, shell, nativeImage } from "electron"
import type { BrowserWindow, MenuItemConstructorOptions } from "electron"
import path from "path"
import https from "https"
import http from "http"
import fs from "fs"

// Content view bounds (will be updated by renderer)
interface ContentViewBounds {
    x: number
    y: number
    width: number
    height: number
}

/**
 * Navigation settings for bundled navigation call
 * All settings are applied BEFORE navigation starts, eliminating race conditions
 */
interface NavigationSettings {
    zoomFactor: number       // Zoom factor (0.7 = 70%, 1.0 = 100%, etc.)
    visualZoom: boolean      // Whether Visual Zoom (Device Emulation) is enabled
    mobileMode: boolean      // Whether Mobile Mode is enabled
    showZoomOverlay: boolean // Whether to show zoom overlay
}

export class ContentViewManager {
    private contentView: WebContentsView | null = null
    private parentWindow: BrowserWindow | null = null
    private currentUrl: string = ""
    private isVisible: boolean = false
    private bounds: ContentViewBounds = { x: 0, y: 0, width: 800, height: 600 }
    private visualZoomEnabled: boolean = false
    private mobileMode: boolean = false
    private pageLoaded: boolean = false  // Track if a page has been loaded (for safe device emulation)
    private emulationAppliedBeforeLoad: boolean = false  // Track if emulation was applied pre-navigation (to skip did-finish-load)
    private pendingEmulationShow: boolean = false  // Track if we need to show ContentView after emulation is applied
    private mobileUserAgent: string = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    
    // Preload script path
    // In dev mode, webpack puts electron.js in dist/, so app.getAppPath() = fluent-reader/dist
    // In packaged mode, app.getAppPath() = resources/app, and preload is in dist/
    private get preloadPath(): string {
        return path.join(
            app.getAppPath(),
            app.isPackaged ? "dist/content-preload.js" : "content-preload.js"
        )
    }
    
    constructor() {
        this.setupIpcHandlers()
    }
    
    /**
     * WORKAROUND: Inject touch event listeners via executeJavaScript
     * After navigation, the preload script's document reference becomes stale.
     * This calls the preload's exposed function via contextBridge.
     * 
     * WICHTIG: Da contextIsolation=true, läuft executeJavaScript im Main World,
     * nicht im Preload-Kontext. Der Preload exponiert die Funktion über contextBridge
     * als window.cssZoomBridge.reRegisterTouchEvents()
     */
    private injectTouchEventListeners(): void {
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            return
        }
        
        // Call the preload's exposed function via contextBridge
        // The preload exposes cssZoomBridge.reRegisterTouchEvents() to the main world
        const script = `
            (function() {
                // cssZoomBridge is exposed by preload via contextBridge
                if (window.cssZoomBridge && typeof window.cssZoomBridge.reRegisterTouchEvents === 'function') {
                    console.log('[ContentViewManager] Calling cssZoomBridge.reRegisterTouchEvents()');
                    window.cssZoomBridge.reRegisterTouchEvents();
                } else {
                    console.log('[ContentViewManager] cssZoomBridge not found - contextBridge may not be ready');
                    console.log('[ContentViewManager] Available on window:', Object.keys(window).filter(k => k.includes('css') || k.includes('zoom') || k.includes('bridge')));
                }
            })();
        `
        
        this.contentView.webContents.executeJavaScript(script).catch(err => {
            console.error("[ContentViewManager] Failed to inject touch listeners:", err)
        })
        console.log("[ContentViewManager] Touch event injection requested")
    }
    
    /**
     * Initialize the content view and attach to parent window
     */
    public initialize(parentWindow: BrowserWindow): void {
        if (this.contentView) {
            console.warn("[ContentViewManager] Already initialized")
            return
        }
        
        this.parentWindow = parentWindow
        this.createContentView()
        
        console.log("[ContentViewManager] Initialized with preload:", this.preloadPath)
    }
    
    /**
     * Create the WebContentsView with proper configuration
     */
    private createContentView(): void {
        try {
            console.log("[ContentViewManager] Creating WebContentsView...")
            
            // Create sandbox session for content isolation
            const sandboxSession = session.fromPartition("sandbox")
            console.log("[ContentViewManager] Sandbox session created")
            
            this.contentView = new WebContentsView({
                webPreferences: {
                    preload: this.preloadPath,
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    spellcheck: false,
                    session: sandboxSession,  // Use the sandbox session
                    // Disable webview tag in content view (security)
                    webviewTag: false,
                }
            })
            console.log("[ContentViewManager] WebContentsView instance created")
            
            // Set background color to prevent white flash on dark pages
            // Using transparent - let's see if this works
            this.contentView.setBackgroundColor('#00000000')  // Transparent
            console.log("[ContentViewManager] Background color set to transparent")
            
            // Set initial bounds (hidden off-screen, or use saved bounds if recreating)
            if (this.bounds && this.isVisible) {
                this.contentView.setBounds(this.bounds)
                console.log("[ContentViewManager] Using saved bounds:", this.bounds)
            } else {
                this.contentView.setBounds({ x: -10000, y: -10000, width: 800, height: 600 })
                console.log("[ContentViewManager] Initial bounds set (off-screen)")
            }
            
            // Add to parent window's content view
            if (this.parentWindow && !this.parentWindow.isDestroyed()) {
                this.parentWindow.contentView.addChildView(this.contentView)
                console.log("[ContentViewManager] Added to parent window")
            }
            
            // Setup navigation events
            this.setupNavigationEvents()
            console.log("[ContentViewManager] Navigation events setup")
            
            // Setup context menu
            this.setupContextMenu()
            console.log("[ContentViewManager] Context menu setup")
            
            // Forward ContentView console messages to main process
            this.contentView.webContents.on('console-message', (event, level, message, line, sourceId) => {
                if (message.includes('[ContentPreload]')) {
                    console.log(`[ContentView] ${message}`)
                }
            })
            
            // Setup keyboard events forwarding
            this.setupKeyboardEvents()
            console.log("[ContentViewManager] Keyboard events setup")
            
            console.log("[ContentViewManager] WebContentsView created successfully")
        } catch (e) {
            console.error("[ContentViewManager] Error creating WebContentsView:", e)
        }
    }
    
    /**
     * NUCLEAR OPTION: Recreate the WebContentsView completely
     * This is needed because Electron's WebContentsView has a bug where touch events
     * stop being delivered to the preload script after navigating to a new page.
     * The ONLY reliable fix is to destroy and recreate the entire view.
     */
    private recreateContentView(): void {
        console.log("[ContentViewManager] NUCLEAR OPTION: Recreating WebContentsView...")
        
        if (!this.parentWindow || this.parentWindow.isDestroyed()) {
            console.error("[ContentViewManager] Cannot recreate - no parent window")
            return
        }
        
        // Save current state
        const savedBounds = this.bounds
        const savedVisible = this.isVisible
        
        // Destroy old view
        if (this.contentView) {
            try {
                this.parentWindow.contentView.removeChildView(this.contentView)
                // webContents is destroyed automatically when view is removed
                this.contentView = null
                console.log("[ContentViewManager] Old WebContentsView destroyed")
            } catch (e) {
                console.error("[ContentViewManager] Error destroying old view:", e)
            }
        }
        
        // Reset page loaded state
        this.pageLoaded = false
        
        // Create fresh view
        this.createContentView()
        
        // Restore visibility state
        if (savedVisible && savedBounds) {
            this.bounds = savedBounds
            this.isVisible = true
            if (this.contentView) {
                this.contentView.setBounds(savedBounds)
            }
        }
        
        console.log("[ContentViewManager] WebContentsView recreated successfully")
    }
    
    /**
     * Setup navigation and loading events
     */
    private setupNavigationEvents(): void {
        if (!this.contentView) return
        
        const wc = this.contentView.webContents
        
        // did-start-navigation is the VERY FIRST event - TOO EARLY, Chromium resets it
        wc.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
            if (!isMainFrame) return  // Only main frame navigations
            
            console.log("[ContentViewManager] EVENT: did-start-navigation -", url)
        })
        
        // did-commit-navigation is when server responds and page starts loading
        // This is the OPTIMAL time to hide - user sees old content until server responds
        wc.on("did-navigate", (event, url) => {
            console.log("[ContentViewManager] EVENT: did-navigate -", url)
            this.currentUrl = url
            this.sendToRenderer("content-view-navigated", url)
            
            // LATE HIDE: Hide ContentView NOW - server has responded, new page is coming
            if (this.visualZoomEnabled && this.pendingEmulationShow && this.isVisible) {
                console.log("[ContentViewManager] LATE-HIDE: Server responded, hiding ContentView now")
                this.setVisible(false, true)  // preserveContent=true for blur
                this.sendToRenderer("content-view-visual-zoom-loading")
            }
        })
        
        wc.on("did-start-loading", () => {
            console.log("[ContentViewManager] EVENT: did-start-loading")
            this.sendToRenderer("content-view-loading", true)
            
            // DISABLED - inconsistent, sometimes too early
            // if (this.visualZoomEnabled && this.pageLoaded) {
            //     console.log("[ContentViewManager] EVENT: did-start-loading → Applying emulation")
            //     this.applyDeviceEmulationForCurrentMode(true)
            // }
        })
        
        wc.on("did-stop-loading", () => {
            console.log("[ContentViewManager] EVENT: did-stop-loading")
            this.sendToRenderer("content-view-loading", false)
        })
        
        // DISABLED for testing - only did-start-navigation
        wc.on("dom-ready", () => {
            console.log("[ContentViewManager] EVENT: dom-ready -", this.currentUrl)
            
            // Mark page as loaded (safe for device emulation now)
            if (!this.pageLoaded) {
                console.log("[ContentViewManager] pageLoaded was: false → setting to true (dom-ready)")
                this.pageLoaded = true
            }
            
            // Send zoom settings to preload based on mode
            // Don't round - preserve fractional values from pinch-zoom (e.g., 3.5 = 135%)
            const level = (this.keyboardZoomFactor - 1.0) / 0.1
            
            if (this.visualZoomEnabled) {
                // Visual Zoom mode: Send mode flag and level for overlay display
                wc.send('set-visual-zoom-mode', true)
                wc.send('set-visual-zoom-level', level)
                console.log("[ContentViewManager] EVENT: dom-ready → Sent set-visual-zoom-mode + level:", level)
            } else {
                // CSS Zoom mode: Send mode flag and zoom level to apply CSS transform
                wc.send('set-visual-zoom-mode', false)
                wc.send('content-view-set-css-zoom', level)
                console.log("[ContentViewManager] EVENT: dom-ready → CSS Zoom mode: Sent content-view-set-css-zoom:", level)
            }
            
            // Apply emulation at dom-ready (earliest consistent point after Chromium reset)
            console.log("[ContentViewManager] EVENT: dom-ready → Calling applyVisualZoomIfEnabled()")
            this.applyVisualZoomIfEnabled()
            
            // HIDE-SHOW STRATEGY: Show ContentView after emulation is applied
            if (this.pendingEmulationShow && this.visualZoomEnabled) {
                console.log("[ContentViewManager] EVENT: dom-ready → pendingEmulationShow: showing ContentView now")
                this.pendingEmulationShow = false
                // Small delay to ensure emulation has taken effect
                setTimeout(() => {
                    this.setVisible(true, false)
                    // Notify renderer that ContentView is now visible (hide loading spinner)
                    this.sendToRenderer("content-view-visual-zoom-ready")
                    console.log("[ContentViewManager] ContentView shown after emulation applied")
                    
                    // === FOCUS FIX: Move focus away, then back to ContentView ===
                    // First focus the main window to "reset" focus
                    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                        this.mainWindow.webContents.focus()
                        console.log("[ContentViewManager] Focus moved to main window")
                    }
                    
                    // Then focus ContentView after a delay
                    setTimeout(() => {
                        if (this.contentView?.webContents && !this.contentView.webContents.isDestroyed()) {
                            this.contentView.webContents.focus()
                            console.log("[ContentViewManager] Focus set to ContentView")
                        }
                    }, 1)
                }, 10)
            } else {
                // === CSS ZOOM MODE: Aggressive workarounds for touch event delivery ===
                // Without these, the ContentView won't receive touch events after navigation
                console.log("[ContentViewManager] EVENT: dom-ready → CSS Zoom mode: Applying touch event workarounds")
                setTimeout(() => {
                    if (this.contentView?.webContents && !this.contentView.webContents.isDestroyed()) {
                        // WORKAROUND 1: Blur-Focus cycle to reset input routing
                        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                            this.mainWindow.webContents.focus()
                            console.log("[ContentViewManager] Focus moved to main window (blur ContentView)")
                        }
                        
                        setTimeout(() => {
                            if (this.contentView?.webContents && !this.contentView.webContents.isDestroyed()) {
                                this.contentView.webContents.focus()
                                console.log("[ContentViewManager] Focus returned to ContentView")
                                
                                // WORKAROUND 2: Re-apply bounds to trigger Chromium's input re-routing
                                if (this.contentView && this.bounds) {
                                    const bounds = { ...this.bounds }
                                    // Tiny adjustment to force recalculation
                                    this.contentView.setBounds({ ...bounds, width: bounds.width - 1 })
                                    setTimeout(() => {
                                        if (this.contentView && !this.contentView.webContents.isDestroyed()) {
                                            this.contentView.setBounds(bounds)
                                            console.log("[ContentViewManager] Re-applied bounds to reset input routing")
                                        }
                                    }, 1)
                                }
                                
                                // WORKAROUND 3: Re-register touch events via executeJavaScript
                                this.injectTouchEventListeners()
                            }
                        }, 50) // Longer delay for blur-focus cycle
                    }
                }, 10)
            }
        })
        
        wc.on("did-finish-load", () => {
            console.log("[ContentViewManager] EVENT: did-finish-load -", this.currentUrl)
            // pageLoaded should already be true from dom-ready
            if (!this.pageLoaded) {
                console.log("[ContentViewManager] pageLoaded was: false → setting to true (did-finish-load fallback)")
                this.pageLoaded = true
            }
            this.sendToRenderer("content-view-loaded", this.currentUrl)
            
            // DISABLED - testing did-start-navigation only
            // if (this.visualZoomEnabled) {
            //     console.log("[ContentViewManager] EVENT: did-finish-load → Verifying emulation is applied")
            //     this.applyVisualZoomIfEnabled()
            // }
            this.emulationAppliedBeforeLoad = false  // Reset flag
        })
        
        wc.on("did-fail-load", (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            // Ignore aborted loads (user navigated away)
            if (errorCode === -3) return
            
            // Only report main frame errors, not subresource errors (ads, tracking, etc.)
            if (!isMainFrame) {
                console.log("[ContentViewManager] Subresource load failed (ignored):", validatedURL)
                return
            }
            
            console.error("[ContentViewManager] Main frame load failed:", errorCode, errorDescription)
            this.sendToRenderer("content-view-error", { errorCode, errorDescription, url: validatedURL })
            
            // === RECOVERY: Show ContentView on load failure ===
            // If we were waiting to show after emulation, we need to recover
            if (this.pendingEmulationShow) {
                console.log("[ContentViewManager] Load failed - recovering: showing ContentView despite error")
                this.pendingEmulationShow = false
                this.setVisible(true, false)
                this.sendToRenderer("content-view-visual-zoom-ready")  // Hide loading spinner
            }
        })
        
        wc.on("did-navigate-in-page", (event, url) => {
            this.currentUrl = url
            this.sendToRenderer("content-view-navigated", url)
        })
        
        // Page title updates
        wc.on("page-title-updated", (event, title) => {
            this.sendToRenderer("content-view-title", title)
        })
    }
    
    /**
     * Setup native context menu for WebContentsView
     * Uses Electron's native Menu.popup() to display over the WebContentsView
     * (React/Fluent UI menus cannot overlay native WebContentsView)
     */
    private setupContextMenu(): void {
        if (!this.contentView) return
        
        this.contentView.webContents.on("context-menu", (event, params) => {
            const menuItems: MenuItemConstructorOptions[] = []
            
            // === Text Selection Menu ===
            if (params.selectionText && params.selectionText.trim().length > 0) {
                menuItems.push({
                    label: "Kopieren",
                    accelerator: "CmdOrCtrl+C",
                    click: () => {
                        clipboard.writeText(params.selectionText)
                    }
                })
                menuItems.push({
                    label: "Im Web suchen",
                    click: () => {
                        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`
                        shell.openExternal(searchUrl)
                    }
                })
                menuItems.push({ type: "separator" })
            }
            
            // === Link Menu ===
            if (params.linkURL && params.linkURL.length > 0) {
                menuItems.push({
                    label: "Link im Browser öffnen",
                    click: () => {
                        shell.openExternal(params.linkURL)
                    }
                })
                menuItems.push({
                    label: "Link-Adresse kopieren",
                    click: () => {
                        clipboard.writeText(params.linkURL)
                    }
                })
                menuItems.push({ type: "separator" })
            }
            
            // === Image Menu ===
            if (params.hasImageContents && params.srcURL) {
                menuItems.push({
                    label: "Bild im Browser öffnen",
                    click: () => {
                        shell.openExternal(params.srcURL)
                    }
                })
                menuItems.push({
                    label: "Bild speichern unter...",
                    click: () => {
                        this.saveImageAs(params.srcURL)
                    }
                })
                menuItems.push({
                    label: "Bild kopieren",
                    click: () => {
                        this.copyImageToClipboard(params.srcURL)
                    }
                })
                menuItems.push({
                    label: "Bild-URL kopieren",
                    click: () => {
                        clipboard.writeText(params.srcURL)
                    }
                })
                menuItems.push({ type: "separator" })
            }
            
            // === General Actions ===
            menuItems.push({
                label: "Zurück",
                accelerator: "Alt+Left",
                enabled: this.contentView?.webContents.navigationHistory.canGoBack() ?? false,
                click: () => {
                    this.contentView?.webContents.goBack()
                }
            })
            menuItems.push({
                label: "Vorwärts",
                accelerator: "Alt+Right",
                enabled: this.contentView?.webContents.navigationHistory.canGoForward() ?? false,
                click: () => {
                    this.contentView?.webContents.goForward()
                }
            })
            menuItems.push({
                label: "Neu laden",
                accelerator: "CmdOrCtrl+R",
                click: () => {
                    this.contentView?.webContents.reload()
                }
            })
            
            // Only show menu if we have items
            if (menuItems.length > 0) {
                // Remove trailing separator if present
                if (menuItems[menuItems.length - 1].type === "separator") {
                    menuItems.pop()
                }
                
                const menu = Menu.buildFromTemplate(menuItems)
                menu.popup({
                    window: this.parentWindow ?? undefined,
                    x: this.bounds.x + params.x,
                    y: this.bounds.y + params.y
                })
            }
            
            // Also notify renderer (for any additional handling)
            this.sendToRenderer("content-view-context-menu", {
                x: params.x,
                y: params.y,
                selectionText: params.selectionText,
                linkURL: params.linkURL,
                srcURL: params.srcURL,
                mediaType: params.mediaType,
            })
        })
    }
    
    /**
     * Save image to file
     */
    private async saveImageAs(imageUrl: string): Promise<void> {
        if (!this.parentWindow) return
        
        const { dialog } = await import("electron")
        
        // Extract filename from URL
        const urlObj = new URL(imageUrl)
        let filename = path.basename(urlObj.pathname) || "image"
        
        // Ensure extension
        if (!filename.includes(".")) {
            filename += ".jpg"
        }
        
        const result = await dialog.showSaveDialog(this.parentWindow, {
            defaultPath: filename,
            filters: [
                { name: "Bilder", extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp"] },
                { name: "Alle Dateien", extensions: ["*"] }
            ]
        })
        
        if (result.canceled || !result.filePath) return
        
        try {
            // Download image
            const protocol = imageUrl.startsWith("https") ? https : http
            const response = await new Promise<Buffer>((resolve, reject) => {
                protocol.get(imageUrl, (res) => {
                    // Handle redirects
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const redirectUrl = res.headers.location
                        if (redirectUrl) {
                            const redirectProtocol = redirectUrl.startsWith("https") ? https : http
                            redirectProtocol.get(redirectUrl, (redirectRes) => {
                                const chunks: Buffer[] = []
                                redirectRes.on("data", chunk => chunks.push(chunk))
                                redirectRes.on("end", () => resolve(Buffer.concat(chunks)))
                                redirectRes.on("error", reject)
                            }).on("error", reject)
                            return
                        }
                    }
                    
                    const chunks: Buffer[] = []
                    res.on("data", chunk => chunks.push(chunk))
                    res.on("end", () => resolve(Buffer.concat(chunks)))
                    res.on("error", reject)
                }).on("error", reject)
            })
            
            fs.writeFileSync(result.filePath, response)
            console.log("[ContentViewManager] Image saved to:", result.filePath)
        } catch (err) {
            console.error("[ContentViewManager] Failed to save image:", err)
        }
    }
    
    /**
     * Copy image to clipboard
     */
    private async copyImageToClipboard(imageUrl: string): Promise<void> {
        try {
            const protocol = imageUrl.startsWith("https") ? https : http
            const response = await new Promise<Buffer>((resolve, reject) => {
                protocol.get(imageUrl, (res) => {
                    // Handle redirects
                    if (res.statusCode === 301 || res.statusCode === 302) {
                        const redirectUrl = res.headers.location
                        if (redirectUrl) {
                            const redirectProtocol = redirectUrl.startsWith("https") ? https : http
                            redirectProtocol.get(redirectUrl, (redirectRes) => {
                                const chunks: Buffer[] = []
                                redirectRes.on("data", chunk => chunks.push(chunk))
                                redirectRes.on("end", () => resolve(Buffer.concat(chunks)))
                                redirectRes.on("error", reject)
                            }).on("error", reject)
                            return
                        }
                    }
                    
                    const chunks: Buffer[] = []
                    res.on("data", chunk => chunks.push(chunk))
                    res.on("end", () => resolve(Buffer.concat(chunks)))
                    res.on("error", reject)
                }).on("error", reject)
            })
            
            const image = nativeImage.createFromBuffer(response)
            clipboard.writeImage(image)
            console.log("[ContentViewManager] Image copied to clipboard")
        } catch (err) {
            console.error("[ContentViewManager] Failed to copy image:", err)
        }
    }
    
    /**
     * Setup keyboard event forwarding to renderer
     */
    private setupKeyboardEvents(): void {
        if (!this.contentView) return
        
        const wc = this.contentView.webContents
        
        // Forward keyboard events to renderer for shortcut handling
        wc.on("before-input-event", (event, input) => {
            // Forward to renderer for processing
            this.sendToRenderer("content-view-input", input)
        })
    }
    
    /**
     * Setup IPC handlers for renderer communication
     */
    private setupIpcHandlers(): void {
        console.log("[ContentViewManager] Setting up IPC handlers...")
        
        // Navigate to URL (legacy - prefer navigateWithSettings for new code)
        ipcMain.handle("content-view-navigate", async (event, url: string) => {
            console.log("[ContentViewManager] IPC: navigate to", url)
            return this.navigate(url)
        })
        
        // Navigate with all settings bundled - eliminates race conditions
        ipcMain.handle("content-view-navigate-with-settings", async (event, url: string, settings: NavigationSettings) => {
            console.log("[ContentViewManager] IPC: navigateWithSettings to", url, "settings:", settings)
            return this.navigateWithSettings(url, settings)
        })
        
        // Update bounds
        ipcMain.on("content-view-set-bounds", (event, bounds: ContentViewBounds) => {
            console.log("[ContentViewManager] IPC: set bounds", bounds)
            this.setBounds(bounds)
        })
        
        // Show/hide content view
        // Second parameter: preserveContent (default false) - set true for blur-div situations
        ipcMain.on("content-view-set-visible", (event, visible: boolean, preserveContent: boolean = false) => {
            console.log("[ContentViewManager] IPC: set visible", visible, "preserveContent:", preserveContent)
            this.setVisible(visible, preserveContent)
        })
        
        // Clear content view (load about:blank)
        ipcMain.on("content-view-clear", () => {
            console.log("[ContentViewManager] IPC: clear")
            this.clear()
        })
        
        // Send message to content view
        ipcMain.on("content-view-send", (event, channel: string, ...args: any[]) => {
            this.sendToContentView(channel, ...args)
        })
        
        // EXPERIMENTAL: Navigate via JavaScript (to test if Device Emulation survives)
        ipcMain.handle("content-view-navigate-via-js", async (event, url: string) => {
            console.log("[ContentViewManager] IPC: navigate-via-js to", url)
            return this.navigateViaJs(url)
        })
        
        // Execute JavaScript in content view
        ipcMain.handle("content-view-execute-js", async (event, code: string) => {
            return this.executeJavaScript(code)
        })
        
        // Set zoom factor (for +/- keyboard shortcuts - uses CSS zoom or Device Emulation)
        // IMPORTANT: This must be synchronous (sendSync) to ensure zoom is set BEFORE navigation starts
        ipcMain.on("content-view-set-zoom-factor", (event, factor: number) => {
            console.log("[ContentViewManager] IPC: set zoom factor", factor)
            this.setZoomFactor(factor)
            event.returnValue = true  // For sendSync - ensures caller waits
        })
        
        // Set CSS zoom level directly (for preload-based zoom when Visual Zoom is OFF)
        ipcMain.on("content-view-set-css-zoom", (event, level: number) => {
            console.log("[ContentViewManager] IPC: set css zoom level", level)
            this.setCssZoom(level)
        })
        
        // Get current CSS zoom level (synchronous - for preload initial load)
        ipcMain.on("get-css-zoom-level", (event) => {
            const level = this.getCssZoomLevel()
            console.log("[ContentViewManager] IPC sync: get-css-zoom-level →", level)
            event.returnValue = level
        })
        
        // Get current CSS zoom level (async)
        ipcMain.handle("content-view-get-css-zoom-level", () => {
            return this.getCssZoomLevel()
        })
        
        // Get current zoom factor
        ipcMain.handle("content-view-get-zoom-factor", () => {
            return this.getZoomFactor()
        })
        
        // Enable/disable visual zoom
        ipcMain.on("content-view-set-visual-zoom", (event, enabled: boolean) => {
            console.log("[ContentViewManager] IPC: set visual zoom", enabled)
            this.visualZoomEnabled = enabled
            if (enabled) {
                this.enableVisualZoom()
            } else {
                this.disableVisualZoom()
            }
            console.log("[ContentViewManager] IPC: visual zoom done")
        })
        
        // Get webContents ID
        ipcMain.handle("content-view-get-id", () => {
            return this.contentView?.webContents?.id ?? null
        })
        
        // Open DevTools
        ipcMain.handle("content-view-open-devtools", () => {
            this.contentView?.webContents?.openDevTools()
        })
        
        // Reload
        ipcMain.handle("content-view-reload", () => {
            this.contentView?.webContents?.reload()
        })
        
        // Go back/forward
        ipcMain.handle("content-view-go-back", () => {
            if (this.contentView?.webContents?.navigationHistory.canGoBack()) {
                this.contentView.webContents.goBack()
                return true
            }
            return false
        })
        
        ipcMain.handle("content-view-go-forward", () => {
            if (this.contentView?.webContents?.navigationHistory.canGoForward()) {
                this.contentView.webContents.goForward()
                return true
            }
            return false
        })
        
        // Set user agent
        ipcMain.on("content-view-set-user-agent", (event, userAgent: string) => {
            if (this.contentView?.webContents) {
                this.contentView.webContents.setUserAgent(userAgent)
            }
        })
        
        // Load HTML content
        ipcMain.handle("content-view-load-html", async (event, html: string, baseURL?: string) => {
            return this.loadHTML(html, baseURL)
        })
        
        // Can go back/forward queries
        ipcMain.handle("content-view-can-go-back", () => {
            return this.contentView?.webContents?.navigationHistory.canGoBack() ?? false
        })
        
        ipcMain.handle("content-view-can-go-forward", () => {
            return this.contentView?.webContents?.navigationHistory.canGoForward() ?? false
        })
        
        // Get current URL
        ipcMain.handle("content-view-get-url", () => {
            return this.contentView?.webContents?.getURL() ?? ""
        })
        
        // Stop loading
        ipcMain.handle("content-view-stop", () => {
            this.contentView?.webContents?.stop()
        })
        
        // Set mobile mode
        ipcMain.on("content-view-set-mobile-mode", (event, enabled: boolean) => {
            console.log("[ContentViewManager] IPC: content-view-set-mobile-mode received, enabled:", enabled)
            this.setMobileMode(enabled)
        })
        
        // Focus content view
        ipcMain.on("content-view-focus", () => {
            if (this.contentView?.webContents && !this.contentView.webContents.isDestroyed()) {
                this.contentView.webContents.focus()
            }
        })
        
        // Capture screenshot of content view
        ipcMain.handle("content-view-capture-screen", async () => {
            return await this.captureScreen()
        })
    }
    
    // Enable performance logging for captureScreen (set to true for debugging)
    private static readonly CAPTURE_PERF_LOGGING = false
    
    /**
     * Capture screenshot of content view
     * Returns base64 data URL or null if not available
     * Uses JPEG encoding (Q70) for optimal performance:
     * - ~8x faster than PNG (~70ms vs ~590ms)
     * - ~9x smaller file size (~220KB vs ~2MB)
     */
    public async captureScreen(): Promise<string | null> {
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            return null
        }
        
        const perfStart = ContentViewManager.CAPTURE_PERF_LOGGING ? performance.now() : 0
        
        try {
            // Step 1: Capture the page (GPU buffer read)
            const captureStart = ContentViewManager.CAPTURE_PERF_LOGGING ? performance.now() : 0
            const image = await this.contentView.webContents.capturePage()
            const captureTime = ContentViewManager.CAPTURE_PERF_LOGGING ? performance.now() - captureStart : 0
            
            if (image.isEmpty()) {
                return null
            }
            
            // Step 2: Encode to JPEG (much faster than PNG)
            const encodeStart = ContentViewManager.CAPTURE_PERF_LOGGING ? performance.now() : 0
            const jpegBuffer = image.toJPEG(70)  // Quality 70 - good balance for blur overlay
            const encodeTime = ContentViewManager.CAPTURE_PERF_LOGGING ? performance.now() - encodeStart : 0
            
            // Step 3: Convert to base64 data URL
            const dataUrl = `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`
            
            if (ContentViewManager.CAPTURE_PERF_LOGGING) {
                const totalTime = performance.now() - perfStart
                const sizeKB = Math.round(dataUrl.length / 1024)
                console.log(`[ContentViewManager] captureScreen perf: capture=${captureTime.toFixed(1)}ms, encode=${encodeTime.toFixed(1)}ms, total=${totalTime.toFixed(1)}ms, size=${sizeKB}KB`)
            }
            
            return dataUrl
        } catch (e) {
            console.error("[ContentViewManager] captureScreen error:", e)
            return null
        }
    }

    /**
     * Navigate content view to URL
     */
    public navigate(url: string): boolean {
        console.log("[ContentViewManager] navigate called:", url)
        if (!this.contentView) {
            console.error("[ContentViewManager] Cannot navigate - not initialized")
            return false
        }
        
        try {
            this.currentUrl = url
            console.log("[ContentViewManager] Navigating to:", url)
            
            // CRITICAL: Apply device emulation BEFORE loading the page
            // This prevents the "jump" when the page loads with wrong viewport
            // and then gets resized after did-finish-load
            // BUT: Only if a page was already loaded (not on first load - that crashes!)
            if (this.visualZoomEnabled && this.pageLoaded) {
                console.log("[ContentViewManager] Pre-navigation: Applying device emulation (subsequent load)")
                this.applyDeviceEmulationForCurrentMode(true)  // Force before page load
                this.emulationAppliedBeforeLoad = true  // Skip did-finish-load emulation
            } else {
                this.emulationAppliedBeforeLoad = false
            }
            
            this.contentView.webContents.loadURL(url).catch(err => {
                // Ignore aborted navigations
                if (err.code !== "ERR_ABORTED") {
                    console.error("[ContentViewManager] Navigation error:", err)
                }
            })
            
            console.log("[ContentViewManager] loadURL called successfully")
            return true
        } catch (e) {
            console.error("[ContentViewManager] navigate error:", e)
            return false
        }
    }
    
    /**
     * Navigate with all settings bundled in a single call
     * This eliminates race conditions by applying all settings SYNCHRONOUSLY before navigation
     * 
     * Flow:
     * 1. Apply all settings immediately (no async)
     * 2. Set up Device Emulation with correct zoom (if visualZoom enabled and page already loaded)
     * 3. Start navigation
     * 4. Preload reads final settings via synchronous IPC on load
     */
    public navigateWithSettings(url: string, settings: NavigationSettings): boolean {
        console.log("[ContentViewManager] ==========================================")
        console.log("[ContentViewManager] navigateWithSettings called:", url)
        console.log("[ContentViewManager] Settings:", JSON.stringify(settings))
        console.log("[ContentViewManager] Current state: pageLoaded:", this.pageLoaded, 
            "currentZoomFactor:", this.keyboardZoomFactor,
            "visualZoomEnabled:", this.visualZoomEnabled)
        
        if (!this.contentView) {
            console.error("[ContentViewManager] Cannot navigate - not initialized")
            return false
        }
        
        try {
            // === STEP 1: Apply ALL settings SYNCHRONOUSLY ===
            this.visualZoomEnabled = settings.visualZoom
            this.mobileMode = settings.mobileMode
            this.keyboardZoomFactor = Math.max(0.25, Math.min(5.0, settings.zoomFactor))
            // Keep cssZoomLevel in sync for preload's initial sync IPC
            // Don't round - preserve fractional values from pinch-zoom
            this.cssZoomLevel = (this.keyboardZoomFactor - 1.0) / 0.1
            // showZoomOverlay is read by preload via sync IPC, no need to store here
            
            console.log("[ContentViewManager] Settings applied:",
                "visualZoom:", this.visualZoomEnabled,
                "mobileMode:", this.mobileMode,
                "zoomFactor:", this.keyboardZoomFactor)
            
            // === LATE-HIDE STRATEGY ===
            // Instead of hiding BEFORE navigation (user sees nothing during network wait),
            // we now hide in did-navigate event (when server responds).
            // This lets the user see the OLD content while waiting for the server.
            // Flow: loadURL() → [user sees old page] → did-navigate (HIDE) → dom-ready (SHOW)
            if (this.visualZoomEnabled) {
                // Set flag for did-navigate handler to know it should hide
                this.pendingEmulationShow = true
                console.log("[ContentViewManager] LATE-HIDE: Will hide in did-navigate event (after server responds)")
            }
            
            // === NUCLEAR OPTION for CSS Zoom Mode ===
            // Electron's WebContentsView has a bug where touch events stop being delivered
            // to the preload script after navigating to a new page. The ONLY reliable fix
            // is to destroy and recreate the entire WebContentsView for each navigation.
            // This is only needed for CSS Zoom mode (visualZoom=false) where we handle
            // touch events in the preload. Visual Zoom mode uses Device Emulation which
            // has its own touch handling.
            if (!this.visualZoomEnabled && this.pageLoaded) {
                console.log("[ContentViewManager] CSS Zoom mode: Using NUCLEAR OPTION - recreating WebContentsView")
                this.recreateContentView()
            }
            
            // === STEP 2: Start navigation ===
            // Nuclear Option handles touch events by recreating WebContentsView
            // No need for data: → file: URL conversion anymore
            this.currentUrl = url
            console.log("[ContentViewManager] Starting loadURL (emulation will be applied after dom-ready)")
            this.contentView.webContents.loadURL(url).catch(err => {
                // Ignore aborted navigations
                if (err.code !== "ERR_ABORTED") {
                    console.error("[ContentViewManager] Navigation error:", err)
                }
            })
            
            console.log("[ContentViewManager] navigateWithSettings: loadURL called successfully")
            console.log("[ContentViewManager] ==========================================")
            return true
        } catch (e) {
            console.error("[ContentViewManager] navigateWithSettings error:", e)
            return false
        }
    }
    
    /**
     * EXPERIMENTAL: Navigate via JavaScript in preload
     * This tests if Device Emulation survives a JavaScript-triggered navigation
     * (as opposed to loadURL() which resets it)
     */
    public navigateViaJs(url: string): boolean {
        console.log("[ContentViewManager] navigateViaJs called:", url)
        
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            console.error("[ContentViewManager] Cannot navigate - webContents not ready")
            return false
        }
        
        // Send URL to preload script - it will do window.location.href = url
        this.currentUrl = url
        this.contentView.webContents.send('navigate-via-js', url)
        console.log("[ContentViewManager] Sent navigate-via-js to preload")
        return true
    }
    
    /**
     * Load HTML content directly
     */
    public loadHTML(html: string, baseURL?: string): void {
        if (!this.contentView) return
        
        this.contentView.webContents.loadURL(
            `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
            { baseURLForDataURL: baseURL }
        )
    }
    
    /**
     * Update content view bounds
     * Also reapplies device emulation with new size (like POC's updateLayout)
     * But ONLY if a page has been loaded (to avoid crashes)
     */
    public setBounds(bounds: ContentViewBounds): void {
        this.bounds = bounds
        
        if (this.contentView && this.isVisible) {
            this.contentView.setBounds(bounds)
            console.log("[ContentViewManager] Bounds updated:", bounds)
            
            // Only reapply device emulation if page is loaded (like POC)
            if (this.pageLoaded) {
                this.applyDeviceEmulation()
            }
        }
    }
    
    /**
     * Show or hide content view
     * @param visible - Whether to show or hide
     * @param preserveContent - If false (default), clears the page when hiding. 
     *                          Set to true for blur-div situations where content should be preserved.
     */
    public setVisible(visible: boolean, preserveContent: boolean = false): void {
        console.log("[ContentViewManager] setVisible called:", visible, "preserveContent:", preserveContent)
        this.isVisible = visible
        
        if (!this.contentView) {
            console.log("[ContentViewManager] setVisible: no contentView!")
            return
        }
        
        try {
            if (visible) {
                console.log("[ContentViewManager] setVisible: applying bounds", this.bounds)
                this.contentView.setBounds(this.bounds)
                console.log("[ContentViewManager] Shown at:", this.bounds)
            } else {
                // Move off-screen to hide
                this.contentView.setBounds({ x: -10000, y: -10000, width: 800, height: 600 })
                console.log("[ContentViewManager] Hidden")
                
                // Clear content unless preserveContent is true (blur-div situation)
                if (!preserveContent) {
                    this.clearContent()
                }
            }
        } catch (e) {
            console.error("[ContentViewManager] setVisible error:", e)
        }
    }
    
    /**
     * Clear the content view (load blank page)
     */
    public clearContent(): void {
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            return
        }
        console.log("[ContentViewManager] Clearing content")
        this.currentUrl = ""
        this.pageLoaded = false
        this.contentView.webContents.loadURL("about:blank")
    }
    
    /**
     * Current keyboard zoom factor (separate from device emulation scale)
     */
    private keyboardZoomFactor: number = 1.0
    
    /**
     * Current CSS zoom level (for preload-based zoom when Visual Zoom is OFF)
     * Level: 0 = 100%, 1 = 110%, -1 = 90%, etc.
     */
    private cssZoomLevel: number = 0
    
    /**
     * Set zoom factor for keyboard +/- shortcuts
     * Uses Device Emulation scale parameter when visual zoom is enabled
     */
    public setZoomFactor(factor: number): void {
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            console.log("[ContentViewManager] setZoomFactor: webContents not ready")
            return
        }
        
        // Skip if emulation was already applied before navigation (async IPC arrived late)
        if (this.emulationAppliedBeforeLoad) {
            console.log("[ContentViewManager] setZoomFactor: skipping - emulation already applied pre-navigation")
            // Still update the factor for next time
            this.keyboardZoomFactor = Math.max(0.25, Math.min(5.0, factor))
            // Keep cssZoomLevel in sync (don't round)
            this.cssZoomLevel = (this.keyboardZoomFactor - 1.0) / 0.1
            // But DO send the zoom level to preload for overlay display
            const level = (factor - 1.0) / 0.1
            this.contentView.webContents.send('set-visual-zoom-level', level)
            return
        }
        
        // Clamp factor to reasonable range (0.25 to 5.0)
        const clampedFactor = Math.max(0.25, Math.min(5.0, factor))
        this.keyboardZoomFactor = clampedFactor
        // Keep cssZoomLevel in sync (don't round)
        this.cssZoomLevel = (clampedFactor - 1.0) / 0.1
        
        try {
            if (this.visualZoomEnabled) {
                // With Device Emulation, use scale parameter
                this.applyDeviceEmulationWithScale(clampedFactor)
                console.log("[ContentViewManager] Zoom via Device Emulation scale:", clampedFactor)
                // Send zoom level to preload for overlay display (don't round)
                const level = (clampedFactor - 1.0) / 0.1
                this.contentView.webContents.send('set-visual-zoom-level', level)
            } else {
                // Without Visual Zoom, use CSS zoom via preload
                // Convert factor to zoom level: 1.0 = 0, 1.1 = 1, 0.9 = -1 (don't round)
                const level = (clampedFactor - 1.0) / 0.1
                this.setCssZoom(level)
            }
        } catch (e) {
            console.error("[ContentViewManager] setZoomFactor error:", e)
        }
    }
    
    /**
     * Set CSS zoom level (for preload-based zoom when Visual Zoom is OFF)
     * Level: 0 = 100%, 1 = 110%, -1 = 90%, etc.
     * This matches the original CSS zoom behavior
     */
    public setCssZoom(level: number): void {
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            console.log("[ContentViewManager] setCssZoom: webContents not ready")
            return
        }
        
        // Clamp to reasonable range
        const clampedLevel = Math.max(-6, Math.min(40, level))
        this.cssZoomLevel = clampedLevel
        
        // Send to preload script
        this.contentView.webContents.send('content-view-set-css-zoom', clampedLevel)
        console.log("[ContentViewManager] CSS Zoom via preload:", clampedLevel)
    }
    
    /**
     * Get current CSS zoom level
     */
    public getCssZoomLevel(): number {
        return this.cssZoomLevel
    }
    
    /**
     * Apply device emulation with custom scale for keyboard zoom
     * Uses the central method that respects mobile mode viewport
     */
    private applyDeviceEmulationWithScale(scale: number): void {
        // keyboardZoomFactor is already set by setZoomFactor()
        // Just call the central method
        this.applyDeviceEmulationForCurrentMode()
    }
    
    /**
     * Get current zoom factor
     */
    public getZoomFactor(): number {
        if (!this.contentView?.webContents || this.contentView.webContents.isDestroyed()) {
            return 1.0
        }
        
        try {
            return this.contentView.webContents.getZoomFactor()
        } catch (e) {
            console.error("[ContentViewManager] getZoomFactor error:", e)
            return 1.0
        }
    }
    
    /**
     * Clear content view by loading about:blank
     * Use this when switching articles or cleaning up, not for blur-div hiding
     */
    public clear(): void {
        if (!this.contentView) return
        
        try {
            this.contentView.webContents.loadURL('about:blank')
            this.pageLoaded = false
            console.log("[ContentViewManager] Content cleared")
        } catch (e) {
            console.error("[ContentViewManager] clear error:", e)
        }
    }
    
    /**
     * Enable visual zoom (pinch-to-zoom) via device emulation
     * Only sets the flag - actual emulation is applied after did-finish-load
     */
    public enableVisualZoom(): void {
        console.log("[ContentViewManager] enableVisualZoom called - setting flag only")
        this.visualZoomEnabled = true
        
        // Notify preload to disable CSS-based zoom wrapper
        if (this.contentView?.webContents && !this.contentView.webContents.isDestroyed()) {
            this.contentView.webContents.send('set-visual-zoom-mode', true)
            console.log("[ContentViewManager] Sent set-visual-zoom-mode to preload")
        }
        
        // Device emulation will be applied in did-finish-load handler
        // DO NOT call applyDeviceEmulation here - causes crash on empty webContents!
    }
    
    /**
     * Apply device emulation for visual zoom
     * ONLY called after did-finish-load (like in POC)
     * This is the KEY to enabling pinch-to-zoom!
     */
    private applyDeviceEmulation(): void {
        console.log("[ContentViewManager] applyDeviceEmulation called - visualZoomEnabled:", this.visualZoomEnabled)
        if (!this.visualZoomEnabled || !this.contentView) {
            console.log("[ContentViewManager] applyDeviceEmulation: skipping (disabled or no view)")
            return
        }
        
        // Use the central method that handles all modes
        console.log("[ContentViewManager] applyDeviceEmulation: → calling applyDeviceEmulationForCurrentMode()")
        this.applyDeviceEmulationForCurrentMode()
    }
    
    /**
     * Called after page load - reapply device emulation (like POC does)
     */
    private applyVisualZoomIfEnabled(): void {
        console.log("[ContentViewManager] applyVisualZoomIfEnabled called")
        this.applyDeviceEmulation()
    }
    
    /**
     * Disable visual zoom
     * Only sets the flag - actual disabling happens after page load to avoid crash
     */
    public disableVisualZoom(): void {
        if (!this.contentView) return
        
        this.visualZoomEnabled = false
        console.log("[ContentViewManager] Visual zoom disabled (flag set)")
        
        // Only disable device emulation if a page has been loaded
        // Calling disableDeviceEmulation() on empty webContents causes V8 crash!
        if (this.pageLoaded && this.contentView.webContents && !this.contentView.webContents.isDestroyed()) {
            this.contentView.webContents.disableDeviceEmulation()
            console.log("[ContentViewManager] Device emulation disabled")
        } else {
            console.log("[ContentViewManager] Skipping disableDeviceEmulation - page not loaded yet")
        }
    }
    
    /**
     * Set mobile mode (changes user agent, optionally viewport)
     * Works alongside Visual Zoom - just adds mobile user agent
     */
    public setMobileMode(enabled: boolean): void {
        if (!this.contentView) return
        
        this.mobileMode = enabled
        const wc = this.contentView.webContents
        
        if (enabled) {
            // Set mobile user agent
            wc.setUserAgent(this.mobileUserAgent)
            console.log("[ContentViewManager] Mobile user agent set")
        } else {
            // Reset to desktop user agent
            wc.setUserAgent("")
            console.log("[ContentViewManager] Desktop user agent set")
        }
        
        // Only apply device emulation if a page has been loaded
        // Device emulation on empty webContents causes crashes!
        if (this.pageLoaded) {
            // Re-apply device emulation with current settings
            // This ensures Visual Zoom keeps working with the correct scale
            if (this.visualZoomEnabled) {
                this.applyDeviceEmulationForCurrentMode()
            } else if (!enabled) {
                // Only disable emulation if both visual zoom and mobile mode are off
                wc.disableDeviceEmulation()
            }
        } else {
            console.log("[ContentViewManager] Skipping device emulation - page not loaded yet")
        }
        
        console.log("[ContentViewManager] Mobile mode:", enabled, "Visual zoom:", this.visualZoomEnabled)
        
        // Inform preload script
        this.sendToContentView("set-mobile-mode", enabled)
        
        // Reload page so the server sees the new User-Agent
        if (this.pageLoaded) {
            console.log("[ContentViewManager] Reloading page for User-Agent change...")
            wc.reload()
        } else {
            console.log("[ContentViewManager] Page not loaded, skipping reload")
        }
    }
    
    /**
     * Apply device emulation based on current mode (Visual Zoom + Mobile Mode)
     * Combines all settings: viewport size, scale, and screen position
     * ONLY safe to call after did-finish-load!
     * 
     * EXPERIMENTAL: Adaptive viewport scaling
     * When scale exceeds critical threshold (content would overflow), the emulated
     * viewport is proportionally reduced. This triggers responsive layouts and
     * prevents content from being cut off.
     * 
     * @param forceBeforeLoad - If true, skip the pageLoaded check (used for pre-navigation setup)
     */
    private applyDeviceEmulationForCurrentMode(forceBeforeLoad: boolean = false): void {
        const wc = this.contentView?.webContents
        if (!wc || wc.isDestroyed()) return
        
        console.log("[ContentViewManager] applyDeviceEmulationForCurrentMode called:",
            "forceBeforeLoad:", forceBeforeLoad,
            "keyboardZoomFactor:", this.keyboardZoomFactor,
            "pageLoaded:", this.pageLoaded)
        
        // Safety check: don't apply device emulation before page is loaded
        // UNLESS forceBeforeLoad is set (for pre-navigation setup to prevent jump)
        if (!this.pageLoaded && !forceBeforeLoad) {
            console.log("[ContentViewManager] applyDeviceEmulationForCurrentMode: page not loaded yet, skipping")
            return
        }
        
        const { width, height } = this.bounds
        if (width <= 0 || height <= 0) {
            console.log("[ContentViewManager] applyDeviceEmulationForCurrentMode: invalid bounds")
            return
        }
        
        // Calculate viewport and scale based on mode
        let viewportWidth = width
        let viewportHeight = height
        let effectiveScale = this.keyboardZoomFactor
        
        console.log("[ContentViewManager] Calculating emulation:",
            "physicalSize:", width, "x", height,
            "initialScale:", effectiveScale)
        
        if (this.mobileMode) {
            // Mobile viewport is fixed at 768px (or less if screen is smaller)
            const mobileViewport = Math.min(768, width)
            viewportWidth = mobileViewport
            
            // Auto-scale to fill available width, then apply keyboard zoom on top
            // Example: width=1086, mobileViewport=768 → baseScale = 1086/768 ≈ 1.41
            const baseScale = width / mobileViewport
            effectiveScale = baseScale * this.keyboardZoomFactor
            
            // EXPERIMENTAL: Adaptive viewport when scale exceeds critical threshold
            // Critical scale = physical width / emulated width
            // In mobile mode: criticalScale ≈ 2.9 (1086/375 example)
            const criticalScale = width / mobileViewport
            if (effectiveScale > criticalScale) {
                // Reduce viewport proportionally to prevent overflow
                // New viewport = physical / effectiveScale
                viewportWidth = Math.round(width / effectiveScale)
                viewportHeight = Math.round(height / effectiveScale)
                console.log("[ContentViewManager] ADAPTIVE: Scale", effectiveScale.toFixed(2),
                    "exceeds critical", criticalScale.toFixed(2),
                    "→ reducing viewport to", viewportWidth, "x", viewportHeight)
            }
            
            console.log("[ContentViewManager] Mobile auto-scale:",
                "baseScale:", baseScale.toFixed(2),
                "keyboardZoom:", this.keyboardZoomFactor,
                "effectiveScale:", effectiveScale.toFixed(2))
        } else {
            // Normal mode (non-mobile)
            // EXPERIMENTAL: Adaptive viewport when scale exceeds 1.0
            // At scale > 1.0, content would overflow the physical viewport
            const criticalScale = 1.0
            if (effectiveScale > criticalScale) {
                // Reduce viewport proportionally to prevent overflow
                viewportWidth = Math.round(width / effectiveScale)
                viewportHeight = Math.round(height / effectiveScale)
                console.log("[ContentViewManager] ADAPTIVE: Scale", effectiveScale.toFixed(2),
                    "exceeds critical", criticalScale.toFixed(2),
                    "→ reducing viewport to", viewportWidth, "x", viewportHeight)
            }
        }
        
        try {
            wc.enableDeviceEmulation({
                screenPosition: 'mobile',  // Always 'mobile' for pinch-to-zoom
                screenSize: { width: viewportWidth, height: viewportHeight },
                viewSize: { width: viewportWidth, height: viewportHeight },
                viewPosition: { x: 0, y: 0 },
                deviceScaleFactor: 1,
                scale: effectiveScale,
            })
            console.log("[ContentViewManager] Device emulation applied:",
                "viewport:", viewportWidth, "x", viewportHeight,
                "scale:", effectiveScale.toFixed(2),
                "mobile:", this.mobileMode)
        } catch (e) {
            console.error("[ContentViewManager] applyDeviceEmulationForCurrentMode error:", e)
        }
    }
    
    /**
     * Send message to content view's preload script
     */
    public sendToContentView(channel: string, ...args: any[]): void {
        if (!this.contentView?.webContents) return
        
        this.contentView.webContents.send(channel, ...args)
    }
    
    /**
     * Execute JavaScript in content view
     */
    public async executeJavaScript(code: string): Promise<any> {
        if (!this.contentView?.webContents) return null
        
        return this.contentView.webContents.executeJavaScript(code)
    }
    
    /**
     * Send message to main renderer (React app)
     */
    private sendToRenderer(channel: string, data: any): void {
        if (this.parentWindow && !this.parentWindow.isDestroyed()) {
            this.parentWindow.webContents.send(channel, data)
        }
    }
    
    /**
     * Get current URL
     */
    public getCurrentUrl(): string {
        return this.currentUrl
    }
    
    /**
     * Check if content view is ready
     */
    public isReady(): boolean {
        return this.contentView !== null && !this.contentView.webContents.isDestroyed()
    }
    
    /**
     * Cleanup on window close
     */
    public destroy(): void {
        if (this.contentView) {
            // Close webContents to prevent memory leak
            this.contentView.webContents.close()
            this.contentView = null
        }
        this.parentWindow = null
        
        console.log("[ContentViewManager] Destroyed")
    }
}

// Singleton instance
let contentViewManagerInstance: ContentViewManager | null = null

export function getContentViewManager(): ContentViewManager {
    if (!contentViewManagerInstance) {
        contentViewManagerInstance = new ContentViewManager()
    }
    return contentViewManagerInstance
}

export function destroyContentViewManager(): void {
    if (contentViewManagerInstance) {
        contentViewManagerInstance.destroy()
        contentViewManagerInstance = null
    }
}
