/**
 * P2P LAN Module - Main Process
 * 
 * Handles peer discovery via UDP broadcast and direct TCP connections
 * for article link sharing within a local network.
 */
import { ipcMain, BrowserWindow } from "electron"
import * as dgram from "dgram"
import * as net from "net"
import * as crypto from "crypto"
import { getKnownPeers, addPeer, updatePeerLastSeen, KnownPeer, generatePeerHash } from "./p2p-share"
import { getStoredP2PRoom, setStoredP2PRoom, clearStoredP2PRoom, getStoredP2PPeerId, setStoredP2PPeerId } from "./settings"
import { 
    addPendingShare, 
    getPendingSharesForPeer, 
    removePendingShare, 
    incrementPendingShareAttempts,
    getPendingShareCounts,
    getAllPendingShares,
    removeOldPendingShares,
    PendingShareRow
} from "./db-sqlite"

// Constants
const DISCOVERY_PORT = 41899  // UDP port for broadcast
const TCP_PORT_START = 41900  // TCP port range start
const TCP_PORT_END = 41999    // TCP port range end
const BROADCAST_INTERVAL = 5000  // ms between broadcasts (5 seconds)
const PEER_TIMEOUT = 15000    // ms before peer considered offline
const HEARTBEAT_INTERVAL = 10000 // ms between heartbeats (10 seconds)
const HEARTBEAT_TIMEOUT = 30000  // ms before peer considered dead (30 seconds)
const ACK_TIMEOUT = 5000      // ms to wait for delivery acknowledgement

/**
 * Generate a unique message ID for ACK tracking
 */
function generateMessageId(): string {
    return crypto.randomBytes(8).toString("hex") + "-" + Date.now().toString(36)
}

// Message types
interface DiscoveryMessage {
    type: "discovery" | "discovery-response"
    roomCode: string
    peerId: string
    displayName: string
    tcpPort: number
    timestamp: number
}

interface P2PMessage {
    type: "article-link-batch" | "article-ack" | "heartbeat" | "heartbeat-ack" | "echo-request" | "echo-response" | "goodbye"
    messageId?: string
    senderName: string
    timestamp: number
    url?: string
    title?: string
    feedName?: string
    feedUrl?: string
    feedIconUrl?: string
    // For batch messages (always used now)
    articles?: Array<{
        url: string
        title: string
        feedName?: string
        feedUrl?: string
        feedIconUrl?: string
    }>
    echoData?: any
}

// State
let udpSocket: dgram.Socket | null = null
let tcpServer: net.Server | null = null
let tcpPort: number = 0
let activeRoomCode: string | null = null
let localPeerId: string = ""
let localDisplayName: string = "Fluent Reader"
let broadcastInterval: NodeJS.Timeout | null = null
let heartbeatInterval: NodeJS.Timeout | null = null

// Connected peers (TCP sockets)
const connectedPeers = new Map<string, {
    socket: net.Socket
    displayName: string
    lastSeen: number
    lastHeartbeat: number
}>()

// Discovered peers (seen via UDP but not yet connected)
const discoveredPeers = new Map<string, {
    displayName: string
    address: string
    tcpPort: number
    lastSeen: number
}>()

// Pending ACKs for article delivery confirmation
const pendingAcks = new Map<string, {
    timestamp: number
    peerId: string
    peerName: string
    url: string
    title: string
    feedName?: string
    feedUrl?: string
    feedIconUrl?: string
    message: P2PMessage
    onSuccess?: () => void
    onFailure?: () => void
}>()

/**
 * Initialize the P2P LAN module
 */
export function initP2PLan(): void {
    // Load existing peer ID or generate a new one
    let savedPeerId = getStoredP2PPeerId()
    if (!savedPeerId) {
        savedPeerId = crypto.randomBytes(8).toString("hex")
        setStoredP2PPeerId(savedPeerId)
        console.log("[P2P-LAN] Generated new persistent peerId:", savedPeerId)
    } else {
        console.log("[P2P-LAN] Loaded existing peerId:", savedPeerId)
    }
    localPeerId = savedPeerId
    
    // Auto-rejoin saved room after a short delay (allow app to fully initialize)
    setTimeout(() => {
        autoRejoinSavedRoom()
    }, 2000)
}

/**
 * Auto-rejoin a previously saved room
 */
