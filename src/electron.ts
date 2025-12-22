import { app, ipcMain, Menu, nativeTheme, powerMonitor, crashReporter } from "electron"
import { ThemeSettings, SchemaTypes } from "./schema-types"
import { store } from "./main/settings"
import performUpdate from "./main/update-scripts"
import { WindowManager } from "./main/window"
import { initP2P, registerP2PIpcHandlers } from "./main/p2p-share"
import { initP2PLan, registerP2PLanIpcHandlers, shutdownP2P, onSystemSuspend, onSystemResume } from "./main/p2p-lan"

// ===== Chromium-Flags für Visual Zoom (Pinch-to-Zoom) =====
// WICHTIG: Diese müssen VOR app.whenReady() gesetzt werden!
app.commandLine.appendSwitch('enable-pinch');
app.commandLine.appendSwitch('enable-viewport');
app.commandLine.appendSwitch('enable-features', 'PinchToZoom,TouchpadAndWheelScrollLatching');
console.log('[Electron] Visual Zoom Chromium flags enabled');

// ===== Crash Handler und Debugging =====
// Fange unerwartete Exceptions ab
process.on('uncaughtException', (error) => {
    console.error('[CRASH] Uncaught Exception:', error)
    console.error('[CRASH] Stack:', error.stack)
})

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRASH] Unhandled Rejection at:', promise, 'reason:', reason)
})

// Aktiviere Crash Reporter für detaillierte Crash-Dumps
crashReporter.start({
    productName: 'FluentReader',
    submitURL: '', // Keine URL - speichert nur lokal
    uploadToServer: false,
    compress: false,
})
console.log('[CrashReporter] Crash dumps will be saved to:', app.getPath('crashDumps'))

if (!process.mas) {
    const locked = app.requestSingleInstanceLock()
    if (!locked) {
        app.quit()
    }
}

if (!app.isPackaged) app.setAppUserModelId(process.execPath)
else if (process.platform === "win32")
    app.setAppUserModelId("me.hyliu.fluentreader")

let restarting = false

function init() {
    performUpdate(store)
    nativeTheme.themeSource = store.get("theme", ThemeSettings.Default)
    
    // Initialize P2P modules
    initP2P()
    registerP2PIpcHandlers()
    
    // Initialize P2P LAN module (for automatic discovery)
    initP2PLan()
    registerP2PLanIpcHandlers()
}

init()

if (process.platform === "darwin") {
    const template = [
        {
            label: "Application",
            submenu: [
                {
                    label: "Hide",
                    accelerator: "Command+H",
                    click: () => {
                        app.hide()
                    },
                },
                {
                    label: "Quit",
                    accelerator: "Command+Q",
                    click: () => {
                        if (winManager.hasWindow) winManager.mainWindow.close()
                    },
                },
            ],
        },
        {
            label: "Edit",
            submenu: [
                {
                    label: "Undo",
                    accelerator: "CmdOrCtrl+Z",
                    selector: "undo:",
                },
                {
                    label: "Redo",
                    accelerator: "Shift+CmdOrCtrl+Z",
                    selector: "redo:",
                },
                { label: "Cut", accelerator: "CmdOrCtrl+X", selector: "cut:" },
                {
                    label: "Copy",
                    accelerator: "CmdOrCtrl+C",
                    selector: "copy:",
                },
                {
                    label: "Paste",
                    accelerator: "CmdOrCtrl+V",
                    selector: "paste:",
                },
                {
                    label: "Select All",
                    accelerator: "CmdOrCtrl+A",
                    selector: "selectAll:",
                },
            ],
        },
        {
            label: "Window",
            submenu: [
                {
                    label: "Close",
                    accelerator: "Command+W",
                    click: () => {
                        if (winManager.hasWindow) winManager.mainWindow.close()
                    },
                },
                {
                    label: "Minimize",
                    accelerator: "Command+M",
                    click: () => {
                        if (winManager.hasWindow())
                            winManager.mainWindow.minimize()
                    },
                },
                { label: "Zoom", click: () => winManager.zoom() },
            ],
        },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
} else {
    Menu.setApplicationMenu(null)
}

const winManager = new WindowManager()

// GPU-Rendering: Früher deaktiviert wegen Crash-Problemen (exit_code=-1073740791)
// Jetzt wieder aktiviert für flüssigeres Scrolling - bei Problemen auskommentieren
// if (process.platform === "win32") {
//     app.commandLine.appendSwitch("use-gl", "swiftshader");
//     app.commandLine.appendSwitch("disable-gpu-compositing");
// } else {
//     app.commandLine.appendSwitch("disable-gpu");
// }

// Touch-Support
app.commandLine.appendSwitch("touch-events", "enabled");

// Handle system sleep/hibernate - notify P2P peers
powerMonitor.on("suspend", () => {
    console.log("[Electron] System suspending (sleep/hibernate)")
    onSystemSuspend()
})

// Handle system resume - re-announce to P2P peers and notify renderer for feed refresh
powerMonitor.on("resume", () => {
    console.log("[Electron] System resumed from sleep/hibernate")
    onSystemResume()
    
    // Notify renderer to refresh feeds
    if (winManager.hasWindow()) {
        console.log("[Electron] Notifying renderer to refresh feeds after resume")
        winManager.mainWindow.webContents.send("power-resume")
    }
})

// Gracefully shutdown P2P when app is quitting
app.on("before-quit", async (event) => {
    // Send goodbye to P2P peers before quitting
    // This happens synchronously enough for the message to be sent
    await shutdownP2P()
})

app.on("window-all-closed", () => {
    if (winManager.hasWindow()) {
        winManager.mainWindow.webContents.session.clearStorageData({
            storages: ["cookies", "localstorage"],
        })
    }
    winManager.mainWindow = null
    if (restarting) {
        restarting = false
        winManager.createWindow()
    } else {
        app.quit()
    }
})

ipcMain.handle("import-all-settings", (_, configs: SchemaTypes) => {
    restarting = true
    store.clear()
    for (let [key, value] of Object.entries(configs)) {
        // @ts-ignore
        store.set(key, value)
    }
    performUpdate(store)
    nativeTheme.themeSource = store.get("theme", ThemeSettings.Default)
    setTimeout(
        () => {
            winManager.mainWindow.close()
        },
        process.platform === "darwin" ? 1000 : 0
    ) // Why ???
})
