import { ipcMain, app } from "electron"
import { extract, extractFromHtml, addTransformations } from "@extractus/article-extractor"
import { initializeCookieTransformations } from "./cookie-transformations"

/**
 * Site-specific transformations for article extraction
 * These run before (pre) or after (post) the main extraction
 */
function setupExtractorTransformations() {
    addTransformations([
        {
            // Reddit: Entferne NSFW-Dialoge, App-Promo, QR-Codes, Modals, Cookie-Banner
            patterns: [/reddit\.com/],
            pre: (document: Document) => {
                // NSFW/18+ Blocking Modals und Dialoge
                document.querySelectorAll('faceplate-modal, faceplate-dialog').forEach(el => el.remove())
                document.querySelectorAll('#nsfw-qr-dialog, #blocking-modal').forEach(el => el.remove())
                
                // NSFW Blocking Container - nur "In App anzeigen" Buttons entfernen
                document.querySelectorAll('xpromo-nsfw-blocking-container .viewInApp').forEach(el => el.remove())
                document.querySelectorAll('xpromo-nsfw-blocking-container a[slot="view-in-app-button"]').forEach(el => el.remove())
                
                // Blurred container für NSFW - Blur entfernen und ungeblurrtes Bild anzeigen
                document.querySelectorAll('shreddit-blurred-container').forEach(el => {
                    el.removeAttribute('blurred')
                    el.setAttribute('mode', 'revealed')
                    
                    const revealed = el.querySelector('[slot="revealed"]')
                    const blurred = el.querySelector('[slot="blurred"]')
                    if (revealed) {
                        (revealed as HTMLElement).style.display = 'block';
                        (revealed as HTMLElement).style.visibility = 'visible'
                    }
                    if (blurred) {
                        (blurred as HTMLElement).style.display = 'none'
                    }
                })
                
                // Modal-Wrapper mit Dialog-Rolle entfernen (App-Promo, Login-Prompts)
                document.querySelectorAll('#wrapper[role="dialog"][aria-modal="true"]').forEach(el => el.remove())
                
                // App-Download Banner und Prompts
                document.querySelectorAll('[data-testid="xpromo-nsfw-blocking-modal"]').forEach(el => el.remove())
                document.querySelectorAll('[data-testid="xpromo-app-selector"]').forEach(el => el.remove())
                document.querySelectorAll('.XPromoPopupRpl, .XPromoBlockingModal').forEach(el => el.remove())
                
                // Cookie/Consent/Datenschutz Banner
                document.querySelectorAll('#data-protection-consent-dialog').forEach(el => el.remove())
                document.querySelectorAll('rpl-modal-card').forEach(el => el.remove())
                document.querySelectorAll('.rpl-dialog').forEach(el => el.remove())
                document.querySelectorAll('[data-testid="cookie-policy-banner"]').forEach(el => el.remove())
                document.querySelectorAll('shreddit-cookie-banner').forEach(el => el.remove())
                
                // Weitere störende Elemente
                document.querySelectorAll('[class*="bottom-sheet"]').forEach(el => el.remove())
                document.querySelectorAll('[class*="overlay-container"]').forEach(el => el.remove())
                
                return document
            }
        }
    ])
}

/**
 * Register IPC handlers for article extraction
 * Allows renderer process to use article-extractor via IPC
 */
export function setupArticleExtractorHandlers() {
    // Initialize cookie/consent banner removal transformations
    initializeCookieTransformations()
    
    // Initialize site-specific extraction transformations
    setupExtractorTransformations()

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