async function autoRejoinSavedRoom(): Promise<void> {
    const stored = getStoredP2PRoom()
    if (stored.roomCode) {
        console.log(`[P2P-LAN] Auto-rejoining saved room: ${stored.roomCode}`)
        const success = await joinRoom(stored.roomCode, stored.displayName, false) // Don't re-save
        if (success) {
            console.log(`[P2P-LAN] Successfully rejoined room ${stored.roomCode}`)
        } else {
            console.log(`[P2P-LAN] Failed to rejoin room, clearing stored room`)
            clearStoredP2PRoom()
        }
    }
}

/**
 * Get the main window for sending IPC messages
 */
function getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows()
    return windows.length > 0 ? windows[0] : null
}

/**
 * Start hosting/joining a room
 */
export async function joinRoom(roomCode: string, displayName: string, saveToStore: boolean = true): Promise<boolean> {
    try {
        // Clean up any existing room
        await leaveRoom(false) // Don't clear store during rejoin
        
        activeRoomCode = roomCode.toUpperCase()
        localDisplayName = displayName || "Fluent Reader"
        
        console.log(`[P2P-LAN] Joining room: ${activeRoomCode} as "${localDisplayName}"`)
        
        // Save to persistent store
        if (saveToStore) {
            setStoredP2PRoom(activeRoomCode, localDisplayName)
            console.log(`[P2P-LAN] Room saved to store`)
        }
        
        // Start TCP server
        await startTcpServer()
        
        // Start UDP discovery
        await startUdpDiscovery()
        
        // Start broadcasting presence
        startBroadcasting()
        
        // Start heartbeat to check peer connectivity
        startHeartbeat()
        
        return true
    } catch (err) {
        console.error("[P2P-LAN] Failed to join room:", err)
        await leaveRoom()
        return false
    }
}

/**
 * Leave the current room
 * @param clearStore - Whether to clear the stored room (default: true)
 * @param sendGoodbye - Whether to send goodbye message to peers (default: true)
 */
