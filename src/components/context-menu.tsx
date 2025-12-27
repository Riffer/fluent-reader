import * as React from "react"
import intl from "react-intl-universal"
import QRCode from "qrcode.react"
import {
    cutText,
    webSearch,
    getSearchEngineName,
    platformCtrl,
} from "../scripts/utils"
import {
    ContextualMenu,
    IContextualMenuItem,
    ContextualMenuItemType,
    DirectionalHint,
} from "office-ui-fabric-react/lib/ContextualMenu"
import { ContextMenuType } from "../scripts/models/app"
import { RSSItem } from "../scripts/models/item"
import { RSSSource } from "../scripts/models/source"
import { ContextReduxProps } from "../containers/context-menu-container"
import { ViewType, ImageCallbackTypes, ViewConfigs, SourceGroup } from "../schema-types"
import { FilterType } from "../scripts/models/feed"

// ServiceRef for P2P shared feeds
const P2P_SHARED_SERVICE_REF = "p2p-shared"

// SourceState type for sources prop
type SourceState = { [sid: number]: RSSSource }

export type ContextMenuProps = ContextReduxProps & {
    type: ContextMenuType
    event?: MouseEvent | string
    position?: [number, number]
    item?: RSSItem
    source?: RSSSource
    sources?: SourceState
    groups?: SourceGroup[]
    feedId?: string
    text?: string
    url?: string
    viewType?: ViewType
    viewConfigs?: ViewConfigs
    filter?: FilterType
    sids?: number[]
    showItem: (feedId: string, item: RSSItem) => void
    markRead: (item: RSSItem) => void
    markUnread: (item: RSSItem) => void
    toggleStarred: (item: RSSItem) => void
    toggleHidden: (item: RSSItem) => void
    switchView: (viewType: ViewType) => void
    setViewConfigs: (configs: ViewConfigs) => void
    switchFilter: (filter: FilterType) => void
    toggleFilter: (filter: FilterType) => void
    markAllRead: (sids?: number[], date?: Date, before?: boolean) => void
    fetchItems: (sids: number[]) => void
    settings: (sids: number[]) => void
    subscribeFeed: (url: string, name?: string) => void
    removeFromGroup: (groupIndex: number, sids: number[]) => void
    updateSourceState: (source: RSSSource) => void
    close: () => void
}

// QR Code Menu Item - renders QR code directly
const QRCodeMenuItem = (props: { url: string }) => (
    <div style={{ padding: "12px", textAlign: "center" }}>
        <QRCode
            value={props.url}
            size={150}
            renderAs="svg"
            level="H"
            includeMargin={true}
        />
    </div>
)

// Exported function for rendering QR code in menu items (used by lite-exporter)
export const renderShareQR = (item: IContextualMenuItem): JSX.Element => (
    <div style={{ padding: "12px", textAlign: "center" }}>
        <QRCode
            value={item.url || ""}
            size={150}
            renderAs="svg"
            level="H"
            includeMargin={true}
        />
    </div>
)

// Basic share submenu (QR only) - used as fallback
export const shareSubmenu = (item: RSSItem): IContextualMenuItem[] => [
    {
        key: "divider",
        itemType: ContextualMenuItemType.Divider,
    },
    {
        key: "qr",
        onRender: () => <QRCodeMenuItem url={item.link} />,
    },
]

// P2P Peer info for share menu
interface P2PPeerInfo {
    peerId: string
    displayName: string
    connected: boolean
}

function getSearchItem(text: string): IContextualMenuItem {
    const engine = window.settings.getSearchEngine()
    return {
        key: "searchText",
        text: intl.get("context.search", {
            text: cutText(text, 15),
            engine: getSearchEngineName(engine),
        }),
        iconProps: { iconName: "Search" },
        onClick: () => webSearch(text, engine),
    }
}

interface ContextMenuState {
    p2pPeers: P2PPeerInfo[]
    p2pConnected: boolean
    feedSubscribed: boolean | null  // null = unknown, checking
}

export class ContextMenu extends React.Component<ContextMenuProps, ContextMenuState> {
    state: ContextMenuState = {
        p2pPeers: [],
        p2pConnected: false,
        feedSubscribed: null,
    }

    componentDidMount() {
        this.loadP2PStatus()
        this.checkFeedSubscription()
    }

    componentDidUpdate(prevProps: ContextMenuProps) {
        // Reload when menu opens or item changes
        if (prevProps.type !== this.props.type || prevProps.item?._id !== this.props.item?._id) {
            this.loadP2PStatus()
            this.checkFeedSubscription()
        }
    }

