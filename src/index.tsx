import * as React from "react"
import * as ReactDOM from "react-dom"
import { Provider } from "react-redux"
import { createStore, applyMiddleware } from "redux"
import thunkMiddleware from "redux-thunk"
import { initializeIcons } from "@fluentui/react/lib/Icons"
import { rootReducer, RootState } from "./scripts/reducer"
import Root from "./components/root"
import { AppDispatch } from "./scripts/utils"
import { applyThemeSettings } from "./scripts/settings"
import { initApp, openTextMenu } from "./scripts/models/app"
import { handleP2PFeedsChanged } from "./scripts/models/source"
import { fetchItems } from "./scripts/models/item"

window.settings.setProxy()

applyThemeSettings()
initializeIcons("icons/")

const store = createStore(
    rootReducer,
    applyMiddleware<AppDispatch, RootState>(thunkMiddleware)
)

store.dispatch(initApp())

window.utils.addMainContextListener((pos, text) => {
    store.dispatch(openTextMenu(pos, text))
})

// P2P Feeds Changed Listener - syncs SQLite P2P articles to Redux state
if (window.p2pLan) {
    window.p2pLan.onFeedsChanged((data) => {
        store.dispatch(handleP2PFeedsChanged(
            data.newFeeds,
            data.newArticles,
            data.groupsUpdated,
            data.groups
        ))
    })
}

window.fontList = [""]
window.utils.initFontList().then(fonts => {
    window.fontList.push(...fonts)
})

// Auto-Refresh Feeds when waking from standby/sleep
window.utils.addPowerResumeListener(() => {
    store.dispatch(fetchItems(true)) // background=true for silent refresh
})

// Global keyboard handler - use window flag to prevent duplicate registration
if (!(window as any)._globalKeydownRegistered) {
    (window as any)._globalKeydownRegistered = true
    ;(window as any)._lastToggleTime = 0  // Debounce on sender side too
    console.log('[index.tsx] Registering global keydown handler')
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'F12') {
            e.preventDefault()
            if ((window as any).ipcRenderer) {
                (window as any).ipcRenderer.invoke('toggle-app-devtools')
            }
        }
        // Global F11 handler for Fullscreen toggle
        if (e.key === 'F11') {
            e.preventDefault()
            window.utils.toggleFullscreen()
        }
        // ö key: Toggle render-position view visibility (debug)
        // Ignore key-repeat to prevent rapid toggling
        // Also debounce on sender side (300ms) to prevent multiple sends
        if (e.key === 'ö' && !e.repeat) {
            e.preventDefault()
            const now = Date.now()
            const lastTime = (window as any)._lastToggleTime || 0
            if (now - lastTime < 300) {
                console.log(`[index.tsx] ö key DEBOUNCED (${now - lastTime}ms since last)`)
                return
            }
            (window as any)._lastToggleTime = now
            console.log(`[index.tsx] ö key pressed, timeStamp=${e.timeStamp}, target=${(e.target as HTMLElement)?.tagName}`)
            if ((window as any).ipcRenderer) {
                (window as any).ipcRenderer.send('cvp-toggle-render-preview')
            }
        }
    })
} else {
    console.log('[index.tsx] Global keydown handler already registered, skipping')
}

ReactDOM.render(
    <Provider store={store}>
        <Root />
    </Provider>,
    document.getElementById("app")
)
