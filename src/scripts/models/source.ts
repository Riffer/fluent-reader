import intl from "react-intl-universal"
import * as db from "../db"
import { SourceRow, ItemRow } from "../../bridges/db"
import {
    fetchFavicon,
    ActionStatus,
    AppThunk,
    parseRSS,
    MyParserItem,
} from "../utils"
import {
    RSSItem,
    insertItems,
    ItemActionTypes,
    FETCH_ITEMS,
    MARK_READ,
    MARK_UNREAD,
    MARK_ALL_READ,
} from "./item"
import { saveSettings } from "./app"
import { SourceRule } from "./rule"
import { fixBrokenGroups, setGroupsFromP2P } from "./group"
import { SourceGroup } from "../../schema-types"

export enum SourceOpenTarget {
    Local,
    Webpage,
    External,
    FullContent,
}

export const enum SourceTextDirection {
    LTR,
    RTL,
    Vertical,
}

export class RSSSource {
    sid: number
    url: string
    iconurl?: string
    name: string
    openTarget: SourceOpenTarget
    defaultZoom: number
    mobileMode: boolean
    persistCookies: boolean
    unreadCount: number
    lastFetched: Date
    serviceRef?: string
    fetchFrequency: number // in minutes
    rules?: SourceRule[]
    textDir: SourceTextDirection
    hidden: boolean
    translateTo?: string // Target language code for translation (e.g., 'de', 'en', 'fr')
    sortAscending: boolean // Sort oldest first when unread filter is active

    constructor(url: string, name: string = null, openTarget: SourceOpenTarget = null, defaultZoom = 0, mobileMode = false, persistCookies = false) {
        this.url = url
        this.name = name
        this.openTarget = openTarget ?? SourceOpenTarget.Local
        this.defaultZoom = defaultZoom
        this.mobileMode = mobileMode
        this.persistCookies = persistCookies
        this.lastFetched = new Date()
        this.fetchFrequency = 0
        this.textDir = SourceTextDirection.LTR
        this.hidden = false
        this.translateTo = undefined
        this.sortAscending = false
    }

    static async fetchMetaData(source: RSSSource) {
        let feed = await parseRSS(source.url)
        if (!source.name) {
            if (feed.title) source.name = feed.title.trim()
            source.name = source.name || intl.get("sources.untitled")
        }
        return feed
    }

    private static async checkItem(
        source: RSSSource,
        item: MyParserItem
    ): Promise<RSSItem> {
        let i = new RSSItem(item, source)
        
        // Use SQLite for duplicate check via window.db bridge
        const exists = await window.db.items.exists(
            i.source,
            i.title,
            i.date.toISOString()
        )
        
        if (!exists) {
            RSSItem.parseContent(i, item)
            if (source.rules) SourceRule.applyAll(source.rules, i)
            
            // NOTE: Translation is now done on-demand when displaying articles
            // This reduces API calls since not all articles are read
            // See card.tsx and article.tsx for on-demand translation
            
            return i
        } else {
            return null
        }
    }

    static async checkItems(
        source: RSSSource,
        items: MyParserItem[]
    ): Promise<RSSItem[]> {
        // Always process in parallel now since translation is on-demand
        const promises = items.map(item => this.checkItem(source, item))
        const results = await Promise.all(promises)
        return results.filter(v => v != null) as RSSItem[]
    }

    static async fetchItems(source: RSSSource) {
        try {
            let feed = await parseRSS(source.url)
            return await this.checkItems(source, feed.items)
        } catch (e) {
            // Extend error message with source info
            const errorMsg = e instanceof Error ? e.message : String(e)
            console.error(`[fetchItems] Error fetching "${source.name}" (${source.url}): ${errorMsg}`)
            throw e
        }
    }
}

export type SourceState = {
    [sid: number]: RSSSource
}

export const INIT_SOURCES = "INIT_SOURCES"
export const ADD_SOURCE = "ADD_SOURCE"
export const ADD_P2P_SOURCES = "ADD_P2P_SOURCES"
export const UPDATE_SOURCE = "UPDATE_SOURCE"
export const UPDATE_UNREAD_COUNTS = "UPDATE_UNREAD_COUNTS"
export const DELETE_SOURCE = "DELETE_SOURCE"
export const HIDE_SOURCE = "HIDE_SOURCE"
export const UNHIDE_SOURCE = "UNHIDE_SOURCE"

interface InitSourcesAction {
    type: typeof INIT_SOURCES
    status: ActionStatus
    sources?: SourceState
    err?
}

