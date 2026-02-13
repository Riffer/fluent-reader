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
import { 
    isVisualZoomEnabled, 
    isZoomOverlayEnabled, 
    isNsfwCleanupEnabled, 
    isAutoCookieConsentEnabled,
    isRedditGalleryExpandEnabled,
    isRedditSingleImageExpandEnabled
} from "./settings"

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
    private _articleIndex: number = -1  // Position in feed list for smart recycling
    private _isFullContentMode: boolean = false  // True if loaded with extracted FullContent (vs Local RSS content)
    
    // === Status ===
    private _status: CachedViewStatus = 'empty'
    private _loadError: Error | null = null
    private _loadStartTime: number = 0
    private _lastUsedAt: number = 0  // Timestamp when view was last activated (for LRU recycling)
    private _hasLoadedOnce: boolean = false  // True if dom-ready was ever received (survives status changes)
    
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
    private onVideoFullscreen: ((isFullscreen: boolean) => void) | null = null
    
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
    
    // === Debug Mode ===
    // Debug colors are only shown in development mode (not packaged)
    // Can be overridden with environment variable FLUENT_READER_DEBUG_COLORS=1
    private static get debugColorsEnabled(): boolean {
        // Enable debug colors in dev mode, unless packaged
        // Override with env var: FLUENT_READER_DEBUG_COLORS=1 to enable in packaged builds
        //                        FLUENT_READER_DEBUG_COLORS=0 to disable in dev builds
        const envOverride = process.env.FLUENT_READER_DEBUG_COLORS
        if (envOverride !== undefined) {
            return envOverride === '1' || envOverride.toLowerCase() === 'true'
        }
        return !app.isPackaged
    }
    
    // === Debug Background Colors (for visual differentiation in dev mode) ===
    private static readonly DEBUG_COLORS: string[] = [
        '#FF6B6B',  // Red for view-0
        '#4ECDC4',  // Green/Teal for view-1  
        '#FFE66D',  // Yellow for view-2
        '#95E1D3',  // Mint for view-3 (if needed)
        '#F38181',  // Coral for view-4 (if needed)
    ]
    
    // Transparent background for production
    private static readonly TRANSPARENT_COLOR = '#00000000'
    
    constructor(id: string) {
        this.id = id
    }
    
    /**
     * Get background color for view
     * Returns debug color in dev mode, transparent in production
     */
    private getBackgroundColor(): string {
        if (!CachedContentView.debugColorsEnabled) {
            return CachedContentView.TRANSPARENT_COLOR
        }
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
    
    get articleIndex(): number {
        return this._articleIndex
    }
    
    get isFullContentMode(): boolean {
        return this._isFullContentMode
    }
    
    set isFullContentMode(value: boolean) {
        this._isFullContentMode = value
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
    
    get lastUsedAt(): number {
        return this._lastUsedAt
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
    
    /**
     * Returns true if the view has ever completed loading (dom-ready).
     * This remains true even if the page is currently reloading due to ads/videos.
     * Reset only on recycle().
     */
    get hasLoadedOnce(): boolean {
        return this._hasLoadedOnce
    }
    
    get isEmpty(): boolean {
        return this._status === 'empty'
    }
    
    get isLoading(): boolean {
        return this._status === 'loading'
    }
    
    /**
     * Returns true if loading has been stuck for too long (> 60 seconds).
     * This helps detect views that are "zombies" - stuck in loading state
     * due to network issues or other problems.
     */
    get isStaleLoading(): boolean {
        if (this._status !== 'loading') return false
        if (this._loadStartTime === 0) return false
        const elapsed = performance.now() - this._loadStartTime
        return elapsed > 60000  // 60 seconds
    }
    
    setOnStatusChanged(callback: ((status: CachedViewStatus) => void) | null): void {
        this.onStatusChanged = callback
    }
    
    setOnDomReady(callback: (() => void) | null): void {
        this.onDomReady = callback
    }
    
    setOnLoadError(callback: ((error: Error) => void) | null): void {
        this.onLoadError = callback
    }
    
    setOnVideoFullscreen(callback: ((isFullscreen: boolean) => void) | null): void {
        this.onVideoFullscreen = callback
    }
    
    // ========== Lifecycle ==========
    
    /**
     * Build additionalArguments array for preload script
     * These settings are passed to the preload at creation time,
     * eliminating the need for sync IPC calls during page load.
     */
    private buildPreloadArgs(): string[] {
        return [
            `--zoom-level=${this._cssZoomLevel}`,
            `--mobile-mode=${this._loadedWithMobileMode}`,
            `--visual-zoom=${isVisualZoomEnabled()}`,
            `--zoom-overlay=${isZoomOverlayEnabled()}`,
            `--nsfw-cleanup=${isNsfwCleanupEnabled()}`,
            `--auto-cookie-consent=${isAutoCookieConsentEnabled()}`,
            `--reddit-gallery-expand=${isRedditGalleryExpandEnabled()}`,
            `--reddit-single-image-expand=${isRedditSingleImageExpandEnabled()}`
        ]
    }
    
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
            
            // Build settings arguments for preload script (eliminates sync IPC)
            const preloadArgs = this.buildPreloadArgs()
            
            this._view = new WebContentsView({
                webPreferences: {
                    preload: CachedContentView.preloadPath,
                    contextIsolation: true,
                    sandbox: true,
                    nodeIntegration: false,
                    spellcheck: false,
                    session: sandboxSession,
                    webviewTag: false,
                    additionalArguments: preloadArgs,
                    backgroundThrottling: false,  // Prevent Chromium from throttling background views during prefetch
                }
            })
            
            // Set debug background color for visual differentiation of views
            // Each view gets a distinct color: red, green, yellow
            const debugColor = this.getBackgroundColor()
            this._view.setBackgroundColor(debugColor)
            // console.log(`[CachedContentView:${this.id}] Background color set to ${debugColor}`)
            
            // Start hidden (using native visibility)
            this._view.setVisible(false)
            
            // Add to parent window
            if (parentWindow && !parentWindow.isDestroyed()) {
                parentWindow.contentView.addChildView(this._view)
            }
            
            // Setup event handlers
            this.setupWebContentsEvents()
            
            // console.log(`[CachedContentView:${this.id}] Created successfully`)
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
        // console.log(`[CachedContentView:${this.id}] Destroyed`)
    }
    
    /**
     * Recycle this view for a new article
     * Destroys the current WebContentsView and resets state
     */
    recycle(): void {
        // console.log(`[CachedContentView:${this.id}] Recycling (was: ${this._articleId})`)
        
        // Destroy the view (must be recreated due to IPC/preload issues)
        this.destroy()
        
        // Reset article context
        this._articleId = null
        this._feedId = null
        this._url = null
        this._isFullContentMode = false
        
        // Reset load state
        this._loadError = null
        this._loadStartTime = 0
        this._hasLoadedOnce = false  // Reset - this view needs to load fresh
        // NOTE: Keep _articleIndex - it helps track which index was last loaded
        // and enables prefetch status to correctly identify already-loaded indices.
        // It will be overwritten when a new article is loaded.
        
        // Reset settings
        this._loadedWithZoom = 1.0
        this._loadedWithMobileMode = false
        this._loadedWithVisualZoom = false
        
        // Reset activity
        this._isActive = false
        
        // Reset visibility state (start off-screen)
        this._isOffScreen = true
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
        useMobileUserAgent: boolean = false,
        articleIndex: number = -1
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
        this._articleIndex = articleIndex
        
        // Store settings
        this._loadedWithZoom = settings.zoomFactor
        this._loadedWithMobileMode = settings.mobileMode
        this._loadedWithVisualZoom = settings.visualZoom
        
        // Apply visual zoom settings BEFORE navigation
        // This ensures Device Emulation is applied correctly on dom-ready
        this._visualZoomEnabled = settings.visualZoom
        this._mobileMode = settings.mobileMode
        // Convert zoomFactor back to level: factor = 1.0 + (level * 0.1) → level = (factor - 1.0) / 0.1
        const zoomLevel = Math.round((settings.zoomFactor - 1.0) / 0.1)
        this._visualZoomLevel = zoomLevel
        this._cssZoomLevel = zoomLevel  // Also set CSS zoom level for get-css-zoom-level IPC
        
        // console.log(`[CachedContentView:${this.id}] Load settings: visualZoom=${settings.visualZoom}, zoomLevel=${zoomLevel}, mobileMode=${settings.mobileMode}`)
        
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
        
        // console.log(`[CachedContentView:${this.id}] Loading: ${articleId} (${url.substring(0, 50)}...)`)
        
        // Start navigation and wait for dom-ready
        // loadURL resolves when navigation starts, but we need to wait for dom-ready
        // to ensure the page is actually rendered and ready
        return new Promise<void>((resolve, reject) => {
            const wc = this._view!.webContents
            
            // Timeout after 30 seconds
            const timeout = setTimeout(() => {
                console.warn(`[CachedContentView:${this.id}] Load timeout after 30s`)
                cleanup()
                // Set error status so view can be recycled
                const err = new Error('Load timeout after 30s')
                this._loadError = err
                this.setStatus('error')
                this.onLoadError?.(err)
                resolve()  // Resolve (not reject) to not crash prefetch chain
            }, 30000)
            
            // Handler for dom-ready
            const onDomReady = () => {
                // console.log(`[CachedContentView:${this.id}] dom-ready received in load()`)
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
                    // Only log errors for URLs that match the original feed domain
                    // This filters out blocked ads/trackers (e.g., from Pi-Hole)
                    const shouldLog = this.shouldLogUrlError(err.url, url)
                    if (shouldLog) {
                        // Truncate data: URLs for readable logging
                        const displayUrl = this.truncateDataUrl(err.url || url)
                        console.error(`[CachedContentView:${this.id}] Load error: ${err.code || err.errno} - ${displayUrl}`)
                    }
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
    
    /**
     * Truncates data: URLs for readable logging.
     * data:text/html;base64,... URLs can be huge - only show the prefix.
     */
    private truncateDataUrl(url: string | undefined): string {
        if (!url) return '(no url)'
        if (url.startsWith('data:')) {
            const commaIndex = url.indexOf(',')
            if (commaIndex > 0) {
                return url.substring(0, commaIndex + 1) + '...(truncated)'
            }
        }
        return url
    }
    
    /**
     * Determines if a URL error should be logged.
     * Filters out errors from third-party domains (ads, trackers blocked by Pi-Hole, etc.)
     * Only logs errors for URLs matching the original feed domain.
     */
    private shouldLogUrlError(errorUrl: string | undefined, originalUrl: string): boolean {
        // Always log if we can't determine the error URL
        if (!errorUrl) return true
        
        // For data: URLs (RSS/Local mode), the original URL is generated HTML.
        // Any external resource that fails (ads, trackers) should be silently ignored.
        if (originalUrl.startsWith('data:')) {
            return false  // Don't log third-party failures for generated HTML content
        }
        
        try {
            const errorDomain = new URL(errorUrl).hostname
            const originalDomain = new URL(originalUrl).hostname
            
            // Extract base domain (handles subdomains)
            const getBaseDomain = (hostname: string): string => {
                const parts = hostname.split('.')
                // Return last 2 parts (e.g., "example.com" from "www.sub.example.com")
                return parts.slice(-2).join('.')
            }
            
            const errorBase = getBaseDomain(errorDomain)
            const originalBase = getBaseDomain(originalDomain)
            
            // Only log if domains match (same site's error, not blocked third-party)
            return errorBase === originalBase
        } catch {
            // If URL parsing fails, log the error
            return true
        }
    }
    
    // ========== Activity State ==========
    
    /**
     * Set whether this view is the active (visible) one
     * Inactive views should not send IPC events to the renderer
     * Also mutes audio when becoming inactive to stop background playback
     */
    setActive(active: boolean): void {
        if (this._isActive === active) return
        
        this._isActive = active
        
        // Update lastUsedAt timestamp on BOTH activation and deactivation
        // This keeps recently viewed articles "fresh" for LRU recycling,
        // especially important for direction changes (going back to previous article)
        this._lastUsedAt = Date.now()
        
        if (this._view?.webContents && !this._view.webContents.isDestroyed()) {
            // Inform the preload script about activity state
            // Channel: 'cvp-set-active-state' (ContentViewPool prefix)
            this._view.webContents.send('cvp-set-active-state', active)
            
            // Mute audio when becoming inactive to stop background video/audio playback
            // Unmute when becoming active again
            this._view.webContents.setAudioMuted(!active)
            
            // Additionally, pause all media when becoming inactive
            if (!active) {
                this._view.webContents.executeJavaScript(`
                    document.querySelectorAll('video, audio').forEach(el => {
                        if (!el.paused) el.pause();
                    });
                `).catch(() => {
                    // Ignore errors (e.g., page not ready)
                })
            }
        }
        
        // console.log(`[CachedContentView:${this.id}] Active: ${active}, audioMuted: ${!active}`)
    }
    
    // ========== Visibility & Bounds ==========
    
    /**
     * Off-screen position for hidden views
     * Using large negative values to move views completely off-screen
     * This preserves the view's rendering state (unlike setVisible which may suspend rendering)
     */
    private static readonly OFF_SCREEN_POSITION = -10000
    
    /**
     * Whether the view is currently positioned off-screen
     */
    private _isOffScreen: boolean = true
    
    /**
     * Whether the view is at the "render position" (1 pixel visible for background rendering)
     */
    private _isAtRenderPosition: boolean = false
    
    /**
     * Check if view is at render position
     */
    get isAtRenderPosition(): boolean {
        return this._isAtRenderPosition
    }
    
    /**
     * Set the bounds of this view
     * 
     * For on-screen views: applies bounds directly
     * For off-screen views: applies bounds at off-screen position (preserves correct size)
     * 
     * This ensures off-screen views always have the correct size, so no resize
     * rendering is needed when they become visible again.
     * 
     * IMPORTANT: Also re-applies Device Emulation when bounds change and visual zoom is enabled,
     * because Device Emulation viewport must match the actual view bounds.
     */
    setBounds(bounds: { x: number, y: number, width: number, height: number }): void {
        if (this._view) {
            if (this._isOffScreen) {
                // Apply size at off-screen position
                // This keeps off-screen views at the correct size
                this._view.setBounds({
                    x: CachedContentView.OFF_SCREEN_POSITION,
                    y: CachedContentView.OFF_SCREEN_POSITION,
                    width: bounds.width,
                    height: bounds.height
                })
            } else {
                // Apply bounds directly
                this._view.setBounds(bounds)
            }
            
            // Re-apply Device Emulation when bounds change (if visual zoom is enabled)
            // This is necessary because Device Emulation uses a fixed viewport size
            // that must match the actual view bounds for proper rendering
            if (this._visualZoomEnabled && this._status === 'ready' && !this._videoFullscreenActive) {
                const scale = 1.0 + (this._visualZoomLevel * 0.1)
                this.applyDeviceEmulation(Math.max(0.25, Math.min(5.0, scale)))
            }
        }
    }
    
    /**
     * Show or hide this view by moving it on-screen or off-screen
     * Using off-screen positioning instead of native setVisible() to preserve rendering state
     * (e.g., video playback position, scroll position, etc.)
     * 
     * @param visible - true to show, false to hide
     * @param bounds - The bounds to apply (from the pool's placeholder)
     *                 Required when visible=true, optional for visible=false (uses current size if not provided)
     */
    setVisible(visible: boolean, bounds?: { x: number, y: number, width: number, height: number }): void {
        if (this._view) {
            // console.log(`[CachedContentView:${this.id}] setVisible(${visible}, bounds=${bounds ? `${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}` : 'none'})`)
            
            if (visible) {
                // Move on-screen with provided bounds
                this._isOffScreen = false
                if (bounds) {
                    // console.log(`[CachedContentView:${this.id}] Applying bounds: ${bounds.width}x${bounds.height}@${bounds.x},${bounds.y}`)
                    this._view.setBounds(bounds)
                } else {
                    console.warn(`[CachedContentView:${this.id}] setVisible(true) called WITHOUT bounds!`)
                }
                // Keep native visibility on (in case it was ever turned off)
                this._view.setVisible(true)
            } else {
                // Move off-screen
                this._isOffScreen = true
                
                // Determine size to use at off-screen position
                let width: number, height: number
                if (bounds) {
                    // Use provided bounds (from pool) - ensures correct size
                    width = bounds.width
                    height = bounds.height
                } else {
                    // Fallback: use current size
                    const currentBounds = this._view.getBounds()
                    width = currentBounds.width > 0 ? currentBounds.width : 800
                    height = currentBounds.height > 0 ? currentBounds.height : 600
                }
                
                // Move to off-screen position with correct size
                this._view.setBounds({
                    x: CachedContentView.OFF_SCREEN_POSITION,
                    y: CachedContentView.OFF_SCREEN_POSITION,
                    width,
                    height
                })
                // Note: We don't call setVisible(false) to preserve rendering
                this._isAtRenderPosition = false
            }
        }
    }
    
    /**
     * Set this view to the "render position" - 1 pixel visible for background rendering
     * 
     * This positions the view so that exactly 1 pixel overlaps with the visible area,
     * which triggers Chromium to render the content even though it appears offscreen.
     * The active view should overlay this pixel so the user sees nothing.
     * 
     * This is used for the "next" article in reading direction to ensure it renders
     * before the user navigates to it.
     * 
     * @param bounds - The reference bounds (from active view area)
     */
    setRenderPosition(bounds: { x: number, y: number, width: number, height: number }): void {
        if (!this._view) return
        
        // Position so 1 pixel overlaps with the visible area at the top-left corner
        // x = bounds.x - width + 1 means the rightmost pixel of this view is at bounds.x
        this._view.setBounds({
            x: bounds.x - bounds.width + 1,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
        })
        
        this._isOffScreen = false  // Technically 1 pixel is on-screen
        this._isAtRenderPosition = true
        this._view.setVisible(true)
        
        console.log(`[CachedContentView:${this.id}] Set to render position (1px visible at x=${bounds.x})`)
    }
    
    /**
     * Move this view from render position to fully off-screen
     */
    moveOffScreen(bounds?: { x: number, y: number, width: number, height: number }): void {
        if (!this._view) return
        
        let width: number, height: number
        if (bounds) {
            width = bounds.width
            height = bounds.height
        } else {
            const currentBounds = this._view.getBounds()
            width = currentBounds.width > 0 ? currentBounds.width : 800
            height = currentBounds.height > 0 ? currentBounds.height : 600
        }
        
        this._view.setBounds({
            x: CachedContentView.OFF_SCREEN_POSITION,
            y: CachedContentView.OFF_SCREEN_POSITION,
            width,
            height
        })
        
        this._isOffScreen = true
        this._isAtRenderPosition = false
    }

    /**
     * Focus this view's webContents
     * Important for keyboard input to be captured
     * 
     * WORKAROUND: WebContentsView steals focus from the main window when loading URLs.
     * We must explicitly call focus() after load operations to restore keyboard input.
     * 
     * This is a known Electron bug:
     * https://github.com/electron/electron/issues/42578
     * 
     * Once fixed, the explicit focus() calls after load/activate can potentially be removed.
     */
    focus(): void {
        if (this._view?.webContents && !this._view.webContents.isDestroyed()) {
            this._view.webContents.focus()
            // console.log(`[CachedContentView:${this.id}] focused`)
        }
    }
    
    /**
     * Bring this view to the front (top of Z-order)
     * Used to ensure active view overlays render-position views
     */
    bringToFront(): void {
        if (!this._view || !this.parentWindow || this.parentWindow.isDestroyed()) return
        
        // Remove and re-add to bring to front
        // In Electron, the last added child is on top
        try {
            this.parentWindow.contentView.removeChildView(this._view)
            this.parentWindow.contentView.addChildView(this._view)
            // console.log(`[CachedContentView:${this.id}] brought to front`)
        } catch (e) {
            console.error(`[CachedContentView:${this.id}] Failed to bring to front:`, e)
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
            // console.log(`[CachedContentView:${this.id}] setCssZoom(${level}) - view not available`)
            return
        }
        
        const clampedLevel = Math.max(-6, Math.min(40, level))
        this._cssZoomLevel = clampedLevel
        
        // console.log(`[CachedContentView:${this.id}] setCssZoom: sending 'content-view-set-css-zoom' with level=${clampedLevel}`)
        this._view.webContents.send('content-view-set-css-zoom', clampedLevel)
    }
    
    /**
     * Get current CSS zoom level
     */
    getCssZoomLevel(): number {
        return this._cssZoomLevel
    }
    
    /**
     * Visual zoom level for Device Emulation
     */
    private _visualZoomLevel: number = 0
    
    /**
     * Whether visual zoom (Device Emulation) is enabled
     */
    private _visualZoomEnabled: boolean = false
    
    /**
     * Whether video is currently in fullscreen mode (disables Device Emulation)
     */
    private _videoFullscreenActive: boolean = false
    
    /**
     * Set video fullscreen mode
     * When entering fullscreen, Device Emulation is disabled to allow native video sizing
     * When exiting fullscreen, Device Emulation is restored if it was enabled
     */
    setVideoFullscreen(isFullscreen: boolean): void {
        this._videoFullscreenActive = isFullscreen
        
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        
        // console.log(`[CachedContentView:${this.id}] setVideoFullscreen: ${isFullscreen}, visualZoom=${this._visualZoomEnabled}`)
        
        if (isFullscreen) {
            // Disable Device Emulation to let video take full screen
            this._view.webContents.disableDeviceEmulation()
        } else if (this._visualZoomEnabled && this._status === 'ready') {
            // Restore Device Emulation when exiting fullscreen
            const scale = 1.0 + (this._visualZoomLevel * 0.1)
            const clampedScale = Math.max(0.25, Math.min(5.0, scale))
            this.applyDeviceEmulation(clampedScale)
        }
    }
    
    /**
     * Set visual zoom level and apply Device Emulation
     * Level: 0 = 100%, 1 = 110%, -1 = 90%, etc.
     */
    setVisualZoomLevel(level: number): void {
        this._visualZoomLevel = level
        
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        
        // Calculate scale factor from level (0 = 1.0, 1 = 1.1, -1 = 0.9, etc.)
        const scale = 1.0 + (level * 0.1)
        const clampedScale = Math.max(0.25, Math.min(5.0, scale))
        
        // console.log(`[CachedContentView:${this.id}] setVisualZoomLevel: level=${level}, scale=${clampedScale}, status=${this._status}`)
        
        // Apply Device Emulation with new scale - only if ready AND not in video fullscreen
        // For empty/loading views, it will be applied at dom-ready
        if (this._visualZoomEnabled && this._status === 'ready' && !this._videoFullscreenActive) {
            this.applyDeviceEmulation(clampedScale)
        }
        
        // Notify preload for overlay display (safe even if not ready)
        try {
            this._view.webContents.send('set-visual-zoom-level', level)
        } catch (e) {
            // Ignore errors if webContents is not ready
        }
    }
    
    /**
     * Mobile Mode flag - constrains viewport to mobile width
     */
    private _mobileMode: boolean = false
    
    /**
     * Mobile viewport width (pixels)
     */
    private static readonly MOBILE_VIEWPORT_WIDTH = 767
    
    /**
     * Apply Device Emulation with specified scale
     * This enables zoom while preserving touch/pinch-to-zoom capability
     * Also handles Mobile Mode viewport constraints
     * 
     * @param zoomScale - User's zoom level (1.0 = 100%, 1.1 = 110%, etc.)
     */
    private applyDeviceEmulation(zoomScale: number): void {
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        
        const wc = this._view.webContents
        const bounds = this._view.getBounds()
        
        // Get actual view dimensions
        const actualWidth = bounds.width || 800
        const actualHeight = bounds.height || 600
        
        // Determine viewport size and scale based on mobile mode
        let viewWidth: number
        let viewHeight: number
        let totalScale: number
        
        if (this._mobileMode) {
            // Mobile Mode: Use fixed mobile width
            // Scale = (actualWidth / mobileWidth) * zoomScale
            // This makes the 767px viewport fill the actual view width, then applies zoom
            viewWidth = CachedContentView.MOBILE_VIEWPORT_WIDTH
            viewHeight = Math.round(actualHeight * (CachedContentView.MOBILE_VIEWPORT_WIDTH / actualWidth))
            
            // Calculate scale: first scale mobile viewport to fit actual width, then apply zoom
            const mobileToActualScale = actualWidth / CachedContentView.MOBILE_VIEWPORT_WIDTH
            totalScale = mobileToActualScale * zoomScale
        } else {
            // Check if this is a local content view (RSS/Local mode uses data: URLs)
            // Webpage mode uses http:// or https:// URLs
            const isLocalContent = this._url?.startsWith('data:')
            
            if (isLocalContent) {
                // RSS/Local mode: Scale WIDTH but keep HEIGHT at full placeholder size
                // 
                // The `scale` factor is applied to BOTH dimensions by Device Emulation.
                // To achieve "scaled width, full height":
                // - Width: Use actual width → after scale, width = actualWidth * scale (scaled!)
                // - Height: Compensate with larger viewport → after scale, height = actualHeight (full!)
                //
                // Example at 60% zoom (scale = 0.6):
                //   viewWidth = actualWidth → final width = actualWidth * 0.6 = 60% (scaled)
                //   viewHeight = actualHeight / 0.6 → final height = (actualHeight / 0.6) * 0.6 = 100% (full)
                //
                // This keeps content vertically filling the full placeholder while
                // horizontally scaling to show the zoom effect.
                viewWidth = actualWidth  // No compensation → will be scaled
                viewHeight = Math.round(actualHeight / zoomScale)  // Compensate → will stay full height
            } else {
                // Webpage/FullContent mode: Scale BOTH dimensions equally
                // This ensures the webpage layout is preserved at any zoom level
                // (width and height both scale proportionally)
                viewWidth = Math.round(actualWidth / zoomScale)
                viewHeight = Math.round(actualHeight / zoomScale)
            }
            totalScale = zoomScale
        }
        
        // For Visual Zoom with Pinch-to-Zoom support:
        // - Use "mobile" screenPosition to enable touch events
        // - Set scale for initial zoom level
        // - deviceScaleFactor affects how the page renders (1 = normal)
        const emulationParams = {
            screenPosition: "mobile" as const,  // Enable touch events for pinch-to-zoom
            screenSize: { width: viewWidth, height: viewHeight },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: 1,
            viewSize: { width: viewWidth, height: viewHeight },
            scale: totalScale
        }
        
        // console.log(`[CachedContentView:${this.id}] Device Emulation: article=${this._articleId}, zoomScale=${zoomScale.toFixed(2)}, totalScale=${totalScale.toFixed(2)}, viewport=${viewWidth}x${viewHeight}, mobileMode=${this._mobileMode}`)
        wc.enableDeviceEmulation(emulationParams)
    }
    
    /**
     * Set Mobile Mode (viewport constraint)
     */
    setMobileMode(enabled: boolean): void {
        const wasEnabled = this._mobileMode
        this._mobileMode = enabled
        
        // console.log(`[CachedContentView:${this.id}] setMobileMode: ${wasEnabled} -> ${enabled}, status=${this._status}`)
        
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        
        // If visual zoom is enabled and view is ready, re-apply emulation with new viewport
        if (this._visualZoomEnabled && this._status === 'ready') {
            const scale = 1.0 + (this._visualZoomLevel * 0.1)
            this.applyDeviceEmulation(Math.max(0.25, Math.min(5.0, scale)))
        }
        
        // Notify preload about mobile mode change
        try {
            this._view.webContents.send('set-mobile-mode', enabled)
        } catch (e) {
            // Ignore errors if webContents is not ready
        }
    }
    
    /**
     * Get Mobile Mode status
     */
    getMobileMode(): boolean {
        return this._mobileMode
    }
    /**
     * Set visual zoom mode flag and enable/disable Device Emulation
     * Note: Device Emulation is only applied when content has been loaded (status !== 'empty')
     */
    setVisualZoomMode(enabled: boolean): void {
        const wasEnabled = this._visualZoomEnabled
        this._visualZoomEnabled = enabled
        
        // console.log(`[CachedContentView:${this.id}] setVisualZoomMode: ${wasEnabled} -> ${enabled}, status=${this._status}`)
        
        // Only apply Device Emulation if view exists and has been used
        if (!this._view?.webContents || this._view.webContents.isDestroyed()) {
            return
        }
        
        // Only apply Device Emulation if we have already loaded content
        // For empty views, it will be applied when content loads via dom-ready
        if (this._status === 'ready') {
            if (enabled && !wasEnabled) {
                // Just enabled - apply current zoom level via Device Emulation
                const scale = 1.0 + (this._visualZoomLevel * 0.1)
                this.applyDeviceEmulation(Math.max(0.25, Math.min(5.0, scale)))
            } else if (!enabled && wasEnabled) {
                // Just disabled - disable Device Emulation
                this._view.webContents.disableDeviceEmulation()
            }
        }
        
        // Notify preload (safe even if no content loaded yet)
        try {
            this._view.webContents.send('set-visual-zoom-mode', enabled)
        } catch (e) {
            // Ignore errors if webContents is not ready
        }
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
        
        // console.log(`[CachedContentView:${this.id}] Status: ${oldStatus} -> ${status}`)
        this.onStatusChanged?.(status)
    }
    
    private setupWebContentsEvents(): void {
        if (!this._view) return
        
        const wc = this._view.webContents
        
        // DOM ready - page structure is available
        wc.on('dom-ready', () => {
            if (this._status === 'loading') {
                const loadTime = performance.now() - this._loadStartTime
                // console.log(`[CachedContentView:${this.id}] DOM ready (${loadTime.toFixed(0)}ms)`)
                
                this.setStatus('ready')
                this._hasLoadedOnce = true  // Mark that we've successfully loaded once
                this.onDomReady?.()
                
                // Apply Device Emulation if Visual Zoom is enabled
                // This must happen after content loads to avoid crashes
                if (this._visualZoomEnabled) {
                    const scale = 1.0 + (this._visualZoomLevel * 0.1)
                    // console.log(`[CachedContentView:${this.id}] Applying Visual Zoom on dom-ready: scale=${scale}`)
                    this.applyDeviceEmulation(Math.max(0.25, Math.min(5.0, scale)))
                }
                
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
        
        // HTML5 Video Fullscreen - entering
        wc.on('enter-html-full-screen', () => {
            // console.log(`[CachedContentView:${this.id}] Video entering fullscreen`)
            this.onVideoFullscreen?.(true)
        })
        
        // HTML5 Video Fullscreen - leaving
        wc.on('leave-html-full-screen', () => {
            // console.log(`[CachedContentView:${this.id}] Video leaving fullscreen`)
            this.onVideoFullscreen?.(false)
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
