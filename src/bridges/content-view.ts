/**
 * Content View Bridge - IPC communication with WebContentsView
 * 
 * This bridge provides a React-friendly API for controlling the
 * WebContentsView that displays article content.
 */
import { ipcRenderer } from "electron"

export interface ContentViewBounds {
    x: number
    y: number
    width: number
    height: number
}

export interface ContentViewContextMenu {
    x: number
    y: number
    selectionText: string
    linkURL: string
    srcURL: string
    mediaType: string
}

export const contentViewBridge = {
    /**
     * Navigate content view to URL
     */
    navigate: (url: string): Promise<boolean> => {
        return ipcRenderer.invoke("content-view-navigate", url)
    },
    
    /**
     * Update content view bounds (position and size)
     */
    setBounds: (bounds: ContentViewBounds): void => {
        ipcRenderer.send("content-view-set-bounds", bounds)
    },
    
    /**
     * Show or hide content view
     */
    setVisible: (visible: boolean): void => {
        ipcRenderer.send("content-view-set-visible", visible)
    },
    
    /**
     * Clear content view (load about:blank)
     * Use when switching articles or cleaning up, not for blur-div hiding
     */
    clear: (): void => {
        ipcRenderer.send("content-view-clear")
    },
    
    /**
     * Send message to content view's preload script
     */
    send: (channel: string, ...args: any[]): void => {
        ipcRenderer.send("content-view-send", channel, ...args)
    },
    
    /**
     * Execute JavaScript in content view
     */
    executeJavaScript: (code: string): Promise<any> => {
        return ipcRenderer.invoke("content-view-execute-js", code)
    },
    
    /**
     * Set zoom factor (for +/- keyboard shortcuts)
     * Works alongside device emulation
     */
    setZoomFactor: (factor: number): void => {
        ipcRenderer.send("content-view-set-zoom-factor", factor)
    },
    
    /**
     * Get current zoom factor
     */
    getZoomFactor: (): Promise<number> => {
        return ipcRenderer.invoke("content-view-get-zoom-factor")
    },
    
    /**
     * Enable visual zoom (pinch-to-zoom)
     */
    setVisualZoom: (enabled: boolean): void => {
        ipcRenderer.send("content-view-set-visual-zoom", enabled)
    },
    
    /**
     * Get content view webContents ID
     */
    getId: (): Promise<number | null> => {
        return ipcRenderer.invoke("content-view-get-id")
    },
    
    /**
     * Open DevTools for content view
     */
    openDevTools: (): Promise<void> => {
        return ipcRenderer.invoke("content-view-open-devtools")
    },
    
    /**
     * Reload content view
     */
    reload: (): Promise<void> => {
        return ipcRenderer.invoke("content-view-reload")
    },
    
    /**
     * Go back in navigation history
     */
    goBack: (): Promise<boolean> => {
        return ipcRenderer.invoke("content-view-go-back")
    },
    
    /**
     * Go forward in navigation history
     */
    goForward: (): Promise<boolean> => {
        return ipcRenderer.invoke("content-view-go-forward")
    },
    
    /**
     * Set user agent for content view
     */
    setUserAgent: (userAgent: string): void => {
        ipcRenderer.send("content-view-set-user-agent", userAgent)
    },
    
    /**
     * Load HTML content directly
     */
    loadHTML: (html: string, baseURL?: string): Promise<void> => {
        return ipcRenderer.invoke("content-view-load-html", html, baseURL)
    },
    
    /**
     * Check if can go back
     */
    canGoBack: (): Promise<boolean> => {
        return ipcRenderer.invoke("content-view-can-go-back")
    },
    
    /**
     * Check if can go forward
     */
    canGoForward: (): Promise<boolean> => {
        return ipcRenderer.invoke("content-view-can-go-forward")
    },
    
    /**
     * Get current URL
     */
    getURL: (): Promise<string> => {
        return ipcRenderer.invoke("content-view-get-url")
    },
    
    /**
     * Stop loading
     */
    stop: (): Promise<void> => {
        return ipcRenderer.invoke("content-view-stop")
    },
    
    /**
     * Set mobile mode
     */
    setMobileMode: (enabled: boolean): void => {
        ipcRenderer.send("content-view-set-mobile-mode", enabled)
    },
    
    /**
     * Focus content view
     */
    focus: (): void => {
        ipcRenderer.send("content-view-focus")
    },
    
    /**
     * Capture screenshot of content view
     * Returns base64 data URL of the screenshot
     */
    captureScreen: (): Promise<string | null> => {
        return ipcRenderer.invoke("content-view-capture-screen")
    },

    // ===== Event Listeners =====
    
    /**
     * Listen for loading state changes
     */
    onLoading: (callback: (loading: boolean) => void): () => void => {
        const handler = (_event: any, loading: boolean) => callback(loading)
        ipcRenderer.on("content-view-loading", handler)
        return () => ipcRenderer.removeListener("content-view-loading", handler)
    },
    
    /**
     * Listen for page loaded events
     */
    onLoaded: (callback: (url: string) => void): () => void => {
        const handler = (_event: any, url: string) => callback(url)
        ipcRenderer.on("content-view-loaded", handler)
        return () => ipcRenderer.removeListener("content-view-loaded", handler)
    },
    
    /**
     * Listen for load errors
     */
    onError: (callback: (error: { errorCode: number, errorDescription: string, url: string }) => void): () => void => {
        const handler = (_event: any, error: any) => callback(error)
        ipcRenderer.on("content-view-error", handler)
        return () => ipcRenderer.removeListener("content-view-error", handler)
    },
    
    /**
     * Listen for navigation events
     */
    onNavigated: (callback: (url: string) => void): () => void => {
        const handler = (_event: any, url: string) => callback(url)
        ipcRenderer.on("content-view-navigated", handler)
        return () => ipcRenderer.removeListener("content-view-navigated", handler)
    },
    
    /**
     * Listen for title updates
     */
    onTitleUpdate: (callback: (title: string) => void): () => void => {
        const handler = (_event: any, title: string) => callback(title)
        ipcRenderer.on("content-view-title", handler)
        return () => ipcRenderer.removeListener("content-view-title", handler)
    },
    
    /**
     * Listen for context menu events
     */
    onContextMenu: (callback: (params: ContentViewContextMenu) => void): () => void => {
        const handler = (_event: any, params: ContentViewContextMenu) => callback(params)
        ipcRenderer.on("content-view-context-menu", handler)
        return () => ipcRenderer.removeListener("content-view-context-menu", handler)
    },
    
    /**
     * Listen for keyboard input events
     */
    onInput: (callback: (input: Electron.Input) => void): () => void => {
        const handler = (_event: any, input: Electron.Input) => callback(input)
        ipcRenderer.on("content-view-input", handler)
        return () => ipcRenderer.removeListener("content-view-input", handler)
    },
    
    /**
     * Remove all listeners for a specific channel
     */
    removeAllListeners: (channel: string): void => {
        ipcRenderer.removeAllListeners(`content-view-${channel}`)
    },
}
