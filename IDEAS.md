# Feature Ideas

## SQLite3 Datenbank-Migration

**Status:** ✅ Implementiert (Dezember 2025)

**Beschreibung:**
Die alte Datenbank-Komponente (Lovefield/IndexedDB) wurde auf SQLite3 migriert für bessere Performance, Stabilität und Sicherheit.

**Implementierte Features:**
- ✅ `src/main/db-sqlite.ts` - SQLite3-Wrapper im Main Process mit `better-sqlite3`
- ✅ `src/bridges/db.ts` - IPC-Bridge für Renderer-Zugriff auf DB-Funktionen
- ✅ Automatische Migration von Lovefield/IndexedDB zu SQLite3 (`migrateLovefieldToSQLite()`)
- ✅ Schema-Definition für SQLite3 (sources + items Tabellen)
- ✅ WAL-Modus für bessere Performance
- ✅ Batch-Insert für große Datenmengen (500 Items pro Batch)
- ✅ `useLovefield` Flag in `config.json` zur Steuerung der Migration

**Architektur:**
- SQLite3 läuft im **Main Process** (`src/main/db-sqlite.ts`)
- Renderer kommuniziert via **IPC** mit Main Process für alle DB-Operationen
- Bridge exponiert `window.db.*` API für Renderer-Zugriff
- Webpack `externals` für `better-sqlite3` (native Module)

**Verwendete Dependencies:**
- `better-sqlite3`: ^12.4.6 (synchrone API, 2-10x schneller als sqlite3)
- `@types/better-sqlite3`: ^7.6.8 (TypeScript-Typen)

*Hinweis: `sqlite3` wurde entfernt da `better-sqlite3` die bevorzugte Lösung für Electron ist.*

**Neue Dateien:**
- `src/main/db-sqlite.ts` - SQLite3-Wrapper mit allen CRUD-Operationen
- `src/bridges/db.ts` - IPC-Bridge für Renderer

**Geänderte Dateien:**
- `src/scripts/db.ts` - Migration von Lovefield → SQLite3
- `src/main/window.ts` - DB-Initialisierung + IPC-Handler
- `src/main/settings.ts` - `useLovefield` Setting
- `src/bridges/settings.ts` - `getLovefieldStatus()` / `setLovefieldStatus()`
- `src/preload.ts` - `window.db` exponiert
- `src/types/window.d.ts` - `DbBridge` Typen
- `src/schema-types.ts` - `useLovefield` in SchemaTypes
- `webpack.config.js` - `externals` für `better-sqlite3`

**SQLite3-Schema:**

```sql
-- sources Tabelle
CREATE TABLE sources (
    sid INTEGER PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    iconurl TEXT,
    name TEXT NOT NULL,
    openTarget INTEGER NOT NULL DEFAULT 0,
    defaultZoom REAL NOT NULL DEFAULT 1.0,
    lastFetched TEXT NOT NULL,
    serviceRef TEXT,
    fetchFrequency INTEGER NOT NULL DEFAULT 0,
    rules TEXT,  -- JSON
    textDir INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    mobileMode INTEGER NOT NULL DEFAULT 0,
    persistCookies INTEGER NOT NULL DEFAULT 0
);

-- items Tabelle
CREATE TABLE items (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    source INTEGER NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    date TEXT NOT NULL,
    fetchedDate TEXT NOT NULL,
    thumb TEXT,
    content TEXT NOT NULL,
    snippet TEXT NOT NULL,
    creator TEXT,
    hasRead INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 0,
    serviceRef TEXT,
    FOREIGN KEY (source) REFERENCES sources(sid) ON DELETE CASCADE
);

-- Indizes für Performance
CREATE INDEX idx_items_date ON items(date DESC);
CREATE INDEX idx_items_source ON items(source);
CREATE INDEX idx_items_serviceRef ON items(serviceRef);
CREATE INDEX idx_items_hasRead ON items(hasRead);
CREATE INDEX idx_items_starred ON items(starred);
```

