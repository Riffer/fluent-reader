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
import { WebContentsView, ipcMain, app, session, Input } from "electron"
import type { BrowserWindow } from "electron"
import path from "path"

// Content view bounds (will be updated by renderer)
interface ContentViewBounds {
    x: number
    y: number
    width: number
    height: number
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
    private mobileUserAgent: string = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    
    // Preload script path
    // In dev mode, webpack puts electron.js in dist/, so app.getAppPath() = fluent-reader/dist
    // In packaged mode, app.getAppPath() = resources/app, and preload is in dist/
    private get preloadPath(): string {
        return path.join(
            app.getAppPath(),
            app.isPackaged ? "dist/webview-preload.js" : "webview-preload.js"
        )
    }
    
    constructor() {
        this.setupIpcHandlers()
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
            
            // Create sandbox session for content isolation (same as webview tag uses)
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
            
            // Set initial bounds (hidden off-screen)
            this.contentView.setBounds({ x: -10000, y: -10000, width: 800, height: 600 })
            console.log("[ContentViewManager] Initial bounds set")
            
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
            
            // Setup keyboard events forwarding
            this.setupKeyboardEvents()
            console.log("[ContentViewManager] Keyboard events setup")
            
            console.log("[ContentViewManager] WebContentsView created successfully")
        } catch (e) {
            console.error("[ContentViewManager] Error creating WebContentsView:", e)
        }
    }
    
    /**
     * Setup navigation and loading events
     */
    private setupNavigationEvents(): void {
        if (!this.contentView) return
        
        const wc = this.contentView.webContents
        
        wc.on("did-start-loading", () => {
            this.sendToRenderer("content-view-loading", true)
        })
        
        wc.on("did-stop-loading", () => {
            this.sendToRenderer("content-view-loading", false)
        })
        
        wc.on("did-finish-load", () => {
            console.log("[ContentViewManager] Page loaded:", this.currentUrl)
            this.pageLoaded = true  // Now safe to apply device emulation
            this.sendToRenderer("content-view-loaded", this.currentUrl)
            
            // Send visual zoom status to preload BEFORE applying device emulation
            // This ensures the preload doesn't create CSS zoom wrapper
            if (this.visualZoomEnabled) {
                wc.send('set-visual-zoom-mode', true)
                console.log("[ContentViewManager] Sent set-visual-zoom-mode after page load")
            }
            
            // Apply visual zoom AFTER page loads (like POC does)
            this.applyVisualZoomIfEnabled()
        })
        
        wc.on("did-fail-load", (event, errorCode, errorDescription, validatedURL) => {
            // Ignore aborted loads (user navigated away)
            if (errorCode === -3) return
            
            console.error("[ContentViewManager] Load failed:", errorCode, errorDescription)
            this.sendToRenderer("content-view-error", { errorCode, errorDescription, url: validatedURL })
        })
        
        wc.on("did-navigate", (event, url) => {
            this.currentUrl = url
            this.sendToRenderer("content-view-navigated", url)
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
     * Setup context menu forwarding
     */
    private setupContextMenu(): void {
        if (!this.contentView) return
        
        this.contentView.webContents.on("context-menu", (event, params) => {
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
        
        // Navigate to URL
        ipcMain.handle("content-view-navigate", async (event, url: string) => {
            console.log("[ContentViewManager] IPC: navigate to", url)
            return this.navigate(url)
        })
        
        // Update bounds
        ipcMain.on("content-view-set-bounds", (event, bounds: ContentViewBounds) => {
            console.log("[ContentViewManager] IPC: set bounds", bounds)
            this.setBounds(bounds)
        })
        
        // Show/hide content view
        ipcMain.on("content-view-set-visible", (event, visible: boolean) => {
            console.log("[ContentViewManager] IPC: set visible", visible)
            this.setVisible(visible)
        })
        
        // Send message to content view
        ipcMain.on("content-view-send", (event, channel: string, ...args: any[]) => {
            this.sendToContentView(channel, ...args)
        })
        
        // Execute JavaScript in content view
        ipcMain.handle("content-view-execute-js", async (event, code: string) => {
            return this.executeJavaScript(code)
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
            if (this.contentView?.webContents?.canGoBack()) {
                this.contentView.webContents.goBack()
                return true
            }
            return false
        })
        
        ipcMain.handle("content-view-go-forward", () => {
            if (this.contentView?.webContents?.canGoForward()) {
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
            return this.contentView?.webContents?.canGoBack() ?? false
        })
        
        ipcMain.handle("content-view-can-go-forward", () => {
            return this.contentView?.webContents?.canGoForward() ?? false
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
            this.setMobileMode(enabled)
        })
        
        // Focus content view
        ipcMain.on("content-view-focus", () => {
            if (this.contentView?.webContents && !this.contentView.webContents.isDestroyed()) {
                this.contentView.webContents.focus()
            }
        })
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
     */
    public setVisible(visible: boolean): void {
        console.log("[ContentViewManager] setVisible called:", visible)
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
            }
        } catch (e) {
            console.error("[ContentViewManager] setVisible error:", e)
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
        if (!this.visualZoomEnabled || !this.contentView) {
            return
        }
        
        const wc = this.contentView.webContents
        if (!wc || wc.isDestroyed()) {
            console.log("[ContentViewManager] applyDeviceEmulation: webContents not ready or destroyed")
            return
        }
        
        const { width, height } = this.bounds
        
        // Skip if bounds are invalid (hidden off-screen)
        if (width <= 0 || height <= 0) {
            console.log("[ContentViewManager] applyDeviceEmulation: invalid bounds, skipping")
            return
        }
        
        try {
            console.log("[ContentViewManager] applyDeviceEmulation:", width, "x", height)
            
            wc.enableDeviceEmulation({
                screenPosition: 'mobile',  // THIS is what enables visual zoom!
                screenSize: { width, height },
                viewSize: { width, height },
                viewPosition: { x: 0, y: 0 },
                deviceScaleFactor: 1,
                scale: 1,
            })
            
            console.log("[ContentViewManager] Device emulation enabled:", width, "x", height)
        } catch (e) {
            console.error("[ContentViewManager] applyDeviceEmulation error:", e)
        }
    }
    
    /**
     * Called after page load - reapply device emulation (like POC does)
     */
    private applyVisualZoomIfEnabled(): void {
        this.applyDeviceEmulation()
    }
    
    /**
     * Disable visual zoom
     */
    public disableVisualZoom(): void {
        if (!this.contentView) return
        
        this.contentView.webContents.disableDeviceEmulation()
        this.visualZoomEnabled = false
        console.log("[ContentViewManager] Visual zoom disabled")
    }
    
    /**
     * Set mobile mode (changes viewport + user agent)
     */
    public setMobileMode(enabled: boolean): void {
        if (!this.contentView) return
        
        this.mobileMode = enabled
        const wc = this.contentView.webContents
        const { width, height } = this.bounds
        
        if (enabled) {
            // Set mobile user agent
            wc.setUserAgent(this.mobileUserAgent)
            
            // Use fixed mobile viewport (768px width like iPhone)
            const mobileWidth = Math.min(768, width)
            
            wc.enableDeviceEmulation({
                screenPosition: "mobile",
                screenSize: { width: mobileWidth, height },
                viewSize: { width: mobileWidth, height },
                viewPosition: { x: 0, y: 0 },
                deviceScaleFactor: 1,
                scale: 1,
            })
            
            console.log("[ContentViewManager] Mobile mode enabled:", mobileWidth, "x", height)
        } else {
            // Reset to desktop
            wc.setUserAgent("")
            
            if (this.visualZoomEnabled) {
                // Keep visual zoom if enabled
                this.enableVisualZoom()
            } else {
                wc.disableDeviceEmulation()
            }
            
            console.log("[ContentViewManager] Mobile mode disabled")
        }
        
        // Inform preload script
        this.sendToContentView("set-mobile-mode", enabled)
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
