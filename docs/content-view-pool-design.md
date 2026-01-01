# Content View Pool - Design Document

## Übersicht

Dieses Dokument beschreibt die Architektur für einen WebContentsView-Pool mit Prefetching,
um die Artikelwechsel-Performance zu verbessern.

## Motivation

**Problem:** Beim Artikelwechsel entstehen Wartezeiten durch:
- WebContentsView Neuerstellung (`recreateContentView()`)
- Navigation und HTML-Parsing
- Device Emulation Setup
- Layout-Berechnung

**Lösung:** Pool von 3 vorbereiteten Views mit Prefetching der nächsten Artikel.

## Architektur

```
┌────────────────────────────────────────────────────────────────┐
│                      ContentViewPool                            │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  activeViewId: string | null                                    │
│  viewsByWebContentsId: Map<number, CachedContentView>           │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  │ CachedContentView│  │ CachedContentView│  │ CachedContentView│
│  │   id: "view-0"   │  │   id: "view-1"   │  │   id: "view-2"   │
│  │   articleId      │  │   articleId      │  │   articleId      │
│  │   feedId         │  │   feedId         │  │   feedId         │
│  │   status         │  │   status         │  │   status         │
│  │   isActive       │  │   isActive       │  │   isActive       │
│  │   webContents    │  │   webContents    │  │   webContents    │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

## Klassen

### CachedContentView

Kapselt einen WebContentsView mit artikelspezifischem State.

```typescript
class CachedContentView {
    // === Identifikation ===
    readonly id: string              // "view-0", "view-1", "view-2"
    private _view: WebContentsView | null
    
    // === Artikel-Kontext ===
    articleId: string | null         // RSSItem._id aus DB
    feedId: string | null            // Für Feed-spezifische Einstellungen
    url: string | null               // Geladene URL (data: oder https:)
    
    // === Status ===
    status: 'empty' | 'loading' | 'ready' | 'error'
    loadError: Error | null
    
    // === Einstellungen beim Laden ===
    loadedWithZoom: number
    loadedWithMobileMode: boolean
    loadedWithVisualZoom: boolean
    
    // === Aktivitätsstatus ===
    private _isActive: boolean
    
    // === Getter ===
    get view(): WebContentsView | null
    get webContentsId(): number | null
    get isActive(): boolean
    
    // === Lifecycle ===
    create(parentWindow: BrowserWindow, preloadPath: string): void
    destroy(): void
    
    // === Navigation ===
    load(url: string, settings: NavigationSettings): Promise<void>
    
    // === Aktivierung ===
    setActive(active: boolean): void
    
    // === Recycling ===
    recycle(): void  // Zerstört View, setzt State zurück
}
```

### ContentViewPool

Verwaltet Array von CachedContentViews und IPC-Routing.

```typescript
class ContentViewPool {
    private views: CachedContentView[] = []
    private activeViewId: string | null = null
    private viewsByWebContentsId: Map<number, CachedContentView> = new Map()
    private parentWindow: BrowserWindow | null = null
    private bounds: ContentViewBounds = { x: 0, y: 0, width: 800, height: 600 }
    
    // === Initialisierung ===
    initialize(parentWindow: BrowserWindow): void
    
    // === View-Zugriff ===
    getActiveView(): CachedContentView | null
    getViewById(id: string): CachedContentView | null
    getViewByArticleId(articleId: string): CachedContentView | null
    getViewByWebContentsId(wcId: number): CachedContentView | null
    
    // === Navigation ===
    navigateToArticle(articleId: string, url: string, settings: NavigationSettings): Promise<void>
    prefetch(articleId: string, url: string, settings: NavigationSettings): void
    
    // === Pool-Management ===
    private findRecyclableView(excludeArticleIds: string[]): CachedContentView | null
    private updateWebContentsMapping(): void
    
    // === Visibility ===
    showActiveView(): void
    hideAllViews(): void
    setBounds(bounds: ContentViewBounds): void
    
    // === IPC ===
    private setupIpcHandlers(): void
    private handleViewEvent(view: CachedContentView, event: any): void
    
    // === Cleanup ===
    destroy(): void
}
```

## Navigation Flow

### Artikelwechsel (User drückt J/K oder klickt)

```
1. Renderer sendet: navigateToArticle(articleId, url, settings)
   
2. Pool prüft: Ist articleId bereits in einem View geladen?
   
   JA → Instant Swap:
        - Alter activeView.setActive(false)
        - Gefundener view.setActive(true)
        - showActiveView()
        - Fertig! (< 1ms)
   
   NEIN → Laden erforderlich:
        - findRecyclableView() → älteste nicht-aktive View
        - view.recycle() → zerstört alten WebContentsView
        - view.create() → neuer WebContentsView
        - view.load(url, settings)
        - Warten auf 'ready'
        - view.setActive(true)
        - showActiveView()