interface AddSourceAction {
    type: typeof ADD_SOURCE
    status: ActionStatus
    batch: boolean
    source?: RSSSource
    err?
}

interface UpdateSourceAction {
    type: typeof UPDATE_SOURCE
    source: RSSSource
}

interface UpdateUnreadCountsAction {
    type: typeof UPDATE_UNREAD_COUNTS
    sources: SourceState
}

interface DeleteSourceAction {
    type: typeof DELETE_SOURCE
    source: RSSSource
}

interface ToggleSourceHiddenAction {
    type: typeof HIDE_SOURCE | typeof UNHIDE_SOURCE
    status: ActionStatus
    source: RSSSource
}

interface AddP2PSourcesAction {
    type: typeof ADD_P2P_SOURCES
    sources: SourceState
}

export type SourceActionTypes =
    | InitSourcesAction
    | AddSourceAction
    | AddP2PSourcesAction
    | UpdateSourceAction
    | UpdateUnreadCountsAction
    | DeleteSourceAction
    | ToggleSourceHiddenAction

export function initSourcesRequest(): SourceActionTypes {
    return {
        type: INIT_SOURCES,
        status: ActionStatus.Request,
    }
}

export function initSourcesSuccess(sources: SourceState): SourceActionTypes {
    return {
        type: INIT_SOURCES,
        status: ActionStatus.Success,
        sources: sources,
    }
}

export function initSourcesFailure(err): SourceActionTypes {
    return {
        type: INIT_SOURCES,
        status: ActionStatus.Failure,
        err: err,
    }
}

async function unreadCount(sources: SourceState): Promise<SourceState> {
    // Use SQLite for unread counts via window.db bridge
    const counts = await window.db.getUnreadCounts()
    for (const [sourceId, count] of Object.entries(counts)) {
        const sid = parseInt(sourceId)
        if (sources[sid]) {
            sources[sid].unreadCount = count
        }
    }
    return sources
}

export function updateUnreadCounts(): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const sources: SourceState = {}
        for (let source of Object.values(getState().sources)) {
            sources[source.sid] = {
                ...source,
                unreadCount: 0,
            }
        }
        dispatch({
            type: UPDATE_UNREAD_COUNTS,
            sources: await unreadCount(sources),
        })
    }
}

// Helper function to convert SQLite SourceRow to RSSSource
function rowToSource(row: SourceRow): RSSSource {
    const source = new RSSSource(row.url, row.name)
    source.sid = row.sid
    source.iconurl = row.iconurl ?? undefined
    source.openTarget = row.openTarget
    source.defaultZoom = row.defaultZoom
    source.lastFetched = new Date(row.lastFetched)
    source.serviceRef = row.serviceRef ?? undefined
    source.fetchFrequency = row.fetchFrequency
    source.rules = row.rules ? JSON.parse(row.rules) : undefined
    source.textDir = row.textDir
    source.hidden = row.hidden === 1
    source.mobileMode = row.mobileMode === 1
    source.persistCookies = row.persistCookies === 1
    source.translateTo = row.translateTo ?? undefined
    source.sortAscending = row.sortAscending === 1
    source.unreadCount = 0
    return source
}

export function initSources(): AppThunk<Promise<void>> {
    return async dispatch => {
        dispatch(initSourcesRequest())
        // Initialize Lovefield for migration support (will be removed later)
        await db.init()
        
        // Use SQLite for source data via window.db bridge
        const sourceRows = await window.db.sources.getAll()
        const state: SourceState = {}
        for (let row of sourceRows) {
            state[row.sid] = rowToSource(row)
        }
        await unreadCount(state)
        dispatch(fixBrokenGroups(state))
        dispatch(initSourcesSuccess(state))
    }
}

export function addSourceRequest(batch: boolean): SourceActionTypes {
    return {
        type: ADD_SOURCE,
        batch: batch,
        status: ActionStatus.Request,
    }
}

export function addSourceSuccess(
    source: RSSSource,
    batch: boolean
): SourceActionTypes {
    return {
        type: ADD_SOURCE,
        batch: batch,
        status: ActionStatus.Success,
        source: source,
    }
}

export function addSourceFailure(err, batch: boolean): SourceActionTypes {
    return {
        type: ADD_SOURCE,
        batch: batch,
        status: ActionStatus.Failure,
        err: err,
    }
}

