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
import { WebContentsView, ipcMain, app, session } from "electron"
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
    
    // Preload script path
    private get preloadPath(): string {
        return path.join(
            app.getAppPath(),
            app.isPackaged ? "dist/webview-preload.js" : "src/renderer/webview-preload.js"
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
        // Create sandbox session for content isolation
        const sandboxSession = session.fromPartition("sandbox")
        
        this.contentView = new WebContentsView({
            webPreferences: {
                preload: this.preloadPath,
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                spellcheck: false,
                partition: "sandbox",
                // Disable webview tag in content view (security)
                webviewTag: false,
            }
        })
        
        // Set initial bounds (hidden off-screen)
        this.contentView.setBounds({ x: -10000, y: -10000, width: 800, height: 600 })
        
        // Add to parent window's content view
        if (this.parentWindow && !this.parentWindow.isDestroyed()) {
            this.parentWindow.contentView.addChildView(this.contentView)
        }
        
        // Setup navigation events
        this.setupNavigationEvents()
        
        // Setup context menu
        this.setupContextMenu()
        
        console.log("[ContentViewManager] WebContentsView created")
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
            this.sendToRenderer("content-view-loaded", this.currentUrl)
            
            // Re-enable visual zoom after navigation
            if (this.visualZoomEnabled) {
                this.enableVisualZoom()
            }
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
     * Setup IPC handlers for renderer communication
     */
    private setupIpcHandlers(): void {
        // Navigate to URL
        ipcMain.handle("content-view-navigate", async (event, url: string) => {
            return this.navigate(url)
        })
        
        // Update bounds
        ipcMain.on("content-view-set-bounds", (event, bounds: ContentViewBounds) => {
            this.setBounds(bounds)
        })
        
        // Show/hide content view
        ipcMain.on("content-view-set-visible", (event, visible: boolean) => {
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
            this.visualZoomEnabled = enabled
            if (enabled) {
                this.enableVisualZoom()
            } else {
                this.disableVisualZoom()
            }
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
    }
    
    /**
     * Navigate content view to URL
     */
    public navigate(url: string): boolean {
        if (!this.contentView) {
            console.error("[ContentViewManager] Cannot navigate - not initialized")
            return false
        }
        
        this.currentUrl = url
        console.log("[ContentViewManager] Navigating to:", url)
        
        this.contentView.webContents.loadURL(url).catch(err => {
            // Ignore aborted navigations
            if (err.code !== "ERR_ABORTED") {
                console.error("[ContentViewManager] Navigation error:", err)
            }
        })
        
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
     */
    public setBounds(bounds: ContentViewBounds): void {
        this.bounds = bounds
        
        if (this.contentView && this.isVisible) {
            this.contentView.setBounds(bounds)
            console.log("[ContentViewManager] Bounds updated:", bounds)
        }
    }
    
    /**
     * Show or hide content view
     */
    public setVisible(visible: boolean): void {
        this.isVisible = visible
        
        if (!this.contentView) return
        
        if (visible) {
            this.contentView.setBounds(this.bounds)
            console.log("[ContentViewManager] Shown at:", this.bounds)
        } else {
            // Move off-screen to hide
            this.contentView.setBounds({ x: -10000, y: -10000, width: 800, height: 600 })
            console.log("[ContentViewManager] Hidden")
        }
    }
    
    /**
     * Enable visual zoom (pinch-to-zoom) via device emulation
     * This is the KEY feature that enables true Chrome-like zoom
     */
    public enableVisualZoom(): void {
        if (!this.contentView) return
        
        const wc = this.contentView.webContents
        const { width, height } = this.bounds
        
        wc.enableDeviceEmulation({
            screenPosition: "mobile",  // THIS enables visual zoom!
            screenSize: { width, height },
            viewSize: { width, height },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: 1,
            scale: 1,
        })
        
        this.visualZoomEnabled = true
        console.log("[ContentViewManager] Visual zoom enabled:", width, "x", height)
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
