/**
 * Content View Pool Bridge - IPC communication for cached article views
 * 
 * This bridge provides a React-friendly API for the ContentViewPool,
 * which manages multiple WebContentsViews for article prefetching.
 */
import { ipcRenderer } from "electron"

export interface ContentViewBounds {
    x: number
    y: number
    width: number
    height: number
}

/**
 * Navigation settings for bundled navigation call
 */
export interface NavigationSettings {
    zoomFactor: number       // Zoom factor (0.7 = 70%, 1.0 = 100%, etc.)
    visualZoom: boolean      // Whether Visual Zoom (Device Emulation) is enabled
    mobileMode: boolean      // Whether Mobile Mode is enabled
    showZoomOverlay: boolean // Whether to show zoom overlay
}

/**
 * Source open target modes (must match SourceOpenTarget enum)
 */
export enum PrefetchOpenTarget {
    Local = 0,       // RSS/Local content
    Webpage = 1,     // Load webpage directly
    External = 2,    // Open in external browser
    FullContent = 3  // Extract and show full content
}

/**
 * Text direction for article rendering
 */
export enum PrefetchTextDirection {
    LTR = 0,
    RTL = 1,
    Vertical = 2
}

/**
 * Extended prefetch info for all content modes
 */
export interface PrefetchArticleInfo {
    articleId: string
    itemLink: string           // URL of the article (for fetching)
    itemContent: string        // RSS content (for Local mode)
    itemTitle: string          // Article title
    itemDate: number           // Article date (timestamp)
    openTarget: PrefetchOpenTarget
    textDir: PrefetchTextDirection
    fontSize: number
    fontFamily: string
    locale: string
}

/**
 * Reading direction for prefetch prioritization
 */
export type ReadingDirection = 'forward' | 'backward' | 'unknown'

/**
 * Pool status information
 */
export interface PoolStatus {
    poolSize: number
    configSize: number
    activeViewId: string | null
    readingDirection: ReadingDirection
    currentIndex: number
    listLength: number
    views: Array<{
        id: string
        articleId: string | null
        status: string
        isActive: boolean
        webContentsId: number | null
    }>
}

/**
 * ContentViewPool Bridge
 * 
 * Usage:
 * - navigateToArticle: Navigate to an article (instant if cached)
 * - requestPrefetch: Manually request prefetch for an article
 * - setReadingDirection: Inform pool about reading direction
 */