// Helper function to convert RSSSource to SQLite SourceRow
function sourceToRow(source: RSSSource): Omit<SourceRow, "sid"> & { sid?: number } {
    return {
        sid: source.sid,
        url: source.url,
        iconurl: source.iconurl ?? null,
        name: source.name,
        openTarget: source.openTarget,
        defaultZoom: source.defaultZoom,
        lastFetched: source.lastFetched.toISOString(),
        serviceRef: source.serviceRef ?? null,
        fetchFrequency: source.fetchFrequency,
        rules: source.rules ? JSON.stringify(source.rules) : null,
        textDir: source.textDir,
        hidden: source.hidden ? 1 : 0,
        mobileMode: source.mobileMode ? 1 : 0,
        persistCookies: source.persistCookies ? 1 : 0,
        translateTo: source.translateTo ?? null,
        sortAscending: source.sortAscending ? 1 : 0
    }
}

let insertPromises = Promise.resolve()
export function insertSource(source: RSSSource): AppThunk<Promise<RSSSource>> {
    return (_, getState) => {
        return new Promise((resolve, reject) => {
            insertPromises = insertPromises.then(async () => {
                let sids = Object.values(getState().sources).map(s => s.sid)
                source.sid = Math.max(...sids, -1) + 1
                try {
                    // Use SQLite for insert via window.db bridge
                    const row = sourceToRow(source)
                    await window.db.sources.insert(row)
                    resolve(source)
                } catch (err) {
                    // SQLite UNIQUE constraint error
                    if (err.message?.includes("UNIQUE constraint failed")) {
                        reject(intl.get("sources.exist"))
                    } else {
                        reject(err)
                    }
                }
            })
        })
    }
}

export function addSource(
    url: string,
    name: string = null,
    batch = false,
    openTarget = null,
    defaultZoom = 0,
    mobileMode = false,
    persistCookies = false
): AppThunk<Promise<number>> {
    return async (dispatch, getState) => {
        const app = getState().app
        if (app.sourceInit) {
            dispatch(addSourceRequest(batch))
            const source = new RSSSource(url, name, openTarget, defaultZoom, mobileMode, persistCookies)
            try {
                const feed = await RSSSource.fetchMetaData(source)
                const inserted = await dispatch(insertSource(source))
                inserted.unreadCount = feed.items.length
                dispatch(addSourceSuccess(inserted, batch))
                window.settings.saveGroups(getState().groups)
                dispatch(updateFavicon([inserted.sid]))
                const items = await RSSSource.checkItems(inserted, feed.items)
                await insertItems(items)
                return inserted.sid
            } catch (e) {
                dispatch(addSourceFailure(e, batch))
                if (!batch) {
                    window.utils.showErrorBox(
                        intl.get("sources.errorAdd"),
                        String(e),
                        intl.get("context.copy")
                    )
                }
                throw e
            }
        }
        throw new Error("Sources not initialized.")
    }
}

export function updateSourceDone(source: RSSSource): SourceActionTypes {
    return {
        type: UPDATE_SOURCE,
        source: source,
    }
}

export function updateSource(source: RSSSource): AppThunk<Promise<void>> {
    return async dispatch => {
        let sourceCopy = { ...source }
        delete sourceCopy.unreadCount
        // Use SQLite for update via window.db bridge
        const row = sourceToRow(sourceCopy)
        
        // DEBUG: Log what we're saving
        console.log(`[Redux updateSource] Saving source: sid=${source.sid}, name=${source.name}, defaultZoom=${source.defaultZoom}`)
        
        await window.db.sources.update(source.sid, row)
        dispatch(updateSourceDone(source))
    }
}

/**
 * Update zoom level for a specific source by sid.
 * This function fetches the current source from Redux state to avoid stale props issues.
 * @param sid - The source ID to update
 * @param defaultZoom - The new zoom level
 */
export function updateSourceZoomBySid(sid: number, defaultZoom: number): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const state = getState()
        const currentSource = state.sources[sid]
        
        if (!currentSource) {
            console.error(`[updateSourceZoomBySid] Source not found for sid=${sid}`)
            return
        }
        
        console.log(`[updateSourceZoomBySid] Updating zoom: sid=${sid}, name=${currentSource.name}, oldZoom=${currentSource.defaultZoom}, newZoom=${defaultZoom}`)
        
        // Only update if zoom actually changed
        if (currentSource.defaultZoom === defaultZoom) {
            console.log(`[updateSourceZoomBySid] Zoom unchanged, skipping update`)
            return
        }
        
        const updatedSource = { ...currentSource, defaultZoom }
        let sourceCopy = { ...updatedSource }
        delete sourceCopy.unreadCount
        
        const row = sourceToRow(sourceCopy)
        await window.db.sources.update(sid, row)
        dispatch(updateSourceDone(updatedSource))
    }
}

