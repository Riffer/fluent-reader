import Store from "electron-store"
import {
    SchemaTypes,
    SourceGroup,
    ViewType,
    ThemeSettings,
    SearchEngines,
    SyncService,
    ServiceConfigs,
    ViewConfigs,
} from "../schema-types"
import { ipcMain, session, nativeTheme, app } from "electron"
import { WindowManager } from "./window"

export const store = new Store<SchemaTypes>()

const GROUPS_STORE_KEY = "sourceGroups"
ipcMain.handle("set-groups", (_, groups: SourceGroup[]) => {
    store.set(GROUPS_STORE_KEY, groups)
})
ipcMain.on("get-groups", event => {
    event.returnValue = store.get(GROUPS_STORE_KEY, [])
})

const MENU_STORE_KEY = "menuOn"
ipcMain.on("get-menu", event => {
    event.returnValue = store.get(MENU_STORE_KEY, false)
})
ipcMain.handle("set-menu", (_, state: boolean) => {
    store.set(MENU_STORE_KEY, state)
})

const PAC_STORE_KEY = "pac"
const PAC_STATUS_KEY = "pacOn"
function getProxyStatus() {
    return store.get(PAC_STATUS_KEY, false)
}
function toggleProxyStatus() {
    store.set(PAC_STATUS_KEY, !getProxyStatus())
    setProxy()
}
function getProxy() {
    return store.get(PAC_STORE_KEY, "")
}
function setProxy(address = null) {
    if (!address) {
        address = getProxy()
    } else {
        store.set(PAC_STORE_KEY, address)
    }
    if (getProxyStatus()) {
        let rules = { pacScript: address }
        session.defaultSession.setProxy(rules)
        session.fromPartition("sandbox").setProxy(rules)
    }
}
ipcMain.on("get-proxy-status", event => {
    event.returnValue = getProxyStatus()
})
ipcMain.on("toggle-proxy-status", () => {
    toggleProxyStatus()
})
ipcMain.on("get-proxy", event => {
    event.returnValue = getProxy()
})
ipcMain.handle("set-proxy", (_, address = null) => {
    setProxy(address)
})

const VIEW_STORE_KEY = "view"
ipcMain.on("get-view", event => {
    event.returnValue = store.get(VIEW_STORE_KEY, ViewType.Cards)
})
ipcMain.handle("set-view", (_, viewType: ViewType) => {
    store.set(VIEW_STORE_KEY, viewType)
})

const THEME_STORE_KEY = "theme"
ipcMain.on("get-theme", event => {
    event.returnValue = store.get(THEME_STORE_KEY, ThemeSettings.Default)
})
ipcMain.handle("set-theme", (_, theme: ThemeSettings) => {
    store.set(THEME_STORE_KEY, theme)
    nativeTheme.themeSource = theme
})
ipcMain.on("get-theme-dark-color", event => {
    event.returnValue = nativeTheme.shouldUseDarkColors
})
export function setThemeListener(manager: WindowManager) {
    nativeTheme.removeAllListeners()
    nativeTheme.on("updated", () => {
        if (manager.hasWindow()) {
            let contents = manager.mainWindow.webContents
            if (!contents.isDestroyed()) {
                contents.send("theme-updated", nativeTheme.shouldUseDarkColors)
            }
        }
    })
}

const LOCALE_STORE_KEY = "locale"
ipcMain.handle("set-locale", (_, option: string) => {
    store.set(LOCALE_STORE_KEY, option)
})
function getLocaleSettings() {
    return store.get(LOCALE_STORE_KEY, "default")
}
ipcMain.on("get-locale-settings", event => {
    event.returnValue = getLocaleSettings()
})
ipcMain.on("get-locale", event => {
    let setting = getLocaleSettings()
    let locale = setting === "default" ? app.getLocale() : setting
    event.returnValue = locale
})

const FONT_SIZE_STORE_KEY = "fontSize"
ipcMain.on("get-font-size", event => {
    event.returnValue = store.get(FONT_SIZE_STORE_KEY, 16)
})
ipcMain.handle("set-font-size", (_, size: number) => {
    store.set(FONT_SIZE_STORE_KEY, size)
})

const FONT_STORE_KEY = "fontFamily"
ipcMain.on("get-font", event => {
    event.returnValue = store.get(FONT_STORE_KEY, "")
})
ipcMain.handle("set-font", (_, font: string) => {
    store.set(FONT_STORE_KEY, font)
})

