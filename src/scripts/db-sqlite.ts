/**
 * SQLite3 Database Layer for Fluent Reader
 * Provides a modern replacement for Lovefield with better security and performance
 */

import Database from "better-sqlite3"
import path from "path"
import { app } from "electron"
import { RSSSource } from "./models/source"
import { RSSItem } from "./models/item"

const dbPath = path.join(app.getPath("userData"), "fluent-reader.db")

let db: Database.Database
let initialized = false

export interface DBTables {
    sources: RSSSource[]
    items: RSSItem[]
}

/**
 * Initialize SQLite database with proper schema
 */
export async function initSqlite() {
    if (initialized) return

    db = new Database(dbPath)
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")

    // Create sources table
    db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
            sid INTEGER PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            iconurl TEXT,
            name TEXT,
            openTarget NUMBER,
            defaultZoom NUMBER DEFAULT 1,
            lastFetched DATETIME,
            serviceRef TEXT,
            fetchFrequency NUMBER DEFAULT 0,
            rules TEXT,
            textDir NUMBER DEFAULT 0,
            hidden BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `)

    // Create items table
    db.exec(`
        CREATE TABLE IF NOT EXISTS items (
            _id INTEGER PRIMARY KEY AUTOINCREMENT,
            source INTEGER NOT NULL,
            title TEXT,
            link TEXT,
            date DATETIME,
            fetchedDate DATETIME,
            thumb TEXT,
            content TEXT,
            snippet TEXT,
            creator TEXT,
            hasRead BOOLEAN DEFAULT 0,
            starred BOOLEAN DEFAULT 0,
            hidden BOOLEAN DEFAULT 0,
            notify BOOLEAN DEFAULT 0,
            serviceRef TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (source) REFERENCES sources(sid) ON DELETE CASCADE
        )
    `)

    // Create indexes for performance
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_items_date ON items(date DESC);
        CREATE INDEX IF NOT EXISTS idx_items_service ON items(serviceRef);
        CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
        CREATE INDEX IF NOT EXISTS idx_sources_url ON sources(url);
    `)

    initialized = true
}

/**
 * Insert sources
 */
export function insertSources(sources: RSSSource[]) {
    const stmt = db.prepare(`
        INSERT INTO sources 
        (sid, url, iconurl, name, openTarget, defaultZoom, lastFetched, serviceRef, fetchFrequency, rules, textDir, hidden)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insert = db.transaction((sources: RSSSource[]) => {
        for (const source of sources) {
            stmt.run(
                source.sid,
                source.url,
                source.iconurl || null,
                source.name,
                source.openTarget,
                source.defaultZoom || 1,
                source.lastFetched,
                source.serviceRef || null,
                source.fetchFrequency || 0,
                source.rules ? JSON.stringify(source.rules) : null,
                source.textDir || 0,
                source.hidden ? 1 : 0
            )
        }
    })

    insert(sources)
}

/**
 * Insert items
 */
export function insertItems(items: RSSItem[]) {
    const stmt = db.prepare(`
        INSERT INTO items 
        (source, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify, serviceRef)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insert = db.transaction((items: RSSItem[]) => {
        for (const item of items) {
            stmt.run(
                item.source,
                item.title || "Untitled",
                item.link,
                item.date,
                item.fetchedDate,
                item.thumb || null,
                item.content || "",
                item.snippet || "",
                item.creator || null,
                item.hasRead ? 1 : 0,
                item.starred ? 1 : 0,
                item.hidden ? 1 : 0,
                item.notify ? 1 : 0,
                item.serviceRef || null
            )
        }
    })

    insert(items)
}

/**
 * Get all sources
 */
export function getAllSources(): RSSSource[] {
    const stmt = db.prepare("SELECT * FROM sources ORDER BY sid")
    const rows = stmt.all()
    return rows.map(row => parseSqliteRow(row, "source")) as RSSSource[]
}

/**
 * Get all items
 */
export function getAllItems(): RSSItem[] {
    const stmt = db.prepare("SELECT * FROM items ORDER BY date DESC")
    const rows = stmt.all()
    return rows.map(row => parseSqliteRow(row, "item")) as RSSItem[]
}

/**
 * Delete all sources
 */
export function deleteAllSources() {
    db.exec("DELETE FROM sources")
}

/**
 * Delete all items
 */
export function deleteAllItems() {
    db.exec("DELETE FROM items")
}

/**
 * Close database connection
 */
export function closeSqlite() {
    if (db) {
        db.close()
        initialized = false
    }
}

/**
 * Helper: Parse SQLite row to proper types
 */
function parseSqliteRow(
    row: any,
    type: "source" | "item"
): RSSSource | RSSItem {
    if (type === "source") {
        return {
            ...row,
            lastFetched: row.lastFetched ? new Date(row.lastFetched) : null,
            defaultZoom: row.defaultZoom || 1,
            fetchFrequency: row.fetchFrequency || 0,
            rules: row.rules ? JSON.parse(row.rules) : undefined,
            hidden: Boolean(row.hidden),
        } as RSSSource
    } else {
        return {
            ...row,
            date: row.date ? new Date(row.date) : null,
            fetchedDate: row.fetchedDate ? new Date(row.fetchedDate) : null,
            hasRead: Boolean(row.hasRead),
            starred: Boolean(row.starred),
            hidden: Boolean(row.hidden),
            notify: Boolean(row.notify),
        } as RSSItem
    }
}

/**
 * Export database as JSON (for backups)
 */
export function exportDatabaseAsJSON(): DBTables {
    return {
        sources: getAllSources(),
        items: getAllItems(),
    }
}

/**
 * Import database from JSON (for restore)
 */
export async function importDatabaseFromJSON(data: DBTables) {
    deleteAllSources()
    deleteAllItems()
    
    if (data.sources?.length) {
        insertSources(data.sources)
    }
    if (data.items?.length) {
        insertItems(data.items)
    }
}
