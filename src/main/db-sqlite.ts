/**
 * SQLite Database Module (Main Process)
 * 
 * Uses better-sqlite3 for synchronous, high-performance database operations.
 * All database operations run in the Main process and are accessed via IPC from Renderer.
 * 
 * Schema matches Lovefield schema from src/scripts/db.ts for migration compatibility.
 */

import Database from "better-sqlite3"
import { app, ipcMain } from "electron"
import path from "path"

// Database instance
let db: Database.Database | null = null

// Schema version for migrations
const SCHEMA_VERSION = 4

// Types matching the Lovefield models
export interface SourceRow {
    sid: number
    url: string
    iconurl: string | null
    name: string
    openTarget: number
    defaultZoom: number
    lastFetched: string  // ISO date string
    serviceRef: string | null
    fetchFrequency: number
    rules: string | null  // JSON string
    textDir: number
    hidden: number  // SQLite boolean (0/1)
    mobileMode: number  // SQLite boolean (0/1)
    persistCookies: number  // SQLite boolean (0/1)
}

export interface ItemRow {
    _id: number
    source: number
    title: string
    link: string
    date: string  // ISO date string
    fetchedDate: string  // ISO date string
    thumb: string | null
    content: string
    snippet: string
    creator: string | null
    hasRead: number  // SQLite boolean (0/1)
    starred: number  // SQLite boolean (0/1)
    hidden: number  // SQLite boolean (0/1)
    notify: number  // SQLite boolean (0/1)
    serviceRef: string | null
}

/**
 * Get the database file path
 */
function getDbPath(): string {
    const userDataPath = app.getPath("userData")
    return path.join(userDataPath, "fluent-reader.db")
}

/**
 * Initialize the SQLite database
 */
export function initDatabase(): Database.Database {
    if (db) return db

    const dbPath = getDbPath()
    console.log(`[db-sqlite] Initializing database at: ${dbPath}`)

    db = new Database(dbPath)
    
    // Enable WAL mode for better concurrent access
    db.pragma("journal_mode = WAL")
    
    // Create tables
    createTables()
    
    // Run migrations
    runMigrations()

    return db
}

/**
 * Create database tables if they don't exist
 */
