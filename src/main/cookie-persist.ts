/**
 * Cookie Persistence Service
 * 
 * Stores and loads cookies per host in separate JSON files.
 * Enables persistent sessions for feeds that require login.
 */

import { app, session } from "electron"
import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"

// Type for stored cookie data
interface StoredCookieData {
    host: string
    lastUpdated: string
    cookies: Electron.Cookie[]
}

// Pfad zum Cookie-Verzeichnis
const getCookiesDir = (): string => {
    return path.join(app.getPath("userData"), "cookies")
}

/**
 * Stellt sicher dass das cookies/ Verzeichnis existiert
 */
const ensureCookiesDir = (): void => {
    const dir = getCookiesDir()
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
    }
}

/**
 * Converts a hostname to a safe filename
 * - Replaces invalid characters for Windows file systems
 * - Shortens names that are too long with a hash suffix
 */
export function hostToFilename(host: string): string {
    // Replace invalid characters for Windows file systems
    let sanitized = host.replace(/[<>:"\/\\|?*]/g, "_")

    // Observe maximum length (255 chars including .json)
    if (sanitized.length > 200) {
        const hash = crypto
            .createHash("md5")
            .update(host)
            .digest("hex")
            .substring(0, 8)
        sanitized = sanitized.substring(0, 190) + "_" + hash
    }

    return sanitized + ".json"
}

/**
 * Extracts the host from a URL (preserves subdomain)
 */
export function extractHost(url: string): string | null {
    try {
        const parsed = new URL(url)
        return parsed.hostname // e.g. "www.reddit.com" or "old.reddit.com"
    } catch {
        console.error("[CookiePersist] Invalid URL:", url)
        return null
    }
}

/**
 * Loads saved cookies for a host
 */
export async function loadCookiesForHost(
    host: string
): Promise<Electron.Cookie[]> {
    ensureCookiesDir()
    const filename = hostToFilename(host)
    const filepath = path.join(getCookiesDir(), filename)

    if (!fs.existsSync(filepath)) {
        return []
    }

    try {
        const content = fs.readFileSync(filepath, "utf-8")
        const data: StoredCookieData = JSON.parse(content)
        return data.cookies
    } catch (e) {
        console.error("[CookiePersist] Error loading cookies for host:", host, e)
        return []
    }
}

/**
 * Saves cookies for a host
 */
export async function saveCookiesForHost(
    host: string,
    cookies: Electron.Cookie[]
): Promise<boolean> {
    ensureCookiesDir()
    const filename = hostToFilename(host)
    const filepath = path.join(getCookiesDir(), filename)

    const data: StoredCookieData = {
        host,
        lastUpdated: new Date().toISOString(),
        cookies,
    }

    try {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8")
        return true
    } catch (e) {
        console.error("[CookiePersist] Error saving cookies for host:", host, e)
        return false
    }
}

/**
 * Deletes saved cookies for a host
 */
export async function deleteCookiesForHost(host: string): Promise<boolean> {
    const filename = hostToFilename(host)
    const filepath = path.join(getCookiesDir(), filename)

    if (!fs.existsSync(filepath)) {
        return true
    }

    try {
        fs.unlinkSync(filepath)
        return true
    } catch (e) {
        console.error("[CookiePersist] Error deleting cookies for host:", host, e)
        return false
    }
}

/**
 * Gets current cookies from session for a host
 * Collects all cookies relevant to the domain
 */
export async function getCookiesFromSession(
    ses: Electron.Session,
    host: string
): Promise<Electron.Cookie[]> {
    try {
        const baseDomain = host.replace(/^www\./, "")
        const allCookies: Electron.Cookie[] = []
        const seenKeys = new Set<string>()
        
        // Helper um Duplikate zu vermeiden
        const addCookie = (cookie: Electron.Cookie) => {
            const key = `${cookie.name}|${cookie.domain}|${cookie.path}`
            if (!seenKeys.has(key)) {
                seenKeys.add(key)
                allCookies.push(cookie)
            }
        }
        
        // 1. All cookies for the URL (http + https)
        try {
            const urlCookies = await ses.cookies.get({ url: `https://${host}` })
            urlCookies.forEach(addCookie)
        } catch (e) {
            // Ignore errors
        }
        
        // 2. Cookies mit exakter Domain
        try {
            const exactCookies = await ses.cookies.get({ domain: host })
            exactCookies.forEach(addCookie)
        } catch (e) {
            // Ignore errors
        }
        
        // 3. Cookies mit .domain (z.B. .reddit.com)
        try {
            const dotDomainCookies = await ses.cookies.get({ domain: "." + baseDomain })
            dotDomainCookies.forEach(addCookie)
        } catch (e) {
            // Ignore errors
        }
        
        // 4. Cookies for www. subdomain if not already host
        if (!host.startsWith("www.")) {
            try {
                const wwwCookies = await ses.cookies.get({ domain: "www." + baseDomain })
                wwwCookies.forEach(addCookie)
            } catch (e) {
                // Ignore errors
            }
        }
        
        // 5. Alle Cookies holen und nach Domain filtern (Fallback)
        try {
            const allSessionCookies = await ses.cookies.get({})
            const relevantCookies = allSessionCookies.filter(c => 
                c.domain === host ||
                c.domain === "." + baseDomain ||
                c.domain === "www." + baseDomain ||
                c.domain.endsWith("." + baseDomain)
            )
            relevantCookies.forEach(addCookie)
        } catch (e) {
            // Ignore errors
        }
        
        return allCookies
    } catch (e) {
        console.error("[CookiePersist] Error getting cookies from session:", e)
        return []
    }
}

/**
 * Sets cookies into session for a host
 */
export async function setCookiesToSession(
    ses: Electron.Session,
    host: string,
    cookies: Electron.Cookie[]
): Promise<number> {
    let successCount = 0
    
    for (const cookie of cookies) {
        try {
            // Always use HTTPS and secure: true when restoring cookies
            // This avoids "overwrite secure cookie" errors and is more secure anyway
            // Modern sites typically use HTTPS, and secure cookies work for both
            const domain = cookie.domain.startsWith(".") 
                ? cookie.domain.substring(1) 
                : cookie.domain
            const url = `https://${domain}${cookie.path || "/"}`
            
            // Cookie setzen - always as secure to avoid conflicts
            await ses.cookies.set({
                url,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: true,  // Always secure - works for HTTPS sites, avoids conflicts
                httpOnly: cookie.httpOnly,
                expirationDate: cookie.expirationDate,
                sameSite: cookie.sameSite,
            })
            successCount++
        } catch (e: any) {
            // Only log if it's not a secure-overwrite issue (those are harmless)
            const errorStr = String(e)
            const errorMsg = e?.message || ''
            const isSecureOverwrite = errorStr.includes('EXCLUDE_OVERWRITE_SECURE') || 
                                      errorMsg.includes('EXCLUDE_OVERWRITE_SECURE') ||
                                      errorStr.includes('overwritten a Secure cookie') ||
                                      errorMsg.includes('overwritten a Secure cookie')
            if (!isSecureOverwrite) {
                console.error(`[CookiePersist] Failed to set cookie: ${cookie.name}`, e)
            }
        }
    }
    
    return successCount
}

/**
 * Listet alle gespeicherten Cookie-Hosts auf
 */
export function listSavedHosts(): string[] {
    ensureCookiesDir()
    const dir = getCookiesDir()
    
    try {
        const files = fs.readdirSync(dir)
        const hosts: string[] = []
        
        for (const file of files) {
            if (file.endsWith(".json")) {
                try {
                    const filepath = path.join(dir, file)
                    const content = fs.readFileSync(filepath, "utf-8")
                    const data: StoredCookieData = JSON.parse(content)
                    hosts.push(data.host)
                } catch {
                    // Ignoriere fehlerhafte Dateien
                }
            }
        }
        
        return hosts
    } catch (e) {
        console.error("[CookiePersist] Error listing saved hosts:", e)
        return []
    }
}
