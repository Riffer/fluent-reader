/**
 * Translation Service for Main Process
 * 
 * Supports multiple translation providers:
 * 1. Google Translate (unofficial, via google-translate-api-x)
 * 2. LibreTranslate (self-hosted or public instance)
 */

import translate from "google-translate-api-x"
import { ipcMain } from "electron"

// =============================================================================
// Configuration
// =============================================================================

export type TranslationProvider = "google" | "libretranslate"

interface LibreTranslateConfig {
    url: string
    apiKey?: string
}

// Current provider and configuration
let currentProvider: TranslationProvider = "libretranslate"  // Default to LibreTranslate for local testing
let libreTranslateConfig: LibreTranslateConfig = {
    url: "http://192.168.0.141:5050",  // Default local instance
    apiKey: undefined
}

/**
 * Set the translation provider
 */
export function setTranslationProvider(provider: TranslationProvider): void {
    currentProvider = provider
    console.log(`[translation-service] Provider set to: ${provider}`)
}

/**
 * Configure LibreTranslate instance
 */
export function setLibreTranslateConfig(config: LibreTranslateConfig): void {
    libreTranslateConfig = config
    console.log(`[translation-service] LibreTranslate configured: ${config.url}`)
}

/**
 * Get current provider
 */
export function getTranslationProvider(): TranslationProvider {
    return currentProvider
}

// Simple in-memory cache to avoid translating the same content twice
const translationCache = new Map<string, string>()
const MAX_CACHE_SIZE = 500

// Global rate limiter - serialize all translation requests
let translationQueue: Promise<void> = Promise.resolve()
let baseDelay = 2000  // Start with 2 seconds between requests
const MIN_DELAY = 2000  // Minimum 2 seconds between requests (be conservative!)
const MAX_DELAY = 60000 // Maximum 60 seconds delay
let consecutiveErrors = 0
let lastRequestTime = 0

/**
 * Add a translation request to the global queue
 * This ensures requests are serialized and rate-limited with exponential backoff
 */
async function queueTranslation<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        translationQueue = translationQueue.then(async () => {
            // Calculate delay based on time since last request and error count
            const now = Date.now()
            const timeSinceLastRequest = now - lastRequestTime
            const requiredDelay = baseDelay - timeSinceLastRequest
            
            if (requiredDelay > 0) {
                await new Promise(r => setTimeout(r, requiredDelay))
            }
            
            try {
                lastRequestTime = Date.now()
                const result = await fn()
                
                // Success - gradually reduce delay
                consecutiveErrors = 0
                if (baseDelay > MIN_DELAY) {
                    baseDelay = Math.max(MIN_DELAY, baseDelay * 0.9)
                }
                
                resolve(result)
            } catch (error: any) {
                // Check for rate limiting error
                if (error?.message?.includes('Too Many Requests') || error?.message?.includes('429')) {
                    consecutiveErrors++
                    // Exponential backoff
                    baseDelay = Math.min(MAX_DELAY, baseDelay * 2)
                    console.log(`[translation-service] Rate limited! Increasing delay to ${baseDelay}ms (errors: ${consecutiveErrors})`)
                }
                reject(error)
            }
        })
    })
}

/**
 * Supported languages for translation
 * Key = language code, Value = display name
 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
    "de": "Deutsch",
    "en": "English",
    "es": "Español",
    "fr": "Français",
    "it": "Italiano",
    "ja": "日本語",
    "ko": "한국어",
    "nl": "Nederlands",
    "pl": "Polski",
    "pt": "Português",
    "ru": "Русский",
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    "ar": "العربية",
    "hi": "हिन्दी",
    "tr": "Türkçe",
    "uk": "Українська",
    "vi": "Tiếng Việt",
    "th": "ไทย",
    "sv": "Svenska",
    "da": "Dansk",
    "fi": "Suomi",
    "no": "Norsk",
    "cs": "Čeština",
    "hu": "Magyar",
    "ro": "Română",
    "el": "Ελληνικά",
    "he": "עברית",
    "id": "Bahasa Indonesia"
}

/**
 * Create a cache key for translation
 */
function getCacheKey(text: string, targetLang: string): string {
    // Use hash for longer texts to save memory
    if (text.length > 100) {
        let hash = 0
        for (let i = 0; i < text.length; i++) {
            const char = text.charCodeAt(i)
            hash = ((hash << 5) - hash) + char
            hash = hash & hash // Convert to 32bit integer
        }
        return `${targetLang}:${hash}:${text.length}`
    }
    return `${targetLang}:${text}`
}

// Maximum characters per translation chunk (Google has ~5000 char limit, use less for safety)
const MAX_CHUNK_SIZE = 4000

/**
 * Split text into chunks at sentence boundaries
 */
