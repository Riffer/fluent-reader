import { ipcMain, app } from "electron"
import { extract, extractFromHtml } from "@extractus/article-extractor"

/**
 * Register IPC handlers for article extraction
 * Allows renderer process to use article-extractor via IPC
 */
export function setupArticleExtractorHandlers() {
    // Get application path for WebView to load article.html
    ipcMain.handle("get-app-path", (event) => {
        try {
            const appPath = app.getAppPath()
            console.log("[article-extractor] App path:", appPath)
            return appPath
        } catch (error) {
            console.error("[article-extractor] Failed to get app path:", error)
            return null
        }
    })

    // Extract article from URL
    ipcMain.handle("extract-article", async (event, url: string) => {
        try {
            console.log(`[article-extractor] Extracting from URL: ${url}`)
            const article = await extract(url)
            console.log(`[article-extractor] Extracted successfully, content length: ${article?.content?.length || 0}`)
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
            console.log(`[article-extractor-html] Extracting from HTML (length: ${html?.length || 0}) for URL: ${url}`)
            const article = await extractFromHtml(html, url)
            console.log(`[article-extractor-html] Extracted successfully, content length: ${article?.content?.length || 0}`)
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

