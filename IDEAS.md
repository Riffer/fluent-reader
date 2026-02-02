# Feature Ideas

## ✅ Implementierte Features

### ContentView Visibility Management - Zentralisierung (30.12.2025)

**Problem (gelöst):**
Das Verstecken/Anzeigen des WebContentsView bei Overlay-Dialogen war über mehrere fragmentierte Mechanismen verteilt. Jeder Handler musste alle anderen States prüfen.

**Implementierte Lösung:**

Neues zentralisiertes Event-System in `src/scripts/overlay-visibility.ts`:

```typescript
// Overlay-Typen für Type-Safety
type OverlaySource = 
    | 'redux-settings'      // Settings, Log Menu, Context Menu (via Redux)
    | 'fluent-dropdown'     // Fluent UI dropdown menus
    | 'p2p-incoming'        // P2P incoming notification dialog
    | 'p2p-share'           // P2P share dialog

// Dispatcher-Funktion (von überall aufrufbar)
setOverlayVisible('p2p-incoming', true)   // Overlay öffnet
setOverlayVisible('p2p-incoming', false)  // Overlay schließt

// OverlayStateManager in Article-Komponente
// Trackt alle offenen Overlays in einer Map
// Entscheidet automatisch: hide wenn irgendein Overlay offen, restore wenn alle zu
```

**Aufgeräumte Dateien:**
- ❌ `p2p-echo-dialog.tsx` - Gelöscht (unbenutzt)
- ❌ `p2p-echo-dialog-lan.tsx` - Gelöscht (unbenutzt)
- ❌ `p2p-share-dialog.tsx` - Gelöscht (non-LAN Version, unbenutzt)

**Vorteile:**
1. ✅ Single Source of Truth: `OverlayStateManager` trackt alle Overlay-Zustände
2. ✅ Keine Cross-Checks mehr: Kein `if (overlayActive || fluentMenuOpen || localDialogOpen...)` 
3. ✅ Einfache Erweiterung: Neuer Dialog = nur `setOverlayVisible('new-dialog', true/false)`
4. ✅ Besseres Debugging: `overlayStateManager.getOpenOverlays()` zeigt alle offenen Overlays

**Branch:** `feature/centralized-overlay-visibility`

---

## 💡 Offene Ideen

### FullContent: Legacy-Pfad (loadFull) mit Pool-Pfad konsolidieren (01.02.2026)

**Problem:**
Für FullContent-Modus existieren zwei separate Implementierungen:

1. **Legacy-Pfad (loadFull in article.tsx)**: 
   - Läuft im Renderer-Prozess
   - Wird bei direkter Navigation aufgerufen (componentDidUpdate)
   - Verwendet `fetch()` und `window.articleExtractor.extractFromHtml()`

2. **Pool-Pfad (prefetchFullContent in content-view-pool.ts)**:
   - Läuft im Main-Prozess
   - Wird nur für Prefetch verwendet
   - Verwendet `net.request()` und eigene `extractFromHtml()`

**Konsequenzen:**
- Doppelter Code für dieselbe Funktionalität
- Übersetzung musste an beiden Stellen implementiert werden
- Inkonsistente Fehlerbehandlung
- Pool-Cache wird bei direkter Navigation nicht genutzt

**Vorgeschlagene Lösung:**
1. Neuer IPC-Handler `cvp-navigate-fullcontent` im Pool
2. Handler prüft ob Artikel schon geprefetcht ist (instant) oder lädt on-demand
3. `loadFull()` in article.tsx entfernen
4. FullContent-Navigation verwendet Pool wie Webpage/Local

**Branch:** `refactor/consolidate-fullcontent-paths`

---

### Arrow-Keys bei Artikelwechsel: Event-Blocking in ContentView (30.12.2025)

**Problem:**
Beim Umschalten zum nächsten Artikel via "Cursor Rechts" wird die Taste auch in dem Artikel ausgewertet und führt zum 'Rucken' bevor der nächste Artikel sichtbar wird.

**Ursache:**
1. User drückt "Pfeil rechts" 
2. `before-input-event` in ContentView feuert
3. Event wird an Renderer weitergeleitet (`content-view-input`)
4. **GLEICHZEITIG**: Webseite erhält das Event und scrollt horizontal
5. Renderer verarbeitet das Event und wechselt zum nächsten Artikel
6. → Der alte Artikel hat bereits gescrollt (sichtbarer "Ruck")

**Mögliche Lösungen:**

**Option A: Event blockieren + weiterleiten**
```typescript
wc.on("before-input-event", (event, input) => {
    const navigationKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']
    if (navigationKeys.includes(input.key)) {
        event.preventDefault()  // Blockiert Event in der Webseite
    }
    this.sendToRenderer("content-view-input", input)  // Trotzdem weiterleiten
})
```
**Problem:** YouTube, interaktive Seiten brauchen diese Tasten (Video vor/zurück, Slider etc.)

**Option B: Blockieren nur ohne Modifier**
```typescript
if (navigationKeys.includes(input.key) && !input.control && !input.alt && !input.shift) {
    event.preventDefault()
}
```
**Problem:** Manche Seiten brauchen auch plain Arrow keys.

**Option C: Input Mode berücksichtigen**
Der Renderer sendet ein Signal, ob "Input Mode" aktiv ist. Wenn ja → nicht blockieren.
**Problem:** Asynchron - der Main-Prozess müsste den Zustand kennen.

**Option D: Nur bei keyDown blockieren, keyUp durchlassen**
```typescript
if (input.type === 'keyDown' && navigationKeys.includes(input.key)) {
    event.preventDefault()
}
```

**Option E: Selektive Navigation-Keys**
Nur Links/Rechts für Artikelwechsel blockieren, Auf/Ab für Scrollen durchlassen:
```typescript
const articleNavKeys = ['ArrowLeft', 'ArrowRight']  // Nur Artikelwechsel
```

**Empfehlung: Option E + B kombiniert**
Blockiere nur `ArrowLeft`/`ArrowRight` (Artikelwechsel), und nur wenn keine Modifier gedrückt sind. `ArrowUp`/`ArrowDown` lassen für normales Scrollen durch.

**Risiko:** Seiten mit horizontalem Scroll (Bildergalerien) funktionieren nicht mehr mit Pfeiltasten.

