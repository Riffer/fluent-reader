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
}

type ArticleState = {
    fontFamily: string
    fontSize: number
    contentMode: SourceOpenTarget  // Replaces loadWebpage + loadFull
    fullContent: string
    loaded: boolean
    error: boolean
    errorDescription: string
    webviewVisible: boolean
    zoom: number
    isLoadingFull: boolean
    appPath: string
    extractorTitle?: string
    extractorDate?: Date
    showZoomOverlay: boolean
    nsfwCleanupEnabled: boolean
    autoCookieConsentEnabled: boolean
    inputModeEnabled: boolean  // Eingabe-Modus: Shortcuts deaktiviert für Login etc.
    showP2PShareDialog: boolean
    visualZoomEnabled: boolean  // Visual Zoom (Pinch-to-Zoom) ohne Mobile-Modus
    menuBlurScreenshot: string | null  // Screenshot for blur placeholder when menu is open
    isNavigatingWithVisualZoom: boolean  // Show loading spinner during Visual Zoom navigation
}

class Article extends React.Component<ArticleProps, ArticleState> {
    globalKeydownListener: (e: KeyboardEvent) => void
    globalKeyupListener: (e: KeyboardEvent) => void
    pressedZoomKeys: Set<string>
    currentZoom: number = 0  // Track zoom locally to avoid state lag
    private _isMounted = false
    private _isTogglingMode = false  // Flag to prevent componentDidUpdate from overriding state during toggle
    private cookieSaveTimeout: NodeJS.Timeout | null = null  // Debounce für Cookie-Speicherung
    private lastCookieSaveTime: number = 0  // Timestamp der letzten Cookie-Speicherung
    
    // ContentView references and cleanup
    private contentViewPlaceholderRef: HTMLDivElement | null = null
    private contentViewCleanup: (() => void)[] = []
    private resizeObserver: ResizeObserver | null = null
    private contentViewHiddenForMenu: boolean = false  // Track if we hid ContentView for menu access
    private contentViewCurrentUrl: string | null = null  // Track current URL to avoid double navigation
    private pendingContentViewFocus: boolean = false  // Track if we need to focus ContentView after load
    private contentViewInitialized: boolean = false  // Track if Device Emulation is already set (for JS navigation experiment)

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
        // Initialisiere mit dem gespeicherten Feed-Zoom
        const initialZoom = props.source.defaultZoom || 0
        this.currentZoom = initialZoom
        // Initialisiere lokalen Mobile-Mode State
        this.localMobileMode = props.source.mobileMode || false
        this.state = {
            fontFamily: window.settings.getFont(),
            fontSize: window.settings.getFontSize(),
            contentMode: props.source.openTarget,  // Use enum directly
            fullContent: "",
            loaded: false,
            error: false,
            errorDescription: "",
            webviewVisible: false,
            zoom: initialZoom,
            isLoadingFull: false,
            appPath: "",
            showZoomOverlay: window.settings.getZoomOverlay(),
            nsfwCleanupEnabled: window.settings.getNsfwCleanup(),
            autoCookieConsentEnabled: window.settings.getAutoCookieConsent(),
            inputModeEnabled: false,
            showP2PShareDialog: false,
            visualZoomEnabled: window.settings.getVisualZoom(),
            menuBlurScreenshot: null,
            isNavigatingWithVisualZoom: false,
        }
        window.utils.addWebviewContextListener(this.contextMenuHandler)
        window.utils.addWebviewKeydownListener(this.keyDownHandler)
        window.utils.addWebviewKeyupListener(this.keyUpHandler)
        window.utils.addWebviewErrorListener(this.webviewError)

