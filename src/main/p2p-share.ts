/**
 * P2P Share Module - Main Process
 * 
 * Handles peer-to-peer article link sharing between Fluent Reader instances.
 * Note: WebRTC connections are managed in the renderer process via simple-peer.
 * This module handles peer configuration storage and IPC coordination only.
 */
import { ipcMain, BrowserWindow } from "electron"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import { app } from "electron"

// Types and Interfaces
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

// Storage Management
const CONFIG_FILE = "p2p-config.json"
const PEERS_FILE = "p2p-peers.json"
const PEER_EXPIRATION_DAYS = 30

function getConfigPath(): string {
    return path.join(app.getPath("userData"), CONFIG_FILE)
}

function getPeersPath(): string {
    return path.join(app.getPath("userData"), PEERS_FILE)
}

function loadConfig(): P2PConfig {
    try {
        const configPath = getConfigPath()
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, "utf8"))
        }
    } catch (e) {
        console.error("[P2P] Error loading config:", e)
    }
    return {
        enabled: true,
        receiveMode: "ask",
        defaultOpenAction: "article"
    }
}

function saveConfig(config: P2PConfig): void {
    try {
        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
    } catch (e) {
        console.error("[P2P] Error saving config:", e)
    }
}

function loadPeers(): KnownPeer[] {
    try {
        const peersPath = getPeersPath()
        if (fs.existsSync(peersPath)) {
            const peers: KnownPeer[] = JSON.parse(fs.readFileSync(peersPath, "utf8"))
            const now = Date.now()
            const expirationMs = PEER_EXPIRATION_DAYS * 24 * 60 * 60 * 1000
            return peers.filter(p => (now - p.lastSeen) < expirationMs)
        }
    } catch (e) {
        console.error("[P2P] Error loading peers:", e)
    }
    return []
}

function savePeers(peers: KnownPeer[]): void {
    try {
        fs.writeFileSync(getPeersPath(), JSON.stringify(peers, null, 2))
    } catch (e) {
        console.error("[P2P] Error saving peers:", e)
    }
}

// Cryptographic Functions
export function generateRoomCode(): string {
    const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    let code = ""
    const randomBytes = crypto.randomBytes(6)
    for (let i = 0; i < 6; i++) {
        code += chars[randomBytes[i] % chars.length]
    }
    return code
}

export function generatePeerHash(sharedSecret: string, peerId: string): string {
    return crypto
        .createHash("sha256")
        .update(sharedSecret + peerId)
        .digest("hex")
        .substring(0, 16)
}

export function generatePeerId(): string {
    return crypto.randomBytes(16).toString("hex")
}

// URL Validation
export function isValidShareUrl(url: string): boolean {
    try {
        const parsed = new URL(url)
        if (!["http:", "https:"].includes(parsed.protocol)) {
            return false
        }
        const hostname = parsed.hostname.toLowerCase()
        if (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("10.") ||
            hostname.startsWith("172.") ||
            hostname.endsWith(".local")
        ) {
            return false
        }
        return true
    } catch {
        return false
    }
}

// Peer Management
let knownPeers: KnownPeer[] = []
let p2pConfig: P2PConfig

export function initP2P(): void {
    p2pConfig = loadConfig()
    knownPeers = loadPeers()
    console.log("[P2P] Initialized with " + knownPeers.length + " known peers")
}

export function getKnownPeers(): KnownPeer[] {
    return knownPeers
}

export function addPeer(peer: KnownPeer): void {
    const existing = knownPeers.findIndex(p => p.peerHash === peer.peerHash)
    if (existing >= 0) {
        knownPeers[existing] = { ...knownPeers[existing], ...peer, lastSeen: Date.now() }
    } else {
        knownPeers.push(peer)
    }
    savePeers(knownPeers)
}

export function removePeer(peerHash: string): void {
    knownPeers = knownPeers.filter(p => p.peerHash !== peerHash)
    savePeers(knownPeers)
}

export function updatePeerLastSeen(peerHash: string): void {
    const peer = knownPeers.find(p => p.peerHash === peerHash)
    if (peer) {
        peer.lastSeen = Date.now()
        savePeers(knownPeers)
    }
}

// IPC Handlers (peer management only - WebRTC runs in renderer)
export function registerP2PIpcHandlers(): void {
    ipcMain.handle("p2p:getConfig", () => p2pConfig)
    
    ipcMain.handle("p2p:setConfig", (_, config: Partial<P2PConfig>) => {
        p2pConfig = { ...p2pConfig, ...config }
        saveConfig(p2pConfig)
        return p2pConfig
    })
    
    ipcMain.handle("p2p:getPeers", () => knownPeers)
    
    ipcMain.handle("p2p:addPeer", (_, peer: KnownPeer) => {
        addPeer(peer)
        return knownPeers
    })
    
    ipcMain.handle("p2p:removePeer", (_, peerHash: string) => {
        removePeer(peerHash)
        return knownPeers
    })
    
    ipcMain.handle("p2p:updatePeerLastSeen", (_, peerHash: string) => {
        updatePeerLastSeen(peerHash)
    })
    
    ipcMain.handle("p2p:generateRoomCode", () => generateRoomCode())
    ipcMain.handle("p2p:generatePeerId", () => generatePeerId())
    ipcMain.handle("p2p:generatePeerHash", (_, secret: string, peerId: string) => 
        generatePeerHash(secret, peerId)
    )
    
    ipcMain.handle("p2p:isValidUrl", (_, url: string) => isValidShareUrl(url))
    
    console.log("[P2P] IPC handlers registered")
}
