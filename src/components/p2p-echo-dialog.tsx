import React, { useState, useEffect, useRef } from "react"
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
import { KnownPeer, ConnectionInfo, ShareMessage } from "../bridges/p2p"
import { p2pConnectionManager } from "../scripts/p2p-connection"

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
    const [connections, setConnections] = useState<ConnectionInfo[]>([])
    const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [testing, setTesting] = useState(false)
    const [result, setResult] = useState<EchoResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const echoTimestamp = useRef<number>(0)
    const echoTimeout = useRef<NodeJS.Timeout | null>(null)

    useEffect(() => {
        if (!hidden) {
            loadData()
            setResult(null)
            setError(null)
            
            // Setup echo response listener using the connection manager
            p2pConnectionManager.setOnMessage((peerHash, message) => {
                if (message.type === "echo-response" && echoTimestamp.current > 0) {
                    const roundTripMs = Date.now() - echoTimestamp.current
                    setResult({
                        success: true,
                        roundTripMs,
                    })
                    setTesting(false)
                    echoTimestamp.current = 0
                    if (echoTimeout.current) {
                        clearTimeout(echoTimeout.current)
                        echoTimeout.current = null
                    }
                }
            })
        }
        
        return () => {
            if (echoTimeout.current) {
                clearTimeout(echoTimeout.current)
            }
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

    const handleEchoTest = async () => {
        if (!selectedPeer) return
        
        // Check if peer is connected
        if (!isConnected(selectedPeer)) {
            setResult({
                success: false,
                error: "Peer is not connected. Connect first in Settings → P2P Share."
            })
            return
        }

        try {
            setTesting(true)
            setResult(null)
            setError(null)

            // Record start time
            echoTimestamp.current = Date.now()
            
            // Create echo request message
            const message: ShareMessage = {
                type: "echo-request",
                senderHash: "local",
                senderName: "Fluent Reader",
                timestamp: echoTimestamp.current
            }
            
            // Send echo request using the Renderer-side manager
            const sent = p2pConnectionManager.sendMessage(selectedPeer, message)
            
            if (!sent) {
                setResult({
                    success: false,
                    error: "Failed to send echo request. Connection may have been lost."
                })
                setTesting(false)
                echoTimestamp.current = 0
                return
            }
            
            // Set timeout for response
            echoTimeout.current = setTimeout(() => {
                if (testing) {
                    setResult({
                        success: false,
                        error: "Echo timeout - no response received within 10 seconds."
                    })
                    setTesting(false)
                    echoTimestamp.current = 0
                }
            }, 10000)
            
        } catch (err) {
            setResult({
                success: false,
                error: "Connection failed. Peer may be offline.",
            })
            setTesting(false)
            echoTimestamp.current = 0
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
                            No peers configured. Go to Settings → P2P Share to add peers.
                        </MessageBar>
                    ) : !hasConnectedPeers ? (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No peers connected. Go to Settings → P2P Share to connect.
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
                    disabled={!selectedPeer || testing || loading || !hasConnectedPeers}
                    iconProps={{ iconName: "Sync" }}
                />
                <DefaultButton text="Close" onClick={onDismiss} disabled={testing} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PEchoDialog
