import {
    ALL,
    SOURCE,
    loadMore,
    FeedFilter,
    FilterType,
    initFeeds,
    FeedActionTypes,
    INIT_FEED,
} from "./feed"
import { getWindowBreakpoint, AppThunk, ActionStatus } from "../utils"
import { RSSItem, markRead } from "./item"
import { SourceActionTypes, DELETE_SOURCE } from "./source"
import { toggleMenu, hideMenu } from "./app"
import { ViewType, ViewConfigs } from "../../schema-types"

export const SELECT_PAGE = "SELECT_PAGE"
export const SWITCH_VIEW = "SWITCH_VIEW"
export const SET_VIEW_CONFIGS = "SET_VIEW_CONFIGS"
export const SHOW_ITEM = "SHOW_ITEM"
export const SHOW_OFFSET_ITEM = "SHOW_OFFSET_ITEM"
export const DISMISS_ITEM = "DISMISS_ITEM"
export const APPLY_FILTER = "APPLY_FILTER"
export const TOGGLE_SEARCH = "TOGGLE_SEARCH"

export enum PageType {
    AllArticles,
    Sources,
    Page,
}

interface SelectPageAction {
    type: typeof SELECT_PAGE
    pageType: PageType
    init: boolean
    keepMenu: boolean
    filter: FeedFilter
    sids?: number[]
    menuKey?: string
    title?: string
}

interface SwitchViewAction {
    type: typeof SWITCH_VIEW
    viewType: ViewType
}

interface SetViewConfigsAction {
    type: typeof SET_VIEW_CONFIGS
    configs: ViewConfigs
}

interface ShowItemAction {
    type: typeof SHOW_ITEM
    feedId: string
    item: RSSItem
}

interface ApplyFilterAction {
    type: typeof APPLY_FILTER
    filter: FeedFilter
}

interface DismissItemAction {
    type: typeof DISMISS_ITEM
}
interface ToggleSearchAction {
    type: typeof TOGGLE_SEARCH
}

export type PageActionTypes =
    | SelectPageAction
    | SwitchViewAction
    | ShowItemAction
    | DismissItemAction
    | ApplyFilterAction
    | ToggleSearchAction
    | SetViewConfigsAction

export function selectAllArticles(init = false): AppThunk {
    return (dispatch, getState) => {
        dispatch({
            type: SELECT_PAGE,
            keepMenu: getWindowBreakpoint(),
            filter: getState().page.filter,
            pageType: PageType.AllArticles,
            init: init,
        } as PageActionTypes)
    }
}

export function selectSources(
    sids: number[],
    menuKey: string,
    title: string
): AppThunk {
    return (dispatch, getState) => {
        if (getState().app.menuKey !== menuKey) {
            dispatch({
                type: SELECT_PAGE,
                pageType: PageType.Sources,
                keepMenu: getWindowBreakpoint(),
                filter: getState().page.filter,
                sids: sids,
                menuKey: menuKey,
                title: title,
                init: true,
            } as PageActionTypes)
        }
    }
}

export function switchView(viewType: ViewType): PageActionTypes {
    return {
        type: SWITCH_VIEW,
        viewType: viewType,
    }
}

export function setViewConfigs(configs: ViewConfigs): AppThunk {
    return (dispatch, getState) => {
        window.settings.setViewConfigs(getState().page.viewType, configs)
        dispatch({
            type: "SET_VIEW_CONFIGS",
            configs: configs,
        })
    }
}

export function showItem(feedId: string, item: RSSItem): AppThunk {
    return (dispatch, getState) => {
        const state = getState()
        if (
            state.items.hasOwnProperty(item._id) &&
            state.sources.hasOwnProperty(item.source)
        ) {
            dispatch({
                type: SHOW_ITEM,
                feedId: feedId,
                item: item,
            })
            dispatch(hideMenu())
        }
    }
}
export function showItemFromId(iid: number): AppThunk {
    return (dispatch, getState) => {
        const state = getState()
        const item = state.items[iid]
        if (!item.hasRead) dispatch(markRead(item))
        if (item) dispatch(showItem(null, item))
    }
}