**Mitigation:** Der `Input Mode` (für Login-Formulare etc.) könnte auch das Blockieren deaktivieren - aber das erfordert, dass der Main-Prozess den Zustand kennt (IPC von Renderer zu Main).

---

   - In `componentDidUpdate` in Article auf Redux-Änderungen reagieren und Event dispatchen
---

### Overlay-Menü Performance: Alternativen zum Screenshot-Workaround (27.12.2025)

**Problem:**
Das WebContentsView ist ein natives OS-Fenster, das über dem React-DOM liegt. Wenn Overlay-Menüs (Tools, Settings, Share-Dialog) geöffnet werden, muss das WebContentsView versteckt und durch einen Screenshot ersetzt werden. Bei langen/komplexen Artikeln dauert der Screenshot-Capture spürbar lange (Warten auf GPU Compositor).

**Aktuelle Implementierung:**
- `capturePage()` erfasst nur den sichtbaren Viewport (nicht das gesamte Dokument)
- JPEG-Encoding (Q70) für Performance (~70ms vs ~590ms bei PNG)
- Flaschenhals: Warten auf fertigen Frame vom Compositor

**Alternative 1: Pre-Caching**
- Screenshot im Idle-Moment erstellen (nach `did-finish-load`)
- Bei Menü-Öffnung gecachten Screenshot nutzen
- ⚠️ Problem: Bei gescrollten Seiten ist der Cache "falsch"

**Alternative 2: Zweites WebContentsView als Menü-Overlay**
```typescript
// Z-Order über addChildView index:
parentWindow.contentView.addChildView(articleView)    // index 0 (unten)
parentWindow.contentView.addChildView(menuView)       // index 1 (oben)

// Oder explizit:
parentWindow.contentView.addChildView(menuView, 1)    // index bestimmt Z-Order
```
**Vorteile:**
- ✅ Menü-View liegt **nativ über** dem Artikel-View
- ✅ Kein Screenshot nötig
- ✅ Volles HTML/CSS/React im Menü möglich (QR-Codes, Custom-Styling)
- ✅ Transparenter Hintergrund möglich (`backgroundColor: '#00000000'`)

**Herausforderungen:**
- ⚠️ Separater WebContents = separater Prozess/Kontext
- ⚠️ Kommunikation nur über IPC (kein direkter React-State-Zugriff)
- ⚠️ Menü müsste eigenes HTML laden (oder data: URL)
- ⚠️ Mehr Speicherverbrauch (zweiter Renderer-Prozess)
- ⚠️ Click-Through für transparente Bereiche muss konfiguriert werden

**Umsetzungsidee:**
- Menü-View lazy erstellen (erst bei erstem Aufruf)
- Wiederverwenden (nur show/hide statt create/destroy)
- IPC-Bridge für Befehle an Haupt-Renderer

**Alternative 3: Native Electron-Menüs (eingeschränkt)**
- `Menu.popup()` erscheint über WebContentsView ohne Screenshot
- ❌ Nicht optisch anpassbar (OS-natives Styling)
- ❌ Keine Bilder/QR-Codes, Custom-Widgets, Eingabefelder
- ✅ Könnte für einfache Aktionen (Tools-Schnellzugriff) genutzt werden

**Status:** 📋 Recherche abgeschlossen, Umsetzung offen

---

### Aktuelle Seiten-URL beim Teilen/Kopieren (26.12.2025)
**Beschreibung:** Wenn der User innerhalb einer Webseite navigiert (Links folgt), wird beim "Link kopieren" im Kontextmenü immer noch die ursprüngliche Feed-URL verwendet, nicht die aktuelle Seiten-URL nach Navigation.

**Problem:**
- User öffnet Artikel aus Feed (URL: `https://blog.example.com/post1`)
- User folgt Links innerhalb der Seite zu `https://other-site.com/interesting`
- User will diese URL teilen/kopieren
- Aktuell wird nur `https://blog.example.com/post1` kopiert

**Nutzen:**
- User navigiert oft von der ursprünglichen Seite weg
- Will dann in normalen Browser wechseln, weiß aber nicht mehr wie er dort hin kam
- Navigated-Link würde sehr helfen

**Technische Umsetzung:**
- `content-view-context-menu` Event um `pageURL` erweitern (aus `this.currentUrl`)
- Im ContentViewManager wird `currentUrl` bereits bei `did-navigate` und `did-navigate-in-page` aktualisiert
- Im Kontextmenü `pageURL` anzeigen wenn `linkURL` leer ist
- Alternativ: Beide URLs anbieten ("Link kopieren" vs "Aktuelle Seiten-URL kopieren")

**Betroffene Dateien:**
- `src/main/content-view-manager.ts` - `setupContextMenu()` um `pageURL: this.currentUrl` erweitern
- `src/bridges/content-view.ts` - Interface `ContentViewContextMenu` erweitern
- `src/components/article.tsx` - `onContextMenu` Handler anpassen
- `src/components/context-menu.tsx` - Neue Menüoption oder Fallback-Logik

**Status:** 📋 Geplant

---

### Auto-Refresh nach Aufwachen aus Suspend (16.12.2025)
**Beschreibung:** Wenn das Gerät aus dem Suspend/Sleep aufwacht, soll die App automatisch eine Aktualisierung aller Feeds durchführen.

**Technische Umsetzung:**
- Electron bietet `powerMonitor.on('resume', callback)` Event
- In `src/electron.ts` oder `src/main/window.ts` registrieren
- IPC-Message an Renderer senden, der dann `fetchItems()` auslöst
- Optional: Konfigurierbar in Settings (an/aus)

**Beispiel-Code:**
```typescript
import { powerMonitor } from 'electron'

powerMonitor.on('resume', () => {
    // Notify renderer to refresh feeds
    mainWindow?.webContents.send('power-resume')
})
```

**Status:** 📋 Geplant

---

## ✅ Datenbankarchitektur (Stand: 14.12.2025)

### Aktueller Zustand - SQLite-ONLY

Die App verwendet jetzt **nur noch SQLite** als Datenbank:

| Datenbank | Ort | Status | Nutzung |
|-----------|-----|--------|---------|
| **Lovefield (IndexedDB)** | Renderer | ❌ ENTFERNT | Nur noch für Migration alter Daten |
| **SQLite** | Main Process | ✅ AKTIV | Alle Operationen via `window.db.*` Bridge |

### Lösung (14.12.2025)
- Alle Models (`src/scripts/models/*.ts`) nutzen jetzt `window.db.*` (SQLite)
- Die Migration (`migrateLovefieldToSQLite`) läuft nur einmal beim ersten Start
- Alle CRUD-Operationen (Create, Read, Update, Delete) laufen über SQLite
- Lovefield wird nur noch für Migration alter Daten benötigt

### 🚨 REGEL FÜR NEUE FEATURES

1. **KEINE Änderungen an Lovefield-Code:**
   - `src/scripts/db.ts` (Lovefield Schema/Init)
   - `db.sourcesDB`, `db.itemsDB` Aufrufe in Models
   - Keine neuen Funktionen die Lovefield nutzen

2. **Neue Features nur über SQLite:**
   - `src/main/db-sqlite.ts` (Main Process)
   - `window.db.*` Bridge für Renderer-Zugriff
   - `src/bridges/db.ts` für Type-Definitionen

3. **P2P Shared Feeds - Korrekter Ansatz:**
   - Feeds/Artikel nur in SQLite speichern (Main Process) ✓
   - **NICHT** versuchen, in Lovefield zu synchronisieren
   - UI-Anzeige der P2P-Feeds kommt erst nach vollständiger SQLite-Migration

### Dateien die NUR SQLite nutzen sollten:
- `src/main/db-sqlite.ts` - SQLite Implementierung ✓
- `src/main/p2p-lan.ts` - P2P Features ✓
- `src/main/settings.ts` - Einstellungen (nutzt electron-store, kein DB)
- `src/bridges/db.ts` - Bridge zum Renderer ✓

### Dateien die jetzt SQLite nutzen (migriert 14.12.2025):
- `src/scripts/models/source.ts` - Source CRUD ✅
- `src/scripts/models/item.ts` - Item CRUD ✅
- `src/scripts/models/feed.ts` - Feed Display ✅
- `src/scripts/models/service.ts` - Cloud Services ✅

### Dateien die Lovefield nur für Migration behalten:
- `src/scripts/db.ts` - Lovefield Init + Migration ⚠️ **Nur für `migrateLovefieldToSQLite()`**

### Migration abgeschlossen (14.12.2025) ✅
- [x] Warnkommentar in `src/scripts/db.ts` hinzugefügt
- [x] Alle Lovefield-Aufrufe in Models durch `window.db.*` ersetzt
- [x] Alle CRUD-Operationen laufen über SQLite
- [x] Feed löschen funktioniert korrekt (CASCADE Delete)
- [ ] Lovefield-Code entfernen (später, für Migration alter Nutzer behalten)
- [ ] P2P-Feeds in UI anzeigen (nächster Schritt)

### Detaillierter Migrationsplan (14.12.2025)

**Branch:** `feature/sqlite-migration`

**Lovefield-Aufrufe die ersetzt werden müssen:**

#### Phase 1: source.ts (8 Aufrufe)
| Zeile | Funktion | Lovefield-Aufruf | SQLite-Ersatz |
|-------|----------|------------------|---------------|
| 81-91 | `checkItem()` | `db.itemsDB.select()...where()` | `window.db.items.exists(source, title, date)` |
| 216-221 | `unreadCount()` | `db.itemsDB.select().groupBy()` | `window.db.items.getUnreadCounts()` |
| 248-250 | `initSources()` | `db.sourcesDB.select()` | `window.db.sources.getAll()` |
| 307-313 | `insertSource()` | `db.sourcesDB.insert()` | `window.db.sources.insert()` |
| 375-379 | `updateSource()` | `db.sourcesDB.insertOrReplace()` | `window.db.sources.update()` |
| 399-407 | `deleteSource()` | `db.itemsDB.delete()` + `db.sourcesDB.delete()` | `window.db.sources.delete()` (CASCADE) |

#### Phase 2: item.ts (12 Aufrufe)
| Zeile | Funktion | Lovefield-Aufruf | SQLite-Ersatz |
|-------|----------|------------------|---------------|
| 204-209 | `insertItems()` | `db.itemsDB.insert()` | `window.db.items.insertBatch()` |
| 357-360 | `markRead()` | `db.itemsDB.update()` | `window.db.items.update()` |
| 389-401 | `markAllRead()` | `db.itemsDB.update().where()` | `window.db.items.markAllRead()` |
| 424-427 | `markUnread()` | `db.itemsDB.update()` | `window.db.items.update()` |
| 445-448 | `toggleStarred()` | `db.itemsDB.update()` | `window.db.items.update()` |
| 459-462 | `toggleHidden()` | `db.itemsDB.update()` | `window.db.items.update()` |

#### Phase 3: feed.ts (4 Aufrufe)
| Zeile | Funktion | Lovefield-Aufruf | SQLite-Ersatz |
|-------|----------|------------------|---------------|
| 54-70 | `loadMore()` predicates | `db.items.hasRead/starred/hidden/title/snippet` | `window.db.items.query()` mit Optionen |
| 123-128 | `loadMore()` query | `db.itemsDB.select().from().where().orderBy()` | `window.db.items.query()` |

#### Phase 4: service.ts (3 Aufrufe)
| Zeile | Funktion | Lovefield-Aufruf | SQLite-Ersatz |
|-------|----------|------------------|---------------|
| 126-129 | `syncWithService()` | `db.sourcesDB.select().where()` | `window.db.sources.getByUrl()` |
| 147+ | `syncWithService()` | `db.itemsDB...` | `window.db.items...` |

**Neue Bridge-Funktionen benötigt:**

```typescript
// In src/bridges/db.ts hinzufügen:
items: {
    // NEU: Duplikatprüfung für RSS-Items
    exists: (source: number, title: string, date: string): Promise<boolean>
    
    // NEU: Unread-Counts gruppiert nach Source
    getUnreadCounts: (): Promise<{source: number, count: number}[]>
    
    // NEU: Batch-Insert für mehrere Items
    insertBatch: (items: ItemRow[]): Promise<ItemRow[]>
    
    // NEU: Mark All Read mit komplexen Filtern
    markAllRead: (sids: number[], date?: string, before?: boolean): Promise<void>
    
    // NEU: Komplexe Query für Feed-Anzeige
    query: (options: ItemQueryOptions): Promise<ItemRow[]>
}
```