**Migration:**
- Migration läuft automatisch beim ersten Start nach Update
- Prüft `useLovefield` Flag (Default: `true` für bestehende Nutzer)
- Kopiert alle Sources und Items in Batches (500 Items/Batch)
- Setzt `useLovefield: false` nach erfolgreicher Migration
- Fehlerbehandlung: Bei Fehler bleibt Lovefield aktiv

**Speicherort:**
- SQLite-DB: `%APPDATA%/Electron/fluent-reader.db` (Dev) bzw. `%APPDATA%/Fluent Reader/fluent-reader.db` (Prod)
- Config: `%APPDATA%/Electron/config.json`

---

## ToDo: Entfernung der alten Datenbank-Komponenten

**Status:** Ausstehend (nach Stabilisierungsphase)

**Nach erfolgreicher Migration und Stabilisierung:**
- [ ] Entfernen von Lovefield-Dependency (`lovefield` Package)
- [ ] Entfernen von NeDB-Dependency (`@seald-io/nedb` Package)
- [ ] Entfernen der Lovefield-Schema-Definition in `db.ts`
- [ ] Entfernen von `migrateNeDB()` und `migrateLovefieldToSQLite()`
- [ ] Refactoring aller DB-Operationen auf `window.db.*` (direkte SQLite-Nutzung)
- [ ] Entfernen von `useLovefield` und `useNeDB` Settings
- [ ] Entfernen der IndexedDB-Daten (nach Bestätigung durch User)
- [ ] Tests: Sicherstellen, dass alle Features mit SQLite3 funktionieren
- [ ] Dokumentation und Changelog aktualisieren

**Hinweis:**
Die Entfernung sollte erst nach mehreren Releases und ausreichend Nutzer-Feedback erfolgen, um Datenverlust zu vermeiden. Vorher: Backup-Empfehlung für Nutzer!

---

## Persistente Cookie-Speicherung pro Feed

**Status:** ✅ Implementiert (v1.1.7)

**Beschreibung:**
Für Seiten die Login benötigen (z.B. Paywalls, Member-Bereiche) werden Cookies automatisch gespeichert und beim Laden wiederhergestellt.

**Implementierte Features:**
- ✅ `persistCookies` Eigenschaft pro Feed (aktivierbar via Kontextmenü)
- ✅ Automatisches Laden der Cookies beim Seitenstart (`did-start-loading`)
- ✅ Automatisches Speichern nach Navigation (`did-navigate`, `did-stop-loading`)
- ✅ Speicherung in JSON-Dateien pro Host (`%APPDATA%/Electron/cookies/`)
- ✅ Input-Modus (Ctrl+I) für Login-Formulare ohne Shortcut-Konflikte
- ✅ OPML Export/Import unterstützt `persistCookies`
- ✅ Datenbank-Schema erweitert (Version 7)

**Neue Dateien:**
- `src/main/cookie-persist.ts` - Cookie-Service (laden, speichern, löschen)

**Geänderte Dateien:**
- `src/scripts/db.ts` - Schema v7 mit `mobileMode` und `persistCookies` Spalten
- `src/scripts/models/source.ts` - `persistCookies` Feld + Migration
- `src/scripts/models/group.ts` - OPML Export/Import
- `src/main/window.ts` - IPC-Handler für Cookie-Operationen
- `src/bridges/utils.ts` - Renderer-Bridge-Funktionen
- `src/components/article.tsx` - Cookie-Integration + Input-Modus

**Benutzung:**
1. Feed auswählen → Rechtsklick → "Cookies speichern (Login)" aktivieren
2. Artikel in Webseiten-Ansicht öffnen
3. **Ctrl+I** → Input-Modus aktivieren → Einloggen → **ESC**
4. App neu starten → Eingeloggt bleiben!

**Technische Details:**
- Session-Partition: `sandbox` (ohne `persist:` Prefix)
- Debouncing: Max. 1 Cookie-Speicherung pro Sekunde (für SPAs wie Reddit)
- Umfassendes Cookie-Sammeln: URL, Domain, Dot-Domain, www-Subdomain, Fallback-Filter

