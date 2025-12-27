/**
 * P2P Share Dialog - LAN Version
 * 
 * Simple dialog to share an article with known peers on LAN.
 * Shows all known peers with their online/offline status.
 * Sends immediately to online peers, queues for offline ones.
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
    openTarget?: number
    defaultZoom?: number
}

interface KnownPeer {
    peerId: string
    peerName: string
    roomCode: string
    lastSeen: string
    createdAt: string
    online: boolean
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
    const [knownPeers, setKnownPeers] = useState<KnownPeer[]>([])
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)
    const [resultMessage, setResultMessage] = useState<string | null>(null)
    const [pendingCounts, setPendingCounts] = useState<PendingShareCounts>({})

    useEffect(() => {
        if (!hidden) {
            loadData()
            setSuccess(false)
            setError(null)
            setResultMessage(null)
            
            // Subscribe to connection state changes
            const unsubscribe = window.p2pLan.onConnectionStateChanged(async (newStatus) => {
                setStatus(newStatus)
                // Refresh known peers when connection state changes
                try {
                    const peers = await window.p2pLan.getKnownPeersWithStatus()
                    setKnownPeers(peers)
                } catch (err) {
                    console.error("[P2P Share Dialog] Failed to refresh peers:", err)
                }
            })
            
            // Subscribe to pending shares changes
            const unsubscribePending = window.p2pLan.onPendingSharesChanged((counts) => {
                setPendingCounts(counts)
            })
            
            return () => {
                unsubscribe()
                unsubscribePending()
            }
        }
    }, [hidden])

    const loadData = async () => {
        try {
            setLoading(true)
            await Promise.all([
                loadStatus(),
                loadKnownPeers(),
                loadPendingCounts()
            ])
        } finally {
            setLoading(false)
        }
    }

    const loadStatus = async () => {
        try {
            const currentStatus = await window.p2pLan.getStatus()
            setStatus(currentStatus)
        } catch (err) {
            setError("Failed to load P2P status")
        }
    }
    
    const loadKnownPeers = async () => {
        try {
            const peers = await window.p2pLan.getKnownPeersWithStatus()
            setKnownPeers(peers)
        } catch (err) {
            console.error("[P2P Share Dialog] Failed to load known peers:", err)
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
            setResultMessage(null)
            
            // Use the new shareToAllKnownPeers function
            const result = await window.p2pLan.shareToAllKnownPeers(
                articleTitle, 
                articleLink, 
                feedName, 
                feedUrl, 
                feedIconUrl
            )
            
            if (result.error) {
                setError(result.error)
                return
            }
            
            // Build result message
            const parts: string[] = []
            if (result.sent > 0) {
                parts.push(`Sent to ${result.sent}`)
            }
            if (result.queued > 0) {
                parts.push(`Queued for ${result.queued}`)
            }
            
            setSuccess(true)
            setResultMessage(parts.join(", ") + ` peer(s)`)
            
            // Refresh pending counts
            loadPendingCounts()
            
            // Auto-close after success
            setTimeout(() => {
                onDismiss()
            }, 1500)
            
        } catch (err) {
            setError("Failed to send article")
        } finally {
            setSending(false)
        }
    }

    const onlineCount = knownPeers.filter(p => p.online).length
    const offlineCount = knownPeers.filter(p => !p.online).length

    // Format last seen time
    const formatLastSeen = (lastSeen: string): string => {
        const date = new Date(lastSeen)
        const now = new Date()
        const diffMs = now.getTime() - date.getTime()
        const diffMins = Math.floor(diffMs / (1000 * 60))
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
        
        if (diffMins < 1) return "just now"
        if (diffMins < 60) return `${diffMins}m ago`
        if (diffHours < 24) return `${diffHours}h ago`
        return `${diffDays}d ago`
    }

    return (
        <Dialog
            hidden={hidden}
            onDismiss={onDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "Share Article via P2P",
                subText: status?.inRoom 
                    ? `Room: ${status.roomCode} — ${knownPeers.length} known peer(s)`
                    : "Join a P2P room first to share articles.",
            }}
            minWidth={420}
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

                    {success && resultMessage && (
                        <MessageBar messageBarType={MessageBarType.success}>
                            {resultMessage}
                        </MessageBar>
                    )}

                    {/* Article Info */}
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

                    {/* Warnings */}
                    {!status?.inRoom && (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            You're not in a P2P room. Go to Settings → P2P Share to create or join a room.
                        </MessageBar>
                    )}
                    
                    {status?.inRoom && knownPeers.length === 0 && (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No known peers in this room yet. Another device must join the same room first.
                        </MessageBar>
                    )}

                    {/* Known Peers List */}
                    {status?.inRoom && knownPeers.length > 0 && (
                        <Stack tokens={{ childrenGap: 4 }}>
                            <Label>
                                <Icon iconName="People" styles={{ root: { marginRight: 4 } }} />
                                Recipients ({onlineCount} online, {offlineCount} offline)
                            </Label>
                            <Stack 
                                styles={{
                                    root: {
                                        backgroundColor: theme.palette.neutralLighter,
                                        padding: 8,
                                        borderRadius: 4,
                                        maxHeight: 150,
                                        overflowY: "auto",
                                    },
                                }}
                                tokens={{ childrenGap: 6 }}
                            >
                                {knownPeers.map((peer) => (
                                    <Stack 
                                        key={peer.peerId} 
                                        horizontal 
                                        verticalAlign="center"
                                        tokens={{ childrenGap: 8 }}
                                    >
                                        <Icon 
                                            iconName={peer.online ? "StatusCircleCheckmark" : "StatusCircleRing"} 
                                            styles={{ 
                                                root: { 
                                                    color: peer.online 
                                                        ? theme.palette.green 
                                                        : theme.palette.neutralTertiary,
                                                    fontSize: 12,
                                                } 
                                            }} 
                                        />
                                        <Text 
                                            variant="small" 
                                            styles={{ 
                                                root: { 
                                                    color: peer.online 
                                                        ? theme.palette.neutralPrimary 
                                                        : theme.palette.neutralSecondary,
                                                    flex: 1,
                                                } 
                                            }}
                                        >
                                            {peer.peerName}
                                        </Text>
                                        <Text 
                                            variant="tiny" 
                                            styles={{ 
                                                root: { 
                                                    color: theme.palette.neutralTertiary,
                                                } 
                                            }}
                                        >
                                            {peer.online ? "online" : "offline"}
                                        </Text>
                                        {pendingCounts[peer.peerId] && (
                                            <Text 
                                                variant="tiny" 
                                                styles={{ 
                                                    root: { 
                                                        color: theme.palette.themePrimary,
                                                        backgroundColor: theme.palette.themeLighter,
                                                        padding: "2px 6px",
                                                        borderRadius: 10,
                                                    } 
                                                }}
                                            >
                                                {pendingCounts[peer.peerId].count} pending
                                            </Text>
                                        )}
                                    </Stack>
                                ))}
                            </Stack>
                        </Stack>
                    )}
                </Stack>
            )}

            <DialogFooter>
                <PrimaryButton
                    text={sending ? "Sending..." : (
                        knownPeers.length > 0 
                            ? `Send to ${knownPeers.length} Peer(s)` 
                            : "No Peers Known"
                    )}
                    onClick={handleSend}
                    disabled={sending || loading || !status?.inRoom || knownPeers.length === 0}
                />
                <DefaultButton text="Cancel" onClick={onDismiss} disabled={sending} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PShareDialog
