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
    dismissContextMenu: () => void
    updateSourceTextDirection: (
        source: RSSSource,
        direction: SourceTextDirection
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
}

class Article extends React.Component<ArticleProps, ArticleState> {
    webview: Electron.WebviewTag
    globalKeydownListener: (e: KeyboardEvent) => void
    globalKeyupListener: (e: KeyboardEvent) => void
    pressedZoomKeys: Set<string>
    currentZoom: number = 0  // Track zoom locally to avoid state lag

    constructor(props: ArticleProps) {
        super(props)
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
            zoom: 0,
            isLoadingFull: false,
            appPath: "",
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
        if (props.source.openTarget === SourceOpenTarget.FullContent) {
            this.loadFull()
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

    moreMenuProps = (): IContextualMenuProps => ({
        items: [
                        {
                key: "copyURL",
                text: intl.get("context.copyURL"),
                iconProps: { iconName: "Link" },
                onClick: () => {
                    window.utils.writeClipboard(this.props.item.link)
                },
            },
            {
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
                key: "divider_1",
                itemType: ContextualMenuItemType.Divider,
            },
            ...shareSubmenu(this.props.item),
        ],
    })

    contextMenuHandler = (pos: [number, number], text: string, url: string) => {
        if (pos) {
            if (text || url) this.props.textMenu(pos, text, url)
            else this.props.imageMenu(pos)
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
        try {
            // Verwende echten Zoom-Level statt Skalierung
            this.webview.send('set-webview-zoom', targetZoom);
        } catch {}
        if (!this.state.webviewVisible) this.setState({ webviewVisible: true });
    }

    webviewStartLoading = () => { 
        const targetZoom = this.props.source.defaultZoom || 0;
        try {
            // Verwende echten Zoom-Level statt Skalierung
            this.webview.send('set-webview-zoom', targetZoom);
        } catch {}
        if (!this.state.webviewVisible) this.setState({ webviewVisible: true });
    }
    webviewLoaded = () => {
        this.setState({ loaded: true })
        const targetZoom = this.props.source.defaultZoom || 0;
        try {
            this.sendZoomToPreload(targetZoom);
        } catch {}
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
        
        // Keyboard state tracking für Zoom
        this.pressedZoomKeys = new Set<string>()
        this.currentZoom = this.state.zoom || 0
        
        // Entferne alte Listener falls vorhanden
        if (this.globalKeydownListener) {
            document.removeEventListener('keydown', this.globalKeydownListener)
        }
        if (this.globalKeyupListener) {
            document.removeEventListener('keyup', this.globalKeyupListener)
        }
        
        // Global keyboard listener für Zoom (auch außerhalb WebView)
        this.globalKeydownListener = (e: KeyboardEvent) => {
            const MIN_ZOOM_LEVEL = -8
            const MAX_ZOOM_LEVEL = 17
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
        this.componentDidMount()
    }

    componentWillUnmount = () => {
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
            this.setState({ loadWebpage: false })
        } else if (
            this.props.item.link.startsWith("https://") ||
            this.props.item.link.startsWith("http://")
        ) {
            this.setState({ loadWebpage: true, loadFull: false })
        }
    }

    toggleFull = () => {
        if (this.state.loadFull) {
            this.setState({ loadFull: false })
        } else if (
            this.props.item.link.startsWith("https://") ||
            this.props.item.link.startsWith("http://")
        ) {
            this.setState({ loadFull: true, loadWebpage: false, webviewVisible: true })
            this.loadFull()
        }
    }
    loadFull = async () => {
        this.setState({ loaded: false, error: false })

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
                
                // Fallback: if extractor produces no content, extract manually
                if (!contentToUse || contentToUse.length === 0) {
                    contentToUse = this.fallbackExtractContent(html)
                } else {
                    // Clean up the extracted content to remove duplicates
                    contentToUse = this.cleanDuplicateContent(contentToUse)
                }
                
                this.setState({ 
                    fullContent: contentToUse, 
                    loaded: true,
                    isLoadingFull: false,
                    webviewVisible: true
                })
            }
        } catch (err) {
            console.error("Article loading failed:", err)
            if (link === this.props.item.link) {
                // Fallback to item content on error
                this.setState({ 
                    fullContent: this.props.item.content,
                    loaded: true,
                    error: true,
                    errorDescription: "ARTICLE_EXTRACTION_FAILURE",
                    isLoadingFull: false,
                    webviewVisible: true
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
            
            // Remove empty/junk elements
            doc.querySelectorAll('div, section').forEach((div) => {
                const text = (div as HTMLElement).textContent || ''
                const innerHTML = (div as HTMLElement).innerHTML || ''
                
                // Remove if mostly empty or contains tracking params with no text
                if (text.trim().length === 0) {
                    div.remove()
                } else if ((innerHTML.includes('?a=') || innerHTML.includes('?utm_') || innerHTML.includes('?ref=')) && text.trim().length < 50) {
                    div.remove()
                }
            })
            
            return doc.body.innerHTML
        } catch (err) {
            console.error("Content cleaning failed:", err)
            return html
        }
    }

    articleView = () => {
        const articleContent = this.state.loadFull
            ? this.state.fullContent
            : this.props.item.content

        const headerContent = renderToString(
            <>
                <p className="title">{this.props.item.title}</p>
                <p className="date">
                    {this.props.item.date.toLocaleString(
                        this.props.locale,
                        { hour12: !this.props.locale.startsWith("zh") }
                    )}
                </p>
            </>
        )

        const rtlClass = this.props.source.textDir === SourceTextDirection.RTL ? "rtl" : this.props.source.textDir === SourceTextDirection.Vertical ? "vertical" : ""

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
html, body { margin: 0; font-family: "Segoe UI", "Source Han Sans Regular", sans-serif; }
body { padding: 12px 96px 32px; overflow: hidden scroll; font-size: ${this.state.fontSize}px; }
${this.state.fontFamily ? `body { font-family: "${this.state.fontFamily}"; }` : ''}
body.rtl { direction: rtl; }
body.vertical { writing-mode: vertical-rl; }
#main { display: none; max-width: 700px; margin: auto; }
#main.show { display: block; animation-name: fadeIn; animation-duration: 0.367s; animation-timing-function: cubic-bezier(0.1, 0.9, 0.2, 1); animation-fill-mode: both; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
#main > p.title { font-size: 1.25rem; line-height: 1.75rem; font-weight: 600; margin-block-end: 0; }
#main > p.date { color: #666; font-size: 0.875rem; margin-block-start: 0.5rem; }
    </style>
</head>
<body class="${rtlClass}">
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
    
    // Create main content
    let main = document.getElementById("main");
    main.innerHTML = headerDom.body.innerHTML + '<article>' + article + '</article>';
    
    // Set base URL for relative links
    let baseEl = document.createElement('base');
    baseEl.setAttribute('href', baseUrl.split("/").slice(0, 3).join("/"));
    document.head.append(baseEl);
    
    // Remove scripts
    for (let s of main.querySelectorAll("script")) {
        s.parentNode.removeChild(s);
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
                        title={intl.get("article.loadFull")}
                        className={this.state.loadFull ? "active" : ""}
                        iconProps={{ iconName: "RawSource" }}
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
                    allowpopups={"true" as unknown as boolean}
                    disableguestresize={"false" as unknown as boolean}
                    webpreferences="contextIsolation,disableDialogs,autoplayPolicy=document-user-activation-required"
                    partition={this.state.loadWebpage ? "sandbox" : undefined}
                    allowFullScreen={"true" as unknown as boolean}
                    ref={(webview) => {
                        if (webview) {
                            this.webview = webview as any
                            // Set up event listeners
                            try {
                                webview.addEventListener('did-start-loading', this.webviewStartLoadingEarly)
                                webview.addEventListener('did-stop-loading', this.webviewLoaded)
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