**Anwendungsfälle:**
- Paywalled Nachrichtenseiten (z.B. NYTimes, Spiegel+)
- Member-Bereiche mit Login
- Seiten mit Session-basierter Authentifizierung
- Trennung von NSFW/normalen Inhalten bei gleichem Host (z.B. Reddit)

**Architektur-Entscheidungen:**

| Aspekt | Entscheidung | Begründung |
|--------|--------------|------------|
| Aktivierung | Pro Feed | Ermöglicht gezielte Kontrolle, z.B. NSFW-Feeds ohne Cookie-Speicherung |
| Speicherung | Pro Host | Vermeidet Redundanz, Login gilt für alle Feeds mit gleichem Host |
| Modus | Automatisch | Cookies werden automatisch gespeichert/geladen |
| Verschlüsselung | Nein | Einfachheit, lokale Speicherung |

**Datenmodell:**

```typescript
// RSSSource (bestehendes Model erweitern)
interface RSSSource {
  // ... bestehende Felder
  persistCookies: boolean  // NEU: Aktiviert Cookie-Persistenz für diesen Feed
}

// Neue Tabelle/Store für Host-Cookies
interface HostCookies {
  host: string           // PK, z.B. "reddit.com"
  cookies: string        // JSON-serialisierte Cookies
  lastUpdated: Date
}
```

**Ablauf - Cookie laden:**
1. Artikel öffnen → Prüfen ob `source.persistCookies === true`
2. Falls ja → Host aus URL extrahieren, gespeicherte Cookies für Host laden
3. Cookies in Webview-Session setzen via Electron API
4. Falls `persistCookies: false` → Keine Cookies laden, Session bleibt temporär

**Ablauf - Cookie speichern (mehrere Trigger):**

| Event | Beschreibung | Priorität |
|-------|--------------|-----------|
| `componentDidUpdate` | Artikelwechsel - alter Artikel wird verlassen | ✅ Kritisch |
| `componentWillUnmount` | Webview wird zerstört | ✅ Kritisch |
| `did-finish-load` | Seite fertig geladen (z.B. nach Login) | ✅ Wichtig |
| App-Beenden | `beforeunload` / `will-quit` | ✅ Backup |

```typescript
// Artikelwechsel (React Component)
componentDidUpdate(prevProps) {
  if (prevProps.item._id !== this.props.item._id) {
    // Alter Artikel wird verlassen → Cookies speichern
    this.saveCookiesForCurrentHost();
    // Neuer Artikel → Cookies laden
    this.loadCookiesForNewHost();
  }
}

componentWillUnmount() {
  // Webview wird zerstört → Cookies speichern
  this.saveCookiesForCurrentHost();
}

// Nach Seitenload (für Login-Flows)
webview.addEventListener('did-finish-load', () => {
  if (source.persistCookies) {
    this.saveCookiesForCurrentHost();
  }
});
```

**UI-Integration:**
- Feed-Einstellungen: Checkbox "Cookies persistent speichern"
- Artikel-Menü: "Cookies für [host] löschen" (optional)

**Technische Umsetzung:**
- Electron `session.cookies` API für Cookie-Zugriff
- Host bleibt vollständig erhalten (inkl. Subdomain): `www.reddit.com`, `old.reddit.com` separat
- Speicherung in separatem `cookies/`-Verzeichnis mit einer JSON-Datei pro Host

**Speicherstruktur:**
```
%APPDATA%/fluent-reader/
└── cookies/
    ├── www.reddit.com.json
    ├── old.reddit.com.json
    ├── shop.spiegel.de.json
    └── www.nytimes.com.json
```

**Dateiformat (pro Host):**
```json
{
  "host": "www.reddit.com",
  "lastUpdated": "2025-01-15T10:30:00.000Z",
  "cookies": [
    {
      "name": "session_token",
      "value": "abc123...",
      "domain": ".reddit.com",
      "path": "/",
      "httpOnly": true,
      "secure": true,
      "expirationDate": 1737000000
    }
  ]
}
```

