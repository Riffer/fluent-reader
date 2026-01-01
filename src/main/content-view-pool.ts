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
import { ipcMain, BrowserWindow } from "electron"
import { CachedContentView, NavigationSettings, CachedViewStatus } from "./cached-content-view"
import { isMobileUserAgentEnabled } from "./settings"

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
        prefetchDelay: 400,
        enabled: true
    }
    
    // === Parent Window ===
    private parentWindow: BrowserWindow | null = null
    
    // === Bounds ===
    private visibleBounds: ContentViewBounds = { x: 0, y: 0, width: 800, height: 600 }
    private isPoolVisible: boolean = false
    
    // === Reading Direction ===
    private readingDirection: ReadingDirection = 'unknown'
    private currentArticleIndex: number = -1
    private articleListLength: number = 0
    
    // === Prefetch Timer ===
    private prefetchTimer: NodeJS.Timeout | null = null
    private pendingPrefetch: PrefetchRequest[] = []
    
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
            
            return true
        }
        
        // Need to load - find or create a view
        const view = cachedView ?? this.getOrCreateView(articleId)
        
        // Deactivate current view
        const currentActive = this.getActiveView()
        if (currentActive) {
            currentActive.setActive(false)
            currentActive.hide()
        }
        
        // Set as active (but not visible yet)
        this.activeViewId = view.id
        view.setActive(true)
        
        // Load the article
        try {
            await view.load(url, articleId, feedId, settings, isMobileUserAgentEnabled())
            
            // Show view when ready
            if (this.isPoolVisible) {
                view.setBounds(this.visibleBounds)
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
        
        // Ensure view is created
        if (!freeView.view && this.parentWindow) {
            freeView.create(this.parentWindow)
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
        if (!this.config.enabled) return
        
        // Cancel any existing timer
        this.cancelPrefetch()
        
        // Wait for active view to be ready
        const activeView = this.getActiveView()
        if (!activeView) return
        
        const doPrefetch = () => {
            this.prefetchTimer = setTimeout(() => {
                this.prefetchTimer = null
                this.executePrefetch()
            }, this.config.prefetchDelay)
        }
        
        if (activeView.isReady) {
            // Already ready - schedule with delay
            doPrefetch()
        } else {
            // Wait for ready event
            activeView.setOnDomReady(() => {
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
        if (this.currentArticleIndex < 0) return
        
        // Determine what to prefetch based on direction
        const targets = this.determinePrefetchTargets()
        
        console.log(`[ContentViewPool] Prefetch targets:`, targets)
        
        // Request prefetch info from renderer
        // The renderer knows the article URLs
        if (targets.primary !== null) {
            this.sendToRenderer('cvp-request-prefetch-info', targets.primary)
        }
        if (targets.secondary !== null) {
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
                empty.create(this.parentWindow)
            }
            return empty
        }
        
        // Check if we can create a new view
        if (this.views.length < this.config.size) {
            const newView = new CachedContentView(`view-${this.views.length}`)
            if (this.parentWindow) {
                newView.create(this.parentWindow)
            }
            this.views.push(newView)
            this.updateWebContentsMapping()
            return newView
        }
        
        // Need to recycle an existing view
        const toRecycle = this.findRecyclableView()
        if (toRecycle) {
            toRecycle.recycle()
            if (this.parentWindow) {
                toRecycle.create(this.parentWindow)
            }
            this.updateWebContentsMapping()
            return toRecycle
        }
        
        // Shouldn't happen, but fallback to first non-active view
        const fallback = this.views.find(v => !v.isActive)!
        fallback.recycle()
        if (this.parentWindow) {
            fallback.create(this.parentWindow)
        }
        this.updateWebContentsMapping()
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
        // Deactivate current
        const current = this.getActiveView()
        if (current && current !== view) {
            current.setActive(false)
            current.hide()
        }
        
        // Activate new
        this.activeViewId = view.id
        view.setActive(true)
        
        // Show if pool is visible
        if (this.isPoolVisible) {
            view.setBounds(this.visibleBounds)
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
    
    // ========== Visibility ==========
    
    /**
     * Set the visible bounds for the active view
     */
    setBounds(bounds: ContentViewBounds): void {
        this.visibleBounds = bounds
        
        // Update active view
        if (this.isPoolVisible) {
            const active = this.getActiveView()
            if (active) {
                active.setBounds(bounds)
            }
        }
    }
    
    /**
     * Show/hide the pool
     */
    setVisible(visible: boolean): void {
        this.isPoolVisible = visible
        
        const active = this.getActiveView()
        if (active) {
            if (visible) {
                active.setBounds(this.visibleBounds)
            } else {
                active.hide()
            }
        }
    }
    
    // ========== IPC ==========
    
    /**
     * Setup IPC handlers for pool operations
     */
    private setupIpcHandlers(): void {
        // Navigate to article
        ipcMain.handle('cvp-navigate', async (event, articleId, url, feedId, settings, index, listLength) => {
            return this.navigateToArticle(articleId, url, feedId, settings, index, listLength)
        })
        
        // Prefetch article
        ipcMain.on('cvp-prefetch', (event, articleId, url, feedId, settings) => {
            this.prefetch(articleId, url, feedId, settings)
        })
        
        // Prefetch info response from renderer
        ipcMain.on('cvp-prefetch-info', (event, articleIndex, articleId, url, feedId, settings) => {
            if (articleId && url) {
                this.prefetch(articleId, url, feedId, settings)
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
        
        // Forward events from views to renderer
        // (Views send events, we route them based on sender)
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
