import * as React from "react"
import intl from "react-intl-universal"
import { renderToString } from "react-dom/server"
import { RSSItem } from "../scripts/models/item"
import {
    Stack,
    CommandBarButton,
    IContextualMenuProps,
    FocusZone,
    ContextualMenuItemType,
    Spinner,
    SpinnerSize,
    Icon,
    Link,
} from "@fluentui/react"
import {
    RSSSource,
    SourceOpenTarget,
    SourceTextDirection,
} from "../scripts/models/source"
import { shareSubmenu } from "./context-menu"
import { platformCtrl, decodeFetchResponse } from "../scripts/utils"
import { P2PShareDialog } from "./p2p-share-dialog-lan"
import { 
    setOverlayVisible, 
    OverlayStateManager, 
    OVERLAY_VISIBILITY_EVENT,
    OverlayVisibilityEvent,
    setVideoFullscreen 
} from "../scripts/overlay-visibility"

const FONT_SIZE_OPTIONS = [8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]

type ArticleProps = {
    item: RSSItem
    source: RSSSource
    locale: string
    menuOpen: boolean
    overlayActive: boolean  // Any major overlay (menu, settings, context menu, log menu)
    shortcuts: (item: RSSItem, e: KeyboardEvent) => void
    dismiss: () => void
    offsetItem: (offset: number) => void
    toggleHasRead: (item: RSSItem) => void
    toggleStarred: (item: RSSItem) => void
    toggleHidden: (item: RSSItem) => void
    textMenu: (position: [number, number], text: string, url: string) => void
    imageMenu: (position: [number, number]) => void
    updateDefaultZoom: (
        source: RSSSource,
        defaultZoom: Number
    ) => void
    updateDefaultZoomBySid: (sid: number, defaultZoom: number) => void
    updateSourceOpenTarget: (
        source: RSSSource,
        openTarget: SourceOpenTarget
    ) => void
    dismissContextMenu: () => void
    updateSourceTextDirection: (
        source: RSSSource,
        direction: SourceTextDirection
    ) => void
    updateMobileMode: (
        source: RSSSource,
        mobileMode: boolean
    ) => void
    updatePersistCookies: (
        source: RSSSource,
        persistCookies: boolean
    ) => void
    // ContentViewPool support: article position in feed
    articleIndex?: number
    listLength?: number
    feedId?: string
    // For prefetch: access to article list and store data
    articleIds?: number[]
    items?: { [id: number]: RSSItem }
    sources?: { [id: string]: RSSSource }
}

type ArticleState = {
    fontFamily: string
    fontSize: number
    contentMode: SourceOpenTarget  // Replaces loadWebpage + loadFull
    fullContent: string
    loaded: boolean
    error: boolean
    errorDescription: string
    contentVisible: boolean
    zoom: number
    isLoadingFull: boolean
    appPath: string
    extractorTitle?: string
    extractorDate?: Date
    showZoomOverlay: boolean
    nsfwCleanupEnabled: boolean
    autoCookieConsentEnabled: boolean
    redditGalleryExpandEnabled: boolean  // Reddit Gallery: Auto-expand carousel to show all images
    redditSingleImageExpandEnabled: boolean  // Reddit Single Image: Auto-expand single images
    inputModeEnabled: boolean  // Input mode: Shortcuts disabled for login etc.
    showP2PShareDialog: boolean
    visualZoomEnabled: boolean  // Visual Zoom (Pinch-to-Zoom) ohne Mobile-Modus
    mobileUserAgentEnabled: boolean  // Global: Send mobile User-Agent to server
    menuBlurScreenshot: string | null  // Screenshot for blur placeholder when menu is open
    isNavigatingWithVisualZoom: boolean  // Show loading spinner during Visual Zoom navigation
    videoFullscreen: boolean  // Video playing in fullscreen mode (ContentView fills window)
    activeViewId: string | null  // Currently active ContentView ID (for debug badge)
}

class Article extends React.Component<ArticleProps, ArticleState> {
    globalKeydownListener: (e: KeyboardEvent) => void
    globalKeyupListener: (e: KeyboardEvent) => void
    pressedZoomKeys: Set<string>
    currentZoom: number = 0  // Track zoom locally to avoid state lag
    private _isMounted = false
    private _isTogglingMode = false  // Flag to prevent componentDidUpdate from overriding state during toggle
    private cookieSaveTimeout: NodeJS.Timeout | null = null  // Debounce for cookie saving
    private lastCookieSaveTime: number = 0  // Timestamp of last cookie save
    
    // ContentView references and cleanup
    private contentViewPlaceholderRef: HTMLDivElement | null = null
    private contentViewCleanup: (() => void)[] = []
    private resizeObserver: ResizeObserver | null = null
    private contentViewHiddenForMenu: boolean = false  // Track if we hid ContentView for menu access
    private contentViewCurrentUrl: string | null = null  // Track current URL to avoid double navigation
    private pendingContentViewFocus: boolean = false  // Track if we need to focus ContentView after load
    private contentViewInitialized: boolean = false  // Track if Device Emulation is already set (for JS navigation experiment)
    
    // Centralized overlay state management - replaces fragmented tracking
    private overlayStateManager = new OverlayStateManager()
    private overlayVisibilityListener: ((e: OverlayVisibilityEvent) => void) | null = null
    
    // Navigation Lock: Prevents rapid-fire navigation during async operations
    // Problem: Arrow key events can queue up during article transitions, causing skips
    // Solution: Lock navigation during transitions, release after navigation completes
    private isNavigating: boolean = false
    private navigationTimeout: NodeJS.Timeout | null = null
    
    // Unified Key Debounce: Prevents duplicate key processing from multiple sources
    // Problem 1: OS sends keydown to BOTH BrowserWindow (document.keydown) AND
    //            ContentView (before-input-event → IPC), causing double execution
    // Problem 2: recreateContentView sends phantom keyDown for still-pressed keys
    // Solution: Track processed keys with timestamp, block duplicates within 100ms
    // Note: Modifier keys are included in the key string to distinguish Ctrl+I from plain I
    private lastProcessedKey: string = ''
    private lastProcessedKeyTime: number = 0
    
    // Build a key string that includes modifiers (e.g., "ctrl+i" vs "i")
    private buildKeyWithModifiers(key: string, ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean): string {
        const parts: string[] = []
        if (ctrl) parts.push('ctrl')
        if (shift) parts.push('shift')
        if (alt) parts.push('alt')
        if (meta) parts.push('meta')
        parts.push(key.toLowerCase())
        return parts.join('+')
    }
    
    // Check if this key was already processed recently (returns true if should be blocked)
    private isDuplicateKey(key: string): boolean {
        const now = Date.now()
        if (key === this.lastProcessedKey && now - this.lastProcessedKeyTime < 100) {
            return true  // Duplicate - block it
        }
        return false
    }
    
    // Mark key as processed
    private markKeyProcessed(key: string): void {
        this.lastProcessedKey = key
        this.lastProcessedKeyTime = Date.now()
    }
    
    // Navigation lock management
    private setNavigationLock(locked: boolean): void {
        this.isNavigating = locked
        
        // Clear any existing timeout
        if (this.navigationTimeout) {
            clearTimeout(this.navigationTimeout)
            this.navigationTimeout = null
        }
        
        if (locked) {
            // Auto-release lock after timeout (safety net)
            this.navigationTimeout = setTimeout(() => {
                console.log('[Article] Navigation lock auto-released (timeout)')
                this.isNavigating = false
                this.navigationTimeout = null
            }, 500)  // 500ms max lock time
        }
    }
    
    // Release navigation lock (called when navigation completes)
    private releaseNavigationLock(): void {
        this.setNavigationLock(false)
        console.log('[Article] Navigation lock released')
    }

    // Helper getters for content mode checks
    private get isWebpageMode(): boolean {
        return this.state.contentMode === SourceOpenTarget.Webpage
    }
    
    private get isFullContentMode(): boolean {
        return this.state.contentMode === SourceOpenTarget.FullContent
    }
    
    private get isLocalMode(): boolean {
        return this.state.contentMode === SourceOpenTarget.Local
    }
    
    // ContentView is used for all modes now (Webpage, FullContent, Local)
    private get usesContentView(): boolean {
        return this.state.contentMode !== SourceOpenTarget.External
    }

    constructor(props: ArticleProps) {
        super(props)
        // Initialize with stored feed zoom
        const initialZoom = props.source.defaultZoom || 0
        this.currentZoom = initialZoom
        // Initialize local Mobile Mode state
        this.localMobileMode = props.source.mobileMode || false
        this.state = {
            fontFamily: window.settings.getFont(),
            fontSize: window.settings.getFontSize(),
            contentMode: props.source.openTarget,  // Use enum directly
            fullContent: "",
            loaded: false,
            error: false,
            errorDescription: "",
            contentVisible: false,
            zoom: initialZoom,
            isLoadingFull: false,
            appPath: "",
            showZoomOverlay: window.settings.getZoomOverlay(),
            nsfwCleanupEnabled: window.settings.getNsfwCleanup(),
            autoCookieConsentEnabled: window.settings.getAutoCookieConsent(),
            redditGalleryExpandEnabled: window.settings.getRedditGalleryExpand(),
            redditSingleImageExpandEnabled: window.settings.getRedditSingleImageExpand(),
            inputModeEnabled: false,
            showP2PShareDialog: false,
            visualZoomEnabled: window.settings.getVisualZoom(),
            mobileUserAgentEnabled: window.settings.getMobileUserAgent(),
            menuBlurScreenshot: null,
            isNavigatingWithVisualZoom: false,
            videoFullscreen: false,
            activeViewId: null,
        }

        // IPC listener for zoom changes from preload script or ContentViewPool
        // NOTE: This listener may fire with stale props if user switches articles quickly.
        // We REQUIRE feedId to match current source before updating Redux.
        // Events without feedId (e.g., from legacy preload) only update local UI state.
        if ((window as any).ipcRenderer) {
            (window as any).ipcRenderer.on('content-view-zoom-changed', (event: any, zoomLevel: number, feedId?: string, viewId?: string) => {
                const currentSourceId = String(this.props.source?.sid)
                window.contentViewPool?.debugLog?.(`[Article] IPC content-view-zoom-changed: zoom=${zoomLevel}, feedId=${feedId}, viewId=${viewId}, currentSource=${currentSourceId}, name=${this.props.source?.name}`)
                
                // Only update zoom state and viewId (for UI)
                this.currentZoom = zoomLevel
                this.setState({ zoom: zoomLevel, activeViewId: viewId || null })
                
                // CRITICAL: Only persist to Redux if:
                // 1. feedId is provided (from ContentViewPool)
                // 2. feedId matches current source
                // This prevents zoom bleeding between feeds when switching quickly
                // Events without feedId (e.g., from legacy preload) only update local UI
                if (feedId && feedId === currentSourceId) {
                    // Use the new sid-based function that fetches fresh state from Redux
                    // This avoids stale props issues
                    const sid = parseInt(feedId)
                    if (!isNaN(sid)) {
                        this.props.updateDefaultZoomBySid(sid, zoomLevel);
                    }
                } else if (!feedId) {
                    window.contentViewPool?.debugLog?.(`[Article] SKIPPING updateDefaultZoom - no feedId (legacy event)`)
                } else {
                    window.contentViewPool?.debugLog?.(`[Article] SKIPPING updateDefaultZoom - feedId mismatch: ${feedId} != ${currentSourceId}`)
                }
            });
            // Note: activeViewId is now updated via content-view-zoom-changed event
            // which fires on every view activation (no separate cvp-view-activated needed)
        }
    }

    // Track ContentView zoom factor (separate from CSS zoom level)
    private contentViewZoomFactor: number = 1.0;
    
    /**
     * Apply zoom to the current view (Pool)
     * - Visual Zoom ON: uses Device Emulation scale (native pinch-to-zoom works)
     * - Visual Zoom OFF: uses CSS-based zoom via preload
     */
    private applyZoom = (zoomLevel: number) => {
        if (!window.contentViewPool) {
            return;
        }
        
        // Clamp zoom level
        const clampedLevel = Math.max(-6, Math.min(40, zoomLevel));
        this.currentZoom = clampedLevel;
        
        if (this.state.visualZoomEnabled) {
            // Visual Zoom ON: use Device Emulation scale (native zoom)
            const factor = 1.0 + (clampedLevel * 0.1);
            this.contentViewZoomFactor = factor;
            window.contentViewPool.setZoomFactor(factor);
        } else {
            // Visual Zoom OFF: use CSS-based zoom via preload
            window.contentViewPool.setCssZoom(clampedLevel);
        }
        
        // Update local state only - Redux persistence is handled via IPC callback
        // from Pool (setZoomFactor/setCssZoom send 'content-view-zoom-changed' with feedId)
        // This prevents zoom bleeding when props.source is stale after feed switch
        if (this._isMounted) {
            this.setState({ zoom: clampedLevel });
        }
        // DO NOT call updateDefaultZoom here - it would use potentially stale this.props.source!
        // The IPC listener 'content-view-zoom-changed' handles Redux updates with feedId validation
    }
    
    /**
     * Get zoom display text for badge (percentage with decimal for fine zoom)
     */
    private getZoomDisplayText = (): string => {
        const zoomLevel = this.state.zoom || 0;
        const percent = Math.round((1.0 + (zoomLevel * 0.1)) * 100);
        return `${percent}%`;
    }
    
    /**
     * Get viewport tooltip showing emulated viewport dimensions
     */
    private getViewportTooltip = (): string => {
        try {
            const info = window.settings.getEmulatedViewportInfo();
            const lines = [
                `Zoom: ${info.zoomPercent}%`,
                `Viewport: ${info.viewportWidth} × ${info.viewportHeight} px`,
                info.mobileMode ? '📱 Mobile Mode aktiv' : '',
                '',
                'Tasten: +/- (10%), Ctrl++/- (1%), # (Reset)'
            ].filter(Boolean);
            return lines.join('\n');
        } catch (e) {
            return `Zoom: ${this.getZoomDisplayText()}`;
        }
    }
    
    /**
     * Get current navigation settings for bundled navigation call
     * This bundles all settings that affect how the content is displayed
     */
    private getNavigationSettings = () => {
        const zoomLevel = this.currentZoom;
        const factor = 1.0 + (zoomLevel * 0.1);
        
        // DEBUG: Send debug info to Main process via IPC
        window.contentViewPool?.debugLog?.(`[getNavigationSettings] currentZoom=${zoomLevel}, factor=${factor.toFixed(2)}, source.sid=${this.props.source?.sid}, source.defaultZoom=${this.props.source?.defaultZoom}`)
        
        return {
            zoomFactor: factor,
            visualZoom: this.state.visualZoomEnabled,
            mobileMode: this.localMobileMode,
            showZoomOverlay: this.state.showZoomOverlay
        };
    }
    
    /**
     * Navigate to content using Pool
     * This is the central navigation method that handles Pool prefetching
     */
    private navigateToContent = (url: string, articleId?: string): void => {
        if (!window.contentViewPool) {
            console.error('[Article] contentViewPool not available');
            return;
        }
        
        const settings = this.getNavigationSettings();
        const { articleIndex = -1, listLength = 0, feedId = null } = this.props;
        const artId = articleId || String(this.props.item?._id) || 'unknown';
        
        console.log(`[Article] Pool navigate: ${artId} (${articleIndex}/${listLength})`);
        
        // Set visible first - Pool will apply stored bounds when available
        window.contentViewPool.setVisible(true);
        
        // Schedule multiple bounds updates to handle initial render timing
        // The placeholder may not have valid bounds immediately
        this.scheduleBoundsUpdates();
        
        window.contentViewPool.navigateToArticle(
            artId,
            url,
            feedId,
            settings,
            articleIndex,
            listLength
        ).catch((err: any) => {
            console.error("[Article] Pool navigation failed:", err);
        });
        
        this.contentViewCurrentUrl = url;
    }
    