**Hostname-Sanitisierung für Dateinamen:**
```typescript
function hostToFilename(host: string): string {
  // Ungültige Zeichen für Windows-Dateisysteme ersetzen
  let sanitized = host.replace(/[<>:"\/\\|?*]/g, '_');
  
  // Maximale Länge beachten (255 chars inkl. .json)
  if (sanitized.length > 200) {
    const hash = crypto.createHash('md5').update(host).digest('hex').substring(0, 8);
    sanitized = sanitized.substring(0, 190) + '_' + hash;
  }
  
  return sanitized + '.json';
}
```

**Wichtig:** Subdomains werden NICHT entfernt, da unterschiedliche Subdomains 
unterschiedliche Sessions haben können (z.B. `www.reddit.com` vs `old.reddit.com`).

---

## Suchfunktion für die Feedverwaltung

**Status:** Geplant

**Beschreibung:**
Eine Suchfunktion in der Feed-/Quellenverwaltung, um bei vielen Feeds schnell den gewünschten Feed zu finden.

**Anwendungsfälle:**
- Schnelles Auffinden eines Feeds bei großer Anzahl von Abonnements
- Filtern nach Feed-Namen oder URL

**Mögliche Features:**
- Suchfeld im Feed-Management Dialog
- Live-Filterung während der Eingabe
- Suche nach Name und/oder URL

---

## Fix: Unhandled Promise Rejection in parseRSS

**Status:** ✅ Behoben (v1.1.7)

**Beschreibung:**
Bei fehlgeschlagenen RSS-Feed-Abrufen wurde der Fehler als `Uncaught (in promise)` geworfen, da das Promise nicht korrekt behandelt wurde.

**Fehlermeldung:**
```
utils.ts:113 Uncaught (in promise) 
parseRSS @ utils.ts:113
```

**Ursache:**
- `parseRSS()` wirft Fehler wenn Feed ungültig ist oder Netzwerkfehler auftritt
- In `sources.tsx` wurde `addSource()` ohne `.catch()` aufgerufen

**Lösung:**
- `.catch()` in `sources.tsx:addSource()` hinzugefügt
- Fehler werden bereits in Redux-Action behandelt und dem Benutzer angezeigt
- Der `.catch()` verhindert nur die Console-Warnung

---

## Mobile Mode Toggle via Browser-Symbol

**Status:** Idee

**Beschreibung:**
Derzeit gibt es ein Browser-Symbol, das beim Klick "Lade vollständigen Inhalt" aktiviert. Die Idee ist, bei einem zweiten Klick auf das Symbol stattdessen den Mobile Mode zu toggeln.

**Konzept:**
1. **Erster Klick**: Aktiviert "Lade vollständigen Inhalt" (wie bisher)
2. **Zweiter Klick**: Schaltet Mobile Mode ein/aus
3. **Visuelles Feedback**: Symbol-Änderung je nach aktivem Modus

**Symbol-Zustände:**
| Zustand | Symbol | Beschreibung |
|---------|--------|--------------|
| Standard | 🌐 | Normale Ansicht |
| Vollständig | 📄 | Lade vollständigen Inhalt aktiv |
| Mobile | 📱 | Mobile Emulation aktiv |

**Vorteile:**
- Schneller Zugriff auf Mobile Mode ohne zusätzlichen Menüeintrag
- Intuitives 3-Stufen-Toggle
- Spart Platz in der UI

**Zu klären:**
- [ ] Exaktes Symbol-Design für jeden Zustand
- [ ] Soll der Zustand pro Feed oder global gespeichert werden?
- [ ] Tooltip-Texte für jeden Zustand

---

## Shortcut-Deaktivierung bei Webview-Eingabefeldern

**Status:** ✅ Implementiert (v1.1.7) - als "Input-Modus"

**Beschreibung:**
Wenn der Benutzer im Webview in ein Login-Formular oder anderes Eingabefeld tippt, werden die Shortcuts (z.B. `L`, `M`, `S`, `+`, `-`) fälschlicherweise als Befehle interpretiert statt als Texteingabe.