    loadP2PStatus = async () => {
        try {
            const status = await window.p2pLan.getStatus()
            if (status) {
                const peers: P2PPeerInfo[] = status.peers.map(p => ({
                    peerId: p.peerId,
                    displayName: p.displayName,
                    connected: p.connected,
                }))
                this.setState({
                    p2pPeers: peers,
                    p2pConnected: status.inRoom,
                })
            }
        } catch (err) {
            // P2P status not available
        }
    }

    checkFeedSubscription = async () => {
        // Check if this is a P2P feed that could be subscribed as a regular feed
        if (!this.props.source) {
            this.setState({ feedSubscribed: null })
            return
        }

        // P2P feeds have serviceRef = "p2p-shared" and store the real feed URL in source.url
        const isP2PFeed = this.props.source.serviceRef === P2P_SHARED_SERVICE_REF
        
        if (!isP2PFeed) {
            // Not a P2P feed - no subscription option needed
            this.setState({ feedSubscribed: null })
            return
        }

        // Check if the feed URL is a valid RSS/Atom feed URL (not the generic p2p:// URL)
        const feedUrl = this.props.source.url
        if (feedUrl.startsWith("p2p://")) {
            // Generic P2P shared feed without real URL - can't subscribe
            this.setState({ feedSubscribed: null })
            return
        }

        // Check if this feed URL is already subscribed as a non-P2P feed
        // We look in Redux state for a source with the same URL but different serviceRef
        const sources = this.props.sources
        if (sources) {
            const alreadySubscribed = Object.values(sources).some(
                s => s.url === feedUrl && s.serviceRef !== P2P_SHARED_SERVICE_REF
            )
            this.setState({ feedSubscribed: alreadySubscribed })
        } else {
            this.setState({ feedSubscribed: false })
        }
    }

    handleP2PShare = async (peerId: string, displayName: string) => {
        if (!this.props.item || !this.props.source) return
        
        try {
            const article = {
                url: this.props.item.link,
                title: this.props.item.title,
                feedUrl: this.props.source.url,
                feedName: this.props.source.name,
                feedIconUrl: this.props.source.iconurl,
                openTarget: this.props.source.openTarget,
                defaultZoom: this.props.source.defaultZoom,
            }
            
            // Try to send with ACK, fall back to queue
            const result = await window.p2pLan.sendArticlesWithAck(peerId, [article])
            if (!result.success) {
                // Queue for later
                await window.p2pLan.sendArticleLinkWithQueue(
                    peerId, 
                    article.title, 
                    article.url, 
                    article.feedName, 
                    article.feedUrl, 
                    article.feedIconUrl
                )
            }
        } catch (err) {
            console.error("[ContextMenu] P2P share failed:", err)
        }
    }

    handleSubscribeFeed = async () => {
        if (!this.props.source) return
        
        // Capture all needed values at start - props may change after await
        const source = { ...this.props.source } // Deep copy to avoid stale props
        const feedUrl = source.url
        const feedName = source.name
        const sid = source.sid
        const groups = this.props.groups ? [...this.props.groups] : undefined
        
        // Don't subscribe generic P2P URLs
        if (feedUrl.startsWith("p2p://")) {
            return
        }
        
        // Check if this is a P2P feed (has the special serviceRef)
        if (source.serviceRef === P2P_SHARED_SERVICE_REF) {
            await this.convertP2PFeedToActive(source, groups)
        } else {
            // Regular feed subscription via Redux
            if (this.props.subscribeFeed) {
                this.props.subscribeFeed(feedUrl, feedName)
            }
        }
        
        this.props.close()
    }
    
    // Handler for subscribing from Group context menu (works with sids prop)
    handleSubscribeFeedFromGroup = async (sid: number) => {
        if (!this.props.sources) return
        
        const source = this.props.sources[sid]
        if (!source) return
        
        // Capture values before async
        const sourceCopy = { ...source }
        const groups = this.props.groups ? [...this.props.groups] : undefined
        
        if (sourceCopy.serviceRef === P2P_SHARED_SERVICE_REF) {
            await this.convertP2PFeedToActive(sourceCopy, groups)
        }
        
        this.props.close()
    }
    
