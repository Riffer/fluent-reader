/**
 * P2P Share Dialog - LAN Version
 * 
 * Simple dialog to share an article with connected peers on LAN.
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
} from "@fluentui/react"
import { P2PStatus } from "../bridges/p2p-lan"

interface P2PShareDialogProps {
    hidden: boolean
    onDismiss: () => void
    articleTitle: string
    articleLink: string
}

export const P2PShareDialog: React.FC<P2PShareDialogProps> = ({
    hidden,
    onDismiss,
    articleTitle,
    articleLink,
}) => {
    const [status, setStatus] = useState<P2PStatus | null>(null)
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    useEffect(() => {
        if (!hidden) {
            loadStatus()
            setSuccess(false)
            setError(null)
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

    const handleSend = async () => {
        try {
            setSending(true)
            setError(null)
            
            // Share to all connected peers
            const sentCount = await window.p2pLan.shareArticle(articleLink, articleTitle)
            
            if (sentCount > 0) {
                setSuccess(true)
                setTimeout(() => {
                    onDismiss()
                }, 1500)
            } else {
                setError("No peers connected. Join a room first in Settings → P2P Share.")
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
                                    backgroundColor: "#f3f3f3",
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
                                    color: "#666",
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
                        </MessageBar>
                    )}
                    
                    {status?.inRoom && connectedCount > 0 && (
                        <MessageBar messageBarType={MessageBarType.info}>
                            Connected peers: {status.peers.filter(p => p.connected).map(p => p.displayName).join(", ")}
                        </MessageBar>
                    )}
                </Stack>
            )}

            <DialogFooter>
                <PrimaryButton
                    text={sending ? "Sending..." : "Send to All Peers"}
                    onClick={handleSend}
                    disabled={sending || loading || !status?.inRoom || connectedCount === 0}
                />
                <DefaultButton text="Cancel" onClick={onDismiss} disabled={sending} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PShareDialog
