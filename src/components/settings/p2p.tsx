import React, { useState, useEffect, useRef } from "react"
import intl from "react-intl-universal"
import {
    Stack,
    Label,
    Dropdown,
    IDropdownOption,
    PrimaryButton,
    DefaultButton,
    DetailsList,
    DetailsListLayoutMode,
    SelectionMode,
    IColumn,
    IconButton,
    Dialog,
    DialogType,
    DialogFooter,
    TextField,
    MessageBar,
    MessageBarType,
    Spinner,
    SpinnerSize,
    Toggle,
    Text,
} from "@fluentui/react"
import { KnownPeer, P2PConfig, ConnectionInfo } from "../../bridges/p2p"
import { p2pConnectionManager } from "../../scripts/p2p-connection"

// P2P Settings Component
export const P2PSettings: React.FC = () => {
    const [config, setConfig] = useState<P2PConfig>({
        enabled: false,
        receiveMode: "ask",
        defaultOpenAction: "article",
    })
    const [peers, setPeers] = useState<KnownPeer[]>([])
    const [activeConnections, setActiveConnections] = useState<ConnectionInfo[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [successMessage, setSuccessMessage] = useState<string | null>(null)

    // Dialog states
    const [showAddDialog, setShowAddDialog] = useState(false)
    const [showJoinDialog, setShowJoinDialog] = useState(false)
    const [showConnectDialog, setShowConnectDialog] = useState(false)
    const [showAcceptDialog, setShowAcceptDialog] = useState(false)
    
    // Form states
    const [roomCode, setRoomCode] = useState("")
    const [peerName, setPeerName] = useState("")
    const [generatedCode, setGeneratedCode] = useState("")
    const [connecting, setConnecting] = useState(false)
    
    // Connection states
    const [selectedPeer, setSelectedPeer] = useState<KnownPeer | null>(null)
    const [offerJson, setOfferJson] = useState("")
    const [answerJson, setAnswerJson] = useState("")
    const [waitingForAnswer, setWaitingForAnswer] = useState(false)
    const [incomingOffer, setIncomingOffer] = useState("")

    // Load config and peers on mount
    useEffect(() => {
        loadData()
        
        // Setup connection state listener using the Renderer-side manager
        p2pConnectionManager.setOnConnectionStateChange((info) => {
            console.log("[P2P UI] Connection state changed:", info)
            refreshConnectionState()
            if (info.connected) {
                setSuccessMessage(`Connected to ${info.displayName}!`)
                setShowConnectDialog(false)
                setShowAcceptDialog(false)
                setWaitingForAnswer(false)
            }
        })
        
        p2pConnectionManager.setOnError((peerHash, displayName, error) => {
            setError(`Connection error with ${displayName}: ${error}`)
            setConnecting(false)
            setWaitingForAnswer(false)
        })
        
        return () => {
            // Cleanup is handled by the manager
        }
    }, [])

    const loadData = async () => {
        try {
            setLoading(true)
            const [configData, peersData] = await Promise.all([
                window.p2p.getConfig(),
                window.p2p.getPeers(),
            ])
            setConfig(configData)
            setPeers(peersData)
            refreshConnectionState()
            setError(null)
        } catch (err) {
            setError("Failed to load P2P settings")
            console.error("P2P settings load error:", err)
        } finally {
            setLoading(false)
        }
    }
    
    const refreshConnectionState = () => {
        // Get connections directly from the Renderer-side manager
        const connections = p2pConnectionManager.getActiveConnections()
        setActiveConnections(connections)
    }
    
    const isConnected = (peerHash: string): boolean => {
        return p2pConnectionManager.isConnected(peerHash)
    }

    const handleToggleEnabled = async (checked: boolean) => {
        try {
            const newConfig = await window.p2p.setConfig({ enabled: checked })
            setConfig(newConfig)
        } catch (err) {
            setError("Failed to toggle P2P")
        }
    }

    const handleCreateRoom = async () => {
        try {
            setConnecting(true)
            const code = await window.p2p.generateRoomCode()
            setGeneratedCode(code)
        } catch (err) {
            setError("Failed to create room")
        } finally {
            setConnecting(false)
        }
    }

    const handleJoinRoom = async () => {
        if (!roomCode || !peerName) return

        try {
            setConnecting(true)
            // Generate peer data
            const peerId = await window.p2p.generatePeerId()
            const peerHash = await window.p2p.generatePeerHash(roomCode, peerId)
            const newPeer: KnownPeer = {
                id: peerId,
                displayName: peerName,
                peerHash: peerHash,
                sharedSecret: roomCode,
                createdAt: Date.now(),
                lastSeen: Date.now(),
            }
            await window.p2p.addPeer(newPeer)
            await loadData()
            setShowJoinDialog(false)
            setRoomCode("")
            setPeerName("")
        } catch (err) {
            setError("Failed to join room")
        } finally {
            setConnecting(false)
        }
    }

    const handleRemovePeer = async (peerHash: string) => {
        try {
            // Disconnect first if connected
            if (isConnected(peerHash)) {
                p2pConnectionManager.disconnect(peerHash)
            }
            await window.p2p.removePeer(peerHash)
            setPeers(peers.filter((p) => p.peerHash !== peerHash))
        } catch (err) {
            setError("Failed to remove peer")
        }
    }
    
    // Start connection as initiator
    const handleStartConnect = async (peer: KnownPeer) => {
        setSelectedPeer(peer)
        setShowConnectDialog(true)
        setOfferJson("")
        setAnswerJson("")
        setWaitingForAnswer(false)
        
        try {
            setConnecting(true)
            const offer = await p2pConnectionManager.createOffer(peer.peerHash, peer.displayName)
            setOfferJson(offer)
            setWaitingForAnswer(true)
        } catch (err) {
            setError("Failed to create connection offer")
            setShowConnectDialog(false)
        } finally {
            setConnecting(false)
        }
    }
    
    // Apply answer from peer (complete connection as initiator)
    const handleApplyAnswer = async () => {
        if (!selectedPeer || !answerJson) return
        
        try {
            setConnecting(true)
            const success = p2pConnectionManager.completeConnection(selectedPeer.peerHash, answerJson)
            if (!success) {
                setError("Failed to apply answer - invalid format")
            }
            // Connection state change will close dialog
        } catch (err) {
            setError("Failed to complete connection")
        } finally {
            setConnecting(false)
        }
    }
    
    // Accept incoming offer (as receiver)
    const handleAcceptOffer = async () => {
        if (!selectedPeer || !incomingOffer) return
        
        try {
            setConnecting(true)
            const answer = await p2pConnectionManager.acceptOffer(incomingOffer, selectedPeer.peerHash, selectedPeer.displayName)
            setAnswerJson(answer)
        } catch (err) {
            setError("Failed to accept offer - invalid format")
        } finally {
            setConnecting(false)
        }
    }
    
    // Disconnect from peer
    const handleDisconnect = (peerHash: string) => {
        try {
            p2pConnectionManager.disconnect(peerHash)
            refreshConnectionState()
        } catch (err) {
            setError("Failed to disconnect")
        }
    }

    const columns: IColumn[] = [
        {
            key: "status",
            name: "",
            minWidth: 24,
            maxWidth: 24,
            onRender: (item: KnownPeer) => (
                <div style={{ 
                    width: 12, 
                    height: 12, 
                    borderRadius: "50%", 
                    backgroundColor: isConnected(item.peerHash) ? "#107c10" : "#d83b01",
                    marginTop: 4
                }} 
                title={isConnected(item.peerHash) ? "Connected" : "Disconnected"} />
            ),
        },
        {
            key: "name",
            name: "Name",
            fieldName: "displayName",
            minWidth: 100,
            maxWidth: 150,
        },
        {
            key: "lastSeen",
            name: "Last Seen",
            minWidth: 100,
            maxWidth: 130,
            onRender: (item: KnownPeer) => {
                if (!item.lastSeen) return "Never"
                const date = new Date(item.lastSeen)
                return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            },
        },
        {
            key: "connect",
            name: "",
            minWidth: 90,
            maxWidth: 90,
            onRender: (item: KnownPeer) => (
                isConnected(item.peerHash) ? (
                    <DefaultButton
                        text="Disconnect"
                        onClick={() => handleDisconnect(item.peerHash)}
                        styles={{ root: { minWidth: 80, height: 24 } }}
                    />
                ) : (
                    <PrimaryButton
                        text="Connect"
                        onClick={() => handleStartConnect(item)}
                        styles={{ root: { minWidth: 80, height: 24 } }}
                        disabled={!config.enabled}
                    />
                )
            ),
        },
        {
            key: "accept",
            name: "",
            minWidth: 70,
            maxWidth: 70,
            onRender: (item: KnownPeer) => (
                !isConnected(item.peerHash) && (
                    <DefaultButton
                        text="Accept"
                        onClick={() => {
                            setSelectedPeer(item)
                            setIncomingOffer("")
                            setAnswerJson("")
                            setShowAcceptDialog(true)
                        }}
                        styles={{ root: { minWidth: 60, height: 24 } }}
                        disabled={!config.enabled}
                    />
                )
            ),
        },
        {
            key: "actions",
            name: "",
            minWidth: 40,
            maxWidth: 40,
            onRender: (item: KnownPeer) => (
                <IconButton
                    iconProps={{ iconName: "Delete" }}
                    title="Remove peer"
                    onClick={() => handleRemovePeer(item.peerHash)}
                />
            ),
        },
    ]

    if (loading) {
        return (
            <Stack horizontalAlign="center" verticalAlign="center" styles={{ root: { height: 200 } }}>
                <Spinner size={SpinnerSize.large} label="Loading P2P settings..." />
            </Stack>
        )
    }

    return (
        <Stack tokens={{ childrenGap: 16 }} styles={{ root: { padding: 16 } }}>
            <Label styles={{ root: { fontSize: 18, fontWeight: 600 } }}>
                P2P Article Sharing
            </Label>

            {error && (
                <MessageBar
                    messageBarType={MessageBarType.error}
                    onDismiss={() => setError(null)}
                >
                    {error}
                </MessageBar>
            )}

            <Toggle
                label="Enable P2P Sharing"
                checked={config.enabled}
                onChange={(_, checked) => handleToggleEnabled(checked ?? false)}
            />

            <Stack horizontal tokens={{ childrenGap: 8 }}>
                <PrimaryButton
                    text="Create Room"
                    iconProps={{ iconName: "Add" }}
                    onClick={() => {
                        handleCreateRoom()
                        setShowAddDialog(true)
                    }}
                    disabled={!config.enabled}
                />
                <DefaultButton
                    text="Join Room"
                    iconProps={{ iconName: "PlugConnected" }}
                    onClick={() => setShowJoinDialog(true)}
                    disabled={!config.enabled}
                />
            </Stack>

            <Label>Known Peers</Label>
            {peers.length === 0 ? (
                <MessageBar>No peers configured yet. Create or join a room to add peers.</MessageBar>
            ) : (
                <DetailsList
                    items={peers}
                    columns={columns}
                    layoutMode={DetailsListLayoutMode.justified}
                    selectionMode={SelectionMode.none}
                />
            )}

            {/* Create Room Dialog */}
            <Dialog
                hidden={!showAddDialog}
                onDismiss={() => {
                    setShowAddDialog(false)
                    setGeneratedCode("")
                }}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: "Create P2P Room",
                    subText: "Share this code with another Fluent Reader user to connect.",
                }}
            >
                {connecting ? (
                    <Spinner size={SpinnerSize.medium} label="Generating code..." />
                ) : generatedCode ? (
                    <Stack tokens={{ childrenGap: 8 }}>
                        <TextField
                            label="Room Code"
                            value={generatedCode}
                            readOnly
                            styles={{ field: { fontSize: 24, textAlign: "center", letterSpacing: "4px" } }}
                        />
                        <DefaultButton
                            text="Copy Code"
                            iconProps={{ iconName: "Copy" }}
                            onClick={() => navigator.clipboard.writeText(generatedCode)}
                        />
                    </Stack>
                ) : null}
                <DialogFooter>
                    <DefaultButton
                        text="Close"
                        onClick={() => {
                            setShowAddDialog(false)
                            setGeneratedCode("")
                        }}
                    />
                </DialogFooter>
            </Dialog>

            {/* Join Room Dialog */}
            <Dialog
                hidden={!showJoinDialog}
                onDismiss={() => setShowJoinDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: "Join P2P Room",
                    subText: "Enter the room code from another Fluent Reader user.",
                }}
            >
                <Stack tokens={{ childrenGap: 8 }}>
                    <TextField
                        label="Peer Name"
                        value={peerName}
                        onChange={(_, value) => setPeerName(value ?? "")}
                        placeholder="Friend's Computer"
                    />
                    <TextField
                        label="Room Code"
                        value={roomCode}
                        onChange={(_, value) => setRoomCode(value?.toUpperCase() ?? "")}
                        placeholder="ABC123"
                        maxLength={6}
                        styles={{ field: { fontSize: 18, textAlign: "center", letterSpacing: "4px" } }}
                    />
                </Stack>
                <DialogFooter>
                    <PrimaryButton
                        text="Join"
                        onClick={handleJoinRoom}
                        disabled={!roomCode || !peerName || connecting}
                    />
                    <DefaultButton text="Cancel" onClick={() => setShowJoinDialog(false)} />
                </DialogFooter>
            </Dialog>
            
            {/* Connect Dialog (Initiator) */}
            <Dialog
                hidden={!showConnectDialog}
                onDismiss={() => {
                    setShowConnectDialog(false)
                    setWaitingForAnswer(false)
                }}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: `Connect to ${selectedPeer?.displayName}`,
                    subText: waitingForAnswer 
                        ? "Send the offer to your peer and paste their answer below."
                        : "Creating connection offer...",
                }}
                modalProps={{ isBlocking: true }}
            >
                {connecting && !waitingForAnswer ? (
                    <Spinner size={SpinnerSize.medium} label="Creating offer..." />
                ) : waitingForAnswer ? (
                    <Stack tokens={{ childrenGap: 12 }}>
                        <Stack tokens={{ childrenGap: 4 }}>
                            <Label>1. Send this offer to your peer:</Label>
                            <TextField
                                value={offerJson}
                                readOnly
                                multiline
                                rows={3}
                                styles={{ field: { fontFamily: "monospace", fontSize: 10 } }}
                            />
                            <DefaultButton
                                text="Copy Offer"
                                iconProps={{ iconName: "Copy" }}
                                onClick={() => {
                                    navigator.clipboard.writeText(offerJson)
                                    setSuccessMessage("Offer copied to clipboard!")
                                }}
                            />
                        </Stack>
                        <Stack tokens={{ childrenGap: 4 }}>
                            <Label>2. Paste the answer from your peer:</Label>
                            <TextField
                                value={answerJson}
                                onChange={(_, v) => setAnswerJson(v ?? "")}
                                multiline
                                rows={3}
                                placeholder="Paste answer JSON here..."
                                styles={{ field: { fontFamily: "monospace", fontSize: 10 } }}
                            />
                        </Stack>
                    </Stack>
                ) : null}
                <DialogFooter>
                    {waitingForAnswer && (
                        <PrimaryButton
                            text="Complete Connection"
                            onClick={handleApplyAnswer}
                            disabled={!answerJson || connecting}
                        />
                    )}
                    <DefaultButton
                        text="Cancel"
                        onClick={() => {
                            setShowConnectDialog(false)
                            setWaitingForAnswer(false)
                            if (selectedPeer) {
                                p2pConnectionManager.disconnect(selectedPeer.peerHash)
                            }
                        }}
                    />
                </DialogFooter>
            </Dialog>
            
            {/* Accept Dialog (Receiver) */}
            <Dialog
                hidden={!showAcceptDialog}
                onDismiss={() => setShowAcceptDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: `Accept connection from ${selectedPeer?.displayName}`,
                    subText: answerJson 
                        ? "Send the answer back to your peer to complete the connection."
                        : "Paste the offer from your peer below.",
                }}
                modalProps={{ isBlocking: true }}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    {!answerJson ? (
                        <Stack tokens={{ childrenGap: 4 }}>
                            <Label>1. Paste the offer from your peer:</Label>
                            <TextField
                                value={incomingOffer}
                                onChange={(_, v) => setIncomingOffer(v ?? "")}
                                multiline
                                rows={3}
                                placeholder="Paste offer JSON here..."
                                styles={{ field: { fontFamily: "monospace", fontSize: 10 } }}
                            />
                        </Stack>
                    ) : (
                        <Stack tokens={{ childrenGap: 4 }}>
                            <Label>2. Send this answer back to your peer:</Label>
                            <TextField
                                value={answerJson}
                                readOnly
                                multiline
                                rows={3}
                                styles={{ field: { fontFamily: "monospace", fontSize: 10 } }}
                            />
                            <DefaultButton
                                text="Copy Answer"
                                iconProps={{ iconName: "Copy" }}
                                onClick={() => {
                                    navigator.clipboard.writeText(answerJson)
                                    setSuccessMessage("Answer copied to clipboard!")
                                }}
                            />
                            <MessageBar messageBarType={MessageBarType.info}>
                                After sending the answer, the connection will establish automatically.
                            </MessageBar>
                        </Stack>
                    )}
                </Stack>
                <DialogFooter>
                    {!answerJson && (
                        <PrimaryButton
                            text="Accept Offer"
                            onClick={handleAcceptOffer}
                            disabled={!incomingOffer || connecting}
                        />
                    )}
                    <DefaultButton
                        text="Close"
                        onClick={() => setShowAcceptDialog(false)}
                    />
                </DialogFooter>
            </Dialog>
            
            {/* Success Message */}
            {successMessage && (
                <Dialog
                    hidden={false}
                    onDismiss={() => setSuccessMessage(null)}
                    dialogContentProps={{
                        type: DialogType.normal,
                        title: "Success",
                    }}
                >
                    <Text>{successMessage}</Text>
                    <DialogFooter>
                        <PrimaryButton text="OK" onClick={() => setSuccessMessage(null)} />
                    </DialogFooter>
                </Dialog>
            )}
        </Stack>
    )
}

export default P2PSettings
