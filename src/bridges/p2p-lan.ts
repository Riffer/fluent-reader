/**
 * P2P LAN Bridge - IPC interface for renderer process
 * 
 * Simple LAN-based peer-to-peer communication.
 * No WebRTC, no manual signaling - just room codes!
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
    // Event Listeners
    // =========================================================================
    
    /**
     * Called when connection state changes (peers join/leave)
     */
    onConnectionStateChanged: (callback: (status: P2PStatus) => void) => {
        ipcRenderer.on("p2p:connectionStateChanged", (_, status) => callback(status))
    },
    
    /**
     * Called when an article link is received from a peer
     */
    onArticleReceived: (callback: (data: {
        peerId: string
        peerName: string
        url: string
        title: string
        timestamp: number
    }) => void) => {
        ipcRenderer.on("p2p:articleReceived", (_, data) => callback(data))
    },
    
    /**
     * Called when an echo response is received
     */
    onEchoResponse: (callback: (data: {
        peerId: string
        originalTimestamp: number
        returnedAt: number
        roundTripMs: number
    }) => void) => {
        ipcRenderer.on("p2p:echoResponse", (_, data) => callback(data))
    },
    
    /**
     * Remove all event listeners
     */
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners("p2p:connectionStateChanged")
        ipcRenderer.removeAllListeners("p2p:articleReceived")
        ipcRenderer.removeAllListeners("p2p:echoResponse")
    }
}

export type P2PLanBridge = typeof p2pLanBridge
