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
- `better-sqlite3`: ^12.4.6 (in package.json)
- `sqlite3`: ^5.1.7 (in package.json)
- `@types/better-sqlite3`: ^7.6.8 (TypeScript-Typen)

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

**Status:** Geplant

**Beschreibung:**
Für Seiten die Login benötigen (z.B. Paywalls, Member-Bereiche) sollen Cookies pro Feed/Source gespeichert und beim Laden automatisch wiederhergestellt werden.

**Anwendungsfälle:**
- Paywalled Nachrichtenseiten
- Member-Bereiche mit Login
- Seiten mit Session-basierter Authentifizierung

**Technische Überlegungen:**
- Cookies pro `RSSSource` in der Datenbank speichern
- Beim Laden der Webview die gespeicherten Cookies setzen
- Optional: UI zum manuellen Speichern/Löschen von Cookies pro Feed
- Electron `session.cookies` API nutzen

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
