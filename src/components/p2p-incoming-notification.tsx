/**
 * P2P Incoming Article Notification
 * 
 * Shows a notification when an article link is received via P2P LAN.
 * Allows user to open the article in the reader or dismiss.
 */
import React, { useState, useEffect } from "react"
import {
    Dialog,
    DialogType,
    DialogFooter,
    PrimaryButton,
    DefaultButton,
    Stack,
    Text,
    MessageBar,
    MessageBarType,
    Link,
} from "@fluentui/react"

interface IncomingArticle {
    peerId: string
    peerName: string
    url: string
    title: string
    timestamp: number
}

export const P2PIncomingNotification: React.FC = () => {
    const [incomingArticle, setIncomingArticle] = useState<IncomingArticle | null>(null)
    const [queue, setQueue] = useState<IncomingArticle[]>([])

    useEffect(() => {
        // Listen for incoming articles from P2P LAN
        window.p2pLan.onArticleReceived((article) => {
            console.log("[P2P Notification] Article received:", article.title)
            if (incomingArticle) {
                // Queue if already showing one
                setQueue(prev => [...prev, article])
            } else {
                setIncomingArticle(article)
            }
        })
        
        return () => {
            window.p2pLan.removeAllListeners()
        }
    }, [incomingArticle])

    const handleDismiss = () => {
        // Show next in queue or close
        if (queue.length > 0) {
            const [next, ...rest] = queue
            setIncomingArticle(next)
            setQueue(rest)
        } else {
            setIncomingArticle(null)
        }
    }

    const handleOpenInReader = () => {
        if (!incomingArticle) return
        
        // Dispatch action to open article (you'll need to connect this to your redux store)
        // For now, we'll just copy to clipboard and show info
        navigator.clipboard.writeText(incomingArticle.url)
        console.log("[P2P] Opening article:", incomingArticle.url)
        
        // You can dispatch a redux action here to actually open the article
        // For example: store.dispatch(openArticle(incomingArticle.url))
        
        handleDismiss()
    }

    const handleOpenInBrowser = () => {
        if (!incomingArticle) return
        window.open(incomingArticle.url, "_blank")
        handleDismiss()
    }

    if (!incomingArticle) return null

    const timeAgo = getTimeAgo(incomingArticle.timestamp)

    return (
        <Dialog
            hidden={false}
            onDismiss={handleDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "📥 Article Received",
                subText: `${incomingArticle.peerName} shared an article with you`,
            }}
            modalProps={{
                isBlocking: false,
                styles: { main: { maxWidth: 500 } },
            }}
        >
            <Stack tokens={{ childrenGap: 12 }}>
                <MessageBar messageBarType={MessageBarType.info}>
                    Received {timeAgo}
                </MessageBar>
                
                <Stack tokens={{ childrenGap: 4 }}>
                    <Text variant="large" styles={{ root: { fontWeight: 600 } }}>
                        {incomingArticle.title}
                    </Text>
                    <Link
                        href={incomingArticle.url}
                        target="_blank"
                        styles={{
                            root: {
                                fontSize: 12,
                                color: "#666",
                                wordBreak: "break-all",
                            },
                        }}
                    >
                        {incomingArticle.url}
                    </Link>
                </Stack>

                {queue.length > 0 && (
                    <MessageBar>
                        +{queue.length} more article{queue.length > 1 ? "s" : ""} waiting
                    </MessageBar>
                )}
            </Stack>

            <DialogFooter>
                <PrimaryButton text="Copy Link" onClick={() => {
                    navigator.clipboard.writeText(incomingArticle.url)
                    handleDismiss()
                }} />
                <DefaultButton text="Open in Browser" onClick={handleOpenInBrowser} />
                <DefaultButton text="Dismiss" onClick={handleDismiss} />
            </DialogFooter>
        </Dialog>
    )
}

function getTimeAgo(timestamp: number): string {
    const now = Date.now()
    const diff = now - timestamp
    
    if (diff < 60000) return "just now"
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`
    return new Date(timestamp).toLocaleDateString()
}

export default P2PIncomingNotification
