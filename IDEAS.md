# Feature Ideas

## SQLite3 Datenbank-Migration

**Status:** In Vorbereitung

**Beschreibung:**
Die alte Datenbank-Komponente (Lovefield/IndexedDB) ist veraltet und hat Sicherheitsprobleme. Migration auf SQLite3 für bessere Performance, Stabilität und Sicherheit.

**Aktuelle Situation:**
- **Lovefield** (Google) als primäre DB im Renderer-Prozess
- Nutzt **IndexedDB** als Backend
- Alte **NeDB**-Migration bereits implementiert (`migrateNeDB()` in `db.ts`)
- Lovefield wird nicht mehr aktiv gewartet

**Bereits vorbereitete Dependencies:**
- `better-sqlite3`: ^12.4.6 (synchrone API, bessere Performance)
- `@types/better-sqlite3`: ^7.6.8 (TypeScript-Typen)

*Hinweis: `sqlite3` wurde entfernt da `better-sqlite3` die bevorzugte Lösung für Electron ist (synchrone API, 2-10x schneller).*

**Geplante Architektur (Kommentar in db.ts):**
- SQLite3 soll im Main Process laufen (`src/main/db-sqlite.ts` - noch zu erstellen)
- Renderer kommuniziert via IPC mit Main Process für DB-Operationen

**Noch zu implementieren:**
- [ ] `src/main/db-sqlite.ts` - SQLite3-Wrapper für Main Process
- [ ] IPC-Bridges für DB-Operationen
- [ ] Migrations-Logik von Lovefield/IndexedDB zu SQLite3
- [ ] Backward-Compatibility während Migration
- [ ] Schema-Definition für SQLite3 (basierend auf Lovefield-Schema)
- [ ] Export/Import für bestehende Nutzer

**Betroffene Dateien:**
- `src/scripts/db.ts` - Aktuell Lovefield, muss auf SQLite3 umgestellt werden
- `src/scripts/models/*.ts` - Nutzen `db.*` für alle Queries
- `src/scripts/settings.ts` - Export/Import Funktionen

**Lovefield-Schema (zu migrieren):**

```
sources:
  - sid (INTEGER, PK)
  - url (STRING, unique index)
  - iconurl (STRING, nullable)
  - name (STRING)
  - openTarget (NUMBER)
  - defaultZoom (NUMBER)
  - lastFetched (DATE_TIME)
  - serviceRef (STRING, nullable)
  - fetchFrequency (NUMBER)
  - rules (OBJECT, nullable)
  - textDir (NUMBER)
  - hidden (BOOLEAN)

items:
  - _id (INTEGER, auto-increment PK)
  - source (INTEGER, FK to sources)
  - title (STRING)
  - link (STRING)
  - date (DATE_TIME, indexed DESC)
  - fetchedDate (DATE_TIME)
  - thumb (STRING, nullable)
  - content (STRING)
  - snippet (STRING)
  - creator (STRING, nullable)
  - hasRead (BOOLEAN)
  - starred (BOOLEAN)
  - hidden (BOOLEAN)
  - notify (BOOLEAN)
  - serviceRef (STRING, nullable, indexed)
```

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

## Fortschritt: SQLite3 Migration

**Status:** ✅ Migration abgeschlossen (Dez 2025)

- SQLite3-Infrastruktur mit `better-sqlite3` im Main-Prozess implementiert (`src/main/db-sqlite.ts`)
- IPC-Bridge für Renderer-Zugriff (`src/bridges/db.ts`)
- Migration von Lovefield/IndexedDB zu SQLite3 automatisiert (`migrateLovefieldToSQLite()` in `db.ts`)
- Migration prüft und setzt Flag `useLovefield: false` in `config.json`
- Datenbankgröße und Item-Zahlen nach Migration: z.B. 96 Quellen, 14.492 Items, 21.7 MB
- Migration läuft nur einmal, Backup empfohlen
- Nach Migration: App nutzt ausschließlich SQLite3

---

## ToDo: Entfernung der alten Datenbank-Komponenten

**Nach erfolgreicher Migration:**
- [ ] Entfernen von Lovefield-Dependency und allen zugehörigen Imports
- [ ] Entfernen von IndexedDB-Schema und Migrations-Code in `db.ts`
- [ ] Entfernen von NeDB-Migrations-Code
- [ ] Refactoring aller Datenbank-Operationen auf `window.db.*` (IPC/SQLite)
- [ ] Tests: Sicherstellen, dass alle Features mit SQLite3 funktionieren
- [ ] Dokumentation und Changelog aktualisieren
- [ ] Endgültiges Löschen alter Datenbankdateien (IndexedDB, NeDB)

**Hinweis:**
Die Entfernung sollte erst nach mehreren Releases und Backups erfolgen, um Datenverlust zu vermeiden. Vorher alle Nutzer auf SQLite3 migrieren!