```

### Prefetch Flow

```
1. Renderer sendet nach Artikelwechsel:
   prefetch(nextArticleId, nextUrl, settings)
   prefetch(prevArticleId, prevUrl, settings)

2. Pool prüft für jeden:
   - Bereits geladen? → Skip
   - Freie View verfügbar? → Lade in Hintergrund
   - Keine freie View? → Skip (aktive View nicht anfassen)
```

## IPC-Kommunikation

### Kanäle: Renderer → Pool (via Main)

| Kanal | Parameter | Beschreibung |
|-------|-----------|--------------|
| `cvp-navigate` | articleId, url, settings | Navigiere zu Artikel |
| `cvp-prefetch` | articleId, url, settings | Prefetch im Hintergrund |
| `cvp-set-bounds` | bounds | Sichtbare Bounds setzen |
| `cvp-set-visibility` | visible | Pool ein/ausblenden |
| `cvp-zoom-changed` | feedId, zoom | Zoom für Feed geändert |

### Kanäle: Pool → Renderer

| Kanal | Parameter | Beschreibung |
|-------|-----------|--------------|
| `cvp-status-changed` | articleId, status | Ladestatus geändert |
| `cvp-navigation-complete` | articleId | Artikel bereit |
| `cvp-error` | articleId, error | Ladefehler |

### Kanäle: Pool → View (webContents.send)

| Kanal | Parameter | Beschreibung |
|-------|-----------|--------------|
| `set-active-state` | boolean | Aktiviert/deaktiviert View |
| `set-visual-zoom-level` | level | CSS Zoom Level |
| (bestehende Kanäle) | ... | Unverändert |

### Kanäle: View → Pool (event.sender identifiziert)

| Kanal | Parameter | Beschreibung |
|-------|-----------|--------------|
| `cv-keydown` | key, modifiers | Tastendruck (nur aktive View) |
| `cv-scroll` | position | Scroll-Event |
| `cv-load-complete` | - | DOM ready |
| (bestehende Kanäle) | ... | Mit View-Filterung |

## Preload Anpassungen

```javascript
// Neuer State im Preload
let isActiveView = false

// Aktivitätsstatus empfangen
ipcRenderer.on('set-active-state', (event, active) => {
    isActiveView = active
})

// Events nur senden wenn aktiv
function sendIfActive(channel, ...args) {
    if (isActiveView) {
        ipcRenderer.send(channel, ...args)
    }
}

// Keyboard-Handler anpassen
document.addEventListener('keydown', (e) => {
    sendIfActive('cv-keydown', {
        key: e.key,
        code: e.code,
        // ...
    })
})
```

## Renderer Anpassungen

### Navigation Hints

Der Renderer muss dem Pool mitteilen, welche Artikel als nächstes kommen:

```typescript
// In article-container.tsx oder nav-container.tsx

function onArticleChanged(currentArticleId: string, direction: 'forward' | 'backward') {
    const currentIndex = articleList.findIndex(a => a._id === currentArticleId)
    
    const nextArticle = articleList[currentIndex + 1]
    const prevArticle = articleList[currentIndex - 1]
    
    // Prefetch basierend auf Leserichtung
    if (direction === 'forward' && nextArticle) {
        window.contentView.prefetch(nextArticle._id, generateUrl(nextArticle), settings)
    } else if (direction === 'backward' && prevArticle) {
        window.contentView.prefetch(prevArticle._id, generateUrl(prevArticle), settings)
    }
    
    // Auch die andere Richtung prefetchen (niedrigere Priorität)
    // ...
}
```

### Zoom-Änderung Broadcasting

Wenn User den Zoom ändert, müssen alle Views des gleichen Feeds aktualisiert werden:

```typescript
function onZoomChanged(feedId: string, newZoom: number) {
    // Speichere in DB
    updateFeedZoom(feedId, newZoom)
    
    // Informiere Pool
    window.contentView.zoomChangedForFeed(feedId, newZoom)
}
```

## State Transitions

### CachedContentView Status

```
                    ┌─────────┐
                    │  empty  │ ←── Initial / nach recycle()
                    └────┬────┘
                         │ load() aufgerufen
                         ▼
                    ┌─────────┐
        ┌──────────►│ loading │
        │           └────┬────┘
        │                │
        │     ┌──────────┼──────────┐
        │     │          │          │
        │     ▼          ▼          ▼
        │ ┌───────┐  ┌───────┐  ┌───────┐
        │ │ ready │  │ error │  │(abort)│
        │ └───────┘  └───┬───┘  └───────┘
        │                │           │
        │                │           │
        └────────────────┴───────────┘
                    recycle()
