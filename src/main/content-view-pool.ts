/**
 * ContentViewPool - Manages a pool of CachedContentViews for article prefetching
 * 
 * This class provides:
 * - Pool of WebContentsViews (default: 3)
 * - Prefetching based on reading direction
 * - Instant view switching when article is already cached
 * - LRU-based recycling of views
 * 
 * Architecture:
 * - Pool manages N CachedContentViews
 * - One view is "active" (visible to user)
 * - Other views prefetch next/previous articles
 * - When user navigates, views are swapped instantly if target is cached
 */
import { ipcMain, BrowserWindow, Menu, clipboard, shell, nativeImage, net } from "electron"
import type { MenuItemConstructorOptions, Input } from "electron"
import { CachedContentView, NavigationSettings, CachedViewStatus } from "./cached-content-view"
import { isMobileUserAgentEnabled, isVisualZoomEnabled } from "./settings"
import { extractFromHtml } from "@extractus/article-extractor"
import { generateArticleHtml, generateFullContentHtml, textDirToString, TextDirection } from "./article-html-generator"
import https from "https"
import http from "http"
import fs from "fs"
import path from "path"

/**
 * Pool configuration
 */
export interface PoolConfig {
    size: number              // Pool size (min: 2, default: 3)
    prefetchDelay: number     // Delay after dom-ready before prefetch (ms)
    enabled: boolean          // Whether prefetching is enabled
}

/**
 * Reading direction for prefetch prioritization
 */
export type ReadingDirection = 'forward' | 'backward' | 'unknown'

/**
 * Content view bounds
 */
interface ContentViewBounds {
    x: number
    y: number
    width: number
    height: number
}

/**
 * Prefetch request from renderer
 */
interface PrefetchRequest {
    articleId: string
    url: string
    feedId: string | null
    settings: NavigationSettings
}

/**
 * Source open target modes (must match renderer's SourceOpenTarget)
 */
enum PrefetchOpenTarget {
    Local = 0,       // RSS/Local content
    Webpage = 1,     // Load webpage directly
    External = 2,    // Open in external browser
    FullContent = 3  // Extract and show full content
}

/**
 * Extended prefetch info from renderer (for FullContent)
 */
interface PrefetchArticleInfo {
    articleId: string
    itemLink: string
    itemContent: string
    itemTitle: string
    itemDate: number
    openTarget: PrefetchOpenTarget
    textDir: number
    fontSize: number
    fontFamily: string
    locale: string
}

/**
 * ContentViewPool - Manages cached WebContentsViews
 */
export class ContentViewPool {
    // === Pool ===
    private views: CachedContentView[] = []
    private activeViewId: string | null = null
    
    // === Mappings ===
    private viewsByWebContentsId: Map<number, CachedContentView> = new Map()
    
    // === Configuration ===
    private config: PoolConfig = {
        size: 5,
        prefetchDelay: 1,  // Reduced for testing (was 400ms)
        enabled: true
    }
    
    // === Parent Window ===
    private parentWindow: BrowserWindow | null = null
    
    // === Bounds ===
    private visibleBounds: ContentViewBounds = { x: 0, y: 0, width: 800, height: 600 }
    private boundsReceived: boolean = false  // Track if real bounds have been received from renderer
    private isPoolVisible: boolean = false
    private videoFullscreenActive: boolean = false  // Track if video is in fullscreen mode
    
    // === Reading Direction ===
    private readingDirection: ReadingDirection = 'unknown'
    private currentArticleIndex: number = -1
    private articleListLength: number = 0
    
    // === Prefetch Timer ===
    private prefetchTimer: NodeJS.Timeout | null = null
    private pendingPrefetch: PrefetchRequest[] = []
    private protectedArticleIds: Set<string> = new Set()  // Articles that should not be recycled (prefetch targets)
    
    // === Zoom State ===
    private cssZoomLevel: number = 0
    private visualZoomEnabled: boolean = false
    private mobileMode: boolean = false
    
    // === Singleton ===
    private static instance: ContentViewPool | null = null
    
    static getInstance(): ContentViewPool {
        if (!ContentViewPool.instance) {
            ContentViewPool.instance = new ContentViewPool()
        }
        return ContentViewPool.instance
    }
    
    private constructor() {
        this.setupIpcHandlers()
    }
    
    // ========== Initialization ==========
    
    /**
     * Initialize the pool with a parent window
     */
    initialize(parentWindow: BrowserWindow): void {
        if (this.parentWindow) {
            console.warn("[ContentViewPool] Already initialized")
            return
        }
        
        this.parentWindow = parentWindow
        
        // Load initial settings from store
        this.visualZoomEnabled = isVisualZoomEnabled()
        console.log(`[ContentViewPool] Initialized with pool size: ${this.config.size}, visualZoom: ${this.visualZoomEnabled}`)
        
        // Views are created lazily when needed
    }
    
    /**
     * Update pool configuration
     */
    setConfig(config: Partial<PoolConfig>): void {
        this.config = { ...this.config, ...config }
        
        // Ensure minimum size
        if (this.config.size < 2) {
            console.warn("[ContentViewPool] Pool size must be at least 2, setting to 2")
            this.config.size = 2
        }
        
        console.log(`[ContentViewPool] Config updated:`, this.config)
    }
    
    // ========== View Creation Helper ==========
    
    /**
     * Create a view and setup all event handlers
     * Also applies current bounds so the view is correctly positioned
     */
    private createViewWithEvents(view: CachedContentView): void {
        if (!this.parentWindow) {
            console.error("[ContentViewPool] Cannot create view - no parent window")
            return
        }
        
        view.create(this.parentWindow)
        this.setupViewKeyboardEvents(view)
        this.setupViewContextMenu(view)
        this.setupFocusGuard(view)  // Prevent background views from stealing focus
        this.setupVideoFullscreenEvents(view)  // Handle HTML5 video fullscreen
        this.updateWebContentsMapping()
        
        // Apply current bounds to the newly created view
        view.setBounds(this.visibleBounds)
        
        // Apply current visual zoom mode to the view
        view.setVisualZoomMode(this.visualZoomEnabled)
        
        // Apply current mobile mode to the view
        view.setMobileMode(this.mobileMode)
        
        // Apply current zoom level
        if (this.visualZoomEnabled) {
            view.setVisualZoomLevel(this.cssZoomLevel)
        } else {
            view.setCssZoom(this.cssZoomLevel)
        }
    }
    
    /**
     * Setup video fullscreen event handling
     * When a video enters/leaves fullscreen, notify renderer to adjust UI
     */
    private setupVideoFullscreenEvents(view: CachedContentView): void {
        view.setOnVideoFullscreen((isFullscreen) => {
            // Only send events for the active view
            if (view.isActive) {
                console.log(`[ContentViewPool] Video fullscreen: ${isFullscreen}`)
                this.sendToRenderer('content-view-video-fullscreen', isFullscreen)
                
                // Track fullscreen state to prevent setBounds from overriding
                this.videoFullscreenActive = isFullscreen
                
                // When entering fullscreen, expand view to fill entire window
                if (isFullscreen && this.parentWindow && !this.parentWindow.isDestroyed()) {
                    // Disable Device Emulation FIRST for proper video sizing
                    view.setVideoFullscreen(true)
                    
                    // Make window fullscreen for immersive experience
                    if (!this.parentWindow.isFullScreen()) {
                        this.parentWindow.setFullScreen(true)
                    }
                    
                    // Then set view bounds to full window - use setTimeout to ensure window is fullscreen
                    setTimeout(() => {
                        if (this.parentWindow && !this.parentWindow.isDestroyed()) {
                            const [width, height] = this.parentWindow.getContentSize()
                            console.log(`[ContentViewPool] Setting fullscreen bounds: ${width}x${height}`)
                            view.setBounds({ x: 0, y: 0, width, height })
                            
                            // Force the content to recognize the new size by triggering a resize event
                            this.triggerContentResize(view)
                        }
                    }, 100)
                } else if (!isFullscreen) {
                    // Exit window fullscreen if we entered it
                    if (this.parentWindow && !this.parentWindow.isDestroyed() && this.parentWindow.isFullScreen()) {
                        this.parentWindow.setFullScreen(false)
                    }
                    
                    // Restore normal bounds FIRST, then restore Device Emulation
                    // This ensures Device Emulation uses the correct viewport size
                    setTimeout(() => {
                        view.setBounds(this.visibleBounds)
                        
                        // Force the content to recognize the restored size
                        this.triggerContentResize(view)
                        
                        // Now restore Device Emulation with correct bounds
                        // Small additional delay to ensure bounds are applied
                        setTimeout(() => {
                            view.setVideoFullscreen(false)
                        }, 50)
                    }, 100)
                }
            }
        })
    }
    
