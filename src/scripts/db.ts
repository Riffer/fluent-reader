/**
 * ============================================================================
 * SQLite Database Initialization
 * ============================================================================
 * 
 * This module provides database initialization for the Fluent Reader app.
 * All database operations use SQLite via the window.db.* bridge.
 * 
 * ARCHITECTURE:
 * - SQLite database is managed in Main Process (src/main/db-sqlite.ts)
 * - Renderer accesses DB via IPC bridge (window.db.*)
 * - Type definitions in src/bridges/db.ts
 * 
 * HISTORY:
 * - Originally used NeDB (file-based)
 * - Then Lovefield (IndexedDB wrapper)
 * - Now SQLite only (better-sqlite3 in Main Process)
 * 
 * ============================================================================
 */

/**
 * Initialize the database
 * This calls the SQLite initialization in Main Process via IPC
 */
export async function init(): Promise<void> {
    console.log("[db] Initializing SQLite database...")
    await window.db.init()
    console.log("[db] SQLite database initialized")
}