    /**
     * Schedule multiple bounds updates to handle initial render timing
     * The placeholder may not have valid bounds immediately after mount
     */
    private scheduleBoundsUpdates = (): void => {
        // Immediate
        this.updateContentViewBounds();
        // After microtask
        Promise.resolve().then(() => this.updateContentViewBounds());
        // After next frame
        requestAnimationFrame(() => this.updateContentViewBounds());
        // After layout stabilizes (various delays for different scenarios)
        setTimeout(() => this.updateContentViewBounds(), 10);
        setTimeout(() => this.updateContentViewBounds(), 50);
        setTimeout(() => this.updateContentViewBounds(), 100);
        setTimeout(() => this.updateContentViewBounds(), 200);
    }

    /**
     * Send settings to ContentView preload script
     * @deprecated For post-navigation settings updates only. 
     *             Use navigateWithSettings() for navigation.
     */
    private sendSettingsToContentView = () => {
        if (!window.contentViewPool) return;
        
        const zoomLevel = this.currentZoom;
        const showOverlay = this.state.showZoomOverlay;
        const mobileMode = this.localMobileMode;
        const visualZoom = this.state.visualZoomEnabled;
        
        // Send all settings to preload
        window.contentViewPool.send('set-zoom-overlay-setting', showOverlay);
        window.contentViewPool.send('set-mobile-mode', mobileMode);
        window.contentViewPool.send('set-visual-zoom-mode', visualZoom);
        
        // Apply zoom based on mode
        if (visualZoom) {
            const factor = 1.0 + (zoomLevel * 0.1);
            window.contentViewPool.setZoomFactor(factor);
        } else {
            window.contentViewPool.setCssZoom(zoomLevel);
        }
    }

    private sendZoomOverlaySettingToContentView = (show: boolean) => {
        if (!window.contentViewPool) return;
        window.contentViewPool.send('set-zoom-overlay-setting', show);
    }

    private toggleZoomOverlay = () => {
        if (!this._isMounted) return;
        const newValue = !this.state.showZoomOverlay;
        window.settings.setZoomOverlay(newValue);
        this.setState({ showZoomOverlay: newValue });
        this.sendZoomOverlaySettingToContentView(newValue);
    }

    /**
     * Toggle Mobile User-Agent (global setting)
     * When enabled, sends mobile User-Agent to server on page load.
     * Requires reload to take effect.
     */
    private toggleMobileUserAgent = () => {
        if (!this._isMounted) return;
        const newValue = !this.state.mobileUserAgentEnabled;
        window.settings.setMobileUserAgent(newValue);
        this.setState({ mobileUserAgentEnabled: newValue });
        
        // Reload current page to apply new User-Agent
        if (window.contentViewPool) {
            window.contentViewPool.reload();
        }
    }

    /**
     * Toggle Visual Zoom mode
     * - Visual Zoom ON: Native pinch-to-zoom via Device Emulation
     * - Visual Zoom OFF: CSS-based zoom via preload
     * 
     * When toggled, the WebContentsView is recreated to apply the new
     * CSS layout and touch handling configuration.
     */
    private toggleVisualZoom = async () => {
        const newValue = !this.state.visualZoomEnabled;
        window.settings.setVisualZoom(newValue);
        
        // Update state first
        if (this._isMounted) {
            this.setState({ visualZoomEnabled: newValue });
        }
        
        // Recreate WebContentsView to apply new CSS layout and touch handling
        // This is necessary because the preload script reads the visual zoom setting
        // at initialization and sets up CSS/event handlers accordingly.
        if (window.contentViewPool) {
            window.contentViewPool.setVisualZoom(newValue);
            // Pool doesn't support recreate() - reload current article instead
            if (this.props.item) {
                setTimeout(() => {
                    this.reloadCurrentArticle();
                }, 100);
            }
        }
    }
    
    /**
     * Reload the current article in ContentView
     * Used after WebContentsView recreation (e.g., Visual Zoom toggle)
     */
    private reloadCurrentArticle = () => {
        if (!this.props.item) return;
        
        // Check if we have a view to navigate
        if (!window.contentViewPool) return;
        
        const contentMode = this.state.contentMode;
        
        if (contentMode === SourceOpenTarget.Webpage) {
            // Webpage mode: Navigate to URL
            const targetUrl = this.props.item.link;
            this.navigateToContent(targetUrl);
        } else {
            // Local (RSS) or FullContent mode: Load HTML directly
            const htmlDataUrl = this.articleView();
            this.navigateToContent(htmlDataUrl);
        }
        
        // Focus ContentView after short delay
        setTimeout(() => {
            if (window.contentViewPool) {
                window.contentViewPool.focus();
            }
        }, 100);
    }

    // ===== ContentView Methods (WebContentsView - now used for ALL display modes) =====
    
    // Track if Pool listeners have been set up to prevent duplicate registration
    private poolListenersRegistered: boolean = false;
    
    /**
     * Setup Pool-specific event listeners
     * Pool uses same IPC channels as legacy ContentView for input/context events
     */
    private setupPoolListeners = () => {
        const ipc = (window as any).ipcRenderer;
        if (!ipc) {
            console.warn('[ContentViewPool] Cannot setup listeners - ipcRenderer not available');
            return;
        }
        
        // Prevent duplicate listener registration
        if (this.poolListenersRegistered) {
            console.log('[ContentViewPool] Pool listeners already registered - skipping');
            return;
        }
        this.poolListenersRegistered = true;
        
        console.log('[ContentViewPool] Setting up Pool listeners');
        
        // Keyboard input forwarding from Pool views
        // Pool sends 'content-view-input' just like legacy ContentView
        const inputHandler = (_event: any, input: Electron.Input) => {
            this.keyDownHandler(input);
        };
        ipc.on("content-view-input", inputHandler);
        this.contentViewCleanup.push(() => ipc.removeListener("content-view-input", inputHandler));
        
        // Video fullscreen state changes
        const onVideoFullscreen = (_: any, isFullscreen: boolean) => {
            console.log('[Article] Video fullscreen:', isFullscreen);
            setVideoFullscreen(isFullscreen);
            if (this._isMounted) {
                this.setState({ videoFullscreen: isFullscreen });
            }
        };
        ipc.on('content-view-video-fullscreen', onVideoFullscreen);
        this.contentViewCleanup.push(() => ipc.removeListener('content-view-video-fullscreen', onVideoFullscreen));
        
        // Pool-specific events
        const onNavigationComplete = (_event: any, articleId: string) => {
            console.log(`[ContentViewPool] Navigation complete: ${articleId}`);
            // Release navigation lock when pool reports navigation complete
            this.releaseNavigationLock();
            if (this._isMounted) {
                this.setState({ loaded: true });
            }
        };
        ipc.on('cvp-navigation-complete', onNavigationComplete);
        this.contentViewCleanup.push(() => ipc.removeListener('cvp-navigation-complete', onNavigationComplete));
        
        // Pool error events
        const onPoolError = (_event: any, articleId: string, error: string) => {
            console.error(`[ContentViewPool] Error for ${articleId}:`, error);
            if (this._isMounted) {
                this.setState({ 
                    error: true, 
                    errorDescription: error 
                });
            }
        };
        ipc.on('cvp-error', onPoolError);
        this.contentViewCleanup.push(() => ipc.removeListener('cvp-error', onPoolError));
        
        // Prefetch info request from Pool
        const onPrefetchRequest = (_event: any, articleIndex: number) => {
            console.log(`[ContentViewPool] Prefetch request for index ${articleIndex}`);
            this.handlePrefetchRequest(articleIndex);
        };
        ipc.on('cvp-request-prefetch-info', onPrefetchRequest);
        this.contentViewCleanup.push(() => ipc.removeListener('cvp-request-prefetch-info', onPrefetchRequest));
        
        // Bounds request from Pool - send current bounds immediately
        const onBoundsRequest = () => {
            console.log(`[ContentViewPool] Bounds request received`);
            this.updateContentViewBounds();
        };
        ipc.on('cvp-request-bounds', onBoundsRequest);
        this.contentViewCleanup.push(() => ipc.removeListener('cvp-request-bounds', onBoundsRequest));
    }
    
    /**
     * Handle prefetch request from ContentViewPool
     * Provides article info for a specific index
     */
    private handlePrefetchRequest = (articleIndex: number) => {
        const { articleIds, items, sources, feedId, locale } = this.props;
        
        if (!articleIds || !items || !sources) {
            console.log(`[ContentViewPool] Cannot handle prefetch - missing props`);
            window.contentViewPool?.providePrefetchInfo(articleIndex, null, null, null, null, null);
            return;
        }
        
        if (articleIndex < 0 || articleIndex >= articleIds.length) {
            console.log(`[ContentViewPool] Prefetch index ${articleIndex} out of bounds (0-${articleIds.length - 1})`);
            window.contentViewPool?.providePrefetchInfo(articleIndex, null, null, null, null, null);
            return;
        }
        
        const itemId = articleIds[articleIndex];
        const item = items[itemId];
        
        if (!item) {
            console.log(`[ContentViewPool] Item ${itemId} not found in store`);
            window.contentViewPool?.providePrefetchInfo(articleIndex, null, null, null, null, null);
            return;
        }
        
        const source = sources[item.source];
        if (!source) {
            console.log(`[ContentViewPool] Source ${item.source} not found for item ${itemId}`);
            window.contentViewPool?.providePrefetchInfo(articleIndex, null, null, null, null, null);
            return;
        }
        
        // Determine URL based on source's openTarget
        let url: string | null = null;
        const openTarget = source.openTarget;
        
        // Build article info for FullContent mode (Main process will do extraction)
        const articleInfo = {
            articleId: String(itemId),
            itemLink: item.link,
            itemContent: item.content || '',
            itemTitle: item.title || '',
            itemDate: item.date.getTime(),
            openTarget: openTarget,
            textDir: source.textDir || 0,
            fontSize: this.state.fontSize,
            fontFamily: this.state.fontFamily || '',
            locale: locale || 'en-US'
        };
        
        if (openTarget === SourceOpenTarget.Webpage) {
            // Webpage mode: Use the article link
            url = item.link;
        } else if (openTarget === SourceOpenTarget.FullContent) {
            // FullContent mode: Send article info, Main process will fetch & extract
            console.log(`[ContentViewPool] Prefetch for FullContent index ${articleIndex}: sending to Main for extraction`);
            // url stays null - Main will generate it after extraction
        } else if (openTarget === SourceOpenTarget.External) {
            // External mode: Opens in browser, no prefetch needed
            console.log(`[ContentViewPool] Prefetch skip for index ${articleIndex}: External mode`);
            window.contentViewPool?.providePrefetchInfo(articleIndex, null, null, null, null, null);
            return;
        } else {
            // Local/RSS mode: Generate the article HTML view (content is local, no network needed)
            // Use a helper to generate the HTML for the target item
            url = this.generateArticleHtml(item, source);
        }
        
        // Use CURRENT zoom if same feed, otherwise use TARGET feed's stored default zoom
        // This ensures:
        // 1. Same-feed prefetched articles inherit the user's current zoom (even if not yet saved)
        // 2. Different-feed articles use their own stored default zoom
        // Note: Compare source IDs (numbers), not feedId (which is a string like "ALL" or "SOURCE" or "123")
        const currentSourceId = this.props.source?.sid;
        const isSameFeed = currentSourceId !== undefined && item.source === currentSourceId;
        const targetZoom = isSameFeed ? this.currentZoom : (source.defaultZoom || 0);
        const targetZoomFactor = 1.0 + (targetZoom * 0.1);
        const settings = {
            zoomFactor: targetZoomFactor,
            visualZoom: this.state.visualZoomEnabled,
            mobileMode: this.localMobileMode,
            showZoomOverlay: this.state.showZoomOverlay
        };
        
        console.log(`[ContentViewPool] Providing prefetch info for index ${articleIndex}: item=${itemId}, openTarget=${SourceOpenTarget[openTarget]}, isSameFeed=${isSameFeed}, targetZoom=${targetZoom}, url=${url?.substring(0, 50) || 'null (FullContent)'}...`);
        window.contentViewPool?.providePrefetchInfo(
            articleIndex,
            String(itemId),
            url,
            // Use the prefetch article's source ID as feedId, not the current article's
            String(item.source),
            settings,
            articleInfo
        );
    }
    
