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
import { ipcMain, BrowserWindow, Menu, clipboard, shell, nativeImage, net, app } from "electron"
import type { MenuItemConstructorOptions, Input } from "electron"
import { CachedContentView, NavigationSettings, CachedViewStatus } from "./cached-content-view"
import { isMobileUserAgentEnabled, isVisualZoomEnabled } from "./settings"
import { extractFromHtml } from "@extractus/article-extractor"
import { generateArticleHtml, generateFullContentHtml, textDirToString, TextDirection } from "./article-html-generator"
import { translateText, translateHtml } from "./translation-service"
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
    translateTo?: string  // Target language for translation (e.g., 'de')
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
        size: 7,  // 1 active + 4 prefetch targets + 2 buffer for parallel feeds
        prefetchDelay: 1,  // Reduced for testing (was 400ms)
        enabled: true
    }
    
    // === Parent Window ===
    private parentWindow: BrowserWindow | null = null
    
    // === Pool Generation (incremented on nuke to invalidate stale requests) ===
    private poolGeneration: number = 0
    private awaitingFirstNavigationAfterNuke: boolean = false  // Block prefetches until first navigation
    
    // === List Identity (menuKey from UI - identifies which article list is active) ===
    private currentMenuKey: string | null = null
    
    // === Bounds ===
    private visibleBounds: ContentViewBounds = { x: 0, y: 0, width: 800, height: 600 }
    private boundsReceived: boolean = false  // Track if real bounds have been received from renderer
    private isPoolVisible: boolean = false
    private videoFullscreenActive: boolean = false  // Track if video is in fullscreen mode
    
    // === Reading Direction ===
    private readingDirection: ReadingDirection = 'unknown'
    private currentArticleIndex: number = -1
    private articleListLength: number = 0
    private currentSourceId: number | null = null  // Current feed group/view ID for cache invalidation
    
    // === Prefetch Timer ===
    private prefetchTimer: NodeJS.Timeout | null = null
    private pendingPrefetch: PrefetchRequest[] = []
    private protectedArticleIds: Set<string> = new Set()  // Articles that should not be recycled (prefetch targets)
    private pendingPrefetchArticleIds: Set<string> = new Set()  // ArticleIds being prefetched right now
    
    // === Cascaded Prefetch ===
    private prefetchQueue: number[] = []  // Queue of article indices to prefetch (prioritized)
    private prefetchInProgress: string | null = null  // Currently prefetching articleId
    
    // === Render Position ===
    // The view at the "render position" has 1 pixel visible to force Chromium to render it
    // This is used for the "next" article in reading direction to ensure instant navigation
    private renderPositionViewId: string | null = null
    private renderPositionPreviewActive: boolean = false  // Debug: When true, render-position view is fully visible
    private cascadedPrefetchEnabled: boolean = true  // Enable/disable cascaded mode
    
    // === Prefetch Status Tracking ===
    private prefetchTargets: number[] = []  // All prefetch target indices (for status)
    private prefetchCompletedIndices: Set<number> = new Set()  // Completed prefetch indices
    
    // === Zoom State ===
    private cssZoomLevel: number = 0
    private visualZoomEnabled: boolean = false
    private mobileMode: boolean = false
    private isSyncingZoom: boolean = false  // Block new zoom requests during sync
    private isZoomPending: boolean = false  // Waiting for view to confirm zoom applied
    private zoomPendingTimeout: NodeJS.Timeout | null = null  // Safety timeout for pending zoom
    
    /**
     * Round zoom level to 1 decimal place to avoid floating-point artifacts
     * (e.g., 8.999999999999998 → 9.0)
     * This preserves 1% zoom steps (0.1) while eliminating precision issues.
     */
    private roundZoom(level: number): number {
        return Math.round(level * 10) / 10
    }
    
    /**
     * Truncate data: URLs for logging (they can be huge base64 content)
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
     * Format error for logging - only show code and truncated URL
     */
    private formatErrorForLog(err: any): string {
        const code = err?.code || err?.errno || 'UNKNOWN'
        const url = this.truncateDataUrl(err?.url)
        return `${code} - ${url}`
    }
    
    /**
     * Called when view confirms zoom was applied
     */
    onZoomApplied(): void {
        this.isZoomPending = false
        if (this.zoomPendingTimeout) {
            clearTimeout(this.zoomPendingTimeout)
            this.zoomPendingTimeout = null
        }
    }
    
    // === Input Mode ===
    // When active, most keyboard shortcuts are passed to the page for form input
    private inputModeActive: boolean = false
    
    // === Focus Tracking ===
    // Track if ContentView had focus before window lost focus
    // This allows restoring focus when window regains focus
    private contentViewHadFocus: boolean = false
    
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
            // console.warn("[ContentViewPool] Already initialized")
            return
        }
        
        this.parentWindow = parentWindow
        
        // Load initial settings from store
        this.visualZoomEnabled = isVisualZoomEnabled()
        // console.log(`[ContentViewPool] Initialized with pool size: ${this.config.size}, visualZoom: ${this.visualZoomEnabled}`)
        
        // Setup window focus tracking
        this.setupWindowFocusTracking()
        
        // Views are created lazily when needed
    }
    
    /**
     * Setup window focus/blur tracking to restore ContentView focus
     * 
     * Problem: When the window loses focus and regains it, the ContentView
     * loses keyboard focus to other UI elements (like buttons).
     * 
     * Solution: If ContentView is visible when window loses focus, restore focus on regain.
     * 
     * Note: We cannot reliably check webContents.isFocused() at blur time because
     * focus has already moved to the other window by the time the event fires.
     * Therefore we use a simple heuristic: if ContentView is visible, restore its focus.
     */
    private setupWindowFocusTracking(): void {
        if (!this.parentWindow) return
        
        // When window loses focus, remember if ContentView was visible
        this.parentWindow.on('blur', () => {
            const activeView = this.getActiveView()
            
            if (activeView && this.isPoolVisible && activeView.isReady) {
                // ContentView is visible and ready - restore its focus when window regains focus
                this.contentViewHadFocus = true
                // console.log(`[ContentViewPool] Window blur - ContentView ${activeView.id} visible, will restore focus`)
            } else {
                this.contentViewHadFocus = false
                // console.log('[ContentViewPool] Window blur - ContentView not visible/ready')
            }
        })
        
        // When window regains focus, restore ContentView focus if it was visible before
        this.parentWindow.on('focus', () => {
            // console.log(`[ContentViewPool] Window focus - contentViewHadFocus=${this.contentViewHadFocus}, isPoolVisible=${this.isPoolVisible}`)
            if (this.contentViewHadFocus && this.isPoolVisible) {
                const activeView = this.getActiveView()
                if (activeView && activeView.isReady) {
                    // console.log('[ContentViewPool] Window focus - restoring ContentView focus')
                    // Small delay to let window focus settle
                    setTimeout(() => {
                        if (this.contentViewHadFocus && activeView.isActive) {
                            activeView.focus()
                            // console.log('[ContentViewPool] ContentView focus restored')
                        }
                    }, 50)
                }
            }
        })
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
        
        // console.log(`[ContentViewPool] Config updated:`, this.config)
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
                // console.log(`[ContentViewPool] Video fullscreen: ${isFullscreen}`)
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
                            // console.log(`[ContentViewPool] Setting fullscreen bounds: ${width}x${height}`)
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
     * Setup focus guard: When a background view triggers navigation events,
     * ensure focus stays on the active view.
     * 
     * Problem: Electron may internally shift focus when a WebContentsView
     * starts or completes loading. This causes the active view to lose
     * keyboard input.
     * 
     * Known Electron bug: https://github.com/electron/electron/issues/42578
     * 
     * Solution: Listen to multiple navigation events on all views and refocus
     * the active view if a background view triggered the event.
     */
    private setupFocusGuard(view: CachedContentView): void {
        const wc = view.getWebContents()
        if (!wc) return
        
        // Helper to refocus active view if this is a background view
        const refocusIfNeeded = (eventName: string) => {
            // If THIS view is NOT active but another view IS active,
            // refocus the active view to prevent focus theft
            if (!view.isActive && this.activeViewId) {
                const activeView = this.getActiveView()
                if (activeView && activeView.isReady) {
                    // console.log(`[ContentViewPool] Focus guard: Background ${view.id} fired ${eventName}, refocusing active ${activeView.id}`)
                    // Small delay to ensure Electron has finished its internal focus handling
                    setTimeout(() => {
                        if (activeView.isActive) {
                            activeView.focus()
                        }
                    }, 10)
                }
            }
        }
        
        // Listen to multiple events that may cause focus theft
        // Earlier events = faster focus recovery
        wc.on('did-start-loading', () => refocusIfNeeded('did-start-loading'))
        wc.on('did-start-navigation', () => refocusIfNeeded('did-start-navigation'))
        wc.on('did-navigate', () => refocusIfNeeded('did-navigate'))
        wc.on('dom-ready', () => refocusIfNeeded('dom-ready'))
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
     * Keys that are ALWAYS blocked, even in Input Mode
     * These are essential for exiting input mode and navigating away
     */
    private static readonly INPUT_MODE_BLOCKED_KEYS = new Set([
        'Escape',           // Exit input mode / close article (Ctrl+I to toggle, ESC to exit)
        // All other keys pass through to page for form input
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
            
            // === Focus Theft Mitigation for Navigation Keys ===
            // Due to Electron bug, background views may steal focus during prefetch loading.
            // If a background view receives ArrowLeft/ArrowRight, forward the event to the
            // active view and restore focus. This ensures navigation works even when focus
            // was incorrectly stolen.
            if (!view.isActive) {
                const isNavigationKey = input.key === 'ArrowLeft' || input.key === 'ArrowRight'
                
                if (isNavigationKey && this.activeViewId) {
                    const activeView = this.getActiveView()
                    if (activeView && activeView.isReady) {
                        const activeWc = activeView.getWebContents()
                        if (activeWc && !activeWc.isDestroyed()) {
                            // console.log(`[ContentViewPool] Focus theft detected: ${view.id} received ${input.key}, forwarding to active ${activeView.id}`)
                            
                            // Restore focus to active view
                            activeView.focus()
                            
                            // Forward the input event to the active view
                            activeWc.sendInputEvent({
                                type: 'keyDown',
                                keyCode: input.key,
                                modifiers: [
                                    ...(input.shift ? ['shift' as const] : []),
                                    ...(input.control ? ['control' as const] : []),
                                    ...(input.alt ? ['alt' as const] : []),
                                    ...(input.meta ? ['meta' as const] : [])
                                ]
                            })
                            
                            // Prevent original event from being processed
                            event.preventDefault()
                        }
                    }
                }
                return  // Don't process events from non-active views
            }
            
            // Don't forward F11/F12 - global shortcuts handled by main window
            if (input.key === 'F11' || input.key === 'F12') {
                return
            }
            
            // During video fullscreen, let certain keys pass through to the video player
            // instead of being handled by the app (e.g., ArrowLeft/Right for seeking, m for mute)
            if (this.videoFullscreenActive && ContentViewPool.VIDEO_FULLSCREEN_PASSTHROUGH_KEYS.has(input.key)) {
                // console.log(`[ContentViewPool] Video fullscreen: passing ${input.key} to page`)
                return  // Don't block, don't forward to renderer - let page handle it
            }
            
            // Input Mode: Allow most keys to pass through for form input
            // Only block essential keys (ESC to exit, Ctrl+I to toggle)
            if (this.inputModeActive) {
                // In input mode, only block minimal keys and forward Ctrl+I / ESC to renderer
                const isCtrlI = input.key.toLowerCase() === 'i' && input.control && !input.alt && !input.meta
                const isEscape = input.key === 'Escape'
                
                if (isCtrlI || isEscape) {
                    // Block and forward to renderer for input mode handling
                    event.preventDefault()
                    // console.log(`[ContentViewPool] Input mode: forwarding ${input.key} to renderer for mode toggle/exit`)
                    this.sendToRenderer("content-view-input", input)
                }
                // All other keys pass through to page - no blocking, no forwarding
                return
            }
            
            // Normal mode: Block keys that we handle via IPC to prevent page from also handling them
            // e.g., "m" toggles mobile mode but would also mute videos
            if (ContentViewPool.BLOCKED_KEYS.has(input.key)) {
                event.preventDefault()
            }
            
            // Forward to renderer for processing
            // console.log(`[ContentViewPool] Forwarding ${input.key} from ${view.id} to renderer`)
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
     * Get the feedId of the currently active view
     * Used by window.ts to enrich zoom events from preload scripts
     * that don't have access to feedId themselves
     */
    getActiveFeedId(): string | null {
        const active = this.getActiveView()
        return active?.feedId ?? null
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
        listLength: number,
        sourceId: number | null = null,
        menuKey: string | null = null
    ): Promise<boolean> {
        // Clear the nuke flag - this navigation establishes the new list context
        if (this.awaitingFirstNavigationAfterNuke) {
            // console.log(`[ContentViewPool] First navigation after nuke - prefetches unblocked`)
            this.awaitingFirstNavigationAfterNuke = false
        }
        
        // Update the current menuKey - this identifies the active article list
        if (menuKey) {
            // if (this.currentMenuKey !== menuKey) {
            //     console.log(`[ContentViewPool] menuKey changed: ${this.currentMenuKey} -> ${menuKey}`)
            // }
            this.currentMenuKey = menuKey
        }
        
        // Cancel any pending prefetch
        this.cancelPrefetch()
        
        // NOTE: List change detection is now handled by onListChanged() from the UI.
        // The UI calls window.contentViewPool.onListChanged() before dispatching
        // selectSources/selectAllArticles, which triggers nukePool().
        
        // NOTE: We no longer invalidate cache on sourceId change.
        // Lists can contain articles from multiple feeds (e.g., "All Articles").
        // Navigating within such a list changes sourceId but should NOT clear the cache.
        // View parameters (zoom etc.) are adjusted per-navigation based on feed settings.
        // The LRU mechanism handles view recycling appropriately.
        
        // Reset input mode on article change (user may have left it on)
        if (this.inputModeActive) {
            this.inputModeActive = false
            // console.log('[ContentViewPool] Input mode reset on article change')
        }
        
        // Update reading direction BEFORE updating currentArticleIndex
        // (needs old index to compare)
        this.updateReadingDirection(articleIndex, listLength)
        
        // Update article context
        this.currentArticleIndex = articleIndex
        this.articleListLength = listLength
        
        // Log pool status for debugging
        // console.log(`[ContentViewPool] Navigate to: ${articleId} (index ${articleIndex}/${listLength}, direction: ${this.readingDirection})`)
        // console.log(`[ContentViewPool] Pool status:`, this.views.map(v => 
        //     `${v.id}: ${v.articleId || 'empty'} (${v.status}, active=${v.isActive})`
        // ).join(', '))
        
        // Check if article is already cached
        // Use hasLoadedOnce instead of isReady to handle pages that temporarily "load"
        // due to ads/videos refreshing - the content is still usable
        const cachedView = this.getViewByArticleId(articleId)
        if (cachedView && cachedView.hasLoadedOnce) {
            // Instant swap!
            // console.log(`[ContentViewPool] Cache HIT - instant swap to ${cachedView.id}`)
            
            // Play sound on cache hit (dev mode only, for debugging)
            if (!app.isPackaged) {
                shell.beep()
            }
            
            // IMPORTANT: Apply zoom settings from the navigation request!
            // The cached view may have been loaded with a different feed's zoom level.
            // We need to apply the current feed's zoom settings (from settings.zoomFactor).
            const zoomLevel = this.roundZoom((settings.zoomFactor - 1.0) / 0.1)
            this.cssZoomLevel = zoomLevel
            
            // Check if zoom differs from what the view was loaded with
            if (Math.abs(cachedView.loadedWithZoom - settings.zoomFactor) > 0.01) {
                // console.log(`[ContentViewPool] Cache HIT: Applying feed-specific zoom: factor=${settings.zoomFactor.toFixed(2)}, level=${zoomLevel} (was loaded with factor=${cachedView.loadedWithZoom.toFixed(2)})`)
                if (this.visualZoomEnabled) {
                    cachedView.setVisualZoomLevel(zoomLevel)
                } else {
                    cachedView.setCssZoom(zoomLevel)
                }
            }
            
            this.activateView(cachedView)
            
            // Update render position immediately for cache hits
            // This ensures the "next" article is at render position when available
            this.updateRenderPosition()
            
            // Schedule prefetch for next articles
            this.schedulePrefetch()
            
            return true
        }
        
        // Update pool's zoom level to match the feed's settings BEFORE creating view
        // This ensures the correct zoom is applied when createViewWithEvents is called
        const zoomLevel = this.roundZoom((settings.zoomFactor - 1.0) / 0.1)
        this.cssZoomLevel = zoomLevel
        
        // Need to load - find or create a view
        const view = cachedView ?? this.getOrCreateView(articleId)
        
        // Deactivate current view - hide it (with current bounds so size is preserved)
        const currentActive = this.getActiveView()
        if (currentActive && currentActive !== view) {
            // console.log(`[ContentViewPool] Deactivating and hiding ${currentActive.id}`)
            
            // Stop any ongoing load on the old active view to free it immediately
            // This ensures the view is available for prefetch on the next navigation
            if (currentActive.isLoading) {
                const wc = currentActive.getWebContents()
                if (wc && !wc.isDestroyed()) {
                    // console.log(`[ContentViewPool] Stopping load on old active ${currentActive.id}`)
                    wc.stop()
                }
            }
            
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
            await view.load(url, articleId, feedId, settings, isMobileUserAgentEnabled(), articleIndex)
            
            // IMPORTANT: Check if this view is still the active one!
            // User may have navigated to another article while we were loading
            if (this.activeViewId !== view.id) {
                // console.log(`[ContentViewPool] Load complete for ${view.id}, but ${this.activeViewId} is now active - not showing`)
                return true  // Load was successful, just not shown
            }
            
            // Show view when ready (only if still active AND bounds are available)
            if (this.isPoolVisible && this.boundsReceived) {
                // DEFENSIVE: Ensure ALL other views are offscreen before showing
                // This prevents "orphaned" views from race conditions
                for (const v of this.views) {
                    if (v !== view && !v.isAtRenderPosition) {
                        v.moveOffScreen(this.visibleBounds)
                    }
                }
                
                view.setVisible(true, this.visibleBounds)
                view.bringToFront()  // Ensure active view is on top (covers render-position views)
                view.focus()  // Single focus call after visibility is set
                // console.log(`[ContentViewPool] Load complete, showing ${view.id}`)
                
                // Update render position for the "next" article
                // Do this after showing the active view so it's properly covered
                this.updateRenderPosition()
            } else if (this.isPoolVisible) {
                // console.log(`[ContentViewPool] Load complete for ${view.id}, waiting for bounds`)
            }
            
            // Notify renderer about view activation with current zoom level
            // This ensures both viewId and zoom are displayed in the UI
            this.sendToRenderer('content-view-zoom-changed', this.cssZoomLevel, feedId, view.id)
            
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
    prefetch(articleId: string, url: string, feedId: string | null, settings: NavigationSettings, articleIndex: number = -1): void {
        if (!this.config.enabled) {
            // CRITICAL: Remove from pending set to prevent blocking future prefetches!
            this.pendingPrefetchArticleIds.delete(articleId)
            return
        }
        
        // Add this articleId to protected set - it's a prefetch target
        // This prevents another concurrent prefetch from recycling a view
        // that's loading/holding this article
        this.protectedArticleIds.add(articleId)
        
        // Check if article is already in a view
        const existingView = this.getViewByArticleId(articleId)
        let viewToUse: CachedContentView | null = null
        
        if (existingView) {
            // Check the status of the existing view
            switch (existingView.status) {
                case 'ready':
                    // Already loaded - mark complete and continue cascade
                    // console.log(`[ContentViewPool] Prefetch skip - already ready: ${articleId}`)
                    // CRITICAL: Remove from pending set to prevent blocking future prefetches!
                    this.pendingPrefetchArticleIds.delete(articleId)
                    this.onPrefetchComplete(articleId, articleIndex)
                    return
                case 'loading':
                    // Currently loading - check if it's stuck (stale)
                    if (existingView.isStaleLoading) {
                        console.warn(`[ContentViewPool] Prefetch: view ${existingView.id} is stale loading (> 60s), recycling`)
                        existingView.recycle()
                        viewToUse = existingView
                    } else {
                        // Still loading normally - the load's completion will trigger onPrefetchComplete
                        // Don't call onPrefetchComplete here - wait for the load to finish
                        // NOTE: Keep in pendingPrefetchArticleIds - the load completion will delete it
                        // console.log(`[ContentViewPool] Prefetch skip - already loading: ${articleId}`)
                        return
                    }
                    break
                case 'error':
                    // Previous load failed - recycle and try again
                    // console.log(`[ContentViewPool] Prefetch retry - previous load failed: ${articleId}`)
                    existingView.recycle()
                    viewToUse = existingView  // Use this view for retry
                    break
                case 'empty':
                    // View was recycled but still has articleId? Shouldn't happen, but use it
                    // console.log(`[ContentViewPool] Prefetch: view ${existingView.id} is empty with articleId ${articleId}`)
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
                // console.log(`[ContentViewPool] Prefetch: recycling ${freeView.id} (was ${freeView.articleId}) for ${articleId}`)
                freeView.recycle()
            }
        }
        
        if (!freeView) {
            // No free view - mark as complete anyway so cascade continues
            // CRITICAL: Remove from pending set to prevent blocking future prefetches!
            this.pendingPrefetchArticleIds.delete(articleId)
            console.warn(`[ContentViewPool] Prefetch skip - no free view for: ${articleId}`)
            this.onPrefetchComplete(articleId, articleIndex)
            return
        }
        
        // console.log(`[ContentViewPool] Prefetch: ${articleId} in ${freeView.id}`)
        
        // Recycle the view if it has old content (but not if protected, pending, or target!)
        if (!freeView.isEmpty) {
            if (freeView.articleId && (
                this.protectedArticleIds.has(freeView.articleId) || 
                this.pendingPrefetchArticleIds.has(freeView.articleId)
            )) {
                // View holds protected article - mark as complete so cascade continues
                // CRITICAL: Remove from pending set to prevent blocking future prefetches!
                this.pendingPrefetchArticleIds.delete(articleId)
                console.warn(`[ContentViewPool] Prefetch skip - view ${freeView.id} holds protected/pending article ${freeView.articleId}`)
                this.onPrefetchComplete(articleId, articleIndex)
                return
            }
            // Don't recycle if view holds ready content for a current prefetch target
            if (freeView.hasLoadedOnce && freeView.articleIndex >= 0 && this.prefetchTargets.includes(freeView.articleIndex)) {
                // View holds target content - mark as complete so cascade continues
                // CRITICAL: Remove from pending set to prevent blocking future prefetches!
                this.pendingPrefetchArticleIds.delete(articleId)
                console.warn(`[ContentViewPool] Prefetch skip - view ${freeView.id} holds ready target index ${freeView.articleIndex}`)
                this.onPrefetchComplete(articleId, articleIndex)
                return
            }
            freeView.recycle()
        }
        
        // Ensure view is created with events
        if (!freeView.view && this.parentWindow) {
            this.createViewWithEvents(freeView)
        }
        
        // Load in background
        freeView.load(url, articleId, feedId, settings, isMobileUserAgentEnabled(), articleIndex)
            .then(() => {
                // Remove from pending set after successful load
                this.pendingPrefetchArticleIds.delete(articleId)
                // Keep in protectedArticleIds - will be cleared on next executePrefetch()
                
                // Cascaded prefetch: trigger next item (with index for status tracking)
                this.onPrefetchComplete(articleId, articleIndex)
            })
            .catch(err => {
                // ERR_FAILED (-2) is expected when prefetch is cancelled (view stopped for new navigation)
                // Only log unexpected errors
                if (err?.code !== 'ERR_FAILED') {
                    console.error(`[ContentViewPool] Prefetch failed for ${articleId}: ${this.formatErrorForLog(err)}`)
                }
                // Remove from pending set on failure too
                this.pendingPrefetchArticleIds.delete(articleId)
                
                // Cascaded prefetch: continue with next even on failure
                this.onPrefetchComplete(articleId, articleIndex)
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
        articleInfo: PrefetchArticleInfo,
        articleIndex: number = -1
    ): Promise<void> {
        if (!this.config.enabled) {
            // CRITICAL: Remove from pending set to prevent blocking future prefetches!
            this.pendingPrefetchArticleIds.delete(articleId)
            this.onPrefetchComplete(articleId, articleIndex)
            return
        }
        
        // Check if article is already in a view WITH FullContent mode
        // If it's cached but NOT in FullContent mode, we need to reload with extracted content
        const existingView = this.getViewByArticleId(articleId)
        if (existingView && existingView.isFullContentMode && (existingView.status === 'ready' || existingView.status === 'loading')) {
            // console.log(`[ContentViewPool] FullContent prefetch skip - already ${existingView.status}: ${articleId}`)
            // CRITICAL: Remove from pending set to prevent blocking future prefetches!
            this.pendingPrefetchArticleIds.delete(articleId)
            this.onPrefetchComplete(articleId, articleIndex)
            return
        }
        
        // If view exists but is NOT FullContent mode, recycle it first
        if (existingView && !existingView.isFullContentMode) {
            console.log(`[ContentViewPool] FullContent: recycling non-FullContent view for ${articleId}`)
            existingView.recycle()
        }
        
        // Find a free view
        let freeView = this.findFreeView()
        if (!freeView) {
            freeView = this.findRecyclableView()
            if (freeView) {
                // console.log(`[ContentViewPool] FullContent prefetch: recycling ${freeView.id}`)
                freeView.recycle()
            }
        }
        
        if (!freeView) {
            // console.log(`[ContentViewPool] FullContent prefetch skip - no free view for: ${articleId}`)
            // CRITICAL: Remove from pending set to prevent blocking future prefetches!
            this.pendingPrefetchArticleIds.delete(articleId)
            this.onPrefetchComplete(articleId, articleIndex)
            return
        }
        
        // console.log(`[ContentViewPool] FullContent prefetch starting: ${articleId} in ${freeView.id}`)
        
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
            // console.log(`[ContentViewPool] FullContent: fetching ${articleInfo.itemLink}`)
            const html = await this.fetchWebpage(articleInfo.itemLink)
            
            // Step 2: Extract article content
            // console.log(`[ContentViewPool] FullContent: extracting content`)
            const extracted = await extractFromHtml(html, articleInfo.itemLink)
            
            // Step 3: Use extracted content or fallback to RSS content
            let contentToUse = extracted?.content || articleInfo.itemContent || ''
            let titleToUse = extracted?.title || articleInfo.itemTitle
            
            // Step 4: Translate if source has translation enabled
            if (articleInfo.translateTo) {
                console.log(`[ContentViewPool] FullContent: translating to ${articleInfo.translateTo}`)
                console.log(`[ContentViewPool] FullContent: contentToUse BEFORE length=${contentToUse.length}`)
                console.log(`[ContentViewPool] FullContent: contentToUse BEFORE first 200 chars: ${contentToUse.substring(0, 200)}`)
                try {
                    // Translate title
                    titleToUse = await translateText(titleToUse, articleInfo.translateTo)
                    // Translate content (HTML-aware)
                    contentToUse = await translateHtml(contentToUse, articleInfo.translateTo)
                    console.log(`[ContentViewPool] FullContent: translation complete`)
                    console.log(`[ContentViewPool] FullContent: contentToUse AFTER length=${contentToUse.length}`)
                    console.log(`[ContentViewPool] FullContent: contentToUse AFTER first 200 chars: ${contentToUse.substring(0, 200)}`)
                } catch (translationError) {
                    console.error(`[ContentViewPool] FullContent: translation failed:`, translationError)
                    // Keep original content on translation error
                }
            }
            
            // Step 5: Generate HTML data URL
            const dataUrl = generateFullContentHtml({
                title: titleToUse,
                date: new Date(articleInfo.itemDate),
                content: contentToUse,
                baseUrl: articleInfo.itemLink,
                textDir: textDirToString(articleInfo.textDir),
                fontSize: articleInfo.fontSize,
                fontFamily: articleInfo.fontFamily,
                locale: articleInfo.locale,
                extractorTitle: titleToUse,
                extractorDate: extracted?.published ? new Date(extracted.published) : undefined
            })
            
            // console.log(`[ContentViewPool] FullContent: loading extracted content for ${articleId}`)
            
            // Step 6: Load the generated HTML and mark as FullContent mode
            await freeView.load(dataUrl, articleId, feedId, settings, false, articleIndex)
            freeView.isFullContentMode = true  // Mark this view as FullContent so it's not recycled for Local mode
            
            // console.log(`[ContentViewPool] FullContent prefetch complete: ${articleId}`)
            // Remove from pending set after successful load
            this.pendingPrefetchArticleIds.delete(articleId)
            
            // Cascaded prefetch: trigger next item (with index for status tracking)
            this.onPrefetchComplete(articleId, articleIndex)
        } catch (err: any) {
            // ERR_FAILED (-2) is expected when prefetch is cancelled (view stopped for new navigation)
            // Only log unexpected errors
            if (err?.code !== 'ERR_FAILED') {
                console.error(`[ContentViewPool] FullContent prefetch failed for ${articleId}: ${this.formatErrorForLog(err)}`)
            }
            // Remove from pending set on failure too
            this.pendingPrefetchArticleIds.delete(articleId)
            // On error, the view stays empty/error state
            
            // Cascaded prefetch: continue with next even on failure (with index for status tracking)
            this.onPrefetchComplete(articleId, articleIndex)
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
            // console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → ${direction}`)
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
     * 
     * Special rule: At list boundaries, force the logical direction:
     * - At start (index 0): can only go forward
     * - At end (index = length-1): can only go backward
     */
    private updateReadingDirection(newIndex: number, listLength: number): void {
        const oldIndex = this.currentArticleIndex
        const oldListLength = this.articleListLength
        
        // Detect list change: different list length suggests a new list
        const isNewList = listLength !== oldListLength
        
        // console.log(`[ContentViewPool] updateReadingDirection: newIndex=${newIndex}, listLength=${listLength}, oldIndex=${oldIndex}, oldListLength=${oldListLength}, isNewList=${isNewList}`)
        
        // First navigation, list change, or index not set yet
        if (oldIndex < 0 || isNewList) {
            // At boundaries, we know the direction
            if (newIndex === 0 && listLength > 1) {
                this.readingDirection = 'forward'
                // console.log(`[ContentViewPool] Reading direction: forward (at start of list)`)
            } else if (newIndex === listLength - 1 && listLength > 1) {
                this.readingDirection = 'backward'
                // console.log(`[ContentViewPool] Reading direction: backward (at end of list)`)
            } else {
                // Middle of list - unknown direction
                this.readingDirection = 'unknown'
                // console.log(`[ContentViewPool] Reading direction: unknown (middle of list, index ${newIndex} of ${listLength})`)
            }
            return
        }
        
        // BOUNDARY RULE: At list edges, force the only possible direction
        // This handles jumps to the end (e.g., clicking last article while at first)
        if (newIndex === 0 && listLength > 1) {
            // At start - can only go forward
            if (this.readingDirection !== 'forward') {
                // console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → forward (reached start of list)`)
                this.readingDirection = 'forward'
            }
            return
        }
        if (newIndex === listLength - 1 && listLength > 1) {
            // At end - can only go backward
            if (this.readingDirection !== 'backward') {
                // console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → backward (reached end of list)`)
                this.readingDirection = 'backward'
            }
            return
        }
        
        // Normal case: Determine direction from index change
        if (newIndex > oldIndex) {
            if (this.readingDirection !== 'forward') {
                // console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → forward (index ${oldIndex} → ${newIndex})`)
                this.readingDirection = 'forward'
            }
        } else if (newIndex < oldIndex) {
            if (this.readingDirection !== 'backward') {
                // console.log(`[ContentViewPool] Reading direction: ${this.readingDirection} → backward (index ${oldIndex} → ${newIndex})`)
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
        // console.log(`[ContentViewPool] schedulePrefetch() called, enabled=${this.config.enabled}`)
        if (!this.config.enabled) {
            // console.log(`[ContentViewPool] Prefetch disabled, skipping`)
            return
        }
        
        // Cancel any existing timer
        this.cancelPrefetch()
        
        // Wait for active view to be ready
        const activeView = this.getActiveView()
        if (!activeView) {
            // console.log(`[ContentViewPool] No active view, skipping prefetch`)
            return
        }
        
        // console.log(`[ContentViewPool] Active view ${activeView.id} isReady=${activeView.isReady}`)
        
        const doPrefetch = () => {
            // console.log(`[ContentViewPool] Starting prefetch timer (${this.config.prefetchDelay}ms)`)
            this.prefetchTimer = setTimeout(() => {
                // console.log(`[ContentViewPool] Prefetch timer fired, executing...`)
                this.prefetchTimer = null
                this.executePrefetch()
            }, this.config.prefetchDelay)
        }
        
        if (activeView.isReady) {
            // Already ready - schedule with delay
            // console.log(`[ContentViewPool] View already ready, scheduling prefetch`)
            doPrefetch()
        } else {
            // Wait for ready event
            // console.log(`[ContentViewPool] View not ready, waiting for dom-ready`)
            activeView.setOnDomReady(() => {
                // console.log(`[ContentViewPool] dom-ready received, scheduling prefetch`)
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
        
        // Cancel cascaded prefetch queue
        this.prefetchQueue = []
        this.prefetchInProgress = null
        
        // CRITICAL: Clear pending/protected article tracking!
        // Without this, articles from previous prefetch cycles stay "locked"
        // and prevent views from being used for new prefetches.
        this.pendingPrefetchArticleIds.clear()
        this.protectedArticleIds.clear()
        
        // Stop loading on non-active views to free them for new prefetches
        // This is necessary because we no longer recycle loading views,
        // so they would stay "stuck" loading old content forever.
        for (const view of this.views) {
            if (!view.isActive && view.isLoading) {
                const wc = view.getWebContents()
                if (wc && !wc.isDestroyed()) {
                    // console.log(`[ContentViewPool] Stopping load on ${view.id} (was loading ${view.articleId})`)
                    wc.stop()
                }
                // Recycle the view to make it available
                view.recycle()
            }
        }
    }
    
    /**
     * Invalidate cache when user switches to a different feed group/source
     * This recycles all non-active views to free memory and ensure
     * fresh prefetch for the new context
     */
    private invalidateCacheOnSourceChange(): void {
        let recycledCount = 0
        
        for (const view of this.views) {
            // Don't recycle the active view - it will be replaced by the new navigation
            if (view.isActive) continue
            
            // Recycle any view that has content
            if (!view.isEmpty) {
                // console.log(`[ContentViewPool] Recycling ${view.id} (was: ${view.articleId}) on source change`)
                view.recycle()
                recycledCount++
            }
        }
        
        // Clear protection sets - old prefetch targets are no longer relevant
        this.protectedArticleIds.clear()
        this.pendingPrefetchArticleIds.clear()
        
        // Reset reading direction - new context, unknown direction
        this.readingDirection = 'unknown'
        
        // console.log(`[ContentViewPool] Cache invalidated: ${recycledCount} views recycled`)
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
     * 
     * CASCADED MODE: Instead of requesting all targets in parallel, we queue them
     * and process one at a time. This prioritizes the most likely next article
     * and reduces network/CPU load.
     */
    private executePrefetch(): void {
        // console.log(`[ContentViewPool] executePrefetch() - index=${this.currentArticleIndex}, listLength=${this.articleListLength}, direction=${this.readingDirection}`)
        if (this.currentArticleIndex < 0) {
            // console.log(`[ContentViewPool] No current article index, skipping prefetch`)
            return
        }
        
        // Determine what to prefetch based on direction
        const targets = this.determinePrefetchTargets()
        
        // console.log(`[ContentViewPool] Prefetch targets:`, targets)
        
        // Track targets for status reporting
        this.prefetchTargets = [...targets]
        this.prefetchCompletedIndices.clear()
        
        // Debug: Log current view states before pre-population check
        // console.log(`[ContentViewPool] Views before pre-population:`, this.views.map(v => 
        //     `${v.id}: idx=${v.articleIndex}, hasLoadedOnce=${v.hasLoadedOnce}, isReady=${v.isReady}, articleId=${v.articleId?.substring(0, 8) || 'empty'}`
        // ))
        
        // Pre-populate completedIndices with targets that are ALREADY ready in the pool
        // This prevents the status from showing "red" when the next article is actually cached
        for (const targetIndex of targets) {
            if (this.isArticleIndexReady(targetIndex)) {
                this.prefetchCompletedIndices.add(targetIndex)
            }
        }
        
        // Update protected articles:
        // Only protect the ACTIVE article. The pending prefetch articleIds will be
        // protected dynamically as prefetch-info responses arrive.
        this.protectedArticleIds.clear()
        this.pendingPrefetchArticleIds.clear()  // Clear pending prefetch tracking
        
        // Protect the active article
        const activeView = this.getActiveView()
        if (activeView?.articleId) {
            this.protectedArticleIds.add(activeView.articleId)
        }
        
        // console.log(`[ContentViewPool] Protected articles:`, Array.from(this.protectedArticleIds))
        // console.log(`[ContentViewPool] Current views:`, this.views.map(v => 
        //     `${v.id}: ${v.articleId?.substring(0, 8) || 'empty'} (${v.status}${v.isActive ? ', ACTIVE' : ''})`
        // ).join(', '))
        
        // Filter out already-ready targets from the queue
        const targetsToFetch = targets.filter(idx => !this.prefetchCompletedIndices.has(idx))
        
        if (this.cascadedPrefetchEnabled) {
            // CASCADED MODE: Queue only targets that need fetching
            this.prefetchQueue = [...targetsToFetch]
            this.prefetchInProgress = null
            // console.log(`[ContentViewPool] Cascaded prefetch: ${this.prefetchCompletedIndices.size} already ready, queued ${targetsToFetch.length} targets: [${targetsToFetch.join(', ')}]`)
            
            // Send initial status (some may already be complete)
            this.sendPrefetchStatus()
            
            this.processNextPrefetch()
        } else {
            // PARALLEL MODE (original): Request only targets that need fetching
            // console.log(`[ContentViewPool] Requesting prefetch info for ${targetsToFetch.length} targets: [${targetsToFetch.join(', ')}]`)
            for (const targetIndex of targetsToFetch) {
                this.sendToRenderer('cvp-request-prefetch-info', targetIndex, this.currentMenuKey)
            }
            // Send initial status
            this.sendPrefetchStatus()
        }
    }
    
    /**
     * Process the next item in the prefetch queue (cascaded mode)
     */
    private processNextPrefetch(): void {
        if (!this.cascadedPrefetchEnabled) return
        
        // If something is already in progress, wait for it
        if (this.prefetchInProgress) {
            // console.log(`[ContentViewPool] Cascaded prefetch: waiting for ${this.prefetchInProgress.substring(0, 8)} to complete`)
            return
        }
        
        // Get next target from queue
        const nextTarget = this.prefetchQueue.shift()
        if (nextTarget === undefined) {
            // console.log(`[ContentViewPool] Cascaded prefetch: queue empty, prefetchInProgress=${this.prefetchInProgress}, sending final status`)
            // Send final status with queueLength = 0
            this.sendPrefetchStatus()
            return
        }
        
        // console.log(`[ContentViewPool] Cascaded prefetch: requesting index ${nextTarget} (${this.prefetchQueue.length} remaining)`)
        this.sendToRenderer('cvp-request-prefetch-info', nextTarget, this.currentMenuKey)
    }
    
    /**
     * Called when a prefetch completes (view becomes ready)
     * Triggers the next item in the cascade
     */
    onPrefetchComplete(articleId: string, articleIndex?: number): void {
        // Track completion by index
        if (articleIndex !== undefined && articleIndex >= 0) {
            this.prefetchCompletedIndices.add(articleIndex)
        }
        
        if (!this.cascadedPrefetchEnabled) {
            // Send updated status for non-cascaded mode
            this.sendPrefetchStatus()
            return
        }
        
        // ALWAYS clear prefetchInProgress and continue chain
        // Even if articleId doesn't match (edge case: early return for already-ready article)
        if (this.prefetchInProgress) {
            // const wasInProgress = this.prefetchInProgress
            // if (wasInProgress === articleId) {
            //     console.log(`[ContentViewPool] Cascaded prefetch: ${articleId.substring(0, 8)} complete`)
            // } else {
            //     console.log(`[ContentViewPool] Cascaded prefetch: completing ${articleId?.substring(0, 8)} (was expecting ${wasInProgress.substring(0, 8)})`)
            // }
            this.prefetchInProgress = null
        }
        
        // console.log(`[ContentViewPool] About to send status after completion, queue.length=${this.prefetchQueue.length}`)
        // Send status AFTER clearing prefetchInProgress so queueLength is correct
        this.sendPrefetchStatus()
        
        // console.log(`[ContentViewPool] Status sent, calling processNextPrefetch`)
        this.processNextPrefetch()
    }
    
    /**
     * Calculate and send prefetch status to renderer
     * Used for visual feedback (traffic light indicator)
     */
    private sendPrefetchStatus(): void {
        const direction = this.readingDirection
        const currentIndex = this.currentArticleIndex
        const totalTargets = this.prefetchTargets.length
        const completedCount = this.prefetchCompletedIndices.size
        
        // Determine "next" article based on direction
        let nextIndex = -1
        if (direction === 'forward' && currentIndex < this.articleListLength - 1) {
            nextIndex = currentIndex + 1
        } else if (direction === 'backward' && currentIndex > 0) {
            nextIndex = currentIndex - 1
        } else if (direction === 'unknown') {
            // Both directions possible - check both neighbors
            nextIndex = -1  // Special case: will check both
        }
        
        // Check if next article is ready
        let nextArticleReady = false
        if (direction === 'unknown') {
            // For unknown: both neighbors must be ready (if they exist)
            const forwardReady = currentIndex >= this.articleListLength - 1 || 
                this.isArticleIndexReady(currentIndex + 1)
            const backwardReady = currentIndex <= 0 || 
                this.isArticleIndexReady(currentIndex - 1)
            nextArticleReady = forwardReady && backwardReady
        } else if (nextIndex >= 0) {
            nextArticleReady = this.isArticleIndexReady(nextIndex)
        } else {
            // No next article (at list boundary)
            nextArticleReady = true
        }
        
        // Calculate queue length (remaining items)
        const queueLength = this.prefetchQueue.length + (this.prefetchInProgress ? 1 : 0)
        
        const status = {
            direction,
            nextArticleReady,
            nextIndex,
            queueLength,
            totalTargets,
            completedCount,
            loadingArticleId: this.prefetchInProgress,
            targets: this.prefetchTargets,
            completedIndices: Array.from(this.prefetchCompletedIndices)
        }
        
        // console.log(`[ContentViewPool] Sending prefetch status:`, status)
        this.sendToRenderer('cvp-prefetch-status', status)
        
        // Update render position for the "next" article
        this.updateRenderPosition()
    }
    
    /**
     * Update which view is at the "render position"
     * 
     * The render position has 1 pixel visible to force Chromium to render the content.
     * Only the "next" article in reading direction gets this position.
     * This ensures instant navigation when the user moves to the next article.
     */
    private updateRenderPosition(): void {
        if (!this.boundsReceived) return
        
        // Determine the "next" article index based on reading direction
        let nextIndex = -1
        if (this.readingDirection === 'forward' && this.currentArticleIndex < this.articleListLength - 1) {
            nextIndex = this.currentArticleIndex + 1
        } else if (this.readingDirection === 'backward' && this.currentArticleIndex > 0) {
            nextIndex = this.currentArticleIndex - 1
        } else if (this.readingDirection === 'unknown') {
            // For unknown direction, prefer forward
            if (this.currentArticleIndex < this.articleListLength - 1) {
                nextIndex = this.currentArticleIndex + 1
            } else if (this.currentArticleIndex > 0) {
                nextIndex = this.currentArticleIndex - 1
            }
        }
        
        if (nextIndex < 0) {
            // No next article - clear render position
            if (this.renderPositionViewId) {
                const oldView = this.getViewById(this.renderPositionViewId)
                if (oldView && oldView.isAtRenderPosition) {
                    oldView.moveOffScreen(this.visibleBounds)
                    console.log(`[ContentViewPool] Cleared render position from ${this.renderPositionViewId}`)
                }
                this.renderPositionViewId = null
                this.renderPositionPreviewActive = false
            }
            return
        }
        
        // Find view for the next article
        const nextView = this.views.find(v => v.articleIndex === nextIndex && v.hasLoadedOnce)
        if (!nextView) {
            // Next article not loaded yet - nothing to do
            return
        }
        
        // Already at render position?
        if (nextView.id === this.renderPositionViewId && nextView.isAtRenderPosition) {
            return
        }
        
        // Move old view from render position to offscreen
        if (this.renderPositionViewId && this.renderPositionViewId !== nextView.id) {
            const oldView = this.getViewById(this.renderPositionViewId)
            if (oldView && oldView.isAtRenderPosition && !oldView.isActive) {
                oldView.moveOffScreen(this.visibleBounds)
                console.log(`[ContentViewPool] Moved ${this.renderPositionViewId} from render position to offscreen`)
            }
            // Note: Keep renderPositionPreviewActive - will apply to new view
        }
        
        // Set new view to render position (if not active)
        if (!nextView.isActive) {
            // If preview mode is active, show fully visible instead of 1-pixel position
            if (this.renderPositionPreviewActive) {
                const webContentsView = nextView.getView()
                if (webContentsView) {
                    webContentsView.setBounds({
                        x: 0,
                        y: this.visibleBounds.y,
                        width: this.visibleBounds.width,
                        height: this.visibleBounds.height
                    })
                    webContentsView.setVisible(true)
                    console.log(`[ContentViewPool] Set ${nextView.id} (index ${nextIndex}) to PREVIEW position (full visibility)`)
                }
            } else {
                nextView.setRenderPosition(this.visibleBounds)
                console.log(`[ContentViewPool] Set ${nextView.id} (index ${nextIndex}) to render position`)
            }
            this.renderPositionViewId = nextView.id
            
            // Auto-expand Reddit gallery after initial render delay
            // content-preload.js handles retry logic for larger galleries
            setTimeout(() => {
                nextView.triggerAutoExpandRedditGallery()
            }, 400)
        }
    }

    /**
     * Toggle render-position view visibility for debugging (ö key)
     * When active, the render-position view is shown at full visibility (0,0)
     * When inactive, it returns to the normal 1-pixel-visible position
     */
    private lastToggleTime: number = 0  // Debounce for toggle
    private toggleRenderPositionPreview(): void {
        // Debounce: Ignore calls within 200ms of each other
        const now = Date.now()
        if (now - this.lastToggleTime < 200) {
            console.log(`[ContentViewPool] Toggle debounced (${now - this.lastToggleTime}ms since last)`)
            return
        }
        this.lastToggleTime = now
        
        if (!this.renderPositionViewId) {
            console.log('[ContentViewPool] No view at render position to preview')
            return
        }
        
        const view = this.getViewById(this.renderPositionViewId)
        if (!view) {
            console.log('[ContentViewPool] Render position view not found')
            return
        }
        
        this.renderPositionPreviewActive = !this.renderPositionPreviewActive
        
        const webContentsView = view.getView()
        if (!webContentsView) {
            console.log('[ContentViewPool] View has no WebContentsView')
            return
        }
        
        if (this.renderPositionPreviewActive) {
            // Show at full visibility (same bounds as active view)
            webContentsView.setBounds({
                x: 0,
                y: this.visibleBounds.y,
                width: this.visibleBounds.width,
                height: this.visibleBounds.height
            })
            console.log(`[ContentViewPool] PREVIEW ON: ${view.id} (articleId=${view.articleId?.substring(0, 8)}, index=${view.articleIndex})`)
        } else {
            // Return to normal render position (1 pixel visible)
            view.setRenderPosition(this.visibleBounds)
            console.log(`[ContentViewPool] PREVIEW OFF: ${view.id} returned to render position`)
        }
    }

    /**
     * Check if an article at given index is ready in the pool
     * Uses hasLoadedOnce instead of isReady to ignore temporary "loading" states
     * caused by ads/videos reloading content.
     */
    private isArticleIndexReady(index: number): boolean {
        // Find view by articleIndex - use hasLoadedOnce to ignore temporary loading states
        for (const view of this.views) {
            if (view.articleIndex === index) {
                // console.log(`[ContentViewPool] isArticleIndexReady(${index}): found view ${view.id}, hasLoadedOnce=${view.hasLoadedOnce}, isReady=${view.isReady}, articleId=${view.articleId?.substring(0,8)}`)
                if (view.hasLoadedOnce) {
                    return true
                }
            }
        }
        // Also check if it was completed in this prefetch cycle
        if (this.prefetchCompletedIndices.has(index)) {
            // console.log(`[ContentViewPool] isArticleIndexReady(${index}): in completedIndices`)
            return true
        }
        // console.log(`[ContentViewPool] isArticleIndexReady(${index}): NOT ready`)
        return false
    }
    
    /**
     * Determine which articles to prefetch based on reading direction.
     * With 5 views: 1 active + 3 in reading direction + 1 opposite direction.
     * Returns array of indices sorted by priority (most likely needed first).
     */
    private determinePrefetchTargets(): number[] {
        const { currentArticleIndex: index, articleListLength: length } = this
        const targets: number[] = []
        
        // Helper to add valid index
        const addIfValid = (i: number) => {
            if (i >= 0 && i < length && i !== index) {
                targets.push(i)
            }
        }
        
        switch (this.readingDirection) {
            case 'forward':
                // Primary direction: +1, +2, +3
                addIfValid(index + 1)
                addIfValid(index + 2)
                addIfValid(index + 3)
                // Opposite direction: -1 (for going back)
                addIfValid(index - 1)
                break
            
            case 'backward':
                // Primary direction: -1, -2, -3
                addIfValid(index - 1)
                addIfValid(index - 2)
                addIfValid(index - 3)
                // Opposite direction: +1 (for going forward)
                addIfValid(index + 1)
                break
            
            case 'unknown':
                // Balanced prefetch: +1, -1, +2, -2
                addIfValid(index + 1)
                addIfValid(index - 1)
                addIfValid(index + 2)
                addIfValid(index - 2)
                break
        }
        
        return targets
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
     * Find a free view for prefetching (not active, not protected)
     */
    private findFreeView(): CachedContentView | null {
        // Prefer empty views
        const empty = this.views.find(v => v.isEmpty && !v.isActive)
        if (empty) {
            console.log(`[ContentViewPool] findFreeView: Found empty view ${empty.id}`)
            return empty
        }
        
        // Can we create a new one?
        if (this.views.length < this.config.size) {
            const newView = new CachedContentView(`view-${this.views.length}`)
            this.views.push(newView)
            console.log(`[ContentViewPool] findFreeView: Created new view ${newView.id}`)
            return newView
        }
        
        // Find the oldest (LRU) view that's not:
        // - Active
        // - Loading (unless stale > 60s)
        // - Protected (in protectedArticleIds or pendingPrefetchArticleIds)
        // - Holding a ready article that's a prefetch target (preserve cached content!)
        // LRU ensures recently used views are kept
        const candidates = this.views.filter(v => {
            if (v.isActive) return false
            // Allow stale-loading views to be recycled
            if (v.isLoading && !v.isStaleLoading) return false
            if (v.articleId && this.protectedArticleIds.has(v.articleId)) return false
            if (v.articleId && this.pendingPrefetchArticleIds.has(v.articleId)) return false
            
            // Don't recycle views that hold ready content for current prefetch targets
            // This preserves already-cached articles when starting a new prefetch cycle
            if (v.hasLoadedOnce && v.articleIndex >= 0 && this.prefetchTargets.includes(v.articleIndex)) {
                // console.log(`[ContentViewPool] findFreeView: Skipping ${v.id} - holds target index ${v.articleIndex}`)
                return false
            }
            
            return true
        })
        
        if (candidates.length === 0) {
            console.log(`[ContentViewPool] findFreeView: No candidates! Views: ${this.views.map(v => `${v.id}:${v.status}${v.isActive?'[A]':''}${v.isLoading?'[L]':''}`).join(', ')}`)
            return null
        }
        
        // Sort by lastUsedAt (oldest first = best to recycle)
        candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
        
        console.log(`[ContentViewPool] findFreeView: Using LRU view ${candidates[0].id} (age=${((Date.now() - candidates[0].lastUsedAt) / 1000).toFixed(1)}s)`)
        return candidates[0]
    }
    
    /**
     * Find the best view to recycle based on reading direction
     * Prefers views that hold articles in the opposite direction of reading
     * NEVER recycles views holding protected articles (current prefetch targets)
     */
    private findRecyclableView(): CachedContentView | null {
        // Don't recycle active view or views with protected/pending articles
        const candidates = this.views.filter(v => {
            if (v.isActive) return false
            // NEVER recycle loading views - they will complete soon
            // Recycling them causes ERR_FAILED errors
            if (v.isLoading) {
                // console.log(`[ContentViewPool] Skipping ${v.id} (currently loading)`)
                return false
            }
            // Don't recycle if article is protected (needed as prefetch target)
            if (v.articleId && this.protectedArticleIds.has(v.articleId)) {
                // console.log(`[ContentViewPool] Skipping ${v.id} (protected article ${v.articleId})`)
                return false
            }
            // Don't recycle if article is pending prefetch
            if (v.articleId && this.pendingPrefetchArticleIds.has(v.articleId)) {
                // console.log(`[ContentViewPool] Skipping ${v.id} (pending prefetch article ${v.articleId})`)
                return false
            }
            // Don't recycle views that hold ready content for current prefetch targets
            // This preserves already-cached articles when starting a new prefetch cycle
            if (v.hasLoadedOnce && v.articleIndex >= 0 && this.prefetchTargets.includes(v.articleIndex)) {
                // console.log(`[ContentViewPool] Skipping ${v.id} - holds target index ${v.articleIndex}`)
                return false
            }
            return true
        })
        
        if (candidates.length === 0) return null
        
        // Score each candidate using LRU (Least Recently Used) strategy
        // Lower score = better candidate for recycling
        // Note: Loading views are already filtered out above
        const scored = candidates.map(view => {
            // Empty views are best to recycle
            if (view.isEmpty || !view.articleId) {
                return { view, score: -1000 }
            }
            
            // Views with errors should be recycled
            if (view.status === 'error') {
                return { view, score: -900 }
            }
            
            // Ready views - use LRU (age-based scoring)
            // Older views (larger ageMs) get lower scores = better to recycle
            
            // Use LRU: Older lastUsedAt = lower score = better to recycle
            // Invert the timestamp so older = lower score
            // Normalize to reasonable range (0-1000 based on age in seconds)
            const ageMs = Date.now() - view.lastUsedAt
            const ageScore = Math.min(ageMs / 1000, 1000)  // Cap at 1000 seconds
            
            // Lower score = recycle first
            // Older views have larger ageMs, so we negate to make them lower score
            return { view, score: -ageScore }
        })
        
        // Sort by score (lowest first = best to recycle)
        scored.sort((a, b) => a.score - b.score)
        
        // Log scoring for debugging
        // console.log(`[ContentViewPool] Recycle candidates (currentIdx=${this.currentArticleIndex}, dir=${this.readingDirection}):`,
        //     scored.map(s => {
        //         const age = s.view.lastUsedAt > 0 ? `${((Date.now() - s.view.lastUsedAt) / 1000).toFixed(1)}s` : 'never'
        //         return `${s.view.id}[idx=${s.view.articleIndex}, age=${age}]=>${s.score.toFixed(0)}`
        //     }).join(', '))
        
        return scored[0].view
    }
    
    /**
     * Activate a view (make it the visible one)
     */
    private activateView(view: CachedContentView): void {
        // Deactivate current - hide it (with current bounds so size is preserved)
        const current = this.getActiveView()
        const sameView = current === view
        
        if (current && !sameView) {
            current.setActive(false)
            current.setVisible(false, this.visibleBounds)  // Pass bounds to preserve size
        }
        
        // Activate new
        this.activeViewId = view.id
        view.setActive(true)
        
        // DEFENSIVE: Ensure ALL other views are offscreen (except render-position views)
        // This prevents "orphaned" views from race conditions when navigating
        for (const v of this.views) {
            if (v !== view && !v.isAtRenderPosition) {
                v.moveOffScreen(this.visibleBounds)
            }
        }
        
        // Apply bounds and show if pool is visible AND we have real bounds
        // IMPORTANT: Always ensure visibility is set, even for same view (it might have been hidden)
        if (this.isPoolVisible && this.boundsReceived) {
            view.setVisible(true, this.visibleBounds)
            view.bringToFront()  // Ensure active view is on top (covers render-position views)
            view.focus()  // Single focus call after visibility is set
            if (sameView) {
                // console.log(`[ContentViewPool] Re-activated same ${view.id} - ensuring visible with bounds:`, this.visibleBounds)
            } else {
                // console.log(`[ContentViewPool] Activated ${view.id} - visible with bounds:`, this.visibleBounds)
            }
        } else if (this.isPoolVisible) {
            // Pool is visible but no bounds yet - view will be shown when bounds arrive
            // console.log(`[ContentViewPool] Activated ${view.id} - waiting for bounds before showing`)
        }
        
        // Notify renderer about view activation with current zoom level
        // This ensures both viewId and zoom are always in sync in the UI
        this.sendToRenderer('content-view-zoom-changed', this.cssZoomLevel, view.feedId, view.id)
        
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
            // console.log(`[ContentViewPool] setBounds skipped (video fullscreen active):`, bounds)
            // Instead, ensure active view stays at full window bounds
            const activeView = this.getActiveView()
            if (activeView && this.parentWindow && !this.parentWindow.isDestroyed()) {
                const [width, height] = this.parentWindow.getContentSize()
                activeView.setBounds({ x: 0, y: 0, width, height })
            }
            return
        }
        
        // console.log(`[ContentViewPool] setBounds:`, bounds, `real=${isRealBounds}, boundsReceived=${this.boundsReceived}`)
        
        // Apply bounds to ALL views
        for (const view of this.views) {
            view.setBounds(bounds)
        }
        
        // If we have an active view that's waiting for real bounds, show it now
        const active = this.getActiveView()
        if (active && this.isPoolVisible && isRealBounds) {
            // DEFENSIVE: On first real bounds, ensure ALL non-active views are offscreen
            // This prevents "orphaned" views from remaining visible due to race conditions
            // (especially important for the very first view which might be in an inconsistent state)
            if (firstRealBounds) {
                // console.log(`[ContentViewPool] First real bounds received! Showing active view ${active.id} at:`, bounds)
                for (const view of this.views) {
                    if (view !== active && !view.isAtRenderPosition) {
                        view.moveOffScreen(bounds)
                    }
                }
            }
            active.setVisible(true, bounds)
            active.bringToFront()  // Cover render-position views
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
                // DEFENSIVE: Ensure ALL non-active views are offscreen
                // This prevents "orphaned" views from remaining visible due to race conditions
                for (const view of this.views) {
                    if (view !== active && !view.isAtRenderPosition) {
                        view.moveOffScreen(this.visibleBounds)
                    }
                }
                
                // Only show if we have real bounds, otherwise wait for setBounds
                if (this.boundsReceived) {
                    active.setVisible(true, this.visibleBounds)
                    active.bringToFront()  // Cover render-position views
                    active.focus()
                    // console.log(`[ContentViewPool] Showing ${active.id} at bounds:`, this.visibleBounds)
                    
                    // Restore render position for the "next" article
                    // This is important after the pool was hidden and re-shown
                    this.updateRenderPosition()
                } else {
                    // console.log(`[ContentViewPool] setVisible(true) - waiting for bounds before showing ${active.id}`)
                }
            } else {
                // CRITICAL: When hiding, move ALL views offscreen - not just active!
                // This prevents "orphaned" views when switching article lists:
                // - Prefetch views that were at render position
                // - Views that haven't been recycled yet
                // - Any view that might be onscreen due to race conditions
                for (const view of this.views) {
                    view.moveOffScreen(this.visibleBounds)
                    // Invalidate articleIndex - the next list will have different indices
                    view.invalidateArticleIndex()
                }
                // Also clear the render position tracking
                this.renderPositionViewId = null
                this.renderPositionPreviewActive = false
                // Reset reading direction for the next list
                this.readingDirection = 'unknown'
                // Cancel any pending prefetches - they're no longer relevant
                this.cancelPrefetch()
            }
        } else if (visible && !wasVisible) {
            // console.log(`[ContentViewPool] setVisible(true) - no active view yet`)
        } else if (!visible) {
            // No active view but hiding - still ensure ALL views are offscreen
            // This handles edge cases where views exist but none is marked active
            for (const view of this.views) {
                view.moveOffScreen(this.visibleBounds)
                // Invalidate articleIndex - the next list will have different indices
                view.invalidateArticleIndex()
            }
            this.renderPositionViewId = null
            this.renderPositionPreviewActive = false
            // Reset reading direction for the next list
            this.readingDirection = 'unknown'
            // Cancel any pending prefetches
            this.cancelPrefetch()
        }
    }
    
    // ========== IPC ==========
    
    /**
     * Setup IPC handlers for pool operations
     */
    private setupIpcHandlers(): void {
        // console.log('[ContentViewPool] Setting up IPC handlers...')
        
        // =====================================================
        // Pool-specific handlers (cvp-* prefix)
        // Note: Preload settings are now passed via additionalArguments
        // at WebContentsView creation time (no sync IPC needed)
        // =====================================================
        
        // Debug: Log messages from preload scripts
        ipcMain.on('cvp-preload-log', (event, message) => {
            // console.log(message)
        })
        
        // Navigate to article
        ipcMain.handle('cvp-navigate', async (event, articleId, url, feedId, settings, index, listLength, sourceId, menuKey) => {
            // console.log(`[ContentViewPool] IPC cvp-navigate received: articleId=${articleId}, index=${index}, source=${sourceId}, menuKey=${menuKey}`)
            return this.navigateToArticle(articleId, url, feedId, settings, index, listLength, sourceId, menuKey)
        })
        
        // Prefetch article
        ipcMain.on('cvp-prefetch', (event, articleId, url, feedId, settings) => {
            // Reject prefetch requests after nuke until first navigation
            if (this.awaitingFirstNavigationAfterNuke) {
                // console.log(`[ContentViewPool] BLOCKED prefetch for ${articleId} - awaiting first navigation after nuke`)
                return
            }
            // console.log(`[ContentViewPool] IPC cvp-prefetch received: articleId=${articleId}`)
            this.prefetch(articleId, url, feedId, settings)
        })
        
        // Prefetch info response from renderer (extended with articleInfo for FullContent)
        ipcMain.on('cvp-prefetch-info', (event, articleIndex, articleId, url, feedId, settings, articleInfo, menuKey) => {
            // Reject prefetch requests after nuke until first navigation
            if (this.awaitingFirstNavigationAfterNuke) {
                // console.log(`[ContentViewPool] BLOCKED prefetch-info for ${articleId} - awaiting first navigation after nuke`)
                return
            }
            
            // CRITICAL: Validate menuKey - reject stale prefetch responses from previous list
            if (menuKey && this.currentMenuKey && menuKey !== this.currentMenuKey) {
                // console.log(`[ContentViewPool] REJECTED stale prefetch-info: menuKey=${menuKey} != current=${this.currentMenuKey}, articleId=${articleId}`)
                // Continue with next prefetch if in cascaded mode
                if (this.cascadedPrefetchEnabled && this.prefetchInProgress === articleId) {
                    this.prefetchInProgress = null
                    this.processNextPrefetch()
                }
                return
            }
            
            // console.log(`[ContentViewPool] IPC cvp-prefetch-info received: index=${articleIndex}, articleId=${articleId}, menuKey=${menuKey}`)
            
            // CRITICAL: Add articleId to pending set BEFORE calling prefetch()
            // This prevents a race condition where one prefetch recycles a view
            // that another concurrent prefetch needs
            if (articleId) {
                this.pendingPrefetchArticleIds.add(articleId)
                // console.log(`[ContentViewPool] Added ${articleId} to pending prefetch set:`, Array.from(this.pendingPrefetchArticleIds))
                
                // Cascaded prefetch: mark this article as in-progress
                if (this.cascadedPrefetchEnabled) {
                    this.prefetchInProgress = articleId
                }
            }
            
            if (articleId && articleInfo?.openTarget === PrefetchOpenTarget.FullContent) {
                // FullContent mode: fetch and extract in background
                // console.log(`[ContentViewPool] Starting FullContent prefetch for ${articleId} at index ${articleIndex}`)
                this.prefetchFullContent(articleId, feedId, settings, articleInfo, articleIndex)
            } else if (articleId && url) {
                // Webpage or RSS mode: use URL directly
                this.prefetch(articleId, url, feedId, settings, articleIndex)
            } else {
                // console.log(`[ContentViewPool] Prefetch info incomplete, skipping`)
                // Cascaded prefetch: if no valid prefetch, continue with next
                if (this.cascadedPrefetchEnabled && this.prefetchInProgress === articleId) {
                    this.prefetchInProgress = null
                    this.processNextPrefetch()
                }
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
        
        // Relative zoom: increment by step (positive = zoom in, negative = zoom out)
        ipcMain.on("cvp-zoom-step", (event, step: number) => {
            this.zoomStep(step)
        })
        
        // Reset zoom to 100% (level 0)
        ipcMain.on("cvp-zoom-reset", () => {
            this.zoomReset()
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
            // Special handling for input mode - update pool's tracking
            if (channel === 'set-input-mode') {
                this.inputModeActive = !!args[0]
                // console.log(`[ContentViewPool] Input mode: ${this.inputModeActive ? 'ACTIVE' : 'inactive'}`)
            }
            
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
        
        // Toggle render-position preview (ö key debug feature)
        // Remove any existing listener first to prevent duplicates
        ipcMain.removeAllListeners("cvp-toggle-render-preview")
        ipcMain.on("cvp-toggle-render-preview", (event) => {
            // Log sender info to debug duplicates
            const senderId = event.sender?.id
            const senderUrl = event.sender?.getURL?.() || 'unknown'
            console.log(`[ContentViewPool] IPC cvp-toggle-render-preview received from webContents ${senderId} (${senderUrl.substring(0, 50)})`)
            this.toggleRenderPositionPreview()
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
        
        // List changed - NUKE the entire pool and rebuild fresh
        ipcMain.on("cvp-on-list-changed", () => {
            this.nukePool()
        })
        
        // Feed refreshed - invalidate article indices but keep cached views
        ipcMain.on("cvp-on-feed-refreshed", () => {
            this.invalidateArticleIndices()
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
        
        // Sync channel for settings.ts (bridges/settings.ts uses this)
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
        
        // Invalidate prefetched views for a specific feed when settings change
        ipcMain.on("cvp-invalidate-prefetch-for-feed", (event, feedId: string | null, settingName?: string) => {
            this.invalidatePrefetchForFeed(feedId, settingName)
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
                this.cssZoomLevel = this.roundZoom((clampedZoom - 1.0) / 0.1)
                
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
        
        // Capture screen of a prefetched view by article ID (for preview tooltip)
        // Views at render position (1-pixel visible) will render and capture directly.
        // Other prefetched views need temporary visibility as fallback.
        ipcMain.handle("cvp-capture-prefetched", async (_event, articleId: string) => {
            // Debug: Log all views and their articleIds
            console.log(`[ContentViewPool] cvp-capture-prefetched: Looking for articleId=${articleId}`)
            console.log(`[ContentViewPool] cvp-capture-prefetched: Available views:`)
            for (const v of this.views) {
                console.log(`  - ${v.id}: articleId=${v.articleId || 'null'}, isActive=${v.isActive}, hasLoadedOnce=${v.hasLoadedOnce}, atRenderPos=${v.isAtRenderPosition}`)
            }
            
            const view = this.getViewByArticleId(articleId)
            if (!view) {
                console.log(`[ContentViewPool] cvp-capture-prefetched: No view found for article ${articleId}`)
                return null
            }
            
            const wc = view.getWebContents()
            if (!wc || wc.isDestroyed()) {
                console.log(`[ContentViewPool] cvp-capture-prefetched: WebContents not available for ${articleId}`)
                return null
            }
            
            // Check if the view is still loading
            if (wc.isLoading()) {
                console.log(`[ContentViewPool] cvp-capture-prefetched: View still loading for ${articleId}`)
                return { loading: true, screenshot: null }
            }
            
            try {
                // First attempt: Direct capture (works for render-position views with 1-pixel visibility)
                let image = await wc.capturePage()
                let dataUrl = image.toDataURL()
                
                // Check if we got a valid image (not empty)
                // An empty PNG is about 200-300 bytes, a real screenshot is much larger
                if (dataUrl.length < 500) {
                    const isRenderPos = view.isAtRenderPosition
                    console.log(`[ContentViewPool] cvp-capture-prefetched: Direct capture returned empty (isRenderPos=${isRenderPos}), trying temporary visibility`)
                    
                    // Fallback: Temporarily make visible for rendering
                    if (this.boundsReceived) {
                        view.setVisible(true, this.visibleBounds)
                        await new Promise(resolve => setTimeout(resolve, 100))
                        
                        image = await wc.capturePage()
                        dataUrl = image.toDataURL()
                        
                        // Hide and ensure active view is on top
                        view.setVisible(false, this.visibleBounds)
                        const activeView = this.getActiveView()
                        if (activeView) {
                            activeView.bringToFront()
                        }
                        console.log(`[ContentViewPool] cvp-capture-prefetched: After temp visibility, size=${dataUrl.length} bytes`)
                    }
                }
                
                console.log(`[ContentViewPool] cvp-capture-prefetched: Screenshot captured, size=${dataUrl.length} bytes`)
                return { loading: false, screenshot: dataUrl }
            } catch (error) {
                console.error(`[ContentViewPool] cvp-capture-prefetched: Failed to capture ${articleId}:`, error)
                return null
            }
        })
        
        // Recreate active view (for visual zoom toggle)
        ipcMain.handle("cvp-recreate", async () => {
            const active = this.getActiveView()
            if (active) {
                const articleId = active.articleId
                const articleIndex = active.articleIndex
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
                    }, isMobileUserAgentEnabled(), articleIndex)
                    return true
                }
            }
            return false
        })
        
        // Nuke active view (for mode switch: RSS <-> Browser)
        // Recycles the view without reloading - caller should navigate after nuke
        ipcMain.handle("cvp-nuke", async () => {
            // console.log("[ContentViewPool] cvp-nuke: Nuking active view for mode switch")
            const active = this.getActiveView()
            if (active) {
                // Recycle (destroys and recreates the WebContentsView)
                active.recycle()
                this.createViewWithEvents(active)
                
                // Mark as active again and restore visibility with current bounds
                active.setActive(true)
                if (this.isPoolVisible && this.boundsReceived) {
                    active.setVisible(true, this.visibleBounds)
                    active.bringToFront()  // Cover render-position views
                }
                
                // console.log("[ContentViewPool] cvp-nuke: View recycled, ready for new navigation")
                return true
            }
            // console.log("[ContentViewPool] cvp-nuke: No active view to nuke")
            return false
        })
        
        // Get cookies from active view's session (for cookie persistence)
        ipcMain.handle("cvp-get-cookies-for-host", async (event, host: string) => {
            const active = this.getActiveView()
            const wc = active?.getWebContents()
            if (!wc || wc.isDestroyed()) {
                // console.log("[ContentViewPool] cvp-get-cookies-for-host: No active view")
                return []
            }
            
            const ses = wc.session
            // console.log(`[ContentViewPool] Getting cookies for host: ${host} from session: ${ses.storagePath}`)
            
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
                    // console.log(`[ContentViewPool] URL cookies: ${urlCookies.length}`)
                } catch (e) { /* ignore */ }
                
                // 2. Exact domain
                try {
                    const exactCookies = await ses.cookies.get({ domain: host })
                    exactCookies.forEach(addCookie)
                    // console.log(`[ContentViewPool] Exact domain cookies: ${exactCookies.length}`)
                } catch (e) { /* ignore */ }
                
                // 3. .domain
                try {
                    const dotCookies = await ses.cookies.get({ domain: "." + baseDomain })
                    dotCookies.forEach(addCookie)
                    // console.log(`[ContentViewPool] Dot domain cookies: ${dotCookies.length}`)
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
                    // console.log(`[ContentViewPool] Total cookies in session: ${allSessionCookies.length}`)
                    allSessionCookies.filter(c =>
                        c.domain === host ||
                        c.domain === "." + baseDomain ||
                        c.domain === "." + host ||
                        c.domain === baseDomain
                    ).forEach(addCookie)
                } catch (e) { /* ignore */ }
                
                // console.log(`[ContentViewPool] Found ${allCookies.length} cookies for ${host}`)
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
                // console.log(`[ContentViewPool] All cookies: ${cookies.length}`)
                // cookies.forEach(c => {
                //     console.log(`  - ${c.name} @ ${c.domain}`)
                // })
                return cookies
            } catch (e) {
                console.error("[ContentViewPool] Error getting all cookies:", e)
                return []
            }
        })
        
        // Debug log from renderer
        ipcMain.on("cvp-debug-log", (_event, message: string) => {
            // console.log(`[Renderer DEBUG] ${message}`)
        })
    }
    
    // ========== Zoom Methods ==========
    
    /**
     * Set zoom factor for +/- shortcuts
     */
    private setZoomFactor(factor: number): void {
        // Block new zoom requests during sync or if waiting for view confirmation
        if (this.isSyncingZoom) {
            // console.log(`[ContentViewPool] setZoomFactor: blocked during sync`)
            return
        }
        if (this.isZoomPending) {
            // console.log(`[ContentViewPool] setZoomFactor: blocked - waiting for view confirmation`)
            return
        }
        
        const clampedFactor = Math.max(0.25, Math.min(5.0, factor))
        this.cssZoomLevel = this.roundZoom((clampedFactor - 1.0) / 0.1)
        
        // console.log(`[ContentViewPool] setZoomFactor: factor=${factor.toFixed(2)}, level=${this.cssZoomLevel.toFixed(1)}, activeId=${this.activeViewId}`)
        
        const active = this.getActiveView()
        if (active) {
            // Set pending flag - will be cleared when view confirms
            this.isZoomPending = true
            // Safety timeout in case view doesn't respond (100ms)
            this.zoomPendingTimeout = setTimeout(() => {
                // console.log(`[ContentViewPool] setZoomFactor: safety timeout - clearing pending`)
                this.isZoomPending = false
            }, 100)
            
            // console.log(`[ContentViewPool] setZoomFactor: applying to active view ${active.id}`)
            if (this.visualZoomEnabled) {
                active.setVisualZoomLevel(this.cssZoomLevel)
            } else {
                active.setCssZoom(this.cssZoomLevel)
            }
            
            // Send zoom update to renderer with feedId and viewId for correct Redux persistence
            // Don't round - preserve fine zoom steps (0.1 = 1%)
            const feedId = active.feedId
            const viewId = active.id
            // console.log(`[ContentViewPool] Sending zoom update to renderer: zoom=${this.cssZoomLevel}, feedId=${feedId}, viewId=${viewId}`)
            this.sendToRenderer("content-view-zoom-changed", this.cssZoomLevel, feedId, viewId)
        }
        
        // Sync to views of the same feed (zoom is feed-specific)
        this.syncZoomToSameFeedViews()
    }
    
    /**
     * Set CSS zoom level directly
     */
    private setCssZoom(level: number): void {
        // Block new zoom requests during sync or if waiting for view confirmation
        if (this.isSyncingZoom) {
            // console.log(`[ContentViewPool] setCssZoom: blocked during sync`)
            return
        }
        if (this.isZoomPending) {
            // console.log(`[ContentViewPool] setCssZoom: blocked - waiting for view confirmation`)
            return
        }
        
        const clampedLevel = Math.max(-6, Math.min(40, level))
        this.cssZoomLevel = this.roundZoom(clampedLevel)
        
        // console.log(`[ContentViewPool] setCssZoom(${level}) -> rounded to ${this.cssZoomLevel}, visualZoomEnabled=${this.visualZoomEnabled}`)

        const active = this.getActiveView()
        if (active) {
            // Set pending flag - will be cleared when view confirms
            this.isZoomPending = true
            // Safety timeout in case view doesn't respond (100ms)
            this.zoomPendingTimeout = setTimeout(() => {
                // console.log(`[ContentViewPool] setCssZoom: safety timeout - clearing pending`)
                this.isZoomPending = false
            }, 100)
            
            // Use the correct zoom method based on visual zoom mode
            if (this.visualZoomEnabled) {
                // console.log(`[ContentViewPool] setCssZoom: Visual Zoom enabled, calling setVisualZoomLevel`)
                active.setVisualZoomLevel(this.cssZoomLevel)
            } else {
                // console.log(`[ContentViewPool] setCssZoom: CSS Zoom, calling setCssZoom on active view ${active.id}`)
                active.setCssZoom(this.cssZoomLevel)
            }
            
            // Send zoom update to renderer with feedId and viewId for correct Redux persistence
            const feedId = active.feedId
            const viewId = active.id
            // console.log(`[ContentViewPool] Sending zoom update to renderer: zoom=${this.cssZoomLevel}, feedId=${feedId}, viewId=${viewId}`)
            this.sendToRenderer("content-view-zoom-changed", this.cssZoomLevel, feedId, viewId)
        } else {
            // console.log(`[ContentViewPool] setCssZoom: no active view!`)
        }
        
        // Sync to views of the same feed (zoom is feed-specific)
        this.syncZoomToSameFeedViews()
    }
    
    /**
     * Relative zoom: increment/decrement current zoom level by step.
     * This is the preferred method for keyboard zoom (+/-) as it uses the Pool's
     * authoritative cssZoomLevel rather than relying on out-of-sync values from article.tsx.
     * @param step Zoom step (positive = zoom in, negative = zoom out). Typically 1.0 for 10% or 0.1 for 1%.
     */
    private zoomStep(step: number): void {
        // Block new zoom requests during sync or if waiting for view confirmation
        if (this.isSyncingZoom || this.isZoomPending) {
            return
        }
        
        // Apply step to current level
        const newLevel = this.cssZoomLevel + step
        const clampedLevel = Math.max(-6, Math.min(40, newLevel))
        this.cssZoomLevel = this.roundZoom(clampedLevel)
        
        // console.log(`[ContentViewPool] zoomStep(${step}) -> new level: ${this.cssZoomLevel}`)
        
        const active = this.getActiveView()
        if (active) {
            // Set pending flag - will be cleared when view confirms
            this.isZoomPending = true
            this.zoomPendingTimeout = setTimeout(() => {
                this.isZoomPending = false
            }, 100)
            
            // Apply to active view
            if (this.visualZoomEnabled) {
                active.setVisualZoomLevel(this.cssZoomLevel)
            } else {
                active.setCssZoom(this.cssZoomLevel)
            }
            
            // Send zoom update to renderer for Redux persistence
            const feedId = active.feedId
            const viewId = active.id
            this.sendToRenderer("content-view-zoom-changed", this.cssZoomLevel, feedId, viewId)
        }
        
        // Sync to views of the same feed
        this.syncZoomToSameFeedViews()
    }
    
    /**
     * Reset zoom to 100% (level 0).
     */
    private zoomReset(): void {
        // Block new zoom requests during sync or if waiting for view confirmation
        if (this.isSyncingZoom || this.isZoomPending) {
            return
        }
        
        this.cssZoomLevel = 0
        
        // console.log(`[ContentViewPool] zoomReset() -> level: 0`)
        
        const active = this.getActiveView()
        if (active) {
            // Set pending flag - will be cleared when view confirms
            this.isZoomPending = true
            this.zoomPendingTimeout = setTimeout(() => {
                this.isZoomPending = false
            }, 100)
            
            // Apply to active view
            if (this.visualZoomEnabled) {
                active.setVisualZoomLevel(0)
            } else {
                active.setCssZoom(0)
            }
            
            // Send zoom update to renderer for Redux persistence
            const feedId = active.feedId
            const viewId = active.id
            this.sendToRenderer("content-view-zoom-changed", 0, feedId, viewId)
        }
        
        // Sync to views of the same feed
        this.syncZoomToSameFeedViews()
    }
    
    /**
     * Handle zoom request from preload (mouse wheel, pinch zoom)
     * The preload has already applied the zoom locally for immediate feedback.
     * We update our state and send the canonical event to renderer for Redux persistence.
     * This is a PUBLIC method called from window.ts IPC handler.
     */
    handleZoomRequest(zoomLevel: number): void {
        // Block new zoom requests during sync or if waiting for view confirmation
        if (this.isSyncingZoom) {
            // console.log(`[ContentViewPool] handleZoomRequest: blocked during sync`)
            return
        }
        if (this.isZoomPending) {
            // console.log(`[ContentViewPool] handleZoomRequest: blocked - waiting for view confirmation`)
            return
        }
        
        const clampedLevel = Math.max(-6, Math.min(40, zoomLevel))
        this.cssZoomLevel = this.roundZoom(clampedLevel)
        
        // console.log(`[ContentViewPool] handleZoomRequest(${zoomLevel}) -> rounded to ${this.cssZoomLevel}`)
        
        // Note: For handleZoomRequest, the preload has already applied zoom locally,
        // so we don't need to wait for confirmation - just update state and notify renderer
        const active = this.getActiveView()
        if (active) {
            const feedId = active.feedId
            const viewId = active.id
            // console.log(`[ContentViewPool] handleZoomRequest: sending zoom update to renderer: zoom=${this.cssZoomLevel}, feedId=${feedId}, viewId=${viewId}`)
            this.sendToRenderer("content-view-zoom-changed", this.cssZoomLevel, feedId, viewId)
        }
        
        // Sync to other views of the same feed
        this.syncZoomToSameFeedViews()
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
        
        // console.log(`[ContentViewPool] setMobileMode(${enabled})`)
        
        // Update all views
        for (const view of this.views) {
            view.setMobileMode(enabled)
        }
    }
    
    /**
     * Invalidate prefetched views for a specific feed when settings change.
     * This recycles all non-active views for the given feedId and triggers re-prefetch.
     * 
     * Used when feed-specific settings change that require a full reload:
     * - mobileMode (changes User-Agent, server returns different HTML)
     * - openTarget (RSS/Local/Webpage/FullContent - completely different load paths)
     * - visualZoom (changes Device Emulation)
     * 
     * NOT needed for zoom changes (can be applied dynamically).
     * 
     * @param feedId - The feed ID whose views should be invalidated, or null for all feeds
     * @param settingName - Optional name of the setting that changed (for logging)
     */
    private invalidatePrefetchForFeed(feedId: string | null, settingName?: string): void {
        console.log(`[ContentViewPool] invalidatePrefetchForFeed: feedId=${feedId}, setting=${settingName || 'unknown'}`)
        
        let recycledCount = 0
        const activeView = this.getActiveView()
        
        for (const view of this.views) {
            // Never recycle the active view
            if (view.isActive) continue
            
            // Skip empty views
            if (view.isEmpty) continue
            
            // If feedId is null, invalidate ALL non-active views
            // If feedId is specified, only invalidate views with matching feedId
            if (feedId === null || view.feedId === feedId) {
                console.log(`[ContentViewPool] Recycling prefetched view ${view.id} (feedId=${view.feedId}, articleId=${view.articleId?.substring(0, 8)})`)
                view.recycle()
                recycledCount++
            }
        }
        
        // Clear protection sets - old prefetch targets are no longer valid
        this.protectedArticleIds.clear()
        this.pendingPrefetchArticleIds.clear()
        
        // Clear prefetch tracking for re-prefetch
        this.prefetchQueue = []
        this.prefetchInProgress = null
        this.prefetchCompletedIndices.clear()
        
        console.log(`[ContentViewPool] invalidatePrefetchForFeed: recycled ${recycledCount} views, scheduling re-prefetch`)
        
        // Schedule re-prefetch with the new settings
        if (recycledCount > 0 && this.currentArticleIndex >= 0) {
            this.schedulePrefetch()
        }
        
        // Send updated status (will show red/yellow until re-prefetch completes)
        this.sendPrefetchStatus()
    }
    
    /**
     * Sync zoom level to views of the same feed in pool
     * 
     * The zoom level is feed-specific (stored in source.defaultZoom),
     * so we only sync to views that have the same feedId as the active view.
     */
    private syncZoomToSameFeedViews(): void {
        // Set flag to block new zoom requests during sync
        this.isSyncingZoom = true
        
        try {
            // Use stored activeViewId instead of getActiveView() to avoid reference comparison issues
            const activeViewId = this.activeViewId
            const activeView = this.getActiveView()
            const activeFeedId = activeView?.feedId
            
            if (!activeFeedId) {
                // console.log('[ContentViewPool] syncZoomToSameFeedViews: no active feed, skipping')
                return
            }
            
            // console.log(`[ContentViewPool] syncZoomToSameFeedViews: active=${activeViewId}, feed=${activeFeedId}, zoomLevel=${this.cssZoomLevel}`)
            
            for (const view of this.views) {
                // Use ID comparison (more robust than object reference comparison)
                // Skip the active view - it was already updated in setZoomFactor/setCssZoom
                if (view.id !== activeViewId && view.feedId === activeFeedId) {
                    // console.log(`[ContentViewPool] syncZoomToSameFeedViews: syncing ${view.id} (same feed: ${activeFeedId})`)
                    if (this.visualZoomEnabled) {
                        view.setVisualZoomLevel(this.cssZoomLevel)
                    } else {
                        view.setCssZoom(this.cssZoomLevel)
                    }
                }
            }
        } finally {
            // Always clear flag, even if error occurs
            this.isSyncingZoom = false
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
     * NUKE the entire pool - destroy ALL views and reset all state.
     * Called when the article list changes to ensure no stale content remains.
     * The pool will be rebuilt fresh on the next navigation.
     */
    nukePool(): void {
        // INCREMENT GENERATION FIRST - this invalidates all pending prefetch requests
        this.poolGeneration++
        this.awaitingFirstNavigationAfterNuke = true  // Block prefetches until navigation
        // console.log(`[ContentViewPool] ========== NUKING POOL (Generation ${this.poolGeneration}) ==========`)
        // console.log(`[ContentViewPool] Views to destroy: ${this.views.length}`)
        
        // Cancel any pending operations FIRST
        this.cancelPrefetch()
        if (this.prefetchTimer) {
            clearTimeout(this.prefetchTimer)
            this.prefetchTimer = null
        }
        
        // Destroy ALL views completely
        for (const view of this.views) {
            const viewId = view.id
            const wcId = view.view?.webContents?.id
            // console.log(`[ContentViewPool] Destroying ${viewId} (wcId=${wcId})`)
            view.destroy()
        }
        
        // Clear all collections
        this.views = []
        this.viewsByWebContentsId.clear()
        this.activeViewId = null
        
        // Reset ALL state to initial values
        this.readingDirection = 'unknown'
        this.currentArticleIndex = -1
        this.articleListLength = 0
        this.currentSourceId = null
        this.currentMenuKey = null  // Clear list identity on nuke
        this.renderPositionViewId = null
        this.renderPositionPreviewActive = false
        this.protectedArticleIds.clear()
        this.pendingPrefetchArticleIds.clear()
        this.prefetchTargets = []
        this.prefetchCompletedIndices.clear()
        this.prefetchQueue = []
        this.prefetchInProgress = null
        this.pendingPrefetch = []
        this.cssZoomLevel = 0
        this.isSyncingZoom = false
        this.isZoomPending = false
        if (this.zoomPendingTimeout) {
            clearTimeout(this.zoomPendingTimeout)
            this.zoomPendingTimeout = null
        }
        this.inputModeActive = false
        this.contentViewHadFocus = false
        
        // console.log(`[ContentViewPool] Pool completely reset - 0 views, all state cleared`)
        // console.log(`[ContentViewPool] ================================`)
    }
    
    /**
     * Invalidate all articleIndex values in the pool without destroying views.
     * Called after feed refresh when the article list order may have changed.
     * Views keep their loaded content but their position references become invalid.
     */
    invalidateArticleIndices(): void {
        console.log(`[ContentViewPool] Invalidating articleIndices for ${this.views.length} views`)
        
        // Invalidate articleIndex on all views EXCEPT the active one
        // The active view keeps its index for navigation continuity
        // Note: After refresh, the active article's position may have shifted
        // but that's handled by the next providePrefetchInfo call from React
        const activeView = this.getActiveView()
        for (const view of this.views) {
            if (view.id !== activeView?.id) {
                view.invalidateArticleIndex()
            }
        }
        
        // Reset render position - the index-based view there is no longer valid
        if (this.renderPositionViewId) {
            const renderView = this.getViewById(this.renderPositionViewId)
            if (renderView && !renderView.isActive) {
                renderView.moveOffScreen(this.visibleBounds)
                console.log(`[ContentViewPool] Moved ${this.renderPositionViewId} from render position to offscreen (indices invalidated)`)
            }
            this.renderPositionViewId = null
            this.renderPositionPreviewActive = false
        }
        
        // Clear prefetch state since indices are no longer valid
        this.prefetchTargets = []
        this.prefetchCompletedIndices.clear()
        this.prefetchQueue = []
        this.pendingPrefetch = []
        
        // Keep currentArticleIndex - it matches the active view which wasn't invalidated
        // The next prefetchInfo from React will update our understanding of the list
        // Reset reading direction to re-detect on next navigation
        this.readingDirection = 'unknown'
        
        console.log(`[ContentViewPool] ArticleIndex invalidation complete - active view preserved at index ${this.currentArticleIndex}`)
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
        
        // console.log("[ContentViewPool] Destroyed")
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