/**
 * Navigate to a P2P article by sourceId and articleId.
 * This will:
 * 1. Select the source (navigate to P2P feed)
 * 2. Initialize the feed (load articles)
 * 3. Show the article
 * 4. Scroll the feed list to the article
 */
export function navigateToP2PArticle(sourceId: number, articleId: number, feedName: string): AppThunk {
    return async (dispatch, getState) => {
        console.log(`[navigateToP2PArticle] START - Navigating to source=${sourceId}, article=${articleId}`)
        
        // Step 1: Navigate to the source feed
        const menuKey = `source-${sourceId}`
        dispatch({
            type: SELECT_PAGE,
            pageType: PageType.Sources,
            keepMenu: getWindowBreakpoint(),
            filter: getState().page.filter,
            sids: [sourceId],
            menuKey: menuKey,
            title: feedName,
            init: true,
        } as PageActionTypes)
        
        // Step 2: Initialize feeds (this loads the articles into the feed view)
        dispatch(initFeeds())
        console.log(`[navigateToP2PArticle] Feed initialized, waiting 500ms for article to load...`)
        
        // Step 3: Wait for feed to load, then show the article
        setTimeout(() => {
            const state = getState()
            const item = state.items[articleId]
            console.log(`[navigateToP2PArticle] After 500ms - item in state:`, item ? "YES" : "NO")
            if (item) {
                console.log(`[navigateToP2PArticle] Found article in state, showing it`)
                dispatch(showItem(null, item))
                if (!item.hasRead) dispatch(markRead(item))
                
                // Step 4: Wait for the article card to appear in DOM, then scroll to it
                const scrollToCard = () => {
                    const card = document.querySelector(
                        `#refocus div[data-iid="${articleId}"]`
                    ) as HTMLElement
                    console.log(`[navigateToP2PArticle] scrollToCard called - card found:`, card ? "YES" : "NO")
                    if (card) {
                        // Delay scroll slightly to let layout stabilize (slider, animations, etc.)
                        console.log(`[navigateToP2PArticle] Card found! Waiting 500ms for layout to stabilize...`)
                        setTimeout(() => {
                            // Re-query the card to get fresh reference
                            const freshCard = document.querySelector(
                                `#refocus div[data-iid="${articleId}"]`
                            ) as HTMLElement
                            
                            if (!freshCard) {
                                console.log(`[navigateToP2PArticle] ERROR: Card disappeared!`)
                                return
                            }
                            
                            // Find the scrollable container (#refocus)
                            const scrollContainer = document.getElementById('refocus')
                            if (!scrollContainer) {
                                console.log(`[navigateToP2PArticle] ERROR: Scroll container #refocus not found!`)
                                return
                            }
                            
                            console.log(`[navigateToP2PArticle] NOW scrolling to article card!`)
                            console.log(`[navigateToP2PArticle] Card offsetTop:`, freshCard.offsetTop)
                            console.log(`[navigateToP2PArticle] Container scrollHeight:`, scrollContainer.scrollHeight)
                            console.log(`[navigateToP2PArticle] Container clientHeight:`, scrollContainer.clientHeight)
                            
                            // Calculate scroll position to center the card in the container
                            const cardTop = freshCard.offsetTop
                            const containerHeight = scrollContainer.clientHeight
                            const cardHeight = freshCard.offsetHeight
                            const scrollTo = cardTop - (containerHeight / 2) + (cardHeight / 2)
                            
                            console.log(`[navigateToP2PArticle] Scrolling container to:`, scrollTo)
                            scrollContainer.scrollTo({
                                top: Math.max(0, scrollTo),
                                behavior: 'smooth'
                            })
                            
                            console.log(`[navigateToP2PArticle] Scroll complete!`)
                        }, 500) // 500ms delay for layout to stabilize
                        return true
                    }
                    return false
                }
                
                // Try immediately first
                console.log(`[navigateToP2PArticle] Trying to find card immediately...`)
                if (scrollToCard()) {
                    console.log(`[navigateToP2PArticle] Card found immediately, scroll scheduled`)
                    return
                }
                
                // Use MutationObserver to wait for the card to appear
                const feedContainer = document.querySelector('#refocus')
                console.log(`[navigateToP2PArticle] Feed container #refocus found:`, feedContainer ? "YES" : "NO")
                if (feedContainer) {
                    console.log(`[navigateToP2PArticle] Setting up MutationObserver to wait for card...`)
                    const observer = new MutationObserver((mutations, obs) => {
                        console.log(`[navigateToP2PArticle] MutationObserver fired - checking for card...`)
                        if (scrollToCard()) {
                            console.log(`[navigateToP2PArticle] Card appeared via observer, disconnecting`)
                            obs.disconnect()
                        }
                    })
                    observer.observe(feedContainer, { 
                        childList: true, 
                        subtree: true 
                    })
                    
                    // Fallback timeout in case card never appears
                    setTimeout(() => {
                        observer.disconnect()
                        console.log(`[navigateToP2PArticle] Observer timeout, trying one last scroll`)
                        scrollToCard()
                    }, 5000)
                } else {
                    console.log(`[navigateToP2PArticle] Feed container not found`)
                }
            } else {
                console.log(`[navigateToP2PArticle] Article ${articleId} not in state yet`)
            }
        }, 500)
    }
}