export function deleteSourceDone(source: RSSSource): SourceActionTypes {
    return {
        type: DELETE_SOURCE,
        source: source,
    }
}

export function deleteSource(
    source: RSSSource,
    batch = false
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        if (!batch) dispatch(saveSettings())
        try {
            // Use SQLite for delete via window.db bridge
            // Items are deleted automatically due to CASCADE foreign key
            await window.db.items.deleteBySource(source.sid)
            await window.db.sources.delete(source.sid)
            dispatch(deleteSourceDone(source))
            window.settings.saveGroups(getState().groups)
        } catch (err) {
            console.error(err)
        } finally {
            if (!batch) dispatch(saveSettings())
        }
    }
}

export function deleteSources(sources: RSSSource[]): AppThunk<Promise<void>> {
    return async dispatch => {
        dispatch(saveSettings())
        for (let source of sources) {
            await dispatch(deleteSource(source, true))
        }
        dispatch(saveSettings())
    }
}

export function toggleSourceHidden(source: RSSSource): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const sourceCopy: RSSSource = { ...getState().sources[source.sid] }
        sourceCopy.hidden = !sourceCopy.hidden
        dispatch({
            type: sourceCopy.hidden ? HIDE_SOURCE : UNHIDE_SOURCE,
            status: ActionStatus.Success,
            source: sourceCopy,
        })
        await dispatch(updateSource(sourceCopy))
    }
}

export function updateFavicon(
    sids?: number[],
    force = false
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const initSources = getState().sources
        if (!sids) {
            sids = Object.values(initSources)
                .filter(s => s.iconurl === undefined)
                .map(s => s.sid)
        } else {
            sids = sids.filter(sid => sid in initSources)
        }
        const promises = sids.map(async sid => {
            const url = initSources[sid].url
            let favicon = (await fetchFavicon(url)) || ""
            const source = getState().sources[sid]
            if (
                source &&
                source.url === url &&
                (force || source.iconurl === undefined)
            ) {
                source.iconurl = favicon
                await dispatch(updateSource(source))
            }
        })
        await Promise.all(promises)
    }
}

/**
 * Action creator for adding P2P sources to the state
 */
export function addP2PSourcesDone(sources: SourceState): SourceActionTypes {
    return {
        type: ADD_P2P_SOURCES,
        sources: sources,
    }
}

/**
 * Import from P2PFeedsChangedData interface in p2p-lan bridge
 */
interface P2PSourceData {
    sid: number
    url: string
    iconurl: string | null
    name: string
    openTarget: number
    defaultZoom: number
    lastFetched: string
    serviceRef: string | null
    fetchFrequency: number
    rules: string | null
    textDir: number
    hidden: number
    mobileMode: number
    persistCookies: number
}

interface P2PArticleData {
    _id: number
    source: number
    title: string
    link: string
    date: string
    fetchedDate: string
    thumb: string | null
    content: string
    snippet: string
    creator: string
    hasRead: boolean
    starred: boolean
    hidden: boolean
    notify: boolean
    serviceRef: string | null
}

/**
 * Handle P2P feeds changed event - adds new sources and items to Redux state.
 * Called when the Main Process notifies that P2P articles have been stored in SQLite.
 */
