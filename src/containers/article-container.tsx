import { connect } from "react-redux"
import { createSelector } from "reselect"
import { RootState } from "../scripts/reducer"
import {
    RSSItem,
    markUnread,
    markRead,
    toggleStarred,
    toggleHidden,
    itemShortcuts,
} from "../scripts/models/item"
import { AppDispatch } from "../scripts/utils"
import { dismissItem, showOffsetItem } from "../scripts/models/page"
import Article from "../components/article"
import {
    openTextMenu,
    closeContextMenu,
    openImageMenu,
} from "../scripts/models/app"
import {
    RSSSource,
    SourceTextDirection,
    SourceOpenTarget,
    updateSource,
} from "../scripts/models/source"

type ArticleContainerProps = {
    itemId: number
}

const getItem = (state: RootState, props: ArticleContainerProps) =>
    state.items[props.itemId]
const getSource = (state: RootState, props: ArticleContainerProps) =>
    state.sources[state.items[props.itemId].source]
const getLocale = (state: RootState) => state.app.locale
const getMenuOpen = (state: RootState) => state.app.menu
const getSettingsOpen = (state: RootState) => state.app.settings.display
const getLogMenuOpen = (state: RootState) => state.app.logMenu.display
const getContextMenuType = (state: RootState) => state.app.contextMenu.type

// Selectors for ContentViewPool - article position in feed
const getFeedId = (state: RootState) => state.page.feedId
const getFeeds = (state: RootState) => state.feeds
const getItemId = (_state: RootState, props: ArticleContainerProps) => props.itemId
const getItems = (state: RootState) => state.items
const getSources = (state: RootState) => state.sources

// Import ContextMenuType for comparison
import { ContextMenuType } from "../scripts/models/app"

const makeMapStateToProps = () => {
    return createSelector(
        [getItem, getSource, getLocale, getMenuOpen, getSettingsOpen, getLogMenuOpen, getContextMenuType, getFeedId, getFeeds, getItemId, getItems, getSources],
        (item, source, locale, menuOpen, settingsOpen, logMenuOpen, contextMenuType, feedId, feeds, itemId, items, sources) => {
            // Calculate article position in feed for ContentViewPool
            let articleIndex = -1
            let listLength = 0
            let articleIds: number[] = []
            
            if (feedId && feeds[feedId]) {
                const iids = feeds[feedId].iids
                listLength = iids.length
                articleIndex = iids.indexOf(itemId)
                articleIds = iids  // Pass the full list for prefetch
                
                // DEBUG: Log article position calculation
                console.log(`[ArticleContainer] feedId=${feedId}, itemId=${itemId}, articleIndex=${articleIndex}, listLength=${listLength}`)
                if (articleIndex === -1 && listLength > 0) {
                    console.warn(`[ArticleContainer] Item ${itemId} NOT FOUND in iids! First 5 iids:`, iids.slice(0, 5))
                }
            } else {
                console.warn(`[ArticleContainer] No feed found for feedId=${feedId}`)
            }
            
            return {
                item: item,
                source: source,
                locale: locale,
                menuOpen: menuOpen,
                // Combined flag: any major overlay is active
                // Note: menuOpen (hamburger) excluded - it only changes layout, doesn't overlap ContentView
                overlayActive: /* menuOpen || */ settingsOpen || logMenuOpen || contextMenuType !== ContextMenuType.Hidden,
                // ContentViewPool support: article position in feed
                articleIndex: articleIndex,
                listLength: listLength,
                feedId: feedId,
                // For prefetch: access to article list and store data
                articleIds: articleIds,
                items: items,
                sources: sources,
            }
        }
    )
}

const mapDispatchToProps = (dispatch: AppDispatch) => {
    return {
        shortcuts: (item: RSSItem, e: KeyboardEvent) =>
            dispatch(itemShortcuts(item, e)),
        dismiss: () => dispatch(dismissItem()),
        offsetItem: (offset: number) => dispatch(showOffsetItem(offset)),
        toggleHasRead: (item: RSSItem) =>
            dispatch(item.hasRead ? markUnread(item) : markRead(item)),
        toggleStarred: (item: RSSItem) => dispatch(toggleStarred(item)),
        toggleHidden: (item: RSSItem) => {
            if (!item.hidden) dispatch(dismissItem())
            if (!item.hasRead && !item.hidden) dispatch(markRead(item))
            dispatch(toggleHidden(item))
        },
        textMenu: (position: [number, number], text: string, url: string) =>
            dispatch(openTextMenu(position, text, url)),
        imageMenu: (position: [number, number]) =>
            dispatch(openImageMenu(position)),
        dismissContextMenu: () => dispatch(closeContextMenu()),
        updateSourceTextDirection: (
            source: RSSSource,
            direction: SourceTextDirection
        ) => {
            dispatch(
                updateSource({ ...source, textDir: direction } as RSSSource)
            )
        },
        updateSourceOpenTarget: (
            source: RSSSource,
            openTarget: SourceOpenTarget
        ) => {
            dispatch(
                updateSource({ ...source, openTarget: openTarget } as RSSSource)
            )
        },
        updateDefaultZoom: (
            source: RSSSource,
            defaultZoom: Number
        ) => {
            dispatch(
                updateSource({ ...source, defaultZoom: defaultZoom } as RSSSource)
            )
        },
        updateMobileMode: (
            source: RSSSource,
            mobileMode: boolean
        ) => {
            dispatch(
                updateSource({ ...source, mobileMode: mobileMode } as RSSSource)
            )
        },
        updatePersistCookies: (
            source: RSSSource,
            persistCookies: boolean
        ) => {
            dispatch(
                updateSource({ ...source, persistCookies: persistCookies } as RSSSource)
            )
        },
    }
}

const ArticleContainer = connect(
    makeMapStateToProps,
    mapDispatchToProps
)(Article)
export default ArticleContainer
