/**
 * P2P Initialization for Renderer Process
 * 
 * Sets up global message handlers for incoming P2P messages.
 * This should be imported once at app startup.
 */
import { p2pConnectionManager } from "./p2p-connection"
import { ShareMessage } from "../bridges/p2p"

// Store for pending notifications (to be shown via UI)
let pendingIncomingArticles: Array<{
    peerHash: string
    peerName: string
    url: string
    title: string
    timestamp: number
}> = []

type ArticleReceivedCallback = (data: {
    peerHash: string
    peerName: string
    url: string
    title: string
    timestamp: number
}) => void

let articleReceivedCallback: ArticleReceivedCallback | null = null

/**
 * Register callback for when an article link is received
 */
export function onArticleReceived(callback: ArticleReceivedCallback): void {
    articleReceivedCallback = callback
    
    // Deliver any pending articles
    while (pendingIncomingArticles.length > 0) {
        const article = pendingIncomingArticles.shift()
        if (article) {
            callback(article)
        }
    }
}

/**
 * Get pending articles that arrived before callback was registered
 */
export function getPendingArticles() {
    return [...pendingIncomingArticles]
}

/**
 * Clear pending articles
 */
export function clearPendingArticles() {
    pendingIncomingArticles = []
}

/**
 * Initialize P2P message handlers
 * Call this once at app startup
 */
export function initP2PMessageHandlers(): void {
    console.log("[P2P] Initializing message handlers")
    
    p2pConnectionManager.setOnMessage((peerHash, message) => {
        console.log(`[P2P] Received message type: ${message.type}`)
        
        if (message.type === "article-link") {
            handleArticleLink(peerHash, message)
        }
        // Echo requests/responses are handled automatically in p2p-connection.ts
    })
}

function handleArticleLink(peerHash: string, message: ShareMessage): void {
    if (!message.url || !message.title) {
        console.error("[P2P] Received article-link without url or title")
        return
    }
    
    const articleData = {
        peerHash,
        peerName: message.senderName,
        url: message.url,
        title: message.title,
        timestamp: message.timestamp
    }
    
    console.log(`[P2P] Article received from ${message.senderName}: ${message.title}`)
    
    if (articleReceivedCallback) {
        articleReceivedCallback(articleData)
    } else {
        // Store for later delivery
        pendingIncomingArticles.push(articleData)
    }
}

// Auto-initialize when module is imported
initP2PMessageHandlers()
