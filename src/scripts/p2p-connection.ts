/**
 * P2P Connection Manager - Renderer Process
 * 
 * Manages WebRTC peer connections using simple-peer library.
 * This runs in the renderer process where WebRTC APIs are available.
 */
import Peer from "simple-peer"
import { ShareMessage, ConnectionInfo } from "../bridges/p2p"

// STUN servers for NAT traversal
const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
]

interface ActiveConnection {
    peer: Peer.Instance
    peerHash: string
    displayName: string
    connected: boolean
    isInitiator: boolean
}

type ConnectionStateCallback = (info: ConnectionInfo) => void
type MessageCallback = (peerHash: string, message: ShareMessage) => void
type ErrorCallback = (peerHash: string, displayName: string, error: string) => void

class P2PConnectionManager {
    private connections = new Map<string, ActiveConnection>()
    private onConnectionStateChange: ConnectionStateCallback | null = null
    private onMessage: MessageCallback | null = null
    private onError: ErrorCallback | null = null

    // Set callbacks
    setOnConnectionStateChange(callback: ConnectionStateCallback): void {
        this.onConnectionStateChange = callback
    }

    setOnMessage(callback: MessageCallback): void {
        this.onMessage = callback
    }

    setOnError(callback: ErrorCallback): void {
        this.onError = callback
    }

    // Create a new connection as initiator
    createOffer(peerHash: string, displayName: string): Promise<string> {
        return this.createConnection(true, peerHash, displayName)
    }

    // Accept an incoming offer
    acceptOffer(offerJson: string, peerHash: string, displayName: string): Promise<string> {
        return new Promise((resolve, reject) => {
            try {
                const offerData = JSON.parse(offerJson)
                
                this.createConnection(false, peerHash, displayName)
                    .then(answerJson => {
                        // Feed the offer to generate answer
                        const connection = this.connections.get(peerHash)
                        if (connection) {
                            connection.peer.signal(offerData)
                        }
                        resolve(answerJson)
                    })
                    .catch(reject)
            } catch (e) {
                reject(new Error("Invalid offer data"))
            }
        })
    }

    // Complete connection with answer (for initiator)
    completeConnection(peerHash: string, answerJson: string): boolean {
        const connection = this.connections.get(peerHash)
        if (!connection) {
            console.error(`[P2P] No pending connection for hash ${peerHash}`)
            return false
        }
        
        try {
            const answerData = JSON.parse(answerJson)
            connection.peer.signal(answerData)
            console.log(`[P2P] Answer applied for ${connection.displayName}`)
            return true
        } catch (e) {
            console.error("[P2P] Invalid answer data:", e)
            return false
        }
    }

    // Disconnect from a peer
    disconnect(peerHash: string): void {
        const connection = this.connections.get(peerHash)
        if (connection) {
            console.log(`[P2P] Disconnecting from ${connection.displayName}`)
            connection.peer.destroy()
            this.connections.delete(peerHash)
        }
    }

    // Send message to specific peer
    sendMessage(peerHash: string, message: ShareMessage): boolean {
        const connection = this.connections.get(peerHash)
        if (!connection || !connection.connected) {
            console.error(`[P2P] Cannot send - not connected to ${peerHash}`)
            return false
        }
        
        try {
            connection.peer.send(JSON.stringify(message))
            console.log(`[P2P] Sent ${message.type} to ${connection.displayName}`)
            return true
        } catch (e) {
            console.error("[P2P] Send error:", e)
            return false
        }
    }

    // Broadcast message to all connected peers
    broadcast(message: ShareMessage): number {
        let sentCount = 0
        this.connections.forEach((connection, peerHash) => {
            if (connection.connected) {
                if (this.sendMessage(peerHash, message)) {
                    sentCount++
                }
            }
        })
        console.log(`[P2P] Broadcast ${message.type} to ${sentCount} peers`)
        return sentCount
    }

    // Get all active connections
    getActiveConnections(): ConnectionInfo[] {
        return Array.from(this.connections.entries()).map(([hash, conn]) => ({
            peerHash: hash,
            displayName: conn.displayName,
            connected: conn.connected,
            isInitiator: conn.isInitiator
        }))
    }

    // Check if connected to a peer
    isConnected(peerHash: string): boolean {
        const connection = this.connections.get(peerHash)
        return connection?.connected ?? false
    }

    // Private: Create WebRTC connection
    private createConnection(isInitiator: boolean, peerHash: string, displayName: string): Promise<string> {
        return new Promise((resolve, reject) => {
            // Clean up existing connection if any
            if (this.connections.has(peerHash)) {
                this.disconnect(peerHash)
            }

            console.log(`[P2P] Creating connection as ${isInitiator ? 'initiator' : 'receiver'} for ${displayName}`)

            const peer = new Peer({
                initiator: isInitiator,
                trickle: false,  // Wait for complete ICE gathering
                config: { iceServers: ICE_SERVERS }
            })

            const connection: ActiveConnection = {
                peer,
                peerHash,
                displayName,
                connected: false,
                isInitiator
            }
            this.connections.set(peerHash, connection)

            // When signaling data is ready (offer or answer)
            peer.on("signal", (data) => {
                console.log(`[P2P] Signal ready for ${displayName}`)
                resolve(JSON.stringify(data))
            })

            // Connection established
            peer.on("connect", () => {
                console.log(`[P2P] Connected to ${displayName}`)
                connection.connected = true
                
                // Update last seen in main process
                window.p2p.updatePeerLastSeen?.(peerHash)
                
                if (this.onConnectionStateChange) {
                    this.onConnectionStateChange({
                        peerHash,
                        displayName,
                        connected: true,
                        isInitiator
                    })
                }
            })

            // Data received
            peer.on("data", (data) => {
                try {
                    const message: ShareMessage = JSON.parse(data.toString())
                    console.log(`[P2P] Received ${message.type} from ${displayName}`)
                    
                    // Handle echo requests automatically
                    if (message.type === "echo-request") {
                        const echoResponse: ShareMessage = {
                            type: "echo-response",
                            senderHash: peerHash,
                            senderName: "Local",
                            timestamp: Date.now(),
                            echoData: {
                                originalTimestamp: message.timestamp,
                                receivedAt: Date.now()
                            }
                        }
                        this.sendMessage(peerHash, echoResponse)
                    }
                    
                    if (this.onMessage) {
                        this.onMessage(peerHash, message)
                    }
                } catch (e) {
                    console.error("[P2P] Error parsing message:", e)
                }
            })

            // Connection closed
            peer.on("close", () => {
                console.log(`[P2P] Connection closed with ${displayName}`)
                connection.connected = false
                this.connections.delete(peerHash)
                
                if (this.onConnectionStateChange) {
                    this.onConnectionStateChange({
                        peerHash,
                        displayName,
                        connected: false,
                        isInitiator
                    })
                }
            })

            // Error handling
            peer.on("error", (err) => {
                console.error(`[P2P] Error with ${displayName}:`, err.message)
                this.connections.delete(peerHash)
                
                if (this.onError) {
                    this.onError(peerHash, displayName, err.message)
                }
                
                reject(err)
            })
        })
    }
}

// Singleton instance
export const p2pConnectionManager = new P2PConnectionManager()
export default p2pConnectionManager
