import { SourceRow } from "../../bridges/db"
import { SyncService, ServiceConfigs } from "../../schema-types"
import { AppThunk, ActionStatus } from "../utils"
import { RSSItem, insertItems, fetchItemsSuccess } from "./item"
import { saveSettings, pushNotification } from "./app"
import {
    deleteSource,
    updateUnreadCounts,
    RSSSource,
    insertSource,
    addSourceSuccess,
    updateSource,
    updateFavicon,
} from "./source"
import { createSourceGroup, addSourceToGroup } from "./group"

import { feverServiceHooks } from "./services/fever"
import { feedbinServiceHooks } from "./services/feedbin"
import { gReaderServiceHooks } from "./services/greader"
import { minifluxServiceHooks } from "./services/miniflux"
import { nextcloudServiceHooks } from "./services/nextcloud"

export interface ServiceHooks {
    authenticate?: (configs: ServiceConfigs) => Promise<boolean>
    reauthenticate?: (configs: ServiceConfigs) => Promise<ServiceConfigs>
    updateSources?: () => AppThunk<Promise<[RSSSource[], Map<string, string>]>>
    fetchItems?: () => AppThunk<Promise<[RSSItem[], ServiceConfigs]>>
    syncItems?: () => AppThunk<Promise<[Set<string>, Set<string>]>>
    markRead?: (item: RSSItem) => AppThunk
    markUnread?: (item: RSSItem) => AppThunk
    markAllRead?: (
        sids?: number[],
        date?: Date,
        before?: boolean
    ) => AppThunk<Promise<void>>
    star?: (item: RSSItem) => AppThunk
    unstar?: (item: RSSItem) => AppThunk
}

export function getServiceHooksFromType(type: SyncService): ServiceHooks {
    switch (type) {
        case SyncService.Fever:
            return feverServiceHooks
        case SyncService.Feedbin:
            return feedbinServiceHooks
        case SyncService.GReader:
        case SyncService.Inoreader:
            return gReaderServiceHooks
        case SyncService.Miniflux:
            return minifluxServiceHooks
        case SyncService.Nextcloud:
            return nextcloudServiceHooks
        default:
            return {}
    }
}

export function getServiceHooks(): AppThunk<ServiceHooks> {
    return (_, getState) => {
        return getServiceHooksFromType(getState().service.type)
    }
}

export function syncWithService(background = false): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const hooks = dispatch(getServiceHooks())
        if (hooks.updateSources && hooks.fetchItems && hooks.syncItems) {
            try {
                dispatch({
                    type: SYNC_SERVICE,
                    status: ActionStatus.Request,
                })
                if (hooks.reauthenticate) await dispatch(reauthenticate(hooks))
                await dispatch(updateSources(hooks.updateSources))
                await dispatch(syncItems(hooks.syncItems))
                await dispatch(fetchItems(hooks.fetchItems, background))
                dispatch({
                    type: SYNC_SERVICE,
                    status: ActionStatus.Success,
                })
            } catch (err) {
                console.log(err)
                dispatch({
                    type: SYNC_SERVICE,
                    status: ActionStatus.Failure,
                    err: err,
                })
            } finally {
                if (getState().app.settings.saving) dispatch(saveSettings())
            }
        }
    }
}

function reauthenticate(hooks: ServiceHooks): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        let configs = getState().service
        if (!(await hooks.authenticate(configs))) {
            configs = await hooks.reauthenticate(configs)
            dispatch(saveServiceConfigs(configs))
        }
    }
}

