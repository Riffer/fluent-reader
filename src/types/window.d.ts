/**
 * Electron Context Bridge Types
 * Declares types for APIs exposed to renderer process
 */

import type { createArticleExtractorBridge } from "../bridges/article-extractor"
import type { DbBridge } from "../bridges/db"
import type { P2PBridge } from "../bridges/p2p"
import type { P2PLanBridge } from "../bridges/p2p-lan"
import type { contentViewBridge } from "../bridges/content-view"

type ArticleExtractorBridge = ReturnType<typeof createArticleExtractorBridge>
type ContentViewBridge = typeof contentViewBridge

declare global {
    /**
     * Extend HTMLElement with Webkit-specific scrollIntoViewIfNeeded method
     * This is a non-standard method supported by Chrome, Edge, and Safari
     * @see https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoViewIfNeeded
     */
    interface HTMLElement {
        /**
         * Scrolls the element into the visible area of the browser window if it's not already visible.
         * Non-standard Webkit extension - check for existence before calling.
         * @param centerIfNeeded If true, centers the element in the visible area. If false, aligns to nearest edge.
         */
        scrollIntoViewIfNeeded?(centerIfNeeded?: boolean): void
    }

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
         * Article HTML base path for ContentView (exposed from preload.ts)
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
         * Content View bridge - WebContentsView for article display with visual zoom
         */
        contentView: ContentViewBridge

        /**
         * Limited IPC renderer for specific channels
         */
        ipcRenderer: {
            send(channel: string, ...args: any[]): void
            on(channel: string, listener: Function): void
            removeAllListeners(channel: string): void
            removeListener(channel: string, listener: Function): void
            invoke(channel: string, ...args: any[]): Promise<any>
        }
    }
}

export {}