export const contentViewPoolBridge = {
    /**
     * Navigate to an article
     * Returns immediately if article is cached (instant swap)
     * 
     * @param articleId - Unique article identifier
     * @param url - URL to load
     * @param feedId - Feed ID (for context)
     * @param settings - Navigation settings (zoom, etc.)
     * @param articleIndex - Current article index in list
     * @param listLength - Total articles in list
     */
    navigateToArticle: (
        articleId: string,
        url: string,
        feedId: string | null,
        settings: NavigationSettings,
        articleIndex: number,
        listLength: number
    ): Promise<boolean> => {
        console.log(`[ContentViewPool Bridge] navigateToArticle: ${articleId}, index=${articleIndex}`)
        return ipcRenderer.invoke(
            "cvp-navigate",
            articleId,
            url,
            feedId,
            settings,
            articleIndex,
            listLength
        )
    },
    
    /**
     * Navigate with settings (direct URL navigation without prefetch/cache)
     * Used for HTML content (RSS articles) where caching doesn't apply
     */
    navigateWithSettings: (url: string, settings: NavigationSettings): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-navigate-with-settings", url, settings)
    },
    
    /**
     * Request prefetch for an article
     * Used by renderer to provide prefetch info when requested
     */
    requestPrefetch: (
        articleId: string,
        url: string,
        feedId: string | null,
        settings: NavigationSettings
    ): void => {
        ipcRenderer.send("cvp-prefetch", articleId, url, feedId, settings)
    },
    
    /**
     * Provide prefetch info for a specific article index
     * Called in response to 'cvp-request-prefetch-info' event
     * 
     * For Webpage mode: url is the webpage URL
     * For RSS/Local mode: url is the data URL with rendered content
     * For FullContent mode: articleInfo contains data for extraction
     */
    providePrefetchInfo: (
        articleIndex: number,
        articleId: string | null,
        url: string | null,
        feedId: string | null,
        settings: NavigationSettings | null,
        articleInfo?: PrefetchArticleInfo | null
    ): void => {
        ipcRenderer.send("cvp-prefetch-info", articleIndex, articleId, url, feedId, settings, articleInfo)
    },
    
    /**
     * Set bounds for the active content view
     */
    setBounds: (bounds: ContentViewBounds): void => {
        ipcRenderer.send("cvp-set-bounds", bounds)
    },
    
    /**
     * Show or hide the content view pool
     */
    setVisible: (visible: boolean): void => {
        ipcRenderer.send("cvp-set-visibility", visible)
    },
    
    /**
     * Set reading direction for prefetch prioritization
     * The pool uses this to prioritize prefetching in the expected direction
     */
    setReadingDirection: (direction: ReadingDirection): void => {
        ipcRenderer.send("cvp-set-reading-direction", direction)
    },
    
    /**
     * Get current pool status (for debugging)
     */
    getPoolStatus: (): Promise<PoolStatus> => {
        return ipcRenderer.invoke("cvp-get-status")
    },
    
    // ========== Zoom & Settings ==========
    
    /**
     * Set zoom factor (for +/- shortcuts)
     */
    setZoomFactor: (factor: number): void => {
        ipcRenderer.sendSync("cvp-set-zoom-factor", factor)
    },
    
    /**
     * Set CSS zoom level
     */
    setCssZoom: (level: number): void => {
        ipcRenderer.send("cvp-set-css-zoom", level)
    },
    
    /**
     * Get CSS zoom level (async)
     */
    getCssZoomLevel: (): Promise<number> => {
        return ipcRenderer.invoke("cvp-get-css-zoom-level-async")
    },
    
    /**
     * Set visual zoom mode
     */
    setVisualZoom: (enabled: boolean): void => {
        ipcRenderer.send("cvp-set-visual-zoom", enabled)
    },
    
    // ========== View Operations ==========
    
    /**
     * Execute JavaScript in active view
     */
    executeJavaScript: (code: string): Promise<any> => {
        return ipcRenderer.invoke("cvp-execute-js", code)
    },
    
    /**
     * Send message to active view
     */
    send: (channel: string, ...args: any[]): void => {
        ipcRenderer.send("cvp-send", channel, ...args)
    },
    
    /**
     * Get active webContents ID
     */
    getId: (): Promise<number | null> => {
        return ipcRenderer.invoke("cvp-get-id")
    },
    
    /**
     * Open DevTools for active view
     */
    openDevTools: (): Promise<void> => {
        return ipcRenderer.invoke("cvp-open-devtools")
    },
    
    /**
     * Check if DevTools is opened
     */
    isDevToolsOpened: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-is-devtools-opened")
    },
    
    /**
     * Close DevTools
     */
    closeDevTools: (): Promise<void> => {
        return ipcRenderer.invoke("cvp-close-devtools")
    },
    
    /**
     * Reload active view
     */
    reload: (): Promise<void> => {
        return ipcRenderer.invoke("cvp-reload")
    },
    
    /**
     * Get current URL of active view
     */
    getUrl: (): Promise<string> => {
        return ipcRenderer.invoke("cvp-get-url")
    },
    
    /**
     * Clear active view (load about:blank)
     */
    clear: (): void => {
        ipcRenderer.send("cvp-clear")
    },
    
    // ========== Additional methods for feature parity ==========
    
    /**
     * Go back in history
     */
    goBack: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-go-back")
    },
    
    /**
     * Go forward in history
     */
    goForward: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-go-forward")
    },
    
    /**
     * Can go back in history?
     */
    canGoBack: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-can-go-back")
    },
    
    /**
     * Can go forward in history?
     */
    canGoForward: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-can-go-forward")
    },
    
    /**
     * Get zoom factor
     */
    getZoomFactor: (): Promise<number> => {
        return ipcRenderer.invoke("cvp-get-zoom-factor")
    },
    
    /**
     * Get emulated viewport info (synchronous)
     */
    getEmulatedViewportInfo: (): { zoomPercent: number, viewportWidth: number, viewportHeight: number, mobileMode: boolean } => {
        return ipcRenderer.sendSync("cvp-get-emulated-viewport-info")
    },
    
    /**
     * Focus active view
     */
    focus: (): void => {
        ipcRenderer.send("cvp-focus")
    },
    
    /**
     * Set mobile mode
     */
    setMobileMode: (enabled: boolean): void => {
        ipcRenderer.send("cvp-set-mobile-mode", enabled)
    },
    
    /**
     * Get mobile mode (synchronous)
     */
    getMobileMode: (): boolean => {
        return ipcRenderer.sendSync("cvp-get-mobile-mode")
    },
    
    /**
     * Load HTML directly
     */
    loadHtml: (html: string, baseURL?: string): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-load-html", html, baseURL)
    },
    
    /**
     * Navigate via JavaScript (SPA-style)
     */
    navigateViaJs: (url: string): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-navigate-via-js", url)
    },
    
    /**
     * Set user agent
     */
    setUserAgent: (userAgent: string): void => {
        ipcRenderer.send("cvp-set-user-agent", userAgent)
    },
    
    /**
     * Stop loading
     */
    stop: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-stop")
    },
    
    /**
     * Capture screen
     */
    captureScreen: (): Promise<string | null> => {
        return ipcRenderer.invoke("cvp-capture-screen")
    },
    
    /**
     * Recreate active view (for visual zoom toggle)
     */
    recreate: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-recreate")
    },
    
    /**
     * Nuke active view (for mode switch: RSS <-> Browser)
     * Destroys and recreates the WebContentsView without loading content.
     * Caller should navigate to new content after nuke completes.
     */
    nuke: (): Promise<boolean> => {
        return ipcRenderer.invoke("cvp-nuke")
    },
    
    // ========== Event Listeners ==========
    
    /**
     * Listen for navigation complete events
     * Called when an article has been loaded and is now visible
     */
    onNavigationComplete: (callback: (articleId: string) => void): (() => void) => {
        const handler = (_event: any, articleId: string) => callback(articleId)
        ipcRenderer.on("cvp-navigation-complete", handler)
        return () => ipcRenderer.removeListener("cvp-navigation-complete", handler)
    },
    
    /**
     * Listen for prefetch info requests
     * Called when the pool needs info about an article to prefetch
     */
    onPrefetchInfoRequest: (callback: (articleIndex: number) => void): (() => void) => {
        const handler = (_event: any, articleIndex: number) => callback(articleIndex)
        ipcRenderer.on("cvp-request-prefetch-info", handler)
        return () => ipcRenderer.removeListener("cvp-request-prefetch-info", handler)
    },
    
    /**
     * Listen for error events
     */
    onError: (callback: (articleId: string, error: string) => void): (() => void) => {
        const handler = (_event: any, articleId: string, error: string) => callback(articleId, error)
        ipcRenderer.on("cvp-error", handler)
        return () => ipcRenderer.removeListener("cvp-error", handler)
    },
    
    /**
     * Listen for bounds request from main process
     * Called when the pool needs real bounds from the renderer
     */
    onBoundsRequest: (callback: () => void): (() => void) => {
        const handler = () => callback()
        ipcRenderer.on("cvp-request-bounds", handler)
        return () => ipcRenderer.removeListener("cvp-request-bounds", handler)
    },
    
    /**
     * Get cookies for a specific host from the active view's session
     * This uses the actual WebContentsView session, not session.fromPartition
     * @param host - The host to get cookies for (e.g., "www.threads.net")
     * @returns Array of Electron.Cookie objects
     */
    getCookiesForHost: (host: string): Promise<Electron.Cookie[]> => {
        return ipcRenderer.invoke("cvp-get-cookies-for-host", host)
    },
    
    /**
     * Get ALL cookies from the active view's session (for debugging)
     * @returns Array of all cookies in the session
     */
    getAllCookies: (): Promise<Electron.Cookie[]> => {
        return ipcRenderer.invoke("cvp-get-all-cookies")
    },
    
    /**
     * Debug log - sends message to main process for console output
     * @param message Debug message to log
     */
    debugLog: (message: string): void => {
        ipcRenderer.send("cvp-debug-log", message)
    },
    
    /**
     * Remove all pool event listeners
     */
    removeAllListeners: (): void => {
        ipcRenderer.removeAllListeners("cvp-navigation-complete")
        ipcRenderer.removeAllListeners("cvp-request-prefetch-info")
        ipcRenderer.removeAllListeners("cvp-error")
        ipcRenderer.removeAllListeners("cvp-request-bounds")
    }
}

// ========== Typed Events for React ==========

/**
 * Helper to create a typed event listener hook pattern
 * Usage in React:
 * 
 * useEffect(() => {
 *     return contentViewPoolBridge.onNavigationComplete((articleId) => {
 *         // Handle navigation complete
 *     })
 * }, [])
 */
