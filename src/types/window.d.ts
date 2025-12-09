/**
 * Electron Context Bridge Types
 * Declares types for APIs exposed to renderer process
 */

import type { createArticleExtractorBridge } from "../bridges/article-extractor"
import type { DbBridge } from "../bridges/db"
import type { P2PBridge } from "../bridges/p2p"
import type { P2PLanBridge } from "../bridges/p2p-lan"

type ArticleExtractorBridge = ReturnType<typeof createArticleExtractorBridge>

declare global {
    interface Window {
        /**
         * Settings bridge - access to application settings
         */
        settings: any

        /**
         * Utils bridge - utility functions
         */
        utils: any

        /**
         * Database bridge - SQLite database operations
         */
        db: DbBridge

        /**
         * Article Extractor bridge - extract article content
         */
        articleExtractor: ArticleExtractorBridge

        /**
         * Article HTML base path for WebView (exposed from preload.ts)
         */
        articleHtmlPath: string

        /**
         * P2P bridge - peer configuration storage (legacy)
         */
        p2p: P2PBridge

        /**
         * P2P LAN bridge - automatic peer discovery in local network
         */
        p2pLan: P2PLanBridge

        /**
         * Limited IPC renderer for specific channels
         */
        ipcRenderer: {
            send(channel: string, ...args: any[]): void
            on(channel: string, listener: Function): void
            removeAllListeners(channel: string): void
            invoke(channel: string, ...args: any[]): Promise<any>
        }
    }
}

export {}
