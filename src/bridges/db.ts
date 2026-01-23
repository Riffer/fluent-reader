/**
 * Database Bridge (Preload Context)
 * 
 * Provides type-safe access to SQLite database operations via IPC.
 * This bridge is exposed to the Renderer process as window.db
 */

import { ipcRenderer } from "electron"

// Types matching db-sqlite.ts
export interface SourceRow {
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

export interface ItemRow {
    _id: number
    source: number
    title: string
    link: string
    date: string
    fetchedDate: string
    thumb: string | null
    content: string
    snippet: string
    creator: string | null
    hasRead: number
    starred: number
    hidden: number
    notify: number
    serviceRef: string | null
}

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

export interface DbStats {
    sources: number
    items: number
    dbSize: string
}

/**
 * Database bridge for Renderer process
 */
const dbBridge = {
    // Initialize database
    init: (): Promise<boolean> => ipcRenderer.invoke("db:init"),

    // Source operations
    sources: {
        getAll: (): Promise<SourceRow[]> => 
            ipcRenderer.invoke("db:sources:getAll"),
        
        getAllSids: (): Promise<number[]> => 
            ipcRenderer.invoke("db:sources:getAllSids"),
        
        getById: (sid: number): Promise<SourceRow | undefined> => 
            ipcRenderer.invoke("db:sources:getById", sid),
        
        getByUrl: (url: string): Promise<SourceRow | undefined> => 
            ipcRenderer.invoke("db:sources:getByUrl", url),
        
        insert: (source: Omit<SourceRow, "sid"> & { sid?: number }): Promise<number> => 
            ipcRenderer.invoke("db:sources:insert", source),
        
        update: (sid: number, updates: Partial<SourceRow>): Promise<void> => 
            ipcRenderer.invoke("db:sources:update", sid, updates),
        
        delete: (sid: number): Promise<void> => 
            ipcRenderer.invoke("db:sources:delete", sid),
        
        getNextId: (): Promise<number> => 
            ipcRenderer.invoke("db:sources:getNextId"),
        
        deleteAll: (): Promise<void> =>
            ipcRenderer.invoke("db:sources:deleteAll"),
        
        bulkInsert: (sources: SourceRow[]): Promise<number[]> =>
            ipcRenderer.invoke("db:sources:bulkInsert", sources),
    },

    // Item operations
    items: {
        getAll: (): Promise<ItemRow[]> => 
            ipcRenderer.invoke("db:items:getAll"),
        
        getById: (id: number): Promise<ItemRow | undefined> => 
            ipcRenderer.invoke("db:items:getById", id),
        
        getBySource: (sourceId: number, limit?: number, offset?: number): Promise<ItemRow[]> => 
            ipcRenderer.invoke("db:items:getBySource", sourceId, limit, offset),
        
        getCount: (sourceId?: number, unreadOnly?: boolean): Promise<number> => 
            ipcRenderer.invoke("db:items:getCount", sourceId, unreadOnly),
        
        insert: (item: Omit<ItemRow, "_id">): Promise<number> => 
            ipcRenderer.invoke("db:items:insert", item),
        
        insertMany: (items: Omit<ItemRow, "_id">[]): Promise<number[]> => 
            ipcRenderer.invoke("db:items:insertMany", items),
        
        update: (id: number, updates: Partial<ItemRow>): Promise<void> => 
            ipcRenderer.invoke("db:items:update", id, updates),
        
        delete: (id: number): Promise<void> => 
            ipcRenderer.invoke("db:items:delete", id),
        
        deleteBySource: (sourceId: number): Promise<void> => 
            ipcRenderer.invoke("db:items:deleteBySource", sourceId),
        
        markRead: (id: number, hasRead?: boolean): Promise<void> => 
            ipcRenderer.invoke("db:items:markRead", id, hasRead),
        
        markAllRead: (sourceIds: number[], beforeDate?: string): Promise<void> => 
            ipcRenderer.invoke("db:items:markAllRead", sourceIds, beforeDate),
        
        toggleStarred: (id: number): Promise<boolean> => 
            ipcRenderer.invoke("db:items:toggleStarred", id),
        
        toggleHidden: (id: number): Promise<boolean> => 
            ipcRenderer.invoke("db:items:toggleHidden", id),
        
        exists: (sourceId: number, title: string, date: string): Promise<boolean> => 
            ipcRenderer.invoke("db:items:exists", sourceId, title, date),
        
        query: (options?: ItemQueryOptions): Promise<ItemRow[]> => 
            ipcRenderer.invoke("db:items:query", options || {}),
        
        // Service sync operations (for cloud service integration)
        getUnreadServiceRefs: (sourceIds: number[], beforeDate?: string, afterDate?: string): Promise<string[]> =>
            ipcRenderer.invoke("db:items:getUnreadServiceRefs", sourceIds, beforeDate, afterDate),
        
        markReadByServiceRef: (serviceRef: string): Promise<void> =>
            ipcRenderer.invoke("db:items:markReadByServiceRef", serviceRef),
        
        markUnreadByServiceRef: (serviceRef: string): Promise<void> =>
            ipcRenderer.invoke("db:items:markUnreadByServiceRef", serviceRef),
        
        setStarredByServiceRef: (serviceRef: string, starred: boolean): Promise<void> =>
            ipcRenderer.invoke("db:items:setStarredByServiceRef", serviceRef, starred),
        
        deleteOlderThan: (date: string): Promise<number> =>
            ipcRenderer.invoke("db:items:deleteOlderThan", date),
        
        getForSync: (): Promise<ItemRow[]> =>
            ipcRenderer.invoke("db:items:getForSync"),
        
        deleteAll: (): Promise<void> =>
            ipcRenderer.invoke("db:items:deleteAll"),
        
        bulkInsert: (items: ItemRow[]): Promise<number[]> =>
            ipcRenderer.invoke("db:items:bulkInsert", items),
    },

    // P2P Feed operations
    p2pFeeds: {
        convertToActive: (sid: number): Promise<void> =>
            ipcRenderer.invoke("db:p2pFeeds:convertToActive", sid),
    },

    // Utility operations
    getUnreadCounts: (): Promise<Record<number, number>> => 
        ipcRenderer.invoke("db:getUnreadCounts"),
    
    vacuum: (): Promise<void> => 
        ipcRenderer.invoke("db:vacuum"),
    
    getStats: (): Promise<DbStats> => 
        ipcRenderer.invoke("db:getStats"),
    
    // Database management
    clearAll: (): Promise<void> =>
        ipcRenderer.invoke("db:clearAll"),
}

export default dbBridge

// Type for window.db
export type DbBridge = typeof dbBridge