**Implementierte Lösung: Manueller Input-Modus**

Statt automatischer Fokus-Erkennung wurde ein manueller Input-Modus implementiert:

| Taste | Aktion |
|-------|--------|
| **Ctrl+I** | Input-Modus ein/aus |
| **ESC** | Input-Modus beenden + Cookies speichern |

**Visuelles Feedback:**
- Grüner Badge "⌨ EINGABE" in der Toolbar wenn Input-Modus aktiv
- Menüeintrag zeigt aktuellen Status

**Vorteile gegenüber automatischer Fokus-Erkennung:**
- Zuverlässiger (keine Fokus-Events aus Iframes/Shadow DOM)
- Explizite Kontrolle durch Benutzer
- Cookie-Speicherung bei ESC (nach Login-Abschluss)

**Erlaubte Shortcuts im Input-Modus:**
| Taste | Aktion |
|-------|--------|
| `Ctrl+I` | Input-Modus beenden |
| `ESC` | Input-Modus beenden + Cookies speichern |

Alle anderen Shortcuts sind deaktiviert um normale Texteingabe zu ermöglichen.

---

## Ursprüngliche Idee: Automatische Fokus-Erkennung (nicht implementiert)

**Problem:**
- `keyDownHandler` in `article.tsx` empfängt alle Tasteneingaben aus dem Webview via IPC
- Tasten wie `L` (Lade vollständigen Inhalt), `M` (Mark read), `S` (Star), `+`/`-` (Zoom) werden abgefangen
- Benutzer kann nicht normal in Login-Formulare tippen

**Technische Lösung:**

1. **Signal aus webview-preload.js:**
```javascript
// Fokus-Tracking für Eingabefelder
document.addEventListener('focusin', (e) => {
    const isInput = e.target.tagName === 'INPUT' || 
                    e.target.tagName === 'TEXTAREA' ||
                    e.target.isContentEditable;
    ipcRenderer.sendToHost('input-focus-changed', isInput);
});

document.addEventListener('focusout', (e) => {
    ipcRenderer.sendToHost('input-focus-changed', false);
});
```

2. **State in article.tsx:**
```typescript
state = {
    // ... existing state
    webviewInputFocused: boolean  // NEU
}

// Beim Webview-Setup
webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'input-focus-changed') {
        this.setState({ webviewInputFocused: event.args[0] });
    }
});
```

3. **Anpassung keyDownHandler:**
```typescript
keyDownHandler = (input: Electron.Input) => {
    // Bei fokussiertem Input: nur Escape und Navigation erlauben
    if (this.state.webviewInputFocused) {
        const allowedKeys = ['Escape', 'ArrowLeft', 'ArrowRight', 'F1', 'F2', 'F5'];
        if (!allowedKeys.includes(input.key)) {
            return; // Normale Texteingabe zulassen
        }
    }
    // ... rest des Handlers
}
```

**Erlaubte Shortcuts bei fokussiertem Input:**
| Taste | Aktion | Grund |
|-------|--------|-------|
| `Escape` | Artikel schließen | Wichtige Navigation |
| `ArrowLeft/Right` | Vorheriger/Nächster Artikel | Navigation |
| `F1-F9` | Menü, Suche, etc. | Keine Texteingabe-Konflikte |

**Blockierte Shortcuts bei fokussiertem Input:**
| Taste | Normale Aktion | Konflikt mit |
|-------|---------------|--------------|
| `L` | Lade vollständigen Inhalt | Buchstabe L |
| `M` | Als gelesen markieren | Buchstabe M |
| `S` | Favorit | Buchstabe S |
| `H` | Verstecken | Buchstabe H |
| `B` | Im Browser öffnen | Buchstabe B |
| `+`/`-` | Zoom | Zahlen/Sonderzeichen |
| `W` | Toggle Full | Buchstabe W |

**Fazit:** Automatische Fokus-Erkennung wurde verworfen zugunsten des manuellen Input-Modus (Ctrl+I), da dieser zuverlässiger und einfacher zu implementieren ist.

---

## Kollabierbare Feedliste mit veränderbarer Breite

