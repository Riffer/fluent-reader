/**
 * P2P Bridge - IPC interface for renderer process
 * 
 * Exposes P2P functionality to the renderer via window.p2p
 * 
 * Note: Peer management goes through IPC to Main Process.
 * WebRTC connections are handled directly in Renderer via p2p-connection.ts
 */
import { ipcRenderer } from "electron"

// Type definitions
export interface KnownPeer {
    id: string
    displayName: string
    peerHash: string
    sharedSecret: string
    createdAt: number
    lastSeen: number
}

export interface P2PConfig {
    enabled: boolean
    receiveMode: "ask" | "allow" | "deny"
    defaultOpenAction: "article" | "browser" | "copy"
}

export interface ShareMessage {
    type: "article-link" | "echo-request" | "echo-response"
    senderHash: string
    senderName: string
    timestamp: number
    url?: string
    title?: string
    echoData?: any
}

export interface ConnectionInfo {
    peerHash: string
    displayName: string
    connected: boolean
    isInitiator?: boolean
}

export const p2pBridge = {
    // =========================================================================
    // Config & Peer Management (via IPC to Main Process)
    // =========================================================================
    
    // Config
    getConfig: (): Promise<P2PConfig> => ipcRenderer.invoke("p2p:getConfig"),
    setConfig: (config: Partial<P2PConfig>): Promise<P2PConfig> => 
        ipcRenderer.invoke("p2p:setConfig", config),
    
    // Peers
    getPeers: (): Promise<KnownPeer[]> => ipcRenderer.invoke("p2p:getPeers"),
    addPeer: (peer: KnownPeer): Promise<KnownPeer[]> => 
        ipcRenderer.invoke("p2p:addPeer", peer),
    removePeer: (peerHash: string): Promise<KnownPeer[]> => 
        ipcRenderer.invoke("p2p:removePeer", peerHash),
    updatePeerLastSeen: (peerHash: string): Promise<void> =>
        ipcRenderer.invoke("p2p:updatePeerLastSeen", peerHash),
    
    // Crypto utilities (in Main Process for security)
    generateRoomCode: (): Promise<string> => ipcRenderer.invoke("p2p:generateRoomCode"),
    generatePeerId: (): Promise<string> => ipcRenderer.invoke("p2p:generatePeerId"),
    generatePeerHash: (secret: string, peerId: string): Promise<string> => 
        ipcRenderer.invoke("p2p:generatePeerHash", secret, peerId),
    
    // Validation
    isValidUrl: (url: string): Promise<boolean> => ipcRenderer.invoke("p2p:isValidUrl", url),
    
    // =========================================================================
    // Note: WebRTC connections are managed directly in Renderer process
    // using p2pConnectionManager from scripts/p2p-connection.ts
    // Import and use that module directly in components
    // =========================================================================
}

export type P2PBridge = typeof p2pBridge
