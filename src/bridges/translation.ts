/**
 * Translation Bridge
 * 
 * Provides renderer process access to the translation service in main process.
 */

import { ipcRenderer } from "electron"

export interface ArticleTranslation {
    title: string
    snippet: string
    content: string
}

export type TranslationProvider = "google" | "libretranslate"

export interface LibreTranslateConfig {
    url: string
    apiKey?: string
}

export interface TranslationBridge {
    /**
     * Translate plain text to target language
     */
    translateText(text: string, targetLang: string): Promise<string>
    
    /**
     * Translate HTML content while preserving tags
     */
    translateHtml(html: string, targetLang: string): Promise<string>
    
    /**
     * Translate article content (title, snippet, and HTML content)
     */
    translateArticle(title: string, snippet: string, content: string, targetLang: string): Promise<ArticleTranslation>
    
    /**
     * Get supported languages
     */
    getSupportedLanguages(): Promise<Record<string, string>>
    
    /**
     * Clear translation cache
     */
    clearCache(): Promise<boolean>
    
    /**
     * Get cache statistics
     */
    getCacheStats(): Promise<{ size: number, maxSize: number }>
    
    /**
     * Set translation provider ("google" or "libretranslate")
     */
    setProvider(provider: TranslationProvider): Promise<boolean>
    
    /**
     * Get current translation provider
     */
    getProvider(): Promise<TranslationProvider>
    
    /**
     * Configure LibreTranslate instance
     */
    setLibreTranslateConfig(url: string, apiKey?: string): Promise<boolean>
    
    /**
     * Get LibreTranslate configuration
     */
    getLibreTranslateConfig(): Promise<LibreTranslateConfig>
}

const translationBridge: TranslationBridge = {
    translateText: (text: string, targetLang: string) => 
        ipcRenderer.invoke("translation:translateText", text, targetLang),
    
    translateHtml: (html: string, targetLang: string) => 
        ipcRenderer.invoke("translation:translateHtml", html, targetLang),
    
    translateArticle: (title: string, snippet: string, content: string, targetLang: string) => 
        ipcRenderer.invoke("translation:translateArticle", title, snippet, content, targetLang),
    
    getSupportedLanguages: () => 
        ipcRenderer.invoke("translation:getSupportedLanguages"),
    
    clearCache: () => 
        ipcRenderer.invoke("translation:clearCache"),
    
    getCacheStats: () => 
        ipcRenderer.invoke("translation:getCacheStats"),
    
    setProvider: (provider: TranslationProvider) => 
        ipcRenderer.invoke("translation:setProvider", provider),
    
    getProvider: () => 
        ipcRenderer.invoke("translation:getProvider"),
    
    setLibreTranslateConfig: (url: string, apiKey?: string) => 
        ipcRenderer.invoke("translation:setLibreTranslateConfig", url, apiKey),
    
    getLibreTranslateConfig: () => 
        ipcRenderer.invoke("translation:getLibreTranslateConfig")
}

export default translationBridge
