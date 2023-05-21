import { contextBridge } from "electron"
import settingsBridge from "./bridges/settings"
import utilsBridge from "./bridges/utils"
//import { ReactNativeZoomableView } from '@openspacelabs/react-native-zoomable-view';

contextBridge.exposeInMainWorld("settings", settingsBridge)
contextBridge.exposeInMainWorld("utils", utilsBridge)
//contextBridge.exposeInMainWorld("zoom", ReactNativeZoomableView)

