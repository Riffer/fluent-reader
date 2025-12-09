/**
 * P2P Echo Dialog - LAN Version
 * 
 * Test connection latency with peers in the same room.
 */
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
import { P2PStatus, P2PPeer } from "../bridges/p2p-lan"

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
    const [status, setStatus] = useState<P2PStatus | null>(null)
    const [selectedPeer, setSelectedPeer] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [testing, setTesting] = useState(false)
    const [result, setResult] = useState<EchoResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const echoTimeout = useRef<NodeJS.Timeout | null>(null)

    useEffect(() => {
        if (!hidden) {
            loadStatus()
            setResult(null)
            setError(null)
            
            // Listen for echo responses
            window.p2pLan.onEchoResponse((data) => {
                console.log("[P2P Echo] Response received:", data)
                setResult({
                    success: true,
                    roundTripMs: data.roundTripMs,
                })
                setTesting(false)
                if (echoTimeout.current) {
                    clearTimeout(echoTimeout.current)
                    echoTimeout.current = null
                }
            })
        }
        
        return () => {
            if (echoTimeout.current) {
                clearTimeout(echoTimeout.current)
            }
        }
    }, [hidden])

    const loadStatus = async () => {
        try {
            setLoading(true)
            const currentStatus = await window.p2pLan.getStatus()
            setStatus(currentStatus)
            
            // Auto-select first connected peer
            const connectedPeer = currentStatus.peers.find(p => p.connected)
            if (connectedPeer) {
                setSelectedPeer(connectedPeer.peerId)
            }
        } catch (err) {
            setError("Failed to load P2P status")
        } finally {
            setLoading(false)
        }
    }

    const handleEchoTest = async () => {
        if (!selectedPeer) return
        
        const peer = status?.peers.find(p => p.peerId === selectedPeer)
        if (!peer?.connected) {
            setResult({
                success: false,
                error: "Peer is not connected."
            })
            return
        }

        try {
            setTesting(true)
            setResult(null)
            setError(null)
            
            const sent = await window.p2pLan.sendEcho(selectedPeer)
            
            if (!sent) {
                setResult({
                    success: false,
                    error: "Failed to send echo request."
                })
                setTesting(false)
                return
            }
            
            // Set timeout for response
            echoTimeout.current = setTimeout(() => {
                setResult({
                    success: false,
                    error: "Echo timeout - no response received within 10 seconds."
                })
                setTesting(false)
            }, 10000)
            
        } catch (err) {
            setResult({
                success: false,
                error: "Connection failed.",
            })
            setTesting(false)
        }
    }

    const peerOptions: IDropdownOption[] = (status?.peers ?? []).map((peer) => ({
        key: peer.peerId,
        text: `${peer.displayName}${peer.connected ? " ✓" : " (not connected)"}`,
        disabled: !peer.connected,
    }))

    const connectedCount = status?.peers.filter(p => p.connected).length ?? 0

    const getLatencyQuality = (ms: number): { text: string; color: string } => {
        if (ms < 50) return { text: "Excellent", color: "#107c10" }
        if (ms < 150) return { text: "Good", color: "#498205" }
        if (ms < 300) return { text: "Fair", color: "#ffb900" }
        return { text: "Poor", color: "#d13438" }
    }

    return (
        <Dialog
            hidden={hidden}
            onDismiss={onDismiss}
            dialogContentProps={{
                type: DialogType.normal,
                title: "P2P Echo Test",
                subText: "Test the connection latency to a peer.",
            }}
            minWidth={400}
        >
            {loading ? (
                <Stack horizontalAlign="center" styles={{ root: { padding: 20 } }}>
                    <Spinner size={SpinnerSize.medium} label="Loading..." />
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

                    {!status?.inRoom ? (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            You're not in a P2P room. Go to Settings → P2P Share to join.
                        </MessageBar>
                    ) : connectedCount === 0 ? (
                        <MessageBar messageBarType={MessageBarType.warning}>
                            No peers connected. Make sure another device is in the same room.
                        </MessageBar>
                    ) : (
                        <>
                            <Dropdown
                                label="Select Peer"
                                selectedKey={selectedPeer}
                                options={peerOptions}
                                onChange={(_, option) => setSelectedPeer(option?.key as string)}
                                disabled={testing}
                            />

                            {testing && (
                                <Stack tokens={{ childrenGap: 8 }}>
                                    <ProgressIndicator label="Waiting for echo response..." />
                                </Stack>
                            )}

                            {result && (
                                <Stack
                                    tokens={{ childrenGap: 8 }}
                                    styles={{
                                        root: {
                                            padding: 16,
                                            backgroundColor: result.success ? "#f0fff0" : "#fff0f0",
                                            borderRadius: 4,
                                        },
                                    }}
                                >
                                    {result.success ? (
                                        <>
                                            <Stack horizontal tokens={{ childrenGap: 8 }} verticalAlign="center">
                                                <Text variant="xLarge" styles={{ root: { fontWeight: 600 } }}>
                                                    {result.roundTripMs} ms
                                                </Text>
                                                <Text
                                                    styles={{
                                                        root: {
                                                            color: getLatencyQuality(result.roundTripMs!).color,
                                                            fontWeight: 600,
                                                        },
                                                    }}
                                                >
                                                    ({getLatencyQuality(result.roundTripMs!).text})
                                                </Text>
                                            </Stack>
                                            <Text variant="small" styles={{ root: { color: "#666" } }}>
                                                Round-trip time to peer
                                            </Text>
                                        </>
                                    ) : (
                                        <Text styles={{ root: { color: "#d13438" } }}>
                                            {result.error}
                                        </Text>
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
                    disabled={!selectedPeer || testing || !status?.inRoom || connectedCount === 0}
                />
                <DefaultButton text="Close" onClick={onDismiss} disabled={testing} />
            </DialogFooter>
        </Dialog>
    )
}

export default P2PEchoDialog
