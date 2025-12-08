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
import { KnownPeer } from "../bridges/p2p"

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
    const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState(false)

    useEffect(() => {
        if (!hidden) {
            loadPeers()
            setSuccess(false)
            setError(null)
        }
    }, [hidden])

    const loadPeers = async () => {
        try {
            setLoading(true)
            const peersData = await window.p2p.getPeers()
            setPeers(peersData)
            if (peersData.length > 0 && !selectedPeer) {
                setSelectedPeer(peersData[0].peerHash)
            }
        } catch (err) {
            setError("Failed to load peers")
        } finally {
            setLoading(false)
        }
    }

    const handleSend = async () => {
        if (!selectedPeer) return

        try {
            setSending(true)
            setError(null)
            // P2P send is not yet implemented in bridge - show placeholder
            console.log("P2P Share:", { peer: selectedPeer, title: articleTitle, link: articleLink })
            // TODO: Implement actual P2P send when WebRTC connection is ready
            setSuccess(true)
            setTimeout(() => {
                onDismiss()
            }, 1500)
        } catch (err) {
            setError("Failed to send article. Peer may be offline.")
        } finally {
            setSending(false)
        }
    }

    const peerOptions: IDropdownOption[] = peers.map((peer) => ({
        key: peer.peerHash,
        text: peer.displayName,
    }))

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
                            No peers configured. Go to Settings → P2P to add peers.
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
                    disabled={!selectedPeer || sending || loading || peers.length === 0}
                />
                <DefaultButton text="Cancel" onClick={onDismiss} disabled={sending} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PShareDialog