function splitTextIntoChunks(text: string, maxSize: number): string[] {
    if (text.length <= maxSize) {
        return [text]
    }
    
    const chunks: string[] = []
    let remaining = text
    
    while (remaining.length > 0) {
        if (remaining.length <= maxSize) {
            chunks.push(remaining)
            break
        }
        
        // Find a good break point (sentence end, newline, or space)
        let breakPoint = maxSize
        
        // Try to find sentence end (. ! ?)
        const sentenceEnd = remaining.substring(0, maxSize).lastIndexOf('. ')
        if (sentenceEnd > maxSize * 0.5) {
            breakPoint = sentenceEnd + 1
        } else {
            // Try newline
            const newlinePos = remaining.substring(0, maxSize).lastIndexOf('\n')
            if (newlinePos > maxSize * 0.5) {
                breakPoint = newlinePos + 1
            } else {
                // Try space
                const spacePos = remaining.substring(0, maxSize).lastIndexOf(' ')
                if (spacePos > maxSize * 0.3) {
                    breakPoint = spacePos + 1
                }
            }
        }
        
        chunks.push(remaining.substring(0, breakPoint))
        remaining = remaining.substring(breakPoint)
    }
    
    return chunks
}

// Track rate limit state globally - if we hit rate limit, stop trying for a while
let rateLimitedUntil = 0
const RATE_LIMIT_COOLDOWN = 60000 // Wait 60 seconds after rate limit before trying again

/**
 * Check if we're currently in rate limit cooldown
 */
function isRateLimited(): boolean {
    return Date.now() < rateLimitedUntil
}

// =============================================================================
// LibreTranslate Implementation
// =============================================================================

/**
 * Translate text using LibreTranslate API
 */
async function translateWithLibreTranslate(
    text: string, 
    targetLang: string, 
    format: "text" | "html" = "text"
): Promise<string> {
    const url = `${libreTranslateConfig.url}/translate`
    
    const body: any = {
        q: text,
        source: "auto",  // Auto-detect source language
        target: targetLang,
        format: format
    }
    
    // Add API key if configured
    if (libreTranslateConfig.apiKey) {
        body.api_key = libreTranslateConfig.apiKey
    }
    
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    })
    
    if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error")
        throw new Error(`LibreTranslate error ${response.status}: ${errorText}`)
    }
    
    const result = await response.json()
    return result.translatedText
}

// =============================================================================
// Google Translate Implementation (via queue/rate limiter)
// =============================================================================

/**
 * Translate text using Google Translate (unofficial)
 */
async function translateWithGoogle(text: string, targetLang: string): Promise<string> {
    const result = await queueTranslation(() => translate(text, { to: targetLang }))
    return result.text
}

// =============================================================================
// Unified Translation with Fallback
// =============================================================================

/**
 * Translate text - returns original text if rate limited or on error
 * Uses the currently configured provider
 */
async function translateWithFallback(
    text: string, 
    targetLang: string,
    format: "text" | "html" = "text"
): Promise<{ translated: string; wasTranslated: boolean }> {
    // For Google: Check rate limit cooldown
    if (currentProvider === "google" && isRateLimited()) {
        console.log(`[translation-service] Still in rate limit cooldown, returning original text`)
        return { translated: text, wasTranslated: false }
    }
    
    try {
        let translated: string
        
        if (currentProvider === "libretranslate") {
            translated = await translateWithLibreTranslate(text, targetLang, format)
        } else {
            translated = await translateWithGoogle(text, targetLang)
        }
        
        return { translated, wasTranslated: true }
    } catch (error: any) {
        const isRateLimit = error?.message?.includes('Too Many Requests') || 
                           error?.message?.includes('429') ||
                           error?.message?.includes('rate limit')
        
        if (isRateLimit && currentProvider === "google") {
            // Set cooldown period - don't try translating for a while
            rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN
            console.log(`[translation-service] Rate limited! Returning original text. Cooldown until ${new Date(rateLimitedUntil).toLocaleTimeString()}`)
            return { translated: text, wasTranslated: false }
        }
        
        // Other error - log and return original
        console.error(`[translation-service] Translation error (${currentProvider}):`, error?.message || error)
        return { translated: text, wasTranslated: false }
    }
}

/**
 * Translate text to target language
 * @param text - Text to translate
 * @param targetLang - Target language code (e.g., 'de', 'en')
 * @returns Translated text
 */
