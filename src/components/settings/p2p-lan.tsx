/**
 * P2P LAN Settings Component
 * 
 * Simple room-based peer discovery in local network.
 * Just enter a room code and peers are discovered automatically!
 */
import React, { useState, useEffect, useRef } from "react"
import intl from "react-intl-universal"
import {
    Stack,
    Label,
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
    useTheme,
} from "@fluentui/react"
import { P2PStatus, P2PPeer } from "../../bridges/p2p-lan"

export const P2PLanSettings: React.FC = () => {
    const theme = useTheme()
    const [status, setStatus] = useState<P2PStatus>({
        inRoom: false,
        roomCode: null,
        peers: []
    })
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [successMessage, setSuccessMessage] = useState<string | null>(null)
    const [collectLinks, setCollectLinks] = useState(false)
    
    // Dialog states
    const [showCreateDialog, setShowCreateDialog] = useState(false)
    const [showJoinDialog, setShowJoinDialog] = useState(false)
    
    // Form states
    const [roomCode, setRoomCode] = useState("")
    const [displayName, setDisplayName] = useState("Fluent Reader")
    const [generatedCode, setGeneratedCode] = useState("")
    const [joining, setJoining] = useState(false)

    // Load status on mount and setup listeners
    useEffect(() => {
        loadStatus()
        setCollectLinks(window.settings.getP2PCollectLinks())
        
        // Listen for connection state changes
        const unsubscribe = window.p2pLan.onConnectionStateChanged((newStatus) => {
            console.log("[P2P-LAN UI] State changed:", newStatus)
            setStatus(newStatus)
            
            // Show notification when peers connect
            const connectedCount = newStatus.peers.filter(p => p.connected).length
            if (connectedCount > 0) {
                setSuccessMessage(`${connectedCount} peer(s) connected!`)
            }
        })
        
        return () => {
            unsubscribe()
        }
    }, [])

    const handleCollectLinksChange = (checked: boolean) => {
        setCollectLinks(checked)
        window.settings.setP2PCollectLinks(checked)
    }
    
    const loadStatus = async () => {
        try {
            setLoading(true)
            const currentStatus = await window.p2pLan.getStatus()
            setStatus(currentStatus)
            setError(null)
        } catch (err) {
            setError("Failed to load P2P status")
            console.error("[P2P-LAN UI] Error:", err)
        } finally {
            setLoading(false)
        }
    }
    
    // Generate a random room code
    const generateRoomCode = (): string => {
        const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
        let code = ""
        for (let i = 0; i < 6; i++) {
            code += chars[Math.floor(Math.random() * chars.length)]
        }
        return code
    }
    
    const handleCreateRoom = () => {
        const code = generateRoomCode()
        setGeneratedCode(code)
        setShowCreateDialog(true)
    }
    
    const handleJoinWithCode = async (code: string) => {
        if (!code || !displayName) return
        
        try {
            setJoining(true)
            setError(null)
            
            const success = await window.p2pLan.joinRoom(code.toUpperCase(), displayName)
            
            if (success) {
                setSuccessMessage(`Joined room ${code.toUpperCase()}! Searching for peers...`)
                setShowCreateDialog(false)
                setShowJoinDialog(false)
                setRoomCode("")
                setGeneratedCode("")
            } else {
                setError("Failed to join room. Check your network connection.")
            }
        } catch (err) {
            setError("Failed to join room")
            console.error("[P2P-LAN UI] Join error:", err)
        } finally {
            setJoining(false)
        }
    }
    
    const handleLeaveRoom = async () => {
        try {
            await window.p2pLan.leaveRoom()
            setSuccessMessage("Left room")
            await loadStatus()
        } catch (err) {
            setError("Failed to leave room")
        }
    }

    const columns: IColumn[] = [
        {
            key: "status",
            name: "",
            minWidth: 24,
            maxWidth: 24,
            onRender: (item: P2PPeer) => (
                <div style={{ 
                    width: 12, 
                    height: 12, 
                    borderRadius: "50%", 
                    backgroundColor: item.connected ? "#107c10" : "#ffb900",
                    marginTop: 4
                }} 
                title={item.connected ? "Connected" : "Discovered (connecting...)"} />
            ),
        },
        {
            key: "name",
            name: "Name",
            fieldName: "displayName",
            minWidth: 150,
            maxWidth: 200,
        },
        {
            key: "peerId",
            name: "Peer ID",
            minWidth: 100,
            maxWidth: 150,
            onRender: (item: P2PPeer) => (
                <Text variant="small" styles={{ root: { fontFamily: "monospace", color: "#666" } }}>
                    {item.peerId.substring(0, 8)}...
                </Text>
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

    const connectedCount = status.peers.filter(p => p.connected).length

    return (
        <Stack tokens={{ childrenGap: 16 }} styles={{ root: { padding: 16 } }}>
            <Label styles={{ root: { fontSize: 18, fontWeight: 600 } }}>
                P2P LAN Sharing
            </Label>
            
            <Text variant="medium" styles={{ root: { color: "#666" } }}>
                Share articles with other Fluent Reader instances on your local network.
                Just use the same room code and you'll be connected automatically!
            </Text>

            {error && (
                <MessageBar
                    messageBarType={MessageBarType.error}
                    onDismiss={() => setError(null)}
                >
                    {error}
                </MessageBar>
            )}
            
            {successMessage && (
                <MessageBar
                    messageBarType={MessageBarType.success}
                    onDismiss={() => setSuccessMessage(null)}
                >
                    {successMessage}
                </MessageBar>
            )}

            {/* Current Status */}
            {status.inRoom ? (
                <Stack tokens={{ childrenGap: 12 }}>
                    <MessageBar messageBarType={MessageBarType.info}>
                        <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 8 }}>
                            <Text>Room:</Text>
                            <Text styles={{ root: { fontWeight: 600, fontFamily: "monospace", fontSize: 16, letterSpacing: "2px" } }}>
                                {status.roomCode}
                            </Text>
                            <Text>•</Text>
                            <Text>{connectedCount} peer(s) connected</Text>
                        </Stack>
                    </MessageBar>
                    
                    <DefaultButton
                        text="Leave Room"
                        iconProps={{ iconName: "SignOut" }}
                        onClick={handleLeaveRoom}
                    />
                </Stack>
            ) : (
                <Stack horizontal tokens={{ childrenGap: 8 }}>
                    <PrimaryButton
                        text="Create Room"
                        iconProps={{ iconName: "Add" }}
                        onClick={handleCreateRoom}
                    />
                    <DefaultButton
                        text="Join Room"
                        iconProps={{ iconName: "PlugConnected" }}
                        onClick={() => setShowJoinDialog(true)}
                    />
                </Stack>
            )}

            {/* Receive behavior toggle */}
            <Toggle
                label="Collect received links in notification bell"
                checked={collectLinks}
                onChange={(_, checked) => handleCollectLinksChange(checked || false)}
                onText="Collect in bell (no dialog)"
                offText="Show dialog immediately"
            />

            {/* Peers List */}
            {status.inRoom && (
                <>
                    <Label>Peers in Room</Label>
                    {status.peers.length === 0 ? (
                        <MessageBar>
                            <Stack horizontal verticalAlign="center" tokens={{ childrenGap: 8 }}>
                                <Spinner size={SpinnerSize.small} />
                                <Text>Searching for peers on local network...</Text>
                            </Stack>
                        </MessageBar>
                    ) : (
                        <DetailsList
                            items={status.peers}
                            columns={columns}
                            layoutMode={DetailsListLayoutMode.justified}
                            selectionMode={SelectionMode.none}
                        />
                    )}
                </>
            )}

            {/* Create Room Dialog */}
            <Dialog
                hidden={!showCreateDialog}
                onDismiss={() => setShowCreateDialog(false)}
                dialogContentProps={{
                    type: DialogType.normal,
                    title: "Create P2P Room",
                    subText: "Share this code with others to connect.",
                }}
            >
                <Stack tokens={{ childrenGap: 12 }}>
                    <TextField
                        label="Your Display Name"
                        value={displayName}
                        onChange={(_, v) => setDisplayName(v || "")}
                        placeholder="My Computer"
                    />
                    
                    <Stack tokens={{ childrenGap: 4 }}>
                        <Label>Room Code</Label>
                        <Text 
                            variant="xxLarge" 
                            styles={{ 
                                root: { 
                                    fontFamily: "monospace", 
                                    letterSpacing: "8px",
                                    textAlign: "center",
                                    padding: 16,
                                    backgroundColor: theme.palette.neutralLighter,
                                    color: theme.palette.neutralPrimary,
                                    borderRadius: 4
                                } 
                            }}
                        >
                            {generatedCode}
                        </Text>
                        <DefaultButton
                            text="Copy Code"
                            iconProps={{ iconName: "Copy" }}
                            onClick={() => {
                                navigator.clipboard.writeText(generatedCode)
                                setSuccessMessage("Code copied!")
                            }}
                        />
                    </Stack>
                </Stack>
                <DialogFooter>
                    <PrimaryButton
                        text={joining ? "Joining..." : "Join Room"}
                        onClick={() => handleJoinWithCode(generatedCode)}
                        disabled={joining || !displayName}
                    />
                    <DefaultButton text="Cancel" onClick={() => setShowCreateDialog(false)} />
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
                <Stack tokens={{ childrenGap: 12 }}>
                    <TextField
                        label="Your Display Name"
                        value={displayName}
                        onChange={(_, v) => setDisplayName(v || "")}
                        placeholder="My Computer"
                    />
                    <TextField
                        label="Room Code"
                        value={roomCode}
                        onChange={(_, v) => setRoomCode(v?.toUpperCase() || "")}
                        placeholder="ABC123"
                        maxLength={6}
                        styles={{ field: { fontSize: 18, textAlign: "center", letterSpacing: "4px", fontFamily: "monospace" } }}
                    />
                </Stack>
                <DialogFooter>
                    <PrimaryButton
                        text={joining ? "Joining..." : "Join"}
                        onClick={() => handleJoinWithCode(roomCode)}
                        disabled={joining || !roomCode || roomCode.length < 4 || !displayName}
                    />
                    <DefaultButton text="Cancel" onClick={() => setShowJoinDialog(false)} />
                </DialogFooter>
            </Dialog>
        </Stack>
    )
}

export default P2PLanSettings
