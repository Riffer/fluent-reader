import { useState, useEffect, useRef } from "react"
import { RSSItem } from "../../scripts/models/item"
import { RSSSource } from "../../scripts/models/source"

// In-memory cache for translated content (survives component re-renders)
// Stores both the translated text AND whether it was actually translated or just fallback
const translationCache = new Map<string, { title: string; snippet: string; wasTranslated: boolean }>()

function getCacheKey(itemId: number, targetLang: string): string {
    return `${itemId}:${targetLang}`
}

export interface TranslatedContent {
    title: string
    snippet: string
    isTranslating: boolean
    isTranslated: boolean  // true if translation was actually performed (not fallback)
}

/**
 * Hook for on-demand translation of article title and snippet
 * Only translates when the component is visible and source has translateTo set
 */
export function useTranslation(item: RSSItem, source: RSSSource): TranslatedContent {
    const [translatedTitle, setTranslatedTitle] = useState<string | null>(null)
    const [translatedSnippet, setTranslatedSnippet] = useState<string | null>(null)
    const [isTranslating, setIsTranslating] = useState(false)
    const [wasTranslated, setWasTranslated] = useState(false)
    const isMounted = useRef(true)
    
    const targetLang = source.translateTo
    const shouldTranslate = !!targetLang
    
    useEffect(() => {
        isMounted.current = true
        return () => { isMounted.current = false }
    }, [])
    
    useEffect(() => {
        if (!shouldTranslate || !item._id) {
            return
        }
        
        const cacheKey = getCacheKey(item._id, targetLang)
        
        // Check cache first
        const cached = translationCache.get(cacheKey)
        if (cached) {
            setTranslatedTitle(cached.title)
            setTranslatedSnippet(cached.snippet)
            setWasTranslated(cached.wasTranslated)
            return
        }
        
        // Start translation
        setIsTranslating(true)
        
        const translateContent = async () => {
            try {
                // Translate title and snippet (not full content - that's done in article view)
                const [title, snippet] = await Promise.all([
                    window.translation.translateText(item.title, targetLang),
                    item.snippet ? window.translation.translateText(item.snippet, targetLang) : Promise.resolve("")
                ])
                
                // Check if we actually got a different translation
                // If rate limited, the service returns the original text
                const titleWasTranslated = title !== item.title
                const snippetWasTranslated = !item.snippet || snippet !== item.snippet
                const wasActuallyTranslated = titleWasTranslated || snippetWasTranslated
                
                if (isMounted.current) {
                    // Cache the result (even if not translated, to avoid re-trying immediately)
                    translationCache.set(cacheKey, { title, snippet, wasTranslated: wasActuallyTranslated })
                    
                    setTranslatedTitle(title)
                    setTranslatedSnippet(snippet)
                    setWasTranslated(wasActuallyTranslated)
                    setIsTranslating(false)
                }
            } catch (error) {
                console.error(`[useTranslation] Failed to translate item ${item._id}:`, error)
                if (isMounted.current) {
                    setIsTranslating(false)
                    setWasTranslated(false)
                }
            }
        }
        
        translateContent()
    }, [item._id, targetLang, shouldTranslate])
    
    return {
        title: translatedTitle ?? item.title,
        snippet: translatedSnippet ?? item.snippet,
        isTranslating,
        isTranslated: wasTranslated
    }
}

/**
 * Clear the translation cache (e.g., when language settings change)
 */
export function clearTranslationCache(): void {
    translationCache.clear()
}
