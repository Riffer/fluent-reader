/**
 * P2P Incoming Article Notification
 * 
 * Shows a notification when an article link is received via P2P LAN.
 * Allows user to open the article in the reader or dismiss.
 */
import React, { useState, useEffect, useRef, useCallback } from "react"
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
    useTheme,
} from "@fluentui/react"

/**
 * Decode HTML entities in a string (e.g., &#x2019; -> ')
 */
function decodeHtmlEntities(text: string): string {
    const textarea = document.createElement("textarea")
    textarea.innerHTML = text
    return textarea.value
}

interface IncomingArticle {
    peerId: string
    peerName: string
    url: string
    title: string
    timestamp: number
}

interface P2PIncomingNotificationProps {
    addToLog: (title: string, url: string, peerName: string) => void
}

export const P2PIncomingNotification: React.FC<P2PIncomingNotificationProps> = ({ addToLog }) => {
    const [incomingArticle, setIncomingArticle] = useState<IncomingArticle | null>(null)
    const [collectLinksInLog, setCollectLinksInLog] = useState<boolean>(false)
    const queueRef = useRef<IncomingArticle[]>([])
    const listenerRegistered = useRef(false)

    // Load setting on mount
    useEffect(() => {
        const loadSetting = async () => {
            const setting = window.settings.getP2PCollectLinks()
            setCollectLinksInLog(setting)
        }
        loadSetting()
    }, [])

    // Register listener only ONCE on mount
    useEffect(() => {
        if (listenerRegistered.current) return
        listenerRegistered.current = true
        
        console.log("[P2P Notification] Registering article listener")
        
        const unsubscribe = window.p2pLan.onArticleReceived((article) => {
            console.log("[P2P Notification] Article received:", article.title)
            
            // Check current setting (use getter to get fresh value)
            const shouldCollect = window.settings.getP2PCollectLinks()
            
            if (shouldCollect) {
                // Add to log instead of showing dialog
                console.log("[P2P Notification] Collecting link in log")
                addToLog(article.title, article.url, article.peerName)
                return
            }
            
            setIncomingArticle(prev => {
                if (prev) {
                    // Queue if already showing one
                    queueRef.current = [...queueRef.current, article]
                    console.log("[P2P Notification] Queued, total in queue:", queueRef.current.length)
                    return prev
                } else {
                    return article
                }
            })
        })
        
        return () => {
            console.log("[P2P Notification] Unregistering article listener")
            unsubscribe()
            listenerRegistered.current = false
        }
    }, [addToLog]) // addToLog is stable from mapDispatchToProps

    const handleDismiss = useCallback(() => {
        // Show next in queue or close
        if (queueRef.current.length > 0) {
            const [next, ...rest] = queueRef.current
            queueRef.current = rest
            setIncomingArticle(next)
        } else {
            setIncomingArticle(null)
        }
    }, [])

    const handleCopyLink = useCallback(() => {
        if (!incomingArticle) return
        navigator.clipboard.writeText(incomingArticle.url)
        console.log("[P2P Notification] Link copied:", incomingArticle.url)
        handleDismiss()
    }, [incomingArticle, handleDismiss])

    const handleOpenInBrowser = useCallback(() => {
        if (!incomingArticle) return
        console.log("[P2P Notification] Opening in browser:", incomingArticle.url)
        // Use Electron's shell to open external URLs
        window.utils.openExternal(incomingArticle.url)
        handleDismiss()
    }, [incomingArticle, handleDismiss])

    const handleOpenInReader = useCallback(() => {
        if (!incomingArticle) return
        console.log("[P2P Notification] Opening in reader:", incomingArticle.url)
        // Open URL in internal reader window
        window.utils.openInReaderWindow(incomingArticle.url, incomingArticle.title)
        handleDismiss()
    }, [incomingArticle, handleDismiss])

    const handleLater = useCallback(() => {
        if (!incomingArticle) return
        console.log("[P2P Notification] Saving for later:", incomingArticle.url)
        // Add to log menu (notification bell) for later viewing
        addToLog(incomingArticle.title, incomingArticle.url, incomingArticle.peerName)
        handleDismiss()
    }, [incomingArticle, addToLog, handleDismiss])

    const theme = useTheme()

    if (!incomingArticle) return null

    const timeAgo = getTimeAgo(incomingArticle.timestamp)
    const decodedTitle = decodeHtmlEntities(incomingArticle.title)

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
                        {decodedTitle}
                    </Text>
                    <Text 
                        variant="small"
                        styles={{
                            root: {
                                color: theme.palette.neutralSecondary,
                                wordBreak: "break-all",
                            },
                        }}
                    >
                        {incomingArticle.url}
                    </Text>
                </Stack>

                {queueRef.current.length > 0 && (
                    <MessageBar>
                        +{queueRef.current.length} more article{queueRef.current.length > 1 ? "s" : ""} waiting
                    </MessageBar>
                )}
            </Stack>

            <DialogFooter>
                <PrimaryButton text="Open in Reader" onClick={handleOpenInReader} />
                <DefaultButton text="Open in Browser" onClick={handleOpenInBrowser} />
                <DefaultButton text="Copy Link" onClick={handleCopyLink} />
                <DefaultButton text="Later" onClick={handleLater} iconProps={{ iconName: "Ringer" }} />
            </DialogFooter>
        </Dialog>
    )
}

function getTimeAgo(timestamp: number | undefined): string {
    // Handle missing or invalid timestamp
    if (!timestamp || isNaN(timestamp)) {
        return "just now"
    }
    
    const now = Date.now()
    const diff = now - timestamp
    
    // Handle future timestamps or very old timestamps
    if (diff < 0 || diff > 86400000 * 30) {
        return "just now"
    }
    
    if (diff < 60000) return "just now"
    if (diff < 3600000) return `${Math.floor(diff / 60000)} min ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`
    return new Date(timestamp).toLocaleDateString()
}

export default P2PIncomingNotification
