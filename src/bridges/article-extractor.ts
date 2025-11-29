/**
 * Article Extractor Bridge
 * Provides typed interface for article extraction via IPC
 * Available in renderer process through window.articleExtractor
 */

export interface ArticleExtractionResult {
    url?: string
    title?: string
    description?: string
    image?: string
    author?: string
    favicon?: string
    content?: string
    published?: string
    type?: string
    source?: string
    links?: string[]
    ttr?: number
}

/**
 * Creates the article extractor bridge with access to ipcRenderer
 * This is called from preload.ts with the proper context
 */
export function createArticleExtractorBridge(ipcRenderer: any) {
    return {
        /**
         * Extract article from a URL
         */
        extractFromUrl: async (url: string): Promise<ArticleExtractionResult | null> => {
            try {
                const result = await ipcRenderer.invoke("extract-article", url)
                if (result.success) {
                    return result.data
                } else {
                    console.error("Article extraction failed:", result.error)
                    return null
                }
            } catch (error) {
                console.error("Failed to invoke extract-article IPC:", error)
                return null
            }
        },

        /**
         * Extract article from HTML content
         */
        extractFromHtml: async (html: string, url: string): Promise<ArticleExtractionResult | null> => {
            try {
                const result = await ipcRenderer.invoke("extract-article-html", html, url)
                if (result.success) {
                    return result.data
                } else {
                    console.error("Article HTML extraction failed:", result.error)
                    return null
                }
            } catch (error) {
                console.error("Failed to invoke extract-article-html IPC:", error)
                return null
            }
        },
    }
}

export default createArticleExtractorBridge