**Migrationsreihenfolge:**
1. ✅ Bridge-Funktionen in `db-sqlite.ts` implementieren
2. ✅ IPC-Handler in `window.ts` registrieren
3. ✅ Bridge-Typen in `bridges/db.ts` erweitern
4. ✅ `source.ts` migrieren (kritisch für initSources)
5. ✅ `item.ts` migrieren (kritisch für fetchItems)
6. ✅ `feed.ts` migrieren (kritisch für UI)
7. ✅ `service.ts` migrieren (Cloud-Services)
8. ⬜ Lovefield-Code entfernen (optional, für Migration alter Nutzer behalten)

---

## Bugs (bekannte Probleme)


### ~~🐛 Dual-Database Sync Problem~~ ✅ Gelöst

**Status:** ✅ Gelöst (14.12.2025)

**Problem (behoben):**
Die App verwendete zwei Datenbanken parallel, was zu Inkonsistenzen führte.

**Lösung:**
Alle Model-Dateien (`source.ts`, `item.ts`, `feed.ts`, `service.ts`) wurden auf SQLite migriert.
Die App nutzt jetzt ausschließlich `window.db.*` für alle CRUD-Operationen.

**Verifiziert:**
- Feed löschen über UI → Feed und Artikel werden in SQLite gelöscht ✅
- Neue Feeds hinzufügen → Werden in SQLite gespeichert ✅
- CASCADE Delete funktioniert (Artikel werden mit Feed gelöscht) ✅

---


## P2P LAN Artikel-Sharing

**Status:** ✅ Implementiert (v1.1.9, Dezember 2025)

**Beschreibung:**
Ermöglicht das Teilen von Artikellinks zwischen Fluent Reader Instanzen im lokalen Netzwerk via UDP-Discovery und TCP-Verbindung.

**Implementierte Features:**
- ✅ Room-basierte Peer-Discovery via UDP Broadcast (Port 41899)
- ✅ TCP-Verbindung für zuverlässige Nachrichtenübermittlung (Port 41900-41999)
- ✅ Automatisches Rejoin beim App-Start (Room wird persistent gespeichert)
- ✅ Dark Mode Support für alle Dialoge
- ✅ "Later" Button zum Sammeln von Links in der Notification Bell
- ✅ "Open in Reader" Button für internes Browser-Fenster
- ✅ Option: Links direkt in Notification Bell sammeln statt Dialog zeigen

### Bekannte Einschränkungen und offene Punkte

**Status:** Aus Produktivtest (Dezember 2025)

#### ~~1. Schlafende/Zugeklappte Peers werden nicht erkannt~~ ✅ Erledigt

**Status:** ✅ Implementiert (v1.1.9)

- Heartbeat alle 10 Sekunden
- Peer wird nach 30 Sekunden ohne Antwort als offline markiert
- Offline-Queue speichert Links für nicht erreichbare Peers
- Bei Reconnect werden gequeuete Links automatisch übermittelt

#### 2. Feed-Information beim Teilen mitgeben

**Status:** 🔶 Teilweise implementiert (v1.1.10) - Feed-Info wird übertragen, UI fehlt noch

**Problem:**
Aktuell wird nur der Artikel-Link und Titel übermittelt, nicht aber der zugehörige Feed.

**Anforderung:**
- ✅ Feed-URL, Feed-Name und Feed-Icon werden mit übertragen
- [ ] Empfänger soll die Möglichkeit haben, den Feed als neuen Feed anzulegen
- [ ] Dialog beim Empfänger: "Artikel von [Feed-Name] empfangen. Feed abonnieren?"
- [ ] Prüfung ob Feed bereits abonniert ist

**Umsetzung:**
- [x] `ShareMessage` erweitern um `feedUrl`, `feedName`, `feedIconUrl`
- [ ] UI beim Empfänger für Feed-Subscription-Option
- [ ] Prüfung ob Feed bereits abonniert ist

#### ~~3. Offline-Queue für nicht erreichbare Peers~~

**Status:** ✅ Implementiert (v1.1.10)

**Problem:**
Wenn der Peer nicht verfügbar ist, geht der geteilte Link verloren.

**Anforderung:**
- Geteilte Links sollen lokal in einer Queue gespeichert werden
- Bei erneuter Verfügbarkeit des Peers automatisch übermitteln
- Queue sollte persistent sein (überleben App-Neustart)

**Umsetzung:**
- [x] `pendingShares` Queue in SQLite oder JSON speichern → SQLite-Tabelle `p2p_pending_shares`
- [x] Bei Peer-Reconnect Queue abarbeiten → `processPendingSharesForPeer()` bei Peer-Statuswechsel auf online
- [x] UI: "X Links warten auf Übermittlung an [Peer]" → Pending-Count wird angezeigt
- [x] Timeout/Verfallsdatum für Queue-Einträge? → Noch nicht implementiert (optional für später)

#### 4. Geteilte Artikel als künstlicher Feed

**Problem:**
Geteilte Artikel sind nach App-Neustart nicht mehr verfügbar (nur in der Notification Bell während der Session).

**Anforderung (zu diskutieren):**
- Geteilte Artikel könnten in einen eigenen "künstlichen" Feed aufgenommen werden
- Ermöglicht späteres Lesen auch nach Neustarts
- Dieselben Methoden wie für normale Feeds verwendbar (Markieren, Favoriten, etc.)

**Vorteile:**
- Konsistente UX mit normalen Artikeln
- Persistenz über Sessions hinweg
- Alle Feed-Funktionen nutzbar (Read/Unread, Star, etc.)

**Nachteile/Offene Fragen:**
- Wie wird der "P2P Shared" Feed erstellt/verwaltet?
- Soll es einen Feed pro Peer geben oder einen gemeinsamen?
- Wie werden Duplikate behandelt (gleicher Artikel von mehreren Peers)?
- Soll der Feed automatisch erstellt werden oder manuell aktivierbar?

