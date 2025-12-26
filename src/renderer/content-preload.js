// Preload for ContentView: CSS-Transform-based zoom (Chrome-like)
// This script runs in the WebContentsView that displays article content.
// The entire page is scaled, not just visually zoomed.
try {
  const { ipcRenderer, contextBridge } = require('electron');

  let zoomLevel = 0; // zoomLevel: 0 = 100%, 1 = 110%, -1 = 90%, etc. (lineare 10%-Schritte)
  const MIN_ZOOM_LEVEL = -6;  // 40% minimum zoom (100% - 6*10%)
  const MAX_ZOOM_LEVEL = 40;  // 500% maximum zoom (100% + 40*10%)

  // Load initial zoom level synchronously (to prevent 100% flash)
  try {
    zoomLevel = ipcRenderer.sendSync('get-css-zoom-level') || 0;
    console.log('[ContentPreload] Initial zoom level loaded:', zoomLevel);
  } catch (e) {
    console.warn('[ContentPreload] Could not load initial zoom level:', e);
  }

  // Zoom-Overlay Einstellung - load synchronously to show overlay on first load
  let showZoomOverlayEnabled = false;
  try {
    showZoomOverlayEnabled = ipcRenderer.sendSync('get-zoom-overlay');
    console.log('[ContentPreload] Zoom Overlay initial state:', showZoomOverlayEnabled ? 'ON' : 'OFF');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Zoom Overlay state:', e);
  }
  
  // Mobile Mode Status
  let mobileMode = false;
  
  // Visual Zoom Mode: Wenn aktiviert, werden Touch-Events NICHT abgefangen
  // damit der native Browser-Pinch-Zoom funktioniert
  // Load initial value synchronously to prevent CSS zoom flash
  let visualZoomEnabled = false;
  try {
    visualZoomEnabled = ipcRenderer.sendSync('get-visual-zoom');
    console.log('[ContentPreload] Visual Zoom initial state:', visualZoomEnabled ? 'ON' : 'OFF');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Visual Zoom state:', e);
  }

  // Overlay für Debug-Anzeige (Zoom, NSFW-Cleanup, etc.)
  let infoOverlay = null;
  let infoOverlayTimeout = null;
  
  // Status-Nachrichten die zusammen mit dem Zoom angezeigt werden
  let statusMessages = [];

  /**
   * Fügt eine Status-Nachricht hinzu die beim nächsten Overlay-Update angezeigt wird
   * @param {string} message - Die Status-Nachricht
   * @param {number} duration - Wie lange die Nachricht im Status bleibt (ms)
   */
  function addStatusMessage(message, duration = 3000) {
    statusMessages.push(message);
    // Nachricht nach duration wieder entfernen
    setTimeout(() => {
      const index = statusMessages.indexOf(message);
      if (index > -1) {
        statusMessages.splice(index, 1);
      }
    }, duration);
    // Sofort anzeigen
    updateOverlay();
  }

  /**
   * Aktualisiert das Overlay mit allen aktuellen Nachrichten
   */
  function updateOverlay(zoomText = null) {
    // Nur anzeigen wenn Overlay aktiviert ist
    if (!showZoomOverlayEnabled) return;
    
    if (!infoOverlay) {
      infoOverlay = document.createElement('div');
      infoOverlay.id = 'fr-info-overlay';
      infoOverlay.style.cssText = `
        position: fixed;
        top: 8px;
        right: 8px;
        background: rgba(0, 0, 0, 0.75);
        color: white;
        padding: 6px 12px;
        border-radius: 4px;
        font-family: "Segoe UI", system-ui, sans-serif;
        font-size: 13px;
        font-weight: 500;
        z-index: 999999;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.2s ease-out;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        white-space: pre-line;
      `;
      document.body.appendChild(infoOverlay);
    }
    
    // Kombiniere Zoom-Text und Status-Nachrichten
    const lines = [];
    if (zoomText) lines.push(zoomText);
    lines.push(...statusMessages);
    
    if (lines.length === 0) {
      infoOverlay.style.opacity = '0';
      return;
    }
    
    infoOverlay.textContent = lines.join('\n');
    infoOverlay.style.opacity = '1';
    
    // Clear existing timeout
    if (infoOverlayTimeout) {
      clearTimeout(infoOverlayTimeout);
    }
    
    // Fade out after 1.5 seconds (nur wenn keine Status-Nachrichten mehr da sind)
    infoOverlayTimeout = setTimeout(() => {
      if (infoOverlay && statusMessages.length === 0) {
        infoOverlay.style.opacity = '0';
      }
    }, 1500);
  }

  /**
   * Zeigt eine kurze Nachricht im Overlay an (Legacy-Funktion)
   */
  function showOverlayMessage(message, duration = 1500) {
    addStatusMessage(message, duration);
  }

  function showZoomOverlay(level) {
    const factor = zoomLevelToFactor(level);
    const percentage = Math.round(factor * 100);
    const modeIndicator = mobileMode ? ' (M)' : ' (D)';
    console.log('[ContentPreload] showZoomOverlay: level=', level, 'factor=', factor, 'percentage=', percentage, '%', 'zoomLevel var=', zoomLevel);
    updateOverlay(`Zoom: ${percentage}%${modeIndicator}`);
  }

  // Konvertierung: zoomLevel -> Faktor (linear: 10% pro Stufe)
  // Level 0 = 100%, Level 1 = 110%, Level -1 = 90%, etc.
  function zoomLevelToFactor(level) {
    return 1 + (level * 0.1);
  }

  // Konvertierung: Faktor -> zoomLevel (linear)
  function factorToZoomLevel(factor) {
    return (factor - 1) / 0.1;
  }

  // Erstelle Zoom-Container der gesamte Seite enthält
  function ensureZoomContainer() {
    let wrapper = document.getElementById('fr-zoom-wrapper');
    if (!wrapper) {
      console.log('[ContentPreload] Creating zoom container - viewport:', window.innerWidth, 'x', window.innerHeight);
      // Erstelle Wrapper als Fixed Viewport (nicht scrollbar)
      wrapper = document.createElement('div');
      wrapper.id = 'fr-zoom-wrapper';
      wrapper.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        z-index: 0;
        margin: 0;
        padding: 0;
      `;
      
      // Erstelle inneren Container für Transform (dieser scrollt!)
      let container = document.createElement('div');
      container.id = 'fr-zoom-container';
      container.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        transform-origin: top left;
        transition: none;
        will-change: transform;
        margin: 0;
        padding: 0;
      `;
      
      // Kopiere alle HTML-Attribute zu Wrapper
      wrapper.style.margin = '0';
      wrapper.style.padding = '0';
      
      // Bewege alle Children vom Body in den Container
      while (document.body.firstChild) {
        container.appendChild(document.body.firstChild);
      }
      
      wrapper.appendChild(container);
      document.body.appendChild(wrapper);
      
      // Passe HTML und Body an
      document.documentElement.style.margin = '0';
      document.documentElement.style.padding = '0';
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.style.width = '100%';
      document.documentElement.style.height = '100%';
      
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.overflow = 'hidden';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
      document.body.style.display = 'block';
      
      // Verstecke horizontale Scrollbar
      const style = document.createElement('style');
      style.id = 'fr-zoom-style';
      style.textContent = `
        html, body {
          margin: 0;
          padding: 0;
          overflow: hidden;
        }
        #fr-zoom-container {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
        }
        #fr-zoom-container::-webkit-scrollbar {
          width: 8px;
          height: 0px;
        }
        #fr-zoom-container::-webkit-scrollbar-track {
          background: transparent;
        }
        #fr-zoom-container::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.3);
          border-radius: 4px;
        }
        #fr-zoom-container::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.5);
        }
      `;
      document.head.appendChild(style);
    }
    return wrapper.querySelector('#fr-zoom-container');
  }

  /**
   * Entfernt den Zoom-Container und stellt die originale DOM-Struktur wieder her
   * Wird aufgerufen wenn Visual Zoom aktiviert wird
   */
  function removeZoomContainer() {
    const wrapper = document.getElementById('fr-zoom-wrapper');
    const container = document.getElementById('fr-zoom-container');
    const style = document.getElementById('fr-zoom-style');
    
    if (!wrapper || !container) {
      console.log('[ContentPreload] removeZoomContainer: no container found');
      return;
    }
    
    console.log('[ContentPreload] Removing zoom container for Visual Zoom mode');
    
    // Bewege alle Children zurück zum Body
    while (container.firstChild) {
      document.body.appendChild(container.firstChild);
    }
    
    // Entferne Wrapper und Style
    wrapper.remove();
    if (style) style.remove();
    
    // Reset HTML und Body Styles
    document.documentElement.style.margin = '';
    document.documentElement.style.padding = '';
    document.documentElement.style.overflow = '';
    document.documentElement.style.width = '';
    document.documentElement.style.height = '';
    
    document.body.style.margin = '';
    document.body.style.padding = '';
    document.body.style.overflow = '';
    document.body.style.width = '';
    document.body.style.height = '';
    document.body.style.display = '';
    
    console.log('[ContentPreload] Zoom container removed - native Visual Zoom should work now');
  }

  // Wende Zoom auf Container an - Zoom kann von einem beliebigen Punkt aus erfolgen
  // WICHTIG: Bei Visual Zoom (Device Emulation) wird diese Funktion NICHT ausgeführt,
  // damit der native Browser-Pinch-Zoom funktioniert!
  function applyZoom(newZoomLevel, options = { notify: true, zoomPointX: null, zoomPointY: null, preserveScroll: true }) {
    // Bei Visual Zoom: KEINE CSS-basierte Zoom-Manipulation!
    // Der native Browser-Zoom (via enableDeviceEmulation) übernimmt.
    if (visualZoomEnabled) {
      console.log('[ContentPreload] applyZoom skipped - Visual Zoom is enabled');
      return;
    }
    
    // Stelle sicher, dass der Container existiert
    const container = ensureZoomContainer();
    const wrapper = container.parentElement;
    
    if (!wrapper) return;
    
    const oldFactor = zoomLevelToFactor(zoomLevel);
    zoomLevel = Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, newZoomLevel));
    const newFactor = zoomLevelToFactor(zoomLevel);
    
    // Aktuelle Scroll-Position
    const currentScrollX = container.scrollLeft || 0;
    const currentScrollY = container.scrollTop || 0;
    
    // Hole Zoom-Punkt: Standard = Viewport-Mitte, oder Custom Point
    let zoomPointX = options.zoomPointX;
    let zoomPointY = options.zoomPointY;
    
    if (zoomPointX === null || zoomPointY === null) {
      if (options.preserveScroll) {
        // Bewahre aktuelle Scroll-Position: zoomt vom oberen-linken Rand des aktuellen Views
        zoomPointX = currentScrollX;
        zoomPointY = currentScrollY;
      } else {
        // Default: Viewport-Mitte relativ zum Container
        zoomPointX = currentScrollX + wrapper.clientWidth / 2;
        zoomPointY = currentScrollY + wrapper.clientHeight / 2;
      }
    }
    
    // Position des Zoom-Punkts im Dokument (ungeskalter Raum)
    const docZoomPointX = zoomPointX / oldFactor;
    const docZoomPointY = zoomPointY / oldFactor;
    
    // Berechne neue Container-Größe basierend auf Skalierung
    const newContainerWidth = wrapper.clientWidth / newFactor;
    const newContainerHeight = wrapper.clientHeight / newFactor;
    
    // Setze Container-Größe und Scroll-Overflow
    container.style.width = newContainerWidth + 'px';
    container.style.height = newContainerHeight + 'px';
    container.style.overflow = 'auto';
    
    // Wende Scale an
    container.style.transform = `scale(${newFactor})`;
    
    // Berechne neue Scroll-Position
    requestAnimationFrame(() => {
      if (options.preserveScroll) {
        // Für Tastatur-Zoom: Behalte einfach die aktuelle Scroll-Position
        // (in ungeskaltem Raum) - ändere nichts an der Scroll-Position
        // container.scrollLeft und container.scrollTop bleiben gleich
      } else {
        // Der Zoom-Punkt (zoomPointX, zoomPointY) soll an der gleichen Stelle im Viewport bleiben
        // zoomPointX/Y sind in skaliertem Raum (mit oldFactor)
        
        // Wo war dieser Punkt im uneskalierten Dokument?
        const docPointX = zoomPointX / oldFactor;
        const docPointY = zoomPointY / oldFactor;
        
        // Wo sollte dieser Punkt nach dem neuen Zoom sein (in skaliertem Raum)?
        const newScaledPointX = docPointX * newFactor;
        const newScaledPointY = docPointY * newFactor;
        
        // Wie weit war der Punkt vom oberen-linken Scroll-Eck entfernt?
        const offsetFromScrollX = zoomPointX - currentScrollX;
        const offsetFromScrollY = zoomPointY - currentScrollY;
        
        // Der neue Scroll sollte so sein, dass der Punkt gleich weit vom Eck entfernt ist
        const newScrollX = Math.max(0, newScaledPointX - offsetFromScrollX);
        const newScrollY = Math.max(0, newScaledPointY - offsetFromScrollY);
        
        container.scrollLeft = newScrollX;
        container.scrollTop = newScrollY;
      }
    });
    
    // Zeige Zoom-Overlay (immer wenn sich Zoom ändert)
    showZoomOverlay(zoomLevel);
    
    // Sende Notification an Main-Prozess
    if (options.notify) {
      try { ipcRenderer.send('content-view-zoom-changed', zoomLevel); } catch {}
    }
  }

  // Initial: Warte auf DOM
  // ABER: Überspringen wenn Visual Zoom aktiviert ist (dann macht Device Emulation den Zoom)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!visualZoomEnabled) {
        applyZoom(zoomLevel, { notify: false });
      } else {
        console.log('[ContentPreload] Skipping initial CSS zoom - Visual Zoom mode active');
        // Aber zeige trotzdem das Overlay wenn aktiviert (für Visual Zoom)
        if (showZoomOverlayEnabled) {
          showZoomOverlay(zoomLevel);
        }
      }
      // Log initial scaling info
      logCurrentScale('DOMContentLoaded');
    });
  } else {
    if (!visualZoomEnabled) {
      applyZoom(zoomLevel, { notify: false });
    } else {
      console.log('[ContentPreload] Skipping initial CSS zoom - Visual Zoom mode active');
      // Aber zeige trotzdem das Overlay wenn aktiviert (für Visual Zoom)
      if (showZoomOverlayEnabled) {
        showZoomOverlay(zoomLevel);
      }
    }
    // Log initial scaling info
    logCurrentScale('Already loaded');
  }
  
  // === SCALE OBSERVER für Debugging ===
  function logCurrentScale(reason) {
    const vv = window.visualViewport;
    const dpr = window.devicePixelRatio;
    const innerW = window.innerWidth;
    const innerH = window.innerHeight;
    const outerW = window.outerWidth;
    const outerH = window.outerHeight;
    
    let msg = `[ContentPreload] SCALE (${reason}): `;
    msg += `innerSize=${innerW}x${innerH}, `;
    msg += `outerSize=${outerW}x${outerH}, `;
    msg += `DPR=${dpr.toFixed(2)}`;
    
    if (vv) {
      msg += `, visualViewport: ${Math.round(vv.width)}x${Math.round(vv.height)} scale=${vv.scale.toFixed(2)}`;
    }
    
    console.log(msg);
  }
  
  // Observe visualViewport changes
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      logCurrentScale('visualViewport resize');
    });
    window.visualViewport.addEventListener('scroll', () => {
      // Only log on significant scale changes, not scroll
      // logCurrentScale('visualViewport scroll');
    });
  }
  
  // Also log on window resize
  window.addEventListener('resize', () => {
    logCurrentScale('window resize');
  });

  // Listener für externe Zoom-Befehle (von Keyboard - bewahre Scroll-Position)
  // ABER: Bei Visual Zoom nur das Level tracken, NICHT CSS zoom anwenden!
  ipcRenderer.on('content-view-set-css-zoom', (event, zoomLevel_) => {
    console.log('[ContentPreload] Received content-view-set-css-zoom:', zoomLevel_, 'visualZoom:', visualZoomEnabled);
    zoomLevel = zoomLevel_;
    
    // Bei Visual Zoom: Kein CSS Zoom anwenden (Device Emulation macht den Zoom)
    if (!visualZoomEnabled) {
      // Ensure DOM is ready before applying zoom (important after navigation)
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          applyZoom(zoomLevel, { notify: false, preserveScroll: true, zoomPointX: null, zoomPointY: null });
        }, { once: true });
      } else {
        applyZoom(zoomLevel, { notify: false, preserveScroll: true, zoomPointX: null, zoomPointY: null });
      }
    }
    
    // Zeige Zoom-Overlay beim Artikelwechsel, wenn aktiviert
    if (showZoomOverlayEnabled) {
      showZoomOverlay(zoomLevel);
    }
  });

  // Listener für Zoom-Overlay-Einstellung
  ipcRenderer.on('set-zoom-overlay-setting', (event, enabled) => {
    showZoomOverlayEnabled = !!enabled;
    // Wenn aktiviert, zeige sofort das aktuelle Zoom-Level an
    if (showZoomOverlayEnabled) {
      showZoomOverlay(zoomLevel);
    }
  });
  
  // Listener für Visual Zoom Level Update (für Overlay-Anzeige bei Device Emulation)
  // Das CSS-basierte zoomLevel wird nicht verwendet bei Visual Zoom,
  // aber wir brauchen trotzdem ein Level für die Overlay-Anzeige
  ipcRenderer.on('set-visual-zoom-level', (event, level) => {
    console.log('[ContentPreload] Visual Zoom level update:', level);
    zoomLevel = level;  // Update internal tracking
    if (showZoomOverlayEnabled) {
      showZoomOverlay(level);
    }
    // Log scale after receiving zoom level
    setTimeout(() => logCurrentScale('after set-visual-zoom-level'), 50);
  });
  
  // Listener für Mobile Mode Status
  ipcRenderer.on('set-mobile-mode', (event, enabled) => {
    const wasEnabled = mobileMode;
    mobileMode = !!enabled;
    console.log('[ContentPreload] Mobile mode changed:', wasEnabled ? 'ON' : 'OFF', '->', mobileMode ? 'ON' : 'OFF');
    // Zeige kurz das Overlay um den Modus-Wechsel anzuzeigen (auch wenn Overlay sonst deaktiviert)
    if (wasEnabled !== mobileMode) {
      const factor = zoomLevelToFactor(zoomLevel);
      const percentage = Math.round(factor * 100);
      const modeIndicator = mobileMode ? ' (M)' : ' (D)';
      // Temporär anzeigen auch wenn Overlay deaktiviert
      const wasOverlayEnabled = showZoomOverlayEnabled;
      showZoomOverlayEnabled = true;
      updateOverlay(`Zoom: ${percentage}%${modeIndicator}`);
      showZoomOverlayEnabled = wasOverlayEnabled;
    }
  });

  // Listener für Visual Zoom Mode (aktiviert nativen Browser-Pinch-Zoom)
  ipcRenderer.on('set-visual-zoom-mode', (event, enabled) => {
    const wasEnabled = visualZoomEnabled;
    visualZoomEnabled = !!enabled;
    console.log('[ContentPreload] Visual Zoom mode changed:', wasEnabled ? 'ON' : 'OFF', '->', visualZoomEnabled ? 'ON' : 'OFF');
    
    // Wenn Visual Zoom aktiviert wird, entferne den CSS Zoom-Container
    // damit der native Browser-Pinch-Zoom (via enableDeviceEmulation) funktioniert
    if (visualZoomEnabled) {
      removeZoomContainer();
    }
    
    if (wasEnabled !== visualZoomEnabled) {
      // Zeige Statusmeldung
      const wasOverlayEnabled = showZoomOverlayEnabled;
      showZoomOverlayEnabled = true;
      updateOverlay(visualZoomEnabled ? 'Visual Zoom: ON (Pinch-to-Zoom aktiv)' : 'Visual Zoom: OFF');
      showZoomOverlayEnabled = wasOverlayEnabled;
    }
  });

  // Listener für Input Mode Status (deaktiviert Keyboard-Navigation für Login-Formulare etc.)
  let inputModeEnabled = false;
  ipcRenderer.on('set-input-mode', (event, enabled) => {
    inputModeEnabled = !!enabled;
    console.log('[ContentPreload] Input mode changed:', inputModeEnabled ? 'ON (navigation disabled)' : 'OFF (navigation enabled)');
  });

  // EXPERIMENTAL: JavaScript-based navigation (to test if Device Emulation survives)
  ipcRenderer.on('navigate-via-js', (event, url) => {
    console.log('[ContentPreload] Received navigate-via-js:', url);
    console.log('[ContentPreload] Current emulation state before JS navigation:');
    logCurrentScale('before JS navigation');
    
    // Navigate using JavaScript - this might preserve Device Emulation!
    window.location.href = url;
  });

  // NSFW-Cleanup Einstellung - synchron beim Start laden
  let nsfwCleanupEnabled = false;
  try {
    nsfwCleanupEnabled = ipcRenderer.sendSync('get-nsfw-cleanup');
    console.log('[ContentPreload] NSFW-Cleanup loaded:', nsfwCleanupEnabled ? 'enabled' : 'disabled');
  } catch (e) {
    console.warn('[ContentPreload] Could not load NSFW-Cleanup setting:', e);
  }

  // Auto Cookie-Consent Einstellung - synchron beim Start laden
  let autoCookieConsentEnabled = false;
  try {
    autoCookieConsentEnabled = ipcRenderer.sendSync('get-auto-cookie-consent');
    console.log('[ContentPreload] Auto Cookie-Consent loaded:', autoCookieConsentEnabled ? 'enabled' : 'disabled');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Auto Cookie-Consent setting:', e);
  }

  // Ctrl+Wheel Zoom (Touchpad) - zoomt vom Cursor aus
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
        // Bei Visual Zoom: Events durchlassen für nativen Browser-Zoom
        if (visualZoomEnabled) return;
        
        e.preventDefault();
        const delta = -e.deltaY;
        // Touchpad-Kontrolle: Mit größeren Schritten (höhere Empfindlichkeit)
        // Je größer dieser Wert, desto weniger empfindlich
        const steps = (delta > 0 ? 1 : -1) * 0.125;
        
        // TEMP: Scroll-Kompensation deaktiviert für Tests
        // Berechne Maus-Position relativ zum Container
        // const container = document.querySelector('#fr-zoom-container');
        // const wrapper = container.parentElement;
        // if (container && wrapper) {
        //   const rect = wrapper.getBoundingClientRect();
        //   const mouseX = (container.scrollLeft || 0) + (e.clientX - rect.left);
        //   const mouseY = (container.scrollTop || 0) + (e.clientY - rect.top);
        //   applyZoom(zoomLevel + steps, { notify: true, zoomPointX: mouseX, zoomPointY: mouseY, preserveScroll: false });
        // } else {
        //   applyZoom(zoomLevel + steps, { notify: true, preserveScroll: false });
        // }
        applyZoom(zoomLevel + steps, { notify: true, preserveScroll: true });
      }
    } catch {}
  }, { passive: false });

  // Touch Pinch-Zoom - zoomt vom Mittelpunkt der beiden Finger
  // WICHTIG: Bei aktiviertem Visual Zoom werden diese Events NICHT abgefangen,
  // damit der native Browser-Pinch-Zoom (via enableDeviceEmulation) funktioniert
  let lastDistance = 0;
  let touchStartZoomLevel = zoomLevel;
  let lastTouchMidpointX = 0;
  let lastTouchMidpointY = 0;

  // Touch-Event-Registrierung als Funktion, die bei jeder Navigation aufgerufen wird
  // Bei data: URLs wird der document bei jeder Navigation ersetzt, daher müssen
  // die Event-Listener auf dem neuen document neu registriert werden
  let touchEventsRegistered = false;
  
  function registerTouchEvents() {
    // WICHTIG: In Electron Preload wird das document bei data: URL Navigationen ersetzt!
    // Wir müssen die Events auf dem AKTUELLEN document registrieren
    const touchTarget = document;
    
    // Prüfe ob bereits auf diesem document registriert
    if (touchTarget._touchEventsRegistered) {
      console.log('[ContentPreload] Touch events already registered on this document');
      return;
    }
    touchTarget._touchEventsRegistered = true;
    
    touchTarget.addEventListener('touchstart', (e) => {
      console.log('[ContentPreload] touchstart received on document, touches:', e.touches.length, 'visualZoomEnabled:', visualZoomEnabled);
      try {
        // Bei Visual Zoom: Events durchlassen für nativen Browser-Zoom
        if (visualZoomEnabled) return;
        
        if (e.touches.length === 2) {
          const touch1 = e.touches[0];
          const touch2 = e.touches[1];
          lastDistance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
          );
          touchStartZoomLevel = zoomLevel;
          console.log('[ContentPreload] 2-finger touch started, distance:', lastDistance, 'zoomLevel:', touchStartZoomLevel);
          
          // Berechne Mittelpunkt der beiden Finger
          lastTouchMidpointX = (touch1.clientX + touch2.clientX) / 2;
          lastTouchMidpointY = (touch1.clientY + touch2.clientY) / 2;
        }
      } catch (err) { console.error('[ContentPreload] touchstart error:', err); }
    }, { passive: false, capture: true });

    touchTarget.addEventListener('touchmove', (e) => {
      try {
        // Bei Visual Zoom: Events durchlassen für nativen Browser-Zoom
        if (visualZoomEnabled) {
          console.log('[ContentPreload] touchmove ignored (Visual Zoom)');
          return;
        }
        
        if (e.touches.length === 2 && lastDistance > 0) {
          console.log('[ContentPreload] touchmove 2-finger, lastDistance:', lastDistance);
          e.preventDefault();
          const touch1 = e.touches[0];
          const touch2 = e.touches[1];
          const currentDistance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
          );
          const scale = currentDistance / lastDistance;
          // Halbe Geschwindigkeit für Touch-Screen (weniger empfindlich)
          const scaleFactor = 1 + (scale - 1) / 2;
          const newFactor = zoomLevelToFactor(touchStartZoomLevel) * scaleFactor;
          console.log('[ContentPreload] touchmove applying zoom, newFactor:', newFactor);
          
          // Berechne aktuellen Mittelpunkt der Finger
          const currentMidX = (touch1.clientX + touch2.clientX) / 2;
          const currentMidY = (touch1.clientY + touch2.clientY) / 2;
          
          // TEMP: Scroll-Kompensation deaktiviert für Tests
          // Berechne Touch-Position relativ zum Container
          // const container = document.querySelector('#fr-zoom-container');
          // const wrapper = container.parentElement;
          // if (container && wrapper) {
          //   const rect = wrapper.getBoundingClientRect();
          //   const touchX = (container.scrollLeft || 0) + (currentMidX - rect.left);
          //   const touchY = (container.scrollTop || 0) + (currentMidY - rect.top);
          //   applyZoom(factorToZoomLevel(newFactor), { notify: true, zoomPointX: touchX, zoomPointY: touchY, preserveScroll: false });
          // } else {
          //   applyZoom(factorToZoomLevel(newFactor), { notify: true, preserveScroll: false });
          // }
          applyZoom(factorToZoomLevel(newFactor), { notify: true, preserveScroll: true });
        }
      } catch (err) { console.error('[ContentPreload] touchmove error:', err); }
    }, { passive: false, capture: true });

    touchTarget.addEventListener('touchend', () => {
      console.log('[ContentPreload] touchend received');
      lastDistance = 0;
    }, { capture: true });

    console.log('[ContentPreload] Touch event listeners registered on document (capture phase)');
  }
  
  // Registriere Touch-Events sofort (für den initialen document)
  registerTouchEvents();
  
  // Bei jeder Navigation wird ein neues document erstellt - registriere dann erneut
  // DOMContentLoaded feuert bei jeder Navigation, auch bei data: URLs
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[ContentPreload] DOMContentLoaded - re-registering touch events');
    registerTouchEvents();
  });
  
  // Export für executeJavaScript Injection vom Main Process
  // Nach Navigation kann der Main Process diese Funktion aufrufen um Touch-Events
  // im neuen document-Kontext neu zu registrieren
  // 
  // WICHTIG: Da contextIsolation=true ist, läuft der Preload in einem isolierten Kontext.
  // executeJavaScript läuft im Main World und sieht ein anderes window-Objekt.
  // Deshalb müssen wir contextBridge verwenden um die Funktion zu exponieren.
  const reRegisterTouchEvents = function() {
    console.log('[ContentPreload] __registerCssZoomTouchEvents called from main process');
    // Force re-registration by clearing the flag on current document
    if (document._touchEventsRegistered) {
      console.log('[ContentPreload] Clearing old touch registration flag');
      delete document._touchEventsRegistered;
    }
    registerTouchEvents();
  };
  
  // Also set on window for direct access within preload context
  window.__registerCssZoomTouchEvents = reRegisterTouchEvents;
  
  // Expose to main world via contextBridge so executeJavaScript can call it
  try {
    contextBridge.exposeInMainWorld('cssZoomBridge', {
      reRegisterTouchEvents: reRegisterTouchEvents
    });
    console.log('[ContentPreload] contextBridge exposed cssZoomBridge.reRegisterTouchEvents');
  } catch (e) {
    console.warn('[ContentPreload] contextBridge failed:', e);
  }

  // macOS Gesture-Events
  window.addEventListener('gesturechange', (e) => {
    try {
      // Bei Visual Zoom: Events durchlassen für nativen Browser-Zoom
      if (visualZoomEnabled) return;
      
      e.preventDefault();
      const scale = typeof e.scale === 'number' ? e.scale : 1;
      const newFactor = zoomLevelToFactor(zoomLevel) * scale;
      applyZoom(factorToZoomLevel(newFactor), { notify: true });
    } catch {}
  }, { passive: false });

  // Arrow key navigation - send to parent via webContents
  // This allows left/right arrow keys to navigate articles even when focus is on webcontentsview
  // Smooth keyboard scrolling state
  let scrollDirection = 0; // -1 = up, 0 = stopped, 1 = down
  let scrollAnimationFrame = null;
  const scrollSpeed = 8; // pixels per frame (~480px/sec at 60fps)
  
  function smoothScroll() {
    if (scrollDirection === 0) {
      scrollAnimationFrame = null;
      return;
    }
    
    // In Visual Zoom mode (Device Emulation), use native window scrolling
    // Otherwise use the zoom container
    if (visualZoomEnabled) {
      window.scrollBy(0, scrollSpeed * scrollDirection);
    } else {
      const container = document.getElementById('fr-zoom-container') || document.body;
      container.scrollTop += scrollSpeed * scrollDirection;
    }
    scrollAnimationFrame = requestAnimationFrame(smoothScroll);
  }
  
  // Image gallery navigation - jump between images with Space/Shift+Space
  let currentImageIndex = -1;
  
  function getVisibleImages() {
    const container = document.getElementById('fr-zoom-container') || document.body;
    const images = Array.from(container.querySelectorAll('img'));
    // Filter out tiny images (icons, trackers) - only include substantial images
    return images.filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.width > 100 && rect.height > 50;
    });
  }
  
  // Find a heading element (h1-h6) that precedes the image in the same container
  // or as a previous sibling of the image's container (e.g., figure)
  function findHeadingForImage(img) {
    // Strategy 1: Check for previous sibling headings of parent elements
    // This handles: <h2>Title</h2><figure><img></figure>
    let element = img.parentElement;
    let depth = 0;
    const maxDepth = 5;
    
    while (element && depth < maxDepth) {
      // Check previous siblings for a heading
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (/^H[1-6]$/.test(sibling.tagName)) {
          return sibling;
        }
        sibling = sibling.previousElementSibling;
      }
      element = element.parentElement;
      depth++;
    }
    
    // Strategy 2: Check for heading inside the same container
    // This handles: <div><h2>Title</h2><p><img></p></div>
    let container = img.parentElement;
    depth = 0;
    
    while (container && depth < maxDepth) {
      const heading = container.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) {
        // Make sure the heading comes before the image in document order
        const headingPos = heading.compareDocumentPosition(img);
        if (headingPos & Node.DOCUMENT_POSITION_FOLLOWING) {
          return heading;
        }
      }
      container = container.parentElement;
      depth++;
    }
    
    return null;
  }
  
  // Helper to get scroll container and scroll position based on mode
  function getScrollContext() {
    if (visualZoomEnabled) {
      // In Visual Zoom mode, use native window scrolling
      return {
        container: document.documentElement,
        scrollTop: window.scrollY,
        viewportHeight: window.innerHeight,
        scrollTo: (top) => window.scrollTo({ top, behavior: 'smooth' }),
        scrollBy: (amount) => window.scrollBy({ top: amount, behavior: 'smooth' })
      };
    } else {
      // In CSS zoom mode, use the zoom container
      const container = document.getElementById('fr-zoom-container') || document.body;
      return {
        container,
        scrollTop: container.scrollTop,
        viewportHeight: container.getBoundingClientRect().height,
        scrollTo: (top) => container.scrollTo({ top, behavior: 'smooth' }),
        scrollBy: (amount) => container.scrollBy({ top: amount, behavior: 'smooth' })
      };
    }
  }
  
  // Fallback: Scroll by page with overlap (like Page Down/Up but smoother)
  function scrollByPage(direction) {
    const ctx = getScrollContext();
    // Keep 20% overlap to maintain reading context
    const scrollAmount = ctx.viewportHeight * 0.8 * direction;
    ctx.scrollBy(scrollAmount);
  }
  
  // Check if an image extends beyond the viewport bottom
  function getImageOverflow(img, viewportTop, viewportHeight) {
    const imgTop = img.offsetTop;
    const imgBottom = imgTop + img.offsetHeight;
    const viewportBottom = viewportTop + viewportHeight;
    
    // Image is currently visible (at least partially in viewport)
    const isVisible = imgTop < viewportBottom && imgBottom > viewportTop;
    // Image extends below viewport
    const overflowsBottom = imgBottom > viewportBottom;
    // How much of the image is below the viewport
    const overflowAmount = imgBottom - viewportBottom;
    
    return { isVisible, overflowsBottom, overflowAmount, imgTop, imgBottom };
  }
  
  function scrollToImage(direction) {
    const images = getVisibleImages();
    
    // If no substantial images, use page scrolling with overlap
    if (images.length === 0) {
      scrollByPage(direction);
      return true;
    }
    
    const ctx = getScrollContext();
    const viewportTop = ctx.scrollTop;
    const viewportHeight = ctx.viewportHeight;
    // Threshold: image/heading must be at least this far into viewport to be "current"
    const visibilityThreshold = viewportHeight * 0.15; // 15% of viewport height
    
    // For each image, get its scroll target (heading or image itself)
    const targets = images.map(img => {
      const heading = findHeadingForImage(img);
      return { img, target: heading || img };
    });
    
    if (direction > 0) {
      // Forward navigation (Space)
      
      // First, check if any currently visible image overflows the viewport
      // If so, scroll to show more of that image instead of jumping to the next one
      for (let i = 0; i < images.length; i++) {
        const overflow = getImageOverflow(images[i], viewportTop, viewportHeight);
        
        if (overflow.isVisible && overflow.overflowsBottom) {
          // This image is visible but extends below viewport
          // Scroll by page to show more of it (with overlap for context)
          const scrollAmount = Math.min(
            overflow.overflowAmount + viewportHeight * 0.1, // Show rest of image + small margin
            viewportHeight * 0.8 // But not more than 80% of viewport
          );
          ctx.scrollBy(scrollAmount);
          return true;
        }
      }
      
      // No overflowing image - find next image/heading to scroll to
      for (let i = 0; i < targets.length; i++) {
        const targetTop = targets[i].target.offsetTop;
        if (targetTop > viewportTop + visibilityThreshold) {
          // This image's heading/target is not yet in view - scroll to it
          targets[i].target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          currentImageIndex = i;
          return true;
        }
      }
      // All images are above threshold - continue with page scroll
      scrollByPage(direction);
      return true;
    } else {
      // Backward navigation (Shift+Space)
      
      // Check if any currently visible image overflows the top of viewport
      // (meaning we scrolled past its top, but it's still partially visible)
      for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        const imgTop = img.offsetTop;
        const imgBottom = imgTop + img.offsetHeight;
        
        // Image is visible and its top is above the viewport
        const topIsAbove = imgTop < viewportTop;
        const isStillVisible = imgBottom > viewportTop + visibilityThreshold;
        
        if (topIsAbove && isStillVisible) {
          // We're in the middle of a tall image - scroll up to show its top
          const scrollAmount = viewportTop - imgTop;
          // But scroll by at least 80% of viewport for good navigation
          const actualScroll = Math.max(scrollAmount, viewportHeight * 0.8);
          ctx.scrollBy(-Math.min(actualScroll, viewportTop)); // Don't scroll past top
          return true;
        }
      }
      
      // Find the previous image/target to scroll to
      let currentIndex = -1;
      for (let i = 0; i < targets.length; i++) {
        const targetTop = targets[i].target.offsetTop;
        // If this target is at or near the current scroll position, it's the "current" one
        if (targetTop >= viewportTop - 50 && targetTop <= viewportTop + visibilityThreshold) {
          currentIndex = i;
          break;
        }
        // If this target is below our current position, the previous one was "current"
        if (targetTop > viewportTop + visibilityThreshold) {
          currentIndex = i - 1;
          break;
        }
      }
      
      // If we found a current index, go to the previous one
      if (currentIndex > 0) {
        targets[currentIndex - 1].target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        currentImageIndex = currentIndex - 1;
        return true;
      } else if (currentIndex === 0) {
        // Already at first image, scroll to top
        ctx.scrollTo(0);
        return true;
      } else {
        // No current index found - find the last target that is above viewport
        for (let i = targets.length - 1; i >= 0; i--) {
          const targetTop = targets[i].target.offsetTop;
          if (targetTop < viewportTop - 10) {
            targets[i].target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            currentImageIndex = i;
            return true;
          }
        }
      }
      // No image above - use page scroll to go up
      scrollByPage(direction);
      return true;
    }
  }
  
  window.addEventListener('keydown', (e) => {
    // Skip navigation shortcuts in input mode (for login forms etc.)
    if (inputModeEnabled) return;
    
    // Note: ArrowLeft/Right for article navigation handled via keyboard events in ContentViewManager
    
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Handle up/down arrow scrolling with smooth continuous animation
      e.preventDefault();
      const newDirection = e.key === 'ArrowUp' ? -1 : 1;
      if (scrollDirection !== newDirection) {
        scrollDirection = newDirection;
        if (!scrollAnimationFrame) {
          scrollAnimationFrame = requestAnimationFrame(smoothScroll);
        }
      }
    } else if (e.key === ' ' || e.key === 'Spacebar') {
      // Space = next image, Shift+Space = previous image
      e.preventDefault();
      const direction = e.shiftKey ? -1 : 1;
      scrollToImage(direction);
    }
  });
  
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      scrollDirection = 0; // Stop scrolling when key released
    }
  });

  // ============================================
  // Site-specific cleanup for normal web browsing
  // ============================================
  
  const siteTransformations = [
    {
      // Reddit: Entferne NSFW-Dialoge, App-Promo, QR-Codes, Modals, Cookie-Banner
      patterns: [/reddit\.com/],
      cleanup: () => {
        // NSFW/18+ Blocking Modals und Dialoge
        document.querySelectorAll('faceplate-modal, faceplate-dialog').forEach(el => el.remove());
        document.querySelectorAll('#nsfw-qr-dialog, #blocking-modal').forEach(el => el.remove());
        
        // NSFW Blocking Container - Shadow DOM manipulieren
        document.querySelectorAll('xpromo-nsfw-blocking-container').forEach(container => {
          // "In App anzeigen" Buttons im Light DOM entfernen
          container.querySelectorAll('.viewInApp, a[slot="view-in-app-button"]').forEach(el => el.remove());
          
          // Shadow DOM: Prompt ("18+ Inhalt" Text) verstecken
          if (container.shadowRoot) {
            const prompt = container.shadowRoot.querySelector('.prompt');
            if (prompt) prompt.style.display = 'none';
          }
        });
        
        // Blurred container für NSFW - Shadow DOM manipulieren
        document.querySelectorAll('shreddit-blurred-container').forEach(el => {
          el.removeAttribute('blurred');
          el.setAttribute('mode', 'revealed');
          
          // Shadow DOM: Overlay und Blur entfernen
          if (el.shadowRoot) {
            // "18+ Inhalte anzeigen" Button/Overlay verstecken
            const overlay = el.shadowRoot.querySelector('.overlay');
            if (overlay) overlay.style.display = 'none';
            
            // Blur-Filter entfernen - alle möglichen Selektoren
            el.shadowRoot.querySelectorAll('.inner.blurred, .blurred, [class*="blur"]').forEach(blurredEl => {
              blurredEl.style.filter = 'none';
              blurredEl.style.webkitFilter = 'none';
              blurredEl.classList.remove('blurred');
            });
            
            // Auch .inner direkt behandeln (falls ohne .blurred Klasse)
            const inner = el.shadowRoot.querySelector('.inner');
            if (inner) {
              inner.style.filter = 'none';
              inner.style.webkitFilter = 'none';
            }
            
            // Scrim (dunkles Overlay) entfernen
            el.shadowRoot.querySelectorAll('.bg-scrim, .scrim, [class*="scrim"]').forEach(scrim => {
              scrim.style.display = 'none';
            });
          }
          
          // Light DOM: Zeige revealed slot, verstecke blurred slot
          const revealed = el.querySelector('[slot="revealed"]');
          const blurred = el.querySelector('[slot="blurred"]');
          if (revealed) {
            revealed.style.display = 'block';
            revealed.style.visibility = 'visible';
          }
          if (blurred) {
            blurred.style.display = 'none';
          }
          
          // Auch direkte Kinder mit Blur behandeln
          el.querySelectorAll('[style*="blur"], [style*="filter"]').forEach(child => {
            child.style.filter = 'none';
            child.style.webkitFilter = 'none';
          });
        });
        
        // Modal-Wrapper mit Dialog-Rolle entfernen (App-Promo, Login-Prompts)
        document.querySelectorAll('#wrapper[role="dialog"][aria-modal="true"]').forEach(el => el.remove());
        
        // App-Download Banner und Prompts
        document.querySelectorAll('[data-testid="xpromo-nsfw-blocking-modal"]').forEach(el => el.remove());
        document.querySelectorAll('[data-testid="xpromo-app-selector"]').forEach(el => el.remove());
        document.querySelectorAll('.XPromoPopupRpl, .XPromoBlockingModal').forEach(el => el.remove());
        
        // Weitere störende Elemente
        document.querySelectorAll('[class*="bottom-sheet"]').forEach(el => el.remove());
        document.querySelectorAll('[class*="overlay-container"]').forEach(el => el.remove());
        
        // Scrim/Backdrop entfernen (graue Overlay)
        document.querySelectorAll('[class*="scrim"]').forEach(el => el.remove());
        document.querySelectorAll('[class*="backdrop"]').forEach(el => el.remove());
        
        // Body scroll wieder aktivieren falls blockiert
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    }
  ];

  // Track if cleanup is complete (no more blocking elements found)
  let cleanupComplete = false;

  function applySiteCleanup() {
    const url = window.location.href;
    let foundBlockingElements = false;
    
    siteTransformations.forEach(transform => {
      if (transform.patterns.some(pattern => pattern.test(url))) {
        try {
          // Check if Reddit blocking elements exist before cleanup
          if (/reddit\.com/.test(url)) {
            // NSFW-Elemente
            const nsfwContainer = document.querySelector('xpromo-nsfw-blocking-container');
            const blurredContainer = document.querySelector('shreddit-blurred-container[blurred]');
            const nsfwPrompt = nsfwContainer?.shadowRoot?.querySelector('.prompt');
            const blurFilter = document.querySelector('shreddit-blurred-container')?.shadowRoot?.querySelector('.inner.blurred');
            
            if (nsfwContainer || blurredContainer || nsfwPrompt || blurFilter) {
              foundBlockingElements = true;
            }
          }
          
          transform.cleanup();
          
          // Mark cleanup as complete if we found and processed blocking elements
          if (foundBlockingElements) {
            cleanupComplete = true;
          }
        } catch (e) {
          console.error('[ContentPreload] Site cleanup failed:', e);
        }
      }
    });
    
    return cleanupComplete;
  }

  // Check if any site transformation matches current URL
  function hasSiteTransformations() {
    const url = window.location.href;
    return siteTransformations.some(t => t.patterns.some(p => p.test(url)));
  }

  // ============================================
  // Auto Cookie-Consent - Separate Feature
  // ============================================
  
  const cookieConsentPatterns = [
    {
      // Reddit Cookie-Consent
      patterns: [/reddit\.com/],
      consent: () => {
        // Cookie/Consent/Datenschutz Banner - versuche "Ablehnen" zu klicken
        const cookieDialog = document.querySelector('#data-protection-consent-dialog');
        if (cookieDialog) {
          // Suche nach "Ablehnen" Button (secondary-button Slot)
          const rejectButton = cookieDialog.querySelector('[slot="secondary-button"]') ||
                               cookieDialog.querySelector('button[data-testid="reject-nonessential-cookies-button"]');
          if (rejectButton) {
            rejectButton.click();
            console.log('[ContentPreload] Cookie-Consent: Clicked Reddit reject button');
            return true;
          } else {
            // Fallback: Dialog entfernen wenn kein Button gefunden
            cookieDialog.remove();
            console.log('[ContentPreload] Cookie-Consent: Removed Reddit cookie dialog (no button found)');
            return true;
          }
        }
        
        // Weitere Cookie-Banner
        let handled = false;
        document.querySelectorAll('[data-testid="cookie-policy-banner"]').forEach(el => { el.remove(); handled = true; });
        document.querySelectorAll('shreddit-cookie-banner').forEach(el => { el.remove(); handled = true; });
        
        return handled;
      }
    },
    // Hier können weitere Seiten hinzugefügt werden:
    // {
    //   patterns: [/example\.com/],
    //   consent: () => { /* ... */ return true; }
    // }
  ];

  let cookieConsentComplete = false;

  function applyCookieConsent() {
    const url = window.location.href;
    let handled = false;
    
    cookieConsentPatterns.forEach(pattern => {
      if (pattern.patterns.some(p => p.test(url))) {
        try {
          if (pattern.consent()) {
            handled = true;
          }
        } catch (e) {
          console.error('[ContentPreload] Cookie-Consent failed:', e);
        }
      }
    });
    
    if (handled) {
      cookieConsentComplete = true;
    }
    
    return cookieConsentComplete;
  }

  function hasCookieConsentPatterns() {
    const url = window.location.href;
    return cookieConsentPatterns.some(p => p.patterns.some(pat => pat.test(url)));
  }

  let cookieConsentObserver = null;
  let cookieConsentStarted = false;

  function startCookieConsent() {
    if (cookieConsentStarted || !hasCookieConsentPatterns()) return;
    cookieConsentStarted = true;
    
    console.log('[ContentPreload] Starting Auto Cookie-Consent');
    
    // Initial consent handling
    applyCookieConsent();
    
    // MutationObserver for delayed cookie banners
    let debounceTimer = null;
    
    cookieConsentObserver = new MutationObserver((mutations) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const done = applyCookieConsent();
        
        if (done && cookieConsentObserver) {
          cookieConsentObserver.disconnect();
          cookieConsentObserver = null;
          console.log('[ContentPreload] Cookie-Consent complete, observer stopped');
          showOverlayMessage('Cookie-Consent erledigt', 1500);
        }
      }, 100);
    });

    if (document.body) {
      cookieConsentObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    // Fallback: Stop observer after 30 seconds
    setTimeout(() => {
      if (cookieConsentObserver) {
        cookieConsentObserver.disconnect();
        cookieConsentObserver = null;
      }
    }, 30000);
  }

  // Observer und Cleanup werden erst gestartet wenn NSFW-Cleanup aktiviert ist
  let siteCleanupObserver = null;
  let siteCleanupStarted = false;

  function startSiteCleanup() {
    if (siteCleanupStarted || !hasSiteTransformations()) return;
    siteCleanupStarted = true;
    
    console.log('[ContentPreload] Starting site cleanup');
    
    // Initial cleanup
    applySiteCleanup();
    
    // MutationObserver for immediate reaction to new elements
    let debounceTimer = null;
    
    siteCleanupObserver = new MutationObserver((mutations) => {
      // Debounce to avoid too many calls
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const cleanupDone = applySiteCleanup();
        
        // Stop observer once cleanup is complete
        if (cleanupDone && siteCleanupObserver) {
          siteCleanupObserver.disconnect();
          siteCleanupObserver = null;
          console.log('[ContentPreload] Site cleanup complete, observer stopped');
          showOverlayMessage('Site-Cleanup abgeschlossen', 2000);
        }
      }, 50);
    });

    // Start observing
    if (document.body) {
      siteCleanupObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['blurred', 'class', 'style']
      });
    }

    // Fallback: Stop observer after 60 seconds if cleanup never completed
    setTimeout(() => {
      if (siteCleanupObserver) {
        siteCleanupObserver.disconnect();
        siteCleanupObserver = null;
      }
    }, 60000);
  }

  // Cleanup automatisch starten wenn aktiviert (Einstellung wurde oben synchron geladen)
  if (nsfwCleanupEnabled && hasSiteTransformations()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startSiteCleanup);
    } else {
      startSiteCleanup();
    }
  }

  // Auto Cookie-Consent automatisch starten wenn aktiviert
  if (autoCookieConsentEnabled && hasCookieConsentPatterns()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startCookieConsent);
    } else {
      startCookieConsent();
    }
  }

} catch {
  // Fehlerbehandlung: Stille Fehlerignorierung
}