import { ipcMain, app } from "electron"
import { extract, extractFromHtml } from "@extractus/article-extractor"
import { initializeCookieTransformations } from "./cookie-transformations"

/**
 * Register IPC handlers for article extraction
 * Allows renderer process to use article-extractor via IPC
 */
export function setupArticleExtractorHandlers() {
    // Initialize cookie/consent banner removal transformations
    initializeCookieTransformations()

    // Get application path for WebView to load article.html
    ipcMain.handle("get-app-path", (event) => {
        try {
            const appPath = app.getAppPath()
            return appPath
        } catch (error) {
            console.error("[article-extractor] Failed to get app path:", error)
            return null
        }
    })

    // Extract article from URL
    ipcMain.handle("extract-article", async (event, url: string) => {
        try {
            // Extract with minimal options - the library handles most cases well
            const article = await extract(url)
            return {
                success: true,
                data: article,
            }
        } catch (error) {
            console.error("[article-extractor] Extraction failed:", error)
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            }
        }
    })

    // Extract article from HTML content
    ipcMain.handle("extract-article-html", async (event, html: string, url: string) => {
        try {
            // Extract article - returns content with text and basic formatting
            // Note: article-extractor doesn't preserve images by design for security/performance
            // Images can be re-injected if needed from the original HTML
            const article = await extractFromHtml(html, url)
            return {
                success: true,
                data: article,
            }
        } catch (error) {
            console.error("[article-extractor-html] Extraction failed:", error)
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            }
        }
    })
}

