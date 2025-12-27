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
        console.log("[P2P] Feeds changed event received:", data.newFeedIds.length, "feeds,", data.newArticles.length, "articles")
        store.dispatch(handleP2PFeedsChanged(
            data.newFeeds,
            data.newArticles,
            data.groupsUpdated,
            data.groups
        ))
    })
    console.log("[P2P] Feeds changed listener registered")
}

window.fontList = [""]
window.utils.initFontList().then(fonts => {
    window.fontList.push(...fonts)
})

// Auto-Refresh Feeds when waking from standby/sleep
window.utils.addPowerResumeListener(() => {
    console.log("[PowerResume] Triggering automatic feed refresh after system wake")
    store.dispatch(fetchItems(true)) // background=true for silent refresh
})

// Global F12 handler for App Developer Tools
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'F12') {
        e.preventDefault()
        if ((window as any).ipcRenderer) {
            (window as any).ipcRenderer.invoke('toggle-app-devtools')
        }
    }
})

ReactDOM.render(
    <Provider store={store}>
        <Root />
    </Provider>,
    document.getElementById("app")
)