export async function leaveRoom(clearStore: boolean = true, sendGoodbye: boolean = true): Promise<void> {
    console.log("[P2P-LAN] Leaving room")
    
    // Send goodbye to all connected peers before closing connections
    if (sendGoodbye && connectedPeers.size > 0) {
        const goodbyeMsg: P2PMessage = {
            type: "goodbye",
            senderName: localDisplayName,
            timestamp: Date.now()
        }
        broadcast(goodbyeMsg)
        console.log(`[P2P-LAN] Sent goodbye to ${connectedPeers.size} peer(s)`)
        
        // Small delay to ensure message is sent before closing sockets
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    
    // Clear stored room if requested
    if (clearStore) {
        clearStoredP2PRoom()
        console.log("[P2P-LAN] Cleared stored room")
    }
    
    // Stop broadcasting
    if (broadcastInterval) {
        clearInterval(broadcastInterval)
        broadcastInterval = null
    }
    
    // Stop heartbeat
    stopHeartbeat()
    
    // Close all TCP connections
    for (const [peerId, peer] of connectedPeers) {
        peer.socket.destroy()
    }
    connectedPeers.clear()
    discoveredPeers.clear()
    
    // Close UDP socket
    if (udpSocket) {
        try {
            udpSocket.close()
        } catch (e) {}
        udpSocket = null
    }
    
    // Close TCP server
    if (tcpServer) {
        tcpServer.close()
        tcpServer = null
    }
    
    activeRoomCode = null
    notifyConnectionState()
}

/**
 * Shutdown P2P gracefully when app is closing
 * Sends goodbye to peers but keeps the room stored for next startup
 */
export async function shutdownP2P(): Promise<void> {
    console.log("[P2P-LAN] Shutting down P2P (app closing)")
    // Don't clear stored room (false), but do send goodbye (true)
    await leaveRoom(false, true)
}

/**
 * Send a message to all connected peers
 */
export function broadcast(message: P2PMessage): number {
    let sentCount = 0
    const data = JSON.stringify(message)
    
    for (const [peerId, peer] of connectedPeers) {
        try {
            peer.socket.write(data + "\n")
            sentCount++
        } catch (err) {
            console.error(`[P2P-LAN] Failed to send to ${peerId}:`, err)
        }
    }
    
    console.log(`[P2P-LAN] Broadcast to ${sentCount} peers`)
    return sentCount
}

/**
 * Send a message to a specific peer
 */
export function sendToPeer(peerId: string, message: P2PMessage): boolean {
    const peer = connectedPeers.get(peerId)
    if (!peer) {
        console.error(`[P2P-LAN] Peer not connected: ${peerId}`)
        return false
    }
    
    try {
        const data = JSON.stringify(message)
        peer.socket.write(data + "\n")
        console.log(`[P2P-LAN] Sent ${message.type} to ${peer.displayName}`)
        return true
    } catch (err) {
        console.error(`[P2P-LAN] Failed to send to ${peerId}:`, err)
        return false
    }
}

/**
 * Send articles with delivery confirmation (always uses batch format)
 * Single article is simply an array with one element.
 * Returns promise that resolves when ACK received or rejects on timeout
 * @param queueOnFailure If true, adds to pending queue on failure (default: false)
 */
export function sendArticlesWithAck(
    peerId: string,
    articles: Array<{
        url: string
        title: string
        feedName?: string
        feedUrl?: string
        feedIconUrl?: string
    }>,
    queueOnFailure: boolean = false
): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const peer = connectedPeers.get(peerId)
        const peerName = peer?.displayName || "Unknown"
        
        if (articles.length === 0) {
            reject(new Error("No articles to send"))
            return
        }
        
        const messageId = generateMessageId()
        const message: P2PMessage = {
            type: "article-link-batch",
            senderId: localPeerId,
            roomCode: activeRoomCode || "",
            displayName: localDisplayName,
            articles,
            messageId,
            timestamp: Date.now(),
            senderName: localDisplayName
        }
        
        const sent = sendToPeer(peerId, message)
        if (!sent) {
            // Peer not connected - queue if requested
            if (queueOnFailure) {
                for (const article of articles) {
                    try {
                        addPendingShare(peerId, peerName, article.url, article.title, article.feedName, article.feedUrl, article.feedIconUrl)
                        console.log(`[P2P-LAN] Queued share for offline peer ${peerName}: ${article.title}`)
                    } catch (err) {
                        console.error(`[P2P-LAN] Failed to queue share:`, err)
                    }
                }
                notifyPendingSharesChanged()
            }
            reject(new Error("Peer not connected"))
            return
        }
        
        // Track pending ACK
        const firstArticle = articles[0]
        pendingAcks.set(messageId, {
            timestamp: Date.now(),
            peerId,
            peerName,
            url: firstArticle.url,
            title: articles.length === 1 ? firstArticle.title : `Batch of ${articles.length} articles`,
            feedName: firstArticle.feedName,
            feedUrl: firstArticle.feedUrl,
            feedIconUrl: firstArticle.feedIconUrl,
            message,
            onSuccess: () => resolve(true),
            onFailure: () => reject(new Error("ACK timeout"))
        })
        
        // Set timeout for ACK
        setTimeout(() => {
            const pending = pendingAcks.get(messageId)
            if (pending) {
                pendingAcks.delete(messageId)
                console.log(`[P2P-LAN] ACK timeout for message ${messageId}`)
                
                // Queue the failed articles if requested
                if (queueOnFailure) {
                    for (const article of articles) {
                        try {
                            addPendingShare(peerId, pending.peerName, article.url, article.title, article.feedName, article.feedUrl, article.feedIconUrl)
                            console.log(`[P2P-LAN] Queued share after timeout: ${article.title}`)
                        } catch (err) {
                            console.error(`[P2P-LAN] Failed to queue share:`, err)
                        }
                    }
                    notifyPendingSharesChanged()
                }
                
                pending.onFailure?.()
            }
        }, ACK_TIMEOUT)
    })
}

/**
 * Send article link and queue on failure
 * Convenience wrapper that always queues on failure
 */
export async function sendArticleLinkWithQueue(
    peerId: string,
    title: string,
    url: string,
    feedName?: string,
    feedUrl?: string,
    feedIconUrl?: string
): Promise<{ success: boolean, queued: boolean, error?: string }> {
    try {
        await sendArticlesWithAck(peerId, [{ url, title, feedName, feedUrl, feedIconUrl }], true)
        return { success: true, queued: false }
    } catch (err) {
        // Message was queued on failure
        return { 
            success: false, 
            queued: true,
            error: err instanceof Error ? err.message : "Unknown error" 
        }
    }
}

/**
 * Send article link to all peers with acknowledgement tracking
 * Returns results for each peer
 */
