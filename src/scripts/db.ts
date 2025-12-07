import intl from "react-intl-universal"
import Datastore from "@seald-io/nedb"
import lf from "lovefield"
import { RSSSource, SourceOpenTarget, SourceTextDirection } from "./models/source"
import { RSSItem } from "./models/item"

// Note: db-sqlite is loaded only in Main Process, not in Renderer
// See: src/main/db-sqlite.ts

const sdbSchema = lf.schema.create("sourcesDB", 7)
sdbSchema
    .createTable("sources")
    .addColumn("sid", lf.Type.INTEGER)
    .addPrimaryKey(["sid"], false)
    .addColumn("url", lf.Type.STRING)
    .addColumn("iconurl", lf.Type.STRING)
    .addColumn("name", lf.Type.STRING)
    .addColumn("openTarget", lf.Type.NUMBER)
    .addColumn("defaultZoom", lf.Type.NUMBER)
    .addColumn("lastFetched", lf.Type.DATE_TIME)
    .addColumn("serviceRef", lf.Type.STRING)
    .addColumn("fetchFrequency", lf.Type.NUMBER)
    .addColumn("rules", lf.Type.OBJECT)
    .addColumn("textDir", lf.Type.NUMBER)
    .addColumn("hidden", lf.Type.BOOLEAN)
    .addColumn("mobileMode", lf.Type.BOOLEAN)
    .addColumn("persistCookies", lf.Type.BOOLEAN)
    .addNullable(["iconurl", "serviceRef", "rules"])
    .addIndex("idxURL", ["url"], true)

const idbSchema = lf.schema.create("itemsDB", 1)
idbSchema
    .createTable("items")
    .addColumn("_id", lf.Type.INTEGER)
    .addPrimaryKey(["_id"], true)
    .addColumn("source", lf.Type.INTEGER)
    .addColumn("title", lf.Type.STRING)
    .addColumn("link", lf.Type.STRING)
    .addColumn("date", lf.Type.DATE_TIME)
    .addColumn("fetchedDate", lf.Type.DATE_TIME)
    .addColumn("thumb", lf.Type.STRING)
    .addColumn("content", lf.Type.STRING)
    .addColumn("snippet", lf.Type.STRING)
    .addColumn("creator", lf.Type.STRING)
    .addColumn("hasRead", lf.Type.BOOLEAN)
    .addColumn("starred", lf.Type.BOOLEAN)
    .addColumn("hidden", lf.Type.BOOLEAN)
    .addColumn("notify", lf.Type.BOOLEAN)
    .addColumn("serviceRef", lf.Type.STRING)
    .addNullable(["thumb", "creator", "serviceRef"])
    .addIndex("idxDate", ["date"], false, lf.Order.DESC)
    .addIndex("idxService", ["serviceRef"], false)

export let sourcesDB: lf.Database
export let sources: lf.schema.Table
export let itemsDB: lf.Database
export let items: lf.schema.Table

async function onUpgradeSourceDB(rawDb: lf.raw.BackStore) {
    const version = rawDb.getVersion()
    if (version < 2) {
        await rawDb.addTableColumn("sources", "textDir", 0)
    }
    if (version < 3) {
        await rawDb.addTableColumn("sources", "hidden", false)
    }
    if (version < 4) {
        await rawDb.addTableColumn("sources", "defaultZoom", 1)
    }
    if (version < 6) {
        // Version 6: Add mobileMode column
        await rawDb.addTableColumn("sources", "mobileMode", false)
    }
    if (version < 7) {
        // Version 7: Add persistCookies column for cookie persistence feature
        await rawDb.addTableColumn("sources", "persistCookies", false)
    }
}

export async function init() {
    // Initialize Lovefield (primary DB for Renderer process)
    sourcesDB = await sdbSchema.connect({ onUpgrade: onUpgradeSourceDB })
    sources = sourcesDB.getSchema().table("sources")
    itemsDB = await idbSchema.connect()
    items = itemsDB.getSchema().table("items")
    
    // Check if we need to migrate from NeDB → Lovefield
    if (window.settings.getNeDBStatus()) {
        await migrateNeDB()
    }

    // Check if we need to migrate from Lovefield → SQLite
    if (window.settings.getLovefieldStatus()) {
        await migrateLovefieldToSQLite()
    }
}

/**
 * Migrate data from Lovefield (IndexedDB) to SQLite
 * This runs once after the SQLite infrastructure is in place
 */
