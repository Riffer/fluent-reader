/**
 * P2P Share Dialog - LAN Version
 * 
 * Simple dialog to share an article with connected peers on LAN.
 * Supports queueing shares for offline peers.
 */
import React, { useState, useEffect } from "react"
import {
    Dialog,
    DialogType,
    DialogFooter,
    PrimaryButton,
    DefaultButton,
    Stack,
    Label,
    MessageBar,
    MessageBarType,
    Spinner,
    SpinnerSize,
    Text,
    useTheme,
    IconButton,
    Icon,
} from "@fluentui/react"
import { P2PStatus } from "../bridges/p2p-lan"

interface P2PShareDialogProps {
    hidden: boolean
    onDismiss: () => void
    articleTitle: string
    articleLink: string
    feedName?: string
    feedUrl?: string
    feedIconUrl?: string
}

interface PendingShareCounts {
    [peerId: string]: { count: number; peerName: string }
}

export const P2PShareDialog: React.FC<P2PShareDialogProps> = ({
    hidden,
    onDismiss,
    articleTitle,
    articleLink,
    feedName,
    feedUrl,
    feedIconUrl,
}) => {
    const theme = useTheme()
    const [status, setStatus] = useState<P2PStatus | null>(null)
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)
    const [pendingCounts, setPendingCounts] = useState<PendingShareCounts>({})

    useEffect(() => {
        if (!hidden) {
            loadStatus()
            loadPendingCounts()
            setSuccess(false)
            setError(null)
            
            // Subscribe to connection state changes while dialog is open
            const unsubscribe = window.p2pLan.onConnectionStateChanged((newStatus) => {
                console.log("[P2P Share Dialog] Connection state changed:", newStatus)
                setStatus(newStatus)
            })
            
            // Subscribe to pending shares changes
            const unsubscribePending = window.p2pLan.onPendingSharesChanged((counts) => {
                console.log("[P2P Share Dialog] Pending shares changed:", counts)
                setPendingCounts(counts)
            })
            
            return () => {
                // Cleanup: unsubscribe when dialog closes
                unsubscribe()
                unsubscribePending()
            }
        }
    }, [hidden])

    const loadStatus = async () => {
        try {
            setLoading(true)
            const currentStatus = await window.p2pLan.getStatus()
            setStatus(currentStatus)
        } catch (err) {
            setError("Failed to load P2P status")
        } finally {
            setLoading(false)
        }
    }
    
    const loadPendingCounts = async () => {
        try {
            const counts = await window.p2pLan.getPendingShareCounts()
            setPendingCounts(counts)
        } catch (err) {
            console.error("[P2P Share Dialog] Failed to load pending counts:", err)
        }
    }

    const handleSend = async () => {
        try {
            setSending(true)
            setError(null)
            
            // Get list of all known peers (connected + discovered)
            const allPeers = status?.peers || []
            
            if (allPeers.length === 0) {
                setError("No peers in room. Make sure another device has joined the same room.")
                return
            }
            
            // Build article object for sending (include feed info for P2P storage)
            const article = { 
                url: articleLink, 
                title: articleTitle,
                feedName,
                feedUrl,
                feedIconUrl
            }
            
            // Send to all peers with queueing for offline ones
            const results: Array<{ peer: string, success: boolean, queued: boolean, error?: string }> = []
            
            for (const peer of allPeers) {
                if (peer.connected) {
                    // Try immediate delivery with ACK (single article as array)
                    try {
                        const result = await window.p2pLan.sendArticlesWithAck(peer.peerId, [article])
                        results.push({ 
                            peer: peer.displayName, 
                            success: result.success, 
                            queued: false,
                            error: result.error 
                        })
                    } catch (err) {
                        // If immediate send fails, queue it
                        await window.p2pLan.sendArticleLinkWithQueue(peer.peerId, articleTitle, articleLink, feedName, feedUrl, feedIconUrl)
                        results.push({ 
                            peer: peer.displayName, 
                            success: false, 
                            queued: true 
                        })
                    }
                } else {
                    // Peer is discovered but not connected - queue the share
                    await window.p2pLan.sendArticleLinkWithQueue(peer.peerId, articleTitle, articleLink, feedName, feedUrl, feedIconUrl)
                    results.push({ 
                        peer: peer.displayName, 
                        success: false, 
                        queued: true 
                    })
                }
            }
            
            const successCount = results.filter(r => r.success).length
            const queuedCount = results.filter(r => r.queued).length
            const failedCount = results.filter(r => !r.success && !r.queued).length
            
            if (successCount === results.length) {
                setSuccess(true)
                setTimeout(() => {
                    onDismiss()
                }, 1500)
            } else if (successCount > 0 || queuedCount > 0) {
                // Partial success or queued
                let message = `Delivered: ${successCount}`
                if (queuedCount > 0) {
                    message += `, Queued: ${queuedCount}`
                }
                if (failedCount > 0) {
                    message += `, Failed: ${failedCount}`
                }
                setError(message)
                setSuccess(true)
                loadPendingCounts() // Refresh pending counts
                setTimeout(() => {
                    onDismiss()
                }, 2500)
            } else {
                // All failed
                setError(`Failed to deliver or queue to any peer.`)
            }
        } catch (err) {
            setError("Failed to send article")
        } finally {
            setSending(false)
        }
    }

    const connectedCount = status?.peers.filter(p => p.connected).length ?? 0

    return (
        <Dialog
            hidden={hidden}
            onDismiss={onDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "Share Article via P2P",
                subText: status?.inRoom 
                    ? `Send to ${connectedCount} connected peer(s) in room ${status.roomCode}`
                    : "Join a P2P room first to share articles.",
            }}
            minWidth={400}
        >
            {loading ? (
                <Stack horizontalAlign="center" styles={{ root: { padding: 20 } }}>
                    <Spinner size={SpinnerSize.medium} label="Loading..." />
                </Stack>
            ) : (
                <Stack tokens={{ childrenGap: 12 }}>
                    {error && (
                        <MessageBar
                            messageBarType={MessageBarType.error}
                            onDismiss={() => setError(null)}
                        >
                            {error}
                        </MessageBar>
                    )}

                    {success && (
                        <MessageBar messageBarType={MessageBarType.success}>
                            Article sent to {connectedCount} peer(s)!
                        </MessageBar>
                    )}

                    <Stack tokens={{ childrenGap: 4 }}>
                        <Label>Article</Label>
                        <Text
                            variant="medium"
                            styles={{
                                root: {
                                    backgroundColor: theme.palette.neutralLighter,
                                    color: theme.palette.neutralPrimary,
                                    padding: 8,
                                    borderRadius: 4,
                                    wordBreak: "break-word",
                                },
                            }}
                        >
                            {articleTitle}
                        </Text>
                    </Stack>

                    <Stack tokens={{ childrenGap: 4 }}>
                        <Label>Link</Label>
                        <Text
                            variant="small"
                            styles={{
                                root: {
                                    color: theme.palette.neutralSecondary,
                                    wordBreak: "break-all",
                                },
                            }}
                        >
                            {articleLink}
                        </Text>
                    </Stack>

                    {!status?.inRoom && (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            You're not in a P2P room. Go to Settings → P2P Share to create or join a room.
                        </MessageBar>
                    )}
                    
                    {status?.inRoom && connectedCount === 0 && (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No peers connected yet. Make sure another device has joined the same room.
                            {Object.keys(pendingCounts).length > 0 && " Shares will be queued for later delivery."}
                        </MessageBar>
                    )}
                    
                    {status?.inRoom && connectedCount > 0 && (
                        <MessageBar messageBarType={MessageBarType.info}>
                            Connected peers: {status.peers.filter(p => p.connected).map(p => p.displayName).join(", ")}
                        </MessageBar>
                    )}
                    
                    {/* Show pending shares queue */}
                    {Object.keys(pendingCounts).length > 0 && (
                        <Stack tokens={{ childrenGap: 4 }}>
                            <Label>
                                <Icon iconName="Clock" styles={{ root: { marginRight: 4 } }} />
                                Pending Deliveries
                            </Label>
                            <Stack 
                                styles={{
                                    root: {
                                        backgroundColor: theme.palette.neutralLighter,
                                        padding: 8,
                                        borderRadius: 4,
                                    },
                                }}
                            >
                                {Object.entries(pendingCounts).map(([peerId, info]) => (
                                    <Text key={peerId} variant="small" styles={{ root: { color: theme.palette.neutralSecondary } }}>
                                        {info.peerName}: {info.count} link(s) waiting
                                    </Text>
                                ))}
                            </Stack>
                        </Stack>
                    )}
                </Stack>
            )}

            <DialogFooter>
                <PrimaryButton
                    text={sending ? "Sending..." : (connectedCount > 0 ? "Send to All Peers" : "Queue for Later")}
                    onClick={handleSend}
                    disabled={sending || loading || !status?.inRoom || (connectedCount === 0 && status?.peers.length === 0)}
                />
                <DefaultButton text="Cancel" onClick={onDismiss} disabled={sending} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PShareDialog
