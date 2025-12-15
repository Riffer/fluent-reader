import { IPartialTheme, loadTheme } from "@fluentui/react"
import locales from "./i18n/_locales"
import { ThemeSettings } from "../schema-types"
import intl from "react-intl-universal"
import { SourceTextDirection } from "./models/source"

let lightTheme: IPartialTheme = {
    defaultFontStyle: {
        fontFamily: '"Segoe UI", "Source Han Sans Regular", sans-serif',
    },
}
let darkTheme: IPartialTheme = {
    ...lightTheme,
    palette: {
        neutralLighterAlt: "#282828",
        neutralLighter: "#313131",
        neutralLight: "#3f3f3f",
        neutralQuaternaryAlt: "#484848",
        neutralQuaternary: "#4f4f4f",
        neutralTertiaryAlt: "#6d6d6d",
        neutralTertiary: "#c8c8c8",
        neutralSecondary: "#d0d0d0",
        neutralSecondaryAlt: "#d2d0ce",
        neutralPrimaryAlt: "#dadada",
        neutralPrimary: "#ffffff",
        neutralDark: "#f4f4f4",
        black: "#f8f8f8",
        white: "#1f1f1f",
        themePrimary: "#3a96dd",
        themeLighterAlt: "#020609",
        themeLighter: "#091823",
        themeLight: "#112d43",
        themeTertiary: "#235a85",
        themeSecondary: "#3385c3",
        themeDarkAlt: "#4ba0e1",
        themeDark: "#65aee6",
        themeDarker: "#8ac2ec",
        accent: "#3a96dd",
    },
}

export function setThemeDefaultFont(locale: string) {
    switch (locale) {
        case "zh-CN":
            lightTheme.defaultFontStyle.fontFamily =
                '"Segoe UI", "Source Han Sans SC Regular", "Microsoft YaHei", sans-serif'
            break
        case "zh-TW":
            lightTheme.defaultFontStyle.fontFamily =
                '"Segoe UI", "Source Han Sans TC Regular", "Microsoft JhengHei", sans-serif'
            break
        case "ja":
            lightTheme.defaultFontStyle.fontFamily =
                '"Segoe UI", "Source Han Sans JP Regular", "Yu Gothic UI", sans-serif'
            break
        case "ko":
            lightTheme.defaultFontStyle.fontFamily =
                '"Segoe UI", "Source Han Sans KR Regular", "Malgun Gothic", sans-serif'
            break
        default:
            lightTheme.defaultFontStyle.fontFamily =
                '"Segoe UI", "Source Han Sans Regular", sans-serif'
    }
    darkTheme.defaultFontStyle.fontFamily =
        lightTheme.defaultFontStyle.fontFamily
    applyThemeSettings()
}
export function setThemeSettings(theme: ThemeSettings) {
    window.settings.setThemeSettings(theme)
    applyThemeSettings()
}
export function getThemeSettings(): ThemeSettings {
    return window.settings.getThemeSettings()
}
export function applyThemeSettings() {
    loadTheme(window.settings.shouldUseDarkColors() ? darkTheme : lightTheme)
}
window.settings.addThemeUpdateListener(shouldDark => {
    loadTheme(shouldDark ? darkTheme : lightTheme)
})

export function getCurrentLocale() {
    let locale = window.settings.getCurrentLocale()
    if (locale in locales) return locale
    locale = locale.split("-")[0]
    return locale in locales ? locale : "en-US"
}

export async function exportAll() {
    const filters = [{ name: intl.get("app.frData"), extensions: ["frdata"] }]
    const write = await window.utils.showSaveDialog(
        filters,
        "*/Fluent_Reader_Backup.frdata"
    )
    if (write) {
        let output = window.settings.getAll()
        // Export from SQLite
        output["sqlite"] = {
            sources: await window.db.sources.getAll(),
            items: await window.db.items.query({}),
        }
        write(JSON.stringify(output), intl.get("settings.writeError"))
    }
}

export async function importAll() {
    const filters = [{ name: intl.get("app.frData"), extensions: ["frdata"] }]
    let data = await window.utils.showOpenDialog(filters)
    if (!data) return true
    let confirmed = await window.utils.showMessageBox(
        intl.get("app.restore"),
        intl.get("app.confirmImport"),
        intl.get("confirm"),
        intl.get("cancel"),
        true,
        "warning"
    )
    if (!confirmed) return true
    let configs = JSON.parse(data)
    
    // Clear existing data in SQLite
    await window.db.clearAll()
    
    // Handle different backup formats
    if (configs.sqlite) {
        // New SQLite format
        for (const source of configs.sqlite.sources) {
            await window.db.sources.insert(source)
        }
        if (configs.sqlite.items?.length > 0) {
            await window.db.items.insertMany(configs.sqlite.items)
        }
        delete configs.sqlite
    } else if (configs.lovefield) {
        // Legacy Lovefield format - convert and import
        for (const s of configs.lovefield.sources) {
            await window.db.sources.insert({
                sid: s.sid,
                url: s.url,
                iconurl: s.iconurl || null,
                name: s.name,
                openTarget: s.openTarget ?? 0,
                defaultZoom: s.defaultZoom ?? 1.0,
                lastFetched: s.lastFetched || new Date().toISOString(),
                serviceRef: s.serviceRef || null,
                fetchFrequency: s.fetchFrequency ?? 0,
                rules: s.rules ? JSON.stringify(s.rules) : null,
                textDir: s.textDir ?? SourceTextDirection.LTR,
                hidden: s.hidden ? 1 : 0,
                mobileMode: s.mobileMode ? 1 : 0,
                persistCookies: s.persistCookies ? 1 : 0,
            })
        }
        if (configs.lovefield.items?.length > 0) {
            const items = configs.lovefield.items.map(i => ({
                source: i.source,
                title: i.title || "",
                link: i.link || "",
                date: i.date || new Date().toISOString(),
                fetchedDate: i.fetchedDate || new Date().toISOString(),
                thumb: i.thumb || null,
                content: i.content || "",
                snippet: i.snippet || "",
                creator: i.creator || null,
                hasRead: i.hasRead ? 1 : 0,
                starred: i.starred ? 1 : 0,
                hidden: i.hidden ? 1 : 0,
                notify: i.notify ? 1 : 0,
                serviceRef: i.serviceRef || null,
            }))
            await window.db.items.insertMany(items)
        }
        delete configs.lovefield
    }
    
    // Remove legacy flags if present
    delete configs.useNeDB
    delete configs.useLovefield
    delete configs.nedb
    
    window.settings.setAll(configs)
    return false
}