export async function translateText(text: string, targetLang: string): Promise<string> {
    if (!text || !targetLang) return text
    
    // Check cache first
    const cacheKey = getCacheKey(text, targetLang)
    const cached = translationCache.get(cacheKey)
    if (cached) {
        return cached
    }
    
    try {
        // LibreTranslate has no text length limit - send directly
        // Google has ~5000 char limit - use chunking
        if (currentProvider === "libretranslate") {
            const { translated, wasTranslated } = await translateWithFallback(text, targetLang)
            
            if (wasTranslated) {
                if (translationCache.size >= MAX_CACHE_SIZE) {
                    const keysToDelete = Array.from(translationCache.keys()).slice(0, 100)
                    keysToDelete.forEach(key => translationCache.delete(key))
                }
                translationCache.set(cacheKey, translated)
            }
            
            return translated
        }
        
        // Google: Split long text into chunks
        const chunks = splitTextIntoChunks(text, MAX_CHUNK_SIZE)
        
        if (chunks.length === 1) {
            // Single chunk - translate with fallback
            const { translated, wasTranslated } = await translateWithFallback(text, targetLang)
            
            if (wasTranslated) {
                if (translationCache.size >= MAX_CACHE_SIZE) {
                    const keysToDelete = Array.from(translationCache.keys()).slice(0, 100)
                    keysToDelete.forEach(key => translationCache.delete(key))
                }
                translationCache.set(cacheKey, translated)
            }
            
            return translated
        }
        
        // Multiple chunks - translate each with fallback (Google only)
        console.log(`[translation-service] Splitting long text into ${chunks.length} chunks (Google)`)
        const translatedChunks: string[] = []
        let allTranslated = true
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]
            const { translated, wasTranslated } = await translateWithFallback(chunk, targetLang)
            translatedChunks.push(translated)
            if (!wasTranslated) allTranslated = false
        }
        
        const translated = translatedChunks.join('')
        
        if (allTranslated) {
            if (translationCache.size >= MAX_CACHE_SIZE) {
                const keysToDelete = Array.from(translationCache.keys()).slice(0, 100)
                keysToDelete.forEach(key => translationCache.delete(key))
            }
            translationCache.set(cacheKey, translated)
        }
        
        return translated
    } catch (error) {
        console.error("[translation-service] Translation failed:", error)
        // Return original text on error
        return text
    }
}

/**
 * Translate HTML content while preserving tags
 * - LibreTranslate: Uses native HTML format support
 * - Google: Manually parses and translates text nodes
 */
export async function translateHtml(html: string, targetLang: string): Promise<string> {
    if (!html || !targetLang) return html
    
    console.log(`[translation-service] translateHtml: provider=${currentProvider}, targetLang=${targetLang}, htmlLength=${html.length}`)
    
    // Check cache for entire HTML
    const cacheKey = getCacheKey(html, targetLang)
    const cached = translationCache.get(cacheKey)
    if (cached) {
        console.log(`[translation-service] translateHtml: CACHE HIT`)
        return cached
    }
    
    try {
        // LibreTranslate: Handle HTML natively, no length limit
        if (currentProvider === "libretranslate") {
            const { translated, wasTranslated } = await translateWithFallback(html, targetLang, "html")
            
            if (wasTranslated) {
                if (translationCache.size >= MAX_CACHE_SIZE) {
                    const keysToDelete = Array.from(translationCache.keys()).slice(0, 100)
                    keysToDelete.forEach(key => translationCache.delete(key))
                }
                translationCache.set(cacheKey, translated)
            }
            
            return translated
        }
        
        // Google: Parse HTML and translate text nodes separately
        // Split HTML into parts: tags and text
        const parts: Array<{ type: 'tag' | 'text', content: string }> = []
        let currentIndex = 0
        
        // Regex to find HTML tags
        const tagRegex = /<[^>]+>/g
        let match
        
        while ((match = tagRegex.exec(html)) !== null) {
            // Add text before tag
            if (match.index > currentIndex) {
                const text = html.substring(currentIndex, match.index)
                if (text.trim()) {
                    parts.push({ type: 'text', content: text })
                } else {
                    parts.push({ type: 'tag', content: text }) // Preserve whitespace
                }
            }
            // Add tag
            parts.push({ type: 'tag', content: match[0] })
            currentIndex = match.index + match[0].length
        }
        
        // Add remaining text after last tag
        if (currentIndex < html.length) {
            const text = html.substring(currentIndex)
            if (text.trim()) {
                parts.push({ type: 'text', content: text })
            } else {
                parts.push({ type: 'tag', content: text })
            }
        }
        
        // Collect all text parts for batch translation
        const textParts = parts.filter(p => p.type === 'text' && p.content.trim().length > 0)
        
        if (textParts.length === 0) {
            return html // No text to translate
        }
        
        // Batch translate all text parts
        // google-translate-api-x supports array input
        const textsToTranslate = textParts.map(p => p.content)
        
        // Translate in batches to avoid rate limits
        const BATCH_SIZE = 10
        const translatedTexts: string[] = []
        
        for (let i = 0; i < textsToTranslate.length; i += BATCH_SIZE) {
            const batch = textsToTranslate.slice(i, i + BATCH_SIZE)
            
            // Translate each chunk individually (batch may have long texts)
            for (const text of batch) {
                const translated = await translateText(text, targetLang)
                translatedTexts.push(translated)
            }
            
            // Small delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < textsToTranslate.length) {
                await new Promise(resolve => setTimeout(resolve, 100))
            }
        }
        
        // Rebuild HTML with translated text
        let textIndex = 0
        const translatedParts = parts.map(part => {
            if (part.type === 'text' && part.content.trim().length > 0) {
                return translatedTexts[textIndex++]
            }
            return part.content
        })
        
        const translatedHtml = translatedParts.join('')
        
        // Cache the result
        if (translationCache.size >= MAX_CACHE_SIZE) {
            const keysToDelete = Array.from(translationCache.keys()).slice(0, 100)
            keysToDelete.forEach(key => translationCache.delete(key))
        }
        translationCache.set(cacheKey, translatedHtml)
        
        return translatedHtml
    } catch (error) {
        console.error("[translation-service] HTML translation failed:", error)
        return html
    }
}