export function handleP2PFeedsChanged(
    newFeeds: P2PSourceData[],
    newArticles: P2PArticleData[],
    groupsUpdated: boolean,
    groups: any[] | null
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        console.log(`[P2P] Handling feeds changed: ${newFeeds.length} feeds, ${newArticles.length} articles`)
        
        // Convert and add new sources to state
        if (newFeeds.length > 0) {
            const sourcesToAdd: SourceState = {}
            for (const feedData of newFeeds) {
                const source = new RSSSource(feedData.url, feedData.name)
                source.sid = feedData.sid
                source.iconurl = feedData.iconurl ?? undefined
                source.openTarget = feedData.openTarget
                source.defaultZoom = feedData.defaultZoom
                source.lastFetched = new Date(feedData.lastFetched)
                source.serviceRef = feedData.serviceRef ?? undefined
                source.fetchFrequency = feedData.fetchFrequency
                source.rules = feedData.rules ? JSON.parse(feedData.rules) : undefined
                source.textDir = feedData.textDir
                source.hidden = feedData.hidden === 1
                source.mobileMode = feedData.mobileMode === 1
                source.persistCookies = feedData.persistCookies === 1
                source.unreadCount = 0
                
                sourcesToAdd[source.sid] = source
            }
            dispatch(addP2PSourcesDone(sourcesToAdd))
            console.log(`[P2P] Added ${Object.keys(sourcesToAdd).length} new sources to Redux state`)
        }
        
        // Convert and add new articles to items state
        if (newArticles.length > 0) {
            const itemsToAdd: RSSItem[] = newArticles.map(articleData => ({
                _id: articleData._id,
                source: articleData.source,
                title: articleData.title,
                link: articleData.link,
                date: new Date(articleData.date),
                fetchedDate: new Date(articleData.fetchedDate),
                thumb: articleData.thumb ?? undefined,
                content: articleData.content,
                snippet: articleData.snippet,
                creator: articleData.creator ?? undefined,
                hasRead: articleData.hasRead,
                starred: articleData.starred,
                hidden: articleData.hidden,
                notify: articleData.notify,
                serviceRef: articleData.serviceRef ?? undefined
            } as RSSItem))
            
            // Create itemState map
            const itemState: { [_id: number]: RSSItem } = {}
            for (const item of itemsToAdd) {
                itemState[item._id] = item
            }
            
            // Dispatch FETCH_ITEMS with success to add items to state
            dispatch({
                type: FETCH_ITEMS,
                status: ActionStatus.Success,
                items: itemsToAdd,
                itemState: itemState,
            })
            console.log(`[P2P] Added ${itemsToAdd.length} new articles to Redux state`)
        }
        
        // Update groups from P2P sync if provided
        if (groupsUpdated && groups && groups.length > 0) {
            // Convert plain objects to SourceGroup instances
            // Important: Preserve isMultiple from original data, don't rely on constructor
            const sourceGroups: SourceGroup[] = groups.map(g => {
                const sg = new SourceGroup(g.sids, g.name)
                sg.isMultiple = g.isMultiple  // Preserve original isMultiple flag
                sg.expanded = g.expanded ?? true
                if (g.name) sg.name = g.name  // Ensure name is preserved for single-item groups
                return sg
            })
            dispatch(setGroupsFromP2P(sourceGroups))
            console.log(`[P2P] Updated groups from P2P sync: ${sourceGroups.length} groups`)
        }
        
        // Update unread counts for affected sources
        if (newFeeds.length > 0 || newArticles.length > 0) {
            await dispatch(updateUnreadCounts())
        }
    }
}

export function sourceReducer(
    state: SourceState = {},
    action: SourceActionTypes | ItemActionTypes
): SourceState {
    switch (action.type) {
        case INIT_SOURCES:
            switch (action.status) {
                case ActionStatus.Success:
                    return action.sources
                default:
                    return state
            }
        case UPDATE_UNREAD_COUNTS:
            return action.sources
        case ADD_SOURCE:
            switch (action.status) {
                case ActionStatus.Success:
                    return {
                        ...state,
                        [action.source.sid]: action.source,
                    }
                default:
                    return state
            }
        case ADD_P2P_SOURCES:
            // Merge new P2P sources into state
            return {
                ...state,
                ...action.sources,
            }
        case UPDATE_SOURCE:
            return {
                ...state,
                [action.source.sid]: action.source,
            }
        case DELETE_SOURCE: {
            delete state[action.source.sid]
            return { ...state }
        }
        case FETCH_ITEMS: {
            switch (action.status) {
                case ActionStatus.Success: {
                    let updateMap = new Map<number, number>()
                    for (let item of action.items) {
                        if (!item.hasRead) {
                            updateMap.set(
                                item.source,
                                updateMap.has(item.source)
                                    ? updateMap.get(item.source) + 1
                                    : 1
                            )
                        }
                    }
                    let nextState = {} as SourceState
                    for (let [s, source] of Object.entries(state)) {
                        let sid = parseInt(s)
                        if (updateMap.has(sid)) {
                            nextState[sid] = {
                                ...source,
                                unreadCount:
                                    source.unreadCount + updateMap.get(sid),
                            } as RSSSource
                        } else {
                            nextState[sid] = source
                        }
                    }
                    return nextState
                }
                default:
                    return state
            }
        }
        case MARK_UNREAD:
        case MARK_READ:
            return {
                ...state,
                [action.item.source]: {
                    ...state[action.item.source],
                    unreadCount:
                        state[action.item.source].unreadCount +
                        (action.type === MARK_UNREAD ? 1 : -1),
                } as RSSSource,
            }
        case MARK_ALL_READ: {
            let nextState = { ...state }
            action.sids.forEach(sid => {
                nextState[sid] = {
                    ...state[sid],
                    unreadCount: action.time ? state[sid].unreadCount : 0,
                }
            })
            return nextState
        }
        default:
            return state
    }
}
