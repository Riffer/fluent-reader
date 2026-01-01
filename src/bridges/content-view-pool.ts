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
     */
    providePrefetchInfo: (
        articleIndex: number,
        articleId: string | null,
        url: string | null,
        feedId: string | null,
        settings: NavigationSettings | null
    ): void => {
        ipcRenderer.send("cvp-prefetch-info", articleIndex, articleId, url, feedId, settings)
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
     * Remove all pool event listeners
     */
    removeAllListeners: (): void => {
        ipcRenderer.removeAllListeners("cvp-navigation-complete")
        ipcRenderer.removeAllListeners("cvp-request-prefetch-info")
        ipcRenderer.removeAllListeners("cvp-error")
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
