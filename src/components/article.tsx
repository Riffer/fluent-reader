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
                // If extraction successful, use extracted content; otherwise use fetched HTML
                const contentToUse = (article && article.content) ? article.content : html
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

    articleView = () => {
        const a = encodeURIComponent(
            this.state.loadFull
                ? this.state.fullContent
                : this.props.item.content
        )
        const h = encodeURIComponent(
            renderToString(
                <>
                    <p className="title">{this.props.item.title}</p>
                    <p className="date">
                        {this.props.item.date.toLocaleString(
                            this.props.locale,
                            { hour12: !this.props.locale.startsWith("zh") }
                        )}
                    </p>
                    <article></article>
                </>
            )
        )
        // Use data: URL instead of file:// to avoid WebView issues with external files
        // The HTML is embedded as base64 data URL with inline JavaScript
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
body { padding: 12px 96px 32px; overflow: hidden scroll; }
body.rtl { direction: rtl; }
body.vertical { writing-mode: vertical-rl; }
#main { display: none; max-width: 700px; margin: auto; }
#main.show { display: block; animation-name: fadeIn; animation-duration: 0.367s; animation-timing-function: cubic-bezier(0.1, 0.9, 0.2, 1); animation-fill-mode: both; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
#main > p.title { font-size: 1.25rem; line-height: 1.75rem; font-weight: 600; margin-block-end: 0; }
#main > p.date { color: #666; font-size: 0.875rem; margin-block-start: 0.5rem; }
    </style>
</head>
<body>
    <div id="main"></div>
    <script>

function get(name) {
    if (name = (new RegExp('[?&]' + encodeURIComponent(name) + '=([^&]*)')).exec(location.search))
        return decodeURIComponent(name[1]);
}
let dir = get("d")
if (dir === "1") {
    document.body.classList.add("rtl")
} else if (dir === "2") {
    document.body.classList.add("vertical")
    document.body.addEventListener("wheel", (evt) => {
        document.scrollingElement.scrollLeft -= evt.deltaY;
    });
}
async function getArticle(url) {
    return get("a") || ""
}
document.documentElement.style.fontSize = get("s") + "px"
let font = get("f")
if (font) document.body.style.fontFamily = \`"\${font}"\`
let url = get("u")
getArticle(url).then(article => {
    let domParser = new DOMParser()
    let dom = domParser.parseFromString(get("h"), "text/html")
    let articleEl = dom.getElementsByTagName("article")[0]
    if (!articleEl) {
        articleEl = dom.createElement("article")
        if (dom.body) dom.body.appendChild(articleEl)
    }
    articleEl.innerHTML = article
    let baseEl = dom.createElement('base')
    baseEl.setAttribute('href', url.split("/").slice(0, 3).join("/"))
    dom.head.append(baseEl)
    for (let s of dom.getElementsByTagName("script")) {
        s.parentNode.removeChild(s)
    }
    for (let e of dom.querySelectorAll("*[src]")) {
        e.src = e.src
    }
    for (let e of dom.querySelectorAll("*[href]")) {
        e.href = e.href
    }
    let main = document.getElementById("main")
    main.innerHTML = dom.body.innerHTML
    main.classList.add("show")
}).catch(err => {
    console.error("[article.js] Error loading article:", err)
})
    </script>
</body>
</html>`
        
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}?a=${a}&h=${h}&f=${encodeURIComponent(
            this.state.fontFamily
        )}&s=${this.state.fontSize}&d=${this.props.source.textDir}&u=${
            this.props.item.link
        }`
        return url
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
