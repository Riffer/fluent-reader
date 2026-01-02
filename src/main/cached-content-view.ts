/**
 * CachedContentView - Encapsulates a WebContentsView with article-specific state
 * 
 * This class wraps a WebContentsView with all the metadata needed for caching:
 * - Article identification (articleId, feedId)
 * - Load status tracking
 * - Settings at time of load (zoom, mobile mode, etc.)
 * - Active/inactive state for IPC routing
 * 
 * Part of the Content View Pool system for prefetching articles.
 */
import { WebContentsView, session, app } from "electron"
import type { BrowserWindow } from "electron"
import path from "path"

/**
 * Navigation settings for loading content
 */
export interface NavigationSettings {
    zoomFactor: number       // Zoom factor (0.7 = 70%, 1.0 = 100%, etc.)
    visualZoom: boolean      // Whether Visual Zoom (Device Emulation) is enabled
    mobileMode: boolean      // Whether Mobile Mode is enabled
    showZoomOverlay: boolean // Whether to show zoom overlay
}

/**
 * Load status of the cached view
 */
export type CachedViewStatus = 'empty' | 'loading' | 'ready' | 'error'

/**
 * Events emitted by CachedContentView
 */
export interface CachedContentViewEvents {
    'status-changed': (status: CachedViewStatus) => void
    'dom-ready': () => void
    'load-error': (error: Error) => void
}

/**
 * CachedContentView - A WebContentsView wrapper with article context
 */
export class CachedContentView {
    // === Identification ===
    readonly id: string
    private _view: WebContentsView | null = null
    
    // === Article Context ===
    private _articleId: string | null = null
    private _feedId: string | null = null
    private _url: string | null = null
    
    // === Status ===
    private _status: CachedViewStatus = 'empty'
    private _loadError: Error | null = null
    private _loadStartTime: number = 0
    
    // === Settings at Load Time ===
    private _loadedWithZoom: number = 1.0
    private _loadedWithMobileMode: boolean = false
    private _loadedWithVisualZoom: boolean = false
    
    // === Activity State ===
    private _isActive: boolean = false
    
    // === Parent Reference ===
    private parentWindow: BrowserWindow | null = null
    
    // === Event Callbacks ===
    private onStatusChanged: ((status: CachedViewStatus) => void) | null = null
    private onDomReady: (() => void) | null = null
    private onLoadError: ((error: Error) => void) | null = null
    
    // === Mobile User Agent ===
    private static readonly MOBILE_USER_AGENT = 
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    
    /**
     * Preload script path
     */
    private static get preloadPath(): string {
        return path.join(
            app.getAppPath(),
            app.isPackaged ? "dist/content-preload.js" : "content-preload.js"
        )
    }
    
    // === Debug Background Colors (for visual differentiation) ===
    private static readonly DEBUG_COLORS: string[] = [
        '#FF6B6B',  // Red for view-0
        '#4ECDC4',  // Green/Teal for view-1  
        '#FFE66D',  // Yellow for view-2
        '#95E1D3',  // Mint for view-3 (if needed)
        '#F38181',  // Coral for view-4 (if needed)
    ]
    
    constructor(id: string) {
        this.id = id
    }
    
    /**
     * Get debug background color based on view ID
     */
    private getDebugBackgroundColor(): string {
        // Extract numeric index from id like "view-0", "view-1", etc.
        const match = this.id.match(/view-(\d+)/)
        const index = match ? parseInt(match[1], 10) : 0
        return CachedContentView.DEBUG_COLORS[index % CachedContentView.DEBUG_COLORS.length]
    }
    
    // ========== Getters ==========
    
    get view(): WebContentsView | null {
        return this._view
    }
    
    get webContentsId(): number | null {
        return this._view?.webContents?.id ?? null
    }
    
    get articleId(): string | null {
        return this._articleId
    }
    
    get feedId(): string | null {
        return this._feedId
    }
    
    get url(): string | null {
        return this._url
    }
    
    get status(): CachedViewStatus {
        return this._status
    }
    
    get loadError(): Error | null {
        return this._loadError
    }
    
    get isActive(): boolean {
        return this._isActive
    }
    
    get loadedWithZoom(): number {
        return this._loadedWithZoom
    }
    
    get loadedWithMobileMode(): boolean {
        return this._loadedWithMobileMode
    }
    
    get loadedWithVisualZoom(): boolean {
        return this._loadedWithVisualZoom
    }
    
    get isReady(): boolean {
        return this._status === 'ready'
    }
    
