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
type ArticleCallback = (data: { peerId: string; peerName: string; url: string; title: string; timestamp: number }) => void
type EchoCallback = (data: { peerId: string; originalTimestamp: number; returnedAt: number; roundTripMs: number }) => void
type PeerDisconnectedCallback = (data: { peerId: string; displayName: string; reason: string }) => void

// Use Maps with unique IDs so components can unsubscribe individually
let nextCallbackId = 0
const connectionCallbacks = new Map<number, ConnectionCallback>()
const articleCallbacks = new Map<number, ArticleCallback>()
const echoCallbacks = new Map<number, EchoCallback>()
const peerDisconnectedCallbacks = new Map<number, PeerDisconnectedCallback>()

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
     * Send an article link with delivery acknowledgement to a specific peer
     */
    sendArticleLinkWithAck: (peerId: string, title: string, url: string, feedName?: string): Promise<{ success: boolean, error?: string }> =>
        ipcRenderer.invoke("p2p-lan:sendArticleLinkWithAck", peerId, title, url, feedName),
    
    /**
     * Broadcast an article link to all peers with delivery acknowledgement
     */
    broadcastArticleLinkWithAck: (title: string, url: string, feedName?: string): Promise<Record<string, { success: boolean, error?: string }>> =>
        ipcRenderer.invoke("p2p-lan:broadcastArticleLinkWithAck", title, url, feedName),
    
    /**
     * Send an echo request to test connection latency
     */
    sendEcho: (peerId: string): Promise<boolean> =>
        ipcRenderer.invoke("p2p-lan:sendEcho", peerId),
    
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
     * Remove all event callbacks (use sparingly - prefer individual unsubscribe)
     */
    removeAllListeners: () => {
        connectionCallbacks.clear()
        articleCallbacks.clear()
        echoCallbacks.clear()
        peerDisconnectedCallbacks.clear()
        console.log("[P2P-LAN Bridge] All callbacks removed")
    }
}

export type P2PLanBridge = typeof p2pLanBridge