**Status:** Geplant

**Beschreibung:**
Die Feedliste (linke Sidebar) soll kollabierbar sein, um mehr Platz für die Artikelanzeige zu schaffen. Zusätzlich soll die Breite der Feedliste via Drag & Drop anpassbar sein.

**Geplante Features:**
- [ ] Kollabierter Modus: Nur Icons anzeigen (Feed-Icons oder Gruppen-Icons)
- [ ] Expandierter Modus: Vollständige Ansicht mit Namen (wie bisher)
- [ ] Verschiebbarer Teiler (Splitter/Divider) zwischen Feedliste und Artikelbereich
- [ ] Drag & Drop mit Maus oder Touchscreen
- [ ] Speicherung der Breite in den Einstellungen (persistent)
- [ ] Minimum-/Maximum-Breite für beide Bereiche

**UI-Konzept:**

| Modus | Darstellung | Breite |
|-------|-------------|--------|
| Expandiert | Icon + Feed-Name | ~200-400px (anpassbar) |
| Kollabiert | Nur Icon | ~48px (fest) |
| Versteckt | Komplett ausgeblendet | 0px |

**Toggle-Möglichkeiten:**
- Button/Icon zum Ein-/Ausklappen
- Doppelklick auf Teiler → Kollabieren/Expandieren
- Shortcut (z.B. `Ctrl+B` für "toggle sidebar")
- Ziehen des Teilers auf Minimum → automatisch kollabieren

**Technische Umsetzung:**

1. **CSS Flexbox/Grid mit variablen Breiten:**
```css
.sidebar {
  width: var(--sidebar-width, 250px);
  min-width: 48px;  /* Kollabiert: nur Icons */
  max-width: 50vw;  /* Maximal 50% des Viewports */
  transition: width 0.2s ease;
}

.sidebar.collapsed {
  width: 48px;
}

.divider {
  width: 4px;
  cursor: col-resize;
  background: var(--divider-color);
}
```

2. **React State für Breite:**
```typescript
interface SidebarState {
  width: number;       // Aktuelle Breite in px
  isCollapsed: boolean; // Kollabierter Modus
  isDragging: boolean;  // Wird gerade gezogen?
}
```

3. **Drag-Handler:**
```typescript
const handleMouseDown = (e: React.MouseEvent) => {
  setIsDragging(true);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
};

const handleMouseMove = (e: MouseEvent) => {
  const newWidth = e.clientX;
  if (newWidth < 80) {
    setIsCollapsed(true);
  } else {
    setIsCollapsed(false);
    setWidth(Math.min(newWidth, maxWidth));
  }
};
```

4. **Touch-Support:**
```typescript
const handleTouchStart = (e: React.TouchEvent) => {
  setIsDragging(true);
  // Touch-Events analog zu Mouse-Events
};
```

**Betroffene Komponenten:**
- `src/components/nav.tsx` - Feedliste-Komponente
- `src/components/page.tsx` - Layout-Container
- `src/components/root.tsx` - Hauptlayout
- Neue Komponente: `src/components/utils/resizable-divider.tsx`

**Einstellungen:**
- `sidebarWidth: number` - Gespeicherte Breite
- `sidebarCollapsed: boolean` - Kollabierter Zustand
- In `config.json` oder Redux Store persistent speichern

**Accessibility:**
- Keyboard-Navigation für Teiler (z.B. Arrow-Keys zum Verschieben)
- ARIA-Labels für Screen Reader
- Fokus-Indikator auf Teiler

**Ähnliche Implementierungen:**
- VS Code Sidebar
- Slack Workspace-Liste
- Discord Server-Liste (kollabiert nur Icons)

---

## Userscript-System für Cookie-Banner und Webseiten-Automatisierung

**Status:** Idee

**Beschreibung:**
Ein Greasemonkey/Tampermonkey-ähnliches System zur automatischen Ausführung von JavaScript auf Webseiten im Webview. Hauptanwendungsfall: Automatisches Wegklicken von Cookie-Consent-Bannern, aber auch andere Automatisierungen möglich.