    /**
     * Force the WebContents to recognize new bounds by triggering a resize event
     * and invalidating the render cache
     */
    private triggerContentResize(view: CachedContentView): void {
        const wc = view.getWebContents()
        if (!wc || wc.isDestroyed()) return
        
        // Dispatch resize event to the window in the WebContents
        wc.executeJavaScript(`
            window.dispatchEvent(new Event('resize'));
        `).catch(() => {
            // Ignore errors (e.g., if page is not ready)
        })
        
        // Invalidate render cache to force repaint
        wc.invalidate()
    }
    
    /**
     * Setup focus guard: When a background view fires dom-ready,
     * ensure focus stays on the active view.
     * 
     * Problem: Electron may internally shift focus when a WebContentsView
     * completes loading (dom-ready). This causes the active view to lose
     * keyboard input.
     * 
     * Solution: Listen to dom-ready on all views and refocus the active view
     * if a background view triggered the event.
     */
    private setupFocusGuard(view: CachedContentView): void {
        const wc = view.getWebContents()
        if (!wc) return
        
        wc.on('dom-ready', () => {
            // If THIS view is NOT active but another view IS active,
            // refocus the active view to prevent focus theft
            if (!view.isActive && this.activeViewId) {
                const activeView = this.getActiveView()
                if (activeView && activeView.isReady) {
                    console.log(`[ContentViewPool] Focus guard: Background ${view.id} fired dom-ready, refocusing active ${activeView.id}`)
                    // Small delay to ensure Electron has finished its internal focus handling
                    setTimeout(() => {
                        if (activeView.isActive) {
                            activeView.focus()
                        }
                    }, 10)
                }
            }
        })
    }
    
    /**
     * Keys that are handled by the app and should NOT be passed to the page
     * These keys are processed via IPC and would cause conflicts if also handled by the page
     * (e.g., "m" for mobile mode would also mute HTML5 videos)
     */
    private static readonly BLOCKED_KEYS = new Set([
        'm', 'M',           // Mobile mode toggle (conflicts with video mute)
        'w', 'W',           // Full content toggle
        'p', 'P',           // Visual zoom toggle
        'h', 'H',           // Hide toggle
        '+', '=',           // Zoom in
        '-', '_',           // Zoom out
        '#',                // Reset zoom
        'ArrowLeft',        // Previous article
        'ArrowRight',       // Next article
        'Escape',           // Close/back
        // Note: ArrowUp/ArrowDown are NOT blocked - needed for scrolling in page
    ])
    
    /**
     * Keys that should be passed through to the page during video fullscreen
     * These are typically video player controls that conflict with app shortcuts
     */
    private static readonly VIDEO_FULLSCREEN_PASSTHROUGH_KEYS = new Set([
        'm', 'M',           // Video mute toggle
        'ArrowLeft',        // Video seek backward
        'ArrowRight',       // Video seek forward
    ])
    
    /**
     * Setup keyboard event forwarding for a view
     */
    private setupViewKeyboardEvents(view: CachedContentView): void {
        const wc = view.getWebContents()
        if (!wc) return
        
        wc.on("before-input-event", (event, input: Input) => {
            // IMPORTANT: Only process keyDown events, NOT keyUp!
            // When user presses ArrowRight:
            // 1. keyDown fires on view-0 → navigation triggers → view-1 becomes active
            // 2. keyUp fires on view-1 (now active!) → would trigger ANOTHER navigation!
            // This causes article skipping.
            if (input.type !== 'keyDown') {
                return
            }
            
            // Only forward events from the active view
            if (!view.isActive) return
            
            // Don't forward F11/F12 - global shortcuts handled by main window
            if (input.key === 'F11' || input.key === 'F12') {
                return
            }
            
            // During video fullscreen, let certain keys pass through to the video player
            // instead of being handled by the app (e.g., ArrowLeft/Right for seeking, m for mute)
            if (this.videoFullscreenActive && ContentViewPool.VIDEO_FULLSCREEN_PASSTHROUGH_KEYS.has(input.key)) {
                console.log(`[ContentViewPool] Video fullscreen: passing ${input.key} to page`)
                return  // Don't block, don't forward to renderer - let page handle it
            }
            
            // Block keys that we handle via IPC to prevent page from also handling them
            // e.g., "m" toggles mobile mode but would also mute videos
            if (ContentViewPool.BLOCKED_KEYS.has(input.key)) {
                event.preventDefault()
            }
            
            // Forward to renderer for processing
            console.log(`[ContentViewPool] Forwarding ${input.key} from ${view.id} to renderer`)
            this.sendToRenderer("content-view-input", input)
        })
    }
    
    /**
     * Setup context menu for a view
     */
    private setupViewContextMenu(view: CachedContentView): void {
        const wc = view.getWebContents()
        if (!wc) return
        
        wc.on("context-menu", (event, params) => {
            // Only show context menu for active view
            if (!view.isActive) return
            
            const menuItems: MenuItemConstructorOptions[] = []
            
            // === Text Selection Menu ===
            if (params.selectionText && params.selectionText.trim().length > 0) {
                menuItems.push({
                    label: "Kopieren",
                    accelerator: "CmdOrCtrl+C",
                    click: () => clipboard.writeText(params.selectionText)
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
                    click: () => shell.openExternal(params.linkURL)
                })
                menuItems.push({
                    label: "Link-Adresse kopieren",
                    click: () => clipboard.writeText(params.linkURL)
                })
                menuItems.push({ type: "separator" })
            }
            
            // === Image Menu ===
            if (params.hasImageContents && params.srcURL) {
                menuItems.push({
                    label: "Bild im Browser öffnen",
                    click: () => shell.openExternal(params.srcURL)
                })
                menuItems.push({
                    label: "Bild speichern unter...",
                    click: () => this.saveImageAs(params.srcURL)
                })
                menuItems.push({
                    label: "Bild kopieren",
                    click: () => this.copyImageToClipboard(params.srcURL)
                })
                menuItems.push({
                    label: "Bild-URL kopieren",
                    click: () => clipboard.writeText(params.srcURL)
                })
                menuItems.push({ type: "separator" })
            }
            
            // === Navigation Actions ===
            menuItems.push({
                label: "Zurück",
                accelerator: "Alt+Left",
                enabled: wc.navigationHistory.canGoBack() ?? false,
                click: () => wc.goBack()
            })
            menuItems.push({
                label: "Vorwärts",
                accelerator: "Alt+Right",
                enabled: wc.navigationHistory.canGoForward() ?? false,
                click: () => wc.goForward()
            })
            menuItems.push({
                label: "Neu laden",
                accelerator: "CmdOrCtrl+R",
                click: () => wc.reload()
            })
            
            if (menuItems.length > 0) {
                // Remove trailing separator
                if (menuItems[menuItems.length - 1].type === "separator") {
                    menuItems.pop()
                }
                
                const menu = Menu.buildFromTemplate(menuItems)
                menu.popup({
                    window: this.parentWindow ?? undefined,
                    x: this.visibleBounds.x + params.x,
                    y: this.visibleBounds.y + params.y
                })
            }
        })
    }
    