    /**
     * Generate article HTML for prefetch (RSS/Local mode)
     * Uses normalized content - extracts images and text, strips all wrapper elements
     */
    private generateArticleHtml = (item: RSSItem, source: RSSSource): string => {
        const articleContent = item.content || '';
        
        // Normalize RSS content - extract images and text separately
        const { images, textParagraphs } = this.normalizeRssContent(articleContent);
        
        // Determine mode based on content
        const totalTextLength = textParagraphs.join(' ').length;
        const isComicMode = images.length > 0 && totalTextLength < 200;
        const isSingleImage = images.length === 1 && totalTextLength < 100;
        
        // Format date
        const dateStr = item.date.toLocaleString(
            this.props.locale,
            { hour12: !this.props.locale.startsWith("zh") }
        );
        
        // Build normalized HTML - just images and text paragraphs
        const imagesHtml = images.map(img => 
            `<img src="${this.escapeHtml(img.src)}" alt="${this.escapeHtml(img.alt)}">`
        ).join('\n        ');
        
        const textHtml = textParagraphs.map(p => `<p>${this.escapeHtml(p)}</p>`).join('\n        ');
        
        // Combine: images first (for comic mode), then text
        const normalizedContent = isComicMode 
            ? `${imagesHtml}\n        ${textHtml}`
            : `${textHtml}\n        ${imagesHtml}`;
        
        const rtlClass = source.textDir === SourceTextDirection.RTL ? "rtl" 
            : source.textDir === SourceTextDirection.Vertical ? "vertical" : "";
        const modeClass = isSingleImage ? "single-image" : isComicMode ? "comic-mode" : "";
        
        const fontSize = this.state.fontSize;
        const fontFamily = this.state.fontFamily;
        
        const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; img-src http: https: data:; style-src 'unsafe-inline'; frame-src http: https:; media-src http: https:; connect-src https: http:">
    <title>Article</title>
    <style>
/* ====== Local/RSS Mode - Simplified Normalized Layout ====== */
::-webkit-scrollbar { width: 16px; }
::-webkit-scrollbar-thumb { border: 2px solid transparent; background-color: #0004; background-clip: padding-box; border-radius: 8px; }
::-webkit-scrollbar-thumb:hover { background-color: #0006; }

:root { 
    --gray: #484644; 
    --primary: #0078d4; 
    --max-width: 1200px;
}

html, body { margin: 0; padding: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #fafafa; color: #1a1a1a; }
body { padding: 1rem; font-size: ${fontSize}px; overflow-x: hidden; }
${fontFamily ? `body { font-family: "${fontFamily}"; }` : ''}
body.rtl { direction: rtl; }
body.vertical { writing-mode: vertical-rl; padding-right: 96px; overflow: scroll hidden; }

/* Main container - simple centered layout */
#main { 
    max-width: var(--max-width); 
    margin: 0 auto; 
    display: flex;
    flex-direction: column;
    gap: 1rem;
    animation: fadeIn 0.3s ease-out;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

/* Title and date */
.title { font-size: 1.25rem; font-weight: 600; margin: 0; }
.date { color: var(--gray); font-size: 0.875rem; margin: 0; }

/* Images - simple responsive */
#main img { 
    width: 100%; 
    height: auto; 
    border-radius: 4px; 
    background: #000;
}

/* Text paragraphs */
#main p { margin: 0; line-height: 1.6; }

/* Links */
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }

/* Dark mode */
@media (prefers-color-scheme: dark) {
    :root { --gray: #a19f9d; --primary: #4ba0e1; }
    html, body { background: #1e1e1e; color: #e0e0e0; }
    ::-webkit-scrollbar-thumb { background-color: #fff4; }
}

/* Comic/Single-image mode - center everything */
.comic-mode #main, .single-image #main { 
    align-items: center; 
    text-align: center; 
}

/* Single Image Mode - Portrait images constrained by height */
.single-image #main img.portrait { width: auto; height: auto; max-height: 100vh; max-width: 100%; }
    </style>
</head>
<body class="${rtlClass} ${modeClass}">
    <div id="main">
        <p class="title">${this.escapeHtml(item.title)}</p>
        <p class="date">${this.escapeHtml(dateStr)}</p>
        ${normalizedContent}
    </div>
    <script>
(function() {
    // Fix relative URLs
    const baseUrl = "${this.escapeHtml(item.link)}";
    let baseEl = document.createElement('base');
    baseEl.setAttribute('href', baseUrl.split("/").slice(0, 3).join("/"));
    document.head.append(baseEl);
    
    document.querySelectorAll("img[src]").forEach(e => { e.src = e.src; });
    document.querySelectorAll("a[href]").forEach(e => { e.href = e.href; });
    
    // Single Image Mode: Optimize portrait image sizing
    // If a portrait image would exceed viewport height when scaled to full width,
    // constrain it by height instead to prevent overflow and pixelation
    if (document.body.classList.contains('single-image')) {
        const img = document.querySelector('#main img');
        if (img) {
            const optimizeImageSize = () => {
                // Only consider portrait images (taller than wide)
                if (img.naturalHeight > img.naturalWidth) {
                    const containerWidth = img.parentElement?.offsetWidth || window.innerWidth;
                    const viewportHeight = window.innerHeight;
                    
                    // Calculate what height the image would have at full container width
                    const aspectRatio = img.naturalWidth / img.naturalHeight;
                    const scaledHeight = containerWidth / aspectRatio;
                    
                    // If scaled image would exceed viewport height, constrain by height
                    if (scaledHeight > viewportHeight) {
                        img.classList.add('portrait');
                        img.style.height = viewportHeight + 'px';
                        img.style.width = 'auto';
                        // Scroll image to top edge of viewport
                        setTimeout(() => {
                            img.scrollIntoView({ behavior: 'instant', block: 'start' });
                        }, 50);
                    }
                }
            };
            if (img.complete && img.naturalHeight > 0) {
                optimizeImageSize();
            } else {
                img.addEventListener('load', optimizeImageSize);
            }
        }
    }
})();
    </script>
</body>
</html>`;

        // Convert to base64 data URL
        return `data:text/html;base64,${btoa(unescape(encodeURIComponent(htmlContent)))}`;
    }
    
    /**
     * Normalize RSS content - extract images and text, remove wrapper elements
     */
    private normalizeRssContent = (htmlContent: string): { images: Array<{src: string, alt: string}>, textParagraphs: string[] } => {
        const images: Array<{src: string, alt: string}> = [];
        
        // Extract images with regex
        const imgRegex1 = /<img[^>]+src=["']([^"']+)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*\/?>/gi;
        const imgRegex2 = /<img[^>]*alt=["']([^"']*)["'][^>]+src=["']([^"']+)["'][^>]*\/?>/gi;
        
        let match;
        const seenSrcs = new Set<string>();
        
        while ((match = imgRegex1.exec(htmlContent)) !== null) {
            if (!seenSrcs.has(match[1])) {
                seenSrcs.add(match[1]);
                images.push({ src: match[1], alt: match[2] || '' });
            }
        }
        
        while ((match = imgRegex2.exec(htmlContent)) !== null) {
            if (!seenSrcs.has(match[2])) {
                seenSrcs.add(match[2]);
                images.push({ src: match[2], alt: match[1] || '' });
            }
        }
        
        // Extract text content
        const textOnly = htmlContent
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<img[^>]*>/gi, '')
            .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        
        const textParagraphs = textOnly
            .split(/\n\n+/)
            .map(p => p.trim())
            .filter(p => p.length > 0);
        
        return { images, textParagraphs };
    }
    
    /**
     * Escape HTML special characters
     */
    private escapeHtml = (text: string): string => {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    
    /**
     * Cleanup ContentView listeners and hide it
     */
    private cleanupContentView = () => {
        
        // Remove all event listeners
        this.contentViewCleanup.forEach(cleanup => cleanup());
        this.contentViewCleanup = [];
        
        // Reset listener registration flag so they can be re-registered
        this.poolListenersRegistered = false;
        
        // Stop ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        
        // Remove window resize listener
        if (this.windowResizeListener) {
            window.removeEventListener('resize', this.windowResizeListener);
            this.windowResizeListener = null;
        }
        
        // Remove window state listeners (maximize/fullscreen)
        this.windowStateCleanup.forEach(cleanup => cleanup());
        this.windowStateCleanup = [];
        
        // Remove centralized overlay visibility listener
        if (this.overlayVisibilityListener) {
            window.removeEventListener(OVERLAY_VISIBILITY_EVENT, this.overlayVisibilityListener as EventListener);
            this.overlayVisibilityListener = null;
        }
        
        // Clear overlay state manager
        this.overlayStateManager.clear()
        
        // Reset bounds cache and current URL
        this.lastContentViewBounds = null;
        this.contentViewCurrentUrl = null;
        
        // Hide ContentView, clear content, and reset bounds via Pool
        if (window.contentViewPool) {
            window.contentViewPool.setVisible(false);
            window.contentViewPool.clear(); // Load about:blank to clear old content
            // Set bounds to 0 to ensure it's completely out of the way
            window.contentViewPool.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        }
        
        // Clear blur screenshot (only if mounted)
        if (this._isMounted) {
            this.setState({ menuBlurScreenshot: null });
        }
        this.contentViewHiddenForMenu = false;
    }
    
    /**
     * Update ContentView bounds based on placeholder position
     */
    private updateContentViewBounds = () => {
        if (!this.contentViewPlaceholderRef) {
            console.warn('[Article] updateContentViewBounds: No placeholder ref!');
            return;
        }
        
        // Don't update bounds if ContentView is hidden for overlay
        if (this.contentViewHiddenForMenu) return;
        
        const rect = this.contentViewPlaceholderRef.getBoundingClientRect();
        const bounds = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
        
        console.log('[Article] updateContentViewBounds:', bounds);
        
        // Only update if bounds actually changed (avoid unnecessary IPC)
        if (this.lastContentViewBounds &&
            this.lastContentViewBounds.x === bounds.x &&
            this.lastContentViewBounds.y === bounds.y &&
            this.lastContentViewBounds.width === bounds.width &&
            this.lastContentViewBounds.height === bounds.height) {
            return;
        }
        
        this.lastContentViewBounds = bounds;
        
        // Update bounds for Pool
        if (window.contentViewPool) {
            window.contentViewPool.setBounds(bounds);
        }
    }
    
    private lastContentViewBounds: { x: number, y: number, width: number, height: number } | null = null;
    private windowResizeListener: (() => void) | null = null;
    private windowStateCleanup: (() => void)[] = [];  // Cleanup for window state listeners (maximize/fullscreen)
    
    /**
     * Initialize ContentView for ALL content types
     * - Webpage mode: navigate to URL
     * - RSS/Full content: load HTML directly via data URL
     * 
     * Uses Pool for all navigation (prefetching supported)
     */
    private initializeContentView = async () => {
        if (!this.contentViewPlaceholderRef) return;
        
        // Check if Pool bridge is available
        if (!window.contentViewPool) {
            console.error('[ContentView] contentViewPool bridge not available!');
            return;
        }
        
        try {
            // Setup listeners if not already done
            if (this.contentViewCleanup.length === 0) {
                this.setupPoolListeners();
            }
            
            // Update bounds
            this.updateContentViewBounds();
            
            // Setup ResizeObserver for dynamic bounds updates
            if (!this.resizeObserver) {
                this.resizeObserver = new ResizeObserver((entries) => {
                    for (const entry of entries) {
                        const { width, height } = entry.contentRect;
                        console.log(`[Article] ResizeObserver: placeholder size changed to ${Math.round(width)}x${Math.round(height)}`);
                    }
                    this.updateContentViewBounds();
                });
                this.resizeObserver.observe(this.contentViewPlaceholderRef);
            }
            
            // Setup window resize listener (ResizeObserver doesn't catch window resizes that only change position)
            // Use multiple delayed updates to handle maximize/fullscreen animations
            if (!this.windowResizeListener) {
                this.windowResizeListener = () => {
                    console.log(`[Article] Window resize event fired, innerSize: ${window.innerWidth}x${window.innerHeight}`);
                    // Immediate update
                    this.updateContentViewBounds();
                    // Delayed updates to catch post-animation layout changes
                    // This is needed because maximize/fullscreen animations can delay DOM layout
                    requestAnimationFrame(() => this.updateContentViewBounds());
                    setTimeout(() => this.updateContentViewBounds(), 50);
                    setTimeout(() => this.updateContentViewBounds(), 150);
                    setTimeout(() => this.updateContentViewBounds(), 300);
                };
                window.addEventListener('resize', this.windowResizeListener);
            }
            
            // Setup window state listeners (maximize/fullscreen) for bounds updates
            // The resize event doesn't always fire reliably on these state changes
            if (this.windowStateCleanup.length === 0) {
                const ipc = (window as any).ipcRenderer;
                if (ipc) {
                    const boundsUpdateHandler = () => {
                        // Multiple delayed updates to catch animation completion
                        this.updateContentViewBounds();
                        requestAnimationFrame(() => this.updateContentViewBounds());
                        setTimeout(() => this.updateContentViewBounds(), 100);
                        setTimeout(() => this.updateContentViewBounds(), 200);
                        setTimeout(() => this.updateContentViewBounds(), 400);
                    };
                    
                    const stateChannels = ['maximized', 'unmaximized', 'enter-fullscreen', 'leave-fullscreen'];
                    for (const channel of stateChannels) {
                        ipc.on(channel, boundsUpdateHandler);
                        this.windowStateCleanup.push(() => ipc.removeListener(channel, boundsUpdateHandler));
                    }
                }
            }
            
            // Setup centralized overlay visibility listener
            if (!this.overlayVisibilityListener) {
                this.overlayVisibilityListener = (e: OverlayVisibilityEvent) => {
                    this.handleOverlayVisibilityEvent(e.detail.source, e.detail.visible);
                };
                window.addEventListener(OVERLAY_VISIBILITY_EVENT, this.overlayVisibilityListener as EventListener);
            }
            
            // Wait for layout to stabilize before navigating
            requestAnimationFrame(() => {
                // Double-rAF ensures layout is complete
                requestAnimationFrame(() => {
                    if (this.isWebpageMode) {
                        this.navigateToContent(this.props.item.link);
                    } else {
                        this.navigateToContent(this.articleView());
                    }
                });
            });
            
            // Show ContentView
            window.contentViewPool.setVisible(true);
            
            // Focus
            window.contentViewPool.focus();
            
            this.setState({ contentVisible: true, loaded: true });
        } catch (e) {
            console.error('[ContentView] Error initializing:', e);
        }
    }
    
    // Input Mode: Sends status to ContentView to disable keyboard navigation
    private setInputMode = (enabled: boolean) => {
        console.log(`[Article] setInputMode: ${enabled}`)
        // Set local state synchronously for immediate access
        this.localInputModeEnabled = enabled;
        this.setState({ inputModeEnabled: enabled });
        // Send to ContentView via Pool
        if (window.contentViewPool) {
            try {
                window.contentViewPool.send('set-input-mode', enabled);
            } catch (e) {
                // ContentView not ready - ignore
            }
        }
    }

    // Local state for Mobile Mode (for reliable IPC timing after reload)
    private localMobileMode: boolean = false;

    private toggleMobileMode = async () => {
        const newMobileMode = !this.props.source.mobileMode;
        this.localMobileMode = newMobileMode;  // Set local state immediately
        this.props.updateMobileMode(this.props.source, newMobileMode);
        
        // Set global Mobile Mode status (for new ContentViews on article change)
        this.setGlobalMobileMode(newMobileMode);
        
        // Use ContentView Pool bridge - this handles User-Agent, Device Emulation, and reload
        if (window.contentViewPool) {
            window.contentViewPool.setMobileMode(newMobileMode);
        }
    }

    private togglePersistCookies = () => {
        const newValue = !this.props.source.persistCookies;
        this.props.updatePersistCookies(this.props.source, newValue);
        
        if (newValue) {
            // If enabled, immediately save current cookies
            this.savePersistedCookies();
        }
    }

    // Note: enableMobileEmulation and disableMobileEmulation removed
    // Mobile mode is now handled via window.contentViewPool.setMobileMode()

    // Sets global Mobile Mode status in Main process
    // Main process then automatically applies emulation to new ContentViews
    private setGlobalMobileMode = (enabled: boolean) => {
        const ipcRenderer = (window as any).ipcRenderer;
        if (ipcRenderer && typeof ipcRenderer.send === 'function') {
            // FIXED viewport width for consistent mobile behavior
            // 767px triggers CSS responsive breakpoints (just below common 768px tablet breakpoint)
            const viewportWidth = 767;
            let viewportHeight = 844;
            
            // Try to get height from ContentView placeholder
            if (this.contentViewPlaceholderRef) {
                try {
                    const rect = this.contentViewPlaceholderRef.getBoundingClientRect();
                    if (rect.height > 0) {
                        viewportHeight = Math.round(rect.height);
                    }
                } catch {}
            }
            
            const params = {
                screenPosition: "mobile",
                screenSize: { width: viewportWidth, height: viewportHeight },
                deviceScaleFactor: 1,
                viewSize: { width: viewportWidth, height: viewportHeight },
                fitToView: false,
                userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
            };
            
            ipcRenderer.send('set-global-mobile-mode', enabled, params);
        }
    }

    private toggleNsfwCleanup = () => {
        const newValue = !this.state.nsfwCleanupEnabled;
        window.settings.setNsfwCleanup(newValue);
        this.setState({ nsfwCleanupEnabled: newValue });
        // Reload ContentView so the setting takes effect
        this.contentReload();
    }

    private toggleAutoCookieConsent = () => {
        const newValue = !this.state.autoCookieConsentEnabled;
        window.settings.setAutoCookieConsent(newValue);
        this.setState({ autoCookieConsentEnabled: newValue });
        // Reload ContentView so the setting takes effect
        this.contentReload();
    }

    private toggleRedditGalleryExpand = () => {
        const newValue = !this.state.redditGalleryExpandEnabled;
        window.settings.setRedditGalleryExpand(newValue);
        this.setState({ redditGalleryExpandEnabled: newValue });
        // Reload ContentView so the setting takes effect
        this.contentReload();
    }

    private toggleRedditSingleImageExpand = () => {
        const newValue = !this.state.redditSingleImageExpandEnabled;
        window.settings.setRedditSingleImageExpand(newValue);
        this.setState({ redditSingleImageExpandEnabled: newValue });
        // Reload ContentView so the setting takes effect
        this.contentReload();
    }

    // ===== Cookie Persistence =====
    
    /**
     * Loads saved cookies for the current article (if persistCookies is enabled)
     */
    private loadPersistedCookies = async () => {
        if (!this.props.source.persistCookies) {
            return
        }
        
        const url = this.props.item.link
        
        try {
            await window.utils.loadPersistedCookies(url)
        } catch (e) {
            console.error("[CookiePersist] Error loading cookies:", e)
        }
    }
    
    /**
     * Saves current cookies for the article (if persistCookies is enabled)
     */
    private savePersistedCookies = async () => {
        console.log(`[CookiePersist] savePersistedCookies called, persistCookies=${this.props.source.persistCookies}, url=${this.props.item?.link}`)
        if (!this.props.source.persistCookies) {
            console.log(`[CookiePersist] Skipping - persistCookies not enabled for this source`)
            return
        }
        
        const url = this.props.item.link
        
        try {
            const result = await window.utils.savePersistedCookies(url)
            console.log(`[CookiePersist] Saved cookies for ${url}:`, result)
            this.lastCookieSaveTime = Date.now()
        } catch (e) {
            console.error("[CookiePersist] Error saving cookies:", e)
        }
    }
    
    /**
     * Debounced version of savePersistedCookies - prevents saving too frequently
     * with many navigation events (e.g. Reddit SPA)
     */
    private savePersistedCookiesDebounced = () => {
        if (!this.props.source.persistCookies) {
            return
        }
        
        // If recently saved, ignore
        const now = Date.now()
        if (now - this.lastCookieSaveTime < 2000) {
            return
        }
        
        // Clear previous timeout
        if (this.cookieSaveTimeout) {
            clearTimeout(this.cookieSaveTimeout)
        }
        
        // Set new timeout (500ms delay)
        this.cookieSaveTimeout = setTimeout(() => {
            this.savePersistedCookies()
        }, 500)
    }

    setFontSize = (size: number) => {
        window.settings.setFontSize(size)
        this.setState({ fontSize: size })
    }
    setFont = (font: string) => {
        window.settings.setFont(font)
        this.setState({ fontFamily: font })
    }

    fontSizeMenuProps = (): IContextualMenuProps => ({
        items: FONT_SIZE_OPTIONS.map(size => ({
            key: String(size),
            text: String(size),
            canCheck: true,
            checked: size === this.state.fontSize,
            onClick: () => this.setFontSize(size),
        })),
    })

    fontFamilyMenuProps = (): IContextualMenuProps => ({
        items: window.fontList.map((font, idx) => ({
            key: String(idx),
            text: font === "" ? intl.get("default") : font,
            canCheck: true,
            checked: this.state.fontFamily === font,
            onClick: () => this.setFont(font),
        })),
    })

    updateTextDirection = (direction: SourceTextDirection) => {
        this.props.updateSourceTextDirection(this.props.source, direction)
    }

    updateDefaultZoom = (defaultZoom: Number) => {
        window.contentViewPool?.debugLog?.(`[Article] updateDefaultZoom: zoom=${defaultZoom}, source.sid=${this.props.source?.sid}, name=${this.props.source?.name}`)
        this.props.updateDefaultZoom(this.props.source, defaultZoom)
    }

    directionMenuProps = (): IContextualMenuProps => ({
        items: [
            {
                key: "LTR",
                text: intl.get("article.LTR"),
                iconProps: { iconName: "Forward" },
                canCheck: true,
                checked: this.props.source.textDir === SourceTextDirection.LTR,
                onClick: () =>
                    this.updateTextDirection(SourceTextDirection.LTR),
            },
            {
                key: "RTL",
                text: intl.get("article.RTL"),
                iconProps: { iconName: "Back" },
                canCheck: true,
                checked: this.props.source.textDir === SourceTextDirection.RTL,
                onClick: () =>
                    this.updateTextDirection(SourceTextDirection.RTL),
            },
            {
                key: "Vertical",
                text: intl.get("article.Vertical"),
                iconProps: { iconName: "Down" },
                canCheck: true,
                checked:
                    this.props.source.textDir === SourceTextDirection.Vertical,
                onClick: () =>
                    this.updateTextDirection(SourceTextDirection.Vertical),
            },
        ],
    })

    moreMenuProps = (): IContextualMenuProps => {
        const items: any[] = [
            {
                key: "copyURL",
                text: intl.get("context.copyURL"),
                iconProps: { iconName: "Link" },
                onClick: () => {
                    window.utils.writeClipboard(this.props.item.link)
                },
            },
            ...shareSubmenu(this.props.item),
            {
                key: "p2pShare",
                text: "P2P Share",
                iconProps: { iconName: "Share" },
                onClick: () => this.setState({ showP2PShareDialog: true }),
            },
        ]
        
        items.push({
                key: "toggleHidden",
                text: this.props.item.hidden
                    ? intl.get("article.unhide")
                    : intl.get("article.hide"),
                iconProps: {
                    iconName: this.props.item.hidden ? "View" : "Hide3",
                },
                onClick: () => {
                    this.props.toggleHidden(this.props.item)
                },
            },
            {
                key: "fontMenu",
                text: intl.get("article.font"),
                iconProps: { iconName: "Font" },
                disabled: this.isWebpageMode,
                subMenuProps: this.fontFamilyMenuProps(),
            },
            {
                key: "fontSizeMenu",
                text: intl.get("article.fontSize"),
                iconProps: { iconName: "FontSize" },
                disabled: this.isWebpageMode,
                subMenuProps: this.fontSizeMenuProps(),
            },
            {
                key: "directionMenu",
                text: intl.get("article.textDir"),
                iconProps: { iconName: "ChangeEntitlements" },
                disabled: this.isWebpageMode,
                subMenuProps: this.directionMenuProps(),
            },
            {
                key: "toolsMenu",
                text: "Tools",
                iconProps: { iconName: "DeveloperTools" },
                subMenuProps: {
                    items: [
                        {
                            key: "copySourceCode",
                            text: "Quelltext kopieren",
                            iconProps: { iconName: "Code" },
                            disabled: this.isLocalMode,  // Only available for Webpage/FullContent
                            onClick: () => {
                                if (this.isFullContentMode && this.state.fullContent) {
                                    window.utils.writeClipboard(this.state.fullContent)
                                } else if (window.contentViewPool) {
                                    window.contentViewPool.executeJavaScript(`
                                        (function() {
                                            const html = document.documentElement.outerHTML;
                                            return html;
                                        })()
                                    `).then((result: string) => {
                                        if (result) {
                                            window.utils.writeClipboard(result)
                                        }
                                    }).catch((err: any) => {
                                        console.error('Fehler beim Kopieren des Quelltexts:', err)
                                    })
                                }
                            },
                        },
                        {
                            key: "copyComputedSource",
                            text: "Berechneter Quelltext kopieren",
                            iconProps: { iconName: "CodeEdit" },
                            disabled: this.isLocalMode,  // Only available for Webpage/FullContent
                            onClick: () => {
                                if (window.contentViewPool) {
                                    window.contentViewPool.executeJavaScript(`
                                        (function() {
                                            let contentEl = document.getElementById('fr-zoom-container') || document.documentElement;
                                            let clone = contentEl.cloneNode(true);
                                            if (clone.id === 'fr-zoom-container') {
                                                clone.style.transform = 'none';
                                                clone.style.position = 'relative';
                                                clone.style.top = 'auto';
                                                clone.style.left = 'auto';
                                            }
                                            const html = new XMLSerializer().serializeToString(clone);
                                            return html;
                                        })()
                                    `).then((result: string) => {
                                        if (result) {
                                            window.utils.writeClipboard(result)
                                        }
                                    }).catch((err: any) => {
                                        console.error('Fehler beim Kopieren des berechneten Quelltexts:', err)
                                    })
                                }
                            },
                        },
                        {
                            key: "dividerTools",
                            itemType: ContextualMenuItemType.Divider,
                        },
                        {
                            key: "toggleZoomOverlay",
                            text: "Zoom-Anzeige",
                            iconProps: { iconName: this.state.showZoomOverlay ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.showZoomOverlay,
                            onClick: this.toggleZoomOverlay,
                        },
                        {
                            key: "toggleMobileMode",
                            text: "Mobile Ansicht (Viewport)",
                            iconProps: { iconName: (this.props.source.mobileMode || false) ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.props.source.mobileMode || false,
                            // Mobile Mode works with ContentView (all modes except External)
                            disabled: !this.usesContentView,
                            onClick: this.toggleMobileMode,
                        },
                        {
                            key: "toggleMobileUserAgent",
                            text: "Mobile User-Agent (global)",
                            iconProps: { iconName: this.state.mobileUserAgentEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.mobileUserAgentEnabled,
                            // User-Agent requires reload, works with ContentView
                            disabled: !this.usesContentView,
                            onClick: this.toggleMobileUserAgent,
                        },
                        {
                            key: "toggleVisualZoom",
                            text: "Visual Zoom (Pinch-to-Zoom)",
                            iconProps: { iconName: this.state.visualZoomEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.visualZoomEnabled,
                            // Visual Zoom works with ContentView (all modes except External)
                            disabled: !this.usesContentView,
                            onClick: this.toggleVisualZoom,
                        },
                        {
                            key: "toggleNsfwCleanup",
                            text: "NSFW-Cleanup (experimentell)",
                            iconProps: { iconName: this.state.nsfwCleanupEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.nsfwCleanupEnabled,
                            onClick: this.toggleNsfwCleanup,
                        },
                        {
                            key: "toggleAutoCookieConsent",
                            text: "Auto Cookie-Consent",
                            iconProps: { iconName: this.state.autoCookieConsentEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.autoCookieConsentEnabled,
                            onClick: this.toggleAutoCookieConsent,
                        },
                        {
                            key: "toggleRedditGalleryExpand",
                            text: "Reddit Gallery Expand",
                            iconProps: { iconName: this.state.redditGalleryExpandEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.redditGalleryExpandEnabled,
                            onClick: this.toggleRedditGalleryExpand,
                        },
                        {
                            key: "toggleRedditSingleImageExpand",
                            text: "Reddit Einzelbild Expand",
                            iconProps: { iconName: this.state.redditSingleImageExpandEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.redditSingleImageExpandEnabled,
                            onClick: this.toggleRedditSingleImageExpand,
                        },
                        {
                            key: "togglePersistCookies",
                            text: "Cookies speichern (Login)",
                            iconProps: { iconName: (this.props.source.persistCookies || false) ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.props.source.persistCookies || false,
                            disabled: !this.isWebpageMode,
                            onClick: this.togglePersistCookies,
                        },
                        {
                            key: "toggleInputMode",
                            text: this.state.inputModeEnabled 
                                ? "Eingabe-Modus beenden (Ctrl+I)" 
                                : "Eingabe-Modus (Ctrl+I)",
                            iconProps: { iconName: this.state.inputModeEnabled ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.state.inputModeEnabled,
                            disabled: !this.isWebpageMode,
                            onClick: () => {
                                const newValue = !this.state.inputModeEnabled;
                                // Cookies speichern beim Verlassen des Eingabe-Modus
                                if (!newValue && this.props.source.persistCookies && this.isWebpageMode) {
                                    this.savePersistedCookies();
                                }
                                this.setInputMode(newValue);
                            },
                        },
                        {
                            key: "openAppDevTools",
                            text: "App Developer Tools",
                            iconProps: { iconName: "Code" },
                            onClick: () => {
                                if ((window as any).ipcRenderer) {
                                    (window as any).ipcRenderer.invoke('toggle-app-devtools')
                                }
                            },
                        },
                        {
                            key: "openContentDevTools",
                            text: "Artikel Developer Tools",
                            iconProps: { iconName: "FileHTML" },
                            onClick: () => {
                                if (window.contentViewPool) {
                                    window.contentViewPool.openDevTools()
                                }
                            },
                        },
                    ],
                },
            },
        )
        
        return {
            items: items,
            onMenuOpened: () => this.handleFluentMenuOpened(),
            onMenuDismissed: () => this.handleFluentMenuDismissed(),
        }
    }

    contextMenuHandler = (pos: [number, number], text: string, url: string) => {
        if (pos) {
            if (text || url) {
                this.props.textMenu(pos, text, url)
            } else {
                this.props.imageMenu(pos)
            }
        } else {
            this.props.dismissContextMenu()
        }
    }

    keyUpHandler = (input: Electron.Input) => {
        if (input.type === "keyUp")
        {
            if(input.control)
            {
            }
        }
    }

    // Track input mode locally for synchronous access (setState is async)
    private localInputModeEnabled: boolean = false;
    
    // Timestamp when ESC exited input mode - blocks subsequent ESC from dismissing
    private inputModeExitTime: number = 0;
    private static readonly INPUT_MODE_EXIT_GRACE_PERIOD = 200; // ms to block ESC after exiting input mode
    
    keyDownHandler = (input: Electron.Input) => {
        // Build key string with modifiers for accurate debounce comparison
        const keyWithMods = this.buildKeyWithModifiers(input.key, input.control, input.shift, input.alt, input.meta)
        
        // Unified Key Debounce: Block if same key was processed recently
        // (either by this handler or by globalKeydownListener)
        if (this.isDuplicateKey(keyWithMods)) {
            return
        }

        if (input.type === "keyDown") {
            // Eingabe-Modus Toggle: Ctrl+I
            if (input.control && (input.key === 'i' || input.key === 'I')) {
                this.markKeyProcessed(keyWithMods)
                const newValue = !this.localInputModeEnabled;
                console.log(`[Article] Input mode toggle: ${this.localInputModeEnabled} -> ${newValue}`)
                // Cookies speichern beim Verlassen des Eingabe-Modus (z.B. nach Login)
                if (!newValue && this.props.source.persistCookies && this.isWebpageMode) {
                    this.savePersistedCookies();
                }
                this.setInputMode(newValue);
                return;
            }
            
            // Im Eingabe-Modus: nur Escape und Ctrl+I erlauben
            if (this.localInputModeEnabled) {
                if (input.key === 'Escape') {
                    console.log(`[Article] Escape in input mode - exiting input mode`)
                    this.markKeyProcessed(keyWithMods)
                    this.inputModeExitTime = Date.now(); // Record exit time
                    this.setInputMode(false);
                    // Cookies speichern beim Verlassen des Eingabe-Modus (z.B. nach Login)
                    if (this.props.source.persistCookies && this.isWebpageMode) {
                        this.savePersistedCookies();
                    }
                    return;
                }
                // Alle anderen Tasten zum ContentView durchlassen (nicht als Shortcuts behandeln)
                return;
            }
            
            // Grace period: Block ESC shortly after exiting input mode
            // This prevents duplicate ESC events from closing the view
            if (input.key === 'Escape' && this.inputModeExitTime > 0) {
                const timeSinceExit = Date.now() - this.inputModeExitTime;
                if (timeSinceExit < Article.INPUT_MODE_EXIT_GRACE_PERIOD) {
                    console.log(`[Article] ESC blocked - grace period after input mode exit (${timeSinceExit}ms < ${Article.INPUT_MODE_EXIT_GRACE_PERIOD}ms)`)
                    return;
                }
            }
            
            switch (input.key) {
                case "Escape":
                    this.props.dismiss()
                    break
                case "F5":
                    // Forward F5 to main window to trigger feed refresh
                    // The nav component listens for F5 on document.keydown
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5' }))
                    break
                case "ArrowLeft":
                case "ArrowRight":
                    // Ignore key repeat (held key) for article navigation
                    if (!input.isAutoRepeat) {
                        // Navigation Lock: DISABLED FOR TESTING
                        // The central debounce in showOffsetItem should handle duplicates
                        // if (this.isNavigating) {
                        //     console.log(`[Article] Navigation locked - ignoring ${input.key}`)
                        //     return
                        // }
                        this.markKeyProcessed(keyWithMods)
                        // this.setNavigationLock(true)
                        
                        // NOTE: "Pre-navigation card focus" workaround was REMOVED.
                        // It was interfering with the Focus Guard system - the FocusZone
                        // in the article list would capture focus and not release it to
                        // the new WebContentsView. The Focus Guard now handles focus
                        // restoration for background view events, making this workaround
                        // unnecessary and counterproductive.
                        
                        // Request focus restoration after navigation via IPC
                        // Use requestAnimationFrame for faster focus restoration (less visible)
                        requestAnimationFrame(() => {
                            window.contentViewPool?.focus()
                        })
                        
                        console.log(`[Article] Arrow key navigation: ${input.key}, current index: ${this.props.articleIndex}`)
                        this.props.offsetItem(input.key === "ArrowLeft" ? -1 : 1)
                    }
                    break
                case "l":
                case "L":
                    this.markKeyProcessed(keyWithMods)
                    this.toggleWebpage()
                    break
                case "+":
                case "=":
                    // Zoom: Ctrl+Plus = fine step (0.1 = 1%), Plus alone = normal step (1 = 10%)
                    // Allow key repeat for continuous zoom when holding the key
                    // No debounce needed - zoom is only handled here (not in globalKeydownListener)
                    {
                        const stepPlus = input.control ? 0.1 : 1
                        this.applyZoom(this.currentZoom + stepPlus)
                    }
                    break
                case "-":
                case "_":
                    // Zoom: Ctrl+Minus = fine step (0.1 = 1%), Minus alone = normal step (1 = 10%)
                    // Allow key repeat for continuous zoom when holding the key
                    {
                        const stepMinus = input.control ? 0.1 : 1
                        this.applyZoom(this.currentZoom - stepMinus)
                    }
                    break
                case "#":
                    // Reset zoom to 100%
                    this.applyZoom(0)
                    break
                case "w":
                case "W":
                    this.markKeyProcessed(keyWithMods)
                    this.toggleFull()
                    break
                case "m":
                case "M":
                    // Shift+M: Toggle Read/Unread
                    // m alone: Toggle Mobile Mode
                    this.markKeyProcessed(keyWithMods)
                    if (input.shift) {
                        this.props.toggleHasRead(this.props.item)
                    } else {
                        this.toggleMobileMode()
                    }
                    break
                case "p":
                case "P":
                    // Toggle Visual Zoom
                    this.markKeyProcessed(keyWithMods)
                    this.toggleVisualZoom()
                    break
                case "H":
                case "h":
                    if (!input.meta) {
                        this.markKeyProcessed(keyWithMods)
                        this.props.toggleHidden(this.props.item)
                    }
                    break
                default:
                    const keyboardEvent = new KeyboardEvent("keydown", {
                        code: input.code,
                        key: input.key,
                        shiftKey: input.shift,
                        altKey: input.alt,
                        ctrlKey: input.control,
                        metaKey: input.meta,
                        repeat: input.isAutoRepeat,
                        bubbles: true,
                    })
                    this.props.shortcuts(this.props.item, keyboardEvent)
                    document.dispatchEvent(keyboardEvent)
                    break
            }
        }
    }

    // Note: Legacy loading methods removed
    // ContentView handles loading events via setupPoolListeners()
    
    contentError = (reason: string) => {
        this.setState({ error: true, errorDescription: reason })
    }
    
    contentReload = () => {
        // Use ContentView Pool reload
        if (window.contentViewPool) {
            this.setState({ loaded: false, error: false })
            window.contentViewPool.reload()
        } else if (this.isFullContentMode) {
            this.loadFull()
        }
    }

    componentDidMount = () => {
        this._isMounted = true
        // Load app path for ContentView article.html loading
        if (!this.state.appPath && (window as any).ipcRenderer) {
            (window as any).ipcRenderer.invoke('get-app-path').then((path: string) => {
                if (path) {
                    this.setState({ appPath: path })
                }
            }).catch((err: any) => {
                console.error("[componentDidMount] Failed to get app path:", err)
            })
        }
        
        // Content View Pool is now always used - no feature flag check needed
        if (window.contentViewPool) {
            console.log("[Article] Using Content View Pool")
            // Set initial mobile mode to pool
            window.contentViewPool.setMobileMode(this.localMobileMode);
        } else {
            console.warn("[Article] Content View Pool not available!")
        }
        
        // Set global Mobile Mode status initially (in case already enabled)
        this.setGlobalMobileMode(this.localMobileMode);
        
        // Setup Pool listeners - now for ALL modes (not just Webpage)
        if (this.state.visualZoomEnabled) {
            this.setupPoolListeners()
        }
        
        // Note: ContentView restoration is handled by explicit click on blur placeholder
        
        // Load persisted cookies on first mount
        if (this.props.source.persistCookies) {
            this.loadPersistedCookies()
        }
        
        // Load full content if needed
        if (this.isFullContentMode && !this.state.fullContent) {
            this.loadFull()
        }
        
        // Keyboard state tracking for zoom
        this.pressedZoomKeys = new Set<string>()
        // Use feed zoom as starting value
        this.currentZoom = this.props.source.defaultZoom || 0
        
        // Remove old listeners if present
        if (this.globalKeydownListener) {
            document.removeEventListener('keydown', this.globalKeydownListener)
        }
        if (this.globalKeyupListener) {
            document.removeEventListener('keyup', this.globalKeyupListener)
        }
        
        // Global keyboard listener for zoom (also outside ContentView)
        // NOTE: Zoom keys (+, -, #) are now ONLY handled via IPC from ContentView
        // This prevents duplicate zoom events when ContentView is focused
        // Zoom will only work when ContentView has focus - this is intentional
        this.globalKeydownListener = (e: KeyboardEvent) => {
            // Zoom keys are handled exclusively by IPC from ContentView (keyDownHandler)
            // Do NOT handle them here to prevent duplicate zoom events
            const isZoomKey = (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '#')
            if (isZoomKey) {
                // Let the event pass through - it will be handled by ContentView via IPC
                // or ignored if ContentView doesn't have focus
                return
            }
            
            // Other global keys can be handled here if needed in the future
        }
        
        this.globalKeyupListener = (e: KeyboardEvent) => {
            this.pressedZoomKeys.delete(e.key)
        }
        
        document.addEventListener('keydown', this.globalKeydownListener)
        document.addEventListener('keyup', this.globalKeyupListener)
        
        // Note: Legacy WebView code removed - ContentView is the only display method
        // ContentView is initialized via ref callback in render()
        
        // Scroll to current article card in feed list (use false to prevent centering/wobble)
        let card = document.querySelector(
            `#refocus div[data-iid="${this.props.item._id}"]`
        ) as HTMLElement
        if (card) this.scrollCardIntoViewStable(card)
    }
    componentDidUpdate = (prevProps: ArticleProps, prevState: ArticleState) => {
        if (prevProps.item._id != this.props.item._id) {
            // Article changed - DO NOT release navigation lock here!
            // The lock is released by cvp-navigation-complete IPC when the view is actually ready.
            // Releasing here would allow another arrow key press before the navigation completes.
            
            // Reset error state on article change
            if (this.state.error) {
                this.setState({ error: false, errorDescription: "" });
            }
            
            // Reset input mode on article change
            if (this.state.inputModeEnabled) {
                this.setInputMode(false);
            }
            // Reset input mode exit time on article change
            this.inputModeExitTime = 0;
            
            // Scroll feed list to new article (use stable scroll to prevent wobble at edges)
            const card = document.querySelector(
                `#refocus div[data-iid="${this.props.item._id}"]`
            ) as HTMLElement
            if (card) this.scrollCardIntoViewStable(card)
            
            // Cookies des alten Artikels speichern (falls persistCookies aktiviert war)
            if (prevProps.source.persistCookies) {
                window.utils.savePersistedCookies(prevProps.item.link).catch(e => {
                    console.error("[CookiePersist] Error saving on article change:", e)
                })
            }
            
            // Synchronize local Mobile Mode state ONLY when switching to a different source
            // Don't reset if same source - user may have just toggled Mobile Mode
            const isSameSource = prevProps.source.sid === this.props.source.sid
            if (!isSameSource) {
                this.localMobileMode = this.props.source.mobileMode || false;
            }
            
            // IMPORTANT: Set global Mobile Mode status BEFORE new ContentView is initialized!
            // Main process then automatically applies emulation on 'did-attach'.
            this.setGlobalMobileMode(this.localMobileMode);
            
            // Synchronize currentZoom immediately on article change
            // Use CURRENT zoom (this.currentZoom), not the stored one from props
            // The stored props.source.defaultZoom may be outdated if user just zoomed
            // Only when switching to a DIFFERENT source, we use the stored value
            
            // DEBUG: Log all zoom-related values via IPC
            window.contentViewPool?.debugLog?.(`[Article] componentDidUpdate: prev.sid=${prevProps.source.sid} prev.zoom=${prevProps.source.defaultZoom} | this.sid=${this.props.source.sid} this.zoom=${this.props.source.defaultZoom} | currentZoom=${this.currentZoom} | isSameSource=${isSameSource}`)
            
            const savedZoom = isSameSource 
                ? this.currentZoom  // Same source: keep current zoom
                : (this.props.source.defaultZoom || 0)  // Different source: use stored zoom
            
            window.contentViewPool?.debugLog?.(`[Article] savedZoom (will use): ${savedZoom}`)
            
            this.currentZoom = savedZoom
            this.setState({ zoom: savedZoom })
            
            // Close DevTools before article change to prevent crash
            // closeDevTools is safe to call even if DevTools is not opened
            try {
                window.contentViewPool?.closeDevTools()
            } catch {}
            
            // Load cookies for new article (if persistCookies is enabled)
            if (this.props.source.persistCookies) {
                this.loadPersistedCookies()
            }
            
            const newContentMode = this.props.source.openTarget
            this.setState({
                contentMode: newContentMode,
                fullContent: "",
                isLoadingFull: false,
            }, () => {
                if (newContentMode === SourceOpenTarget.FullContent) {
                    this.setState({ isLoadingFull: true })
                    this.loadFull()
                } else if (newContentMode === SourceOpenTarget.Webpage) {
                    // For webpage mode - Navigate to URL (Pool)
                    const targetUrl = this.props.item.link;
                    if (this.contentViewCurrentUrl !== targetUrl) {
                        this.navigateToContent(targetUrl);
                    }
                    // Focus ContentView for keyboard input (with delay to ensure it's ready)
                    setTimeout(() => {
                        if (window.contentViewPool) {
                            window.contentViewPool.focus();
                        }
                    }, 100);
                } else {
                    // For Local (RSS) mode - Load HTML (Pool)
                    const htmlDataUrl = this.articleView();
                    this.navigateToContent(htmlDataUrl);
                    // Focus ContentView
                    setTimeout(() => {
                        if (window.contentViewPool) {
                            window.contentViewPool.focus();
                        }
                    }, 100);
                    // CSS zoom for non-Visual-Zoom mode is handled by preload via sync IPC
                    // No need for separate applyZoom call anymore!
                }
            })
        } else if (prevProps.source.openTarget !== this.props.source.openTarget) {
            // If openTarget changes from OUTSIDE (not from toggleWebpage/toggleFull), update the state
            // Skip if we're currently toggling mode (to prevent race conditions)
            if (this._isTogglingMode) {
                return
            }
            
            const targetContentMode = this.props.source.openTarget
            
            // Only update if state doesn't already match the target
            if (this.state.contentMode !== targetContentMode) {
                this.setState({
                    contentMode: targetContentMode,
                })
            }
        }
        
        // Handle overlay visibility changes for ContentView (Redux-based overlays)
        // Bridge Redux state changes to the centralized overlay system
        if (prevProps.overlayActive !== this.props.overlayActive) {
            this.handleReduxOverlayChange(this.props.overlayActive)
        }
        
        // Handle local P2P Share Dialog state changes
        // Bridge local component state to the centralized overlay system
        if (prevState.showP2PShareDialog !== this.state.showP2PShareDialog) {
            setOverlayVisible('p2p-share', this.state.showP2PShareDialog)
        }
        
        // Handle hamburger menu layout changes - update ContentView bounds
        // The hamburger menu doesn't overlap but changes the layout position
        if (this.usesContentView && prevProps.menuOpen !== this.props.menuOpen) {
            // Small delay to let the CSS transition complete
            setTimeout(() => {
                if (this._isMounted) {
                    this.updateContentViewBounds()
                }
            }, 300) // Match the CSS transition duration
        }
    }
    
    /**
     * Central helper to capture screenshot and hide ContentView
     * Used by all overlay/menu handlers for consistent behavior
     * @param reason - Description for logging
     * @param shouldHideCheck - Optional callback to verify we should still hide (for async timing)
     */
    private hideContentViewWithScreenshot = async (reason: string, shouldHideCheck?: () => boolean): Promise<void> => {
        if (!window.contentViewPool) return;
        if (this.contentViewHiddenForMenu) return;  // Already hidden
        
        // Check if we should proceed (for async timing safety)
        if (shouldHideCheck && !shouldHideCheck()) return;
        
        try {
            // Capture screenshot BEFORE hiding the view
            const screenshot = await window.contentViewPool.captureScreen();
            
            // Double-check we should still hide (timing race protection)
            if (shouldHideCheck && !shouldHideCheck()) return;
            if (this.contentViewHiddenForMenu) return;  // Something else already hid it
            
            // Set screenshot in state (this shows the blur placeholder)
            if (screenshot && this._isMounted) {
                this.setState({ menuBlurScreenshot: screenshot });
            }
            
            // Now hide the ContentView
            window.contentViewPool.setVisible(false);
            this.contentViewHiddenForMenu = true;
            
            console.log(`[Article] ContentView hidden with screenshot for: ${reason}`);
        } catch (error) {
            console.error(`[Article] Failed to capture screenshot for ${reason}:`, error);
            // Fall back to hiding without screenshot
            window.contentViewPool.setVisible(false);
            this.contentViewHiddenForMenu = true;
        }
    }
    
    /**
     * Centralized handler for ALL overlay visibility changes
     * Called by the overlay-visibility event listener
     * Replaces fragmented handlers: handleOverlayVisibilityChange, handleLocalDialogVisibilityChange, etc.
     */
    private handleOverlayVisibilityEvent = async (source: string, visible: boolean) => {
        if (!window.contentViewPool) return;
        
        const anyOpen = this.overlayStateManager.update(source as any, visible)
        
        if (visible && !this.contentViewHiddenForMenu) {
            // Overlay opening - hide ContentView with screenshot
            await this.hideContentViewWithScreenshot(`Overlay: ${source}`, () => this.overlayStateManager.isAnyOpen())
        } else if (!anyOpen && this.contentViewHiddenForMenu) {
            // All overlays closed - restore ContentView
            this.restoreContentView()
        }
    }
    
    /**
     * Handle Redux overlay visibility change for ContentView
     * Bridges Redux state changes to the centralized overlay system
     */
    private handleReduxOverlayChange = (overlayActive: boolean) => {
        // Determine which Redux overlay changed (we emit a combined event)
        setOverlayVisible('redux-settings', overlayActive)
    }
    
    /**
     * Handle Fluent UI dropdown menu opening
     * Called by onMenuOpened callback in menu props
     */
    private handleFluentMenuOpened = () => {
        setOverlayVisible('fluent-dropdown', true)
    }
    
    /**
     * Handle Fluent UI dropdown menu closing
     * Called by onMenuDismissed callback in menu props
     */
    private handleFluentMenuDismissed = () => {
        setOverlayVisible('fluent-dropdown', false)
    }
    
    // Timer for auto-restore when mouse hovers over blur placeholder
    private blurHoverTimer: NodeJS.Timeout | null = null;
    private readonly BLUR_HOVER_DELAY = 250; // ms before auto-restore
    
    /**
     * Handle click on blur placeholder to restore ContentView
     */
    private handleBlurPlaceholderClick = () => {
        this.restoreContentView()
    }
    
    /**
     * Handle mouse move over blur placeholder - starts timer for auto-restore
     */
    private handleBlurPlaceholderMouseMove = () => {
        // Reset timer on each mouse move
        if (this.blurHoverTimer) {
            clearTimeout(this.blurHoverTimer)
        }
        
        this.blurHoverTimer = setTimeout(() => {
            // Don't auto-restore if any overlay is still open
            if (this.overlayStateManager.isAnyOpen()) {
                return
            }
            this.restoreContentView()
        }, this.BLUR_HOVER_DELAY)
    }
    
    /**
     * Handle mouse leaving blur placeholder - cancel auto-restore timer
     */
    private handleBlurPlaceholderMouseLeave = () => {
        if (this.blurHoverTimer) {
            clearTimeout(this.blurHoverTimer)
            this.blurHoverTimer = null
        }
    }
    
    /**
     * Restore ContentView after overlay interaction
     */
    private restoreContentView = () => {
        if (!window.contentViewPool) return;
        if (!this.contentViewHiddenForMenu) return;
        
        // Clear hover timer
        if (this.blurHoverTimer) {
            clearTimeout(this.blurHoverTimer)
            this.blurHoverTimer = null
        }
        
        // Show Pool
        window.contentViewPool.setVisible(true);
        this.contentViewHiddenForMenu = false;
        
        // Small delay to ensure view is rendered before removing blur
        setTimeout(() => {
            if (this._isMounted) {
                this.setState({ menuBlurScreenshot: null })
            }
        }, 16)  // One frame delay
    }
    
    /**
     * Handle mouse leaving the ContentView area
     * Capture screenshot and hide ContentView to allow overlay interaction
     */
    private handleContentViewMouseLeave = async () => {
        if (!this.state.visualZoomEnabled || !this.usesContentView) return
        if (!window.contentViewPool) return
        
        await this.hideContentViewWithScreenshot('Mouse left ContentView area')
    }
    
    /**
     * Handle mouse entering the ContentView area
     * Restore ContentView when mouse returns to the area
     */
    private handleContentViewMouseEnter = () => {
        if (!this.state.visualZoomEnabled || !this.usesContentView) return
        if (!window.contentViewPool) return
        if (!this.contentViewHiddenForMenu) return  // Not hidden, nothing to do
        
        // Check if any Redux overlay is still active (menu, settings, etc.)
        if (this.props.overlayActive) {
            return
        }
        
        // Check if any Fluent UI overlay is still visible
        const fluentOverlay = document.querySelector('.ms-Layer:not(:empty), .ms-ContextualMenu, [role="menu"]')
        if (fluentOverlay) {
            return
        }
        
        window.contentViewPool.setVisible(true)
        this.contentViewHiddenForMenu = false
        
        // Clear screenshot after a short delay
        setTimeout(() => {
            if (this._isMounted && !this.contentViewHiddenForMenu) {
                this.setState({ menuBlurScreenshot: null })
            }
        }, 50)
    }
    
    /**
     * Global mouse move handler to detect when mouse enters/leaves ContentView area
     * This is needed because the ContentView (native) sits above the placeholder div
     * and captures mouse events when visible
     */
    private handleGlobalMouseMove = (e: MouseEvent) => {
        if (!this.state.visualZoomEnabled || !this.usesContentView) return
        if (!this.contentViewPlaceholderRef) return
        
        const rect = this.contentViewPlaceholderRef.getBoundingClientRect()
        const isInsideContentView = 
            e.clientX >= rect.left && 
            e.clientX <= rect.right && 
            e.clientY >= rect.top && 
            e.clientY <= rect.bottom
        
        // Only act when ContentView is hidden (for overlay access)
        // When ContentView is visible, it captures mouse events and we don't receive them here
        if (this.contentViewHiddenForMenu && isInsideContentView) {
            // Mouse moved into ContentView area while hidden - try to restore
            this.handleContentViewMouseEnter()
        }
        
        // Note: We can't detect mouse leaving when ContentView is visible
        // because the native view captures mouse events
    }
    
    private contentViewRestoreTimeout: NodeJS.Timeout | null = null
    
    // Focus ContentView after full content is loaded
    private focusContentViewAfterLoad = () => {
        if (window.contentViewPool) {
            // Check if we're waiting to focus ContentView after mode switch
            if (this.pendingContentViewFocus) {
                this.pendingContentViewFocus = false;
                // Multiple focus attempts to ensure it sticks
                window.contentViewPool.focus();
                setTimeout(() => {
                    if (window.contentViewPool && this._isMounted) {
                        window.contentViewPool.focus();
                    }
                }, 50);
                setTimeout(() => {
                    if (window.contentViewPool && this._isMounted) {
                        window.contentViewPool.focus();
                    }
                }, 200);
            } else {
                // Normal focus with small delay
                setTimeout(() => {
                    if (window.contentViewPool && this._isMounted) {
                        window.contentViewPool.focus()
                    }
                }, 100)
            }
        }
    }

    componentWillUnmount = () => {
        this._isMounted = false
        
        // Cleanup ContentView
        this.cleanupContentView()
        
        // Restore ContentView visibility if hidden for menu
        if (this.contentViewHiddenForMenu && window.contentViewPool) {
            window.contentViewPool.setVisible(true)
            this.contentViewHiddenForMenu = false
        }
        
        // Clear any pending restore timeout
        if (this.contentViewRestoreTimeout) {
            clearTimeout(this.contentViewRestoreTimeout)
            this.contentViewRestoreTimeout = null
        }
        
        // Note: No global listeners to clean up - restoration is click-based
        
        // Save cookies before component is destroyed
        if (this.props.source.persistCookies) {
            window.utils.savePersistedCookies(this.props.item.link).catch(e => {
                console.error("[CookiePersist] Error saving on unmount:", e)
            })
        }
        
        // Close DevTools before unmount to prevent crash
        // closeDevTools is safe to call even if DevTools is not opened
        try {
            window.contentViewPool?.closeDevTools()
        } catch {}
        
        let refocus = document.querySelector(
            `#refocus div[data-iid="${this.props.item._id}"]`
        ) as HTMLElement
        if (refocus) refocus.focus()
        
        // Remove global keyboard listeners
        if (this.globalKeydownListener) {
            document.removeEventListener('keydown', this.globalKeydownListener)
        }
        if (this.globalKeyupListener) {
            document.removeEventListener('keyup', this.globalKeyupListener)
        }
        
        // IPC-Listener cleanup
        if ((window as any).ipcRenderer) {
            (window as any).ipcRenderer.removeAllListeners('content-view-zoom-changed');
        }
    }

    /**
     * Stable scroll method that avoids wobble at container edges.
     * Only scrolls if the card is actually outside the visible area.
     * Uses a small margin to prevent edge-case oscillation.
     */
    scrollCardIntoViewStable = (card: HTMLElement) => {
        const scrollContainer = document.getElementById('refocus')
        if (!scrollContainer) return
        
        const containerRect = scrollContainer.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        
        // Add a small margin (5px) to prevent edge-case wobble
        const margin = 5
        
        // Check if card is already fully visible with margin
        const isAboveView = cardRect.top < containerRect.top + margin
        const isBelowView = cardRect.bottom > containerRect.bottom - margin
        
        if (isAboveView) {
            // Card is above visible area - scroll to show at top
            const scrollTop = scrollContainer.scrollTop + (cardRect.top - containerRect.top) - margin
            scrollContainer.scrollTop = Math.max(0, scrollTop)
        } else if (isBelowView) {
            // Card is below visible area - scroll to show at bottom
            const scrollTop = scrollContainer.scrollTop + (cardRect.bottom - containerRect.bottom) + margin
            scrollContainer.scrollTop = scrollTop
        }
        // If card is already visible, do nothing (prevents wobble)
    }

    toggleWebpage = () => {
        // Set flag to prevent componentDidUpdate from overriding our state changes
        this._isTogglingMode = true;
        
        if (this.isWebpageMode) {
            // Switching FROM webpage mode TO Local (RSS) mode
            // Clear tracked URL so ContentView will reload with new content
            this.contentViewCurrentUrl = null;
            
            // Capture source BEFORE setState to avoid stale reference
            const sourceSnapshot = this.props.source;
            
            this.setState({ contentMode: SourceOpenTarget.Local, contentVisible: false }, async () => {
                // Switch back to Local (RSS) mode and persist
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.Local
                )
                // Nuke the view before re-initializing (clean slate for mode switch)
                if (window.contentViewPool) {
                    await window.contentViewPool.nuke();
                }
                // Re-initialize ContentView with RSS content
                this.initializeContentView();
                
                // Clear toggle flag after a short delay to allow Redux updates to settle
                setTimeout(() => { this._isTogglingMode = false; }, 500);
            })
        } else if (
            this.props.item.link.startsWith("https://") ||
            this.props.item.link.startsWith("http://")
        ) {
            // Switching TO webpage mode
            // Clear tracked URL so ContentView will load the webpage
            this.contentViewCurrentUrl = null;
            
            // Capture source BEFORE setState to avoid stale reference
            const sourceSnapshot = this.props.source;
            
            this.setState({ contentMode: SourceOpenTarget.Webpage, contentVisible: false }, async () => {
                // Update source to persist openTarget
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.Webpage
                )
                // Nuke the view before re-initializing (clean slate for mode switch)
                if (window.contentViewPool) {
                    await window.contentViewPool.nuke();
                }
                // Re-initialize ContentView with webpage URL
                this.initializeContentView();
                
                // Clear toggle flag after a short delay to allow Redux updates to settle
                setTimeout(() => { this._isTogglingMode = false; }, 500);
            })
        } else {
            // URL doesn't start with http/https, clear the flag
            this._isTogglingMode = false;
        }
    }