async function migrateLovefieldToSQLite() {
    try {
        console.log("[migration] Starting Lovefield → SQLite migration...")

        // Initialize SQLite database via IPC
        await window.db.init()

        // Get all sources from Lovefield
        const sourceDocs = await sourcesDB
            .select()
            .from(sources)
            .exec() as RSSSource[]

        console.log(`[migration] Found ${sourceDocs.length} sources in Lovefield`)

        // Get all items from Lovefield
        const itemDocs = await itemsDB
            .select()
            .from(items)
            .exec() as RSSItem[]

        console.log(`[migration] Found ${itemDocs.length} items in Lovefield`)

        // Migrate sources to SQLite
        if (sourceDocs.length > 0) {
            for (const source of sourceDocs) {
                await window.db.sources.insert({
                    sid: source.sid,
                    url: source.url,
                    iconurl: source.iconurl || null,
                    name: source.name,
                    openTarget: source.openTarget ?? SourceOpenTarget.Local,
                    defaultZoom: source.defaultZoom ?? 1.0,
                    lastFetched: source.lastFetched?.toISOString() ?? new Date().toISOString(),
                    serviceRef: source.serviceRef || null,
                    fetchFrequency: source.fetchFrequency ?? 0,
                    rules: source.rules ? JSON.stringify(source.rules) : null,
                    textDir: source.textDir ?? SourceTextDirection.LTR,
                    hidden: source.hidden ? 1 : 0,
                    mobileMode: source.mobileMode ? 1 : 0,
                    persistCookies: source.persistCookies ? 1 : 0,
                })
            }
            console.log(`[migration] Migrated ${sourceDocs.length} sources to SQLite`)
        }

        // Migrate items to SQLite in batches (for performance)
        if (itemDocs.length > 0) {
            const BATCH_SIZE = 500
            const batches = Math.ceil(itemDocs.length / BATCH_SIZE)
            
            for (let i = 0; i < batches; i++) {
                const batch = itemDocs.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
                const sqliteItems = batch.map(item => ({
                    source: item.source,
                    title: item.title || intl.get("article.untitled"),
                    link: item.link || "",
                    date: item.date?.toISOString() ?? new Date().toISOString(),
                    fetchedDate: item.fetchedDate?.toISOString() ?? new Date().toISOString(),
                    thumb: item.thumb || null,
                    content: item.content || "",
                    snippet: item.snippet || "",
                    creator: item.creator || null,
                    hasRead: item.hasRead ? 1 : 0,
                    starred: item.starred ? 1 : 0,
                    hidden: item.hidden ? 1 : 0,
                    notify: item.notify ? 1 : 0,
                    serviceRef: item.serviceRef || null,
                }))
                
                await window.db.items.insertMany(sqliteItems)
                console.log(`[migration] Migrated items batch ${i + 1}/${batches} (${batch.length} items)`)
            }
            console.log(`[migration] Migrated ${itemDocs.length} items to SQLite`)
        }

        // Mark migration as complete
        window.settings.setLovefieldStatus(false)
        console.log("[migration] Lovefield → SQLite migration complete!")

        // Show stats
        const stats = await window.db.getStats()
        console.log(`[migration] SQLite DB stats: ${stats.sources} sources, ${stats.items} items, ${stats.dbSize}`)

    } catch (err) {
        console.error("[migration] Lovefield → SQLite migration failed:", err)
        window.utils.showErrorBox(
            "Database Migration Error",
            `Failed to migrate from Lovefield to SQLite: ${String(err)}\n\nThe app will continue using Lovefield.`
        )
        // Don't mark as complete - will retry next time
    }
}

async function migrateNeDB() {
    try {
        const sdb = new Datastore<RSSSource>({
            filename: "sources",
            autoload: true,
            onload: err => {
                if (err) window.console.log(err)
            },
        })
        const idb = new Datastore<RSSItem>({
            filename: "items",
            autoload: true,
            onload: err => {
                if (err) window.console.log(err)
            },
        })
        const [sourceDocs, itemDocs] = await Promise.all([
            new Promise<RSSSource[]>(resolve => {
                sdb.find({}, (_, docs) => {
                    resolve(docs)
                })
            }),
            new Promise<RSSItem[]>(resolve => {
                idb.find({}, (_, docs) => {
                    resolve(docs)
                })
            }),
        ])
        const sRows = sourceDocs.map(doc => {
            if (doc.serviceRef !== undefined)
                doc.serviceRef = String(doc.serviceRef)
            // @ts-ignore
            delete doc._id
            if (!doc.fetchFrequency) doc.fetchFrequency = 0
            doc.textDir = 0
            doc.hidden = false
            return sources.createRow(doc)
        })
        const iRows = itemDocs.map(doc => {
            if (doc.serviceRef !== undefined)
                doc.serviceRef = String(doc.serviceRef)
            if (!doc.title) doc.title = intl.get("article.untitled")
            if (!doc.content) doc.content = ""
            if (!doc.snippet) doc.snippet = ""
            delete doc._id
            doc.starred = Boolean(doc.starred)
            doc.hidden = Boolean(doc.hidden)
            doc.notify = Boolean(doc.notify)
            return items.createRow(doc)
        })
        await Promise.all([
            sourcesDB.insert().into(sources).values(sRows).exec(),
            itemsDB.insert().into(items).values(iRows).exec(),
        ])
        window.settings.setNeDBStatus(false)
        sdb.remove({}, { multi: true }, () => {
            sdb.persistence.compactDatafile()
        })
        idb.remove({}, { multi: true }, () => {
            idb.persistence.compactDatafile()
        })
    } catch (err) {
        window.utils.showErrorBox(
            "An error has occured during update. Please report this error on GitHub.",
            String(err)
        )
        window.utils.closeWindow()
    }
}