**Mögliche Umsetzung:**
- [ ] Spezieller Feed-Typ `type: "p2p-shared"` oder `virtual: true`
- [ ] Automatische Erstellung beim ersten empfangenen Artikel
- [ ] Gruppierung: Ein Feed "P2P Geteilt" oder pro Peer "Von [Name]"
- [ ] Items werden in SQLite gespeichert wie normale Artikel

#### ~~5. Artikel-Modus beim Teilen mitgeben~~ ✅ Erledigt

**Status:** ✅ Implementiert (v1.1.10)

**Implementiert:**
- ✅ `openTarget` (Anzeigemodus: Lokal/Extern) wird mit übertragen
- ✅ `defaultZoom` (Zoom-Level) wird mit übertragen
- ✅ Werte werden beim Erstellen neuer P2P-Feeds verwendet

**Verhalten:**
- Neuer P2P-Feed erhält die Anzeigeeinstellungen vom Sender
- Bestehende Feeds behalten ihre eigenen Einstellungen

#### 6. System-Events nutzen (Sleep/Resume)

**Problem:**
Wenn das System in Sleep/Hibernate geht, erfahren die Peers davon erst durch den 30s Heartbeat-Timeout. Beim Aufwachen dauert es bis zu 10s bis der nächste Heartbeat gesendet wird.

**Anforderung:**
- Bei `suspend`: Goodbye an Peers senden (sofortige Offline-Erkennung)
- Bei `resume`: Sofort wieder aktiv werden (Discovery, Heartbeat, Pending Shares)
- **Bonus**: Beim Aufwachen auch Feed-Aktualisierung triggern (je nach Einstellung)

**Umsetzung:**
- [ ] `powerMonitor.on("suspend")` → `shutdownP2P()` aufrufen (Goodbye senden)
- [ ] `powerMonitor.on("resume")` → Sofort UDP-Discovery und Heartbeat senden
- [ ] `powerMonitor.on("resume")` → Pending Shares für wieder erreichbare Peers verarbeiten
- [ ] Optional: Feed-Refresh bei Resume (wenn Auto-Refresh aktiviert ist)
- [ ] Beachten: Bei `suspend` ist die Zeit sehr knapp (wenige ms)

**Electron API:**
```typescript
import { powerMonitor } from "electron"
powerMonitor.on("suspend", () => { /* System geht schlafen */ })
powerMonitor.on("resume", () => { /* System ist aufgewacht */ })
```

#### 7. P2P-Teilen im Artikel-Kontextmenü

**Status:** ✅ Implementiert (14.12.2025)

**Implementiert:**
- ✅ P2P-Peers werden im "Teilen"-Untermenü des Artikel-Kontextmenüs angezeigt
- ✅ Schnelles Teilen ohne Artikel öffnen zu müssen
- ✅ Peers werden nur angezeigt wenn P2P verbunden und Peers verfügbar
- ✅ QR-Code zum Teilen wird im gleichen Menü angezeigt

**Technische Umsetzung:**
- `context-menu.tsx`: `getShareSubmenuItems()` Methode für P2P-Peers
- IPC-Kommunikation via `window.p2p.getPeers()` und `window.p2p.shareToPeer()`
- State-Management für P2P-Verbindungsstatus im Kontextmenü

#### 8. Feed abonnieren aus P2P-Artikel

**Status:** ✅ Implementiert (14.12.2025)

**Implementiert:**
- ✅ "Feed abonnieren" Option im Feed-Listen-Kontextmenü (Rechtsklick auf P2P-Feed in Sidebar)
- ✅ Konvertiert P2P-Feed zu aktivem Feed (entfernt `serviceRef: "p2p-shared"`)
- ✅ Feed wird automatisch aus P2P-Gruppe entfernt
- ✅ Artikel werden sofort aktualisiert nach dem Abonnieren (`fetchItems`)
- ✅ Übersetzungen für DE und EN-US

**Technische Umsetzung:**
- `context-menu.tsx`: `handleSubscribeFeedFromGroup()` Handler für Feed-Listen-Kontextmenü
- `context-menu.tsx`: `convertP2PFeedToActive()` für die gemeinsame Konvertierungslogik
- `context-menu-container.tsx`: `sources` und `groups` werden an `ContextMenuType.Group` weitergegeben
- `bridges/db.ts`: `window.db.p2pFeeds.convertToActive(sid)` Bridge-Funktion
- SQLite: `UPDATE sources SET serviceRef = NULL WHERE sid = ?`

**Design-Entscheidungen:**
- **Option C gewählt:** Flag und Gruppe getrennt halten
  - Das `serviceRef`-Flag ist die **einzige Wahrheit** über den P2P-Status
  - Die Gruppenzugehörigkeit ist nur organisatorisch
  - Manuelles Verschieben aus der Gruppe ändert das Flag NICHT
- Menüpunkt nur für einzelne P2P-Feeds sichtbar (nicht für Gruppen)
- Nach Konvertierung: Feed bleibt wo er ist, neue Artikel kommen vom Original-Feed

**Bekanntes Verhalten:**
- React async pattern: Props werden am Funktionsanfang kopiert um Stale-Props nach await zu vermeiden

---

## Upstream-Contribution Strategie

**Status:** Geplant

**Ziel:**
Ausgewählte Änderungen aus diesem Fork als Pull Requests an das Original-Repository (yang991178/fluent-reader) zurückgeben.

### Empfohlene PR-Strategie

**Phase 1: Kleine, isolierte Bug Fixes (hohe Akzeptanzchance)**

| Feature | Commit | Aufwand | Priorität |
|---------|--------|---------|-----------|
| Fix: parseRSS Error Handling | `8afd1b5` | Gering | ⭐⭐⭐ Hoch |
| OPML mobileMode Export/Import | `093cd85` | Gering | ⭐⭐⭐ Hoch |
| Comic Mode: Duplicate Images Fix | `35ea74c` | Gering | ⭐⭐ Mittel |

**Phase 2: Feature PRs (erst als Issue/Discussion vorstellen)**

| Feature | Commits | Aufwand | Voraussetzung |
|---------|---------|---------|---------------|
| Mobile Mode (Device Emulation) | mehrere | Mittel | Lokalisierung, englische Kommentare |
| Input Mode (Ctrl+I) | Teil von Cookies | Mittel | Kann separat extrahiert werden |
| Zoom/Scroll Verbesserungen | `a55c6d5` | Gering | Review nötig |