ipcMain.on("get-all-settings", event => {
    let output = {}
    for (let [key, value] of store) {
        output[key] = value
    }
    event.returnValue = output
})

const FETCH_INTEVAL_STORE_KEY = "fetchInterval"
ipcMain.on("get-fetch-interval", event => {
    event.returnValue = store.get(FETCH_INTEVAL_STORE_KEY, 0)
})
ipcMain.handle("set-fetch-interval", (_, interval: number) => {
    store.set(FETCH_INTEVAL_STORE_KEY, interval)
})

const SEARCH_ENGINE_STORE_KEY = "searchEngine"
ipcMain.on("get-search-engine", event => {
    event.returnValue = store.get(SEARCH_ENGINE_STORE_KEY, SearchEngines.Google)
})
ipcMain.handle("set-search-engine", (_, engine: SearchEngines) => {
    store.set(SEARCH_ENGINE_STORE_KEY, engine)
})

const SERVICE_CONFIGS_STORE_KEY = "serviceConfigs"
ipcMain.on("get-service-configs", event => {
    event.returnValue = store.get(SERVICE_CONFIGS_STORE_KEY, {
        type: SyncService.None,
    })
})
ipcMain.handle("set-service-configs", (_, configs: ServiceConfigs) => {
    store.set(SERVICE_CONFIGS_STORE_KEY, configs)
})

const FILTER_TYPE_STORE_KEY = "filterType"
ipcMain.on("get-filter-type", event => {
    event.returnValue = store.get(FILTER_TYPE_STORE_KEY, null)
})
ipcMain.handle("set-filter-type", (_, filterType: number) => {
    store.set(FILTER_TYPE_STORE_KEY, filterType)
})

const LIST_CONFIGS_STORE_KEY = "listViewConfigs"
ipcMain.on("get-view-configs", (event, view: ViewType) => {
    switch (view) {
        case ViewType.List:
            event.returnValue = store.get(
                LIST_CONFIGS_STORE_KEY,
                ViewConfigs.ShowCover | ViewConfigs.FadeRead
            )
            break
        default:
            event.returnValue = undefined
            break
    }
})
ipcMain.handle(
    "set-view-configs",
    (_, view: ViewType, configs: ViewConfigs) => {
        switch (view) {
            case ViewType.List:
                store.set(LIST_CONFIGS_STORE_KEY, configs)
                break
        }
    }
)

const ZOOM_OVERLAY_STORE_KEY = "showZoomOverlay"
ipcMain.on("get-zoom-overlay", event => {
    event.returnValue = store.get(ZOOM_OVERLAY_STORE_KEY, false)
})
ipcMain.handle("set-zoom-overlay", (_, flag: boolean) => {
    store.set(ZOOM_OVERLAY_STORE_KEY, flag)
})

const NSFW_CLEANUP_STORE_KEY = "nsfwCleanupEnabled"
ipcMain.on("get-nsfw-cleanup", event => {
    event.returnValue = store.get(NSFW_CLEANUP_STORE_KEY, false)
})
ipcMain.handle("set-nsfw-cleanup", (_, flag: boolean) => {
    store.set(NSFW_CLEANUP_STORE_KEY, flag)
})

const AUTO_COOKIE_CONSENT_STORE_KEY = "autoCookieConsentEnabled"
ipcMain.on("get-auto-cookie-consent", event => {
    event.returnValue = store.get(AUTO_COOKIE_CONSENT_STORE_KEY, false)
})
ipcMain.handle("set-auto-cookie-consent", (_, flag: boolean) => {
    store.set(AUTO_COOKIE_CONSENT_STORE_KEY, flag)
})

const P2P_COLLECT_LINKS_STORE_KEY = "p2pCollectLinks"
ipcMain.on("get-p2p-collect-links", event => {
    event.returnValue = store.get(P2P_COLLECT_LINKS_STORE_KEY, false)
})
ipcMain.handle("set-p2p-collect-links", (_, flag: boolean) => {
    store.set(P2P_COLLECT_LINKS_STORE_KEY, flag)
})

// P2P Room persistence
const P2P_ROOM_CODE_STORE_KEY = "p2pRoomCode"
const P2P_DISPLAY_NAME_STORE_KEY = "p2pDisplayName"
const P2P_PEER_ID_STORE_KEY = "p2pPeerId"