    get isEmpty(): boolean {
        return this._status === 'empty'
    }
    
    get isLoading(): boolean {
        return this._status === 'loading'
    }
    
    get hasError(): boolean {
        return this._status === 'error'
    }
    
    // ========== Event Registration ==========
    
    setOnStatusChanged(callback: ((status: CachedViewStatus) => void) | null): void {
        this.onStatusChanged = callback
    }
    
    setOnDomReady(callback: (() => void) | null): void {
        this.onDomReady = callback
    }
    
    setOnLoadError(callback: ((error: Error) => void) | null): void {
        this.onLoadError = callback
    }
    
    // ========== Lifecycle ==========
    
    /**
     * Create the underlying WebContentsView
     * Must be called before load()
     */
    create(parentWindow: BrowserWindow): void {
        if (this._view) {
            console.warn(`[CachedContentView:${this.id}] View already exists, destroying first`)
            this.destroy()
        }
        
        this.parentWindow = parentWindow
        
        try {
            // Create sandbox session for content isolation
            const sandboxSession = session.fromPartition("sandbox")
            
            this._view = new WebContentsView({
                webPreferences: {
                    preload: CachedContentView.preloadPath,
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    spellcheck: false,
                    session: sandboxSession,
                    webviewTag: false,
                }
            })
            
            // Set debug background color for visual differentiation of views
            // Each view gets a distinct color: red, green, yellow
            const debugColor = this.getDebugBackgroundColor()
            this._view.setBackgroundColor(debugColor)
            console.log(`[CachedContentView:${this.id}] Background color set to ${debugColor}`)
            
            // Start hidden (using native visibility)
            this._view.setVisible(false)
            
            // Add to parent window
            if (parentWindow && !parentWindow.isDestroyed()) {
                parentWindow.contentView.addChildView(this._view)
            }
            
            // Setup event handlers
            this.setupWebContentsEvents()
            
            console.log(`[CachedContentView:${this.id}] Created successfully`)
        } catch (e) {
            console.error(`[CachedContentView:${this.id}] Error creating view:`, e)
            this._view = null
        }
    }
    
    /**
     * Destroy the underlying WebContentsView
     */
    destroy(): void {
        if (!this._view) return
        
        try {
            if (this.parentWindow && !this.parentWindow.isDestroyed()) {
                this.parentWindow.contentView.removeChildView(this._view)
            }
        } catch (e) {
            console.error(`[CachedContentView:${this.id}] Error removing from parent:`, e)
        }
        
        this._view = null
        this.setStatus('empty')
        console.log(`[CachedContentView:${this.id}] Destroyed`)
    }
    
    /**
     * Recycle this view for a new article
     * Destroys the current WebContentsView and resets state
     */
    recycle(): void {
        console.log(`[CachedContentView:${this.id}] Recycling (was: ${this._articleId})`)
        
        // Destroy the view (must be recreated due to IPC/preload issues)
        this.destroy()
        
        // Reset article context
        this._articleId = null
        this._feedId = null
        this._url = null
        
        // Reset load state
        this._loadError = null
        this._loadStartTime = 0
        
        // Reset settings
        this._loadedWithZoom = 1.0
        this._loadedWithMobileMode = false
        this._loadedWithVisualZoom = false
        
        // Reset activity
        this._isActive = false
    }
    
    // ========== Navigation ==========
    