**Phase 3: Größere/Kontroverse Features (Fork-only oder später)**

| Feature | Grund für Verzögerung |
|---------|----------------------|
| SQLite3 Migration | Breaking Change, Lovefield noch aktiv upstream |
| Persistent Cookies | Security-Review nötig, Privacy-Bedenken |
| NSFW-Cleanup | Kontrovers, Reddit-spezifisch |
| Auto Cookie-Consent | Rechtlich fraglich in manchen Ländern |

### Voraussetzungen für Upstream-PRs

- [ ] Deutsche Kommentare auf Englisch umstellen
- [ ] Hardcodierte deutsche Texte lokalisieren (alle 18 Sprachen)
- [ ] Tests hinzufügen falls vorhanden
- [ ] CHANGELOG aktualisieren
- [ ] Code-Style an Upstream anpassen

### Git-Workflow für PRs

```bash
# Einzelnen Commit für PR extrahieren
git checkout upstream/master
git checkout -b pr/fix-parserss-error
git cherry-pick 8afd1b5
git push origin pr/fix-parserss-error
# Dann PR auf GitHub erstellen
```

---

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

## SQLite Migration robuster gestalten

**Status:** Idee

**Problem:**
Die aktuelle Migration stützt sich ausschließlich auf das `useLovefield` Flag in der Config. Das kann zu Problemen führen wenn:
- Das Flag manuell geändert wurde
- Die Config beschädigt/gelöscht wurde
- Ein Nutzer die App auf einem neuen Rechner startet aber die SQLite-DB bereits kopiert hat

**Anforderung:**
Zusätzlich zur Flag-Prüfung sollte auch geprüft werden, ob die SQLite-Datenbank bereits Daten enthält.

**Mögliche Umsetzung:**
```typescript
// Vor Migration prüfen:
// 1. useLovefield Flag in Config
// 2. SQLite-DB existiert UND hat Daten (sources.count > 0)

function shouldMigrate(): boolean {
    const useLovefield = settings.getUseLovefield()
    
    // Wenn Flag false, nutze SQLite (keine Migration nötig)
    if (!useLovefield) return false
    
    // Wenn SQLite-DB bereits Daten hat, überspringe Migration
    const sqliteHasData = db.getSourceCount() > 0
    if (sqliteHasData) {
        console.log("[Migration] SQLite already has data, skipping migration")
        settings.setUseLovefield(false)
        return false
    }
    
    // Flag ist true und SQLite ist leer → Migration durchführen
    return true
}
```

**Vorteile:**
- Robuster gegen Config-Probleme
- Verhindert versehentliche Doppel-Migration
- Unterstützt Szenarien wie DB-Kopie zwischen Rechnern

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
3. Cookies in WebContentsview-Session setzen via Electron API
4. Falls `persistCookies: false` → Keine Cookies laden, Session bleibt temporär

**Ablauf - Cookie speichern (mehrere Trigger):**

| Event | Beschreibung | Priorität |
|-------|--------------|-----------|
| `componentDidUpdate` | Artikelwechsel - alter Artikel wird verlassen | ✅ Kritisch |
| `componentWillUnmount` | Webcontentsview wird zerstört | ✅ Kritisch |
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
  // Komponente wird zerstört → Cookies speichern
  this.saveCookiesForCurrentHost();
}