function createTables(): void {
    if (!db) throw new Error("Database not initialized")

    // Schema version table
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY
        )
    `)

    // Sources table - matches Lovefield schema
    db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
            sid INTEGER PRIMARY KEY,
            url TEXT NOT NULL UNIQUE,
            iconurl TEXT,
            name TEXT NOT NULL,
            openTarget INTEGER NOT NULL DEFAULT 0,
            defaultZoom REAL NOT NULL DEFAULT 1.0,
            lastFetched TEXT NOT NULL,
            serviceRef TEXT,
            fetchFrequency INTEGER NOT NULL DEFAULT 0,
            rules TEXT,
            textDir INTEGER NOT NULL DEFAULT 0,
            hidden INTEGER NOT NULL DEFAULT 0,
            mobileMode INTEGER NOT NULL DEFAULT 0,
            persistCookies INTEGER NOT NULL DEFAULT 0
        )
    `)

    // Items table - matches Lovefield schema
    db.exec(`
        CREATE TABLE IF NOT EXISTS items (
            _id INTEGER PRIMARY KEY AUTOINCREMENT,
            source INTEGER NOT NULL,
            title TEXT NOT NULL,
            link TEXT NOT NULL,
            date TEXT NOT NULL,
            fetchedDate TEXT NOT NULL,
            thumb TEXT,
            content TEXT NOT NULL,
            snippet TEXT NOT NULL,
            creator TEXT,
            hasRead INTEGER NOT NULL DEFAULT 0,
            starred INTEGER NOT NULL DEFAULT 0,
            hidden INTEGER NOT NULL DEFAULT 0,
            notify INTEGER NOT NULL DEFAULT 0,
            serviceRef TEXT,
            FOREIGN KEY (source) REFERENCES sources(sid) ON DELETE CASCADE
        )
    `)

    // Create indexes for performance
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_items_date ON items(date DESC);
        CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);
        CREATE INDEX IF NOT EXISTS idx_items_serviceRef ON items(serviceRef);
        CREATE INDEX IF NOT EXISTS idx_items_hasRead ON items(hasRead);
        CREATE INDEX IF NOT EXISTS idx_items_starred ON items(starred);
    `)

    // P2P Pending Shares Queue table
    db.exec(`
        CREATE TABLE IF NOT EXISTS p2p_pending_shares (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peerId TEXT NOT NULL,
            peerName TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT NOT NULL,
            feedName TEXT,
            feedUrl TEXT,
            feedIconUrl TEXT,
            createdAt TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            lastAttempt TEXT
        )
    `)

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pending_shares_peerId ON p2p_pending_shares(peerId);
    `)

    // P2P Known Peers table - persists peers across restarts
    db.exec(`
        CREATE TABLE IF NOT EXISTS p2p_known_peers (
            peerId TEXT PRIMARY KEY,
            peerName TEXT NOT NULL,
            roomCode TEXT NOT NULL,
            lastSeen TEXT NOT NULL,
            createdAt TEXT NOT NULL
        )
    `)

    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_known_peers_roomCode ON p2p_known_peers(roomCode);
    `)
}

/**
 * Run database migrations
 */
function runMigrations(): void {
    if (!db) throw new Error("Database not initialized")

    const versionRow = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined
    const currentVersion = versionRow?.version ?? 0

    if (currentVersion < SCHEMA_VERSION) {
        console.log(`[db-sqlite] Migrating from version ${currentVersion} to ${SCHEMA_VERSION}`)
        
        // Migration to v2: Add p2p_pending_shares table
        if (currentVersion < 2) {
            console.log("[db-sqlite] Migration v2: Adding p2p_pending_shares table")
            db.exec(`
                CREATE TABLE IF NOT EXISTS p2p_pending_shares (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    peerId TEXT NOT NULL,
                    peerName TEXT NOT NULL,
                    url TEXT NOT NULL,
                    title TEXT NOT NULL,
                    feedName TEXT,
                    createdAt TEXT NOT NULL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    lastAttempt TEXT
                )
            `)
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_pending_shares_peerId ON p2p_pending_shares(peerId);
            `)
        }
        
        // Migration to v3: Add feedUrl and feedIconUrl to p2p_pending_shares
        if (currentVersion < 3) {
            console.log("[db-sqlite] Migration v3: Adding feedUrl and feedIconUrl to p2p_pending_shares")
            // Check if columns exist before adding (safe migration)
            const tableInfo = db.prepare("PRAGMA table_info(p2p_pending_shares)").all() as Array<{ name: string }>
            const columnNames = tableInfo.map(c => c.name)
            
            if (!columnNames.includes("feedUrl")) {
                db.exec(`ALTER TABLE p2p_pending_shares ADD COLUMN feedUrl TEXT`)
            }
            if (!columnNames.includes("feedIconUrl")) {
                db.exec(`ALTER TABLE p2p_pending_shares ADD COLUMN feedIconUrl TEXT`)
            }
        }

        // Migration to v4: Add p2p_known_peers table for peer persistence
        if (currentVersion < 4) {
            console.log("[db-sqlite] Migration v4: Adding p2p_known_peers table")
            db.exec(`
                CREATE TABLE IF NOT EXISTS p2p_known_peers (
                    peerId TEXT PRIMARY KEY,
                    peerName TEXT NOT NULL,
                    roomCode TEXT NOT NULL,
                    lastSeen TEXT NOT NULL,
                    createdAt TEXT NOT NULL
                )
            `)
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_known_peers_roomCode ON p2p_known_peers(roomCode);
            `)
        }

        // Update schema version
        if (currentVersion === 0) {
            db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION)
        } else {
            db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION)
        }
    }
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
    if (db) {
        db.close()
        db = null
    }
}

// ============================================
// SOURCE OPERATIONS
// ============================================

export function getAllSources(): SourceRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM sources").all() as SourceRow[]
}

export function getSourceById(sid: number): SourceRow | undefined {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM sources WHERE sid = ?").get(sid) as SourceRow | undefined
}

export function getSourceByUrl(url: string): SourceRow | undefined {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM sources WHERE url = ?").get(url) as SourceRow | undefined
}

export function insertSource(source: Omit<SourceRow, "sid"> & { sid?: number }): number {
    if (!db) throw new Error("Database not initialized")
    
    const stmt = db.prepare(`
        INSERT INTO sources (sid, url, iconurl, name, openTarget, defaultZoom, lastFetched, serviceRef, fetchFrequency, rules, textDir, hidden, mobileMode, persistCookies)
        VALUES (@sid, @url, @iconurl, @name, @openTarget, @defaultZoom, @lastFetched, @serviceRef, @fetchFrequency, @rules, @textDir, @hidden, @mobileMode, @persistCookies)
    `)
    
    const result = stmt.run({
        sid: source.sid ?? null,
        url: source.url,
        iconurl: source.iconurl ?? null,
        name: source.name,
        openTarget: source.openTarget,
        defaultZoom: source.defaultZoom,
        lastFetched: source.lastFetched,
        serviceRef: source.serviceRef ?? null,
        fetchFrequency: source.fetchFrequency,
        rules: source.rules ?? null,
        textDir: source.textDir,
        hidden: source.hidden,
        mobileMode: source.mobileMode,
        persistCookies: source.persistCookies
    })
    
    return result.lastInsertRowid as number
}

export function updateSource(sid: number, updates: Partial<SourceRow>): void {
    if (!db) throw new Error("Database not initialized")
    
    const fields = Object.keys(updates).filter(k => k !== "sid")
    if (fields.length === 0) return
    
    // DEBUG: Log what we're updating
    if ('defaultZoom' in updates) {
        console.log(`[db-sqlite updateSource] Updating sid=${sid}, defaultZoom=${updates.defaultZoom}`)
    }
    
    const setClause = fields.map(f => `${f} = @${f}`).join(", ")
    const stmt = db.prepare(`UPDATE sources SET ${setClause} WHERE sid = @sid`)
    
    stmt.run({ ...updates, sid })
}

export function deleteSource(sid: number): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("DELETE FROM sources WHERE sid = ?").run(sid)
}

export function getNextSourceId(): number {
    if (!db) throw new Error("Database not initialized")
    const row = db.prepare("SELECT MAX(sid) as maxSid FROM sources").get() as { maxSid: number | null }
    return (row.maxSid ?? 0) + 1
}

export function deleteAllSources(): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("DELETE FROM sources").run()
}

export function bulkInsertSources(sources: SourceRow[]): number[] {
    if (!db) throw new Error("Database not initialized")
    
    const stmt = db.prepare(`
        INSERT INTO sources (sid, url, iconurl, name, openTarget, defaultZoom, lastFetched, serviceRef, fetchFrequency, rules, textDir, hidden, mobileMode, persistCookies)
        VALUES (@sid, @url, @iconurl, @name, @openTarget, @defaultZoom, @lastFetched, @serviceRef, @fetchFrequency, @rules, @textDir, @hidden, @mobileMode, @persistCookies)
    `)
    
    const insertMany = db.transaction((sources: SourceRow[]) => {
        const ids: number[] = []
        for (const source of sources) {
            const result = stmt.run({
                sid: source.sid ?? null,
                url: source.url,
                iconurl: source.iconurl ?? null,
                name: source.name,
                openTarget: source.openTarget,
                defaultZoom: source.defaultZoom,
                lastFetched: source.lastFetched,
                serviceRef: source.serviceRef ?? null,
                fetchFrequency: source.fetchFrequency,
                rules: source.rules ?? null,
                textDir: source.textDir,
                hidden: source.hidden,
                mobileMode: source.mobileMode,
                persistCookies: source.persistCookies
            })
            ids.push(result.lastInsertRowid as number)
        }
        return ids
    })
    
    return insertMany(sources)
}

// ============================================
// P2P SHARED FEED OPERATIONS
// ============================================

/** ServiceRef value for P2P shared feeds - prevents auto-fetching */
export const P2P_SHARED_SERVICE_REF = "p2p-shared"

/** Default group name for P2P shared feeds */
export const P2P_GROUP_NAME = "P2P Geteilt"

/**
 * Get or create a passive P2P feed for the given URL.
 * If feed already exists (active or passive), returns the existing sid.
 * If not, creates a new passive feed with serviceRef = "p2p-shared".
 * 
 * @returns { sid: number, created: boolean }
 */
export function getOrCreateP2PFeed(
    feedUrl: string,
    feedName: string,
    feedIconUrl?: string,
    openTarget?: number,
    defaultZoom?: number
): { sid: number; created: boolean } {
    if (!db) throw new Error("Database not initialized")
    
    // Check if feed already exists
    const existing = getSourceByUrl(feedUrl)
    if (existing) {
        return { sid: existing.sid, created: false }
    }
    
    // Create new passive feed
    const nextSid = getNextSourceId()
    const now = new Date().toISOString()
    
    const sid = insertSource({
        sid: nextSid,
        url: feedUrl,
        iconurl: feedIconUrl ?? null,
        name: feedName || "P2P Shared Feed",
        openTarget: openTarget ?? 0, // SourceOpenTarget.Local if not provided
        defaultZoom: defaultZoom ?? 0,
        lastFetched: now,
        serviceRef: P2P_SHARED_SERVICE_REF, // This prevents auto-fetching!
        fetchFrequency: 0,
        rules: null,
        textDir: 0, // SourceTextDirection.LTR
        hidden: 0, // SQLite boolean (0 = false)
        mobileMode: 0, // SQLite boolean (0 = false)
        persistCookies: 0 // SQLite boolean (0 = false)
    })
    
    return { sid, created: true }
}

/**
 * Get all P2P shared feeds (feeds with serviceRef = "p2p-shared")
 */
export function getP2PSharedFeeds(): SourceRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM sources WHERE serviceRef = ?").all(P2P_SHARED_SERVICE_REF) as SourceRow[]
}

/**
 * Convert a P2P passive feed to an active feed (enable auto-fetching)
 */
export function convertP2PFeedToActive(sid: number): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("UPDATE sources SET serviceRef = NULL WHERE sid = ? AND serviceRef = ?")
        .run(sid, P2P_SHARED_SERVICE_REF)
}

// ============================================
// ITEM OPERATIONS
// ============================================

export function getItemById(id: number): ItemRow | undefined {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM items WHERE _id = ?").get(id) as ItemRow | undefined
}

export function getItemsBySource(sourceId: number, limit?: number, offset?: number): ItemRow[] {
    if (!db) throw new Error("Database not initialized")
    
    let query = "SELECT * FROM items WHERE source = ? ORDER BY date DESC"
    if (limit) {
        query += ` LIMIT ${limit}`
        if (offset) query += ` OFFSET ${offset}`
    }
    
    return db.prepare(query).all(sourceId) as ItemRow[]
}

export function getItemsCount(sourceId?: number, unreadOnly?: boolean): number {
    if (!db) throw new Error("Database not initialized")
    
    let query = "SELECT COUNT(*) as count FROM items"
    const conditions: string[] = []
    const params: any[] = []
    
    if (sourceId !== undefined) {
        conditions.push("source = ?")
        params.push(sourceId)
    }
    if (unreadOnly) {
        conditions.push("hasRead = 0")
    }
    
    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ")
    }
    
    const row = db.prepare(query).get(...params) as { count: number }
    return row.count
}

export function insertItem(item: Omit<ItemRow, "_id">): number {
    if (!db) throw new Error("Database not initialized")
    
    const stmt = db.prepare(`
        INSERT INTO items (source, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify, serviceRef)
        VALUES (@source, @title, @link, @date, @fetchedDate, @thumb, @content, @snippet, @creator, @hasRead, @starred, @hidden, @notify, @serviceRef)
    `)
    
    const result = stmt.run({
        source: item.source,
        title: item.title,
        link: item.link,
        date: item.date,
        fetchedDate: item.fetchedDate,
        thumb: item.thumb ?? null,
        content: item.content,
        snippet: item.snippet,
        creator: item.creator ?? null,
        hasRead: item.hasRead,
        starred: item.starred,
        hidden: item.hidden,
        notify: item.notify,
        serviceRef: item.serviceRef ?? null
    })
    
    return result.lastInsertRowid as number
}

export function insertItems(items: Omit<ItemRow, "_id">[]): number[] {
    if (!db) throw new Error("Database not initialized")
    if (items.length === 0) return []
    
    const stmt = db.prepare(`
        INSERT INTO items (source, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify, serviceRef)
        VALUES (@source, @title, @link, @date, @fetchedDate, @thumb, @content, @snippet, @creator, @hasRead, @starred, @hidden, @notify, @serviceRef)
    `)
    
    const insertMany = db.transaction((items: Omit<ItemRow, "_id">[]) => {
        const ids: number[] = []
        for (const item of items) {
            const result = stmt.run({
                source: item.source,
                title: item.title,
                link: item.link,
                date: item.date,
                fetchedDate: item.fetchedDate,
                thumb: item.thumb ?? null,
                content: item.content,
                snippet: item.snippet,
                creator: item.creator ?? null,
                hasRead: item.hasRead,
                starred: item.starred,
                hidden: item.hidden,
                notify: item.notify,
                serviceRef: item.serviceRef ?? null
            })
            ids.push(result.lastInsertRowid as number)
        }
        return ids
    })
    
    return insertMany(items)
}

export function updateItem(id: number, updates: Partial<ItemRow>): void {
    if (!db) throw new Error("Database not initialized")
    
    const fields = Object.keys(updates).filter(k => k !== "_id")
    if (fields.length === 0) return
    
    const setClause = fields.map(f => `${f} = @${f}`).join(", ")
    const stmt = db.prepare(`UPDATE items SET ${setClause} WHERE _id = @_id`)
    
    stmt.run({ ...updates, _id: id })
}

export function deleteItem(id: number): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("DELETE FROM items WHERE _id = ?").run(id)
}

export function deleteItemsBySource(sourceId: number): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("DELETE FROM items WHERE source = ?").run(sourceId)
}

export function getAllItems(): ItemRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM items").all() as ItemRow[]
}

export function deleteAllItems(): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("DELETE FROM items").run()
}

export function bulkInsertItems(items: ItemRow[]): number[] {
    if (!db) throw new Error("Database not initialized")
    if (items.length === 0) return []
    
    const stmt = db.prepare(`
        INSERT INTO items (_id, source, title, link, date, fetchedDate, thumb, content, snippet, creator, hasRead, starred, hidden, notify, serviceRef)
        VALUES (@_id, @source, @title, @link, @date, @fetchedDate, @thumb, @content, @snippet, @creator, @hasRead, @starred, @hidden, @notify, @serviceRef)
    `)
    
    const insertMany = db.transaction((items: ItemRow[]) => {
        const ids: number[] = []
        for (const item of items) {
            const result = stmt.run({
                _id: item._id ?? null,
                source: item.source,
                title: item.title,
                link: item.link,
                date: item.date,
                fetchedDate: item.fetchedDate,
                thumb: item.thumb ?? null,
                content: item.content,
                snippet: item.snippet,
                creator: item.creator ?? null,
                hasRead: item.hasRead,
                starred: item.starred,
                hidden: item.hidden,
                notify: item.notify,
                serviceRef: item.serviceRef ?? null
            })
            ids.push(result.lastInsertRowid as number)
        }
        return ids
    })
    
    return insertMany(items)
}

export function markItemRead(id: number, hasRead: boolean = true): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("UPDATE items SET hasRead = ? WHERE _id = ?").run(hasRead ? 1 : 0, id)
}

export function markAllRead(sourceIds: number[], beforeDate?: string): void {
    if (!db) throw new Error("Database not initialized")
    
    if (sourceIds.length === 0) return
    
    const placeholders = sourceIds.map(() => "?").join(",")
    let query = `UPDATE items SET hasRead = 1 WHERE source IN (${placeholders})`
    const params: any[] = [...sourceIds]
    
    if (beforeDate) {
        query += " AND date <= ?"
        params.push(beforeDate)
    }
    
    db.prepare(query).run(...params)
}

export function toggleStarred(id: number): boolean {
    if (!db) throw new Error("Database not initialized")
    
    const item = getItemById(id)
    if (!item) throw new Error(`Item ${id} not found`)
    
    const newValue = item.starred ? 0 : 1
    db.prepare("UPDATE items SET starred = ? WHERE _id = ?").run(newValue, id)
    return newValue === 1
}

export function toggleHidden(id: number): boolean {
    if (!db) throw new Error("Database not initialized")
    
    const item = getItemById(id)
    if (!item) throw new Error(`Item ${id} not found`)
    
    const newValue = item.hidden ? 0 : 1
    db.prepare("UPDATE items SET hidden = ? WHERE _id = ?").run(newValue, id)
    return newValue === 1
}

/**
 * Check if an item already exists (for deduplication)
 */
export function itemExists(sourceId: number, title: string, date: string): boolean {
    if (!db) throw new Error("Database not initialized")
    
    const row = db.prepare(`
        SELECT 1 FROM items 
        WHERE source = ? AND title = ? AND date = ?
        LIMIT 1
    `).get(sourceId, title, date)
    
    return row !== undefined
}

/**
 * Check if an item with given link already exists in a source (for P2P deduplication)
 * Returns the existing item's _id if found, null otherwise
 */
export function itemExistsByLink(sourceId: number, link: string): number | null {
    if (!db) throw new Error("Database not initialized")
    
    const row = db.prepare(`
        SELECT _id FROM items 
        WHERE source = ? AND link = ?
        LIMIT 1
    `).get(sourceId, link) as { _id: number } | undefined
    
    return row?._id ?? null
}

/**
 * Find an article globally by its link (across all feeds)
 * Returns the article's _id and source, or null if not found
 */
export function findArticleByLink(link: string): { articleId: number, sourceId: number } | null {
    if (!db) throw new Error("Database not initialized")
    
    const row = db.prepare(`
        SELECT _id, source FROM items 
        WHERE link = ?
        LIMIT 1
    `).get(link) as { _id: number, source: number } | undefined
    
    if (row) {
        return { articleId: row._id, sourceId: row.source }
    }
    return null
}

/**
 * Query items with flexible filtering
 */
export interface ItemQueryOptions {
    sourceIds?: number[]
    unreadOnly?: boolean
    starredOnly?: boolean
    hiddenOnly?: boolean
    searchTerm?: string
    hasServiceRef?: boolean
    limit?: number
    offset?: number
    orderBy?: "date" | "fetchedDate"
    orderDir?: "ASC" | "DESC"
}

export function queryItems(options: ItemQueryOptions = {}): ItemRow[] {
    if (!db) throw new Error("Database not initialized")
    
    const conditions: string[] = []
    const params: any[] = []
    
    if (options.sourceIds && options.sourceIds.length > 0) {
        const placeholders = options.sourceIds.map(() => "?").join(",")
        conditions.push(`source IN (${placeholders})`)
        params.push(...options.sourceIds)
    }
    
    if (options.unreadOnly) {
        conditions.push("hasRead = 0")
    }
    
    if (options.starredOnly) {
        conditions.push("starred = 1")
    }
    
    if (options.hiddenOnly !== undefined) {
        conditions.push(`hidden = ${options.hiddenOnly ? 1 : 0}`)
    }
    
    if (options.searchTerm) {
        conditions.push("(title LIKE ? OR snippet LIKE ?)")
        const term = `%${options.searchTerm}%`
        params.push(term, term)
    }
    
    if (options.hasServiceRef) {
        conditions.push("serviceRef IS NOT NULL")
    }
    
    let query = "SELECT * FROM items"
    if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ")
    }
    
    const orderBy = options.orderBy || "date"
    const orderDir = options.orderDir || "DESC"
    query += ` ORDER BY ${orderBy} ${orderDir}`
    
    if (options.limit) {
        query += ` LIMIT ${options.limit}`
        if (options.offset) {
            query += ` OFFSET ${options.offset}`
        }
    }
    
    return db.prepare(query).all(...params) as ItemRow[]
}

// ============================================
// P2P PENDING SHARES OPERATIONS
// ============================================

export interface PendingShareRow {
    id: number
    peerId: string
    peerName: string
    url: string
    title: string
    feedName: string | null
    feedUrl: string | null
    feedIconUrl: string | null
    createdAt: string
    attempts: number
    lastAttempt: string | null
}

/**
 * Add a pending share to the queue
 */
export function addPendingShare(
    peerId: string,
    peerName: string,
    url: string,
    title: string,
    feedName?: string,
    feedUrl?: string,
    feedIconUrl?: string
): number {
    if (!db) throw new Error("Database not initialized")
    
    const stmt = db.prepare(`
        INSERT INTO p2p_pending_shares (peerId, peerName, url, title, feedName, feedUrl, feedIconUrl, createdAt, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `)
    
    const result = stmt.run(peerId, peerName, url, title, feedName ?? null, feedUrl ?? null, feedIconUrl ?? null, new Date().toISOString())
    console.log(`[db-sqlite] Added pending share: ${title} for peer ${peerName}`)
    return result.lastInsertRowid as number
}

/**
 * Get all pending shares for a specific peer
 */
export function getPendingSharesForPeer(peerId: string): PendingShareRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM p2p_pending_shares WHERE peerId = ? ORDER BY createdAt ASC").all(peerId) as PendingShareRow[]
}

/**
 * Get all pending shares grouped by peer
 */
export function getAllPendingShares(): PendingShareRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM p2p_pending_shares ORDER BY createdAt ASC").all() as PendingShareRow[]
}

/**
 * Get pending share counts per peer
 */
export function getPendingShareCounts(): Record<string, { count: number, peerName: string }> {
    if (!db) throw new Error("Database not initialized")
    
    const rows = db.prepare(`
        SELECT peerId, peerName, COUNT(*) as count 
        FROM p2p_pending_shares 
        GROUP BY peerId
    `).all() as Array<{ peerId: string, peerName: string, count: number }>
    
    const counts: Record<string, { count: number, peerName: string }> = {}
    for (const row of rows) {
        counts[row.peerId] = { count: row.count, peerName: row.peerName }
    }
    return counts
}

/**
 * Remove a pending share (after successful delivery or manual removal)
 */
export function removePendingShare(id: number): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("DELETE FROM p2p_pending_shares WHERE id = ?").run(id)
    console.log(`[db-sqlite] Removed pending share id: ${id}`)
}

/**
 * Remove all pending shares for a peer
 */
export function removePendingSharesForPeer(peerId: string): number {
    if (!db) throw new Error("Database not initialized")
    const result = db.prepare("DELETE FROM p2p_pending_shares WHERE peerId = ?").run(peerId)
    console.log(`[db-sqlite] Removed ${result.changes} pending shares for peer ${peerId}`)
    return result.changes
}

/**
 * Increment attempt count for a pending share
 */
export function incrementPendingShareAttempts(id: number): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare(`
        UPDATE p2p_pending_shares 
        SET attempts = attempts + 1, lastAttempt = ? 
        WHERE id = ?
    `).run(new Date().toISOString(), id)
}

/**
 * Remove old pending shares (older than X days)
 */
export function removeOldPendingShares(maxAgeDays: number = 7): number {
    if (!db) throw new Error("Database not initialized")
    
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
    
    const result = db.prepare("DELETE FROM p2p_pending_shares WHERE createdAt < ?").run(cutoffDate.toISOString())
    if (result.changes > 0) {
        console.log(`[db-sqlite] Removed ${result.changes} old pending shares (older than ${maxAgeDays} days)`)
    }
    return result.changes
}

// ============================================
// P2P KNOWN PEERS OPERATIONS
// ============================================

export interface KnownPeerRow {
    peerId: string
    peerName: string
    roomCode: string
    lastSeen: string
    createdAt: string
}

/**
 * Add or update a known peer
 */
export function upsertKnownPeer(peerId: string, peerName: string, roomCode: string): void {
    if (!db) throw new Error("Database not initialized")
    
    const now = new Date().toISOString()
    db.prepare(`
        INSERT INTO p2p_known_peers (peerId, peerName, roomCode, lastSeen, createdAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(peerId) DO UPDATE SET
            peerName = excluded.peerName,
            roomCode = excluded.roomCode,
            lastSeen = excluded.lastSeen
    `).run(peerId, peerName, roomCode, now, now)
}

/**
 * Update last seen time for a peer
 */
export function updatePeerLastSeen(peerId: string): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("UPDATE p2p_known_peers SET lastSeen = ? WHERE peerId = ?").run(new Date().toISOString(), peerId)
}

/**
 * Get all known peers for a specific room
 */
export function getKnownPeersForRoom(roomCode: string): KnownPeerRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM p2p_known_peers WHERE roomCode = ? ORDER BY lastSeen DESC").all(roomCode) as KnownPeerRow[]
}

/**
 * Get all known peers
 */
export function getAllKnownPeers(): KnownPeerRow[] {
    if (!db) throw new Error("Database not initialized")
    return db.prepare("SELECT * FROM p2p_known_peers ORDER BY lastSeen DESC").all() as KnownPeerRow[]
}

/**
 * Remove a known peer (and their pending shares)
 */
export function removeKnownPeer(peerId: string): void {
    if (!db) throw new Error("Database not initialized")
    
    // First remove their pending shares
    const sharesRemoved = removePendingSharesForPeer(peerId)
    
    // Then remove the peer
    db.prepare("DELETE FROM p2p_known_peers WHERE peerId = ?").run(peerId)
    console.log(`[db-sqlite] Removed known peer ${peerId} and ${sharesRemoved} pending shares`)
}

/**
 * Remove old peers (not seen in X days) and their pending shares
 */
export function removeOldKnownPeers(maxAgeDays: number = 7): number {
    if (!db) throw new Error("Database not initialized")
    
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)
    const cutoffStr = cutoffDate.toISOString()
    
    // Get peer IDs to remove
    const oldPeers = db.prepare("SELECT peerId FROM p2p_known_peers WHERE lastSeen < ?").all(cutoffStr) as Array<{ peerId: string }>
    
    if (oldPeers.length === 0) return 0
    
    // Remove pending shares for each old peer
    let totalSharesRemoved = 0
    for (const peer of oldPeers) {
        const removed = removePendingSharesForPeer(peer.peerId)
        totalSharesRemoved += removed
    }
    
    // Remove old peers
    const result = db.prepare("DELETE FROM p2p_known_peers WHERE lastSeen < ?").run(cutoffStr)
    
    console.log(`[db-sqlite] Removed ${result.changes} old peers (not seen in ${maxAgeDays} days) and ${totalSharesRemoved} pending shares`)
    return result.changes
}

// ============================================
// UTILITY OPERATIONS
// ============================================

/**
 * Get unread counts for all sources
 */
export function getUnreadCounts(): Record<number, number> {
    if (!db) throw new Error("Database not initialized")
    
    const rows = db.prepare(`
        SELECT source, COUNT(*) as count 
        FROM items 
        WHERE hasRead = 0 
        GROUP BY source
    `).all() as { source: number; count: number }[]
    
    const counts: Record<number, number> = {}
    for (const row of rows) {
        counts[row.source] = row.count
    }
    return counts
}

/**
 * Vacuum the database to reclaim space
 */
export function vacuum(): void {
    if (!db) throw new Error("Database not initialized")
    db.exec("VACUUM")
    console.log("[db-sqlite] Database vacuumed")
}

/**
 * Get database statistics
 */
export function getStats(): { sources: number; items: number; dbSize: string } {
    if (!db) throw new Error("Database not initialized")
    
    const sourcesCount = (db.prepare("SELECT COUNT(*) as count FROM sources").get() as { count: number }).count
    const itemsCount = (db.prepare("SELECT COUNT(*) as count FROM items").get() as { count: number }).count
    
    // Get file size
    const fs = require("fs")
    const dbPath = getDbPath()
    let dbSize = "unknown"
    try {
        const stats = fs.statSync(dbPath)
        const bytes = stats.size
        if (bytes < 1024) dbSize = `${bytes} B`
        else if (bytes < 1024 * 1024) dbSize = `${(bytes / 1024).toFixed(1)} KB`
        else dbSize = `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    } catch (e) {
        // File might not exist yet
    }
    
    return { sources: sourcesCount, items: itemsCount, dbSize }
}

// ============================================
// SERVICE SYNC OPERATIONS
// ============================================

/**
 * Get serviceRef values for unread items in specific sources
 * Used by cloud sync services to sync read status
 */
export function getUnreadServiceRefs(sourceIds: number[], beforeDate?: string, afterDate?: string): string[] {
    if (!db) throw new Error("Database not initialized")
    
    if (sourceIds.length === 0) return []
    
    const placeholders = sourceIds.map(() => '?').join(',')
    let query = `SELECT serviceRef FROM items WHERE hasRead = 0 AND source IN (${placeholders}) AND serviceRef IS NOT NULL`
    const params: (number | string)[] = [...sourceIds]
    
    if (beforeDate) {
        query += ` AND date < ?`
        params.push(beforeDate)
    }
    if (afterDate) {
        query += ` AND date > ?`
        params.push(afterDate)
    }
    
    const rows = db.prepare(query).all(...params) as { serviceRef: string }[]
    return rows.map(r => r.serviceRef)
}

/**
 * Mark items as read by their serviceRef
 */
export function markReadByServiceRef(serviceRef: string): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("UPDATE items SET hasRead = 1 WHERE serviceRef = ?").run(serviceRef)
}

