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
import { ipcMain, BrowserWindow, Menu, clipboard, shell, nativeImage } from "electron"
import type { MenuItemConstructorOptions, Input } from "electron"
import { CachedContentView, NavigationSettings, CachedViewStatus } from "./cached-content-view"
import { isMobileUserAgentEnabled } from "./settings"
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
        size: 3,
        prefetchDelay: 1,  // Reduced for testing (was 400ms)
        enabled: true
    }
    
    // === Parent Window ===
    private parentWindow: BrowserWindow | null = null
    
    // === Bounds ===
    private visibleBounds: ContentViewBounds = { x: 0, y: 0, width: 800, height: 600 }
    private boundsReceived: boolean = false  // Track if real bounds have been received from renderer
    private isPoolVisible: boolean = false
    
    // === Reading Direction ===
    private readingDirection: ReadingDirection = 'unknown'
    private currentArticleIndex: number = -1
    private articleListLength: number = 0
    
    // === Navigation Lock ===
    // Prevents concurrent navigations - only one navigation can be in flight at a time
    // Problem: Multiple sources trigger navigation (IPC from ContentView, componentDidUpdate, etc.)
    // When user presses ArrowRight quickly, multiple navigations can queue up and cause skipping
    private isNavigationInProgress: boolean = false
    private navigationLockTimeout: NodeJS.Timeout | null = null
    private readonly NAVIGATION_LOCK_TIMEOUT_MS = 2000  // Auto-release lock after 2 seconds (safety net)
    
    // === Navigation Deduplication (secondary protection) ===
    // Even with lock, deduplicate same-article requests within short window
    private lastNavigationArticleId: string | null = null
    private lastNavigationTime: number = 0
    private readonly NAVIGATION_DEBOUNCE_MS = 100  // Ignore duplicate navigations within 100ms
    
    // === Prefetch Timer ===
    private prefetchTimer: NodeJS.Timeout | null = null
    private pendingPrefetch: PrefetchRequest[] = []
    
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
        console.log(`[ContentViewPool] Initialized with pool size: ${this.config.size}`)
        
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
        this.updateWebContentsMapping()
        
        // Apply current bounds to the newly created view
        view.setBounds(this.visibleBounds)
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
     * Release the navigation lock and clear timeout
     */
    private releaseNavigationLock(): void {
        this.isNavigationInProgress = false
        if (this.navigationLockTimeout) {
            clearTimeout(this.navigationLockTimeout)
            this.navigationLockTimeout = null
        }
    }
    
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
        // === Navigation Lock Check ===
        // Only one navigation can be in flight at a time
        // This prevents article skipping when multiple sources trigger navigation
        if (this.isNavigationInProgress) {
            console.log(`[ContentViewPool] Navigation BLOCKED (lock active) - request for ${articleId} ignored`)
            return false  // Return false to signal navigation was not performed
        }
        
        // === Navigation Deduplication (secondary) ===
        // Even with lock, deduplicate same-article requests within short window
        const now = Date.now()
        if (articleId === this.lastNavigationArticleId && 
            now - this.lastNavigationTime < this.NAVIGATION_DEBOUNCE_MS) {
            console.log(`[ContentViewPool] Navigation DEDUPLICATED - same article ${articleId} within ${this.NAVIGATION_DEBOUNCE_MS}ms`)
            return true  // Return success but don't actually navigate again
        }
        
        // === Acquire Navigation Lock ===
        this.isNavigationInProgress = true
        // Safety timeout - release lock if navigation takes too long
        this.navigationLockTimeout = setTimeout(() => {
            console.log(`[ContentViewPool] Navigation lock auto-released (timeout)`)
            this.releaseNavigationLock()
        }, this.NAVIGATION_LOCK_TIMEOUT_MS)
        
        // Track this navigation for deduplication
        this.lastNavigationArticleId = articleId
        this.lastNavigationTime = now
        
        // Cancel any pending prefetch
        this.cancelPrefetch()
        
        // Update article context
        this.currentArticleIndex = articleIndex
        this.articleListLength = listLength
        
        // Update reading direction based on position
        this.updateReadingDirectionFromPosition(articleIndex, listLength)
        
        console.log(`[ContentViewPool] Navigate to: ${articleId} (index ${articleIndex}/${listLength}, direction: ${this.readingDirection})`)
        
        // Check if article is already cached
        const cachedView = this.getViewByArticleId(articleId)
        if (cachedView && cachedView.isReady) {
            // Instant swap!
            console.log(`[ContentViewPool] Cache HIT - instant swap to ${cachedView.id}`)
            this.activateView(cachedView)
            
            // Schedule prefetch for next articles
            this.schedulePrefetch()
            
            // Release navigation lock - instant swap is complete
            this.releaseNavigationLock()
            
            return true
        }
        
        // Need to load - find or create a view
        const view = cachedView ?? this.getOrCreateView(articleId)
        
        // Deactivate current view - hide it
        const currentActive = this.getActiveView()
        if (currentActive && currentActive !== view) {
            console.log(`[ContentViewPool] Deactivating and hiding ${currentActive.id}`)
            currentActive.setActive(false)
            currentActive.setVisible(false)  // Hide using native visibility
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
                // Still release lock - navigation completed (just not shown)
                this.releaseNavigationLock()
                return true  // Load was successful, just not shown
            }
            
            // Show view when ready (only if still active AND bounds are available)
            if (this.isPoolVisible && this.boundsReceived) {
                view.setBounds(this.visibleBounds)
                view.setVisible(true)  // Show using native visibility
                view.focus()  // Single focus call after visibility is set
                console.log(`[ContentViewPool] Load complete, showing ${view.id}`)
            } else if (this.isPoolVisible) {
                console.log(`[ContentViewPool] Load complete for ${view.id}, waiting for bounds`)
            }
            
            // Notify renderer
            this.sendToRenderer('cvp-navigation-complete', articleId)
            
            // Schedule prefetch
            this.schedulePrefetch()
            
            // Release navigation lock - load complete
            this.releaseNavigationLock()
            
            return true
        } catch (err) {
            console.error(`[ContentViewPool] Navigation failed:`, err)
            this.sendToRenderer('cvp-error', articleId, String(err))
            
            // Release navigation lock even on error
            this.releaseNavigationLock()
            
            return false
        }
    }
    
    /**
     * Prefetch an article in the background
     */
    prefetch(articleId: string, url: string, feedId: string | null, settings: NavigationSettings): void {
        if (!this.config.enabled) return
        
        // Don't prefetch if already cached
        if (this.getViewByArticleId(articleId)) {
            console.log(`[ContentViewPool] Prefetch skip - already cached: ${articleId}`)
            return
        }
        
        // Find a free view (not active)
        const freeView = this.findFreeView()
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
     * Update reading direction based on article position
     */
    private updateReadingDirectionFromPosition(index: number, listLength: number): void {
        if (index === 0 && listLength > 1) {
            // First article - can only go forward
            this.readingDirection = 'forward'
        } else if (index === listLength - 1 && listLength > 1) {
            // Last article - can only go backward
            this.readingDirection = 'backward'
        }
        // Otherwise keep current direction (or unknown)
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
    private executePrefetch(): void {
        console.log(`[ContentViewPool] executePrefetch() - index=${this.currentArticleIndex}, listLength=${this.articleListLength}, direction=${this.readingDirection}`)
        if (this.currentArticleIndex < 0) {
            console.log(`[ContentViewPool] No current article index, skipping prefetch`)
            return
        }
        
        // Determine what to prefetch based on direction
        const targets = this.determinePrefetchTargets()
        
        console.log(`[ContentViewPool] Prefetch targets:`, targets)
        
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
     * Find the best view to recycle (LRU-like)
     */
    private findRecyclableView(): CachedContentView | null {
        // Don't recycle active view
        const candidates = this.views.filter(v => !v.isActive)
        
        if (candidates.length === 0) return null
        
        // Prefer views in opposite direction of reading
        // For now, just return the first non-active
        // TODO: Implement proper LRU with lastAccessTime
        return candidates[0]
    }
    
    /**
     * Activate a view (make it the visible one)
     */
    private activateView(view: CachedContentView): void {
        // Deactivate current - hide it
        const current = this.getActiveView()
        if (current && current !== view) {
            current.setActive(false)
            current.setVisible(false)  // Hide using native visibility
        }
        
        // Activate new
        this.activeViewId = view.id
        view.setActive(true)
        
        // Apply bounds and show if pool is visible AND we have real bounds
        if (this.isPoolVisible && this.boundsReceived) {
            view.setBounds(this.visibleBounds)
            view.setVisible(true)
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
        
        // Store bounds
        this.visibleBounds = bounds
        
        // Only mark as received if real bounds
        if (isRealBounds) {
            this.boundsReceived = true
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
            active.setBounds(bounds)
            active.setVisible(true)
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
                    active.setBounds(this.visibleBounds)
                    active.setVisible(true)
                    active.focus()
                    console.log(`[ContentViewPool] Showing ${active.id} at bounds:`, this.visibleBounds)
                } else {
                    console.log(`[ContentViewPool] setVisible(true) - waiting for bounds before showing ${active.id}`)
                }
            } else {
                active.setVisible(false)
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
        
        // Prefetch info response from renderer
        ipcMain.on('cvp-prefetch-info', (event, articleIndex, articleId, url, feedId, settings) => {
            console.log(`[ContentViewPool] IPC cvp-prefetch-info received: index=${articleIndex}, articleId=${articleId}, url=${url?.substring(0, 50)}...`)
            if (articleId && url) {
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
            this.mobileMode = enabled
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
        
        const active = this.getActiveView()
        if (active) {
            active.setCssZoom(clampedLevel)
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
