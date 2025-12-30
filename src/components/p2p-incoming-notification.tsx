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
 * Play a subtle notification sound when articles are added to the bell
 */
function playNotificationSound(): void {
    try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)()
        
        // Create a pleasant two-tone "ding" sound
        const oscillator1 = audioContext.createOscillator()
        const oscillator2 = audioContext.createOscillator()
        const gainNode = audioContext.createGain()
        
        oscillator1.connect(gainNode)
        oscillator2.connect(gainNode)
        gainNode.connect(audioContext.destination)
        
        // First tone: E5 (659 Hz)
        oscillator1.frequency.setValueAtTime(659, audioContext.currentTime)
        oscillator1.type = "sine"
        
        // Second tone: G5 (784 Hz) - slightly delayed
        oscillator2.frequency.setValueAtTime(784, audioContext.currentTime + 0.1)
        oscillator2.type = "sine"
        
        // Fade in and out
        gainNode.gain.setValueAtTime(0, audioContext.currentTime)
        gainNode.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.05)
        gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.3)
        
        oscillator1.start(audioContext.currentTime)
        oscillator1.stop(audioContext.currentTime + 0.15)
        
        oscillator2.start(audioContext.currentTime + 0.1)
        oscillator2.stop(audioContext.currentTime + 0.3)
        
        // Clean up
        setTimeout(() => audioContext.close(), 500)
    } catch (err) {
        // Sound playback failed - not critical
    }
}

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
    storedInFeed?: boolean
    articleId?: number
    sourceId?: number
    feedName?: string
}

interface P2PIncomingNotificationProps {
    addToLog: (title: string, url: string, peerName: string, articleId?: number, sourceId?: number) => void
    navigateToArticle: (sourceId: number, articleId: number, feedName: string) => void
}

export const P2PIncomingNotification: React.FC<P2PIncomingNotificationProps> = ({ addToLog, navigateToArticle }) => {
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
        
        const unsubscribe = window.p2pLan.onArticleReceived((article) => {
            // Check current setting (use getter to get fresh value)
            const shouldCollect = window.settings.getP2PCollectLinks()
            
            if (shouldCollect) {
                // Add to log instead of showing dialog
                addToLog(article.title, article.url, article.peerName, article.articleId, article.sourceId)
                playNotificationSound()
                return
            }
            
            setIncomingArticle(prev => {
                if (prev) {
                    // Queue if already showing one
                    queueRef.current = [...queueRef.current, article]
                    return prev
                } else {
                    return article
                }
            })
        })
        
        // Register batch listener - batch articles always go directly to log
        const unsubscribeBatch = window.p2pLan.onArticlesReceivedBatch((data) => {
            // Add all articles to log
            for (const article of data.articles) {
                addToLog(article.title, article.url, data.peerName)
            }
            
            // Play notification sound for batch
            playNotificationSound()
        })
        
        return () => {
            unsubscribe()
            unsubscribeBatch()
            listenerRegistered.current = false
        }
    }, [addToLog]) // addToLog is stable from mapDispatchToProps

    // Notify Article component when P2P dialog opens/closes (for screenshot placeholder)
    useEffect(() => {
        // Dispatch custom event to Article component - it handles the screenshot/placeholder logic
        const event = new CustomEvent('p2p-dialog-visibility', {
            detail: { open: incomingArticle !== null }
        })
        window.dispatchEvent(event)
    }, [incomingArticle])

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
        handleDismiss()
    }, [incomingArticle, handleDismiss])

    const handleOpenInBrowser = useCallback(() => {
        if (!incomingArticle) return
        // Use Electron's shell to open external URLs
        window.utils.openExternal(incomingArticle.url)
        handleDismiss()
    }, [incomingArticle, handleDismiss])

    const handleOpenInReader = useCallback(() => {
        if (!incomingArticle) return
        // Open URL in internal reader window
        window.utils.openInReaderWindow(incomingArticle.url, incomingArticle.title)
        handleDismiss()
    }, [incomingArticle, handleDismiss])

    const handleLater = useCallback(() => {
        if (!incomingArticle) return
        // Add to log menu (notification bell) for later viewing
        addToLog(incomingArticle.title, incomingArticle.url, incomingArticle.peerName, incomingArticle.articleId, incomingArticle.sourceId)
        handleDismiss()
    }, [incomingArticle, addToLog, handleDismiss])

    const handleGoToArticle = useCallback(() => {
        if (!incomingArticle) return
        if (!incomingArticle.articleId || !incomingArticle.sourceId) {
            return
        }
        
        // Store values before dismissing
        const { sourceId, articleId, feedName } = incomingArticle
        
        // Dismiss dialog first
        handleDismiss()
        
        // Navigate after dialog has closed (async to prevent focus issues)
        setTimeout(() => {
            navigateToArticle(sourceId, articleId, feedName || "P2P Geteilt")
        }, 50)
    }, [incomingArticle, navigateToArticle, handleDismiss])

    const theme = useTheme()

    if (!incomingArticle) return null

    const timeAgo = getTimeAgo(incomingArticle.timestamp)
    const decodedTitle = decodeHtmlEntities(incomingArticle.title)
    const canNavigateToArticle = incomingArticle.storedInFeed && incomingArticle.articleId && incomingArticle.sourceId

    return (
        <Dialog
            hidden={false}
            onDismiss={handleDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "📥 Article Received",
                subText: `${incomingArticle.peerName} shared an article with you`,
                styles: { inner: { minWidth: 480 } },
            }}
            modalProps={{
                isBlocking: false,
                styles: { main: { minWidth: 520, maxWidth: 600 } },
            }}
            minWidth={520}
            maxWidth={600}
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
                <Stack 
                    horizontal 
                    tokens={{ childrenGap: 8 }}
                    styles={{ root: { width: "100%" } }}
                >
                    {canNavigateToArticle && (
                        <PrimaryButton 
                            text="Zum Artikel"
                            onClick={handleGoToArticle} 
                            iconProps={{ iconName: "ReadingMode" }}
                        />
                    )}
                    <DefaultButton 
                        text="Im Reader"
                        onClick={handleOpenInReader} 
                        iconProps={{ iconName: "NavigateExternalInline" }}
                        primary={!canNavigateToArticle}
                    />
                    <DefaultButton 
                        text="Im Browser"
                        onClick={handleOpenInBrowser} 
                        iconProps={{ iconName: "Globe" }}
                    />
                    <DefaultButton 
                        text="Kopieren"
                        onClick={handleCopyLink} 
                        iconProps={{ iconName: "Link" }}
                    />
                    <Stack.Item grow={1}>
                        <span />
                    </Stack.Item>
                    <DefaultButton 
                        text="Später"
                        onClick={handleLater} 
                        iconProps={{ iconName: "Ringer" }} 
                    />
                </Stack>
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