    toggleFull = () => {
        // Set flag to prevent componentDidUpdate from overriding our state changes
        this._isTogglingMode = true;
        
        if (this.isFullContentMode) {
            // Switching FROM Full Content TO Local (RSS raw)
            // Clear tracked URL so ContentView will reload with new content
            this.contentViewCurrentUrl = null;
            
            // Capture source BEFORE setState to avoid stale reference
            const sourceSnapshot = this.props.source;
            
            this.setState({ contentMode: SourceOpenTarget.Local, contentVisible: false }, async () => {
                // Switch back to Local (RSS) mode and persist
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.Local
                )
                // Nuke the view before re-initializing (clean slate for mode switch)
                if (window.contentViewPool) {
                    await window.contentViewPool.nuke();
                }
                // Re-initialize ContentView with RSS content
                this.initializeContentView();
                
                // Clear toggle flag after a short delay to allow Redux updates to settle
                setTimeout(() => { this._isTogglingMode = false; }, 500);
            })
        } else if (
            this.props.item.link.startsWith("https://") ||
            this.props.item.link.startsWith("http://")
        ) {
            // Switching TO FullContent mode
            // Clear tracked URL so ContentView will reload
            this.contentViewCurrentUrl = null;
            
            // Capture source BEFORE setState to avoid stale reference
            const sourceSnapshot = this.props.source;
            
            this.setState({ contentMode: SourceOpenTarget.FullContent, contentVisible: false }, async () => {
                // Update source to persist openTarget
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.FullContent
                )
                // Nuke the view before loading full content (clean slate for mode switch)
                if (window.contentViewPool) {
                    await window.contentViewPool.nuke();
                }
                // Load and extract full content
                this.loadFull()
                
                // Clear toggle flag after a short delay to allow Redux updates to settle
                setTimeout(() => { this._isTogglingMode = false; }, 500);
            })
        } else {
            // URL doesn't start with http/https, clear the flag
            this._isTogglingMode = false;
        }
    }
    loadFull = async () => {
        if (!this._isMounted) return
        
        if (this._isMounted) {
            this.setState({ loaded: false, error: false, isLoadingFull: true })
        }

        const link = this.props.item.link
        try {
            // Fetch the full webpage
            const result = await fetch(link)
            if (!result || !result.ok) throw new Error("Failed to fetch URL")
            const html = await decodeFetchResponse(result, true)
            
            // Use article-extractor via IPC to extract clean article content
            const article = await window.articleExtractor.extractFromHtml(html, link)
            
            if (link === this.props.item.link) {
                // If extraction successful, use extracted content; otherwise use fallback
                let contentToUse = (article && article.content) ? article.content : null
                
                // Store extractor metadata (title and date) for better alignment
                let extractorTitle = article?.title || undefined
                let extractorDate = article?.published ? new Date(article.published) : undefined
                
                // Check if extracted content contains significant template syntax
                // Some sites use Mustache/Handlebars templates that get extracted as-is
                const hasTemplates = contentToUse && /\{\{[^}]+\}\}/g.test(contentToUse)
                const templateMatches = contentToUse?.match(/\{\{[^}]+\}\}/g) || []
                const templateRatio = contentToUse ? (templateMatches.join('').length / contentToUse.length) : 0
                
                // Fallback: if extractor produces no content OR content is mostly templates
                if (!contentToUse || contentToUse.length === 0 || (hasTemplates && templateRatio > 0.05)) {
                    contentToUse = this.fallbackExtractContent(html)
                }
                
                // Always clean up the content to remove duplicates (both extractor and fallback)
                contentToUse = this.cleanDuplicateContent(contentToUse)
                
                // Wrap extracted content in semantic <article> structure
                const escapeHtml = (text: string) => {
                    const div = document.createElement('div')
                    div.textContent = text
                    return div.innerHTML
                }
                
                const dateStr = extractorDate ? extractorDate.toLocaleDateString("de-DE", { 
                    year: "numeric", 
                    month: "long", 
                    day: "numeric" 
                }) : ""
                
                const headerHtml = extractorTitle ? `
                    <header>
                        <h1>${escapeHtml(extractorTitle)}</h1>
                        ${dateStr ? `<p><time datetime="${extractorDate?.toISOString()}">${dateStr}</time></p>` : ""}
                    </header>
                ` : ""
                
                const footerHtml = `
                    <footer>
                        <p>Quelle: <a href="${escapeHtml(this.props.item.link)}" target="_blank">${escapeHtml(new URL(this.props.item.link).hostname)}</a></p>
                    </footer>
                `
                
                contentToUse = `
                    <article>
                        ${headerHtml}
                        <section>${contentToUse}</section>
                        ${footerHtml}
                    </article>
                `
                
                if (this._isMounted) {
                    this.setState({ 
                        fullContent: contentToUse, 
                        loaded: false, // Will be set true after ContentView loads
                        isLoadingFull: false,
                        contentVisible: false, // Will be set true after ContentView initializes
                        extractorTitle: extractorTitle,
                        extractorDate: extractorDate
                    }, () => {
                        // Apply saved zoom level
                        const savedZoom = this.props.source.defaultZoom || 0
                        this.currentZoom = savedZoom
                        // Re-initialize ContentView with the new full content
                        this.initializeContentView()
                    })
                }
            }
        } catch (err) {
            console.error("Article loading failed:", err)
            if (link === this.props.item.link && this._isMounted) {
                // Fallback to item content on error
                this.setState({ 
                    fullContent: this.props.item.content,
                    loaded: false,
                    error: true,
                    errorDescription: "ARTICLE_EXTRACTION_FAILURE",
                    isLoadingFull: false,
                    contentVisible: false,
                    extractorTitle: undefined,
                    extractorDate: undefined
                }, () => {
                    // Apply saved zoom level
                    const savedZoom = this.props.source.defaultZoom || 0
                    this.currentZoom = savedZoom
                    // Re-initialize ContentView with fallback content
                    this.initializeContentView()
                })
            }
        }
    }

    // Fallback content extraction if extractor fails
    private fallbackExtractContent = (html: string): string => {
        try {
            const parser = new DOMParser()
            const doc = parser.parseFromString(html, 'text/html')
            
            // Remove common non-content elements
            doc.querySelectorAll('script, style, noscript, nav, header, footer, [data-ad-container], .advertisement, .ads, .sidebar').forEach(el => el.remove())
            
            // Helper to check if text contains significant template syntax
            // (Mustache/Handlebars templates like {{title}}, {{#posts}}, {{/posts}})
            const hasTemplateContent = (text: string): boolean => {
                if (!text) return false
                // Count template tags
                const templateMatches = text.match(/\{\{[^}]+\}\}/g)
                if (!templateMatches) return false
                
                // Calculate ratio of template content to total text
                const templateLength = templateMatches.join('').length
                const textLength = text.length
                
                // If more than 10% of the text is template syntax, it's template-heavy
                return templateLength / textLength > 0.1
            }
            
            // Helper to strip template syntax from content
            const stripTemplates = (content: string): string => {
                // Remove Mustache/Handlebars block tags: {{#...}}, {{/...}}, {{^...}}
                content = content.replace(/\{\{[#/^][^}]+\}\}/g, '')
                // Remove Mustache/Handlebars variable tags: {{variable}}
                content = content.replace(/\{\{[^}]+\}\}/g, '')
                // Clean up extra whitespace from removed templates
                content = content.replace(/\s{3,}/g, ' ')
                return content
            }
            
            // Remove elements that are mostly template syntax (JavaScript-rendered content)
            doc.querySelectorAll('*').forEach(el => {
                const text = el.textContent || ''
                // If the element contains mostly template syntax and no meaningful text,
                // it's probably a JS-rendered component placeholder
                if (hasTemplateContent(text) && el.children.length === 0) {
                    el.remove()
                }
            })
            
            // Find main content container
            const selectors = [
                'article',
                '[role="main"]',
                'main',
                '.article-content',
                '.post-content',
                '.entry-content',
                '[class*="main-content"]',
                '[id*="main"]'
            ]
            
            for (const selector of selectors) {
                const el = doc.querySelector(selector)
                if (el && el.textContent) {
                    const text = el.textContent.trim()
                    // Skip if mostly template content
                    if (hasTemplateContent(text)) continue
                    // Need at least 300 chars of real content
                    if (text.length > 300) {
                        return stripTemplates(el.innerHTML)
                    }
                }
            }
            
            // Last resort: return body with templates stripped
            const bodyHtml = doc.body.innerHTML
            const strippedBody = stripTemplates(bodyHtml)
            
            // If the result is mostly empty after stripping templates, return a message
            const strippedText = doc.body.textContent || ''
            if (strippedText.replace(/\s/g, '').length < 100) {
                return `<p><em>Diese Seite verwendet JavaScript zum Rendern des Inhalts. 
                Der vollständige Inhalt kann nicht extrahiert werden. 
                Bitte öffne die <a href="${this.props.item.link}" target="_blank">Originalseite</a>.</em></p>`
            }
            
            return strippedBody
        } catch (err) {
            console.error("Fallback extraction failed:", err)
            return html
        }
    }



    // Clean up duplicate content in extracted HTML
    private cleanDuplicateContent = (html: string): string => {
        try {
            const parser = new DOMParser()
            const doc = parser.parseFromString(html, 'text/html')
            
            // Remove script/style tags
            doc.querySelectorAll('script, style, noscript').forEach(el => el.remove())
            
            // ===== DUPLICATE IMAGE REMOVAL =====
            // Track seen image sources to remove duplicates (e.g., from fancybox links)
            const seenImageSrcs = new Set<string>()
            
            // Helper to normalize image URLs for comparison
            // Uses host + pathname (without query params) to identify duplicates
            const normalizeImageUrl = (url: string): string => {
                try {
                    const u = new URL(url, 'http://dummy')
                    // Use host + pathname for comparison (ignore query params)
                    // This correctly identifies duplicates across same domain
                    return (u.host + u.pathname).toLowerCase()
                } catch {
                    return url.toLowerCase()
                }
            }
            
            // First pass: collect all unique image sources and remove duplicates
            const allImages = Array.from(doc.querySelectorAll('img'))
            
            allImages.forEach((img) => {
                const src = img.getAttribute('src')
                if (src) {
                    const normalized = normalizeImageUrl(src)
                    
                    if (seenImageSrcs.has(normalized)) {
                        // Duplicate image - remove the element
                        // If it's inside a link that only contains this image, remove the link too
                        const parent = img.parentElement
                        if (parent?.tagName === 'A' && parent.children.length === 1) {
                            parent.remove()
                        } else {
                            img.remove()
                        }
                    } else {
                        seenImageSrcs.add(normalized)
                    }
                }
            })
            
            // Second pass: Unwrap fancybox/lightbox links (remove link, keep image)
            // These often have the image both as href AND as img src inside
            doc.querySelectorAll('a.fancybox, a[data-fancybox], a[data-lightbox], a[rel="lightbox"]').forEach((link) => {
                const href = link.getAttribute('href')
                if (href) {
                    const normalizedHref = normalizeImageUrl(href)
                    const innerImg = link.querySelector('img')
                    if (innerImg) {
                        const innerSrc = innerImg.getAttribute('src')
                        if (innerSrc && normalizeImageUrl(innerSrc) === normalizedHref) {
                            // The link and image point to the same file - unwrap the link, keep just the image
                            link.replaceWith(innerImg)
                        }
                    }
                }
            })
            
            // Remove empty/junk elements (but preserve elements with images!)
            doc.querySelectorAll('div, section').forEach((div) => {
                const text = (div as HTMLElement).textContent || ''
                const innerHTML = (div as HTMLElement).innerHTML || ''
                
                // Check if element contains images - don't remove containers with images
                const hasImages = div.querySelector('img, picture, video, iframe') !== null
                
                // Remove if mostly empty AND has no images, or contains tracking params with no text
                if (text.trim().length === 0 && !hasImages) {
                    div.remove()
                } else if ((innerHTML.includes('?a=') || innerHTML.includes('?utm_') || innerHTML.includes('?ref=')) && text.trim().length < 50 && !hasImages) {
                    div.remove()
                }
            })
            
            return doc.body.innerHTML
        } catch (err) {
            console.error("Content cleaning failed:", err)
            return html
        }
    }

    // Prepend feed summary/teaser to extracted article for context
    private prependFeedSummary = (extractedContent: string, extractorTitle?: string): string => {
        try {
            const feedContent = this.props.item.content
            if (!feedContent || feedContent.length === 0) {
                return extractedContent
            }

            // Parse extracted content to get plain text for title comparison
            const parser = new DOMParser()
            const extractedDoc = parser.parseFromString(extractedContent, 'text/html')
            const extractedTextContent = extractedDoc.body.textContent?.toLowerCase() || ''
            
            // Check if RSS title is already in extracted content (using plain text comparison)
            const rssTitle = this.props.item.title
            const rssTitleNormalized = rssTitle.toLowerCase().replace(/\s+/g, ' ').trim()
            const extractorTitleNormalized = extractorTitle?.toLowerCase().replace(/\s+/g, ' ').trim()
            
            // Normalize extracted text for comparison (collapse whitespace)
            const extractedTextNormalized = extractedTextContent.replace(/\s+/g, ' ')
            
            const titleInExtractor = extractorTitleNormalized && extractedTextNormalized.includes(extractorTitleNormalized)
            const rssInContent = extractedTextNormalized.includes(rssTitleNormalized)
            
            // Parse feed content to extract images and text
            const feedDoc = parser.parseFromString(feedContent, 'text/html')

            // Extract the first image from feed summary
            let summaryHtml = ""
            const firstImg = feedDoc.querySelector('img')
            if (firstImg) {
                summaryHtml += firstImg.outerHTML
            }

            // Extract first paragraph or meaningful text from feed
            const firstP = feedDoc.querySelector('p')
            if (firstP && firstP.textContent && firstP.textContent.trim().length > 20) {
                summaryHtml += `<p><em>${firstP.textContent.trim()}</em></p>`
            }

            // Create separator - no inline styles, let CSS handle it
            const separator = `<section><hr style="border: none; border-top: 4px solid #0078d4; margin: 0 0 12px 0; padding: 0; height: 0;"><p style="text-align: center; color: #0078d4; font-style: italic; font-size: 0.85em; margin: 0;">— RSS-Zusammenfassung endet hier —</p></section>`

            // If title is already present in extracted content, skip RSS summary but show separator
            if (titleInExtractor || rssInContent) {
                return separator + extractedContent
            }

            // If we found summary content, prepend it with separator
            if (summaryHtml) {
                // Wrap RSS summary - no extra styling, let article CSS handle everything
                const summary = `<div>${summaryHtml}</div>${separator}`
                return summary + extractedContent
            }

            // No summary content found, just show separator
            return separator + extractedContent
        } catch (err) {
            console.error("Feed summary extraction failed:", err)
            return extractedContent
        }
    }

    // Extract best image from original HTML as teaser/hero image
    private extractTeaserImageFromHtml = (html: string): string => {
        try {
            const parser = new DOMParser()
            const doc = parser.parseFromString(html, 'text/html')

            // Collect all images with scoring
            const images: Array<{ html: string; score: number; src: string }> = []

            doc.querySelectorAll('img, picture').forEach((element) => {
                let score = 0
                let imgHtml = ""
                let src = ""

                if (element.tagName === "IMG") {
                    const img = element as HTMLImageElement
                    src = img.src
                    imgHtml = img.outerHTML

                    // Score based on attributes
                    const width = img.width || parseInt(img.getAttribute('width') || '0')
                    const height = img.height || parseInt(img.getAttribute('height') || '0')
                    const alt = img.alt || ""
                    const dataSize = img.getAttribute('data-src') ? 1 : 0

                    // Larger images score higher
                    if (width > 300) score += 10
                    if (width > 600) score += 15
                    if (height > 300) score += 10
                    if (height > 600) score += 15

                    // Alt text indicates intentional image
                    if (alt.length > 10) score += 8
                    if (alt.includes("article") || alt.includes("teaser")) score += 5

                    // Aspect ratio close to 16:9 or 4:3 is better for hero images
                    if (width > 0 && height > 0) {
                        const ratio = width / height
                        if ((ratio > 1.3 && ratio < 2.0) || (ratio > 0.66 && ratio < 0.77)) {
                            score += 5
                        }
                    }

                    // Avoid tiny images
                    if (width < 100 || height < 100) score = 0

                    // Avoid images with tracking-like names
                    if (src.includes("pixel") || src.includes("tracker") || src.includes("analytics")) score = 0
                } else if (element.tagName === "PICTURE") {
                    const picture = element as HTMLElement
                    const img = picture.querySelector('img')
                    if (img) {
                        src = img.src
                        imgHtml = picture.outerHTML
                        // Pictures are usually intentional hero images
                        score = 20
                    }
                }

                if (score > 0 && src) {
                    images.push({ html: imgHtml, score, src })
                }
            })

            // Sort by score and get best image
            if (images.length > 0) {
                images.sort((a, b) => b.score - a.score)
                const bestImage = images[0]
                return bestImage.html
            }

            return ""
        } catch (err) {
            console.error("Teaser image extraction failed:", err)
            return ""
        }
    }

    articleView = () => {
        // For Local Mode (RSS content), use the simplified normalized HTML
        if (!this.isFullContentMode) {
            return this.generateArticleHtml(this.props.item, this.props.source);
        }
        
        // FullContent Mode - use full HTML structure with extractor content
        const articleContent = this.state.fullContent

        // Content analysis for comic/image mode
        const imgCount = (articleContent.match(/<img/gi) || []).length
        const pictureCount = (articleContent.match(/<picture/gi) || []).length
        const totalImages = imgCount + pictureCount
        
        // Extract text without HTML tags to determine pure text length
        const textOnly = articleContent.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
        const textLength = textOnly.length
        
        // Comic-Modus: Wenig Text (< 200 Zeichen) und mindestens ein Bild
        // Oder: Nur Bilder ohne nennenswerten Text
        const isComicMode = totalImages > 0 && textLength < 200
        const isSingleImage = totalImages === 1 && textLength < 100

        // Use extractor metadata if available (better alignment with extracted content)
        const displayTitle = this.isFullContentMode && this.state.extractorTitle ? this.state.extractorTitle : this.props.item.title
        const displayDate = this.isFullContentMode && this.state.extractorDate ? this.state.extractorDate : this.props.item.date

        // When showing full content with extractor metadata, don't show duplicate header in main
        // (it's already in the <article> structure)
        const headerContent = renderToString(
            <>
                {!(this.isFullContentMode && this.state.extractorTitle) && (
                    <>
                        <p className="title">{displayTitle}</p>
                        <p className="date">
                            {displayDate.toLocaleString(
                                this.props.locale,
                                { hour12: !this.props.locale.startsWith("zh") }
                            )}
                        </p>
                    </>
                )}
            </>
        )

        const rtlClass = this.props.source.textDir === SourceTextDirection.RTL ? "rtl" : this.props.source.textDir === SourceTextDirection.Vertical ? "vertical" : ""
        const comicClass = isComicMode ? "comic-mode" : ""
        const singleImageClass = isSingleImage ? "single-image" : ""

        // Build HTML directly with embedded data via JSON, not via query parameters
        // CSS is fully embedded inline since data: URLs cannot load file:// resources
        const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; img-src http: https: data:; style-src 'unsafe-inline'; frame-src http: https:; media-src http: https:; connect-src https: http:">
    <title>Article</title>
    <style>
/* ====== Responsive Article Layout ====== */

/* Scrollbar Styles */
::-webkit-scrollbar { width: 16px; }
::-webkit-scrollbar-thumb { border: 2px solid transparent; background-color: #0004; background-clip: padding-box; border-radius: 8px; }
::-webkit-scrollbar-thumb:hover { background-color: #0006; }
::-webkit-scrollbar-thumb:active { background-color: #0008; }

/* CSS Variables */
:root { 
    --gray: #484644; 
    --primary: #0078d4; 
    --primary-alt: #004578;
    --bg-color: #fafafa;
    --text-color: #1a1a1a;
    --content-max-width: 1200px;
}

/* Base Styles - Block layout for proper overflow handling */
html, body { 
    margin: 0; 
    padding: 0; 
    font-family: "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg-color);
    color: var(--text-color);
}
body { 
    padding: 1rem; 
    overflow-x: hidden; 
    overflow-y: auto; 
    font-size: ${this.state.fontSize}px; 
    box-sizing: border-box;
    /* No flexbox on body - causes centering issues with large content */
}
${this.state.fontFamily ? `body { font-family: "${this.state.fontFamily}", system-ui, sans-serif; }` : ''}
body.rtl { direction: rtl; }
body.vertical { 
    writing-mode: vertical-rl; 
    padding: 1rem; 
    padding-right: 96px; 
    overflow: scroll hidden;
}
* { box-sizing: border-box; }

/* Typography */
h1, h2, h3, h4, h5, h6, b, strong { font-weight: 600; }
a { color: var(--primary); text-decoration: none; }
a:hover, a:active { color: var(--primary-alt); text-decoration: underline; }

/* Main Container - Centered with margin, max-width constraint */
#main { 
    display: none; 
    width: 100%; 
    max-width: var(--content-max-width);
    margin: 0 auto; /* Center with margin instead of flexbox */
}
body.vertical #main { 
    max-width: unset; 
    max-height: 100%; 
}
#main.show { 
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    animation: fadeIn 0.367s cubic-bezier(0.1, 0.9, 0.2, 1) both;
}
@keyframes fadeIn { 
    from { opacity: 0; transform: translateY(10px); } 
    to { opacity: 1; transform: translateY(0); } 
}

/* Title and Date - Header section */
#main > p.title { 
    font-size: 1.25rem; 
    line-height: 1.75rem; 
    font-weight: 600; 
    margin: 0;
    padding: 0 0.5rem;
}
#main > p.date { 
    color: var(--gray); 
    font-size: 0.875rem; 
    margin: 0;
    padding: 0 0.5rem;
}

/* Article Content - Gallery-style layout for images */
#main > article { 
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 0.5rem;
    padding: 0 0.5rem;
    line-height: 1.6;
}
body.vertical article { line-height: 1.5; }
body.vertical article p { text-indent: 2rem; }

