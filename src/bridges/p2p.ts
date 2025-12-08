/**
 * P2P Bridge - IPC interface for renderer process
 * 
 * Exposes P2P functionality to the renderer via window.p2p
 */
import { ipcRenderer } from "electron"

// Re-export types from main process (copied here to avoid cross-module issues)
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

export const p2pBridge = {
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
    
    // Crypto utilities
    generateRoomCode: (): Promise<string> => ipcRenderer.invoke("p2p:generateRoomCode"),
    generatePeerId: (): Promise<string> => ipcRenderer.invoke("p2p:generatePeerId"),
    generatePeerHash: (secret: string, peerId: string): Promise<string> => 
        ipcRenderer.invoke("p2p:generatePeerHash", secret, peerId),
    
    // Validation
    isValidUrl: (url: string): Promise<boolean> => ipcRenderer.invoke("p2p:isValidUrl", url),
    
    // Event listeners for incoming messages
    onShareReceived: (callback: (message: ShareMessage) => void) => {
        ipcRenderer.on("p2p:shareReceived", (_, message) => callback(message))
    },
    
    onEchoReceived: (callback: (message: ShareMessage) => void) => {
        ipcRenderer.on("p2p:echoReceived", (_, message) => callback(message))
    },
    
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners("p2p:shareReceived")
        ipcRenderer.removeAllListeners("p2p:echoReceived")
    }
}

export type P2PBridge = typeof p2pBridge
