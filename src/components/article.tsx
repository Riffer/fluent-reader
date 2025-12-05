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

const FONT_SIZE_OPTIONS = [8, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]

type ArticleProps = {
    item: RSSItem
    source: RSSSource
    locale: string
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
}

type ArticleState = {
    fontFamily: string
    fontSize: number
    loadWebpage: boolean
    loadFull: boolean
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
}

class Article extends React.Component<ArticleProps, ArticleState> {
    webview: Electron.WebviewTag
    globalKeydownListener: (e: KeyboardEvent) => void
    globalKeyupListener: (e: KeyboardEvent) => void
    pressedZoomKeys: Set<string>
    currentZoom: number = 0  // Track zoom locally to avoid state lag
    private _isMounted = false

    constructor(props: ArticleProps) {
        super(props)
        // Initialisiere mit dem gespeicherten Feed-Zoom
        const initialZoom = props.source.defaultZoom || 0
        this.currentZoom = initialZoom
        this.state = {
            fontFamily: window.settings.getFont(),
            fontSize: window.settings.getFontSize(),
            loadWebpage: props.source.openTarget === SourceOpenTarget.Webpage,
            loadFull: props.source.openTarget === SourceOpenTarget.FullContent,
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

    private sendZoomToPreload = (zoom: number) => {
        if (!this.webview) return;
        try {
            this.webview.send('set-webview-zoom', zoom);
        } catch (e) {
            // Falls das Webview noch nicht bereit ist, nach dom-ready einmalig senden
            const once = () => {
                try { this.webview.send('set-webview-zoom', zoom); } catch {}
                this.webview.removeEventListener('dom-ready', once as any);
            };
            try { this.webview.addEventListener('dom-ready', once as any); } catch {}
        }
    }

    private sendZoomOverlaySettingToPreload = (show: boolean) => {
        if (!this.webview) return;
        try {
            this.webview.send('set-zoom-overlay-setting', show);
        } catch (e) {
            // Falls das Webview noch nicht bereit ist, nach dom-ready einmalig senden
            const once = () => {
                try { this.webview.send('set-zoom-overlay-setting', show); } catch {}
                this.webview.removeEventListener('dom-ready', once as any);
            };
            try { this.webview.addEventListener('dom-ready', once as any); } catch {}
        }
    }

    private toggleZoomOverlay = () => {
        const newValue = !this.state.showZoomOverlay;
        window.settings.setZoomOverlay(newValue);
        this.setState({ showZoomOverlay: newValue });
        this.sendZoomOverlaySettingToPreload(newValue);
    }

    private toggleMobileMode = () => {
        const newMobileMode = !this.props.source.mobileMode;
        this.props.updateMobileMode(this.props.source, newMobileMode);
        // Webview neu laden damit die Einstellung greift
        this.reloadWebview();
    }

    private toggleNsfwCleanup = () => {
        const newValue = !this.state.nsfwCleanupEnabled;
        window.settings.setNsfwCleanup(newValue);
        this.setState({ nsfwCleanupEnabled: newValue });
        // Webview neu laden damit die Einstellung greift
        this.reloadWebview();
    }

    private reloadWebview = () => {
        if (this.webview) {
            try {
                this.webview.reload();
            } catch {}
        }
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
                disabled: this.state.loadWebpage,
                subMenuProps: this.fontFamilyMenuProps(),
            },
            {
                key: "fontSizeMenu",
                text: intl.get("article.fontSize"),
                iconProps: { iconName: "FontSize" },
                disabled: this.state.loadWebpage,
                subMenuProps: this.fontSizeMenuProps(),
            },
            {
                key: "directionMenu",
                text: intl.get("article.textDir"),
                iconProps: { iconName: "ChangeEntitlements" },
                disabled: this.state.loadWebpage,
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
                            disabled: !this.state.loadFull && !this.state.loadWebpage,
                            onClick: () => {
                                if (this.state.loadFull && this.state.fullContent) {
                                    window.utils.writeClipboard(this.state.fullContent)
                                } else if (this.state.loadWebpage && this.webview) {
                                    this.webview.executeJavaScript(`
                                        (function() {
                                            const html = document.documentElement.outerHTML;
                                            return html;
                                        })()
                                    `, false).then((result: string) => {
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
                            disabled: !this.state.loadFull && !this.state.loadWebpage,
                            onClick: () => {
                                if (this.state.loadFull && this.webview) {
                                    this.webview.executeJavaScript(`
                                        (function() {
                                            const html = document.documentElement.outerHTML;
                                            return html;
                                        })()
                                    `, false).then((result: string) => {
                                        if (result) {
                                            window.utils.writeClipboard(result)
                                        }
                                    }).catch((err: any) => {
                                        console.error('Fehler beim Kopieren des berechneten Quelltexts:', err)
                                    })
                                } else if (this.state.loadWebpage && this.webview) {
                                    this.webview.executeJavaScript(`
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
                                    `, false).then((result: string) => {
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
                            iconProps: { iconName: this.props.source.mobileMode ? "CheckMark" : "" },
                            canCheck: true,
                            checked: this.props.source.mobileMode || false,
                            disabled: !this.state.loadWebpage,
                            onClick: this.toggleMobileMode,
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
                                if (this.webview) {
                                    this.webview.openDevTools()
                                }
                            },
                        },
                    ],
                },
            },
        )
        
        return {
            items: items,
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

    keyDownHandler = (input: Electron.Input) => {
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
                    const newZoomUp = (this.state.zoom || 0) + 1;
                    this.setState({ zoom: newZoomUp });
                    this.sendZoomToPreload(newZoomUp);
                    this.updateDefaultZoom(newZoomUp);
                    break;
                case "-":
                    const newZoomDown = (this.state.zoom || 0) - 1;
                    this.setState({ zoom: newZoomDown });
                    this.sendZoomToPreload(newZoomDown);
                    this.updateDefaultZoom(newZoomDown);
                    break;
                case "#":
                    this.setState({ zoom: 0 });
                    this.sendZoomToPreload(0);
                    this.updateDefaultZoom(0);
                    break;
                case "*":
                    // Strg+Shift+8: Zoom vergrößern
                    if (input.shift) {
                        const newZoomUp = (this.state.zoom || 0) + 1;
                        this.setState({ zoom: newZoomUp });
                        this.sendZoomToPreload(newZoomUp);
                        this.updateDefaultZoom(newZoomUp);
                    }
                    break;
                case "_":
                    // Strg+Shift+Minus: Zoom verkleinern
                    if (input.shift) {
                        const newZoomDown = (this.state.zoom || 0) - 1;
                        this.setState({ zoom: newZoomDown });
                        this.sendZoomToPreload(newZoomDown);
                        this.updateDefaultZoom(newZoomDown);
                    }
                    break;
                case "w":
                case "W":
                    this.toggleFull()
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

    // Früh beim Start der Navigation Zoom setzen und Sichtbarkeit aktivieren
    webviewStartLoadingEarly = () => {
        if (!this.webview) return;
        const targetZoom = this.props.source.defaultZoom || 0;
        // Synchronisiere currentZoom mit dem Feed-Zoom
        this.currentZoom = targetZoom;
        try {
            // Verwende echten Zoom-Level statt Skalierung
            this.webview.send('set-webview-zoom', targetZoom);
        } catch {}
        if (!this.state.webviewVisible) this.setState({ webviewVisible: true });
    }

    webviewStartLoading = () => { 
        const targetZoom = this.props.source.defaultZoom || 0;
        // Synchronisiere currentZoom mit dem Feed-Zoom
        this.currentZoom = targetZoom;
        try {
            // Verwende echten Zoom-Level statt Skalierung
            this.webview.send('set-webview-zoom', targetZoom);
            // Sende Zoom-Overlay-Einstellung
            this.webview.send('set-zoom-overlay-setting', this.state.showZoomOverlay);
        } catch {}
        if (!this.state.webviewVisible) this.setState({ webviewVisible: true });
    }
    webviewLoaded = () => {
        this.setState({ loaded: true })
        const targetZoom = this.props.source.defaultZoom || 0;
        // Synchronisiere currentZoom mit dem Feed-Zoom
        this.currentZoom = targetZoom;
        try {
            this.sendZoomToPreload(targetZoom);
            // Sende Zoom-Overlay-Einstellung nochmals
            this.sendZoomOverlaySettingToPreload(this.state.showZoomOverlay);
            // NSFW-Cleanup wird jetzt synchron beim Preload-Start geladen, kein IPC nötig
        } catch {}
        // Focus auf Webview setzen nachdem alles geladen ist
        this.focusWebviewAfterLoad()
    }
    webviewError = (reason: string) => {
        this.setState({ error: true, errorDescription: reason })
    }
    webviewReload = () => {
        if (this.webview) {
            this.setState({ loaded: false, error: false })
            this.webview.reload()
        } else if (this.state.loadFull) {
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
        
        // Load full content if needed
        if (this.state.loadFull && !this.state.fullContent) {
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
                this.sendZoomToPreload(newZoom)
                this.updateDefaultZoom(newZoom)
            } else if (e.key === '-' || e.key === '_') {
                const newZoom = Math.max(MIN_ZOOM_LEVEL, this.currentZoom - 1)
                this.currentZoom = newZoom
                this.setState({ zoom: newZoom })
                this.sendZoomToPreload(newZoom)
                this.updateDefaultZoom(newZoom)
            } else if (e.key === '#') {
                this.currentZoom = 0
                this.setState({ zoom: 0 })
                this.sendZoomToPreload(0)
                this.updateDefaultZoom(0)
            }
        }
        
        this.globalKeyupListener = (e: KeyboardEvent) => {
            this.pressedZoomKeys.delete(e.key)
        }
        
        document.addEventListener('keydown', this.globalKeydownListener)
        document.addEventListener('keyup', this.globalKeyupListener)
        
        let webview = document.getElementById("article") as Electron.WebviewTag
        if (webview != this.webview) {
            this.webview = webview
            if (webview) {
                webview.focus()
                this.setState({ loaded: false, error: false })
                // Vor dem Laden: Zoom direkt setzen und sichtbar schalten
                this.webviewStartLoadingEarly()
                webview.addEventListener("did-stop-loading", this.webviewLoaded)
                webview.addEventListener("did-start-loading", this.webviewStartLoadingEarly)
                webview.addEventListener("dom-ready", this.webviewStartLoading)
                // Keyboard shortcuts for zoom control
                webview.addEventListener('keydown', (e: any) => {
                    try {
                        if (e.key === '+' || e.key === '=') {
                            this.sendZoomToPreload(this.state.zoom + 1)
                        } else if (e.key === '-' || e.key === '_') {
                            this.sendZoomToPreload(this.state.zoom - 1)
                        } else if (e.key === '#') {
                            this.sendZoomToPreload(0)
                        }
                    } catch {}
                })
                // Events aus sendToHost (Preload -> Renderer) entgegennehmen
                webview.addEventListener('ipc-message', (e: any) => {
                    try {
                        if (e && e.channel === 'webview-zoom-changed' && typeof e.args?.[0] === 'number') {
                            this.props.updateDefaultZoom(this.props.source, e.args[0])
                        } else if (e && e.channel === 'article-nav' && e.args?.[0]) {
                            // Handle left/right arrow navigation from webview
                            const direction = e.args[0].direction;
                            this.props.offsetItem(direction);
                        }
                    } catch {}
                })
                // Close DevTools before navigation to prevent crash
                webview.addEventListener('will-navigate', () => {
                    try {
                        if (webview.isDevToolsOpened()) {
                            webview.closeDevTools()
                        }
                    } catch {}
                })
                let card = document.querySelector(
                    `#refocus div[data-iid="${this.props.item._id}"]`
                ) as HTMLElement
                // @ts-ignore
                if (card) card.scrollIntoViewIfNeeded()
            }
        }
    }
    componentDidUpdate = (prevProps: ArticleProps) => {
        if (prevProps.item._id != this.props.item._id) {
            // Synchronisiere currentZoom sofort bei Artikelwechsel
            const savedZoom = this.props.source.defaultZoom || 0
            this.currentZoom = savedZoom
            this.setState({ zoom: savedZoom })
            
            // Close DevTools before article change to prevent crash
            try {
                if (this.webview && this.webview.isDevToolsOpened()) {
                    this.webview.closeDevTools()
                }
            } catch {}
            
            const loadFull = this.props.source.openTarget === SourceOpenTarget.FullContent
            this.setState({
                loadWebpage:
                    this.props.source.openTarget === SourceOpenTarget.Webpage,
                loadFull: loadFull,
                fullContent: "",
                isLoadingFull: false,
            }, () => {
                if (loadFull) {
                    this.setState({ isLoadingFull: true })
                    this.loadFull()
                } else if (this.state.loadWebpage) {
                    // For webpage: focus after dom-ready
                    if (this.webview) {
                        const focusOnReady = () => {
                            this.webview.focus()
                            this.webview.removeEventListener('dom-ready', focusOnReady)
                        }
                        this.webview.addEventListener('dom-ready', focusOnReady)
                    }
                } else {
                    // For regular feed content: focus webview
                    this.sendZoomToPreload(this.currentZoom)
                    this.focusWebviewAfterLoad()
                }
            })
        } else if (prevProps.source.openTarget !== this.props.source.openTarget) {
            // If openTarget changes, update the state
            const loadFull = this.props.source.openTarget === SourceOpenTarget.FullContent
            this.setState({
                loadWebpage:
                    this.props.source.openTarget === SourceOpenTarget.Webpage,
                loadFull: loadFull,
            })
        }
    }
    
    // Focus webview after full content is loaded
    private focusWebviewAfterLoad = () => {
        if (this.webview) {
            // Kleiner Delay um sicherzustellen, dass das Webview bereit ist
            setTimeout(() => {
                if (this.webview && this._isMounted) {
                    this.webview.focus()
                }
            }, 100)
        }
    }

    componentWillUnmount = () => {
        this._isMounted = false
        
        // Close DevTools before unmount to prevent crash
        try {
            if (this.webview && this.webview.isDevToolsOpened()) {
                this.webview.closeDevTools()
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
        if (this.state.loadWebpage) {
            this.setState({ loadWebpage: false }, () => {
                // Switch back to Local (RSS) mode and persist
                this.props.updateSourceOpenTarget(
                    this.props.source,
                    SourceOpenTarget.Local
                )
            })
        } else if (
            this.props.item.link.startsWith("https://") ||
            this.props.item.link.startsWith("http://")
        ) {
            this.setState({ loadWebpage: true, loadFull: false }, () => {
                // Update source to persist openTarget
                this.props.updateSourceOpenTarget(
                    this.props.source,
                    SourceOpenTarget.Webpage
                )
                // Focus webview after switching to webpage mode
                if (this.webview) {
                    const focusOnReady = () => {
                        this.webview.focus()
                        this.webview.removeEventListener('dom-ready', focusOnReady)
                    }
                    this.webview.addEventListener('dom-ready', focusOnReady)
                }
            })
        }
    }

    toggleFull = () => {
        if (this.state.loadFull) {
            this.setState({ loadFull: false }, () => {
                // Switch back to Local (RSS) mode and persist
                this.props.updateSourceOpenTarget(
                    this.props.source,
                    SourceOpenTarget.Local
                )
                // Set focus to webview for RSS content
                if (this.webview) {
                    const focusOnReady = () => {
                        this.webview.focus()
                        this.webview.removeEventListener('dom-ready', focusOnReady)
                    }
                    this.webview.addEventListener('dom-ready', focusOnReady)
                }
            })
        } else if (
            this.props.item.link.startsWith("https://") ||
            this.props.item.link.startsWith("http://")
        ) {
            this.setState({ loadFull: true, loadWebpage: false, webviewVisible: true }, () => {
                // Update source to persist openTarget
                this.props.updateSourceOpenTarget(
                    this.props.source,
                    SourceOpenTarget.FullContent
                )
                // Focus webview after switching to full content mode
                this.loadFull()
            })
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
                
                // Fallback: if extractor produces no content, extract manually
                if (!contentToUse || contentToUse.length === 0) {
                    contentToUse = this.fallbackExtractContent(html)
                } else {
                    // Clean up the extracted content to remove duplicates
                    contentToUse = this.cleanDuplicateContent(contentToUse)
                    
                    // DEBUG: Check the structure of extracted content
                    console.log("[DEBUG] Extracted content starts with:", contentToUse.substring(0, 100))
                    console.log("[DEBUG] Has <article>:", contentToUse.includes("<article"))
                    console.log("[DEBUG] Has <div>:", contentToUse.substring(0, 200).includes("<div"))
                    console.log("[DEBUG] Content length:", contentToUse.length)
                }
                
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
                        loaded: true,
                        isLoadingFull: false,
                        webviewVisible: true,
                        extractorTitle: extractorTitle,
                        extractorDate: extractorDate
                    }, () => {
                        // Apply saved zoom level and focus webview after full content is rendered
                        const savedZoom = this.props.source.defaultZoom || 0
                        this.currentZoom = savedZoom
                        this.sendZoomToPreload(savedZoom)
                        this.focusWebviewAfterLoad()
                    })
                }
            }
        } catch (err) {
            console.error("Article loading failed:", err)
            if (link === this.props.item.link && this._isMounted) {
                // Fallback to item content on error
                this.setState({ 
                    fullContent: this.props.item.content,
                    loaded: true,
                    error: true,
                    errorDescription: "ARTICLE_EXTRACTION_FAILURE",
                    isLoadingFull: false,
                    webviewVisible: true,
                    extractorTitle: undefined,
                    extractorDate: undefined
                }, () => {
                    // Apply saved zoom level and focus webview after fallback content is rendered
                    const savedZoom = this.props.source.defaultZoom || 0
                    this.currentZoom = savedZoom
                    this.sendZoomToPreload(savedZoom)
                    this.focusWebviewAfterLoad()
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
                if (el && el.textContent && el.textContent.trim().length > 300) {
                    return el.innerHTML
                }
            }
            
            // Last resort: return body
            return doc.body.innerHTML
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
        const articleContent = this.state.loadFull
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
        const displayTitle = this.state.loadFull && this.state.extractorTitle ? this.state.extractorTitle : this.props.item.title
        const displayDate = this.state.loadFull && this.state.extractorDate ? this.state.extractorDate : this.props.item.date

        // When showing full content with extractor metadata, don't show duplicate header in main
        // (it's already in the <article> structure)
        const headerContent = renderToString(
            <>
                {!(this.state.loadFull && this.state.extractorTitle) && (
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
})};

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
                                : this.state.loadFull 
                                    ? intl.get("article.loadFull") + " ✓ (geladen)"
                                    : intl.get("article.loadFull")
                        }
                        className={!this.state.loadWebpage ? "active" : ""}
                        iconProps={{ 
                            iconName: this.state.isLoadingFull 
                                ? "Sync" 
                                : this.state.loadFull 
                                    ? "CheckMark" 
                                    : "RawSource" 
                        }}
                        onClick={this.toggleFull}
                    />
                    <CommandBarButton
                        title={intl.get("article.loadWebpage")}
                        className={this.state.loadWebpage ? "active" : ""}
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
            {(!this.state.loadFull && !this.state.loadWebpage) || (this.state.loadFull && this.state.fullContent) || this.state.loadWebpage ? (
                <webview
                    id="article"
                    className={this.state.error ? "error" : ""}
                    style={{ visibility: this.state.webviewVisible ? "visible" : "hidden" }}
                    key={
                        this.props.item._id +
                        (this.state.loadWebpage ? "_" : "") +
                        (this.state.loadFull ? "__" : "") +
                        (this.state.fullContent ? "_content" : "") +
                        (this.state.appPath ? "_app" : "")
                    }
                    src={
                        this.state.loadWebpage
                            ? this.props.item.link
                            : this.articleView()
                    }
                    preload={(window as any).webviewPreloadPath || 'webview-preload.js'}
                    allowpopups={"true" as any}
                    disableguestresize={"false" as any}
                    webpreferences="contextIsolation,disableDialogs,autoplayPolicy=document-user-activation-required"
                    partition={this.state.loadWebpage ? "sandbox" : undefined}
                    allowFullScreen={true}
                    ref={(webview) => {
                        if (webview) {
                            this.webview = webview as any
                            // Set up event listeners
                            try {
                                webview.addEventListener('did-start-loading', this.webviewStartLoadingEarly)
                                webview.addEventListener('did-stop-loading', this.webviewLoaded)
                                // Close DevTools before navigation to prevent crash
                                webview.addEventListener('will-navigate', () => {
                                    try {
                                        const wv = webview as Electron.WebviewTag
                                        if (wv.isDevToolsOpened()) {
                                            wv.closeDevTools()
                                        }
                                    } catch {}
                                })
                            } catch {}
                        }
                    }}
                />
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
        </FocusZone>
        )
    }
}

export default Article