/* All elements respect container width */
article * { max-width: 100%; }
#main > * { max-width: 100%; }

/* Images - Responsive gallery style */
/* Use !important to override inline width/height HTML attributes */
/* Target both images in article AND directly in #main */
article img,
#main > img { 
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important; 
    object-fit: contain;
    border-radius: 4px;
    background: #000;
}
body.vertical article img { max-height: 75%; }

/* Figures with captions */
article figure { 
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
article figure figcaption { 
    font-size: 0.875rem; 
    color: var(--gray); 
    text-align: center;
    -webkit-user-modify: read-only; 
}

/* Embedded content */
article iframe { width: 100%; border-radius: 4px; }
article video { width: 100%; height: auto; border-radius: 4px; }

/* Code blocks */
article code { 
    font-family: Monaco, Consolas, "Cascadia Code", monospace; 
    font-size: 0.875rem; 
    line-height: 1.4; 
    word-break: break-word;
    background: rgba(0,0,0,0.05);
    padding: 0.1em 0.3em;
    border-radius: 3px;
}
article pre { 
    word-break: normal; 
    overflow-wrap: normal; 
    white-space: pre-wrap; 
    max-width: 100%; 
    overflow-x: auto;
    background: rgba(0,0,0,0.05);
    padding: 1rem;
    border-radius: 4px;
}
article pre code {
    background: none;
    padding: 0;
}

/* Blockquotes */
article blockquote { 
    border-left: 3px solid var(--primary); 
    margin: 0; 
    padding: 0.5rem 1rem;
    background: rgba(0,0,0,0.02);
    border-radius: 0 4px 4px 0;
}

/* Tables */
#main table { 
    max-width: 100%; 
    overflow-x: auto;
    border-collapse: collapse;
}
#main table td, #main table th {
    padding: 0.5rem;
    border: 1px solid var(--gray);
}

