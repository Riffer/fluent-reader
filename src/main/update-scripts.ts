import { app } from "electron"
import Store = require("electron-store")
import { SchemaTypes } from "../schema-types"

export default function performUpdate(store: Store<SchemaTypes>) {
    let version = store.get("version", null)
    let currentVersion = app.getVersion()

    // Update version on first run or version change
    if (version != currentVersion) {
        store.set("version", currentVersion)
    }
}
