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
import { getStoredP2PRoom, setStoredP2PRoom, clearStoredP2PRoom } from "./settings"

// Constants
const DISCOVERY_PORT = 41899  // UDP port for broadcast
const TCP_PORT_START = 41900  // TCP port range start
const TCP_PORT_END = 41999    // TCP port range end
const BROADCAST_INTERVAL = 5000  // ms between broadcasts (5 seconds)
const PEER_TIMEOUT = 15000    // ms before peer considered offline

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
    type: "article-link" | "echo-request" | "echo-response"
    senderName: string
    timestamp: number
    url?: string
    title?: string
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

// Connected peers (TCP sockets)
const connectedPeers = new Map<string, {
    socket: net.Socket
    displayName: string
    lastSeen: number
}>()

// Discovered peers (seen via UDP but not yet connected)
const discoveredPeers = new Map<string, {
    displayName: string
    address: string
    tcpPort: number
    lastSeen: number
}>()

/**
 * Initialize the P2P LAN module
 */
export function initP2PLan(): void {
    localPeerId = crypto.randomBytes(8).toString("hex")
    console.log("[P2P-LAN] Initialized with peerId:", localPeerId)
    
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
 */
export async function leaveRoom(clearStore: boolean = true): Promise<void> {
    console.log("[P2P-LAN] Leaving room")
    
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
 * Get list of connected peers
 */
export function getConnectedPeers(): Array<{ peerId: string, displayName: string, connected: boolean }> {
    const peers: Array<{ peerId: string, displayName: string, connected: boolean }> = []
    
    // Add connected peers
    for (const [peerId, peer] of connectedPeers) {
        peers.push({
            peerId,
            displayName: peer.displayName,
            connected: true
        })
    }
    
    // Add discovered but not connected peers
    for (const [peerId, peer] of discoveredPeers) {
        if (!connectedPeers.has(peerId)) {
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
    
    console.log(`[P2P-LAN] Received ${msg.type} from ${peer.displayName}`)
    
    switch (msg.type) {
        case "article-link":
            if (msg.url && msg.title) {
                notifyArticleReceived(peerId, peer.displayName, msg.url, msg.title, msg.timestamp)
            }
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

function notifyArticleReceived(peerId: string, peerName: string, url: string, title: string, timestamp: number): void {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    
    mainWindow.webContents.send("p2p:articleReceived", {
        peerId,
        peerName,
        url,
        title,
        timestamp
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
    
    ipcMain.handle("p2p-lan:sendEcho", (_, peerId: string) => {
        return sendToPeer(peerId, {
            type: "echo-request",
            senderName: localDisplayName,
            timestamp: Date.now()
        })
    })
    
    console.log("[P2P-LAN] IPC handlers registered")
}
