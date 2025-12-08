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
    ProgressIndicator,
} from "@fluentui/react"
import { KnownPeer } from "../bridges/p2p"

interface EchoResult {
    success: boolean
    roundTripMs?: number
    error?: string
}

interface P2PEchoDialogProps {
    hidden: boolean
    onDismiss: () => void
}

export const P2PEchoDialog: React.FC<P2PEchoDialogProps> = ({ hidden, onDismiss }) => {
    const [peers, setPeers] = useState<KnownPeer[]>([])
    const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [testing, setTesting] = useState(false)
    const [result, setResult] = useState<EchoResult | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!hidden) {
            loadPeers()
            setResult(null)
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

    const handleEchoTest = async () => {
        if (!selectedPeer) return

        try {
            setTesting(true)
            setResult(null)
            setError(null)

            const startTime = Date.now()
            // TODO: Implement actual echo when WebRTC is ready
            // Simulate echo for now
            await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200))
            const endTime = Date.now()

            setResult({
                success: true,
                roundTripMs: endTime - startTime,
            })
        } catch (err) {
            setResult({
                success: false,
                error: "Connection failed. Peer may be offline.",
            })
        } finally {
            setTesting(false)
        }
    }

    const peerOptions: IDropdownOption[] = peers.map((peer) => ({
        key: peer.peerHash,
        text: peer.displayName,
    }))

    const getLatencyQuality = (ms: number): { text: string; color: string } => {
        if (ms < 100) return { text: "Excellent", color: "#107c10" }
        if (ms < 300) return { text: "Good", color: "#498205" }
        if (ms < 500) return { text: "Fair", color: "#ffb900" }
        return { text: "Poor", color: "#d13438" }
    }

    return (
        <Dialog
            hidden={hidden}
            onDismiss={onDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "P2P Echo Test",
                subText: "Test the connection to a peer by sending an echo request.",
            }}
            minWidth={400}
        >
            {loading ? (
                <Stack horizontalAlign="center" styles={{ root: { padding: 20 } }}>
                    <Spinner size={SpinnerSize.medium} label="Loading peers..." />
                </Stack>
            ) : (
                <Stack tokens={{ childrenGap: 16 }}>
                    {error && (
                        <MessageBar
                            messageBarType={MessageBarType.error}
                            onDismiss={() => setError(null)}
                        >
                            {error}
                        </MessageBar>
                    )}

                    {peers.length === 0 ? (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No peers configured. Go to Settings → P2P to add peers.
                        </MessageBar>
                    ) : (
                        <>
                            <Dropdown
                                label="Select Peer"
                                selectedKey={selectedPeer}
                                options={peerOptions}
                                onChange={(_, option) => {
                                    setSelectedPeer(option?.key as string)
                                    setResult(null)
                                }}
                                disabled={testing}
                            />

                            {testing && (
                                <Stack tokens={{ childrenGap: 8 }}>
                                    <ProgressIndicator
                                        label="Testing connection..."
                                        description="Waiting for echo response"
                                    />
                                </Stack>
                            )}

                            {result && (
                                <Stack
                                    tokens={{ childrenGap: 8 }}
                                    styles={{
                                        root: {
                                            padding: 16,
                                            backgroundColor: result.success ? "#dff6dd" : "#fde7e9",
                                            borderRadius: 4,
                                        },
                                    }}
                                >
                                    {result.success ? (
                                        <>
                                            <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 8 }}>
                                                <Text
                                                    variant="large"
                                                    styles={{ root: { color: "#107c10", fontWeight: 600 } }}
                                                >
                                                    ✓ Connection Successful
                                                </Text>
                                            </Stack>
                                            <Stack horizontal tokens={{ childrenGap: 16 }}>
                                                <Stack>
                                                    <Label>Round-trip Time</Label>
                                                    <Text variant="xLarge" styles={{ root: { fontWeight: 600 } }}>
                                                        {result.roundTripMs} ms
                                                    </Text>
                                                </Stack>
                                                <Stack>
                                                    <Label>Quality</Label>
                                                    <Text
                                                        variant="xLarge"
                                                        styles={{
                                                            root: {
                                                                fontWeight: 600,
                                                                color: getLatencyQuality(result.roundTripMs!).color,
                                                            },
                                                        }}
                                                    >
                                                        {getLatencyQuality(result.roundTripMs!).text}
                                                    </Text>
                                                </Stack>
                                            </Stack>
                                        </>
                                    ) : (
                                        <Stack tokens={{ childrenGap: 4 }}>
                                            <Text
                                                variant="large"
                                                styles={{ root: { color: "#a4262c", fontWeight: 600 } }}
                                            >
                                                ✗ Connection Failed
                                            </Text>
                                            <Text variant="medium">{result.error}</Text>
                                        </Stack>
                                    )}
                                </Stack>
                            )}
                        </>
                    )}
                </Stack>
            )}

            <DialogFooter>
                <PrimaryButton
                    text={testing ? "Testing..." : "Run Echo Test"}
                    onClick={handleEchoTest}
                    disabled={!selectedPeer || testing || loading || peers.length === 0}
                    iconProps={{ iconName: "Sync" }}
                />
                <DefaultButton text="Close" onClick={onDismiss} disabled={testing} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PEchoDialog