export async function broadcastArticlesWithAck(
    articles: Array<{
        url: string
        title: string
        feedName?: string
        feedUrl?: string
        feedIconUrl?: string
    }>
): Promise<Map<string, { success: boolean, error?: string }>> {
    const results = new Map<string, { success: boolean, error?: string }>()
    
    console.log(`[P2P-LAN] broadcastArticlesWithAck called, connectedPeers.size: ${connectedPeers.size}`)
    for (const [peerId, peer] of connectedPeers) {
        console.log(`[P2P-LAN]   - Peer: ${peer.displayName} (${peerId})`)
    }
    
    const promises = Array.from(connectedPeers.keys()).map(async (peerId) => {
        try {
            await sendArticlesWithAck(peerId, articles)
            results.set(peerId, { success: true })
        } catch (err) {
            results.set(peerId, { 
                success: false, 
                error: err instanceof Error ? err.message : "Unknown error" 
            })
        }
    })
    
    await Promise.all(promises)
    console.log(`[P2P-LAN] broadcastArticlesWithAck results:`, Array.from(results.entries()))
    return results
}

/**
 * Process pending shares queue for a specific peer
 * Called when peer reconnects
 * 
 * Sends all pending shares as a single batch message.
 * The receiver will see them as a batch (multiple articles → notification bell).
 */
async function processPendingSharesForPeer(peerId: string, peerName: string): Promise<void> {
    try {
        const pendingShares = getPendingSharesForPeer(peerId)
        if (pendingShares.length === 0) return
        
        console.log(`[P2P-LAN] Processing ${pendingShares.length} pending shares for ${peerName}`)
        
        // Build articles array for batch send
        const articles = pendingShares.map(share => ({
            url: share.url,
            title: share.title,
            feedName: share.feedName || undefined,
            feedUrl: share.feedUrl || undefined,
            feedIconUrl: share.feedIconUrl || undefined
        }))
        
        try {
            // Send all articles (uses the unified sendArticlesWithAck)
            await sendArticlesWithAck(peerId, articles)
            
            // Success - remove all from queue
            for (const share of pendingShares) {
                removePendingShare(share.id)
            }
            console.log(`[P2P-LAN] Successfully sent batch of ${articles.length} queued shares to ${peerName}`)
        } catch (err) {
            // Batch failed - increment attempts for all
            for (const share of pendingShares) {
                incrementPendingShareAttempts(share.id)
                
                // If too many attempts, give up
                if (share.attempts >= 5) {
                    console.log(`[P2P-LAN] Giving up on share after ${share.attempts + 1} attempts: ${share.title}`)
                    removePendingShare(share.id)
                }
            }
            console.log(`[P2P-LAN] Failed to send batch to ${peerName}:`, err)
        }
        
        notifyPendingSharesChanged()
    } catch (err) {
        console.error(`[P2P-LAN] Error processing pending shares:`, err)
    }
}

/**
 * Notify renderer about pending shares changes
 */
function notifyPendingSharesChanged(): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    try {
        const counts = getPendingShareCounts()
        mainWindow.webContents.send("p2p:pendingSharesChanged", counts)
    } catch (err) {
        console.error(`[P2P-LAN] Error notifying pending shares:`, err)
    }
}

/**
 * Start heartbeat interval to check peer connectivity
 */
function startHeartbeat(): void {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
    }
    
    heartbeatInterval = setInterval(() => {
        if (!activeRoomCode) return
        
        const now = Date.now()
        const disconnectedPeers: string[] = []
        
        // Send heartbeat to all connected peers and check for timeouts
        for (const [peerId, peer] of connectedPeers) {
            // Check if peer timed out
            if (now - peer.lastSeen > HEARTBEAT_TIMEOUT) {
                console.log(`[P2P-LAN] Peer ${peer.displayName} timed out (last seen ${Math.round((now - peer.lastSeen) / 1000)}s ago)`)
                disconnectedPeers.push(peerId)
                continue
            }
            
            // Send heartbeat
            try {
                const message: P2PMessage = {
                    type: "heartbeat",
                    senderId: localPeerId,
                    roomCode: activeRoomCode,
                    displayName: localDisplayName
                }
                peer.socket.write(JSON.stringify(message) + "\n")
            } catch (err) {
                console.error(`[P2P-LAN] Failed to send heartbeat to ${peerId}:`, err)
                disconnectedPeers.push(peerId)
            }
        }
        
        // Remove timed out peers
        for (const peerId of disconnectedPeers) {
            const peer = connectedPeers.get(peerId)
            if (peer) {
                console.log(`[P2P-LAN] Removing timed out peer: ${peer.displayName}`)
                notifyPeerDisconnected(peerId, peer.displayName, "Timeout - no response")
                try {
                    peer.socket.destroy()
                } catch (e) {}
                connectedPeers.delete(peerId)
            }
        }
        
        if (disconnectedPeers.length > 0) {
            notifyPeersChanged()
        }
    }, HEARTBEAT_INTERVAL)
}

/**
 * Stop heartbeat interval
 */
