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

**Lösung:** Pool von vorbereiteten Views mit Prefetching der nächsten Artikel.

## Pool-Größe

### Grenzen

| Grenze | Wert | Begründung |
|--------|------|------------|
| **Minimum** | 2 | 1 aktiv + 1 prefetch (sonst kein Vorteil) |
| **Default** | 3 | 1 prev + 1 aktiv + 1 next (optimaler Kompromiss) |
| **Maximum** | ressourcenabhängig | ~20-50MB RAM pro View |

### Warum Minimum 2?

```
Pool-Größe 1:  Kein Prefetch möglich → identisch mit aktueller Implementierung
Pool-Größe 2:  [AKTIV] [PREFETCH] → Vorwärts ODER Rückwärts gecached
Pool-Größe 3:  [PREV] [AKTIV] [NEXT] → Beide Richtungen gecached
Pool-Größe 4+: Ältere Artikel bleiben länger im Cache
```

### Memory-Kalkulation

```
WebContentsView Basis:     ~20MB
+ Geladene HTML/DOM:       ~5-20MB (abhängig von Artikel)
+ Bilder (dekodiert):      ~10-50MB (abhängig von Feed)
─────────────────────────────────────
Pro View:                  ~35-90MB

Pool-Größe 2:              ~70-180MB
Pool-Größe 3:              ~105-270MB  ← Empfohlen
Pool-Größe 5:              ~175-450MB
Pool-Größe 10:             ~350-900MB  ← Nicht empfohlen
```

### Konfigurierbare Pool-Größe

```typescript
interface PoolConfig {
    // Pool-Größe (2 = minimal, 3 = empfohlen)
    size: number              // Default: 3, Min: 2
    
    // Automatische Größenanpassung bei Memory-Druck
    autoShrink: boolean       // Default: false
    
    // Grenze für autoShrink (wenn verfügbarer RAM darunter fällt)
    memoryThresholdMB: number // Default: 512
}
```

### Dynamische Anpassung (Optional, Phase 2)

```typescript
class ContentViewPool {
    private config: PoolConfig
    
    // Bei Memory-Druck Pool verkleinern
    private onMemoryPressure(): void {
        if (!this.config.autoShrink) return
        
        const availableMemory = getAvailableMemoryMB()
        if (availableMemory < this.config.memoryThresholdMB) {
            // Auf Minimum reduzieren, aber nie unter 2
            this.shrinkPool(2)
        }
    }
    
    // Wenn Memory wieder verfügbar, Pool vergrößern
    private onMemoryRelieved(): void {
        if (this.views.length < this.config.size) {
            this.growPool(this.config.size)
        }
    }
}
```

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
    
    // === Leserichtung ===
    private readingDirection: 'forward' | 'backward' | 'unknown' = 'unknown'
    private currentArticleIndex: number = -1
    private articleListLength: number = 0
    
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
    
    // === Leserichtung ===
    setArticleContext(currentIndex: number, listLength: number): void
    updateReadingDirection(newDirection: 'forward' | 'backward'): void
    getReadingDirection(): 'forward' | 'backward' | 'unknown'
    
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

### Leserichtung (Reading Direction)

Die Leserichtung bestimmt, welcher Artikel primär geprefetcht wird.

#### Ermittlung der Leserichtung

```
┌─────────────────────────────────────────────────────────────────┐
│                    Artikel-Liste im Feed                         │
├─────────────────────────────────────────────────────────────────┤
│  [0]      [1]      [2]      [3]      [4]      [5]      [6]      │
│  ältester                                              neuester │
│                                                                  │
│  Fall A: User öffnet [0] → Richtung: FORWARD (kann nur vorwärts)│
│  Fall B: User öffnet [6] → Richtung: BACKWARD (kann nur zurück) │
│  Fall C: User öffnet [3] → Richtung: UNKNOWN (noch unbestimmt)  │
│                                                                  │
│  Bei UNKNOWN: Nächste Aktion (J/K) bestimmt Richtung            │
└─────────────────────────────────────────────────────────────────┘
```

#### State Machine für Leserichtung

```
                    ┌──────────────┐
                    │   UNKNOWN    │ ← Initial (Artikel in der Mitte)
                    └──────┬───────┘
                           │
            ┌──────────────┼──────────────┐
            │ J/→ gedrückt │ K/← gedrückt │
            ▼              │              ▼
    ┌──────────────┐       │      ┌──────────────┐
    │   FORWARD    │◄──────┴─────►│   BACKWARD   │
    └──────────────┘   Richtungs- └──────────────┘
            ▲            wechsel          ▲
            │              │              │
            └──────────────┴──────────────┘
                    jederzeit möglich
```