/**
 * Translate article content (title, snippet, and HTML content)
 */
export interface ArticleTranslation {
    title: string
    snippet: string
    content: string
}

export async function translateArticle(
    title: string,
    snippet: string,
    content: string,
    targetLang: string
): Promise<ArticleTranslation> {
    if (!targetLang) {
        return { title, snippet, content }
    }
    
    console.log(`[translation-service] translateArticle: title="${title.substring(0, 50)}...", targetLang=${targetLang}, contentLength=${content.length}`)
    
    try {
        // Translate sequentially to respect rate limits
        // Title first (small text, quick)
        const translatedTitle = await translateText(title, targetLang)
        
        // Snippet second (also small)
        const translatedSnippet = await translateText(snippet, targetLang)
        
        // Content last (largest, takes longest)
        const translatedContent = await translateHtml(content, targetLang)
        
        console.log(`[translation-service] translateArticle DONE: title="${translatedTitle.substring(0, 50)}...", contentLength=${translatedContent.length}`)
        
        return {
            title: translatedTitle,
            snippet: translatedSnippet,
            content: translatedContent
        }
    } catch (error) {
        console.error("[translation-service] Article translation failed:", error)
        return { title, snippet, content }
    }
}

/**
 * Clear the translation cache
 */
export function clearTranslationCache(): void {
    translationCache.clear()
}

/**
 * Get cache statistics
 */
export function getCacheStats(): { size: number, maxSize: number } {
    return {
        size: translationCache.size,
        maxSize: MAX_CACHE_SIZE
    }
}

/**
 * Register IPC handlers for translation service
 */
export function registerTranslationIpc(): void {
    console.log(`[translation-service] Initializing with provider: ${currentProvider}`)
    if (currentProvider === "libretranslate") {
        console.log(`[translation-service] LibreTranslate URL: ${libreTranslateConfig.url}`)
    }
    
    // Translate text
    ipcMain.handle("translation:translateText", async (_, text: string, targetLang: string) => {
        return translateText(text, targetLang)
    })
    
    // Translate HTML
    ipcMain.handle("translation:translateHtml", async (_, html: string, targetLang: string) => {
        return translateHtml(html, targetLang)
    })
    
    // Translate article
    ipcMain.handle("translation:translateArticle", async (_, title: string, snippet: string, content: string, targetLang: string) => {
        return translateArticle(title, snippet, content, targetLang)
    })
    
    // Get supported languages
    ipcMain.handle("translation:getSupportedLanguages", async () => {
        return SUPPORTED_LANGUAGES
    })
    
    // Clear cache
    ipcMain.handle("translation:clearCache", async () => {
        clearTranslationCache()
        return true
    })
    
    // Get cache stats
    ipcMain.handle("translation:getCacheStats", async () => {
        return getCacheStats()
    })
    
    // Set translation provider
    ipcMain.handle("translation:setProvider", async (_, provider: TranslationProvider) => {
        setTranslationProvider(provider)
        return true
    })
    
    // Get current provider
    ipcMain.handle("translation:getProvider", async () => {
        return getTranslationProvider()
    })
    
    // Configure LibreTranslate
    ipcMain.handle("translation:setLibreTranslateConfig", async (_, url: string, apiKey?: string) => {
        setLibreTranslateConfig({ url, apiKey })
        return true
    })
    
    // Get LibreTranslate config
    ipcMain.handle("translation:getLibreTranslateConfig", async () => {
        return libreTranslateConfig
    })
}
