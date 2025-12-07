/**
 * Electron Context Bridge Types
 * Declares types for APIs exposed to renderer process
 */

import type { createArticleExtractorBridge } from "../bridges/article-extractor"
import type { DbBridge } from "../bridges/db"

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