    /**
     * Load a URL with the given settings
     * Creates the WebContentsView if needed
     */
    async load(
        url: string, 
        articleId: string, 
        feedId: string | null,
        settings: NavigationSettings,
        useMobileUserAgent: boolean = false
    ): Promise<void> {
        // Ensure view exists
        if (!this._view && this.parentWindow) {
            this.create(this.parentWindow)
        }
        
        if (!this._view || !this._view.webContents) {
            throw new Error(`[CachedContentView:${this.id}] No view available`)
        }
        
        // Store article context
        this._articleId = articleId
        this._feedId = feedId
        this._url = url
        
        // Store settings
        this._loadedWithZoom = settings.zoomFactor
        this._loadedWithMobileMode = settings.mobileMode
        this._loadedWithVisualZoom = settings.visualZoom
        
        // Reset error state
        this._loadError = null
        this._loadStartTime = performance.now()
        
        // Set status to loading
        this.setStatus('loading')
        
        // Apply user agent
        if (useMobileUserAgent) {
            this._view.webContents.setUserAgent(CachedContentView.MOBILE_USER_AGENT)
        } else {
            this._view.webContents.setUserAgent("")
        }
        
        console.log(`[CachedContentView:${this.id}] Loading: ${articleId} (${url.substring(0, 50)}...)`)
        
        // Start navigation and wait for dom-ready
        // loadURL resolves when navigation starts, but we need to wait for dom-ready
        // to ensure the page is actually rendered and ready
        return new Promise<void>((resolve, reject) => {
            const wc = this._view!.webContents
            
            // Timeout after 30 seconds
            const timeout = setTimeout(() => {
                console.warn(`[CachedContentView:${this.id}] Load timeout after 30s`)
                cleanup()
                // Resolve anyway - partial content is better than nothing
                resolve()
            }, 30000)
            
            // Handler for dom-ready
            const onDomReady = () => {
                console.log(`[CachedContentView:${this.id}] dom-ready received in load()`)
                cleanup()
                resolve()
            }
            
            // Handler for load failure
            const onDidFailLoad = (event: Electron.Event, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
                if (isMainFrame && errorCode !== -3) {  // -3 = ERR_ABORTED
                    cleanup()
                    const err = new Error(`${errorDescription} (${errorCode})`)
                    this._loadError = err
                    this.setStatus('error')
                    this.onLoadError?.(err)
                    reject(err)
                }
            }
            
            // Cleanup function
            const cleanup = () => {
                clearTimeout(timeout)
                wc.removeListener('dom-ready', onDomReady)
                wc.removeListener('did-fail-load', onDidFailLoad)
            }
            
            // Register listeners
            wc.once('dom-ready', onDomReady)
            wc.on('did-fail-load', onDidFailLoad)
            
            // Start the navigation
            wc.loadURL(url).catch((err: any) => {
                // Ignore aborted navigations (user navigated away)
                // ERR_ABORTED can come as err.code === "ERR_ABORTED" or err.errno === -3
                const isAborted = err.code === "ERR_ABORTED" || err.errno === -3
                if (!isAborted) {
                    console.error(`[CachedContentView:${this.id}] Load error:`, err)
                    cleanup()
                    this._loadError = err
                    this.setStatus('error')
                    this.onLoadError?.(err)
                    reject(err)
                } else {
                    // Aborted - clean up silently
                    cleanup()
                    resolve()  // Resolve instead of reject - aborted is not an error
                }
            })
        })
    }
    
    // ========== Activity State ==========
    
    /**
     * Set whether this view is the active (visible) one
     * Inactive views should not send IPC events to the renderer
     */
    setActive(active: boolean): void {
        if (this._isActive === active) return
        
        this._isActive = active
        
        // Inform the preload script about activity state
        // Channel: 'cvp-set-active-state' (ContentViewPool prefix)
        if (this._view?.webContents && !this._view.webContents.isDestroyed()) {
            this._view.webContents.send('cvp-set-active-state', active)
        }
        
        console.log(`[CachedContentView:${this.id}] Active: ${active}`)
    }
    
    // ========== Visibility & Bounds ==========
    
    /**
     * Set the bounds of this view
     */
    setBounds(bounds: { x: number, y: number, width: number, height: number }): void {
        if (this._view) {
            this._view.setBounds(bounds)
        }
    }
    
    /**
     * Show or hide this view using native visibility
     * This is cleaner than moving off-screen with setBounds
     */
    setVisible(visible: boolean): void {
        if (this._view) {
            console.log(`[CachedContentView:${this.id}] setVisible(${visible})`)
            this._view.setVisible(visible)
        }
    }
    
    /**
     * Focus this view's webContents
     * Important for keyboard input to be captured
     */
    focus(): void {
        if (this._view?.webContents && !this._view.webContents.isDestroyed()) {
            this._view.webContents.focus()
            console.log(`[CachedContentView:${this.id}] focused`)
        }
    }
    
    /**
     * Hide this view (using native visibility)
     */
    hide(): void {
        this.setVisible(false)
    }
    
    /**
     * Show this view (using native visibility)
     */
    show(): void {
        this.setVisible(true)
    }
    
    // ========== WebContents Access ==========
    
    /**
     * Send IPC message to this view's webContents
     */
    send(channel: string, ...args: any[]): void {
        if (this._view?.webContents && !this._view.webContents.isDestroyed()) {
            this._view.webContents.send(channel, ...args)
        }
    }
    