function updateSources(
    hook: ServiceHooks["updateSources"]
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const [sources, groupsMap] = await dispatch(hook())
        const existing = new Map<string, RSSSource>()
        for (let source of Object.values(getState().sources)) {
            if (source.serviceRef) {
                existing.set(source.serviceRef, source)
            }
        }
        const forceSettings = () => {
            if (!getState().app.settings.saving) dispatch(saveSettings())
        }
        let promises = sources.map(async s => {
            if (existing.has(s.serviceRef)) {
                const doc = existing.get(s.serviceRef)
                existing.delete(s.serviceRef)
                return doc
            } else {
                // Use SQLite to check if source exists by URL
                const existingRow = await window.db.sources.getByUrl(s.url)
                if (!existingRow) {
                    // Create a new source
                    forceSettings()
                    const inserted = await dispatch(insertSource(s))
                    inserted.unreadCount = 0
                    dispatch(addSourceSuccess(inserted, true))
                    window.settings.saveGroups(getState().groups)
                    dispatch(updateFavicon([inserted.sid]))
                    return inserted
                } else if (existingRow.serviceRef !== s.serviceRef) {
                    // Mark an existing source as remote and remove all items
                    // Convert row to RSSSource
                    const doc: RSSSource = {
                        sid: existingRow.sid,
                        url: existingRow.url,
                        iconurl: existingRow.iconurl ?? undefined,
                        name: existingRow.name,
                        openTarget: existingRow.openTarget,
                        defaultZoom: existingRow.defaultZoom,
                        lastFetched: new Date(existingRow.lastFetched),
                        serviceRef: s.serviceRef,
                        fetchFrequency: existingRow.fetchFrequency,
                        rules: existingRow.rules ? JSON.parse(existingRow.rules) : undefined,
                        textDir: existingRow.textDir,
                        hidden: existingRow.hidden === 1,
                        mobileMode: existingRow.mobileMode === 1,
                        persistCookies: existingRow.persistCookies === 1,
                        unreadCount: 0
                    } as RSSSource
                    forceSettings()
                    await dispatch(updateSource(doc))
                    // Delete items using SQLite
                    await window.db.items.deleteBySource(doc.sid)
                    return doc
                } else {
                    // Convert existing row to RSSSource
                    return {
                        sid: existingRow.sid,
                        url: existingRow.url,
                        iconurl: existingRow.iconurl ?? undefined,
                        name: existingRow.name,
                        openTarget: existingRow.openTarget,
                        defaultZoom: existingRow.defaultZoom,
                        lastFetched: new Date(existingRow.lastFetched),
                        serviceRef: existingRow.serviceRef ?? undefined,
                        fetchFrequency: existingRow.fetchFrequency,
                        rules: existingRow.rules ? JSON.parse(existingRow.rules) : undefined,
                        textDir: existingRow.textDir,
                        hidden: existingRow.hidden === 1,
                        mobileMode: existingRow.mobileMode === 1,
                        persistCookies: existingRow.persistCookies === 1,
                        unreadCount: 0
                    } as RSSSource
                }
            }
        })
        for (let [_, source] of existing) {
            // Delete sources removed from the service side
            forceSettings()
            promises.push(dispatch(deleteSource(source, true)).then(() => null))
        }
        let sourcesResults = (await Promise.all(promises)).filter(s => s)
        if (groupsMap) {
            // Add sources to imported groups
            forceSettings()
            for (let source of sourcesResults) {
                if (groupsMap.has(source.serviceRef)) {
                    const gid = dispatch(
                        createSourceGroup(groupsMap.get(source.serviceRef))
                    )
                    dispatch(addSourceToGroup(gid, source.sid))
                }
            }
            const configs = getState().service
            delete configs.importGroups
            dispatch(saveServiceConfigs(configs))
        }
    }
}