// Nach Seitenload (für Login-Flows)
webcontentsview.addEventListener('did-finish-load', () => {
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

## Shortcut-Deaktivierung bei Browser-Eingabefeldern

**Status:** ✅ Implementiert (v1.1.7) - als "Input-Modus"

**Beschreibung:**
Wenn der Benutzer im Browser-Modus in ein Login-Formular oder anderes Eingabefeld tippt, werden die Shortcuts (z.B. `L`, `M`, `S`, `+`, `-`) fälschlicherweise als Befehle interpretiert statt als Texteingabe.

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
Ein Greasemonkey/Tampermonkey-ähnliches System zur automatischen Ausführung von JavaScript auf Webseiten im WebContentsView. Hauptanwendungsfall: Automatisches Wegklicken von Cookie-Consent-Bannern, aber auch andere Automatisierungen möglich.

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

3. **Skript-Injection via ontentsview-preload.js:**
```javascript
// In ontentsview-preload.js
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
- Skripte laufen im WebContentsview-Context (sandboxed)
- Kein Zugriff auf Electron/Node APIs aus Userscripts
- Warnung beim Import von externen Skripten
- Optional: Skript-Signierung für vertrauenswürdige Quellen

**Betroffene Dateien:**
- `src/renderer/webcontents-preload.js` - Skript-Injection
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

### Migrations-Bewertung: Existierende Site-Anpassungen → Userscripts

Die folgenden Features in `src/renderer/content-preload.js` sind Kandidaten für eine spätere Migration ins Userscript-System:

#### 1. NSFW-Cleanup (Reddit)

| Aspekt | Aktueller Stand | Userscript-Kompatibilität |
|--------|-----------------|---------------------------|
| **DOM-Manipulation** | Reines JS: `querySelector`, `remove()`, Style-Änderungen | ✅ 100% kompatibel |
| **Shadow DOM** | `element.shadowRoot.querySelector()` | ✅ Standard Web API |
| **Domain-Check** | `/reddit\.com/.test(url)` | ✅ `@match *://*.reddit.com/*` |
| **Observer** | `MutationObserver` für dynamische Elemente | ✅ Standard Web API |
| **Timing** | `document-idle` + Observer | ✅ `@run-at document-idle` |

**Besonderheiten:**
- Shadow DOM-Manipulation (Reddit Web Components)
- MutationObserver mit automatischem Disconnect nach Cleanup
- Debouncing zur Performance-Optimierung

**Anpassungsbedarf:**
- `ipcRenderer.sendSync('get-nsfw-cleanup')` → `GM_getValue('nsfwCleanup', true)`
- `showOverlayMessage()` → Optional entfernen oder `GM_notification()`

**Als Userscript (~30 Zeilen Kern-Code):**
```javascript
// ==UserScript==
// @name         Reddit NSFW Cleanup
// @match        *://*.reddit.com/*
// @run-at       document-idle
// ==/UserScript==
function cleanup() {
  document.querySelectorAll('xpromo-nsfw-blocking-container').forEach(c => {
    if (c.shadowRoot) c.shadowRoot.querySelector('.prompt')?.style.display = 'none';
  });
  document.querySelectorAll('shreddit-blurred-container').forEach(el => {
    el.removeAttribute('blurred');
    if (el.shadowRoot) {
      el.shadowRoot.querySelector('.overlay')?.style.display = 'none';
      el.shadowRoot.querySelectorAll('.blurred').forEach(b => b.style.filter = 'none');
    }
  });
}
cleanup();
new MutationObserver(cleanup).observe(document.body, {childList:true, subtree:true});
```

**Migrations-Aufwand:** ⭐⭐ Gering (15-20 Min)

---

#### 2. Auto Cookie-Consent (Reddit)

| Aspekt | Aktueller Stand | Userscript-Kompatibilität |
|--------|-----------------|---------------------------|
| **DOM-Manipulation** | `querySelector`, `click()`, `remove()` | ✅ 100% kompatibel |
| **Domain-Check** | Pattern-Array mit RegExp | ✅ `@match` Patterns |
| **Button-Klick** | `rejectButton.click()` | ✅ Standard Web API |
| **Timing** | `document-idle` + Observer | ✅ `@run-at document-idle` |

**Struktur bereits modular:**
```javascript
const cookieConsentPatterns = [
  { patterns: [/reddit\.com/], consent: () => { /* ... */ } },
  // Weitere Sites können einfach hinzugefügt werden
];
```

**Anpassungsbedarf:**
- `ipcRenderer.sendSync('get-auto-cookie-consent')` → `GM_getValue()`
- Pattern-Array → Separate Userscripts pro Domain (oder Multi-Match)

**Als Userscript (~20 Zeilen):**
```javascript
// ==UserScript==
// @name         Reddit Cookie Auto-Reject
// @match        *://*.reddit.com/*
// @run-at       document-idle
// ==/UserScript==
function rejectCookies() {
  const dialog = document.querySelector('#data-protection-consent-dialog');
  const reject = dialog?.querySelector('[data-testid="reject-nonessential-cookies-button"]');
  if (reject) { reject.click(); return true; }
  document.querySelectorAll('shreddit-cookie-banner').forEach(el => el.remove());
}
rejectCookies();
new MutationObserver(rejectCookies).observe(document.body, {childList:true, subtree:true});
```

**Migrations-Aufwand:** ⭐ Sehr gering (10 Min)

---

#### 3. Reddit Gallery/Image Expand (NEU, Januar 2026)

| Aspekt | Aktueller Stand | Userscript-Kompatibilität |
|--------|-----------------|---------------------------|
| **DOM-Manipulation** | `querySelector`, `click()` | ✅ 100% kompatibel |
| **Domain-Check** | `/reddit\.com/.test(url)` | ✅ `@match *://*.reddit.com/*` |
| **Timing** | Nach View-Aktivierung | ⚠️ Siehe unten |

**Besonderheit:** Content-View-Pool Integration
- Aktuelle Implementierung reagiert auf `cvp-set-active-state` IPC
- Userscript müsste alternatives Timing nutzen: `IntersectionObserver` oder `visibilitychange`

**Als Userscript (~15 Zeilen):**
```javascript
// ==UserScript==
// @name         Reddit Gallery Auto-Expand
// @match        *://*.reddit.com/*
// @run-at       document-idle
// ==/UserScript==
setTimeout(() => {
  // Gallery (multiple images)
  document.querySelectorAll('gallery-carousel').forEach(c => 
    (c.querySelector('img.media-lightbox-img') || c).click()
  );
  // Single image
  document.querySelectorAll('shreddit-media-lightbox-listener').forEach(l => {
    if (!l.closest('gallery-carousel')) (l.querySelector('img') || l).click();
  });
}, 2000);
```

**Migrations-Aufwand:** ⭐ Sehr gering (10 Min)

---

#### Zusammenfassung: Migrations-Readiness

| Feature | Kern-Code portierbar | Fluent-Reader-spezifisch | Aufwand |
|---------|---------------------|--------------------------|---------|
| NSFW-Cleanup | ✅ 95% | IPC, Overlay-Message | ⭐⭐ |
| Cookie-Consent | ✅ 98% | IPC | ⭐ |
| Gallery Expand | ✅ 90% | IPC, Active-State | ⭐ |

**Empfehlung für zukünftige Site-Anpassungen:**
```javascript
// 1. Reiner DOM-Logik Block (portierbar)
function siteSpecificAction() {
  // Nur querySelector, click, DOM-Manipulation
}

// 2. Fluent-Reader Integration (wird später zum Userscript-Runner)
if (settingEnabled && matchesPattern(url)) {
  onViewActive(() => siteSpecificAction());
}
```

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

---

## Bekannte Electron/Chromium-Meldungen (harmlos)

**Status:** Dokumentiert (Dezember 2025)

**Beschreibung:**
Beim Start der App erscheinen im Terminal einige Fehlermeldungen von Electron/Chromium. Diese sind **harmlos** und beeinträchtigen die Funktionalität nicht.

**Bekannte Meldungen:**

| Meldung | Ursache | Status |
|---------|---------|--------|
| `Failed to delete file ...Cookies: Das Verzeichnis ist nicht leer` | Chromium versucht beim Start alte Session-Daten zu migrieren. Das interne `Cookies`-Verzeichnis kann nicht gelöscht werden, wenn noch Handles offen sind. | ⚠️ Harmlos |
| `Encountered error while migrating network context data` | Zusammenhängend mit dem Cookies-Problem - Chromium's Netzwerk-Sandbox kann nicht alle Daten migrieren. | ⚠️ Harmlos |
| `Request Autofill.enable failed` | DevTools versucht Autofill-CDP-Befehle zu nutzen, die in Electron nicht unterstützt werden. Erscheint nur bei geöffneten DevTools. | ⚠️ Harmlos |
| `Request Autofill.setAddresses failed` | Wie oben - CDP (Chrome DevTools Protocol) Befehl nicht verfügbar in Electron. | ⚠️ Harmlos |

**Wichtig:** 
- Das Chromium-interne `Cookies`-Verzeichnis (`%APPDATA%/Electron/Cookies`) ist **nicht** identisch mit unserem Cookie-Persistenz-Verzeichnis (`%APPDATA%/Electron/cookies/`).
- Unsere Cookie-Persistenz-Dateien (JSON pro Host) sind davon nicht betroffen.
- Diese Meldungen kommen direkt aus dem Chromium-Netzwerk-Stack und können nicht durch unseren Code behoben werden.

**Workaround:**
Keine Aktion erforderlich. Die Meldungen können ignoriert werden.


---

## UI/UX Verbesserungen

**Status:** Idee

### Keyboard-Shortcuts in der UI sichtbar machen

**Problem:**
Aktuell sind Keyboard-Shortcuts (W, M, R, +, -, 0, Pfeiltasten, etc.) nicht in der Oberflaeche sichtbar. Neue Nutzer muessen die Dokumentation lesen oder sie zufaellig entdecken.

**Loesung:**
- Jede Keyboard-Taste sollte einen **Menuepunkt mit entsprechender Beschriftung** haben
- Buttons/Schaltflaechen sollten **Tooltips mit dem Shortcut** anzeigen (z.B. Webseite laden (W))
- Beispiel: Zoom: 100% (M) zeigt bereits den Mobile-Mode-Indikator - aehnlich fuer andere Funktionen

### Feed-spezifische Settings in der Feedverwaltung

**Problem:**
Permanente Feed-spezifische Settings (wie Zoom, Mobile Mode, Cookie-Persistenz) sind nur ueber das Tools-Menue im Artikel-View erreichbar, nicht aber in der zentralen Feedverwaltung.

**Loesung:**
- Alle permanenten Feed-spezifischen Settings (Zoom, Mobile Mode, Cookie-Persistenz, Text-Richtung, etc.) sollen auch in der **Feedverwaltung** (Einstellungen - Quellen) sichtbar und einstellbar sein
- Ermoeglicht zentrale Konfiguration aller Feeds ohne jeden einzeln oeffnen zu muessen
- Uebersicht ueber alle Feed-Einstellungen an einem Ort

### Globale Settings in der Konfiguration

**Problem:**
Permanente Funktionen, die unabhaengig vom Feed sind, sind teilweise nur ueber Menues erreichbar, nicht in den App-Einstellungen.

**Loesung:**
- Alle globalen/permanenten Funktionen sollen **zusaetzlich zum Menue** auch in den **App-Einstellungen** direkt konfigurierbar sein
- Zentrale Anlaufstelle fuer alle Konfigurationsoptionen
- Konsistente Benutzererfahrung

---

## Code-Qualitaet und Internationalisierung

**Status:** Idee / TODO

### Deutsche Kommentare auf Englisch umstellen

**Problem:**
Im Quellcode befinden sich einige Kommentare auf Deutsch, was fuer internationale Programmierer schwer verstaendlich ist.

**Loesung:**
- Alle deutschen Kommentare im Quellcode sollen auf **Englisch** umgestellt werden
- Einheitliche Sprache im gesamten Codebase fuer bessere internationale Zusammenarbeit
- Betrifft: article.tsx, window.ts, utils.ts, webcontentsview-preload.js und weitere Dateien

### Lokalisierung neuer Funktionen

**Problem:**
Neu hinzugefuegte Funktionen und Schaltflaechen haben teilweise nur englische oder deutsche Texte, aber keine Uebersetzungen fuer alle unterstuetzten Sprachen.

**Loesung:**
- Alle neu hinzugefuegten UI-Texte muessen in **allen verfuegbaren Sprachen** angelegt werden
- Verfuegbare Sprachen: en-US, de, cs, es, fr-FR, fi-FI, it, ja, ko, nl, pt-BR, pt-PT, ru, sv, tr, uk, zh-CN, zh-TW (18 Sprachen)
- Neue Strings fuer: Mobile Mode Toggle, Cookie-Persistenz, Zoom-Overlay, etc.
- Lokalisierungsdateien: src/scripts/i18n/*.json

**Hardcodierte Texte in `article.tsx` (zu lokalisieren):**

| Zeile | Aktueller Text (DE) | Vorgeschlagener i18n-Key |
|-------|---------------------|--------------------------|
| 509 | `"Tools"` | `article.tools` |
| 515 | `"Quelltext kopieren"` | `article.copySource` |
| 539 | `"Berechneter Quelltext kopieren"` | `article.copyComputedSource` |
| 586 | `"Zoom-Anzeige"` | `article.zoomOverlay` |
| 594 | `"Mobile Ansicht"` | `article.mobileView` |
| 603 | `"NSFW-Cleanup (experimentell)"` | `article.nsfwCleanup` |
| 611 | `"Auto Cookie-Consent"` | `article.autoCookieConsent` |
| 619 | `"Cookies speichern (Login)"` | `article.persistCookies` |
| 631 | `"Eingabe-Modus beenden (Ctrl+I)"` | `article.inputModeEnd` |
| 632 | `"Eingabe-Modus (Ctrl+I)"` | `article.inputMode` |
| 648 | `"App Developer Tools"` | `article.appDevTools` |
| 658 | `"Artikel Developer Tools"` | `article.articleDevTools` |
| 1885 | `"Eingabe-Modus aktiv..."` (title) | `article.inputModeTooltip` |
| 1887 | `"⌨ EINGABE"` | `article.inputModeBadge` |
| 1929 | `"(wird geladen...)"` | `article.loading` |
| 1931 | `"✓ (geladen)"` | `article.loaded` |

**Hinweis:** Diese Texte sind aktuell auf Deutsch hardcodiert. Für eine vollständige Lokalisierung müssen sie:
1. In `en-US.json` als englische Basis angelegt werden
2. In alle 17 anderen Sprachdateien übersetzt werden
3. Im Code durch `intl.get("key")` ersetzt werden

**Mögliche Quellen für Übersetzungen:**
- DeepL API (kostenlos bis 500k Zeichen/Monat)
- Upstream-Repository synchronisieren (`git fetch upstream`)
- Community-Beiträge (siehe README in src/scripts/i18n/)