/**
 * Mark items as unread by their serviceRef
 */
export function markUnreadByServiceRef(serviceRef: string): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("UPDATE items SET hasRead = 0 WHERE serviceRef = ?").run(serviceRef)
}

/**
 * Set starred status by serviceRef
 */
export function setStarredByServiceRef(serviceRef: string, starred: boolean): void {
    if (!db) throw new Error("Database not initialized")
    db.prepare("UPDATE items SET starred = ? WHERE serviceRef = ?").run(starred ? 1 : 0, serviceRef)
}

/**
 * Delete items older than a specific date
 * Excludes starred items to preserve user favorites
 */
export function deleteOlderThan(date: string): number {
    if (!db) throw new Error("Database not initialized")
    const result = db.prepare("DELETE FROM items WHERE date < ? AND starred = 0").run(date)
    console.log(`[db-sqlite] Deleted ${result.changes} items older than ${date}`)
    return result.changes
}

/**
 * Get all items for sync purposes (export/migration)
 * Returns raw item data
 */
export function getItemsForSync(): ItemRow[] {
    if (!db) throw new Error("Database not initialized")
    const rows = db.prepare("SELECT * FROM items").all() as ItemRow[]
    return rows
}

/**
 * Clear all data from the database
 * Used during import to start fresh
 */
