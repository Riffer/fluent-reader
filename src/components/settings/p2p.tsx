import React, { useState, useEffect } from "react"
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
} from "@fluentui/react"
import { KnownPeer, P2PConfig } from "../../bridges/p2p"

// P2P Settings Component
export const P2PSettings: React.FC = () => {
    const [config, setConfig] = useState<P2PConfig>({
        enabled: false,
        receiveMode: "ask",
        defaultOpenAction: "article",
    })
    const [peers, setPeers] = useState<KnownPeer[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Dialog states
    const [showAddDialog, setShowAddDialog] = useState(false)
    const [showJoinDialog, setShowJoinDialog] = useState(false)
    const [roomCode, setRoomCode] = useState("")
    const [peerName, setPeerName] = useState("")
    const [generatedCode, setGeneratedCode] = useState("")
    const [connecting, setConnecting] = useState(false)

    // Load config and peers on mount
    useEffect(() => {
        loadData()
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
            setError(null)
        } catch (err) {
            setError("Failed to load P2P settings")
            console.error("P2P settings load error:", err)
        } finally {
            setLoading(false)
        }
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
            await window.p2p.removePeer(peerHash)
            setPeers(peers.filter((p) => p.peerHash !== peerHash))
        } catch (err) {
            setError("Failed to remove peer")
        }
    }

    const columns: IColumn[] = [
        {
            key: "name",
            name: "Name",
            fieldName: "displayName",
            minWidth: 100,
            maxWidth: 200,
        },
        {
            key: "lastSeen",
            name: "Last Seen",
            minWidth: 100,
            maxWidth: 150,
            onRender: (item: KnownPeer) => {
                if (!item.lastSeen) return "Never"
                const date = new Date(item.lastSeen)
                return date.toLocaleDateString() + " " + date.toLocaleTimeString()
            },
        },
        {
            key: "actions",
            name: "",
            minWidth: 50,
            maxWidth: 50,
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
                            styles={{ field: { fontSize: 24, textAlign: "center", letterSpacing: 4 } }}
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
                        styles={{ field: { fontSize: 18, textAlign: "center", letterSpacing: 4 } }}
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
        </Stack>
    )
}

export default P2PSettings