    /**
     * Save image to file
     */
    private async saveImageAs(imageUrl: string): Promise<void> {
        if (!this.parentWindow) return
        
        const { dialog } = await import("electron")
        
        const urlObj = new URL(imageUrl)
        let filename = path.basename(urlObj.pathname) || "image"
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
            const protocol = imageUrl.startsWith("https") ? https : http
            const response = await new Promise<Buffer>((resolve, reject) => {
                protocol.get(imageUrl, (res) => {
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
        } catch (err) {
            console.error("[ContentViewPool] Failed to save image:", err)
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
        } catch (err) {
            console.error("[ContentViewPool] Failed to copy image:", err)
        }
    }

    // ========== View Access ==========
    
    /**
     * Get the currently active view
     */
    getActiveView(): CachedContentView | null {
        if (!this.activeViewId) return null
        return this.views.find(v => v.id === this.activeViewId) ?? null
    }
    
    /**
     * Get a view by its ID
     */
    getViewById(id: string): CachedContentView | null {
        return this.views.find(v => v.id === id) ?? null
    }
    
    /**
     * Get a view by article ID (if cached)
     */
    getViewByArticleId(articleId: string): CachedContentView | null {
        return this.views.find(v => v.articleId === articleId) ?? null
    }
    
    /**
     * Get a view by webContents ID
     */
    getViewByWebContentsId(wcId: number): CachedContentView | null {
        return this.viewsByWebContentsId.get(wcId) ?? null
    }
    
    // ========== Navigation ==========
    
    /**
     * Navigate to an article
     * Returns immediately if article is already cached (instant swap)
     */
    async navigateToArticle(
        articleId: string,
        url: string,
        feedId: string | null,
        settings: NavigationSettings,
        articleIndex: number,
        listLength: number
    ): Promise<boolean> {
        // Cancel any pending prefetch
        this.cancelPrefetch()
        
        // Update reading direction BEFORE updating currentArticleIndex
        // (needs old index to compare)
        this.updateReadingDirection(articleIndex, listLength)
        
        // Update article context
        this.currentArticleIndex = articleIndex
        this.articleListLength = listLength
        
        console.log(`[ContentViewPool] Navigate to: ${articleId} (index ${articleIndex}/${listLength}, direction: ${this.readingDirection})`)
        
        // Check if article is already cached
        const cachedView = this.getViewByArticleId(articleId)
        if (cachedView && cachedView.isReady) {
            // Instant swap!
            console.log(`[ContentViewPool] Cache HIT - instant swap to ${cachedView.id}`)
            
            // Play sound on cache hit (for debugging)
            shell.beep()
            
            this.activateView(cachedView)
            
            // Schedule prefetch for next articles
            this.schedulePrefetch()
            
            return true
        }
        
        // Need to load - find or create a view
        const view = cachedView ?? this.getOrCreateView(articleId)
        
        // Deactivate current view - hide it (with current bounds so size is preserved)
        const currentActive = this.getActiveView()
        if (currentActive && currentActive !== view) {
            console.log(`[ContentViewPool] Deactivating and hiding ${currentActive.id}`)
            currentActive.setActive(false)
            currentActive.setVisible(false, this.visibleBounds)  // Pass bounds to preserve size
        }
        
        // Set as active (but not visible yet - will show after load)
        this.activeViewId = view.id
        view.setActive(true)
        
        // Apply bounds immediately
        view.setBounds(this.visibleBounds)
        
        // Load the article
        try {
            await view.load(url, articleId, feedId, settings, isMobileUserAgentEnabled())
            
            // IMPORTANT: Check if this view is still the active one!
            // User may have navigated to another article while we were loading
            if (this.activeViewId !== view.id) {
                console.log(`[ContentViewPool] Load complete for ${view.id}, but ${this.activeViewId} is now active - not showing`)
                return true  // Load was successful, just not shown
            }
            
            // Show view when ready (only if still active AND bounds are available)
            if (this.isPoolVisible && this.boundsReceived) {
                view.setVisible(true, this.visibleBounds)
                view.focus()  // Single focus call after visibility is set
                console.log(`[ContentViewPool] Load complete, showing ${view.id}`)
            } else if (this.isPoolVisible) {
                console.log(`[ContentViewPool] Load complete for ${view.id}, waiting for bounds`)
            }
            
            // Notify renderer
            this.sendToRenderer('cvp-navigation-complete', articleId)
            
            // Schedule prefetch
            this.schedulePrefetch()
            
            return true
        } catch (err) {
            console.error(`[ContentViewPool] Navigation failed:`, err)
            this.sendToRenderer('cvp-error', articleId, String(err))
            
            return false
        }
    }
    
    /**
     * Prefetch an article in the background
     */
    prefetch(articleId: string, url: string, feedId: string | null, settings: NavigationSettings): void {
        if (!this.config.enabled) return
        
        // Check if article is already in a view
        const existingView = this.getViewByArticleId(articleId)
        let viewToUse: CachedContentView | null = null
        
        if (existingView) {
            // Check the status of the existing view
            switch (existingView.status) {
                case 'ready':
                    // Already loaded - skip
                    console.log(`[ContentViewPool] Prefetch skip - already ready: ${articleId}`)
                    return
                case 'loading':
                    // Currently loading - skip, will be ready soon
                    console.log(`[ContentViewPool] Prefetch skip - already loading: ${articleId}`)
                    return
                case 'error':
                    // Previous load failed - recycle and try again
                    console.log(`[ContentViewPool] Prefetch retry - previous load failed: ${articleId}`)
                    existingView.recycle()
                    viewToUse = existingView  // Use this view for retry
                    break
                case 'empty':
                    // View was recycled but still has articleId? Shouldn't happen, but use it
                    console.log(`[ContentViewPool] Prefetch: view ${existingView.id} is empty with articleId ${articleId}`)
                    viewToUse = existingView
                    break
            }
        }
        
        // Find a free view if we don't have one from error retry
        let freeView = viewToUse || this.findFreeView()
        
        // If no free view, try to recycle a non-active view
        if (!freeView) {
            freeView = this.findRecyclableView()
            if (freeView) {
                console.log(`[ContentViewPool] Prefetch: recycling ${freeView.id} (was ${freeView.articleId}) for ${articleId}`)
                freeView.recycle()
            }
        }
        
        if (!freeView) {
            console.log(`[ContentViewPool] Prefetch skip - no free view for: ${articleId}`)
            return
        }
        
        console.log(`[ContentViewPool] Prefetch: ${articleId} in ${freeView.id}`)
        
        // Recycle the view if it has old content
        if (!freeView.isEmpty) {
            freeView.recycle()
        }
        
        // Ensure view is created with events
        if (!freeView.view && this.parentWindow) {
            this.createViewWithEvents(freeView)
        }
        
        // Load in background
        freeView.load(url, articleId, feedId, settings, isMobileUserAgentEnabled())
            .catch(err => {
                console.error(`[ContentViewPool] Prefetch failed for ${articleId}:`, err)
            })
    }
    
    /**
     * Prefetch FullContent article - fetch webpage and extract content
     * This runs entirely in the main process
     */
    async prefetchFullContent(
        articleId: string,
        feedId: string | null,
        settings: NavigationSettings,
        articleInfo: PrefetchArticleInfo
    ): Promise<void> {
        if (!this.config.enabled) return
        
        // Check if article is already in a view
        const existingView = this.getViewByArticleId(articleId)
        if (existingView && (existingView.status === 'ready' || existingView.status === 'loading')) {
            console.log(`[ContentViewPool] FullContent prefetch skip - already ${existingView.status}: ${articleId}`)
            return
        }
        
        // Find a free view
        let freeView = this.findFreeView()
        if (!freeView) {
            freeView = this.findRecyclableView()
            if (freeView) {
                console.log(`[ContentViewPool] FullContent prefetch: recycling ${freeView.id}`)
                freeView.recycle()
            }
        }
        
        if (!freeView) {
            console.log(`[ContentViewPool] FullContent prefetch skip - no free view for: ${articleId}`)
            return
        }
        
        console.log(`[ContentViewPool] FullContent prefetch starting: ${articleId} in ${freeView.id}`)
        
        // Recycle if needed
        if (!freeView.isEmpty) {
            freeView.recycle()
        }
        
        // Ensure view is created
        if (!freeView.view && this.parentWindow) {
            this.createViewWithEvents(freeView)
        }
        
        try {
            // Step 1: Fetch the webpage
            console.log(`[ContentViewPool] FullContent: fetching ${articleInfo.itemLink}`)
            const html = await this.fetchWebpage(articleInfo.itemLink)
            
            // Step 2: Extract article content
            console.log(`[ContentViewPool] FullContent: extracting content`)
            const extracted = await extractFromHtml(html, articleInfo.itemLink)
            
            // Step 3: Use extracted content or fallback to RSS content
            let contentToUse = extracted?.content || articleInfo.itemContent || ''
            
            // Step 4: Generate HTML data URL
            const dataUrl = generateFullContentHtml({
                title: articleInfo.itemTitle,
                date: new Date(articleInfo.itemDate),
                content: contentToUse,
                baseUrl: articleInfo.itemLink,
                textDir: textDirToString(articleInfo.textDir),
                fontSize: articleInfo.fontSize,
                fontFamily: articleInfo.fontFamily,
                locale: articleInfo.locale,
                extractorTitle: extracted?.title,
                extractorDate: extracted?.published ? new Date(extracted.published) : undefined
            })
            
            console.log(`[ContentViewPool] FullContent: loading extracted content for ${articleId}`)
            
            // Step 5: Load the generated HTML
            await freeView.load(dataUrl, articleId, feedId, settings, false)
            
            console.log(`[ContentViewPool] FullContent prefetch complete: ${articleId}`)
        } catch (err) {
            console.error(`[ContentViewPool] FullContent prefetch failed for ${articleId}:`, err)
            // On error, the view stays empty/error state
        }
    }
    
    /**
     * Fetch webpage content using Electron's net module
     */
    private async fetchWebpage(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const request = net.request(url)
            let data = ''
            
            request.on('response', (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}`))
                    return
                }
                
                response.on('data', (chunk) => {
                    data += chunk.toString()
                })
                
                response.on('end', () => {
                    resolve(data)
                })
                
                response.on('error', (err) => {
                    reject(err)
                })
            })
            
            request.on('error', (err) => {
                reject(err)
            })
            
            request.end()
        })
    }
    
    // ========== Reading Direction ==========
    
    /**
     * Update reading direction based on navigation
     */
    setReadingDirection(direction: ReadingDirection): void {
        if (this.readingDirection !== direction) {
            console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → ${direction}`)
            this.readingDirection = direction
        }
    }
    
    /**
     * Get current reading direction
     */
    getReadingDirection(): ReadingDirection {
        return this.readingDirection
    }
    
    /**
     * Update reading direction based on navigation
     * Compares new index with previous to determine direction
     */
    private updateReadingDirection(newIndex: number, listLength: number): void {
        const oldIndex = this.currentArticleIndex
        
        // First navigation or index not set yet
        if (oldIndex < 0) {
            // At boundaries, we know the direction
            if (newIndex === 0 && listLength > 1) {
                this.readingDirection = 'forward'
            } else if (newIndex === listLength - 1 && listLength > 1) {
                this.readingDirection = 'backward'
            }
            // Otherwise keep unknown
            return
        }
        
        // Determine direction from index change
        if (newIndex > oldIndex) {
            if (this.readingDirection !== 'forward') {
                console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → forward (index ${oldIndex} → ${newIndex})`)
                this.readingDirection = 'forward'
            }
        } else if (newIndex < oldIndex) {
            if (this.readingDirection !== 'backward') {
                console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → backward (index ${oldIndex} → ${newIndex})`)
                this.readingDirection = 'backward'
            }
        }
        // Same index = keep current direction (reload)
    }
    
    // ========== Prefetch Scheduling ==========
    
    /**
     * Schedule prefetch after active view is ready
     */
    private schedulePrefetch(): void {
        console.log(`[ContentViewPool] schedulePrefetch() called, enabled=${this.config.enabled}`)
        if (!this.config.enabled) {
            console.log(`[ContentViewPool] Prefetch disabled, skipping`)
            return
        }
        
        // Cancel any existing timer
        this.cancelPrefetch()
        
        // Wait for active view to be ready
        const activeView = this.getActiveView()
        if (!activeView) {
            console.log(`[ContentViewPool] No active view, skipping prefetch`)
            return
        }
        
        console.log(`[ContentViewPool] Active view ${activeView.id} isReady=${activeView.isReady}`)
        
        const doPrefetch = () => {
            console.log(`[ContentViewPool] Starting prefetch timer (${this.config.prefetchDelay}ms)`)
            this.prefetchTimer = setTimeout(() => {
                console.log(`[ContentViewPool] Prefetch timer fired, executing...`)
                this.prefetchTimer = null
                this.executePrefetch()
            }, this.config.prefetchDelay)
        }
        
        if (activeView.isReady) {
            // Already ready - schedule with delay
            console.log(`[ContentViewPool] View already ready, scheduling prefetch`)
            doPrefetch()
        } else {
            // Wait for ready event
            console.log(`[ContentViewPool] View not ready, waiting for dom-ready`)
            activeView.setOnDomReady(() => {
                console.log(`[ContentViewPool] dom-ready received, scheduling prefetch`)
                activeView.setOnDomReady(null)  // One-shot
                doPrefetch()
            })
        }
    }
    
    /**
     * Cancel pending prefetch
     */
    private cancelPrefetch(): void {
        if (this.prefetchTimer) {
            clearTimeout(this.prefetchTimer)
            this.prefetchTimer = null
        }
        this.pendingPrefetch = []
    }
    
    /**
     * Execute prefetch based on reading direction
     */
    /**
     * Execute prefetch for adjacent articles
     * 
     * IMPORTANT: Before requesting prefetch info from renderer, we protect
     * the current article and its neighbors from being recycled. This prevents
     * a race condition where the primary prefetch recycles a view that holds
     * an article needed by the secondary prefetch.
     */
    private executePrefetch(): void {
        console.log(`[ContentViewPool] executePrefetch() - index=${this.currentArticleIndex}, listLength=${this.articleListLength}, direction=${this.readingDirection}`)
        if (this.currentArticleIndex < 0) {
            console.log(`[ContentViewPool] No current article index, skipping prefetch`)
            return
        }
        
        // Determine what to prefetch based on direction
        const targets = this.determinePrefetchTargets()
        
        console.log(`[ContentViewPool] Prefetch targets:`, targets)
        
        // Clear old protected articles and protect current neighbors
        // This prevents recycling views that hold articles we might navigate to
        this.protectedArticleIds.clear()
        
        // Protect the active article
        const activeView = this.getActiveView()
        if (activeView?.articleId) {
            this.protectedArticleIds.add(activeView.articleId)
        }
        
        // Protect articles at target indices (we don't know their IDs yet,
        // but we can protect any view holding articles at adjacent indices)
        // For simplicity, protect all non-active ready views for the duration of prefetch
        // The protection will be updated on next navigation
        for (const view of this.views) {
            if (!view.isActive && view.articleId && view.status === 'ready') {
                this.protectedArticleIds.add(view.articleId)
            }
        }
        
        console.log(`[ContentViewPool] Protected articles:`, Array.from(this.protectedArticleIds))
        
        // Request prefetch info from renderer
        // The renderer knows the article URLs
        if (targets.primary !== null) {
            console.log(`[ContentViewPool] Requesting prefetch info for primary target index ${targets.primary}`)
            this.sendToRenderer('cvp-request-prefetch-info', targets.primary)
        }
        if (targets.secondary !== null) {
            console.log(`[ContentViewPool] Requesting prefetch info for secondary target index ${targets.secondary}`)
            this.sendToRenderer('cvp-request-prefetch-info', targets.secondary)
        }
    }
    
    /**
     * Determine which articles to prefetch based on reading direction
     */
    private determinePrefetchTargets(): { primary: number | null, secondary: number | null } {
        const { currentArticleIndex: index, articleListLength: length } = this
        
        switch (this.readingDirection) {
            case 'forward':
                return {
                    primary: index + 1 < length ? index + 1 : null,
                    secondary: index - 1 >= 0 ? index - 1 : null
                }
            
            case 'backward':
                return {
                    primary: index - 1 >= 0 ? index - 1 : null,
                    secondary: index + 1 < length ? index + 1 : null
                }
            
            case 'unknown':
                // Both directions equally likely
                return {
                    primary: index + 1 < length ? index + 1 : null,
                    secondary: index - 1 >= 0 ? index - 1 : null
                }
        }
    }
    
    // ========== Pool Management ==========
    
    /**
     * Get or create a view for an article
     */
    private getOrCreateView(articleId: string): CachedContentView {
        // First check if we have a view for this article
        const existing = this.getViewByArticleId(articleId)
        if (existing) return existing
        
        // Check if we have an empty view
        const empty = this.views.find(v => v.isEmpty)
        if (empty) {
            if (!empty.view && this.parentWindow) {
                this.createViewWithEvents(empty)
            }
            return empty
        }
        
        // Check if we can create a new view
        if (this.views.length < this.config.size) {
            const newView = new CachedContentView(`view-${this.views.length}`)
            if (this.parentWindow) {
                this.createViewWithEvents(newView)
            }
            this.views.push(newView)
            return newView
        }
        
        // Need to recycle an existing view
        const toRecycle = this.findRecyclableView()
        if (toRecycle) {
            toRecycle.recycle()
            if (this.parentWindow) {
                this.createViewWithEvents(toRecycle)
            }
            return toRecycle
        }
        
        // Shouldn't happen, but fallback to first non-active view
        const fallback = this.views.find(v => !v.isActive)!
        fallback.recycle()
        if (this.parentWindow) {
            this.createViewWithEvents(fallback)
        }
        return fallback
    }
    
    /**
     * Find a free view for prefetching (not active)
     */
    private findFreeView(): CachedContentView | null {
        // Prefer empty views
        const empty = this.views.find(v => v.isEmpty && !v.isActive)
        if (empty) return empty
        
        // Then views that aren't loading
        const ready = this.views.find(v => !v.isActive && !v.isLoading)
        if (ready) return ready
        
        // Can we create a new one?
        if (this.views.length < this.config.size) {
            const newView = new CachedContentView(`view-${this.views.length}`)
            this.views.push(newView)
            return newView
        }
        
        return null
    }
    
    /**
     * Find the best view to recycle based on reading direction
     * Prefers views that hold articles in the opposite direction of reading
     * NEVER recycles views holding protected articles (current prefetch targets)
     */
    private findRecyclableView(): CachedContentView | null {
        // Don't recycle active view or views with protected articles
        const candidates = this.views.filter(v => {
            if (v.isActive) return false
            // Don't recycle if article is protected (needed as prefetch target)
            if (v.articleId && this.protectedArticleIds.has(v.articleId)) {
                console.log(`[ContentViewPool] Skipping ${v.id} (protected article ${v.articleId})`)
                return false
            }
            return true
        })
        
        if (candidates.length === 0) return null
        
        // If we don't know the current position, just return any non-active
        if (this.currentArticleIndex < 0) {
            return candidates[0]
        }
        
        // Calculate "distance" for each candidate based on reading direction
        // Negative distance = opposite to reading direction (prefer recycling)
        // Positive distance = same as reading direction (keep for cache)
        const scored = candidates.map(view => {
            // Empty views are best to recycle
            if (view.isEmpty || !view.articleId) {
                return { view, score: -1000 }
            }
            
            // Views with errors should be recycled
            if (view.status === 'error') {
                return { view, score: -900 }
            }
            
            // Loading views - prefer to recycle these over ready views
            // (a loading view's article might not be visited anyway)
            if (view.isLoading) {
                return { view, score: -500 }
            }
            
            // Ready views - keep these if possible
            return { view, score: 0 }
        })
        
        // Sort by score (lowest/most negative first = best to recycle)
        scored.sort((a, b) => a.score - b.score)
        
        return scored[0].view
    }
    
    /**
     * Activate a view (make it the visible one)
     */
    private activateView(view: CachedContentView): void {
        // Deactivate current - hide it (with current bounds so size is preserved)
        const current = this.getActiveView()
        if (current && current !== view) {
            current.setActive(false)
            current.setVisible(false, this.visibleBounds)  // Pass bounds to preserve size
        }
        
        // Activate new
        this.activeViewId = view.id
        view.setActive(true)
        
        // Apply bounds and show if pool is visible AND we have real bounds
        if (this.isPoolVisible && this.boundsReceived) {
            view.setVisible(true, this.visibleBounds)
            view.focus()  // Single focus call after visibility is set
            console.log(`[ContentViewPool] Activated ${view.id} - visible with bounds:`, this.visibleBounds)
        } else if (this.isPoolVisible) {
            // Pool is visible but no bounds yet - view will be shown when bounds arrive
            console.log(`[ContentViewPool] Activated ${view.id} - waiting for bounds before showing`)
        }
        
        // Notify renderer
        this.sendToRenderer('cvp-navigation-complete', view.articleId)
    }
    
    /**
     * Update the webContentsId → view mapping
     */
    private updateWebContentsMapping(): void {
        this.viewsByWebContentsId.clear()
        for (const view of this.views) {
            const wcId = view.webContentsId
            if (wcId !== null) {
                this.viewsByWebContentsId.set(wcId, view)
            }
        }
    }
    
    // ========== Bounds & Visibility ==========
    
    /**
     * Set the visible bounds for ALL views in the pool
     * 
     * All views share the same bounds - only visibility differs.
     * This is called by ResizeObserver and window resize listeners.
     */
    setBounds(bounds: ContentViewBounds): void {
        // Basic validation - width/height must be positive
        if (bounds.width <= 0 || bounds.height <= 0) {
            return
        }
        
        // Check if these are "real" bounds (not default 0,0)
        // Real bounds from the renderer will have x > 0 (because of the navigation panel)
        // or at minimum be different from our default 800x600
        const isRealBounds = bounds.x > 0 || bounds.y > 0 || 
                             bounds.width !== 800 || bounds.height !== 600
        
        const firstRealBounds = !this.boundsReceived && isRealBounds
        
        // Store bounds (always store for later restoration)
        this.visibleBounds = bounds
        
        // Only mark as received if real bounds
        if (isRealBounds) {
            this.boundsReceived = true
        }
        
        // If video is in fullscreen mode, don't apply normal bounds - keep view at full window size
        if (this.videoFullscreenActive) {
            console.log(`[ContentViewPool] setBounds skipped (video fullscreen active):`, bounds)
            // Instead, ensure active view stays at full window bounds
            const activeView = this.getActiveView()
            if (activeView && this.parentWindow && !this.parentWindow.isDestroyed()) {
                const [width, height] = this.parentWindow.getContentSize()
                activeView.setBounds({ x: 0, y: 0, width, height })
            }
            return
        }
        
        console.log(`[ContentViewPool] setBounds:`, bounds, `real=${isRealBounds}, boundsReceived=${this.boundsReceived}`)
        
        // Apply bounds to ALL views
        for (const view of this.views) {
            view.setBounds(bounds)
        }
        
        // If we have an active view that's waiting for real bounds, show it now
        const active = this.getActiveView()
        if (active && this.isPoolVisible && isRealBounds) {
            if (firstRealBounds) {
                console.log(`[ContentViewPool] First real bounds received! Showing active view ${active.id} at:`, bounds)
            }
            active.setVisible(true, bounds)
            active.focus()
        }
    }
    
    /**
     * Show/hide the pool (controls visibility of active view)
     */
    setVisible(visible: boolean): void {
        const wasVisible = this.isPoolVisible
        this.isPoolVisible = visible
        
        const active = this.getActiveView()
        if (active) {
            if (visible) {
                // Only show if we have real bounds, otherwise wait for setBounds
                if (this.boundsReceived) {
                    active.setVisible(true, this.visibleBounds)
                    active.focus()
                    console.log(`[ContentViewPool] Showing ${active.id} at bounds:`, this.visibleBounds)
                } else {
                    console.log(`[ContentViewPool] setVisible(true) - waiting for bounds before showing ${active.id}`)
                }
            } else {
                active.setVisible(false, this.visibleBounds)  // Pass bounds to preserve size
            }
        } else if (visible && !wasVisible) {
            console.log(`[ContentViewPool] setVisible(true) - no active view yet`)
        }
    }
    
    // ========== IPC ==========
    
    /**
     * Setup IPC handlers for pool operations
     */
    private setupIpcHandlers(): void {
        console.log('[ContentViewPool] Setting up IPC handlers...')
        
        // =====================================================
        // Legacy channel handlers (for code paths that haven't migrated yet)
        // These forward to the Pool implementation
        // =====================================================
        
        // Legacy: content-view-navigate-with-settings
        ipcMain.handle("content-view-navigate-with-settings", async (event, url: string, settings: NavigationSettings) => {
            console.log('[ContentViewPool] Legacy channel content-view-navigate-with-settings forwarded to Pool')
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (!wc || wc.isDestroyed()) {
                console.error("[ContentViewPool] Cannot navigate - no active view")
                return false
            }
            
            try {
                // Apply settings
                this.visualZoomEnabled = settings.visualZoom
                this.mobileMode = settings.mobileMode
                const clampedZoom = Math.max(0.25, Math.min(5.0, settings.zoomFactor))
                this.cssZoomLevel = (clampedZoom - 1.0) / 0.1
                
                // Apply mobile user agent if enabled
                const mobileUA = "Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36"
                if (isMobileUserAgentEnabled()) {
                    wc.setUserAgent(mobileUA)
                } else {
                    wc.setUserAgent("")
                }
                
                // Navigate
                await wc.loadURL(url)
                return true
            } catch (e) {
                console.error("[ContentViewPool] navigateWithSettings error:", e)
                return false
            }
        })
        
        // Legacy: content-view-close-devtools
        ipcMain.handle("content-view-close-devtools", () => {
            console.log('[ContentViewPool] Legacy channel content-view-close-devtools forwarded to Pool')
            const active = this.getActiveView()
            active?.getWebContents()?.closeDevTools()
        })
        
        // Legacy: get-css-zoom-level (sync - used by content-preload.js)
        ipcMain.on("get-css-zoom-level", (event) => {
            event.returnValue = this.cssZoomLevel
        })
        
        // Legacy: get-mobile-mode (sync - used by content-preload.js)
        ipcMain.on("get-mobile-mode", (event) => {
            event.returnValue = this.mobileMode
        })
        
        // =====================================================
        // Pool-specific handlers (cvp-* prefix)
        // =====================================================
        
        // Debug: Log messages from preload scripts
        ipcMain.on('cvp-preload-log', (event, message) => {
            console.log(message)
        })
        
        // Navigate to article
        ipcMain.handle('cvp-navigate', async (event, articleId, url, feedId, settings, index, listLength) => {
            console.log(`[ContentViewPool] IPC cvp-navigate received: articleId=${articleId}, index=${index}`)
            return this.navigateToArticle(articleId, url, feedId, settings, index, listLength)
        })
        
        // Prefetch article
        ipcMain.on('cvp-prefetch', (event, articleId, url, feedId, settings) => {
            console.log(`[ContentViewPool] IPC cvp-prefetch received: articleId=${articleId}`)
            this.prefetch(articleId, url, feedId, settings)
        })
        
        // Prefetch info response from renderer (extended with articleInfo for FullContent)
        ipcMain.on('cvp-prefetch-info', (event, articleIndex, articleId, url, feedId, settings, articleInfo) => {
            console.log(`[ContentViewPool] IPC cvp-prefetch-info received: index=${articleIndex}, articleId=${articleId}, url=${url?.substring(0, 50) || 'null'}...`)
            
            if (articleId && articleInfo?.openTarget === PrefetchOpenTarget.FullContent) {
                // FullContent mode: fetch and extract in background
                console.log(`[ContentViewPool] Starting FullContent prefetch for ${articleId}`)
                this.prefetchFullContent(articleId, feedId, settings, articleInfo)
            } else if (articleId && url) {
                // Webpage or RSS mode: use URL directly
                this.prefetch(articleId, url, feedId, settings)
            } else {
                console.log(`[ContentViewPool] Prefetch info incomplete, skipping`)
            }
        })
        
        // Set bounds
        ipcMain.on('cvp-set-bounds', (event, bounds) => {
            this.setBounds(bounds)
        })
        
        // Set visibility
        ipcMain.on('cvp-set-visibility', (event, visible) => {
            this.setVisible(visible)
        })
        
        // Set reading direction
        ipcMain.on('cvp-set-reading-direction', (event, direction) => {
            this.setReadingDirection(direction)
        })
        
        // Get pool status (for debugging)
        ipcMain.handle('cvp-get-status', async () => {
            return this.getPoolStatus()
        })
        
        // === Zoom Handlers (apply to active view) ===
        
        // Set zoom factor (synchronous for +/- shortcuts)
        ipcMain.on("cvp-set-zoom-factor", (event, factor: number) => {
            this.setZoomFactor(factor)
            event.returnValue = true
        })
        
        // Set CSS zoom level
        ipcMain.on("cvp-set-css-zoom", (event, level: number) => {
            this.setCssZoom(level)
        })
        
        // Get CSS zoom level (sync)
        ipcMain.on("cvp-get-css-zoom-level", (event) => {
            event.returnValue = this.cssZoomLevel
        })
        
        // Get CSS zoom level (async)
        ipcMain.handle("cvp-get-css-zoom-level-async", () => {
            return this.cssZoomLevel
        })
        
        // Set visual zoom mode
        ipcMain.on("cvp-set-visual-zoom", (event, enabled: boolean) => {
            this.setVisualZoomMode(enabled)
        })
        
        // === Navigation Handlers (apply to active view) ===
        
        // Execute JavaScript
        ipcMain.handle("cvp-execute-js", async (event, code: string) => {
            const active = this.getActiveView()
            if (active) {
                return active.executeJavaScript(code)
            }
            return null
        })
        
        // Send message to active view
        ipcMain.on("cvp-send", (event, channel: string, ...args: any[]) => {
            const active = this.getActiveView()
            if (active) {
                active.send(channel, ...args)
            }
        })
        
        // Get active webContents ID
        ipcMain.handle("cvp-get-id", () => {
            const active = this.getActiveView()
            return active?.webContentsId ?? null
        })
        
        // DevTools
        ipcMain.handle("cvp-open-devtools", () => {
            const active = this.getActiveView()
            active?.getWebContents()?.openDevTools()
        })
        
        ipcMain.handle("cvp-is-devtools-opened", () => {
            const active = this.getActiveView()
            return active?.getWebContents()?.isDevToolsOpened() ?? false
        })
        
        ipcMain.handle("cvp-close-devtools", () => {
            const active = this.getActiveView()
            active?.getWebContents()?.closeDevTools()
        })
        
        // Reload
        ipcMain.handle("cvp-reload", () => {
            const active = this.getActiveView()
            active?.getWebContents()?.reload()
        })
        
        // Get URL
        ipcMain.handle("cvp-get-url", () => {
            const active = this.getActiveView()
            return active?.getWebContents()?.getURL() ?? ""
        })
        
        // Clear (load about:blank)
        ipcMain.on("cvp-clear", () => {
            const active = this.getActiveView()
            if (active) {
                active.getWebContents()?.loadURL("about:blank")
            }
        })
        
        // === Additional handlers for feature parity with ContentViewManager ===
        
        // Go back in history
        ipcMain.handle("cvp-go-back", () => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc?.canGoBack()) {
                wc.goBack()
                return true
            }
            return false
        })
        