export function clearAll(): void {
    if (!db) throw new Error("Database not initialized")
    
    db.exec(`
        DELETE FROM items;
        DELETE FROM sources;
        DELETE FROM p2p_pending_shares;
    `)
    
    console.log("[db-sqlite] Cleared all data from database")
}

// ============================================
// IPC HANDLER SETUP
// ============================================

/**
 * Set up IPC handlers for database operations
 * Call this from window.ts after app is ready
 */
export function setupDatabaseIPC(): void {
    // Initialize
    ipcMain.handle("db:init", () => {
        initDatabase()
        return true
    })

    // Source operations
    ipcMain.handle("db:sources:getAll", () => getAllSources())
    ipcMain.handle("db:sources:getById", (_, sid: number) => getSourceById(sid))
    ipcMain.handle("db:sources:getByUrl", (_, url: string) => getSourceByUrl(url))
    ipcMain.handle("db:sources:insert", (_, source) => insertSource(source))
    ipcMain.handle("db:sources:update", (_, sid: number, updates) => updateSource(sid, updates))
    ipcMain.handle("db:sources:delete", (_, sid: number) => deleteSource(sid))
    ipcMain.handle("db:sources:getNextId", () => getNextSourceId())
    ipcMain.handle("db:sources:deleteAll", () => deleteAllSources())
    ipcMain.handle("db:sources:bulkInsert", (_, sources) => bulkInsertSources(sources))

    // Item operations
    ipcMain.handle("db:items:getAll", () => getAllItems())
    ipcMain.handle("db:items:getById", (_, id: number) => getItemById(id))
    ipcMain.handle("db:items:getBySource", (_, sourceId: number, limit?: number, offset?: number) => 
        getItemsBySource(sourceId, limit, offset))
    ipcMain.handle("db:items:getCount", (_, sourceId?: number, unreadOnly?: boolean) => 
        getItemsCount(sourceId, unreadOnly))
    ipcMain.handle("db:items:insert", (_, item) => insertItem(item))
    ipcMain.handle("db:items:insertMany", (_, items) => insertItems(items))
    ipcMain.handle("db:items:update", (_, id: number, updates) => updateItem(id, updates))
    ipcMain.handle("db:items:delete", (_, id: number) => deleteItem(id))
    ipcMain.handle("db:items:deleteBySource", (_, sourceId: number) => deleteItemsBySource(sourceId))
    ipcMain.handle("db:items:deleteAll", () => deleteAllItems())
    ipcMain.handle("db:items:bulkInsert", (_, items) => bulkInsertItems(items))
    ipcMain.handle("db:items:markRead", (_, id: number, hasRead?: boolean) => markItemRead(id, hasRead))
    ipcMain.handle("db:items:markAllRead", (_, sourceIds: number[], beforeDate?: string) => 
        markAllRead(sourceIds, beforeDate))
    ipcMain.handle("db:items:toggleStarred", (_, id: number) => toggleStarred(id))
    ipcMain.handle("db:items:toggleHidden", (_, id: number) => toggleHidden(id))
    ipcMain.handle("db:items:exists", (_, sourceId: number, title: string, date: string) => 
        itemExists(sourceId, title, date))
    ipcMain.handle("db:items:query", (_, options: ItemQueryOptions) => queryItems(options))

    // Utility operations
    ipcMain.handle("db:getUnreadCounts", () => getUnreadCounts())
    ipcMain.handle("db:vacuum", () => vacuum())
    ipcMain.handle("db:getStats", () => getStats())

    // Service sync operations
    ipcMain.handle("db:items:getUnreadServiceRefs", (_, sourceIds: number[], beforeDate?: string, afterDate?: string) =>
        getUnreadServiceRefs(sourceIds, beforeDate, afterDate))
    ipcMain.handle("db:items:markReadByServiceRef", (_, serviceRef: string) => markReadByServiceRef(serviceRef))
    ipcMain.handle("db:items:markUnreadByServiceRef", (_, serviceRef: string) => markUnreadByServiceRef(serviceRef))
    ipcMain.handle("db:items:setStarredByServiceRef", (_, serviceRef: string, starred: boolean) => 
        setStarredByServiceRef(serviceRef, starred))
    ipcMain.handle("db:items:deleteOlderThan", (_, date: string) => deleteOlderThan(date))
    ipcMain.handle("db:items:getForSync", () => getItemsForSync())
    ipcMain.handle("db:clearAll", () => clearAll())

    // P2P Pending Shares operations
    ipcMain.handle("db:pendingShares:add", (_, peerId: string, peerName: string, url: string, title: string, feedName?: string) => 
        addPendingShare(peerId, peerName, url, title, feedName))
    ipcMain.handle("db:pendingShares:getForPeer", (_, peerId: string) => getPendingSharesForPeer(peerId))
    ipcMain.handle("db:pendingShares:getAll", () => getAllPendingShares())
    ipcMain.handle("db:pendingShares:getCounts", () => getPendingShareCounts())
    ipcMain.handle("db:pendingShares:remove", (_, id: number) => removePendingShare(id))
    ipcMain.handle("db:pendingShares:removeForPeer", (_, peerId: string) => removePendingSharesForPeer(peerId))
    ipcMain.handle("db:pendingShares:incrementAttempts", (_, id: number) => incrementPendingShareAttempts(id))
    ipcMain.handle("db:pendingShares:removeOld", (_, maxAgeDays?: number) => removeOldPendingShares(maxAgeDays))

    // P2P Shared Feeds operations
    ipcMain.handle("db:p2pFeeds:getOrCreate", (_, feedUrl: string, feedName: string, feedIconUrl?: string, openTarget?: number, defaultZoom?: number) =>
        getOrCreateP2PFeed(feedUrl, feedName, feedIconUrl, openTarget, defaultZoom))
    ipcMain.handle("db:p2pFeeds:getAll", () => getP2PSharedFeeds())
    ipcMain.handle("db:p2pFeeds:convertToActive", (_, sid: number) => convertP2PFeedToActive(sid))

    console.log("[db-sqlite] IPC handlers registered")
}