function stopHeartbeat(): void {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
    }
    
    // Clear pending ACKs
    for (const [messageId, pending] of pendingAcks) {
        pending.onFailure?.()
    }
    pendingAcks.clear()
}

/**
 * Get list of connected peers
 */
export function getConnectedPeers(): Array<{ peerId: string, displayName: string, connected: boolean }> {
    const peers: Array<{ peerId: string, displayName: string, connected: boolean }> = []
    
    console.log(`[P2P-LAN] getConnectedPeers called - connectedPeers.size: ${connectedPeers.size}, discoveredPeers.size: ${discoveredPeers.size}`)
    
    // Add connected peers
    for (const [peerId, peer] of connectedPeers) {
        console.log(`[P2P-LAN]   - Connected: ${peer.displayName} (${peerId})`)
        peers.push({
            peerId,
            displayName: peer.displayName,
            connected: true
        })
    }
    
    // Add discovered but not connected peers
    for (const [peerId, peer] of discoveredPeers) {
        if (!connectedPeers.has(peerId)) {
            console.log(`[P2P-LAN]   - Discovered (not connected): ${peer.displayName} (${peerId})`)
            peers.push({
                peerId,
                displayName: peer.displayName,
                connected: false
            })
        }
    }
    
    return peers
}

/**
 * Check if currently in a room
 */
export function isInRoom(): boolean {
    return activeRoomCode !== null
}

/**
 * Get current room code
 */
export function getRoomCode(): string | null {
    return activeRoomCode
}

// ============================================================================
// Private: UDP Discovery
// ============================================================================

async function startUdpDiscovery(): Promise<void> {
    return new Promise((resolve, reject) => {
        udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true })
        
        udpSocket.on("error", (err) => {
            console.error("[P2P-LAN] UDP error:", err)
            reject(err)
        })
        
        udpSocket.on("message", (msg, rinfo) => {
            handleDiscoveryMessage(msg, rinfo)
        })
        
        udpSocket.on("listening", () => {
            const addr = udpSocket!.address()
            console.log(`[P2P-LAN] UDP listening on ${addr.address}:${addr.port}`)
            
            // Enable broadcast
            udpSocket!.setBroadcast(true)
            resolve()
        })
        
        udpSocket.bind(DISCOVERY_PORT)
    })
}

function handleDiscoveryMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
        const data: DiscoveryMessage = JSON.parse(msg.toString())
        
        // Ignore our own messages
        if (data.peerId === localPeerId) return
        
        // Ignore messages from other rooms
        if (data.roomCode !== activeRoomCode) return
        
        console.log(`[P2P-LAN] Discovery from ${data.displayName} (${rinfo.address}:${data.tcpPort})`)
        
        // Update discovered peers
        discoveredPeers.set(data.peerId, {
            displayName: data.displayName,
            address: rinfo.address,
            tcpPort: data.tcpPort,
            lastSeen: Date.now()
        })
        
        // If not already connected, try to connect
        if (!connectedPeers.has(data.peerId)) {
            // Only one side initiates (the one with "smaller" peerId)
            if (localPeerId < data.peerId) {
                connectToPeer(data.peerId, rinfo.address, data.tcpPort, data.displayName)
            }
        }
        
        // Send response if this was a discovery request
        if (data.type === "discovery") {
            sendDiscoveryResponse(rinfo.address)
        }
        
    } catch (err) {
        // Ignore malformed messages
    }
}

function startBroadcasting(): void {
    const sendBroadcast = () => {
        if (!udpSocket || !activeRoomCode) return
        
        const message: DiscoveryMessage = {
            type: "discovery",
            roomCode: activeRoomCode,
            peerId: localPeerId,
            displayName: localDisplayName,
            tcpPort: tcpPort,
            timestamp: Date.now()
        }
        
        const data = Buffer.from(JSON.stringify(message))
        
        // Send to broadcast address
        udpSocket.send(data, DISCOVERY_PORT, "255.255.255.255", (err) => {
            if (err) console.error("[P2P-LAN] Broadcast error:", err)
        })
    }
    
    // Send immediately and then periodically
    sendBroadcast()
    broadcastInterval = setInterval(sendBroadcast, BROADCAST_INTERVAL)
}

function sendDiscoveryResponse(targetAddress: string): void {
    if (!udpSocket || !activeRoomCode) return
    
    const message: DiscoveryMessage = {
        type: "discovery-response",
        roomCode: activeRoomCode,
        peerId: localPeerId,
        displayName: localDisplayName,
        tcpPort: tcpPort,
        timestamp: Date.now()
    }
    
    const data = Buffer.from(JSON.stringify(message))
    udpSocket.send(data, DISCOVERY_PORT, targetAddress)
}