**Motivation:**
- Cookie-Banner nerven beim Lesen von Artikeln
- Viele Seiten haben unterschiedliche Banner-Implementierungen
- Community kann Skripte teilen und pflegen
- Flexibler als hartcodierte Lösungen

**Geplante Features:**
- [ ] Userscript-Manager in den Einstellungen
- [ ] Skript-Editor mit Syntax-Highlighting
- [ ] Import/Export von Skripten
- [ ] Aktivierung pro Domain oder global
- [ ] `@match`/`@include`/`@exclude` Pattern wie Greasemonkey
- [ ] Vorgefertigte Skripte für gängige Cookie-Banner
- [ ] Community-Repository für Skripte (optional)

**Userscript-Format (kompatibel mit Greasemonkey):**

```javascript
// ==UserScript==
// @name         Auto Cookie Consent
// @namespace    fluent-reader
// @version      1.0
// @description  Automatically accepts cookie banners
// @match        *://*/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';
    
    // Gängige Cookie-Banner Selektoren
    const selectors = [
        // "Alle akzeptieren" Buttons
        '[data-testid="cookie-accept"]',
        '#onetrust-accept-btn-handler',
        '.cookie-consent-accept',
        '[aria-label*="accept cookies"]',
        'button[contains(text(), "Alle akzeptieren")]',
        'button[contains(text(), "Accept all")]',
        '.sp_choice_type_11', // SourcePoint
        '#didomi-notice-agree-button', // Didomi
        '.css-47sehv', // Vercel/Next.js common
        
        // CMP-spezifische
        '.cmp-accept-all',
        '#consent-accept-all',
        '.fc-cta-consent', // Funding Choices
    ];
    
    function clickFirstMatch() {
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el && el.offsetParent !== null) {
                el.click();
                console.log('[Fluent Reader] Cookie banner dismissed:', selector);
                return true;
            }
        }
        return false;
    }
    
    // Sofort versuchen
    if (!clickFirstMatch()) {
        // Falls nicht sofort gefunden, mit MutationObserver warten
        const observer = new MutationObserver(() => {
            if (clickFirstMatch()) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        
        // Timeout nach 10 Sekunden
        setTimeout(() => observer.disconnect(), 10000);
    }
})();
```

**Technische Umsetzung:**

1. **Skript-Speicherung:**
```typescript
interface UserScript {
  id: string;
  name: string;
  version: string;
  description: string;
  code: string;
  enabled: boolean;
  matches: string[];      // URL-Pattern
  excludes: string[];
  runAt: 'document-start' | 'document-end' | 'document-idle';
  lastModified: Date;
}
```

2. **Speicherort:**
```
%APPDATA%/Fluent Reader/
└── userscripts/
    ├── manifest.json      // Liste aller Skripte mit Metadaten
    ├── cookie-consent.js
    ├── paywall-bypass.js
    └── custom-styles.js
```

3. **Skript-Injection via webview-preload.js:**
```javascript
// In webview-preload.js
const { ipcRenderer } = require('electron');

// Skripte vom Main Process holen
const scripts = ipcRenderer.sendSync('get-userscripts-for-url', window.location.href);

scripts.forEach(script => {
  if (script.runAt === 'document-start') {
    executeScript(script.code);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  scripts.filter(s => s.runAt === 'document-end').forEach(s => executeScript(s.code));
});

// document-idle nach Load-Event
window.addEventListener('load', () => {
  setTimeout(() => {
    scripts.filter(s => s.runAt === 'document-idle').forEach(s => executeScript(s.code));
  }, 100);
});

function executeScript(code) {
  try {
    const fn = new Function(code);
    fn();
  } catch (e) {
    console.error('[UserScript Error]', e);
  }
}
```

4. **URL-Pattern Matching:**
```typescript
function matchesPattern(url: string, pattern: string): boolean {
  // Konvertiere Greasemonkey-Pattern zu RegExp
  // *://*.example.com/* → https?://[^/]*\.example\.com/.*
  const regexPattern = pattern
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\./g, '\\.');
  return new RegExp(`^${regexPattern}$`).test(url);
}
```

