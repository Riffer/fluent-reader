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