export const dismissItem = (): PageActionTypes => ({ type: DISMISS_ITEM })

export const toggleSearch = (): AppThunk => {
    return (dispatch, getState) => {
        let state = getState()
        dispatch({ type: TOGGLE_SEARCH })
        if (!getWindowBreakpoint() && state.app.menu) {
            dispatch(toggleMenu())
        }
        if (state.page.searchOn) {
            dispatch(
                applyFilter({
                    ...state.page.filter,
                    search: "",
                })
            )
        }
    }
}

// === Navigation Debounce ===
// Simple "deaf period" after each navigation to prevent rapid-fire skipping
// ANY navigation within the debounce window is blocked, regardless of target
let lastNavigationTime = 0
const NAVIGATION_DEBOUNCE_MS = 200  // Block ALL navigations for 200ms after each navigation

export function showOffsetItem(offset: number): AppThunk {
    return (dispatch, getState) => {
        // === Simple Debounce: Block ANY navigation within the deaf period ===
        const now = Date.now()
        if (now - lastNavigationTime < NAVIGATION_DEBOUNCE_MS) {
            console.log(`[showOffsetItem] BLOCKED - within ${NAVIGATION_DEBOUNCE_MS}ms deaf period (${now - lastNavigationTime}ms since last)`)
            return
        }
        
        let state = getState()
        if (!state.page.itemFromFeed) return
        let [itemId, feedId] = [state.page.itemId, state.page.feedId]
        let feed = state.feeds[feedId]
        let iids = feed.iids
        let itemIndex = iids.indexOf(itemId)
        
        // Calculate target index
        let newIndex = itemIndex + offset
        if (itemIndex < 0) {
            let item = state.items[itemId]
            let prevs = feed.iids
                .map(
                    (id, index) => [state.items[id], index] as [RSSItem, number]
                )
                .filter(([i, _]) => i.date > item.date)
            if (prevs.length > 0) {
                let prev = prevs[0]
                for (let j = 1; j < prevs.length; j += 1) {
                    if (prevs[j][0].date < prev[0].date) prev = prevs[j]
                }
                newIndex = prev[1] + offset + (offset < 0 ? 1 : 0)
            } else {
                newIndex = offset - 1
            }
        }
        
        console.log(`[showOffsetItem] Navigation: index ${itemIndex} → ${newIndex} (offset ${offset})`)
        
        // Mark navigation time BEFORE dispatch to block any rapid follow-ups
        lastNavigationTime = now
        
        if (newIndex >= 0) {
            if (newIndex < iids.length) {
                let item = state.items[iids[newIndex]]
                dispatch(markRead(item))
                dispatch(showItem(feedId, item))
                return
            } else if (!feed.allLoaded) {
                dispatch(loadMore(feed))
                    .then(() => {
                        dispatch(showOffsetItem(offset))
                    })
                    .catch(() => dispatch(dismissItem()))
                return
            }
        }
        dispatch(dismissItem())
    }
}