// ============================================================================
// Private: TCP Server/Client
// ============================================================================

async function startTcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
        tcpServer = net.createServer((socket) => {
            handleIncomingConnection(socket)
        })
        
        tcpServer.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                // Try next port
                tcpPort++
                if (tcpPort <= TCP_PORT_END) {
                    tcpServer!.listen(tcpPort)
                } else {
                    reject(new Error("No available TCP port"))
                }
            } else {
                reject(err)
            }
        })
        
        tcpServer.on("listening", () => {
            const addr = tcpServer!.address() as net.AddressInfo
            tcpPort = addr.port
            console.log(`[P2P-LAN] TCP server listening on port ${tcpPort}`)
            resolve()
        })
        
        // Start with first port in range
        tcpPort = TCP_PORT_START
        tcpServer.listen(tcpPort)
    })
}

function handleIncomingConnection(socket: net.Socket): void {
    console.log(`[P2P-LAN] Incoming connection from ${socket.remoteAddress}`)
    
    let buffer = ""
    let peerId: string | null = null
    
    socket.on("data", (data) => {
        buffer += data.toString()
        
        // Process complete messages (newline-delimited)
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        
        for (const line of lines) {
            if (!line.trim()) continue
            
            try {
                const msg = JSON.parse(line)
                
                // First message should be handshake
                if (!peerId && msg.type === "handshake") {
                    peerId = msg.peerId
                    const displayName = msg.displayName || "Unknown"
                    
                    connectedPeers.set(peerId, {
                        socket,
                        displayName,
                        lastSeen: Date.now()
                    })
                    
                    console.log(`[P2P-LAN] Connected to ${displayName} (${peerId})`)
                    
                    // Send handshake response
                    socket.write(JSON.stringify({
                        type: "handshake-ack",
                        peerId: localPeerId,
                        displayName: localDisplayName
                    }) + "\n")
                    
                    notifyConnectionState()
                    
                    // Process any pending shares for this peer
                    processPendingSharesForPeer(peerId, displayName)
                } else if (peerId) {
                    handlePeerMessage(peerId, msg)
                }
            } catch (err) {
                console.error("[P2P-LAN] Failed to parse message:", err)
            }
        }
    })
    
    socket.on("close", () => {
        if (peerId) {
            console.log(`[P2P-LAN] Disconnected from ${peerId}`)
            connectedPeers.delete(peerId)
            notifyConnectionState()
        }
    })
    
    socket.on("error", (err) => {
        console.error("[P2P-LAN] Socket error:", err)
        if (peerId) {
            connectedPeers.delete(peerId)
            notifyConnectionState()
        }
    })
}

function connectToPeer(peerId: string, address: string, port: number, displayName: string): void {
    if (connectedPeers.has(peerId)) return
    
    console.log(`[P2P-LAN] Connecting to ${displayName} at ${address}:${port}`)
    
    const socket = net.createConnection({ host: address, port }, () => {
        console.log(`[P2P-LAN] TCP connected to ${displayName}`)
        
        // Send handshake
        socket.write(JSON.stringify({
            type: "handshake",
            peerId: localPeerId,
            displayName: localDisplayName
        }) + "\n")
    })
    
    let buffer = ""
    let handshakeComplete = false
    
    socket.on("data", (data) => {
        buffer += data.toString()
        
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        
        for (const line of lines) {
            if (!line.trim()) continue
            
            try {
                const msg = JSON.parse(line)
                
                if (!handshakeComplete && msg.type === "handshake-ack") {
                    handshakeComplete = true
                    
                    connectedPeers.set(peerId, {
                        socket,
                        displayName,
                        lastSeen: Date.now()
                    })
                    
                    console.log(`[P2P-LAN] Handshake complete with ${displayName}`)
                    notifyConnectionState()
                    
                    // Process any pending shares for this peer
                    processPendingSharesForPeer(peerId, displayName)
                } else if (handshakeComplete) {
                    handlePeerMessage(peerId, msg)
                }
            } catch (err) {
                console.error("[P2P-LAN] Failed to parse message:", err)
            }
        }
    })
    
    socket.on("close", () => {
        console.log(`[P2P-LAN] Disconnected from ${displayName}`)
        connectedPeers.delete(peerId)
        notifyConnectionState()
    })
    
    socket.on("error", (err) => {
        console.error(`[P2P-LAN] Connection to ${displayName} failed:`, err)
        connectedPeers.delete(peerId)
    })
}