    /**
     * Execute JavaScript in this view
     */
    async executeJavaScript(code: string): Promise<any> {
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            throw new Error('WebContents not available')
        }
        return this._view.webContents.executeJavaScript(code)
    }
    
    /**
     * Get the webContents (for advanced operations)
     */
    getWebContents() {
        return this._view?.webContents ?? null
    }
    
    // ========== Zoom Methods ==========
    
    /**
     * CSS zoom level (0 = 100%, 1 = 110%, -1 = 90%)
     */
    private _cssZoomLevel: number = 0
    
    /**
     * Set CSS zoom level (for preload-based zoom)
     * Level: 0 = 100%, 1 = 110%, -1 = 90%, etc.
     */
    setCssZoom(level: number): void {
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        
        const clampedLevel = Math.max(-6, Math.min(40, level))
        this._cssZoomLevel = clampedLevel
        
        this._view.webContents.send('content-view-set-css-zoom', clampedLevel)
    }
    
    /**
     * Get current CSS zoom level
     */
    getCssZoomLevel(): number {
        return this._cssZoomLevel
    }
    
    /**
     * Set visual zoom level (for overlay display)
     */
    setVisualZoomLevel(level: number): void {
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        this._view.webContents.send('set-visual-zoom-level', level)
    }
    
    /**
     * Set visual zoom mode flag
     */
    setVisualZoomMode(enabled: boolean): void {
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        this._view.webContents.send('set-visual-zoom-mode', enabled)
    }
    
    /**
     * Get the view for direct operations
     */
    getView(): WebContentsView | null {
        return this._view
    }
    
    // ========== Private Methods ==========
    
    private setStatus(status: CachedViewStatus): void {
        if (this._status === status) return
        
        const oldStatus = this._status
        this._status = status
        
        console.log(`[CachedContentView:${this.id}] Status: ${oldStatus} → ${status}`)
        this.onStatusChanged?.(status)
    }
    
    private setupWebContentsEvents(): void {
        if (!this._view) return
        
        const wc = this._view.webContents
        
        // DOM ready - page structure is available
        wc.on('dom-ready', () => {
            if (this._status === 'loading') {
                const loadTime = performance.now() - this._loadStartTime
                console.log(`[CachedContentView:${this.id}] DOM ready (${loadTime.toFixed(0)}ms)`)
                
                this.setStatus('ready')
                this.onDomReady?.()
                
                // Inject necessary scripts
                this.injectScripts()
            }
        })
        
        // Navigation started
        wc.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace) {
                // Main frame navigation - reset to loading if we were ready
                if (this._status === 'ready') {
                    this._loadStartTime = performance.now()
                    this.setStatus('loading')
                }
            }
        })
        
        // Load failed
        wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (isMainFrame && errorCode !== -3) {  // -3 = ERR_ABORTED (user navigated away)
                const error = new Error(`${errorDescription} (${errorCode})`)
                this._loadError = error
                this.setStatus('error')
                this.onLoadError?.(error)
            }
        })
    }
    
    /**
     * Inject necessary scripts after DOM ready
     */
    private injectScripts(): void {
        // Suppress JavaScript dialogs
        this.injectDialogSuppression()
        
        // Re-register touch event listeners (for CSS zoom)
        this.injectTouchEventListeners()
    }
    
    /**
     * Suppress alert/confirm/prompt dialogs
     */
    private injectDialogSuppression(): void {
        const script = `
            (function() {
                if (window.__dialogsSuppressed) return;
                window.__dialogsSuppressed = true;
                window.alert = function(msg) { console.warn('[Suppressed alert]', msg); };
                window.confirm = function(msg) { console.warn('[Suppressed confirm]', msg); return false; };
                window.prompt = function(msg) { console.warn('[Suppressed prompt]', msg); return null; };
            })();
        `
        this.executeJavaScript(script).catch(() => {})
    }
    
    /**
     * Re-register touch event listeners for CSS zoom
     */
    private injectTouchEventListeners(): void {
        const script = `
            (function() {
                if (window.cssZoomBridge && typeof window.cssZoomBridge.reRegisterTouchEvents === 'function') {
                    window.cssZoomBridge.reRegisterTouchEvents();
                }
            })();
        `
        this.executeJavaScript(script).catch(() => {})
    }
    
    // ========== Debug ==========
    
    /**
     * Get debug info about this view
     */
    toDebugString(): string {
        return `CachedContentView[${this.id}] { ` +
            `status: ${this._status}, ` +
            `articleId: ${this._articleId ?? 'null'}, ` +
            `feedId: ${this._feedId ?? 'null'}, ` +
            `isActive: ${this._isActive}, ` +
            `webContentsId: ${this.webContentsId ?? 'null'} }`
    }
}
