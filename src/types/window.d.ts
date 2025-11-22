/**
 * Electron Context Bridge Types
 * Declares types for APIs exposed to renderer process
 */

import type { createArticleExtractorBridge } from "../bridges/article-extractor"

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
         * Article Extractor bridge - extract article content
         */
        articleExtractor: ArticleExtractorBridge

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