/* Paragraphs in article */
article p {
    margin: 0;
}

/* ====== Dark Mode ====== */
@media (prefers-color-scheme: dark) {
    :root { 
        --gray: #a19f9d; 
        --primary: #4ba0e1; 
        --primary-alt: #65aee6;
        --bg-color: #1e1e1e;
        --text-color: #e0e0e0;
    }
    article code {
        background: rgba(255,255,255,0.1);
    }
    article pre {
        background: rgba(255,255,255,0.05);
    }
    article blockquote {
        background: rgba(255,255,255,0.03);
    }
    ::-webkit-scrollbar-thumb { background-color: #fff4; }
    ::-webkit-scrollbar-thumb:hover { background-color: #fff6; }
    ::-webkit-scrollbar-thumb:active { background-color: #fff8; }
}

/* ====== Comic Mode - Image-dominated content ====== */
.comic-mode #main {
    max-width: 100%;
    padding: 0;
    gap: 0;
}
.comic-mode article {
    gap: 0.5rem;
    padding: 0;
}
.comic-mode #main img {
    border-radius: 0;
    width: 100% !important;
    max-width: 100% !important;
    height: auto !important;
}
.comic-mode .title,
.comic-mode .date {
    text-align: center;
}
.comic-mode p {
    text-align: center;
    padding: 0 1rem;
}

/* ====== Single Image Mode ====== */
/* Note: Do NOT set max-width here - inherit the 1200px from base #main */
.single-image #main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: calc(100vh - 2rem);
}
/* When both comic-mode and single-image are active, restore max-width constraint */
.comic-mode.single-image #main {
    max-width: var(--content-max-width);
}
.single-image article {
    align-items: center;
}
.single-image #main img {
    width: 100%;
    max-width: 100%;
    height: auto;
    object-fit: contain;
}
    </style>