#### Sonderfälle

| Position | Öffnungs-Aktion | Initiale Richtung |
|----------|-----------------|-------------------|
| Erster Artikel (Index 0) | Klick/Enter | FORWARD (zwingend) |
| Letzter Artikel (Index n-1) | Klick/Enter | BACKWARD (zwingend) |
| Mittlerer Artikel | Klick/Enter | UNKNOWN → durch nächste J/K Aktion |
| Nach J/→ | Navigation | FORWARD |
| Nach K/← | Navigation | BACKWARD |

#### Prefetch-Strategie basierend auf Richtung

```typescript
interface ReadingState {
    direction: 'forward' | 'backward' | 'unknown'
    currentIndex: number
    listLength: number
}

function determinePrefetchTargets(state: ReadingState): {
    primary: number | null,    // Wird sofort geprefetcht
    secondary: number | null   // Wird geprefetcht wenn View frei
} {
    const { direction, currentIndex, listLength } = state
    
    switch (direction) {
        case 'forward':
            return {
                primary: currentIndex + 1 < listLength ? currentIndex + 1 : null,
                secondary: currentIndex - 1 >= 0 ? currentIndex - 1 : null
            }
        
        case 'backward':
            return {
                primary: currentIndex - 1 >= 0 ? currentIndex - 1 : null,
                secondary: currentIndex + 1 < listLength ? currentIndex + 1 : null
            }
        
        case 'unknown':
            // Beide Richtungen gleichwertig prefetchen
            return {
                primary: currentIndex + 1 < listLength ? currentIndex + 1 : null,
                secondary: currentIndex - 1 >= 0 ? currentIndex - 1 : null
            }
    }
}
```

#### Pool-Belegung nach Leserichtung

**Szenario: User liest vorwärts (FORWARD)**

```
Artikel-Liste: [A] [B] [C] [D] [E]
                        ↑
                    aktuell

Pool-Belegung:
┌─────────┬─────────┬─────────┐
│ View 0  │ View 1  │ View 2  │
│ Art. B  │ Art. C  │ Art. D  │
│ (prev)  │ (AKTIV) │ (next)  │
│ ready   │ ready   │ loading │
└─────────┴─────────┴─────────┘

User drückt J → Wechsel zu D:
┌─────────┬─────────┬─────────┐
│ View 0  │ View 1  │ View 2  │
│ Art. E  │ Art. C  │ Art. D  │
│ (next)  │ (prev)  │ (AKTIV) │
│ loading │ ready   │ ready   │ ← Instant swap!
└─────────┴─────────┴─────────┘
View 0 wird recycled für E (primary prefetch)
```

**Szenario: User wechselt Richtung (FORWARD → BACKWARD)**

```
Artikel-Liste: [A] [B] [C] [D] [E]
                        ↑
                    aktuell, war vorwärts

User drückt K → Wechsel zu B, Richtung wird BACKWARD:
┌─────────┬─────────┬─────────┐
│ View 0  │ View 1  │ View 2  │
│ Art. A  │ Art. B  │ Art. D  │
│ (next)  │ (AKTIV) │ (old)   │
│ loading │ ready   │ ready   │ ← B war noch im Cache!
└─────────┴─────────┴─────────┘
View 0 wird für A (neuer primary in BACKWARD) geladen
View 2 (Art. D) bleibt als Fallback
```

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

### Prefetch Timing

Um die aktive View nicht zu beeinträchtigen und bei schnellem Navigieren keine
unnötigen Requests zu erzeugen, wird Prefetch verzögert ausgeführt:

#### Timing-Strategie

```
┌─────────────────────────────────────────────────────────────────┐
│                    Prefetch Timing                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  navigateToArticle()                                             │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────┐                                                │
│  │ Aktive View  │ ← User sieht neuen Artikel                     │
│  │   lädt...    │                                                │
│  └──────┬───────┘                                                │
│         │                                                        │
│         ▼ 'dom-ready' Event                                      │
│  ┌──────────────┐                                                │
│  │ Aktive View  │ ← DOM bereit, Bilder laden evtl. noch          │
│  │    ready     │                                                │
│  └──────┬───────┘                                                │
│         │                                                        │
│         ▼ + PREFETCH_DELAY (300-500ms)                           │
│  ┌──────────────┐                                                │
│  │   Prefetch   │ ← Erst jetzt nächsten Artikel laden            │
│  │   startet    │                                                │
│  └──────────────┘                                                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

#### Abbruch bei erneutem Navigieren

```typescript
class ContentViewPool {
    private prefetchTimer: NodeJS.Timeout | null = null
    private readonly PREFETCH_DELAY = 400  // ms nach dom-ready
    
