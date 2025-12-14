/**
 * P2P LAN Bridge - IPC interface for renderer process
 * 
 * Simple LAN-based peer-to-peer communication.
 * No WebRTC, no manual signaling - just room codes!
 * 
 * NOTE: Due to contextBridge limitations, event listeners are registered
 * once at startup and callbacks are stored internally.
 */
import { ipcRenderer } from "electron"

export interface P2PMessage {
    type: "article-link" | "echo-request" | "echo-response"
    senderName: string
    timestamp: number
    url?: string
    title?: string
    echoData?: any
}

export interface P2PPeer {
    peerId: string
    displayName: string
    connected: boolean
}

export interface P2PStatus {
    inRoom: boolean
    roomCode: string | null
    peers: P2PPeer[]
}

// Internal callback storage (contextBridge can't pass functions directly)
type ConnectionCallback = (status: P2PStatus) => void
type ArticleCallback = (data: { 
    peerId: string
    peerName: string
    url: string
    title: string
    timestamp: number
    feedName?: string
    feedUrl?: string
    feedIconUrl?: string
    storedInFeed?: boolean
    articleId?: number
    sourceId?: number
}) => void
type ArticleBatchCallback = (data: {
    peerId: string
    peerName: string
    count: number
    articles: Array<{
        url: string
        title: string
        timestamp: number
        feedName?: string
        feedUrl?: string
        feedIconUrl?: string
    }>
}) => void
type EchoCallback = (data: { peerId: string; originalTimestamp: number; returnedAt: number; roundTripMs: number }) => void
type PeerDisconnectedCallback = (data: { peerId: string; displayName: string; reason: string }) => void
type PendingSharesCallback = (counts: Record<string, { count: number; peerName: string }>) => void

// P2P Feeds Changed callback - called when new feeds/articles are stored in SQLite
export interface P2PFeedsChangedData {
    newFeedIds: number[]
    newFeeds: Array<{
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
    }>
    newArticles: Array<{
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
    }>
    groupsUpdated: boolean
    groups: any[] | null  // SourceGroup[] from settings
}
type FeedsChangedCallback = (data: P2PFeedsChangedData) => void

// Use Maps with unique IDs so components can unsubscribe individually
let nextCallbackId = 0
const connectionCallbacks = new Map<number, ConnectionCallback>()
const articleCallbacks = new Map<number, ArticleCallback>()
const articleBatchCallbacks = new Map<number, ArticleBatchCallback>()
const echoCallbacks = new Map<number, EchoCallback>()
const peerDisconnectedCallbacks = new Map<number, PeerDisconnectedCallback>()
const pendingSharesCallbacks = new Map<number, PendingSharesCallback>()
const feedsChangedCallbacks = new Map<number, FeedsChangedCallback>()

