import React, { useState, useEffect } from "react"
import {
    Dialog,
    DialogType,
    DialogFooter,
    PrimaryButton,
    DefaultButton,
    Dropdown,
    IDropdownOption,
    Stack,
    Label,
    MessageBar,
    MessageBarType,
    Spinner,
    SpinnerSize,
    Text,
} from "@fluentui/react"
import { KnownPeer, ConnectionInfo, ShareMessage } from "../bridges/p2p"
import { p2pConnectionManager } from "../scripts/p2p-connection"

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
    const [peers, setPeers] = useState<KnownPeer[]>([])
    const [connections, setConnections] = useState<ConnectionInfo[]>([])
    const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    useEffect(() => {
        if (!hidden) {
            loadData()
            setSuccess(false)
            setError(null)
        }
    }, [hidden])

    const loadData = async () => {
        try {
            setLoading(true)
            const peersData = await window.p2p.getPeers()
            const connectionsData = p2pConnectionManager.getActiveConnections()
            setPeers(peersData)
            setConnections(connectionsData)
            
            // Auto-select first connected peer
            const connectedPeer = connectionsData.find(c => c.connected)
            if (connectedPeer) {
                setSelectedPeer(connectedPeer.peerHash)
            } else if (peersData.length > 0 && !selectedPeer) {
                setSelectedPeer(peersData[0].peerHash)
            }
        } catch (err) {
            setError("Failed to load peers")
        } finally {
            setLoading(false)
        }
    }
    
    const isConnected = (peerHash: string): boolean => {
        return p2pConnectionManager.isConnected(peerHash)
    }

    const handleSend = async () => {
        if (!selectedPeer) return

        try {
            setSending(true)
            setError(null)
            
            // Check if peer is connected
            if (!isConnected(selectedPeer)) {
                setError("Peer is not connected. Connect first in Settings → P2P Share.")
                return
            }
            
            // Create share message
            const message: ShareMessage = {
                type: "article-link",
                senderHash: "local", // Will be replaced by receiver
                senderName: "Fluent Reader",
                timestamp: Date.now(),
                url: articleLink,
                title: articleTitle
            }
            
            // Send via P2P using the Renderer-side manager
            const sent = p2pConnectionManager.sendMessage(selectedPeer, message)
            
            if (sent) {
                setSuccess(true)
                setTimeout(() => {
                    onDismiss()
                }, 1500)
            } else {
                setError("Failed to send. Connection may have been lost.")
            }
        } catch (err) {
            setError("Failed to send article. Peer may be offline.")
        } finally {
            setSending(false)
        }
    }

    const peerOptions: IDropdownOption[] = peers.map((peer) => {
        const connected = isConnected(peer.peerHash)
        return {
            key: peer.peerHash,
            text: `${peer.displayName}${connected ? " ✓" : " (offline)"}`,
            disabled: !connected,
        }
    })
    
    const hasConnectedPeers = connections.some(c => c.connected)

    return (
        <Dialog
            hidden={hidden}
            onDismiss={onDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "Share Article via P2P",
                subText: "Send this article link to a connected peer.",
            }}
            minWidth={400}
        >
            {loading ? (
                <Stack horizontalAlign="center" styles={{ root: { padding: 20 } }}>
                    <Spinner size={SpinnerSize.medium} label="Loading peers..." />
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
                            Article sent successfully!
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

                    {peers.length === 0 ? (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No peers configured. Go to Settings → P2P Share to add peers.
                        </MessageBar>
                    ) : !hasConnectedPeers ? (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No peers connected. Go to Settings → P2P Share to connect.
                        </MessageBar>
                    ) : (
                        <Dropdown
                            label="Send to"
                            selectedKey={selectedPeer}
                            options={peerOptions}
                            onChange={(_, option) => setSelectedPeer(option?.key as string)}
                            disabled={sending}
                        />
                    )}
                </Stack>
            )}

            <DialogFooter>
                <PrimaryButton
                    text={sending ? "Sending..." : "Send"}
                    onClick={handleSend}
                    disabled={!selectedPeer || sending || loading || !hasConnectedPeers}
                />
                <DefaultButton text="Cancel" onClick={onDismiss} disabled={sending} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PShareDialog