    private schedulePrefetch(targets: PrefetchTargets): void {
        // Vorherigen Timer abbrechen (User hat schnell weitergeklickt)
        if (this.prefetchTimer) {
            clearTimeout(this.prefetchTimer)
            this.prefetchTimer = null
        }
        
        // Neuen Timer starten
        this.prefetchTimer = setTimeout(() => {
            this.prefetchTimer = null
            this.executePrefetch(targets)
        }, this.PREFETCH_DELAY)
    }
    
    navigateToArticle(articleId: string, ...): Promise<void> {
        // Timer abbrechen bei neuer Navigation
        if (this.prefetchTimer) {
            clearTimeout(this.prefetchTimer)
            this.prefetchTimer = null
        }
        
        // ... Navigation durchführen ...
        
        // Nach 'dom-ready': Prefetch planen
        activeView.onReady(() => {
            const targets = this.determinePrefetchTargets()
            this.schedulePrefetch(targets)
        })
    }
}
```

#### Schnelles Navigieren (J J J J)

```
Zeit →
────────────────────────────────────────────────────────────────────►

  J          J          J          J
  │          │          │          │
  ▼          ▼          ▼          ▼
┌────┐     ┌────┐     ┌────┐     ┌────┐
│Art1│     │Art2│     │Art3│     │Art4│
│load│     │load│     │load│     │load│
└─┬──┘     └─┬──┘     └─┬──┘     └─┬──┘
  │          │          │          │
  │ 400ms    │ 400ms    │ 400ms    │ 400ms
  │ Timer    │ Timer    │ Timer    │ Timer
  ▼          ▼          ▼          ▼
  ✗          ✗          ✗          ✓ Prefetch Art5
  (abgebr.)  (abgebr.)  (abgebr.)  (ausgeführt)
  
Ergebnis: Nur EIN Prefetch (für Art5) wird tatsächlich gestartet.
Die abgebrochenen Timer verhindern unnötige Netzwerk-/CPU-Last.
```

#### Konfigurierbare Parameter

```typescript
interface PrefetchConfig {
    // Verzögerung nach dom-ready bevor Prefetch startet
    delayAfterReady: number      // Default: 400ms
    
    // Minimale Zeit zwischen zwei Prefetch-Starts
    minInterval: number          // Default: 200ms
    
    // Prefetch komplett deaktivieren (für langsame Systeme)
    enabled: boolean             // Default: true
}
```

#### Optionale Erweiterung: Adaptive Timing (Future)

Für Feeds mit unterschiedlicher Seitenkomplexität könnte das Timing pro Host
adaptiv angepasst werden. Dies ist eine **optionale Optimierung** für Edge Cases.

**Konzept:**

```typescript
interface HostLoadMetrics {
    hostname: string             // z.B. "example.com"
    avgLoadTime: number          // Durchschnittliche Ladezeit (ms)
    avgResourceCount: number     // Durchschnittliche Anzahl Ressourcen
    avgMemoryImpact: number      // Geschätzter Speicherbedarf (MB)
    sampleCount: number          // Anzahl Messungen
    lastUpdated: Date
}

// Speicherung in SQLite (feeds.db oder separate Tabelle)
// CREATE TABLE host_metrics (
//     hostname TEXT PRIMARY KEY,
//     avg_load_time INTEGER,
//     avg_resource_count INTEGER,
//     avg_memory_impact INTEGER,
//     sample_count INTEGER,
//     last_updated TEXT
// )
```

**Adaptive Delay-Berechnung:**

```typescript
function calculateAdaptiveDelay(hostname: string): number {
    const metrics = getHostMetrics(hostname)
    
    if (!metrics || metrics.sampleCount < 3) {
        // Nicht genug Daten → Default verwenden
        return DEFAULT_PREFETCH_DELAY  // 400ms
    }
    
    // Schnelle Seiten: Kürzerer Delay (min 200ms)
    // Langsame Seiten: Längerer Delay (max 1000ms)
    const baseDelay = Math.min(1000, Math.max(200, metrics.avgLoadTime * 0.5))
    
    // Bei hohem Memory-Impact: Zusätzliche Verzögerung
    if (metrics.avgMemoryImpact > 50) {  // > 50MB
        return baseDelay + 200
    }
    
    return baseDelay
}
```

**Messung der Ladezeit:**

```typescript
class CachedContentView {
    private loadStartTime: number = 0
    
    async load(url: string, settings: NavigationSettings): Promise<void> {
        this.loadStartTime = performance.now()
        // ... Navigation starten ...
    }
    