function syncItems(hook: ServiceHooks["syncItems"]): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const state = getState()
        const [unreadRefs, starredRefs] = await dispatch(hook())
        const unreadCopy = new Set(unreadRefs)
        const starredCopy = new Set(starredRefs)
        
        // Query items with serviceRef that are unread or starred using SQLite
        const items = await window.db.items.query({
            hasServiceRef: true
        })
        
        // Filter to only unread or starred items
        const relevantItems = items.filter(item => !item.hasRead || item.starred)
        
        const updates: Promise<void>[] = []
        
        for (let item of relevantItems) {
            const serviceRef = item.serviceRef
            if (!serviceRef) continue
            
            // If local item is unread but service says it's read, mark as read
            if (!item.hasRead && !unreadRefs.delete(serviceRef)) {
                updates.push(window.db.items.markReadByServiceRef(serviceRef))
            }
            // If local item is starred but service says it's not, unstar it
            if (item.starred && !starredRefs.delete(serviceRef)) {
                updates.push(window.db.items.setStarredByServiceRef(serviceRef, false))
            }
        }
        
        // Mark items as unread that the service says are unread
        for (let unread of unreadRefs) {
            updates.push(window.db.items.markUnreadByServiceRef(unread))
        }
        
        // Mark items as starred that the service says are starred
        for (let starred of starredRefs) {
            updates.push(window.db.items.setStarredByServiceRef(starred, true))
        }
        
        if (updates.length > 0) {
            await Promise.all(updates)
            await dispatch(updateUnreadCounts())
            dispatch(syncLocalItems(unreadCopy, starredCopy))
        }
    }
}

function fetchItems(
    hook: ServiceHooks["fetchItems"],
    background: boolean
): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const [items, configs] = await dispatch(hook())
        if (items.length > 0) {
            const inserted = await insertItems(items)
            dispatch(fetchItemsSuccess(inserted.reverse(), getState().items))
            if (background) {
                for (let item of inserted) {
                    if (item.notify) dispatch(pushNotification(item))
                }
                if (inserted.length > 0) window.utils.requestAttention()
            }
            dispatch(saveServiceConfigs(configs))
        }
    }
}

export function importGroups(): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        const configs = getState().service
        if (configs.type !== SyncService.None) {
            dispatch(saveSettings())
            configs.importGroups = true
            dispatch(saveServiceConfigs(configs))
            await dispatch(syncWithService())
        }
    }
}

export function removeService(): AppThunk<Promise<void>> {
    return async (dispatch, getState) => {
        dispatch(saveSettings())
        const state = getState()
        const promises = Object.values(state.sources)
            .filter(s => s.serviceRef)
            .map(async s => {
                await dispatch(deleteSource(s, true))
            })
        await Promise.all(promises)
        dispatch(saveServiceConfigs({ type: SyncService.None }))
        dispatch(saveSettings())
    }
}

export const SAVE_SERVICE_CONFIGS = "SAVE_SERVICE_CONFIGS"
export const SYNC_SERVICE = "SYNC_SERVICE"
export const SYNC_LOCAL_ITEMS = "SYNC_LOCAL_ITEMS"

interface SaveServiceConfigsAction {
    type: typeof SAVE_SERVICE_CONFIGS
    configs: ServiceConfigs
}

interface SyncWithServiceAction {
    type: typeof SYNC_SERVICE
    status: ActionStatus
    err?
}

interface SyncLocalItemsAction {
    type: typeof SYNC_LOCAL_ITEMS
    unreadIds: Set<string>
    starredIds: Set<string>
}

export type ServiceActionTypes =
    | SaveServiceConfigsAction
    | SyncWithServiceAction
    | SyncLocalItemsAction

export function saveServiceConfigs(configs: ServiceConfigs): AppThunk {
    return dispatch => {
        window.settings.setServiceConfigs(configs)
        dispatch({
            type: SAVE_SERVICE_CONFIGS,
            configs: configs,
        })
    }
}

function syncLocalItems(
    unread: Set<string>,
    starred: Set<string>
): ServiceActionTypes {
    return {
        type: SYNC_LOCAL_ITEMS,
        unreadIds: unread,
        starredIds: starred,
    }
}

export function serviceReducer(
    state = window.settings.getServiceConfigs(),
    action: ServiceActionTypes
): ServiceConfigs {
    switch (action.type) {
        case SAVE_SERVICE_CONFIGS:
            return action.configs
        default:
            return state
    }
}