**UI-Design:**

| Bereich | Beschreibung |
|---------|--------------|
| Skript-Liste | Tabelle mit Name, Version, Status (an/aus), Match-Count |
| Editor | Monaco Editor oder CodeMirror mit JS-Highlighting |
| Import | Drag & Drop oder Datei-Dialog für .user.js Dateien |
| Export | Einzeln oder alle als ZIP |
| Vorlagen | Dropdown mit vorgefertigten Skripten |

**Vorgefertigte Skripte:**
- 🍪 **Cookie Consent Auto-Accept** - Klickt gängige Cookie-Banner weg
- 🚫 **Ad-Placeholder Remover** - Entfernt leere Ad-Container
- 📖 **Reader Mode Enhancer** - Verbessert Lesbarkeit
- 🔗 **External Link Handler** - Öffnet externe Links im Browser

**Sicherheitsüberlegungen:**
- Skripte laufen im Webview-Context (sandboxed)
- Kein Zugriff auf Electron/Node APIs aus Userscripts
- Warnung beim Import von externen Skripten
- Optional: Skript-Signierung für vertrauenswürdige Quellen

**Betroffene Dateien:**
- `src/renderer/webview-preload.js` - Skript-Injection
- `src/main/userscripts.ts` - NEU: Skript-Management
- `src/components/settings/userscripts.tsx` - NEU: UI
- `src/bridges/userscripts.ts` - NEU: IPC-Bridge

**Alternativen/Ergänzungen:**
- Integration mit existierenden Filterlisten (EasyList, uBlock)
- CSS-Injection für kosmetische Filter
- Element-Picker zum visuellen Erstellen von Regeln

**Referenzen:**
- [Greasemonkey Manual](https://wiki.greasespot.net/)
- [Tampermonkey Documentation](https://www.tampermonkey.net/documentation.php)
- [I don't care about cookies](https://www.i-dont-care-about-cookies.eu/) - Filterliste

---

## Comic-Modus Verbesserungen

**Status:** Teilweise implementiert (Dezember 2025)

**Beschreibung:**
Der Comic-Modus optimiert die Darstellung von bildlastigen Feeds (Comics, Webcomics) mit wenig Text.

**Implementierte Features:**
- ✅ Automatische Erkennung: `totalImages > 0 && textLength < 200`
- ✅ CSS-Klasse `comic-mode` für angepasstes Layout
- ✅ Entfernung doppelter Bilder (Fancybox/Lightbox-Links)
- ✅ URL-Normalisierung für zuverlässige Duplikaterkennung

**Bekannte Einschränkungen:**

| Problem | Beschreibung | Workaround |
|---------|--------------|------------|
| **Aufgeblähte kleine Bilder** | Alle Bilder werden im Comic-Modus auf gleiche Größe skaliert, auch kleine Icons oder Nebenbilder | Externe Feed-Bereinigung via RSS-Bridge |
| **Hauptbild-Erkennung** | Keine zuverlässige Methode um das "Hauptbild" von Nebenbildern zu unterscheiden | - |
| **Bildgröße unbekannt** | Tatsächliche Pixelgröße ist erst nach dem Laden bekannt | - |

**Nicht implementiert (bewusst):**

- **Größenbasierte Filterung**: Problematisch, da Werbebanner oft größer als Comics sind
- **Positionsbasierte Filterung**: Erste Bilder sind nicht immer das Hauptbild
- **Container-basierte Erkennung**: Jede Website hat andere HTML-Struktur

**Empfohlene externe Lösung:**
Für komplexe Feed-Bereinigung wird [RSS-Bridge](https://github.com/RSS-Bridge/rss-bridge) empfohlen. RSS-Bridge kann Feeds vor der Anzeige in Fluent Reader filtern und transformieren. Eine Integration in Fluent Reader selbst wäre zu umfangreich.

**Betroffene Dateien:**
- `src/components/article.tsx` - `cleanDuplicateContent()`, `isComicMode` Logik