    private onDomReady(): void {
        const loadTime = performance.now() - this.loadStartTime
        const hostname = new URL(this.url).hostname
        
        // Metrik aktualisieren (gleitender Durchschnitt)
        updateHostMetrics(hostname, {
            loadTime,
            resourceCount: performance.getEntriesByType('resource').length,
            // Memory-Impact müsste über process.memoryUsage() gemessen werden
        })
    }
}
```

**Wann implementieren:**

| Priorität | Grund |
|-----------|-------|
| **Niedrig** | 400ms Default funktioniert für 95% der Fälle |
| **Mittel** | Wenn User-Feedback zeigt, dass bestimmte Feeds Probleme machen |
| **Hoch** | Wenn Memory-Management kritisch wird (viele große Feeds) |

**Empfehlung:** Erst in Phase 2 implementieren, wenn das Basis-Pooling stabil läuft.

## IPC-Kommunikation

### Kanäle: Renderer → Pool (via Main)

| Kanal | Parameter | Beschreibung |
|-------|-----------|--------------|
| `cvp-navigate` | articleId, url, settings, index, listLength | Navigiere zu Artikel |
| `cvp-prefetch` | articleId, url, settings | Prefetch im Hintergrund |
| `cvp-set-bounds` | bounds | Sichtbare Bounds setzen |
| `cvp-set-visibility` | visible | Pool ein/ausblenden |
| `cvp-zoom-changed` | feedId, zoom | Zoom für Feed geändert |
| `cvp-set-reading-direction` | direction | Leserichtung explizit setzen |
| `cvp-article-list-changed` | listLength | Wenn sich die Liste ändert |

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

### Phase 1: Parallelbetrieb ✅

1. ✅ `ContentViewPool` als neue Klasse neben `ContentViewManager`
2. ✅ Feature Flag: `USE_CONTENT_VIEW_POOL` in window.ts
3. ⏳ Beide Implementierungen testen

### Phase 2: Migration

1. IPC-Handler von Manager zu Pool verschieben
2. Renderer auf neue Kanäle umstellen
3. Alte ContentViewManager-Referenzen ersetzen

### Phase 3: Cleanup

1. `ContentViewManager` löschen
2. Feature Flag entfernen
3. Dokumentation aktualisieren

## Implementierungsfortschritt

### Erstellte Dateien

| Datei | Zeilen | Status | Beschreibung |
|-------|--------|--------|--------------|
| [cached-content-view.ts](../src/main/cached-content-view.ts) | ~380 | ✅ | WebContentsView-Wrapper mit Artikel-State |
| [content-view-pool.ts](../src/main/content-view-pool.ts) | ~550 | ✅ | Pool-Manager für gecachte Views |
| [content-view-pool.ts](../src/bridges/content-view-pool.ts) | ~200 | ✅ | IPC-Bridge für Renderer |

### Geänderte Dateien

| Datei | Status | Änderung |
|-------|--------|----------|
| [window.ts](../src/main/window.ts) | ✅ | Feature Flag + Pool-Initialisierung |
| [content-preload.js](../src/renderer/content-preload.js) | ✅ | isActiveView Flag + sendIfActive() |

### Nächste Schritte

| Priorität | Aufgabe | Beschreibung |
|-----------|---------|--------------|
| ~~1~~ | ~~Preload anpassen~~ | ✅ `isActive` Flag implementiert |
| 2 | Renderer anpassen | Navigation über Pool-Bridge, Artikel-Index mitsenden |
| 3 | IPC-Handler migrieren | Scroll, Keyboard, Context-Menu an aktive View routen |
| 4 | Settings-Sync | Zoom/MobileMode aus ContentViewManager übernehmen |
| 5 | Testing | Feature Flag aktivieren und testen |

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
   - ✅ Entschieden: 400ms nach dom-ready
   - Timer-Abbruch bei schneller Navigation

3. **Memory-Monitoring**
   - Sollen wir Memory-Verbrauch loggen?
   - Bei Memory-Druck Pool verkleinern?

## Anhang: Dateistruktur

```
src/main/
├── content-view-manager.ts      # ALT - wird ersetzt
├── content-view-pool.ts         # NEU - Pool-Verwaltung ✅
├── cached-content-view.ts       # NEU - Einzelne View-Kapselung ✅
└── window.ts                    # Feature Flag + Initialisierung ✅

src/bridges/
├── content-view.ts              # ALT - bestehende Bridge
└── content-view-pool.ts         # NEU - Pool-spezifische Bridge ✅

src/renderer/
└── content-preload.js           # isActive-Flag ✅
```
