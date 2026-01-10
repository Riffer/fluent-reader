import {
    SourceGroup,
    ViewType,
    ThemeSettings,
    SearchEngines,
    ServiceConfigs,
    ViewConfigs,
} from "../schema-types"
import { ipcRenderer } from "electron"

const settingsBridge = {
    saveGroups: (groups: SourceGroup[]) => {
        ipcRenderer.invoke("set-groups", groups)
    },
    loadGroups: (): SourceGroup[] => {
        return ipcRenderer.sendSync("get-groups")
    },

    getDefaultMenu: (): boolean => {
        return ipcRenderer.sendSync("get-menu")
    },
    setDefaultMenu: (state: boolean) => {
        ipcRenderer.invoke("set-menu", state)
    },

    getProxyStatus: (): boolean => {
        return ipcRenderer.sendSync("get-proxy-status")
    },
    toggleProxyStatus: () => {
        ipcRenderer.send("toggle-proxy-status")
    },
    getProxy: (): string => {
        return ipcRenderer.sendSync("get-proxy")
    },
    setProxy: (address: string = null) => {
        ipcRenderer.invoke("set-proxy", address)
    },

    getDefaultView: (): ViewType => {
        return ipcRenderer.sendSync("get-view")
    },
    setDefaultView: (viewType: ViewType) => {
        ipcRenderer.invoke("set-view", viewType)
    },

    getThemeSettings: (): ThemeSettings => {
        return ipcRenderer.sendSync("get-theme")
    },
    setThemeSettings: (theme: ThemeSettings) => {
        ipcRenderer.invoke("set-theme", theme)
    },
    shouldUseDarkColors: (): boolean => {
        return ipcRenderer.sendSync("get-theme-dark-color")
    },
    addThemeUpdateListener: (callback: (shouldDark: boolean) => any) => {
        ipcRenderer.on("theme-updated", (_, shouldDark) => {
            callback(shouldDark)
        })
    },

    setLocaleSettings: (option: string) => {
        ipcRenderer.invoke("set-locale", option)
    },
    getLocaleSettings: (): string => {
        return ipcRenderer.sendSync("get-locale-settings")
    },
    getCurrentLocale: (): string => {
        return ipcRenderer.sendSync("get-locale")
    },

    getFontSize: (): number => {
        return ipcRenderer.sendSync("get-font-size")
    },
    setFontSize: (size: number) => {
        ipcRenderer.invoke("set-font-size", size)
    },

    getFont: (): string => {
        return ipcRenderer.sendSync("get-font")
    },
    setFont: (font: string) => {
        ipcRenderer.invoke("set-font", font)
    },

    getFetchInterval: (): number => {
        return ipcRenderer.sendSync("get-fetch-interval")
    },
    setFetchInterval: (interval: number) => {
        ipcRenderer.invoke("set-fetch-interval", interval)
    },

    getSearchEngine: (): SearchEngines => {
        return ipcRenderer.sendSync("get-search-engine")
    },
    setSearchEngine: (engine: SearchEngines) => {
        ipcRenderer.invoke("set-search-engine", engine)
    },

    getServiceConfigs: (): ServiceConfigs => {
        return ipcRenderer.sendSync("get-service-configs")
    },
    setServiceConfigs: (configs: ServiceConfigs) => {
        ipcRenderer.invoke("set-service-configs", configs)
    },

    getFilterType: (): number => {
        return ipcRenderer.sendSync("get-filter-type")
    },
    setFilterType: (filterType: number) => {
        ipcRenderer.invoke("set-filter-type", filterType)
    },

    getViewConfigs: (view: ViewType): ViewConfigs => {
        return ipcRenderer.sendSync("get-view-configs", view)
    },
    setViewConfigs: (view: ViewType, configs: ViewConfigs) => {
        ipcRenderer.invoke("set-view-configs", view, configs)
    },

    getNeDBStatus: (): boolean => {
        return ipcRenderer.sendSync("get-nedb-status")
    },
    setNeDBStatus: (flag: boolean) => {
        ipcRenderer.invoke("set-nedb-status", flag)
    },

    getLovefieldStatus: (): boolean => {
        return ipcRenderer.sendSync("get-lovefield-status")
    },
    setLovefieldStatus: (flag: boolean) => {
        ipcRenderer.invoke("set-lovefield-status", flag)
    },

    getZoomOverlay: (): boolean => {
        return ipcRenderer.sendSync("get-zoom-overlay")
    },
    setZoomOverlay: (flag: boolean) => {
        ipcRenderer.invoke("set-zoom-overlay", flag)
    },

    getNsfwCleanup: (): boolean => {
        return ipcRenderer.sendSync("get-nsfw-cleanup")
    },
    setNsfwCleanup: (flag: boolean) => {
        ipcRenderer.invoke("set-nsfw-cleanup", flag)
    },

    getAutoCookieConsent: (): boolean => {
        return ipcRenderer.sendSync("get-auto-cookie-consent")
    },
    setAutoCookieConsent: (flag: boolean) => {
        ipcRenderer.invoke("set-auto-cookie-consent", flag)
    },

    getRedditGalleryExpand: (): boolean => {
        return ipcRenderer.sendSync("get-reddit-gallery-expand")
    },
    setRedditGalleryExpand: (flag: boolean) => {
        ipcRenderer.invoke("set-reddit-gallery-expand", flag)
    },

    getP2PCollectLinks: (): boolean => {
        return ipcRenderer.sendSync("get-p2p-collect-links")
    },
    setP2PCollectLinks: (flag: boolean) => {
        ipcRenderer.invoke("set-p2p-collect-links", flag)
    },

    getVisualZoom: (): boolean => {
        return ipcRenderer.sendSync("get-visual-zoom")
    },
    setVisualZoom: (flag: boolean) => {
        ipcRenderer.invoke("set-visual-zoom", flag)
    },

    getMobileUserAgent: (): boolean => {
        return ipcRenderer.sendSync("get-mobile-user-agent")
    },
    setMobileUserAgent: (flag: boolean) => {
        ipcRenderer.invoke("set-mobile-user-agent", flag)
    },

    getAll: () => {
        return ipcRenderer.sendSync("get-all-settings") as Object
    },

    setAll: configs => {
        ipcRenderer.invoke("import-all-settings", configs)
    },
    
    // Get emulated viewport info for display in UI badge/tooltip
    getEmulatedViewportInfo: (): { viewportWidth: number; viewportHeight: number; scale: number; mobileMode: boolean; zoomPercent: number } => {
        return ipcRenderer.sendSync("get-emulated-viewport-info")
    },
}

declare global {
    interface Window {
        settings: typeof settingsBridge
    }
}

export default settingsBridge
