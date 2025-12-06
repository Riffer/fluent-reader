/**
 * Cookie Persistence Service
 * 
 * Speichert und lädt Cookies pro Host in separaten JSON-Dateien.
 * Ermöglicht persistente Sessions für Feeds die Login benötigen.
 */

import { app, session } from "electron"
import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"

// Typ für gespeicherte Cookie-Daten
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
        console.log("[CookiePersist] Created cookies directory:", dir)
    }
}

/**
 * Konvertiert einen Hostnamen in einen sicheren Dateinamen
 * - Ersetzt ungültige Zeichen für Windows-Dateisysteme
 * - Kürzt zu lange Namen mit Hash-Suffix
 */
export function hostToFilename(host: string): string {
    // Ungültige Zeichen für Windows-Dateisysteme ersetzen
    let sanitized = host.replace(/[<>:"\/\\|?*]/g, "_")

    // Maximale Länge beachten (255 chars inkl. .json)
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
 * Extrahiert den Host aus einer URL (behält Subdomain bei)
 */
export function extractHost(url: string): string | null {
    try {
        const parsed = new URL(url)
        return parsed.hostname // z.B. "www.reddit.com" oder "old.reddit.com"
    } catch {
        console.error("[CookiePersist] Invalid URL:", url)
        return null
    }
}

/**
 * Lädt gespeicherte Cookies für einen Host
 */
export async function loadCookiesForHost(
    host: string
): Promise<Electron.Cookie[]> {
    ensureCookiesDir()
    const filename = hostToFilename(host)
    const filepath = path.join(getCookiesDir(), filename)

    console.log("[CookiePersist] Loading cookies for host:", host)
    console.log("[CookiePersist] Cookie file path:", filepath)

    if (!fs.existsSync(filepath)) {
        console.log("[CookiePersist] No saved cookies found for host:", host)
        return []
    }

    try {
        const content = fs.readFileSync(filepath, "utf-8")
        const data: StoredCookieData = JSON.parse(content)
        console.log(
            "[CookiePersist] Loaded",
            data.cookies.length,
            "cookies for host:",
            host
        )
        console.log(
            "[CookiePersist] Last updated:",
            data.lastUpdated
        )
        return data.cookies
    } catch (e) {
        console.error("[CookiePersist] Error loading cookies for host:", host, e)
        return []
    }
}

/**
 * Speichert Cookies für einen Host
 */
export async function saveCookiesForHost(
    host: string,
    cookies: Electron.Cookie[]
): Promise<boolean> {
    ensureCookiesDir()
    const filename = hostToFilename(host)
    const filepath = path.join(getCookiesDir(), filename)

    console.log("[CookiePersist] Saving", cookies.length, "cookies for host:", host)
    console.log("[CookiePersist] Cookie file path:", filepath)

    // Cookie-Namen loggen (ohne Werte für Sicherheit)
    cookies.forEach((cookie, i) => {
        console.log(
            `[CookiePersist]   [${i + 1}] ${cookie.name} (domain: ${cookie.domain}, path: ${cookie.path})`
        )
    })

    const data: StoredCookieData = {
        host,
        lastUpdated: new Date().toISOString(),
        cookies,
    }

    try {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8")
        console.log("[CookiePersist] Cookies saved successfully:", filepath)
        return true
    } catch (e) {
        console.error("[CookiePersist] Error saving cookies for host:", host, e)
        return false
    }
}

/**
 * Löscht gespeicherte Cookies für einen Host
 */
export async function deleteCookiesForHost(host: string): Promise<boolean> {
    const filename = hostToFilename(host)
    const filepath = path.join(getCookiesDir(), filename)

    console.log("[CookiePersist] Deleting cookies for host:", host)

    if (!fs.existsSync(filepath)) {
        console.log("[CookiePersist] No cookie file exists for host:", host)
        return true
    }

    try {
        fs.unlinkSync(filepath)
        console.log("[CookiePersist] Deleted cookie file:", filepath)
        return true
    } catch (e) {
        console.error("[CookiePersist] Error deleting cookies for host:", host, e)
        return false
    }
}

/**
 * Holt aktuelle Cookies aus der Session für einen Host
 * Sammelt alle Cookies die für die Domain relevant sind
 */
export async function getCookiesFromSession(
    ses: Electron.Session,
    host: string
): Promise<Electron.Cookie[]> {
    console.log("[CookiePersist] Getting cookies from session for host:", host)
    
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
        
        // 1. Alle Cookies für die URL (http + https)
        try {
            const urlCookies = await ses.cookies.get({ url: `https://${host}` })
            console.log("[CookiePersist] Found", urlCookies.length, "cookies for https URL")
            urlCookies.forEach(addCookie)
        } catch (e) {
            console.log("[CookiePersist] Error getting URL cookies:", e)
        }
        
        // 2. Cookies mit exakter Domain
        try {
            const exactCookies = await ses.cookies.get({ domain: host })
            console.log("[CookiePersist] Found", exactCookies.length, "cookies for exact domain:", host)
            exactCookies.forEach(addCookie)
        } catch (e) {
            console.log("[CookiePersist] Error getting exact domain cookies:", e)
        }
        
        // 3. Cookies mit .domain (z.B. .reddit.com)
        try {
            const dotDomainCookies = await ses.cookies.get({ domain: "." + baseDomain })
            console.log("[CookiePersist] Found", dotDomainCookies.length, "cookies for dot-domain:", "." + baseDomain)
            dotDomainCookies.forEach(addCookie)
        } catch (e) {
            console.log("[CookiePersist] Error getting dot-domain cookies:", e)
        }
        
        // 4. Cookies für www. subdomain falls nicht bereits host
        if (!host.startsWith("www.")) {
            try {
                const wwwCookies = await ses.cookies.get({ domain: "www." + baseDomain })
                console.log("[CookiePersist] Found", wwwCookies.length, "cookies for www subdomain")
                wwwCookies.forEach(addCookie)
            } catch (e) {
                console.log("[CookiePersist] Error getting www cookies:", e)
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
            console.log("[CookiePersist] Found", relevantCookies.length, "cookies via fallback filter (from", allSessionCookies.length, "total)")
            relevantCookies.forEach(addCookie)
        } catch (e) {
            console.log("[CookiePersist] Error getting all cookies:", e)
        }
        
        console.log("[CookiePersist] Total unique cookies collected:", allCookies.length)
        
        // Cookie-Namen loggen
        allCookies.forEach((cookie, i) => {
            console.log(`[CookiePersist]   [${i + 1}] ${cookie.name} (domain: ${cookie.domain}, secure: ${cookie.secure}, httpOnly: ${cookie.httpOnly})`)
        })
        
        return allCookies
    } catch (e) {
        console.error("[CookiePersist] Error getting cookies from session:", e)
        return []
    }
}

/**
 * Setzt Cookies in die Session für einen Host
 */
export async function setCookiesToSession(
    ses: Electron.Session,
    host: string,
    cookies: Electron.Cookie[]
): Promise<number> {
    console.log("[CookiePersist] Setting", cookies.length, "cookies to session for host:", host)
    
    let successCount = 0
    
    for (const cookie of cookies) {
        try {
            // URL für das Cookie konstruieren
            const protocol = cookie.secure ? "https" : "http"
            const domain = cookie.domain.startsWith(".") 
                ? cookie.domain.substring(1) 
                : cookie.domain
            const url = `${protocol}://${domain}${cookie.path || "/"}`
            
            // Cookie setzen
            await ses.cookies.set({
                url,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                expirationDate: cookie.expirationDate,
                sameSite: cookie.sameSite,
            })
            
            console.log(`[CookiePersist]   Set cookie: ${cookie.name} (domain: ${cookie.domain})`)
            successCount++
        } catch (e) {
            console.error(`[CookiePersist]   Failed to set cookie: ${cookie.name}`, e)
        }
    }
    
    console.log("[CookiePersist] Successfully set", successCount, "of", cookies.length, "cookies")
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
        
        console.log("[CookiePersist] Found saved cookies for", hosts.length, "hosts")
        return hosts
    } catch (e) {
        console.error("[CookiePersist] Error listing saved hosts:", e)
        return []
    }
}