        // IPC-Listener für Zoom-Änderungen vom Preload-Script
        if ((window as any).ipcRenderer) {
            (window as any).ipcRenderer.on('webview-zoom-changed', (event: any, zoomLevel: number) => {
                this.currentZoom = zoomLevel
                this.setState({ zoom: zoomLevel })
                this.props.updateDefaultZoom(this.props.source, zoomLevel);
            });
        }
    }

    // Track ContentView zoom factor (separate from CSS zoom level)
    private contentViewZoomFactor: number = 1.0;
    
    /**
     * Apply zoom to the current view (always ContentView now)
     * - Visual Zoom ON: uses Device Emulation scale (native pinch-to-zoom works)
     * - Visual Zoom OFF: uses CSS-based zoom via preload (like old WebView)
     */
    private applyZoom = (zoomLevel: number) => {
        if (!window.contentView) {
            console.log('[Zoom] ContentView not available');
            return;
        }
        
        // Clamp zoom level
        const clampedLevel = Math.max(-6, Math.min(40, zoomLevel));
        this.currentZoom = clampedLevel;
        
        if (this.state.visualZoomEnabled) {
            // Visual Zoom ON: use Device Emulation scale (native zoom)
            const factor = 1.0 + (clampedLevel * 0.1);
            this.contentViewZoomFactor = factor;
            window.contentView.setZoomFactor(factor);
            console.log('[Zoom] Native zoom factor:', factor, 'from level:', clampedLevel);
        } else {
            // Visual Zoom OFF: use CSS-based zoom via preload
            window.contentView.setCssZoom(clampedLevel);
            console.log('[Zoom] CSS zoom level:', clampedLevel);
        }
        
        // Update state and persist
        if (this._isMounted) {
            this.setState({ zoom: clampedLevel });
        }
        this.updateDefaultZoom(clampedLevel);
    }
    
    /**
     * Get current navigation settings for bundled navigation call
     * This bundles all settings that affect how the content is displayed
     */
    private getNavigationSettings = () => {
        const zoomLevel = this.currentZoom;
        const factor = 1.0 + (zoomLevel * 0.1);
        return {
            zoomFactor: factor,
            visualZoom: this.state.visualZoomEnabled,
            mobileMode: this.localMobileMode,
            showZoomOverlay: this.state.showZoomOverlay
        };
    }

    /**
     * Send settings to ContentView preload script
     * @deprecated For post-navigation settings updates only. 
     *             Use navigateWithSettings() for navigation.
     */
    private sendSettingsToContentView = () => {
        if (!window.contentView) return;
        
        const zoomLevel = this.currentZoom;
        const showOverlay = this.state.showZoomOverlay;
        const mobileMode = this.localMobileMode;
        const visualZoom = this.state.visualZoomEnabled;
        
        console.log('[ContentView] Sending settings: zoom:', zoomLevel, 'overlay:', showOverlay, 'mobile:', mobileMode, 'visualZoom:', visualZoom);
        
        // Send all settings to preload
        window.contentView.send('set-zoom-overlay-setting', showOverlay);
        window.contentView.send('set-mobile-mode', mobileMode);
        window.contentView.send('set-visual-zoom-mode', visualZoom);
        
        // Apply zoom based on mode
        if (visualZoom) {
            const factor = 1.0 + (zoomLevel * 0.1);
            window.contentView.setZoomFactor(factor);
        } else {
            window.contentView.setCssZoom(zoomLevel);
        }
    }

    private sendZoomOverlaySettingToContentView = (show: boolean) => {
        if (!window.contentView) return;
        window.contentView.send('set-zoom-overlay-setting', show);
    }

    private toggleZoomOverlay = () => {
        if (!this._isMounted) return;
        const newValue = !this.state.showZoomOverlay;
        window.settings.setZoomOverlay(newValue);
        this.setState({ showZoomOverlay: newValue });
        this.sendZoomOverlaySettingToContentView(newValue);
    }

    /**
     * Toggle Visual Zoom mode
     * - Visual Zoom ON: Native pinch-to-zoom via Device Emulation
     * - Visual Zoom OFF: CSS-based zoom via preload (like old WebView)
     * Both modes use ContentView now - no more switching between WebView and ContentView!
     */
    private toggleVisualZoom = async () => {
        const newValue = !this.state.visualZoomEnabled;
        window.settings.setVisualZoom(newValue);
        
        console.log('[VisualZoom] Toggle:', newValue ? 'ON (native zoom)' : 'OFF (CSS zoom)');
        
        // Update ContentView settings
        if (window.contentView) {
            window.contentView.setVisualZoom(newValue);
            window.contentView.send('set-visual-zoom-mode', newValue);
            
            // Re-apply zoom with new mode
            const zoomLevel = this.currentZoom;
            if (newValue) {
                // Switch to native zoom
                const factor = 1.0 + (zoomLevel * 0.1);
                window.contentView.setZoomFactor(factor);
            } else {
                // Switch to CSS zoom
                window.contentView.setCssZoom(zoomLevel);
            }
        }
        
        if (this._isMounted) {
            this.setState({ visualZoomEnabled: newValue });
        }
    }

    // ===== ContentView Methods (WebContentsView - now used for ALL display modes) =====
    
    /**
     * Setup ContentView event listeners
     */
    private setupContentViewListeners = () => {
        // Guard: Ensure contentView bridge is available
        if (!window.contentView) {
            console.warn('[ContentView] Cannot setup listeners - contentView bridge not available');
            return;
        }
        
        console.log('[ContentView] Setting up listeners');
        
        // Loading state
        const unsubLoading = window.contentView.onLoading((loading) => {
            if (!loading && this._isMounted) {
                this.setState({ loaded: true });
            }
        });
        this.contentViewCleanup.push(unsubLoading);
        
        // Error handling
        const unsubError = window.contentView.onError((error) => {
            console.error('[ContentView] Load error:', error);
            if (this._isMounted) {
                this.setState({ 
                    error: true, 
                    errorDescription: error.errorDescription 
                });
            }
        });
        this.contentViewCleanup.push(unsubError);
        
        // Context menu
        const unsubContextMenu = window.contentView.onContextMenu((params) => {
            const pos: [number, number] = [params.x, params.y];
            if (params.selectionText) {
                this.props.textMenu(pos, params.selectionText, params.linkURL);
            } else if (params.srcURL && params.mediaType === "image") {
                this.props.imageMenu(pos);
            } else {
                this.props.dismissContextMenu();
            }
        });
        this.contentViewCleanup.push(unsubContextMenu);
        
        // Keyboard input forwarding
        const unsubInput = window.contentView.onInput((input) => {
            this.keyDownHandler(input);
        });
        this.contentViewCleanup.push(unsubInput);
        
        // Navigation (for cookie persistence)
        const unsubNavigated = window.contentView.onNavigated((url) => {
            if (this.props.source.persistCookies && this.isWebpageMode) {
                console.log("[CookiePersist] ContentView: Navigation to:", url);
                this.savePersistedCookiesDebounced();
            }
        });
        this.contentViewCleanup.push(unsubNavigated);
        
        // Visual Zoom loading spinner events
        if ((window as any).ipcRenderer) {
            const ipc = (window as any).ipcRenderer;
            
            // Show loading spinner when Visual Zoom navigation starts
            const onVisualZoomLoading = () => {
                console.log('[ContentView] Visual Zoom loading started - showing spinner');
                if (this._isMounted) {
                    this.setState({ isNavigatingWithVisualZoom: true });
                }
            };
            ipc.on('content-view-visual-zoom-loading', onVisualZoomLoading);
            this.contentViewCleanup.push(() => ipc.removeAllListeners('content-view-visual-zoom-loading'));
            
            // Hide loading spinner when Visual Zoom is ready
            const onVisualZoomReady = () => {
                console.log('[ContentView] Visual Zoom ready - hiding spinner');
                if (this._isMounted) {
                    this.setState({ isNavigatingWithVisualZoom: false });
                }
            };
            ipc.on('content-view-visual-zoom-ready', onVisualZoomReady);
            this.contentViewCleanup.push(() => ipc.removeAllListeners('content-view-visual-zoom-ready'));
        }
    }
    
    /**
     * Cleanup ContentView listeners and hide it
     */
    private cleanupContentView = () => {
        console.log('[ContentView] Cleaning up');
        
        // Remove all event listeners
        this.contentViewCleanup.forEach(cleanup => cleanup());
        this.contentViewCleanup = [];
        
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
        
        // Reset bounds cache and current URL
        this.lastContentViewBounds = null;
        this.contentViewCurrentUrl = null;
        
        // Hide ContentView, clear content, and reset bounds (with null check)
        if (window.contentView) {
            window.contentView.setVisible(false);
            window.contentView.clear(); // Load about:blank to clear old content
            // Set bounds to 0 to ensure it's completely out of the way
            window.contentView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
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
        if (!this.contentViewPlaceholderRef) return;
        if (!window.contentView) return;
        
        // Don't update bounds if ContentView is hidden for overlay
        if (this.contentViewHiddenForMenu) return;
        
        const rect = this.contentViewPlaceholderRef.getBoundingClientRect();
        const bounds = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
        
        // Only update if bounds actually changed (avoid unnecessary IPC)
        if (this.lastContentViewBounds &&
            this.lastContentViewBounds.x === bounds.x &&
            this.lastContentViewBounds.y === bounds.y &&
            this.lastContentViewBounds.width === bounds.width &&
            this.lastContentViewBounds.height === bounds.height) {
            return;
        }
        
        this.lastContentViewBounds = bounds;
        console.log('[ContentView] Updating bounds:', bounds);
        window.contentView.setBounds(bounds);
    }
    
    private lastContentViewBounds: { x: number, y: number, width: number, height: number } | null = null;
    private windowResizeListener: (() => void) | null = null;
    
    /**
     * Initialize ContentView for displaying article content
     */
    /**
     * Initialize ContentView for ALL content types
     * - Webpage mode: navigate to URL
     * - RSS/Full content: load HTML directly via data URL
     * ContentView is now the ONLY display method (no more WebView!)
     */
    private initializeContentView = async () => {
        if (!this.contentViewPlaceholderRef) return;
        
        // Check if contentView bridge is available
        if (!window.contentView) {
            console.error('[ContentView] contentView bridge not available!');
            return;
        }
        
        console.log('[ContentView] Initializing for mode:', SourceOpenTarget[this.state.contentMode]);
        
        try {
            // Setup listeners if not already done
            if (this.contentViewCleanup.length === 0) {
                this.setupContentViewListeners();
            }
            
            // Update bounds
            this.updateContentViewBounds();
            
            // Setup ResizeObserver for dynamic bounds updates
            if (!this.resizeObserver) {
                this.resizeObserver = new ResizeObserver(() => {
                    this.updateContentViewBounds();
                });
                this.resizeObserver.observe(this.contentViewPlaceholderRef);
            }
            
            // Setup window resize listener (ResizeObserver doesn't catch window resizes that only change position)
            if (!this.windowResizeListener) {
                this.windowResizeListener = () => {
                    requestAnimationFrame(() => this.updateContentViewBounds());
                };
                window.addEventListener('resize', this.windowResizeListener);
            }
            
            // Load content with bundled settings (all settings applied BEFORE navigation)
            if (this.isWebpageMode) {
                // Webpage mode: Navigate to URL with bundled settings
                const targetUrl = this.props.item.link;
                if (this.contentViewCurrentUrl !== targetUrl) {
                    console.log('[ContentView] FIRST LOAD - navigateWithSettings to:', targetUrl);
                    this.contentViewCurrentUrl = targetUrl;
                    await window.contentView.navigateWithSettings(targetUrl, this.getNavigationSettings());
                    // Mark ContentView as initialized (Device Emulation is now active)
                    this.contentViewInitialized = true;
                    console.log('[ContentView] ContentView initialized, subsequent navigations will use JS navigation');
                } else {
                    console.log('[ContentView] URL unchanged, skipping navigation');
                }
            } else {
                // Local (RSS) or FullContent mode: Load HTML directly with bundled settings
                const htmlDataUrl = this.articleView();
                console.log('[ContentView] FIRST LOAD - Loading HTML content for mode:', SourceOpenTarget[this.state.contentMode]);
                // Navigate with settings bundled - all settings applied BEFORE navigation starts
                await window.contentView.navigateWithSettings(htmlDataUrl, this.getNavigationSettings());
                this.contentViewCurrentUrl = htmlDataUrl;
                // Mark ContentView as initialized (Device Emulation is now active)
                this.contentViewInitialized = true;
                console.log('[ContentView] ContentView initialized, subsequent navigations will use JS navigation');
            }
            
            // Settings are now bundled with navigation - no need for separate send
            // The preload reads settings via synchronous IPC on load
            console.log('[ContentView] Navigation complete (settings bundled with navigate call)');
            
            // Show ContentView (if Visual Zoom is enabled, main process handles showing after emulation)
            // We still call setVisible(true) here - main process will handle the timing
            if (!this.state.visualZoomEnabled) {
                window.contentView.setVisible(true);
            }
            // For Visual Zoom: ContentViewManager shows the view after emulation is applied (dom-ready)
            
            // Focus
            window.contentView.focus();
            
            this.setState({ webviewVisible: true, loaded: true });
        } catch (e) {
            console.error('[ContentView] Error initializing:', e);
        }
    }
    
    // Input Mode: Sendet Status an ContentView um Keyboard-Navigation zu deaktivieren
    private setInputMode = (enabled: boolean) => {
        this.setState({ inputModeEnabled: enabled });
        // Send to ContentView
        if (window.contentView) {
            try {
                window.contentView.send('set-input-mode', enabled);
            } catch (e) {
                // ContentView not ready - ignore
            }
        }
    }

    // Lokaler State für Mobile Mode (für zuverlässiges IPC-Timing nach Reload)
    private localMobileMode: boolean = false;

    private toggleMobileMode = async () => {
        const newMobileMode = !this.props.source.mobileMode;
        this.localMobileMode = newMobileMode;  // Lokalen State sofort setzen
        this.props.updateMobileMode(this.props.source, newMobileMode);
        
        console.log('[Article] Mobile mode toggled:', newMobileMode ? 'ON' : 'OFF');
        
        // Globalen Mobile-Mode Status setzen (für neue WebViews bei Artikelwechsel)
        this.setGlobalMobileMode(newMobileMode);
        
        // Use ContentView bridge - this handles User-Agent, Device Emulation, and reload
        if (window.contentView) {
            console.log('[Article] Setting ContentView mobile mode:', newMobileMode);
            window.contentView.setMobileMode(newMobileMode);
        }
    }

    private togglePersistCookies = () => {
        const newValue = !this.props.source.persistCookies;
        console.log("[CookiePersist] Article: Toggle persistCookies:", newValue, "source:", this.props.source.name)
        this.props.updatePersistCookies(this.props.source, newValue);
        
        if (newValue) {
            // Wenn aktiviert, sofort aktuelle Cookies speichern
            console.log("[CookiePersist] Article: Saving cookies immediately after enabling")
            this.savePersistedCookies();
        }
    }

    // Note: enableMobileEmulation and disableMobileEmulation removed
    // Mobile mode is now handled via window.contentView.setMobileMode()

    // Setzt den globalen Mobile-Mode-Status im Main-Prozess
    // Der Main-Prozess wendet dann automatisch Emulation auf neue ContentViews an
    private setGlobalMobileMode = (enabled: boolean) => {
        const ipcRenderer = (window as any).ipcRenderer;
        if (ipcRenderer && typeof ipcRenderer.send === 'function') {
            // FESTE Viewport-Breite für konsistentes Mobile-Verhalten
            // 768px ist der Standard-Breakpoint für Mobile/Tablet
            const viewportWidth = 768;
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
            
            console.log('[MobileMode] Setting global mobile mode:', enabled, 'viewport:', viewportWidth, 'x', viewportHeight);
            ipcRenderer.send('set-global-mobile-mode', enabled, params);
        }
    }

    private toggleNsfwCleanup = () => {
        const newValue = !this.state.nsfwCleanupEnabled;
        window.settings.setNsfwCleanup(newValue);
        this.setState({ nsfwCleanupEnabled: newValue });
        // Reload ContentView damit die Einstellung greift
        this.webviewReload();
    }

    private toggleAutoCookieConsent = () => {
        const newValue = !this.state.autoCookieConsentEnabled;
        window.settings.setAutoCookieConsent(newValue);
        this.setState({ autoCookieConsentEnabled: newValue });
        // Reload ContentView damit die Einstellung greift
        this.webviewReload();
    }

    // ===== Cookie Persistence =====
    
    /**
     * Lädt gespeicherte Cookies für den aktuellen Artikel (falls persistCookies aktiviert)
     */
    private loadPersistedCookies = async () => {
        if (!this.props.source.persistCookies) {
            console.log("[CookiePersist] Article: persistCookies disabled for source:", this.props.source.name)
            return
        }
        
        const url = this.props.item.link
        console.log("[CookiePersist] Article: Loading cookies for article:", this.props.item.title)
        console.log("[CookiePersist] Article: URL:", url)
        
        try {
            const result = await window.utils.loadPersistedCookies(url)
            console.log("[CookiePersist] Article: Load result:", result)
        } catch (e) {
            console.error("[CookiePersist] Article: Error loading cookies:", e)
        }
    }
    
    /**
     * Speichert aktuelle Cookies für den Artikel (falls persistCookies aktiviert)
     */
    private savePersistedCookies = async () => {
        if (!this.props.source.persistCookies) {
            return
        }
        
        const url = this.props.item.link
        console.log("[CookiePersist] Article: Saving cookies for article:", this.props.item.title)
        console.log("[CookiePersist] Article: URL:", url)
        
        try {
            const result = await window.utils.savePersistedCookies(url)
            console.log("[CookiePersist] Article: Save result:", result)
            this.lastCookieSaveTime = Date.now()
        } catch (e) {
            console.error("[CookiePersist] Article: Error saving cookies:", e)
        }
    }
    
    /**
     * Debounced Version von savePersistedCookies - verhindert zu häufiges Speichern
     * bei vielen Navigation-Events (z.B. Reddit SPA)
     */
    private savePersistedCookiesDebounced = () => {
        if (!this.props.source.persistCookies) {
            return
        }
        
        // Wenn kürzlich gespeichert wurde, ignorieren
        const now = Date.now()
        if (now - this.lastCookieSaveTime < 2000) {
            console.log("[CookiePersist] Article: Skipping save (debounced, last save was", now - this.lastCookieSaveTime, "ms ago)")
            return
        }
        
        // Vorherigen Timeout löschen
        if (this.cookieSaveTimeout) {
            clearTimeout(this.cookieSaveTimeout)
        }
        
        // Neuen Timeout setzen (500ms delay)
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
                                } else if (window.contentView) {
                                    window.contentView.executeJavaScript(`
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
                                if (window.contentView) {
                                    window.contentView.executeJavaScript(`
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
                            text: "Mobile Ansicht",
                            iconProps: { iconName: (this.props.source.mobileMode || false) ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.props.source.mobileMode || false,
                            // Mobile Mode works with ContentView (all modes except External)
                            disabled: !this.usesContentView,
                            onClick: this.toggleMobileMode,
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
                                console.log('[InputMode] Menu toggle:', newValue ? 'ENABLED' : 'DISABLED');
                                // Cookies speichern beim Verlassen des Eingabe-Modus
                                if (!newValue && this.props.source.persistCookies && this.isWebpageMode) {
                                    console.log('[CookiePersist] Article: Saving cookies after leaving input mode (Menu)');
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
                            key: "openWebviewDevTools",
                            text: "Artikel Developer Tools",
                            iconProps: { iconName: "FileHTML" },
                            onClick: () => {
                                if (window.contentView) {
                                    window.contentView.openDevTools()
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
                console.log("ctrl UP");
            }
        }
    }

    // Track last processed key event to prevent duplicates (WebView + ContentView both send events)
    private lastKeyEventTime: number = 0;
    private lastKeyEventKey: string = '';

    keyDownHandler = (input: Electron.Input) => {
        // Debounce duplicate events (both WebView and ContentView can send keyboard events)
        const now = Date.now();
        const eventKey = `${input.type}-${input.key}-${input.control}-${input.shift}-${input.alt}`;
        if (now - this.lastKeyEventTime < 50 && eventKey === this.lastKeyEventKey) {
            return; // Ignore duplicate event within 50ms
        }
        this.lastKeyEventTime = now;
        this.lastKeyEventKey = eventKey;

        if (input.type === "keyDown")
        {
            if(input.control && !input.isAutoRepeat)
            {
                console.log("ctrl DOWN");
            }
        }
        if (input.type === "keyUp")
        {
            if(input.control && !input.isAutoRepeat)
            {
                console.log("ctrl UP");
            }
        }

        if (input.type === "")
        {
            
        }
        if (input.type === "keyDown") {
            // Eingabe-Modus Toggle: Ctrl+I
            if (input.control && (input.key === 'i' || input.key === 'I')) {
                const newValue = !this.state.inputModeEnabled;
                console.log('[InputMode] Toggle:', newValue ? 'ENABLED (shortcuts off)' : 'DISABLED (shortcuts on)');
                // Cookies speichern beim Verlassen des Eingabe-Modus (z.B. nach Login)
                if (!newValue && this.props.source.persistCookies && this.isWebpageMode) {
                    console.log('[CookiePersist] Article: Saving cookies after leaving input mode (Ctrl+I)');
                    this.savePersistedCookies();
                }
                this.setInputMode(newValue);
                return;
            }
            
            // Im Eingabe-Modus: nur Escape und Ctrl+I erlauben
            if (this.state.inputModeEnabled) {
                if (input.key === 'Escape') {
                    console.log('[InputMode] Escape pressed - disabling input mode');
                    console.log('[InputMode] persistCookies:', this.props.source.persistCookies, 'contentMode:', SourceOpenTarget[this.state.contentMode]);
                    this.setInputMode(false);
                    // Cookies speichern beim Verlassen des Eingabe-Modus (z.B. nach Login)
                    if (this.props.source.persistCookies && this.isWebpageMode) {
                        console.log('[CookiePersist] Article: Saving cookies after leaving input mode');
                        this.savePersistedCookies();
                    }
                    return;
                }
                // Alle anderen Tasten zum Webview durchlassen (nicht als Shortcuts behandeln)
                return;
            }
            
            switch (input.key) {
                case "Escape":
                    this.props.dismiss()
                    break
                case "ArrowLeft":
                case "ArrowRight":
                    this.props.offsetItem(input.key === "ArrowLeft" ? -1 : 1)
                    break
                case "l":
                case "L":
                    this.toggleWebpage()
                    break
                case "+":
                    this.applyZoom((this.state.zoom || 0) + 1);
                    break;
                case "-":
                    this.applyZoom((this.state.zoom || 0) - 1);
                    break;
                case "#":
                    this.applyZoom(0);
                    break;
                case "*":
                    // Strg+Shift+8: Zoom vergrößern
                    if (input.shift) {
                        this.applyZoom((this.state.zoom || 0) + 1);
                    }
                    break;
                case "_":
                    // Strg+Shift+Minus: Zoom verkleinern
                    if (input.shift) {
                        this.applyZoom((this.state.zoom || 0) - 1);
                    }
                    break;
                case "w":
                case "W":
                    this.toggleFull()
                    break
                case "m":
                case "M":
                    // Toggle Mobile Mode
                    console.log('[Article] M key pressed - toggling mobile mode, usesContentView:', this.usesContentView);
                    this.toggleMobileMode()
                    break
                case "p":
                case "P":
                    // Toggle Visual Zoom (WebView <-> ContentView)
                    console.log('[Article] P key pressed - toggling Visual Zoom (ContentView)');
                    this.toggleVisualZoom()
                    break
                case "H":
                case "h":
                    if (!input.meta) this.props.toggleHidden(this.props.item)
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

    // Note: webviewStartLoadingEarly, webviewStartLoading, webviewLoaded removed
    // ContentView handles loading events via setupContentViewListeners()
    
    webviewError = (reason: string) => {
        this.setState({ error: true, errorDescription: reason })
    }
    
    webviewReload = () => {
        // Use ContentView reload instead of webview
        if (window.contentView) {
            this.setState({ loaded: false, error: false })
            window.contentView.reload()
        } else if (this.isFullContentMode) {
            this.loadFull()
        }
    }

    componentDidMount = () => {
        this._isMounted = true
        // Load app path for WebView article.html loading
        if (!this.state.appPath && (window as any).ipcRenderer) {
            (window as any).ipcRenderer.invoke('get-app-path').then((path: string) => {
                if (path) {
                    this.setState({ appPath: path })
                }
            }).catch((err: any) => {
                console.error("[componentDidMount] Failed to get app path:", err)
            })
        }
        
        // Globalen Mobile-Mode Status initial setzen (für den Fall dass bereits aktiviert)
        this.setGlobalMobileMode(this.localMobileMode);
        
        // Setup ContentView listeners - now for ALL modes (not just Webpage)
        if (this.state.visualZoomEnabled) {
            this.setupContentViewListeners()
        }
        
        // Note: ContentView restoration is handled by explicit click on blur placeholder
        
        // Persistierte Cookies laden beim ersten Mount
        if (this.props.source.persistCookies) {
            console.log("[CookiePersist] Article: Loading cookies on mount")
            this.loadPersistedCookies()
        }
        
        // Load full content if needed
        if (this.isFullContentMode && !this.state.fullContent) {
            this.loadFull()
        }
        
        // Keyboard state tracking für Zoom
        this.pressedZoomKeys = new Set<string>()
        // Verwende den Feed-Zoom als Ausgangswert
        this.currentZoom = this.props.source.defaultZoom || 0
        
        // Entferne alte Listener falls vorhanden
        if (this.globalKeydownListener) {
            document.removeEventListener('keydown', this.globalKeydownListener)
        }
        if (this.globalKeyupListener) {
            document.removeEventListener('keyup', this.globalKeyupListener)
        }
        
        // Global keyboard listener für Zoom (auch außerhalb WebView)
        this.globalKeydownListener = (e: KeyboardEvent) => {
            // Lineare 10%-Schritte: -6 = 40%, 0 = 100%, 40 = 500%
            const MIN_ZOOM_LEVEL = -6
            const MAX_ZOOM_LEVEL = 40
            const isZoomKey = (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '#')
            
            if (!isZoomKey || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
            
            // Ignoriere repeat Events (Taste wird gehalten)
            if (e.repeat) return
            
            e.preventDefault()
            this.pressedZoomKeys.add(e.key)
            
            if (e.key === '+' || e.key === '=') {
                const newZoom = Math.min(MAX_ZOOM_LEVEL, this.currentZoom + 1)
                this.currentZoom = newZoom
                this.setState({ zoom: newZoom })
                this.applyZoom(newZoom)
            } else if (e.key === '-' || e.key === '_') {
                const newZoom = Math.max(MIN_ZOOM_LEVEL, this.currentZoom - 1)
                this.currentZoom = newZoom
                this.setState({ zoom: newZoom })
                this.applyZoom(newZoom)
            } else if (e.key === '#') {
                this.currentZoom = 0
                this.setState({ zoom: 0 })
                this.applyZoom(0)
            }
        }
        
        this.globalKeyupListener = (e: KeyboardEvent) => {
            this.pressedZoomKeys.delete(e.key)
        }
        
        document.addEventListener('keydown', this.globalKeydownListener)
        document.addEventListener('keyup', this.globalKeyupListener)
        
        // Note: WebView code removed - ContentView is now the only display method
        // ContentView is initialized via ref callback in render()
        
        // Scroll to current article card in feed list
        let card = document.querySelector(
            `#refocus div[data-iid="${this.props.item._id}"]`
        ) as HTMLElement
        // @ts-ignore
        if (card) card.scrollIntoViewIfNeeded()
    }
    componentDidUpdate = (prevProps: ArticleProps, prevState: ArticleState) => {
        if (prevProps.item._id != this.props.item._id) {
            // Fehler-State zurücksetzen bei Artikelwechsel
            if (this.state.error) {
                this.setState({ error: false, errorDescription: "" });
            }
            
            // Eingabe-Modus bei Artikelwechsel zurücksetzen
            if (this.state.inputModeEnabled) {
                console.log('[InputMode] Article changed - disabling input mode');
                this.setInputMode(false);
            }
            
            // Feed-Liste zum neuen Artikel scrollen
            const card = document.querySelector(
                `#refocus div[data-iid="${this.props.item._id}"]`
            ) as HTMLElement
            if (card && card.scrollIntoViewIfNeeded) {
                card.scrollIntoViewIfNeeded(false) // false = nur scrollen wenn nötig, zentriert nicht
            } else if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
            }
            
            // Cookies des alten Artikels speichern (falls persistCookies aktiviert war)
            if (prevProps.source.persistCookies) {
                console.log("[CookiePersist] Article: Saving cookies before article change")
                window.utils.savePersistedCookies(prevProps.item.link).catch(e => {
                    console.error("[CookiePersist] Article: Error saving on article change:", e)
                })
            }
            
            // Synchronisiere lokalen Mobile-Mode State mit neuer Source
            this.localMobileMode = this.props.source.mobileMode || false;
            console.log('[Article] Article changed - localMobileMode:', this.localMobileMode);
            
            // WICHTIG: Globalen Mobile-Mode Status setzen BEVOR neuer WebView erstellt wird!
            // Der Main-Prozess wendet dann automatisch die Emulation bei 'did-attach' an.
            this.setGlobalMobileMode(this.localMobileMode);
            
            // Synchronisiere currentZoom sofort bei Artikelwechsel
            // Verwende den AKTUELLEN Zoom (this.currentZoom), nicht den gespeicherten aus props
            // Der gespeicherte props.source.defaultZoom kann veraltet sein wenn der User gerade gezoomt hat
            // Nur wenn wir zu einer ANDEREN Source wechseln, verwenden wir den gespeicherten Wert
            const isSameSource = prevProps.source.sid === this.props.source.sid
            const savedZoom = isSameSource 
                ? this.currentZoom  // Gleiche Source: behalte aktuellen Zoom
                : (this.props.source.defaultZoom || 0)  // Andere Source: verwende gespeicherten Zoom
            this.currentZoom = savedZoom
            this.setState({ zoom: savedZoom })
            
            console.log('[Article] Zoom for article change: isSameSource:', isSameSource, 
                'currentZoom:', this.currentZoom, 'savedZoom:', savedZoom)
            
            // Close DevTools before article change to prevent crash
            try {
                if (window.contentView && window.contentView.isDevToolsOpened()) {
                    window.contentView.closeDevTools()
                }
            } catch {}
            
            // Cookies für neuen Artikel laden (falls persistCookies aktiviert)
            if (this.props.source.persistCookies) {
                console.log("[CookiePersist] Article: Loading cookies for new article")
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
                    // For webpage mode - ContentView navigates to URL with bundled settings
                    if (window.contentView) {
                        const targetUrl = this.props.item.link;
                        if (this.contentViewCurrentUrl !== targetUrl) {
                            // JS-Navigation test showed: Emulation is reset even with window.location.href
                            // So we use navigateWithSettings with HIDE-SHOW strategy:
                            // Main process hides view, navigates, applies emulation at dom-ready, then shows
                            console.log('[ContentView] Article changed (Webpage) - navigateWithSettings to:', targetUrl);
                            this.contentViewCurrentUrl = targetUrl;
                            window.contentView.navigateWithSettings(targetUrl, this.getNavigationSettings());
                        }
                        // Focus ContentView for keyboard input (with delay to ensure it's ready)
                        setTimeout(() => {
                            if (window.contentView) {
                                window.contentView.focus();
                            }
                        }, 100);
                    }
                } else {
                    // For Local (RSS) mode - ContentView loads HTML data URL with bundled settings
                    if (window.contentView) {
                        const htmlDataUrl = this.articleView();
                        // Use navigateWithSettings with HIDE-SHOW strategy
                        console.log('[ContentView] Article changed (Local/RSS) - navigateWithSettings');
                        this.contentViewCurrentUrl = htmlDataUrl;
                        window.contentView.navigateWithSettings(htmlDataUrl, this.getNavigationSettings());
                        // Focus ContentView
                        setTimeout(() => {
                            if (window.contentView) {
                                window.contentView.focus();
                            }
                        }, 100);
                    }
                    // CSS zoom for non-Visual-Zoom mode is handled by preload via sync IPC
                    // No need for separate applyZoom call anymore!
                }
            })
        } else if (prevProps.source.openTarget !== this.props.source.openTarget) {
            // If openTarget changes from OUTSIDE (not from toggleWebpage/toggleFull), update the state
            // Skip if we're currently toggling mode (to prevent race conditions)
            if (this._isTogglingMode) {
                console.log('[Article] componentDidUpdate - openTarget changed but _isTogglingMode is true - IGNORING')
                return
            }
            
            const targetContentMode = this.props.source.openTarget
            
            console.log('[Article] componentDidUpdate - openTarget changed:',
                'prev:', SourceOpenTarget[prevProps.source.openTarget], 
                'new:', SourceOpenTarget[this.props.source.openTarget],
                'current state contentMode:', SourceOpenTarget[this.state.contentMode],
                'target contentMode:', SourceOpenTarget[targetContentMode])
            
            // Only update if state doesn't already match the target
            if (this.state.contentMode !== targetContentMode) {
                console.log('[Article] openTarget changed from outside, syncing state:', 
                    'contentMode:', SourceOpenTarget[targetContentMode])
                this.setState({
                    contentMode: targetContentMode,
                })
            } else {
                console.log('[Article] openTarget changed but state already matches - skipping setState')
            }
        }
        
        // Handle overlay visibility changes for ContentView (Redux-based overlays only)
        // This covers: settings, log menu, context menus (not hamburger menu)
        // Note: Fluent UI dropdowns (Tools, View) are handled by onMenuOpened/onMenuDismissed callbacks
        if (prevProps.overlayActive !== this.props.overlayActive) {
            this.handleOverlayVisibilityChange(this.props.overlayActive)
        }
        
        // Handle local dialog state changes (P2P Share Dialog, etc.)
        // These are not managed by Redux, so we need to handle them separately
        if (prevState.showP2PShareDialog !== this.state.showP2PShareDialog) {
            this.handleLocalDialogVisibilityChange(this.state.showP2PShareDialog)
        }
        
        // Handle hamburger menu layout changes - update ContentView bounds
        // The hamburger menu doesn't overlap but changes the layout position
        if (this.usesContentView && prevProps.menuOpen !== this.props.menuOpen) {
            // Small delay to let the CSS transition complete
            setTimeout(() => {
                if (this._isMounted) {
                    console.log('[Article] Menu state changed - updating ContentView bounds')
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
        if (!window.contentView) return
        if (this.contentViewHiddenForMenu) return  // Already hidden
        
        console.log(`[Article] ${reason} - capturing screenshot`)
        try {
            const screenshot = await window.contentView.captureScreen()
            if (screenshot && this._isMounted) {
                // Use setState callback to hide ContentView after React renders the placeholder
                this.setState({ menuBlurScreenshot: screenshot }, () => {
                    // Re-check conditions after async setState
                    if (this._isMounted && window.contentView && (!shouldHideCheck || shouldHideCheck())) {
                        window.contentView.setVisible(false, true) // preserveContent for blur-div
                        this.contentViewHiddenForMenu = true
                        console.log(`[Article] ContentView hidden for ${reason}`)
                    }
                })
                return
            }
        } catch (e) {
            console.error(`[Article] Error capturing screenshot for ${reason}:`, e)
        }
        
        // Fallback: hide without screenshot (error case or no screenshot)
        if (!shouldHideCheck || shouldHideCheck()) {
            window.contentView.setVisible(false, true) // preserveContent for blur-div
            this.contentViewHiddenForMenu = true
            console.log(`[Article] ContentView hidden for ${reason} (no screenshot)`)
        }
    }
    
    /**
     * Handle Redux overlay visibility change for ContentView
     * Only handles Redux-based overlays (menu, settings, log menu, context menu)
     * Fluent UI dropdowns are handled by onMenuOpened/onMenuDismissed callbacks
     */
    private handleOverlayVisibilityChange = async (overlayActive: boolean) => {
        if (!window.contentView) return
        
        if (overlayActive) {
            await this.hideContentViewWithScreenshot('Redux overlay opening', () => this.props.overlayActive)
        } else {
            // Redux overlay closed - check if we can restore
            if (this.contentViewHiddenForMenu && !this.fluentMenuOpen && !this.localDialogOpen) {
                console.log('[Article] Redux overlay closed - restoring ContentView')
                this.restoreContentView()
            }
        }
    }
    
    // Track if a local dialog (not Redux-managed) is open
    private localDialogOpen = false
    
    /**
     * Handle local dialog visibility change for ContentView
     * Covers dialogs managed by local component state (P2P Share Dialog, etc.)
     */
    private handleLocalDialogVisibilityChange = async (dialogOpen: boolean) => {
        if (!window.contentView) return
        
        if (dialogOpen) {
            this.localDialogOpen = true
            await this.hideContentViewWithScreenshot('local dialog opening', () => this.localDialogOpen)
        } else {
            // Local dialog closed - check if we can restore
            this.localDialogOpen = false
            if (this.contentViewHiddenForMenu && !this.fluentMenuOpen && !this.props.overlayActive) {
                console.log('[Article] Local dialog closed - restoring ContentView')
                this.restoreContentView()
            }
        }
    }
    
    // Track if a Fluent UI dropdown menu is open
    private fluentMenuOpen = false
    
    /**
     * Handle Fluent UI dropdown menu opening
     * Called by onMenuOpened callback in menu props
     */
    private handleFluentMenuOpened = async () => {
        this.fluentMenuOpen = true
        
        // ContentView is now used for ALL modes (RSS, Full Content, Webpage)
        // Hide it whenever a menu opens to allow interaction with the menu
        await this.hideContentViewWithScreenshot('Fluent UI menu opening', () => this.fluentMenuOpen)
    }
    
    /**
     * Handle Fluent UI dropdown menu closing
     * Called by onMenuDismissed callback in menu props
     */
    private handleFluentMenuDismissed = () => {
        console.log('[Article] Fluent UI menu dismissed')
        this.fluentMenuOpen = false
        
        // ContentView is now used for ALL modes - restore if it was hidden
        if (!window.contentView) return
        if (!this.contentViewHiddenForMenu) return  // Not hidden, nothing to do
        
        // Check if Redux overlay or local dialog is still active
        if (this.props.overlayActive) {
            console.log('[Article] Fluent menu dismissed but Redux overlay active - staying hidden')
            return
        }
        if (this.localDialogOpen) {
            console.log('[Article] Fluent menu dismissed but local dialog active - staying hidden')
            return
        }
        
        // Menu closed and no other overlay open - restore immediately
        console.log('[Article] Fluent menu dismissed - restoring ContentView')
        this.restoreContentView()
    }
    
    // Timer for auto-restore when mouse hovers over blur placeholder
    private blurHoverTimer: NodeJS.Timeout | null = null;
    private readonly BLUR_HOVER_DELAY = 250; // ms before auto-restore
    
    /**
     * Handle click on blur placeholder to restore ContentView
     */
    private handleBlurPlaceholderClick = () => {
        console.log('[Article] Blur placeholder clicked - restoring ContentView')
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
            // Don't auto-restore if a menu is still open
            if (this.props.overlayActive || this.fluentMenuOpen) {
                console.log('[Article] Blur hover timeout - menu still open, not restoring')
                return
            }
            console.log('[Article] Blur hover timeout - auto-restoring ContentView')
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
        if (!window.contentView) return
        if (!this.contentViewHiddenForMenu) return
        
        // Clear hover timer
        if (this.blurHoverTimer) {
            clearTimeout(this.blurHoverTimer)
            this.blurHoverTimer = null
        }
        
        // Show ContentView FIRST, then remove blur screenshot
        // This prevents a flash where neither is visible
        window.contentView.setVisible(true)
        this.contentViewHiddenForMenu = false
        
        // Small delay to ensure ContentView is rendered before removing blur
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
        
        await this.hideContentViewWithScreenshot('Mouse left ContentView area')
    }
    
    /**
     * Handle mouse entering the ContentView area
     * Restore ContentView when mouse returns to the area
     */
    private handleContentViewMouseEnter = () => {
        if (!this.state.visualZoomEnabled || !this.usesContentView) return
        if (!window.contentView) return
        if (!this.contentViewHiddenForMenu) return  // Not hidden, nothing to do
        
        // Check if any Redux overlay is still active (menu, settings, etc.)
        if (this.props.overlayActive) {
            console.log('[Article] Mouse entered but Redux overlay active - staying hidden')
            return
        }
        
        // Check if any Fluent UI overlay is still visible
        const fluentOverlay = document.querySelector('.ms-Layer:not(:empty), .ms-ContextualMenu, [role="menu"]')
        if (fluentOverlay) {
            console.log('[Article] Mouse entered but Fluent UI overlay active - staying hidden')
            return
        }
        
        console.log('[Article] Mouse entered ContentView area - restoring')
        window.contentView.setVisible(true)
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
        if (window.contentView) {
            // Check if we're waiting to focus ContentView after mode switch
            if (this.pendingContentViewFocus) {
                console.log('[VisualZoom] pendingContentViewFocus: focusing ContentView now');
                this.pendingContentViewFocus = false;
                // Multiple focus attempts to ensure it sticks
                window.contentView.focus();
                setTimeout(() => {
                    if (window.contentView && this._isMounted) {
                        window.contentView.focus();
                        console.log('[VisualZoom] ✅ ContentView focused - press P to switch back');
                    }
                }, 50);
                setTimeout(() => {
                    if (window.contentView && this._isMounted) {
                        window.contentView.focus();
                    }
                }, 200);
            } else {
                // Normal focus with small delay
                setTimeout(() => {
                    if (window.contentView && this._isMounted) {
                        window.contentView.focus()
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
        if (this.contentViewHiddenForMenu && window.contentView) {
            window.contentView.setVisible(true)
            this.contentViewHiddenForMenu = false
        }
        
        // Clear any pending restore timeout
        if (this.contentViewRestoreTimeout) {
            clearTimeout(this.contentViewRestoreTimeout)
            this.contentViewRestoreTimeout = null
        }
        
        // Note: No global listeners to clean up - restoration is click-based
        
        // Cookies speichern bevor die Komponente zerstört wird
        if (this.props.source.persistCookies) {
            console.log("[CookiePersist] Article: Saving cookies on unmount")
            window.utils.savePersistedCookies(this.props.item.link).catch(e => {
                console.error("[CookiePersist] Article: Error saving on unmount:", e)
            })
        }
        
        // Close DevTools before unmount to prevent crash
        try {
            if (window.contentView && window.contentView.isDevToolsOpened()) {
                window.contentView.closeDevTools()
            }
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
            (window as any).ipcRenderer.removeAllListeners('webview-zoom-changed');
        }
    }

    toggleWebpage = () => {
        console.log('[Article] toggleWebpage called, current contentMode:', SourceOpenTarget[this.state.contentMode]);
        
        // Set flag to prevent componentDidUpdate from overriding our state changes
        this._isTogglingMode = true;
        
        if (this.isWebpageMode) {
            // Switching FROM webpage mode TO Local (RSS) mode
            console.log('[Article] Switching FROM Webpage TO Local mode');
            // Clear tracked URL so ContentView will reload with new content
            this.contentViewCurrentUrl = null;
            
            // Capture source BEFORE setState to avoid stale reference
            const sourceSnapshot = this.props.source;
            
            this.setState({ contentMode: SourceOpenTarget.Local, webviewVisible: false }, () => {
                console.log('[Article] State set to contentMode: Local');
                // Switch back to Local (RSS) mode and persist
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.Local
                )
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
            console.log('[Article] Switching TO Webpage mode');
            // Clear tracked URL so ContentView will load the webpage
            this.contentViewCurrentUrl = null;
            
            // Capture source BEFORE setState to avoid stale reference
            const sourceSnapshot = this.props.source;
            console.log('[Article] Source snapshot openTarget:', SourceOpenTarget[sourceSnapshot.openTarget]);
            
            this.setState({ contentMode: SourceOpenTarget.Webpage, webviewVisible: false }, () => {
                console.log('[Article] State set to contentMode: Webpage');
                console.log('[Article] Current props.source.openTarget:', SourceOpenTarget[this.props.source.openTarget]);
                // Update source to persist openTarget
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.Webpage
                )
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
            
            this.setState({ contentMode: SourceOpenTarget.Local, webviewVisible: false }, () => {
                // Switch back to Local (RSS) mode and persist
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.Local
                )
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
            
            this.setState({ contentMode: SourceOpenTarget.FullContent, webviewVisible: false }, () => {
                // Update source to persist openTarget
                this.props.updateSourceOpenTarget(
                    sourceSnapshot,
                    SourceOpenTarget.FullContent
                )
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
                    console.log("[loadFull] Using fallback extraction:", {
                        hasContent: !!contentToUse,
                        contentLength: contentToUse?.length || 0,
                        hasTemplates,
                        templateRatio: templateRatio.toFixed(3)
                    })
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
                
                // Debug: Log the content before setting state
                console.log("=== FULL CONTENT DEBUG ===")
                console.log("Content length:", contentToUse.length)
                console.log("Has <article>:", contentToUse.includes("<article"))
                console.log("First 500 chars:", contentToUse.substring(0, 500))
                console.log("========================")
                
                if (this._isMounted) {
                    this.setState({ 
                        fullContent: contentToUse, 
                        loaded: false, // Will be set true after ContentView loads
                        isLoadingFull: false,
                        webviewVisible: false, // Will be set true after ContentView initializes
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
                    webviewVisible: false,
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
                console.log("Title already in extracted content, skipping RSS summary but showing separator")
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
                console.log("Best teaser image found:", {
                    src: bestImage.src,
                    score: bestImage.score,
                    totalCandidates: images.length
                })
                return bestImage.html
            }

            return ""
        } catch (err) {
            console.error("Teaser image extraction failed:", err)
            return ""
        }
    }

    articleView = () => {
        const articleContent = this.isFullContentMode
            ? this.state.fullContent
            : this.props.item.content

        // Content-Analyse für Comic/Bild-Modus
        const imgCount = (articleContent.match(/<img/gi) || []).length
        const pictureCount = (articleContent.match(/<picture/gi) || []).length
        const totalImages = imgCount + pictureCount
        
        // Text ohne HTML-Tags extrahieren um reine Textlänge zu ermitteln
        const textOnly = articleContent.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
        const textLength = textOnly.length
        
        // Comic-Modus: Wenig Text (< 200 Zeichen) und mindestens ein Bild
        // Oder: Nur Bilder ohne nennenswerten Text
        const isComicMode = totalImages > 0 && textLength < 200
        const isSingleImage = totalImages === 1 && textLength < 100
        
        console.log("Article content analysis:", {
            url: this.props.item.link,
            totalImages,
            textLength,
            isComicMode,
            isSingleImage
        })

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

        // Baue HTML direkt mit eingebetteten Daten über JSON, nicht über Query-Parameter
        const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; img-src http: https: data:; style-src 'unsafe-inline'; frame-src http: https:; media-src http: https:; connect-src https: http:">
    <title>Article</title>
    <link rel="stylesheet" href="file://${this.state.appPath ? this.state.appPath.replace(/\\\\/g, '/') : '/'}/article/article.css" />
    <style>
html, body { margin: 0; padding: 0; font-family: "Segoe UI", "Source Han Sans Regular", sans-serif; }
body { padding: 12px 16px 32px; overflow-x: hidden; overflow-y: auto; font-size: ${this.state.fontSize}px; box-sizing: border-box; width: 100%; }
${this.state.fontFamily ? `body { font-family: "${this.state.fontFamily}"; }` : ''}
body.rtl { direction: rtl; }
body.vertical { writing-mode: vertical-rl; }
* { box-sizing: border-box; }
#main { display: none; width: 100%; margin: 0; }
#main.show { display: block; animation-name: fadeIn; animation-duration: 0.367s; animation-timing-function: cubic-bezier(0.1, 0.9, 0.2, 1); animation-fill-mode: both; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
#main > p.title { font-size: 1.25rem; line-height: 1.75rem; font-weight: 600; margin-block-end: 0; }
#main > p.date { color: #666; font-size: 0.875rem; margin-block-start: 0.5rem; }
#main > article { max-width: 800px; margin: 20px auto 0; padding: 0 16px; }
#main img { max-width: 100%; height: auto; }
#main table { max-width: 100%; overflow-x: auto; }
#main pre { max-width: 100%; overflow-x: auto; }
#main code { word-break: break-word; }
@media (prefers-color-scheme: dark) {
  body { background-color: #2d2d30; color: #f8f8f8; }
  #main > p.date { color: #a19f9d; }
  a { color: #4ba0e1; }
  a:hover, a:active { color: #65aee6; }
}

/* Comic Mode Styles - für Bilder-dominierte Inhalte */
.comic-mode #main {
    max-width: 100%;
    padding: 0;
}
.comic-mode article img,
.comic-mode #main > img {
    max-width: 100%;
    width: 100%;
    height: auto;
    display: block;
    margin: 0 auto;
}
.comic-mode .title,
.comic-mode .date {
    text-align: center;
    padding: 0 16px;
}
.comic-mode p {
    text-align: center;
}

/* Single Image Mode - einzelnes großes Bild */
.single-image #main {
    max-width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0;
}
.single-image article img,
.single-image #main > img {
    max-height: 90vh;
    width: auto;
    max-width: 100%;
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
    if (overflowElements.length > 0) {
        console.log('Elements causing horizontal overflow:', overflowElements);
    }
    
    // Fixiere absolute URLs
    for (let e of main.querySelectorAll("*[src]")) {
        e.src = e.src;
    }
    for (let e of main.querySelectorAll("*[href]")) {
        e.href = e.href;
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

        // Konvertiere zu base64 data URL um Längenbegrenzungen zu vermeiden
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
                        // Show placeholder when either webview is visible OR we have a blur screenshot
                        visibility: (this.state.webviewVisible || this.state.menuBlurScreenshot) ? "visible" : "hidden",
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
                                filter: "blur(4px) brightness(0.9)",
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
                            <Link onClick={this.webviewReload}>
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