</head>
<body class="${rtlClass} ${comicClass} ${singleImageClass}">
    <div id="main"></div>
    <script>
window.__articleData = ${JSON.stringify({ 
    header: headerContent, 
    article: articleContent, 
    baseUrl: this.props.item.link 
}).replace(/<\/script>/gi, '<\\/script>')};

(function() {
    const { header, article, baseUrl } = window.__articleData;
    
    // Parse header and article HTML
    let domParser = new DOMParser();
    let headerDom = domParser.parseFromString(header, 'text/html');
    
    // Create main content - just use the article content as-is (no complex splitting)
    let main = document.getElementById("main");
    main.innerHTML = headerDom.body.innerHTML + article;
    
    // Set base URL for relative links
    let baseEl = document.createElement('base');
    baseEl.setAttribute('href', baseUrl.split("/").slice(0, 3).join("/"));
    document.head.append(baseEl);
    
    // Remove scripts
    for (let s of main.querySelectorAll("script")) {
        s.parentNode.removeChild(s);
    }
    
    // Remove width/height attributes from images - they prevent CSS from controlling size
    for (let img of main.querySelectorAll("img")) {
        img.removeAttribute('width');
        img.removeAttribute('height');
    }
    
    // DEBUG: Find elements that might cause horizontal overflow
    const viewportWidth = document.documentElement.clientWidth;
    let overflowElements = [];
    main.querySelectorAll('*').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > viewportWidth) {
            overflowElements.push({
                tag: el.tagName,
                class: el.className,
                width: rect.width,
                offsetWidth: el.offsetWidth,
                scrollWidth: el.scrollWidth
            });
        }
    });
    
    // Fixiere absolute URLs
    for (let e of main.querySelectorAll("*[src]")) {
        e.src = e.src;
    }
    for (let e of main.querySelectorAll("*[href]")) {
        e.href = e.href;
    }
    
    // Comic/Single-Image Mode: Unwrap images from <p> tags
    // Block-level <p> tags with width:100% break flex centering
    if (document.body.classList.contains('comic-mode') || document.body.classList.contains('single-image')) {
        main.querySelectorAll('p > img').forEach(img => {
            const p = img.parentElement;
            // Only unwrap if <p> contains only the image (and whitespace)
            const textContent = p.textContent.trim();
            const hasOnlyImage = p.children.length === 1 && textContent === '';
            if (hasOnlyImage) {
                // Replace <p> with just the <img>
                p.replaceWith(img);
            }
        });
    }
    
    // Comic-Modus: Scrolle zum ersten Bild
    if (document.body.classList.contains('comic-mode')) {
        const firstImg = main.querySelector('img');
        if (firstImg) {
            firstImg.id = 'comic-image';
            // Warte kurz bis Bilder geladen sind, dann scrolle
            setTimeout(() => {
                firstImg.scrollIntoView({ behavior: 'instant', block: 'start' });
            }, 100);
        }
    }
    
    main.classList.add("show");
})();
    </script>
