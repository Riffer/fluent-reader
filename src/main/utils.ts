import { ipcMain, shell, dialog, app, session, clipboard, BrowserWindow } from "electron"
import { WindowManager } from "./window"
import fs = require("fs")
import { TouchBarTexts } from "../schema-types"
import { initMainTouchBar } from "./touchbar"
import fontList = require("font-list")

export function setUtilsListeners(manager: WindowManager) {
    async function openExternal(url: string, background = false) {
        console.log("openExternal:" + url)
        if (url.startsWith("https://") || url.startsWith("http://")) {
            if (background && process.platform === "darwin") {
                shell.openExternal(url, { activate: false })
            } else if (background && manager.hasWindow()) {
                manager.mainWindow.setAlwaysOnTop(true)
                await shell.openExternal(url)
                setTimeout(() => manager.mainWindow.setAlwaysOnTop(false), 1000)
            } else {
                shell.openExternal(url)
            }
        }
    }
    
    app.on("web-contents-created", (_, contents) => {
        contents.setWindowOpenHandler(details => {
            // Note: WebView tag check removed - ContentView handles its own links
            // via ContentViewManager.setupContextMenu() and setupNavigationEvents()
            console.log("WindowOpenHandler:" + details.url)
            return {
                action: manager.hasWindow() ? "deny" : "allow",
            }
        })
        contents.on("will-navigate", (event, url) => {
            event.preventDefault()
            contents.loadURL(url);
            console.log("will-navigate:" + url)
        })
    })

    ipcMain.on("get-version", event => {
        event.returnValue = app.getVersion()
    })

    ipcMain.handle("open-external", (_, url: string, background: boolean) => {
        console.log("from ipcMain.handle()")
        openExternal(url, background)
    })

    // Open URL in a new internal browser window
    ipcMain.handle("open-in-reader-window", (_, url: string, title: string = "Reader") => {
        console.log("Opening in reader window:", url)
        const readerWindow = new BrowserWindow({
            width: 1000,
            height: 800,
            title: title,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
            autoHideMenuBar: true,
        })
        readerWindow.loadURL(url)
    })

    ipcMain.handle(
        "show-error-box",
        async (_, title, content, copy?: string) => {
            if (manager.hasWindow() && copy != null) {
                const response = await dialog.showMessageBox(
                    manager.mainWindow,
                    {
                        type: "error",
                        title: title,
                        message: title,
                        detail: content,
                        buttons: ["OK", copy],
                        cancelId: 0,
                        defaultId: 0,
                    }
                )
                if (response.response === 1) {
                    clipboard.writeText(`${title}: ${content}`)
                }
            } else {
                dialog.showErrorBox(title, content)
            }
        }
    )

    ipcMain.handle(
        "show-message-box",
        async (_, title, message, confirm, cancel, defaultCancel, type) => {
            if (manager.hasWindow()) {
                let response = await dialog.showMessageBox(manager.mainWindow, {
                    type: type,
                    title: title,
                    message: title,
                    detail: message,
                    buttons:
                        process.platform === "win32"
                            ? ["Yes", "No"]
                            : [confirm, cancel],
                    cancelId: 1,
                    defaultId: defaultCancel ? 1 : 0,
                })
                return response.response === 0
            } else {
                return false
            }
        }
    )

    ipcMain.handle(
        "show-save-dialog",
        async (_, filters: Electron.FileFilter[], path: string) => {
            ipcMain.removeAllListeners("write-save-result")
            if (manager.hasWindow()) {
                let response = await dialog.showSaveDialog(manager.mainWindow, {
                    defaultPath: path,
                    filters: filters,
                })
                if (!response.canceled) {
                    ipcMain.handleOnce(
                        "write-save-result",
                        (_, result, errmsg) => {
                            fs.writeFile(response.filePath, result, err => {
                                if (err)
                                    dialog.showErrorBox(errmsg, String(err))
                            })
                        }
                    )
                    return true
                }
            }
            return false
        }
    )

    ipcMain.handle(
        "show-open-dialog",
        async (_, filters: Electron.FileFilter[]) => {
            if (manager.hasWindow()) {
                let response = await dialog.showOpenDialog(manager.mainWindow, {
                    filters: filters,
                    properties: ["openFile"],
                })
                if (!response.canceled) {
                    try {
                        return await fs.promises.readFile(
                            response.filePaths[0],
                            "utf-8"
                        )
                    } catch (err) {
                        console.log(err)
                    }
                }
            }
            return null
        }
    )

    ipcMain.handle("get-cache", async () => {
        return await session.defaultSession.getCacheSize()
    })

    ipcMain.handle("clear-cache", async () => {
        await session.defaultSession.clearCache()
    })

    // Note: WebView context-menu, error, and keyboard handlers removed
    // ContentView uses native Electron Menu.popup() for context menu (see content-view-manager.ts)
    // ContentView handles its own errors and keyboard events via IPC

    ipcMain.handle("write-clipboard", (_, text) => {
        clipboard.writeText(text)
    })

    ipcMain.handle("close-window", () => {
        if (manager.hasWindow()) manager.mainWindow.close()
    })

    ipcMain.handle("minimize-window", () => {
        if (manager.hasWindow()) manager.mainWindow.minimize()
    })

    ipcMain.handle("maximize-window", () => {
        manager.zoom()
    })

    ipcMain.on("is-maximized", event => {
        event.returnValue =
            Boolean(manager.mainWindow) && manager.mainWindow.isMaximized()
    })

    ipcMain.on("is-focused", event => {
        event.returnValue =
            manager.hasWindow() && manager.mainWindow.isFocused()
    })

    ipcMain.on("is-fullscreen", event => {
        event.returnValue =
            manager.hasWindow() && manager.mainWindow.isFullScreen()
    })

    ipcMain.handle("request-focus", () => {
        if (manager.hasWindow()) {
            const win = manager.mainWindow
            if (win.isMinimized()) win.restore()
            if (process.platform === "win32") {
                win.setAlwaysOnTop(true)
                win.setAlwaysOnTop(false)
            }
            win.focus()
        }
    })

    ipcMain.handle("request-attention", () => {
        if (manager.hasWindow() && !manager.mainWindow.isFocused()) {
            if (process.platform === "win32") {
                manager.mainWindow.flashFrame(true)
                manager.mainWindow.once("focus", () => {
                    manager.mainWindow.flashFrame(false)
                })
            } else if (process.platform === "darwin") {
                app.dock.bounce()
            }
        }
    })

    ipcMain.handle("touchbar-init", (_, texts: TouchBarTexts) => {
        if (manager.hasWindow()) initMainTouchBar(texts, manager.mainWindow)
    })
    ipcMain.handle("touchbar-destroy", () => {
        if (manager.hasWindow()) manager.mainWindow.setTouchBar(null)
    })

    ipcMain.handle("init-font-list", () => {
        return fontList.getFonts({
            disableQuoting: true,
        })
    })
}