// ============================================================================
// Private: Message Handling
// ============================================================================

function handlePeerMessage(peerId: string, msg: P2PMessage): void {
    const peer = connectedPeers.get(peerId)
    if (!peer) return
    
    peer.lastSeen = Date.now()
    
    // Don't log heartbeats to reduce noise
    if (msg.type !== "heartbeat" && msg.type !== "heartbeat-ack") {
        console.log(`[P2P-LAN] Received ${msg.type} from ${peer.displayName}`)
    }
    
    switch (msg.type) {
        case "article-link-batch":
            // Unified handler for all article shares (1 or more)
            if (msg.articles && msg.articles.length > 0) {
                console.log(`[P2P-LAN] Received ${msg.articles.length} article(s) from ${peer.displayName}`)
                
                if (msg.articles.length === 1) {
                    // Single article - show dialog
                    const a = msg.articles[0]
                    notifyArticleReceived(
                        peerId,
                        peer.displayName,
                        a.url,
                        a.title,
                        msg.timestamp,
                        a.feedName,
                        a.feedUrl,
                        a.feedIconUrl
                    )
                } else {
                    // Multiple articles - send to batch handler (goes to bell, no dialogs)
                    notifyArticlesReceivedBatch(
                        peerId,
                        peer.displayName,
                        msg.articles.map(a => ({
                            url: a.url,
                            title: a.title,
                            timestamp: msg.timestamp,
                            feedName: a.feedName,
                            feedUrl: a.feedUrl,
                            feedIconUrl: a.feedIconUrl
                        }))
                    )
                }
                
                // Send ACK back to sender
                if (msg.messageId) {
                    sendToPeer(peerId, {
                        type: "article-link-ack",
                        senderId: localPeerId,
                        roomCode: activeRoomCode || "",
                        displayName: localDisplayName,
                        ackId: msg.messageId,
                        senderName: localDisplayName,
                        timestamp: Date.now()
                    })
                }
            }
            break
            
        case "article-link-ack":
            // Handle ACK for sent article
            if (msg.ackId) {
                const pending = pendingAcks.get(msg.ackId)
                if (pending) {
                    console.log(`[P2P-LAN] Received ACK for message ${msg.ackId} from ${peer.displayName}`)
                    pendingAcks.delete(msg.ackId)
                    pending.onSuccess?.()
                }
            }
            break
            
        case "heartbeat":
            // Respond with heartbeat-ack
            sendToPeer(peerId, {
                type: "heartbeat-ack",
                senderId: localPeerId,
                roomCode: activeRoomCode || "",
                displayName: localDisplayName
            })
            break
            
        case "heartbeat-ack":
            // Just update lastSeen (already done above)
            break
            
        case "echo-request":
            // Respond to echo
            sendToPeer(peerId, {
                type: "echo-response",
                senderName: localDisplayName,
                timestamp: Date.now(),
                echoData: {
                    originalTimestamp: msg.timestamp,
                    receivedAt: Date.now()
                }
            })
            break
            
        case "echo-response":
            notifyEchoResponse(peerId, msg.echoData?.originalTimestamp, msg.timestamp)
            break
            
        case "goodbye":
            // Peer is leaving gracefully - remove from connected peers
            console.log(`[P2P-LAN] Received goodbye from ${peer.displayName}`)
            connectedPeers.delete(peerId)
            discoveredPeers.delete(peerId)
            notifyPeerDisconnected(peerId, peer.displayName, "Peer left the room")
            notifyPeersChanged()
            break
    }
}

// ============================================================================
// Private: IPC Notifications to Renderer
// ============================================================================

function notifyConnectionState(): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    const peers = getConnectedPeers()
    mainWindow.webContents.send("p2p:connectionStateChanged", {
        inRoom: isInRoom(),
        roomCode: activeRoomCode,
        peers
    })
}

function notifyPeersChanged(): void {
    // Reuse notifyConnectionState since it sends all peer info
    notifyConnectionState()
}

function notifyPeerDisconnected(peerId: string, displayName: string, reason: string): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    mainWindow.webContents.send("p2p:peerDisconnected", {
        peerId,
        displayName,
        reason
    })
}

function notifyArticleReceived(
    peerId: string, 
    peerName: string, 
    url: string, 
    title: string, 
    timestamp: number,
    feedName?: string,
    feedUrl?: string,
    feedIconUrl?: string
): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    mainWindow.webContents.send("p2p:articleReceived", {
        peerId,
        peerName,
        url,
        title,
        timestamp,
        feedName,
        feedUrl,
        feedIconUrl
    })
}