</body>
</html>`

        // Convert to base64 data URL to avoid length limitations
        return `data:text/html;base64,${btoa(unescape(encodeURIComponent(htmlContent)))}`
    }

    render = () => {
        return (
        <FocusZone className="article">
            <Stack horizontal style={{ height: 36 }}>
                <span style={{ width: 96 }}></span>
                <Stack
                    className="actions"
                    grow
                    horizontal
                    tokens={{ childrenGap: 12 }}>
                    <Stack.Item grow>
                        <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
                            <span className="source-name">
                                {this.state.loaded ? (
                                    this.props.source.iconurl && (
                                        <img
                                            className="favicon"
                                            src={this.props.source.iconurl}
                                        />
                                    )
                                ) : (
                                    <Spinner size={1} />
                                )}
                                {this.props.source.name}
                                {this.props.item.creator && (
                                    <span className="creator">
                                        {this.props.item.creator}
                                    </span>
                                )}
                            </span>
                            {/* Input Mode Badge - outside source-name to avoid overflow:hidden */}
                            {this.state.inputModeEnabled && (
                                <span 
                                    className="input-mode-badge"
                                    style={{
                                        marginLeft: 8,
                                        padding: '2px 6px',
                                        backgroundColor: '#107c10',
                                        color: 'white',
                                        borderRadius: 3,
                                        fontSize: 11,
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                    }}
                                    title="Eingabe-Modus aktiv - Shortcuts deaktiviert (Escape oder Ctrl+I zum Beenden)"
                                >
                                    ⌨ EINGABE
                                </span>
                            )}
                            {/* Zoom Badge with viewport tooltip */}
                            {(this.state.zoom !== undefined && this.state.zoom !== 0) && (
                                <span 
                                    className="zoom-badge"
                                    style={{
                                        marginLeft: 8,
                                        padding: '2px 6px',
                                        backgroundColor: '#0078d4',
                                        color: 'white',
                                        borderRadius: 3,
                                        fontSize: 11,
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                        cursor: 'default',
                                    }}
                                    title={this.getViewportTooltip()}
                                >
                                    🔍 {this.getZoomDisplayText()}
                                </span>
                            )}
                            {/* View ID Badge (Debug) - Only shown in development */}
                            {process.env.NODE_ENV !== 'production' && this.state.activeViewId && (
                                <span 
                                    className="view-badge"
                                    style={{
                                        marginLeft: 8,
                                        padding: '2px 6px',
                                        backgroundColor: '#107c10',
                                        color: 'white',
                                        borderRadius: 3,
                                        fontSize: 11,
                                        fontWeight: 600,
                                        whiteSpace: 'nowrap',
                                        cursor: 'default',
                                    }}
                                    title={`Aktiver ContentView: ${this.state.activeViewId}`}
                                >
                                    📺 {this.state.activeViewId}
                                </span>
                            )}
                        </div>
                    </Stack.Item>
                    <CommandBarButton
                        title={
                            this.props.item.hasRead
                                ? intl.get("article.markUnread")
                                : intl.get("article.markRead")
                        }
                        iconProps={
                            this.props.item.hasRead
                                ? { iconName: "StatusCircleRing" }
                                : {
                                      iconName: "RadioBtnOn",
                                      style: {
                                          fontSize: 14,
                                          textAlign: "center",
                                      },
                                  }
                        }
                        onClick={() =>
                            this.props.toggleHasRead(this.props.item)
                        }
                    />
                    <CommandBarButton
                        title={
                            this.props.item.starred
                                ? intl.get("article.unstar")
                                : intl.get("article.star")
                        }
                        iconProps={{
                            iconName: this.props.item.starred
                                ? "FavoriteStarFill"
                                : "FavoriteStar",
                        }}
                        onClick={() =>
                            this.props.toggleStarred(this.props.item)
                        }
                    />
                    <CommandBarButton
                        title={
                            this.state.isLoadingFull 
                                ? intl.get("article.loadFull") + " (wird geladen...)"
                                : this.isFullContentMode 
                                    ? intl.get("article.loadFull") + " ✓ (geladen)"
                                    : intl.get("article.loadFull")
                        }
                        className={!this.isWebpageMode ? "active" : ""}
                        iconProps={{ 
                            iconName: this.state.isLoadingFull 
                                ? "Sync" 
                                : this.isFullContentMode 
                                    ? "CheckMark" 
                                    : "RawSource" 
                        }}
                        onClick={this.toggleFull}
                    />
                    <CommandBarButton
                        title={intl.get("article.loadWebpage")}
                        className={this.isWebpageMode ? "active" : ""}
                        iconProps={{ iconName: "Globe" }}
                        onClick={this.toggleWebpage}
                    />
                    <CommandBarButton
                        title={intl.get("openExternal")}
                        iconProps={{ iconName: "NavigateExternalInline" }}
                        onClick= {() =>
                            window.utils.openExternal(this.props.item.link, false)
                        }
                    />
                    <CommandBarButton
                        title={intl.get("more")}
                        iconProps={{ iconName: "More" }}
                        menuIconProps={{ style: { display: "none" } }}
                        menuProps={this.moreMenuProps()}
                    />
                </Stack>
                <Stack horizontal horizontalAlign="end" style={{ width: 112 }}>
                    <CommandBarButton
                        title={intl.get("close")}
                        iconProps={{ iconName: "BackToWindow" }}
                        onClick={this.props.dismiss}
                    />
                </Stack>
            </Stack>
            {/* Use ContentView (WebContentsView) for ALL article display modes */}
            {/* Show placeholder when: content is ready (Local, FullContent with content, or Webpage) */}
            {(this.isLocalMode || (this.isFullContentMode && this.state.fullContent) || this.isWebpageMode) ? (
                <div
                    id="article-contentview-placeholder"
                    className={this.state.error ? "error" : ""}
                    style={{ 
                        flex: 1, 
                        width: "100%",
                        position: "relative",
                        // Show placeholder when either content is visible OR we have a blur screenshot
                        visibility: (this.state.contentVisible || this.state.menuBlurScreenshot) ? "visible" : "hidden",
                        background: "var(--neutralLighter, #f3f2f1)"
                    }}
                    ref={(el) => {
                        if (el && el !== this.contentViewPlaceholderRef) {
                            // Cleanup old ResizeObserver if element changed
                            if (this.resizeObserver && this.contentViewPlaceholderRef) {
                                this.resizeObserver.disconnect();
                                this.resizeObserver = null;
                            }
                            this.contentViewPlaceholderRef = el;
                            // Initialize ContentView when placeholder is mounted
                            this.initializeContentView();
                        }
                    }}
                    // Note: onMouseEnter/Leave don't work here because the native ContentView 
                    // sits ABOVE this div and captures mouse events. We use a global mousemove
                    // listener instead (see handleGlobalMouseMove)
                >
                    {/* Blur placeholder shown when overlay is active - click or hover to restore */}
                    {this.state.menuBlurScreenshot && (
                        <div
                            id="article-blur-placeholder"
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                backgroundImage: `url(${this.state.menuBlurScreenshot})`,
                                backgroundSize: "100% 100%",
                                backgroundPosition: "top left",
                                backgroundRepeat: "no-repeat",
                                filter: "blur(1px) brightness(1.0)",
                                zIndex: 10,
                                cursor: "pointer",
                            }}
                            onClick={this.handleBlurPlaceholderClick}
                            onMouseMove={this.handleBlurPlaceholderMouseMove}
                            onMouseLeave={this.handleBlurPlaceholderMouseLeave}
                            title="Klicken oder kurz warten zum Zurückkehren"
                        />
                    )}
                    {/* Loading spinner for Visual Zoom navigation */}
                    {this.state.isNavigatingWithVisualZoom && (
                        <div
                            id="visual-zoom-loading"
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                justifyContent: "center",
                                background: "var(--neutralLighter, #f3f2f1)",
                                zIndex: 5,
                            }}
                        >
                            <Spinner 
                                size={SpinnerSize.large}
                                label="Laden..."
                                labelPosition="bottom"
                            />
                        </div>
                    )}
                </div>
            ) : (
                <Stack
                    className="loading-prompt"
                    verticalAlign="center"
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}>
                    <Spinner ariaLive="assertive" />
                </Stack>
            )}
            {this.state.error && (
                <Stack
                    className="error-prompt"
                    verticalAlign="center"
                    horizontalAlign="center"
                    tokens={{ childrenGap: 12 }}>
                    <Icon iconName="HeartBroken" style={{ fontSize: 32 }} />
                    <Stack
                        horizontal
                        horizontalAlign="center"
                        tokens={{ childrenGap: 7 }}>
                        <small>{intl.get("article.error")}</small>
                        <small>
                            <Link onClick={this.contentReload}>
                                {intl.get("article.reload")}
                            </Link>
                        </small>
                    </Stack>
                    <span style={{ fontSize: 11 }}>
                        {this.state.errorDescription}
                    </span>
                </Stack>
            )}
            
            {/* P2P Dialogs */}
            <P2PShareDialog
                hidden={!this.state.showP2PShareDialog}
                onDismiss={() => this.setState({ showP2PShareDialog: false })}
                articleTitle={this.props.item.title}
                articleLink={this.props.item.link}
                feedName={this.props.source?.name}
                feedUrl={this.props.source?.url}
                feedIconUrl={this.props.source?.iconurl}
                openTarget={this.props.source?.openTarget}
                defaultZoom={this.props.source?.defaultZoom}
            />
        </FocusZone>
        )
    }
}

export default Article