    // Shared logic for converting a P2P feed to an active feed
    convertP2PFeedToActive = async (source: RSSSource, groups: SourceGroup[] | undefined) => {
        const sid = source.sid
        
        try {
            // 1. Convert to active feed in DB (remove serviceRef)
            await window.db.p2pFeeds.convertToActive(sid)
            
            // 2. Update Redux sources state (remove serviceRef from the source object)
            if (this.props.updateSourceState) {
                const updatedSource: RSSSource = {
                    ...source,
                    serviceRef: undefined, // Remove P2P serviceRef
                }
                this.props.updateSourceState(updatedSource)
            }
            
            // 3. Remove from P2P group via Redux (this updates both UI and config.json)
            const P2P_GROUP_NAME = "P2P Geteilt"
            if (groups && this.props.removeFromGroup) {
                const p2pGroupIndex = groups.findIndex(
                    g => g.isMultiple && g.name === P2P_GROUP_NAME
                )
                if (p2pGroupIndex !== -1) {
                    const p2pGroup = groups[p2pGroupIndex]
                    if (p2pGroup.sids.includes(sid)) {
                        this.props.removeFromGroup(p2pGroupIndex, [sid])
                    }
                }
            }
            
            // 4. Fetch items to refresh the feed with new articles
            this.props.fetchItems([sid])
            
            // Update local state to reflect the change
            this.setState({ feedSubscribed: true })
        } catch (err) {
            console.error("[ContextMenu] Failed to convert P2P feed:", err)
        }
    }

    getShareSubmenuItems = (): IContextualMenuItem[] => {
        const items: IContextualMenuItem[] = []
        
        // P2P sharing section
        if (this.state.p2pConnected && this.state.p2pPeers.length > 0) {
            const connectedPeers = this.state.p2pPeers.filter(p => p.connected)
            
            if (connectedPeers.length > 0) {
                items.push({
                    key: "p2p-header",
                    text: "P2P Teilen",
                    itemType: ContextualMenuItemType.Header,
                })
                
                connectedPeers.forEach(peer => {
                    items.push({
                        key: `p2p-${peer.peerId}`,
                        text: peer.displayName,
                        iconProps: { iconName: "Contact" },
                        onClick: () => {
                            this.handleP2PShare(peer.peerId, peer.displayName)
                        },
                    })
                })
                
                items.push({
                    key: "p2p-divider",
                    itemType: ContextualMenuItemType.Divider,
                })
            }
        }
        
        // QR Code
        items.push({
            key: "qr-header",
            text: "QR Code",
            itemType: ContextualMenuItemType.Header,
        })
        items.push({
            key: "qr",
            onRender: () => <QRCodeMenuItem url={this.props.item?.link || ""} />,
        })
        
        return items
    }