// Register IPC listeners once at module load
ipcRenderer.on("p2p:connectionStateChanged", (_, status: P2PStatus) => {
    console.log("[P2P-LAN Bridge] Connection state changed:", status, "callbacks:", connectionCallbacks.size)
    connectionCallbacks.forEach((cb, id) => {
        try { cb(status) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

ipcRenderer.on("p2p:articleReceived", (_, data) => {
    console.log("[P2P-LAN Bridge] Article received:", data, "callbacks:", articleCallbacks.size)
    articleCallbacks.forEach((cb, id) => {
        try { cb(data) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

ipcRenderer.on("p2p:echoResponse", (_, data) => {
    console.log("[P2P-LAN Bridge] Echo response:", data, "callbacks:", echoCallbacks.size)
    echoCallbacks.forEach((cb, id) => {
        try { cb(data) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

ipcRenderer.on("p2p:peerDisconnected", (_, data) => {
    console.log("[P2P-LAN Bridge] Peer disconnected:", data, "callbacks:", peerDisconnectedCallbacks.size)
    peerDisconnectedCallbacks.forEach((cb, id) => {
        try { cb(data) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

ipcRenderer.on("p2p:pendingSharesChanged", (_, counts) => {
    console.log("[P2P-LAN Bridge] Pending shares changed:", counts, "callbacks:", pendingSharesCallbacks.size)
    pendingSharesCallbacks.forEach((cb, id) => {
        try { cb(counts) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

ipcRenderer.on("p2p:articlesReceivedBatch", (_, data) => {
    console.log("[P2P-LAN Bridge] Articles batch received:", data, "callbacks:", articleBatchCallbacks.size)
    articleBatchCallbacks.forEach((cb, id) => {
        try { cb(data) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

ipcRenderer.on("p2p:feedsChanged", (_, data: P2PFeedsChangedData) => {
    console.log("[P2P-LAN Bridge] P2P feeds changed:", data.newFeedIds.length, "feeds,", data.newArticles.length, "articles, callbacks:", feedsChangedCallbacks.size)
    feedsChangedCallbacks.forEach((cb, id) => {
        try { cb(data) } catch (e) { console.error("[P2P-LAN Bridge] Callback error:", e) }
    })
})

export const p2pLanBridge = {
    /**
     * Join a room with the given code and display name
     * Other peers in the same room on the same network will be discovered automatically
     */
    joinRoom: (roomCode: string, displayName: string): Promise<boolean> =>
        ipcRenderer.invoke("p2p-lan:joinRoom", roomCode, displayName),
    
    /**
     * Leave the current room and disconnect from all peers
     */
    leaveRoom: (): Promise<void> =>
        ipcRenderer.invoke("p2p-lan:leaveRoom"),
    
    /**
     * Get current P2P status (room info and connected peers)
     */
    getStatus: (): Promise<P2PStatus> =>
        ipcRenderer.invoke("p2p-lan:getStatus"),
    
    /**
     * Send a message to all connected peers
     */
    broadcast: (message: P2PMessage): Promise<number> =>
        ipcRenderer.invoke("p2p-lan:broadcast", message),
    
    /**
     * Send a message to a specific peer
     */
    sendToPeer: (peerId: string, message: P2PMessage): Promise<boolean> =>
        ipcRenderer.invoke("p2p-lan:sendToPeer", peerId, message),
    
    /**
     * Send articles with delivery acknowledgement to a specific peer
     * Always uses array format - single article is just an array with 1 element
     */
    sendArticlesWithAck: (peerId: string, articles: Array<{ url: string, title: string, feedName?: string, feedUrl?: string, feedIconUrl?: string, openTarget?: number, defaultZoom?: number }>): Promise<{ success: boolean, error?: string }> =>
        ipcRenderer.invoke("p2p-lan:sendArticlesWithAck", peerId, articles),
    
    /**
     * Broadcast articles to all peers with delivery acknowledgement
     */
    broadcastArticlesWithAck: (articles: Array<{ url: string, title: string, feedName?: string, feedUrl?: string, feedIconUrl?: string, openTarget?: number, defaultZoom?: number }>): Promise<Record<string, { success: boolean, error?: string }>> =>
        ipcRenderer.invoke("p2p-lan:broadcastArticlesWithAck", articles),
    
    /**
     * Send an article link with automatic queueing if delivery fails
     */
    sendArticleLinkWithQueue: (peerId: string, title: string, url: string, feedName?: string, feedUrl?: string, feedIconUrl?: string): Promise<{ success: boolean, queued: boolean, error?: string }> =>
        ipcRenderer.invoke("p2p-lan:sendArticleLinkWithQueue", peerId, title, url, feedName, feedUrl, feedIconUrl),
    
    /**
     * Send an echo request to test connection latency
     */
    sendEcho: (peerId: string): Promise<boolean> =>
        ipcRenderer.invoke("p2p-lan:sendEcho", peerId),
    
    // =========================================================================
    // Pending Shares Queue
    // =========================================================================
    
    /**
     * Get pending share counts per peer
     */
    getPendingShareCounts: (): Promise<Record<string, { count: number; peerName: string }>> =>
        ipcRenderer.invoke("p2p-lan:getPendingShareCounts"),
    
    /**
     * Get all pending shares
     */
    getAllPendingShares: (): Promise<Array<{
        id: number
        peerId: string
        peerName: string
        url: string
        title: string
        feedName: string | null
        createdAt: string
        attempts: number
        lastAttempt: string | null
    }>> =>
        ipcRenderer.invoke("p2p-lan:getAllPendingShares"),
    
    /**
     * Remove a pending share from the queue
     */
    removePendingShare: (id: number): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke("p2p-lan:removePendingShare", id),
    
    /**
     * Clear old pending shares (older than maxAgeDays, default 7)
     */
    clearOldPendingShares: (maxAgeDays?: number): Promise<{ success: boolean; removed?: number; error?: string }> =>
        ipcRenderer.invoke("p2p-lan:clearOldPendingShares", maxAgeDays),
    
    /**
     * Share an article link with all connected peers
     */
    shareArticle: (url: string, title: string): Promise<number> =>
        ipcRenderer.invoke("p2p-lan:broadcast", {
            type: "article-link",
            senderName: "Fluent Reader",
            timestamp: Date.now(),
            url,
            title
        }),
    
    // =========================================================================
    // Event Listeners - Returns unsubscribe function for cleanup
    // =========================================================================
    
    /**
     * Called when connection state changes (peers join/leave)
     * Returns an unsubscribe function
     */
    onConnectionStateChanged: (callback: ConnectionCallback): (() => void) => {
        const id = nextCallbackId++
        connectionCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Connection callback registered, id:", id, "total:", connectionCallbacks.size)
        return () => {
            connectionCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Connection callback removed, id:", id, "total:", connectionCallbacks.size)
        }
    },
    
    /**
     * Called when an article link is received from a peer
     * Returns an unsubscribe function
     */
    onArticleReceived: (callback: ArticleCallback): (() => void) => {
        const id = nextCallbackId++
        articleCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Article callback registered, id:", id, "total:", articleCallbacks.size)
        return () => {
            articleCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Article callback removed, id:", id, "total:", articleCallbacks.size)
        }
    },
    
    /**
     * Called when multiple articles are received at once (e.g., from pending queue)
     * These should go directly to notification bell without showing individual dialogs
     * Returns an unsubscribe function
     */
    onArticlesReceivedBatch: (callback: ArticleBatchCallback): (() => void) => {
        const id = nextCallbackId++
        articleBatchCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Article batch callback registered, id:", id, "total:", articleBatchCallbacks.size)
        return () => {
            articleBatchCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Article batch callback removed, id:", id, "total:", articleBatchCallbacks.size)
        }
    },
    
    /**
     * Called when an echo response is received
     * Returns an unsubscribe function
     */
    onEchoResponse: (callback: EchoCallback): (() => void) => {
        const id = nextCallbackId++
        echoCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Echo callback registered, id:", id, "total:", echoCallbacks.size)
        return () => {
            echoCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Echo callback removed, id:", id, "total:", echoCallbacks.size)
        }
    },
    
    /**
     * Called when a peer disconnects (timeout, error, etc.)
     * Returns an unsubscribe function
     */
    onPeerDisconnected: (callback: PeerDisconnectedCallback): (() => void) => {
        const id = nextCallbackId++
        peerDisconnectedCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Peer disconnected callback registered, id:", id, "total:", peerDisconnectedCallbacks.size)
        return () => {
            peerDisconnectedCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Peer disconnected callback removed, id:", id, "total:", peerDisconnectedCallbacks.size)
        }
    },
    
    /**
     * Called when pending shares queue changes (share queued, sent, or removed)
     * Returns an unsubscribe function
     */
    onPendingSharesChanged: (callback: PendingSharesCallback): (() => void) => {
        const id = nextCallbackId++
        pendingSharesCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Pending shares callback registered, id:", id, "total:", pendingSharesCallbacks.size)
        return () => {
            pendingSharesCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Pending shares callback removed, id:", id, "total:", pendingSharesCallbacks.size)
        }
    },
    
    /**
     * Called when P2P feeds/articles are stored in SQLite database.
     * This is the signal to update Redux state with new sources and items.
     * Returns an unsubscribe function
     */
    onFeedsChanged: (callback: FeedsChangedCallback): (() => void) => {
        const id = nextCallbackId++
        feedsChangedCallbacks.set(id, callback)
        console.log("[P2P-LAN Bridge] Feeds changed callback registered, id:", id, "total:", feedsChangedCallbacks.size)
        return () => {
            feedsChangedCallbacks.delete(id)
            console.log("[P2P-LAN Bridge] Feeds changed callback removed, id:", id, "total:", feedsChangedCallbacks.size)
        }
    },
    
    /**
     * Remove all event callbacks (use sparingly - prefer individual unsubscribe)
     */
    removeAllListeners: () => {
        connectionCallbacks.clear()
        articleCallbacks.clear()
        articleBatchCallbacks.clear()
        echoCallbacks.clear()
        peerDisconnectedCallbacks.clear()
        pendingSharesCallbacks.clear()
        feedsChangedCallbacks.clear()
        console.log("[P2P-LAN Bridge] All callbacks removed")
    }
}

export type P2PLanBridge = typeof p2pLanBridge