```

## Recycling-Strategie

Bei Navigation vorwärts und Pool voll:

1. Suche View mit ältestem `lastAccessTime`
2. Aber NICHT die aktive View
3. Bevorzuge Views in entgegengesetzter Leserichtung

```typescript
findRecyclableView(currentArticleId: string, direction: 'forward' | 'backward'): CachedContentView {
    const candidates = this.views.filter(v => !v.isActive)
    
    // Sortiere: Entgegengesetzte Richtung zuerst, dann nach lastAccessTime
    candidates.sort((a, b) => {
        // Komplexe Sortierlogik basierend auf Artikelposition
        // ...
    })
    
    return candidates[0]
}
```

## Edge Cases

### 1. Schnelles Navigieren

User drückt J J J J schnell hintereinander:
- Jede Navigation triggert Prefetch
- Abgebrochene Loads werden ignoriert (status bleibt 'loading' bis fertig oder error)
- Aktive View wechselt instant wenn Ziel-Artikel bereits geladen

### 2. Feed-Wechsel

User wechselt von Feed A zu Feed B:
- Views mit Feed A Artikeln können recycled werden
- Keine sofortige Bereinigung nötig (LRU regelt das)

### 3. Zoom-Änderung während Prefetch

User ändert Zoom während ein Artikel im Hintergrund lädt:
- `loadedWithZoom` speichert den Zoom-Wert beim Laden
- Bei Aktivierung prüfen: Stimmt Zoom noch?
- Wenn nicht: Neu laden oder CSS Zoom nachträglich anpassen

### 4. Netzwerk-Fehler bei Prefetch

Prefetch schlägt fehl:
- `status` wird 'error', `loadError` enthält Details
- Bei Aktivierung: User sieht Fehlermeldung mit Reload-Button
- Kein automatischer Retry (würde Netzwerk belasten)

### 5. Sehr lange Artikel-Listen

User scrollt durch 1000+ Artikel:
- Pool bleibt bei 3 Views
- Ständiges Recycling ist OK (Views werden neu erstellt)
- Memory bleibt konstant

## Migration von ContentViewManager

### Phase 1: Parallelbetrieb

1. `ContentViewPool` als neue Klasse neben `ContentViewManager`
2. Feature Flag: `useViewPool: boolean`
3. Beide Implementierungen testen

### Phase 2: Migration

1. IPC-Handler von Manager zu Pool verschieben
2. Renderer auf neue Kanäle umstellen
3. Alte ContentViewManager-Referenzen ersetzen

### Phase 3: Cleanup

1. `ContentViewManager` löschen
2. Feature Flag entfernen
3. Dokumentation aktualisieren

## Testplan

### Unit Tests

- [ ] CachedContentView Lifecycle (create, load, destroy)
- [ ] CachedContentView Status Transitions
- [ ] ContentViewPool View-Lookup
- [ ] ContentViewPool Recycling-Logik

### Integration Tests

- [ ] Navigation vorwärts/rückwärts
- [ ] Prefetch triggert korrekt
- [ ] Zoom-Änderung propagiert
- [ ] IPC-Routing korrekt

### Manuelle Tests

- [ ] Schnelles Navigieren (J J J J)
- [ ] Zurück-Navigation (K)
- [ ] Feed-Wechsel
- [ ] Netzwerk-Fehler (Offline-Modus)
- [ ] Memory-Verbrauch über Zeit
- [ ] Visual Zoom + Pool
- [ ] Mobile Mode + Pool

## Offene Fragen

1. **Pool-Größe konfigurierbar?**
   - Aktuell: Fest auf 3
   - Könnte in Settings aufgenommen werden (2-5?)

2. **Prefetch-Timing**
   - Sofort nach Navigation?
   - Mit Delay (User liest evtl. nur kurz)?
   - Idle-basiert?

3. **Memory-Monitoring**
   - Sollen wir Memory-Verbrauch loggen?
   - Bei Memory-Druck Pool verkleinern?

## Anhang: Dateistruktur

```
src/main/
├── content-view-manager.ts      # ALT - wird ersetzt
├── content-view-pool.ts         # NEU - Pool-Verwaltung
├── cached-content-view.ts       # NEU - Einzelne View-Kapselung
└── ...

src/bridges/
└── content-view.ts              # Anpassungen für Pool-API

src/renderer/
└── content-preload.js           # isActive-Flag hinzufügen
```