    getItems = (): IContextualMenuItem[] => {
        switch (this.props.type) {
            case ContextMenuType.Item:
                return [
                    {
                        key: "showItem",
                        text: intl.get("context.read"),
                        iconProps: { iconName: "TextDocument" },
                        onClick: () => {
                            this.props.markRead(this.props.item)
                            this.props.showItem(
                                this.props.feedId,
                                this.props.item
                            )
                        },
                    },
                    {
                        key: "openInBrowser",
                        text: intl.get("openExternal"),
                        iconProps: { iconName: "NavigateExternalInline" },
                        onClick: e => {
                            this.props.markRead(this.props.item)
                            window.utils.openExternal(
                                this.props.item.link,
                                platformCtrl(e)
                            )
                        },
                    },
                    {
                        key: "markAsRead",
                        text: this.props.item.hasRead
                            ? intl.get("article.markUnread")
                            : intl.get("article.markRead"),
                        iconProps: this.props.item.hasRead
                            ? {
                                  iconName: "RadioBtnOn",
                                  style: { fontSize: 14, textAlign: "center" },
                              }
                            : { iconName: "StatusCircleRing" },
                        onClick: () => {
                            if (this.props.item.hasRead)
                                this.props.markUnread(this.props.item)
                            else this.props.markRead(this.props.item)
                        },
                        split: true,
                        subMenuProps: {
                            items: [
                                {
                                    key: "markBelow",
                                    text: intl.get("article.markBelow"),
                                    iconProps: {
                                        iconName: "Down",
                                        style: { fontSize: 14 },
                                    },
                                    onClick: () =>
                                        this.props.markAllRead(
                                            null,
                                            this.props.item.date
                                        ),
                                },
                                {
                                    key: "markAbove",
                                    text: intl.get("article.markAbove"),
                                    iconProps: {
                                        iconName: "Up",
                                        style: { fontSize: 14 },
                                    },
                                    onClick: () =>
                                        this.props.markAllRead(
                                            null,
                                            this.props.item.date,
                                            false
                                        ),
                                },
                            ],
                        },
                    },
                    {
                        key: "toggleStarred",
                        text: this.props.item.starred
                            ? intl.get("article.unstar")
                            : intl.get("article.star"),
                        iconProps: {
                            iconName: this.props.item.starred
                                ? "FavoriteStar"
                                : "FavoriteStarFill",
                        },
                        onClick: () => {
                            this.props.toggleStarred(this.props.item)
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
                        key: "divider_1",
                        itemType: ContextualMenuItemType.Divider,
                    },
                    {
                        key: "share",
                        text: intl.get("context.share"),
                        iconProps: { iconName: "Share" },
                        subMenuProps: {
                            items: this.getShareSubmenuItems(),
                        },
                    },
                    {
                        key: "copyLink",
                        text: intl.get("context.copyURL"),
                        iconProps: { iconName: "Copy" },
                        onClick: () => {
                            navigator.clipboard.writeText(this.props.item.link)
                        },
                    },
                    {   
                        key: "copyTitle",
                        text: intl.get("context.copyTitle"),
                        onClick: () => {
                            window.utils.writeClipboard(this.props.item.title)
                        },
                    },
                    ...(this.props.viewConfigs !== undefined
                        ? [
                              {
                                  key: "divider_2",
                                  itemType: ContextualMenuItemType.Divider,
                              },
                              {
                                  key: "view",
                                  text: intl.get("context.view"),
                                  subMenuProps: {
                                      items: [
                                          {
                                              key: "showCover",
                                              text: intl.get(
                                                  "context.showCover"
                                              ),
                                              canCheck: true,
                                              checked: Boolean(
                                                  this.props.viewConfigs &
                                                      ViewConfigs.ShowCover
                                              ),
                                              onClick: () =>
                                                  this.props.setViewConfigs(
                                                      this.props.viewConfigs ^
                                                          ViewConfigs.ShowCover
                                                  ),
                                          },
                                          {
                                              key: "showSnippet",
                                              text: intl.get(
                                                  "context.showSnippet"
                                              ),
                                              canCheck: true,
                                              checked: Boolean(
                                                  this.props.viewConfigs &
                                                      ViewConfigs.ShowSnippet
                                              ),
                                              onClick: () =>
                                                  this.props.setViewConfigs(
                                                      this.props.viewConfigs ^
                                                          ViewConfigs.ShowSnippet
                                                  ),
                                          },
                                          {
                                              key: "fadeRead",
                                              text: intl.get(
                                                  "context.fadeRead"
                                              ),
                                              canCheck: true,
                                              checked: Boolean(
                                                  this.props.viewConfigs &
                                                      ViewConfigs.FadeRead
                                              ),
                                              onClick: () =>
                                                  this.props.setViewConfigs(
                                                      this.props.viewConfigs ^
                                                          ViewConfigs.FadeRead
                                                  ),
                                          },
                                      ],
                                  },
                              },
                          ]
                        : []),
                ]
            case ContextMenuType.Text: {
                const items: IContextualMenuItem[] = this.props.text
                    ? [
                          {
                              key: "copyText",
                              text: intl.get("context.copy"),
                              iconProps: { iconName: "Copy" },
                              onClick: () => {
                                  window.utils.writeClipboard(this.props.text)
                              },
                          },
                          getSearchItem(this.props.text),
                      ]
                    : []
                if (this.props.url) {
                    items.push({
                        key: "urlSection",
                        itemType: ContextualMenuItemType.Section,
                        sectionProps: {
                            topDivider: items.length > 0,
                            items: [
                                {
                                    key: "openInBrowser",
                                    text: intl.get("openExternal"),
                                    iconProps: {
                                        iconName: "NavigateExternalInline",
                                    },
                                    onClick: e => {
                                        window.utils.openExternal(
                                            this.props.url,
                                            platformCtrl(e)
                                        )
                                    },
                                },
                                {
                                    key: "copyURL",
                                    text: intl.get("context.copyURL"),
                                    iconProps: { iconName: "Link" },
                                    onClick: () => {
                                        window.utils.writeClipboard(
                                            this.props.url
                                        )
                                    },
                                },
                            ],
                        },
                    })
                }
                
                return items
            }
            case ContextMenuType.Image:
                return [
                    {
                        key: "openInBrowser",
                        text: intl.get("openExternal"),
                        iconProps: { iconName: "NavigateExternalInline" },
                        onClick: e => {
                            if (platformCtrl(e)) {
                                window.utils.imageCallback(
                                    ImageCallbackTypes.OpenExternalBg
                                )
                            } else {
                                window.utils.imageCallback(
                                    ImageCallbackTypes.OpenExternal
                                )
                            }
                        },
                    },
                    {
                        key: "saveImageAs",
                        text: intl.get("context.saveImageAs"),
                        iconProps: { iconName: "SaveTemplate" },
                        onClick: () => {
                            window.utils.imageCallback(
                                ImageCallbackTypes.SaveAs
                            )
                        },
                    },
                    {
                        key: "copyImage",
                        text: intl.get("context.copyImage"),
                        iconProps: { iconName: "FileImage" },
                        onClick: () => {
                            window.utils.imageCallback(ImageCallbackTypes.Copy)
                        },
                    },
                    {
                        key: "copyImageURL",
                        text: intl.get("context.copyImageURL"),
                        iconProps: { iconName: "Link" },
                        onClick: () => {
                            window.utils.imageCallback(
                                ImageCallbackTypes.CopyLink
                            )
                        },
                    },
                ]
            case ContextMenuType.View:
                return [
                    {
                        key: "section_1",
                        itemType: ContextualMenuItemType.Section,
                        sectionProps: {
                            title: intl.get("context.view"),
                            bottomDivider: true,
                            items: [
                                {
                                    key: "cardView",
                                    text: intl.get("context.cardView"),
                                    iconProps: { iconName: "GridViewMedium" },
                                    canCheck: true,
                                    checked:
                                        this.props.viewType === ViewType.Cards,
                                    onClick: () =>
                                        this.props.switchView(ViewType.Cards),
                                },
                                {
                                    key: "listView",
                                    text: intl.get("context.listView"),
                                    iconProps: { iconName: "BacklogList" },
                                    canCheck: true,
                                    checked:
                                        this.props.viewType === ViewType.List,
                                    onClick: () =>
                                        this.props.switchView(ViewType.List),
                                },
                                {
                                    key: "magazineView",
                                    text: intl.get("context.magazineView"),
                                    iconProps: { iconName: "Articles" },
                                    canCheck: true,
                                    checked:
                                        this.props.viewType ===
                                        ViewType.Magazine,
                                    onClick: () =>
                                        this.props.switchView(
                                            ViewType.Magazine
                                        ),
                                },
                                {
                                    key: "compactView",
                                    text: intl.get("context.compactView"),
                                    iconProps: { iconName: "BulletedList" },
                                    canCheck: true,
                                    checked:
                                        this.props.viewType ===
                                        ViewType.Compact,
                                    onClick: () =>
                                        this.props.switchView(ViewType.Compact),
                                },
                            ],
                        },
                    },
                    {
                        key: "section_2",
                        itemType: ContextualMenuItemType.Section,
                        sectionProps: {
                            title: intl.get("context.filter"),
                            bottomDivider: true,
                            items: [
                                {
                                    key: "allArticles",
                                    text: intl.get("allArticles"),
                                    iconProps: { iconName: "ClearFilter" },
                                    canCheck: true,
                                    checked:
                                        (this.props.filter &
                                            ~FilterType.Toggles) ==
                                        FilterType.Default,
                                    onClick: () =>
                                        this.props.switchFilter(
                                            FilterType.Default
                                        ),
                                },
                                {
                                    key: "unreadOnly",
                                    text: intl.get("context.unreadOnly"),
                                    iconProps: {
                                        iconName: "RadioBtnOn",
                                        style: {
                                            fontSize: 14,
                                            textAlign: "center",
                                        },
                                    },
                                    canCheck: true,
                                    checked:
                                        (this.props.filter &
                                            ~FilterType.Toggles) ==
                                        FilterType.UnreadOnly,
                                    onClick: () =>
                                        this.props.switchFilter(
                                            FilterType.UnreadOnly
                                        ),
                                },
                                {
                                    key: "starredOnly",
                                    text: intl.get("context.starredOnly"),
                                    iconProps: { iconName: "FavoriteStarFill" },
                                    canCheck: true,
                                    checked:
                                        (this.props.filter &
                                            ~FilterType.Toggles) ==
                                        FilterType.StarredOnly,
                                    onClick: () =>
                                        this.props.switchFilter(
                                            FilterType.StarredOnly
                                        ),
                                },
                            ],
                        },
                    },
                    {
                        key: "section_3",
                        itemType: ContextualMenuItemType.Section,
                        sectionProps: {
                            title: intl.get("search"),
                            bottomDivider: true,
                            items: [
                                {
                                    key: "caseSensitive",
                                    text: intl.get("context.caseSensitive"),
                                    iconProps: {
                                        style: {
                                            fontSize: 12,
                                            fontStyle: "normal",
                                        },
                                        children: "Aa",
                                    },
                                    canCheck: true,
                                    checked: !(
                                        this.props.filter &
                                        FilterType.CaseInsensitive
                                    ),
                                    onClick: () =>
                                        this.props.toggleFilter(
                                            FilterType.CaseInsensitive
                                        ),
                                },
                                {
                                    key: "fullSearch",
                                    text: intl.get("context.fullSearch"),
                                    iconProps: { iconName: "Breadcrumb" },
                                    canCheck: true,
                                    checked: Boolean(
                                        this.props.filter &
                                            FilterType.FullSearch
                                    ),
                                    onClick: () =>
                                        this.props.toggleFilter(
                                            FilterType.FullSearch
                                        ),
                                },
                            ],
                        },
                    },
                    {
                        key: "showHidden",
                        text: intl.get("context.showHidden"),
                        canCheck: true,
                        checked: Boolean(
                            this.props.filter & FilterType.ShowHidden
                        ),
                        onClick: () =>
                            this.props.toggleFilter(FilterType.ShowHidden),
                    },
                ]
            case ContextMenuType.Group:
                // Check if this is a single P2P feed
                const isP2PFeed = this.props.sids?.length === 1 && 
                    this.props.sources && 
                    this.props.sources[this.props.sids[0]]?.serviceRef === P2P_SHARED_SERVICE_REF
                
                return [
                    // Subscribe option for P2P feeds
                    ...(isP2PFeed ? [
                        {
                            key: "subscribeFeed",
                            text: intl.get("context.subscribeFeed"),
                            iconProps: { iconName: "Add" },
                            onClick: () => this.handleSubscribeFeedFromGroup(this.props.sids[0]),
                        },
                        {
                            key: "divider_subscribe",
                            itemType: ContextualMenuItemType.Divider,
                        },
                    ] : []),
                    {
                        key: "markAllRead",
                        text: intl.get("nav.markAllRead"),
                        iconProps: { iconName: "CheckMark" },
                        onClick: () => this.props.markAllRead(this.props.sids),
                    },
                    {
                        key: "refresh",
                        text: intl.get("nav.refresh"),
                        iconProps: { iconName: "Sync" },
                        onClick: () => this.props.fetchItems(this.props.sids),
                    },
                    {
                        key: "manage",
                        text: intl.get("context.manageSources"),
                        iconProps: { iconName: "Settings" },
                        onClick: () => this.props.settings(this.props.sids),
                    },
                ]
            case ContextMenuType.MarkRead:
                return [
                    {
                        key: "section_1",
                        itemType: ContextualMenuItemType.Section,
                        sectionProps: {
                            title: intl.get("nav.markAllRead"),
                            items: [
                                {
                                    key: "all",
                                    text: intl.get("allArticles"),
                                    iconProps: { iconName: "ReceiptCheck" },
                                    onClick: () => this.props.markAllRead(),
                                },
                                {
                                    key: "1d",
                                    text: intl.get("app.daysAgo", { days: 1 }),
                                    onClick: () => {
                                        let date = new Date()
                                        date.setTime(date.getTime() - 86400000)
                                        this.props.markAllRead(null, date)
                                    },
                                },
                                {
                                    key: "3d",
                                    text: intl.get("app.daysAgo", { days: 3 }),
                                    onClick: () => {
                                        let date = new Date()
                                        date.setTime(
                                            date.getTime() - 3 * 86400000
                                        )
                                        this.props.markAllRead(null, date)
                                    },
                                },
                                {
                                    key: "7d",
                                    text: intl.get("app.daysAgo", { days: 7 }),
                                    onClick: () => {
                                        let date = new Date()
                                        date.setTime(
                                            date.getTime() - 7 * 86400000
                                        )
                                        this.props.markAllRead(null, date)
                                    },
                                },
                            ],
                        },
                    },
                ]
            default:
                return []
        }
    }

    render() {
        return this.props.type == ContextMenuType.Hidden ? null : (
            <ContextualMenu
                directionalHint={DirectionalHint.bottomLeftEdge}
                items={this.getItems()}
                target={
                    this.props.event ||
                    (this.props.position && {
                        left: this.props.position[0],
                        top: this.props.position[1],
                    })
                }
                onDismiss={this.props.close}
            />
        )
    }
}