        // Go forward in history
        ipcMain.handle("cvp-go-forward", () => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc?.canGoForward()) {
                wc.goForward()
                return true
            }
            return false
        })
        
        // Can go back?
        ipcMain.handle("cvp-can-go-back", () => {
            const active = this.getActiveView()
            return active?.getWebContents()?.canGoBack() ?? false
        })
        
        // Can go forward?
        ipcMain.handle("cvp-can-go-forward", () => {
            const active = this.getActiveView()
            return active?.getWebContents()?.canGoForward() ?? false
        })
        
        // Get zoom factor
        ipcMain.handle("cvp-get-zoom-factor", () => {
            return 1.0 + (this.cssZoomLevel * 0.1)
        })
        
        // Get emulated viewport info
        ipcMain.on("cvp-get-emulated-viewport-info", (event) => {
            const factor = 1.0 + (this.cssZoomLevel * 0.1)
            event.returnValue = {
                zoomPercent: Math.round(factor * 100),
                viewportWidth: Math.round(1440 / factor),
                viewportHeight: Math.round(900 / factor),
                mobileMode: this.mobileMode
            }
        })
        
        // Legacy channel for settings.ts compatibility
        ipcMain.on("get-emulated-viewport-info", (event) => {
            const factor = 1.0 + (this.cssZoomLevel * 0.1)
            event.returnValue = {
                zoomPercent: Math.round(factor * 100),
                viewportWidth: Math.round(1440 / factor),
                viewportHeight: Math.round(900 / factor),
                scale: factor,
                mobileMode: this.mobileMode
            }
        })
        
        // Focus active view
        ipcMain.on("cvp-focus", () => {
            const active = this.getActiveView()
            active?.focus()
        })
        
        // Set mobile mode
        ipcMain.on("cvp-set-mobile-mode", (event, enabled: boolean) => {
            this.setMobileMode(enabled)
        })
        
        // Get mobile mode
        ipcMain.on("cvp-get-mobile-mode", (event) => {
            event.returnValue = this.mobileMode
        })
        
        // Navigate with settings (direct URL navigation without prefetch/cache)
        // Used for HTML content (RSS articles) where caching doesn't apply
        ipcMain.handle("cvp-navigate-with-settings", async (event, url: string, settings: NavigationSettings) => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (!wc || wc.isDestroyed()) {
                console.error("[ContentViewPool] Cannot navigate - no active view")
                return false
            }
            
            try {
                // Apply settings
                this.visualZoomEnabled = settings.visualZoom
                this.mobileMode = settings.mobileMode
                // Convert zoomFactor to cssZoomLevel (0 = 100%, 1 = 110%, -1 = 90%, etc.)
                const clampedZoom = Math.max(0.25, Math.min(5.0, settings.zoomFactor))
                this.cssZoomLevel = (clampedZoom - 1.0) / 0.1
                
                // Apply mobile user agent if enabled
                const mobileUA = "Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36"
                if (isMobileUserAgentEnabled()) {
                    wc.setUserAgent(mobileUA)
                } else {
                    wc.setUserAgent("")
                }
                
                // Navigate
                await wc.loadURL(url)
                return true
            } catch (e) {
                console.error("[ContentViewPool] navigateWithSettings error:", e)
                return false
            }
        })
        
        // Load HTML directly
        ipcMain.handle("cvp-load-html", async (event, html: string, baseURL?: string) => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc && !wc.isDestroyed()) {
                await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
                return true
            }
            return false
        })
        
        // Navigate via JS (for SPA-style navigation)
        ipcMain.handle("cvp-navigate-via-js", async (event, url: string) => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc && !wc.isDestroyed()) {
                await wc.executeJavaScript(`window.location.href = ${JSON.stringify(url)}`)
                return true
            }
            return false
        })
        
        // Set user agent
        ipcMain.on("cvp-set-user-agent", (event, userAgent: string) => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc && !wc.isDestroyed()) {
                wc.setUserAgent(userAgent)
            }
        })
        
        // Stop loading
        ipcMain.handle("cvp-stop", () => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc && !wc.isDestroyed()) {
                wc.stop()
                return true
            }
            return false
        })
        
        // JS dialog forwarding (from content-preload)
        ipcMain.on("cvp-js-dialog", (event, data: { type: string, message: string, defaultValue?: string }) => {
            // Forward to main window for logging
            if (this.parentWindow && !this.parentWindow.isDestroyed()) {
                this.parentWindow.webContents.send("content-view-js-dialog", data)
            }
        })
        
        // Capture screen
        ipcMain.handle("cvp-capture-screen", async () => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (wc && !wc.isDestroyed()) {
                const image = await wc.capturePage()
                return image.toDataURL()
            }
            return null
        })
        
        // Recreate active view (for visual zoom toggle)
        ipcMain.handle("cvp-recreate", async () => {
            const active = this.getActiveView()
            if (active) {
                const articleId = active.articleId
                const url = active.getWebContents()?.getURL()
                if (articleId && url) {
                    // Recycle and reload
                    active.recycle()
                    this.createViewWithEvents(active)
                    await active.load(url, articleId, active.feedId, {
                        zoomFactor: 1.0 + (this.cssZoomLevel * 0.1),
                        visualZoom: this.visualZoomEnabled,
                        mobileMode: this.mobileMode,
                        showZoomOverlay: false
                    }, isMobileUserAgentEnabled())
                    return true
                }
            }
            return false
        })
        
        // Nuke active view (for mode switch: RSS <-> Browser)
        // Recycles the view without reloading - caller should navigate after nuke
        ipcMain.handle("cvp-nuke", async () => {
            console.log("[ContentViewPool] cvp-nuke: Nuking active view for mode switch")
            const active = this.getActiveView()
            if (active) {
                // Recycle (destroys and recreates the WebContentsView)
                active.recycle()
                this.createViewWithEvents(active)
                
                // Mark as active again and restore visibility with current bounds
                active.setActive(true)
                if (this.isPoolVisible && this.boundsReceived) {
                    active.setVisible(true, this.visibleBounds)
                }
                
                console.log("[ContentViewPool] cvp-nuke: View recycled, ready for new navigation")
                return true
            }
            console.log("[ContentViewPool] cvp-nuke: No active view to nuke")
            return false
        })
        
        // Get cookies from active view's session (for cookie persistence)
        ipcMain.handle("cvp-get-cookies-for-host", async (event, host: string) => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (!wc || wc.isDestroyed()) {
                console.log("[ContentViewPool] cvp-get-cookies-for-host: No active view")
                return []
            }
            
            const ses = wc.session
            console.log(`[ContentViewPool] Getting cookies for host: ${host} from session: ${ses.storagePath}`)
            
            try {
                const baseDomain = host.replace(/^www\./, "")
                const allCookies: Electron.Cookie[] = []
                const seenKeys = new Set<string>()
                
                const addCookie = (cookie: Electron.Cookie) => {
                    const key = `${cookie.name}|${cookie.domain}|${cookie.path}`
                    if (!seenKeys.has(key)) {
                        seenKeys.add(key)
                        allCookies.push(cookie)
                    }
                }
                
                // 1. All cookies for the URL
                try {
                    const urlCookies = await ses.cookies.get({ url: `https://${host}` })
                    urlCookies.forEach(addCookie)
                    console.log(`[ContentViewPool] URL cookies: ${urlCookies.length}`)
                } catch (e) { /* ignore */ }
                
                // 2. Exact domain
                try {
                    const exactCookies = await ses.cookies.get({ domain: host })
                    exactCookies.forEach(addCookie)
                    console.log(`[ContentViewPool] Exact domain cookies: ${exactCookies.length}`)
                } catch (e) { /* ignore */ }
                
                // 3. .domain
                try {
                    const dotCookies = await ses.cookies.get({ domain: "." + baseDomain })
                    dotCookies.forEach(addCookie)
                    console.log(`[ContentViewPool] Dot domain cookies: ${dotCookies.length}`)
                } catch (e) { /* ignore */ }
                
                // 4. www. subdomain
                if (!host.startsWith("www.")) {
                    try {
                        const wwwCookies = await ses.cookies.get({ domain: "www." + baseDomain })
                        wwwCookies.forEach(addCookie)
                    } catch (e) { /* ignore */ }
                }
                
                // 5. Fallback: All cookies filtered by domain
                try {
                    const allSessionCookies = await ses.cookies.get({})
                    console.log(`[ContentViewPool] Total cookies in session: ${allSessionCookies.length}`)
                    allSessionCookies.filter(c =>
                        c.domain === host ||
                        c.domain === "." + baseDomain ||
                        c.domain === "." + host ||
                        c.domain === baseDomain
                    ).forEach(addCookie)
                } catch (e) { /* ignore */ }
                
                console.log(`[ContentViewPool] Found ${allCookies.length} cookies for ${host}`)
                return allCookies
            } catch (e) {
                console.error("[ContentViewPool] Error getting cookies:", e)
                return []
            }
        })
        
        // Get ALL cookies from active view's session (for debugging)
        ipcMain.handle("cvp-get-all-cookies", async () => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (!wc || wc.isDestroyed()) {
                return []
            }
            
            try {
                const cookies = await wc.session.cookies.get({})
                console.log(`[ContentViewPool] All cookies: ${cookies.length}`)
                cookies.forEach(c => {
                    console.log(`  - ${c.name} @ ${c.domain}`)
                })
                return cookies
            } catch (e) {
                console.error("[ContentViewPool] Error getting all cookies:", e)
                return []
            }
        })
    }
    
    // ========== Zoom Methods ==========
    
    /**
     * Set zoom factor for +/- shortcuts
     */
    private setZoomFactor(factor: number): void {
        const clampedFactor = Math.max(0.25, Math.min(5.0, factor))
        this.cssZoomLevel = (clampedFactor - 1.0) / 0.1
        
        const active = this.getActiveView()
        if (active) {
            if (this.visualZoomEnabled) {
                active.setVisualZoomLevel(this.cssZoomLevel)
            } else {
                active.setCssZoom(this.cssZoomLevel)
            }
        }
        
        // Sync to all views in pool (so prefetched articles have same zoom)
        this.syncZoomToAllViews()
    }
    
    /**
     * Set CSS zoom level directly
     */
    private setCssZoom(level: number): void {
        const clampedLevel = Math.max(-6, Math.min(40, level))
        this.cssZoomLevel = clampedLevel
        
        console.log(`[ContentViewPool] setCssZoom(${level}) -> clamped to ${clampedLevel}, visualZoomEnabled=${this.visualZoomEnabled}`)

        const active = this.getActiveView()
        if (active) {
            // Use the correct zoom method based on visual zoom mode
            if (this.visualZoomEnabled) {
                console.log(`[ContentViewPool] setCssZoom: Visual Zoom enabled, calling setVisualZoomLevel`)
                active.setVisualZoomLevel(clampedLevel)
            } else {
                console.log(`[ContentViewPool] setCssZoom: CSS Zoom, calling setCssZoom on active view ${active.id}`)
                active.setCssZoom(clampedLevel)
            }
        } else {
            console.log(`[ContentViewPool] setCssZoom: no active view!`)
        }
        
        // Sync to all views
        this.syncZoomToAllViews()
    }
    
    /**
     * Set visual zoom mode
     */
    private setVisualZoomMode(enabled: boolean): void {
        this.visualZoomEnabled = enabled
        
        // Update all views
        for (const view of this.views) {
            view.setVisualZoomMode(enabled)
        }
    }
    
    /**
     * Set mobile mode (viewport constraint)
     */
    private setMobileMode(enabled: boolean): void {
        this.mobileMode = enabled
        
        console.log(`[ContentViewPool] setMobileMode(${enabled})`)
        
        // Update all views
        for (const view of this.views) {
            view.setMobileMode(enabled)
        }
    }
    
    /**
     * Sync zoom level to all views in pool
     */
    private syncZoomToAllViews(): void {
        for (const view of this.views) {
            if (this.visualZoomEnabled) {
                view.setVisualZoomLevel(this.cssZoomLevel)
            } else {
                view.setCssZoom(this.cssZoomLevel)
            }
        }
    }
    
    /**
     * Send message to the renderer
     */
    private sendToRenderer(channel: string, ...args: any[]): void {
        if (this.parentWindow && !this.parentWindow.isDestroyed()) {
            this.parentWindow.webContents.send(channel, ...args)
        }
    }
    
    // ========== Status & Debug ==========
    
    /**
     * Get pool status for debugging
     */
    getPoolStatus(): object {
        return {
            poolSize: this.views.length,
            configSize: this.config.size,
            activeViewId: this.activeViewId,
            readingDirection: this.readingDirection,
            currentIndex: this.currentArticleIndex,
            listLength: this.articleListLength,
            views: this.views.map(v => ({
                id: v.id,
                articleId: v.articleId,
                status: v.status,
                isActive: v.isActive,
                webContentsId: v.webContentsId
            }))
        }
    }
    
    /**
     * Destroy all views and cleanup
     */
    destroy(): void {
        this.cancelPrefetch()
        
        for (const view of this.views) {
            view.destroy()
        }
        
        this.views = []
        this.viewsByWebContentsId.clear()
        this.activeViewId = null
        this.parentWindow = null
        
        console.log("[ContentViewPool] Destroyed")
    }
}

// ========== Module Exports ==========

let poolInstance: ContentViewPool | null = null

export function initializeContentViewPool(parentWindow: BrowserWindow): ContentViewPool {
    poolInstance = ContentViewPool.getInstance()
    poolInstance.initialize(parentWindow)
    return poolInstance
}

export function getContentViewPool(): ContentViewPool | null {
    return poolInstance
}

export function destroyContentViewPool(): void {
    if (poolInstance) {
        poolInstance.destroy()
        poolInstance = null
    }
}