const applyFilterDone = (filter: FeedFilter): PageActionTypes => ({
    type: APPLY_FILTER,
    filter: filter,
})

function applyFilter(filter: FeedFilter): AppThunk {
    return (dispatch, getState) => {
        const oldFilterType = getState().page.filter.type
        if (filter.type !== oldFilterType)
            window.settings.setFilterType(filter.type)
        dispatch(applyFilterDone(filter))
        dispatch(initFeeds(true))
    }
}

export function switchFilter(filter: FilterType): AppThunk {
    return (dispatch, getState) => {
        let oldFilter = getState().page.filter
        let oldType = oldFilter.type
        let newType = filter | (oldType & FilterType.Toggles)
        if (oldType != newType) {
            dispatch(
                applyFilter({
                    ...oldFilter,
                    type: newType,
                })
            )
        }
    }
}

export function toggleFilter(filter: FilterType): AppThunk {
    return (dispatch, getState) => {
        let nextFilter = { ...getState().page.filter }
        nextFilter.type ^= filter
        dispatch(applyFilter(nextFilter))
    }
}

export function performSearch(query: string): AppThunk {
    return (dispatch, getState) => {
        let state = getState()
        if (state.page.searchOn) {
            dispatch(
                applyFilter({
                    ...state.page.filter,
                    search: query,
                })
            )
        }
    }
}

export class PageState {
    viewType = window.settings.getDefaultView()
    viewConfigs = window.settings.getViewConfigs(
        window.settings.getDefaultView()
    )
    filter = new FeedFilter()
    feedId = ALL
    itemId = null as number
    itemFromFeed = true
    searchOn = false
}

export function pageReducer(
    state = new PageState(),
    action: PageActionTypes | SourceActionTypes | FeedActionTypes
): PageState {
    switch (action.type) {
        case SELECT_PAGE:
            switch (action.pageType) {
                case PageType.AllArticles:
                    return {
                        ...state,
                        feedId: ALL,
                        itemId: null,
                    }
                case PageType.Sources:
                    return {
                        ...state,
                        feedId: SOURCE,
                        itemId: null,
                    }
                default:
                    return state
            }
        case SWITCH_VIEW:
            return {
                ...state,
                viewType: action.viewType,
                viewConfigs: window.settings.getViewConfigs(action.viewType),
                itemId: null,
            }
        case SET_VIEW_CONFIGS:
            return {
                ...state,
                viewConfigs: action.configs,
            }
        case APPLY_FILTER:
            return {
                ...state,
                filter: action.filter,
            }
        case SHOW_ITEM:
            return {
                ...state,
                itemId: action.item._id,
                itemFromFeed: Boolean(action.feedId),
            }
        case INIT_FEED:
            switch (action.status) {
                case ActionStatus.Success:
                    return {
                        ...state,
                        itemId:
                            action.feed._id === state.feedId &&
                            action.items.filter(i => i._id === state.itemId)
                                .length === 0
                                ? null
                                : state.itemId,
                    }
                default:
                    return state
            }
        case DELETE_SOURCE:
        case DISMISS_ITEM:
            return {
                ...state,
                itemId: null,
            }
        case TOGGLE_SEARCH:
            return {
                ...state,
                searchOn: !state.searchOn,
            }
        default:
            return state
    }
}