export function getStoredP2PRoom(): { roomCode: string | null, displayName: string } {
    return {
        roomCode: store.get(P2P_ROOM_CODE_STORE_KEY, null) as string | null,
        displayName: store.get(P2P_DISPLAY_NAME_STORE_KEY, "Fluent Reader") as string
    }
}

export function setStoredP2PRoom(roomCode: string | null, displayName: string): void {
    if (roomCode) {
        store.set(P2P_ROOM_CODE_STORE_KEY, roomCode)
        store.set(P2P_DISPLAY_NAME_STORE_KEY, displayName)
    } else {
        store.delete(P2P_ROOM_CODE_STORE_KEY)
    }
}

export function clearStoredP2PRoom(): void {
    store.delete(P2P_ROOM_CODE_STORE_KEY)
}

/**
 * Get the stored P2P peer ID or null if not set
 */
export function getStoredP2PPeerId(): string | null {
    return store.get(P2P_PEER_ID_STORE_KEY, null) as string | null
}

/**
 * Save the P2P peer ID persistently
 */
export function setStoredP2PPeerId(peerId: string): void {
    store.set(P2P_PEER_ID_STORE_KEY, peerId)
}

// ============================================
// P2P SHARED FEEDS GROUP MANAGEMENT
// ============================================

import { P2P_GROUP_NAME } from "./db-sqlite"

/**
 * Get source groups from store
 */
export function getSourceGroups(): SourceGroup[] {
    return store.get(GROUPS_STORE_KEY, []) as SourceGroup[]
}

/**
 * Save source groups to store
 */
export function saveSourceGroups(groups: SourceGroup[]): void {
    store.set(GROUPS_STORE_KEY, groups)
}

/**
 * Find the index of the P2P shared feeds group, or -1 if not found
 */
export function findP2PGroupIndex(): number {
    const groups = getSourceGroups()
    return groups.findIndex(g => g.isMultiple && g.name === P2P_GROUP_NAME)
}

/**
 * Get or create the "P2P Geteilt" group and add a source to it.
 * Returns the updated groups array.
 * 
 * @param sid - Source ID to add to the group
 * @returns Updated groups array
 */
export function addSourceToP2PGroup(sid: number): SourceGroup[] {
    const groups = getSourceGroups()
    let groupIndex = findP2PGroupIndex()
    
    if (groupIndex === -1) {
        // Create new P2P group at the beginning
        console.log(`[settings] Creating new P2P group: "${P2P_GROUP_NAME}" (at start)`)
        const newGroup: SourceGroup = {
            isMultiple: true,
            sids: [sid],
            name: P2P_GROUP_NAME,
            expanded: true
        }
        groups.unshift(newGroup) // Insert at beginning instead of end
    } else {
        // Add to existing group if not already present
        const group = groups[groupIndex]
        if (!group.sids.includes(sid)) {
            console.log(`[settings] Adding source ${sid} to P2P group`)
            group.sids.push(sid)
        } else {
            console.log(`[settings] Source ${sid} already in P2P group`)
        }
    }
    
    saveSourceGroups(groups)
    return groups
}

/**
 * Check if a source is in the P2P group
 */
export function isSourceInP2PGroup(sid: number): boolean {
    const groupIndex = findP2PGroupIndex()
    if (groupIndex === -1) return false
    
    const groups = getSourceGroups()
    return groups[groupIndex].sids.includes(sid)
}

/**
 * Remove a source from the P2P group.
 * Returns the updated groups array, or null if source wasn't in P2P group.
 * 
 * @param sid - Source ID to remove from the P2P group
 * @returns Updated groups array or null
 */
export function removeSourceFromP2PGroup(sid: number): SourceGroup[] | null {
    const groups = getSourceGroups()
    const groupIndex = findP2PGroupIndex()
    
    if (groupIndex === -1) {
        console.log(`[settings] P2P group not found, nothing to remove`)
        return null
    }
    
    const group = groups[groupIndex]
    const sidIndex = group.sids.indexOf(sid)
    
    if (sidIndex === -1) {
        console.log(`[settings] Source ${sid} not in P2P group`)
        return null
    }
    
    // Remove the source from the group
    group.sids.splice(sidIndex, 1)
    console.log(`[settings] Removed source ${sid} from P2P group`)
    
    // If group is now empty, optionally remove the group itself
    // For now, keep empty groups as they may be used again
    
    saveSourceGroups(groups)
    return groups
}