/**
 * Notify renderer about multiple articles received at once (e.g., from pending queue)
 * This should go directly to notification bell without showing individual dialogs
 */
function notifyArticlesReceivedBatch(
    peerId: string,
    peerName: string,
    articles: Array<{
        url: string
        title: string
        timestamp: number
        feedName?: string
        feedUrl?: string
        feedIconUrl?: string
    }>
): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    console.log(`[P2P-LAN] Sending batch of ${articles.length} articles from ${peerName}`)
    mainWindow.webContents.send("p2p:articlesReceivedBatch", {
        peerId,
        peerName,
        articles,
        count: articles.length
    })
}

function notifyEchoResponse(peerId: string, originalTimestamp: number, returnedAt: number): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    mainWindow.webContents.send("p2p:echoResponse", {
        peerId,
        originalTimestamp,
        returnedAt,
        roundTripMs: Date.now() - originalTimestamp
    })
}

// ============================================================================
// IPC Handlers
// ============================================================================

export function registerP2PLanIpcHandlers(): void {
    ipcMain.handle("p2p-lan:joinRoom", async (_, roomCode: string, displayName: string) => {
        return await joinRoom(roomCode, displayName)
    })
    
    ipcMain.handle("p2p-lan:leaveRoom", async () => {
        await leaveRoom()
    })
    
    ipcMain.handle("p2p-lan:getStatus", () => {
        return {
            inRoom: isInRoom(),
            roomCode: activeRoomCode,
            peers: getConnectedPeers()
        }
    })
    
    ipcMain.handle("p2p-lan:broadcast", (_, message: P2PMessage) => {
        return broadcast(message)
    })
    
    ipcMain.handle("p2p-lan:sendToPeer", (_, peerId: string, message: P2PMessage) => {
        return sendToPeer(peerId, message)
    })
    
    ipcMain.handle("p2p-lan:sendArticlesWithAck", async (_, peerId: string, articles: Array<{ url: string, title: string, feedName?: string, feedUrl?: string, feedIconUrl?: string }>) => {
        try {
            await sendArticlesWithAck(peerId, articles)
            return { success: true }
        } catch (err) {
            return { 
                success: false, 
                error: err instanceof Error ? err.message : "Unknown error" 
            }
        }
    })
    
    ipcMain.handle("p2p-lan:sendArticleLinkWithQueue", async (_, peerId: string, title: string, url: string, feedName?: string, feedUrl?: string, feedIconUrl?: string) => {
        return await sendArticleLinkWithQueue(peerId, title, url, feedName, feedUrl, feedIconUrl)
    })
    
    ipcMain.handle("p2p-lan:broadcastArticlesWithAck", async (_, articles: Array<{ url: string, title: string, feedName?: string, feedUrl?: string, feedIconUrl?: string }>) => {
        const results = await broadcastArticlesWithAck(articles)
        // Convert Map to object for IPC
        const resultObj: Record<string, { success: boolean, error?: string }> = {}
        for (const [peerId, result] of results) {
            resultObj[peerId] = result
        }
        return resultObj
    })
    
    ipcMain.handle("p2p-lan:sendEcho", (_, peerId: string) => {
        return sendToPeer(peerId, {
            type: "echo-request",
            senderName: localDisplayName,
            timestamp: Date.now()
        })
    })
    
    // Pending shares queue handlers
    ipcMain.handle("p2p-lan:getPendingShareCounts", () => {
        try {
            return getPendingShareCounts()
        } catch (err) {
            console.error("[P2P-LAN] Error getting pending share counts:", err)
            return {}
        }
    })
    
    ipcMain.handle("p2p-lan:getAllPendingShares", () => {
        try {
            return getAllPendingShares()
        } catch (err) {
            console.error("[P2P-LAN] Error getting all pending shares:", err)
            return []
        }
    })
    
    ipcMain.handle("p2p-lan:removePendingShare", (_, id: number) => {
        try {
            removePendingShare(id)
            notifyPendingSharesChanged()
            return { success: true }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
        }
    })
    
    ipcMain.handle("p2p-lan:clearOldPendingShares", (_, maxAgeDays?: number) => {
        try {
            const removed = removeOldPendingShares(maxAgeDays)
            notifyPendingSharesChanged()
            return { success: true, removed }
        } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
        }
    })
    
    console.log("[P2P-LAN] IPC handlers registered")
}
