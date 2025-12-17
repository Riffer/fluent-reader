// Preload für Webviews: Echter Zoom via CSS-Transform (Chrome-ähnlich)
// Die gesamte Seite wird skaliert, nicht nur optisch verkleinert
try {
  const { ipcRenderer } = require('electron');

  let zoomLevel = 0; // zoomLevel: 0 = 100%, 1 = 110%, -1 = 90%, etc. (lineare 10%-Schritte)
  const MIN_ZOOM_LEVEL = -6;  // 40% minimum zoom (100% - 6*10%)
  const MAX_ZOOM_LEVEL = 40;  // 500% maximum zoom (100% + 40*10%)

  // Zoom-Overlay Einstellung (default: aus)
  let showZoomOverlayEnabled = false;
  
  // Mobile Mode Status
  let mobileMode = false;

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
      console.log('[Preload] Creating zoom container - viewport:', window.innerWidth, 'x', window.innerHeight);
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

  // Wende Zoom auf Container an - Zoom kann von einem beliebigen Punkt aus erfolgen
  function applyZoom(newZoomLevel, options = { notify: true, zoomPointX: null, zoomPointY: null, preserveScroll: true }) {
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
    
    // Sende Notification
    if (options.notify) {
      try { ipcRenderer.send('webview-zoom-changed', zoomLevel); } catch {}
      try { ipcRenderer.sendToHost('webview-zoom-changed', zoomLevel); } catch {}
    }
  }

  // Initial: Warte auf DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      applyZoom(zoomLevel, { notify: false });
    });
  } else {
    applyZoom(zoomLevel, { notify: false });
  }

  // Listener für externe Zoom-Befehle (von Keyboard - bewahre Scroll-Position)
  ipcRenderer.on('set-webview-zoom', (event, zoomLevel_) => {
    console.log('[Preload] Received set-webview-zoom:', zoomLevel_, 'viewport:', window.innerWidth, 'x', window.innerHeight);
    zoomLevel = zoomLevel_;
    applyZoom(zoomLevel, { notify: false, preserveScroll: true, zoomPointX: null, zoomPointY: null });
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
  
  // Listener für Mobile Mode Status
  ipcRenderer.on('set-mobile-mode', (event, enabled) => {
    const wasEnabled = mobileMode;
    mobileMode = !!enabled;
    console.log('[Preload] Mobile mode changed:', wasEnabled ? 'ON' : 'OFF', '->', mobileMode ? 'ON' : 'OFF');
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

  // Listener für Input Mode Status (deaktiviert Keyboard-Navigation für Login-Formulare etc.)
  let inputModeEnabled = false;
  ipcRenderer.on('set-input-mode', (event, enabled) => {
    inputModeEnabled = !!enabled;
    console.log('[Preload] Input mode changed:', inputModeEnabled ? 'ON (navigation disabled)' : 'OFF (navigation enabled)');
  });

  // NSFW-Cleanup Einstellung - synchron beim Start laden
  let nsfwCleanupEnabled = false;
  try {
    nsfwCleanupEnabled = ipcRenderer.sendSync('get-nsfw-cleanup');
    console.log('[webview-preload] NSFW-Cleanup loaded:', nsfwCleanupEnabled ? 'enabled' : 'disabled');
  } catch (e) {
    console.warn('[webview-preload] Could not load NSFW-Cleanup setting:', e);
  }

  // Auto Cookie-Consent Einstellung - synchron beim Start laden
  let autoCookieConsentEnabled = false;
  try {
    autoCookieConsentEnabled = ipcRenderer.sendSync('get-auto-cookie-consent');
    console.log('[webview-preload] Auto Cookie-Consent loaded:', autoCookieConsentEnabled ? 'enabled' : 'disabled');
  } catch (e) {
    console.warn('[webview-preload] Could not load Auto Cookie-Consent setting:', e);
  }

  // Fallback: postMessage von Embedder
  window.addEventListener('message', (event) => {
    try {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'set-webview-zoom' && typeof data.zoomLevel === 'number') {
        zoomLevel = data.zoomLevel;
        applyZoom(zoomLevel, { notify: false });
      }
    } catch {}
  });

  // Ctrl+Wheel Zoom (Touchpad) - zoomt vom Cursor aus
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
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
  let lastDistance = 0;
  let touchStartZoomLevel = zoomLevel;
  let lastTouchMidpointX = 0;
  let lastTouchMidpointY = 0;

  window.addEventListener('touchstart', (e) => {
    try {
      if (e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        lastDistance = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        touchStartZoomLevel = zoomLevel;
        
        // Berechne Mittelpunkt der beiden Finger
        lastTouchMidpointX = (touch1.clientX + touch2.clientX) / 2;
        lastTouchMidpointY = (touch1.clientY + touch2.clientY) / 2;
      }
    } catch {}
  }, { passive: false });

  window.addEventListener('touchmove', (e) => {
    try {
      if (e.touches.length === 2 && lastDistance > 0) {
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
    } catch {}
  }, { passive: false });

  window.addEventListener('touchend', () => {
    lastDistance = 0;
  });

  // macOS Gesture-Events
  window.addEventListener('gesturechange', (e) => {
    try {
      e.preventDefault();
      const scale = typeof e.scale === 'number' ? e.scale : 1;
      const newFactor = zoomLevelToFactor(zoomLevel) * scale;
      applyZoom(factorToZoomLevel(newFactor), { notify: true });
    } catch {}
  }, { passive: false });

  // Arrow key navigation - send to parent via webContents
  // This allows left/right arrow keys to navigate articles even when focus is on webview
  // Smooth keyboard scrolling state
  let scrollDirection = 0; // -1 = up, 0 = stopped, 1 = down
  let scrollAnimationFrame = null;
  const scrollSpeed = 8; // pixels per frame (~480px/sec at 60fps)
  
  function smoothScroll() {
    if (scrollDirection === 0) {
      scrollAnimationFrame = null;
      return;
    }
    const container = document.getElementById('fr-zoom-container') || document.body;
    container.scrollTop += scrollSpeed * scrollDirection;
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
  
  function scrollToImage(direction) {
    const images = getVisibleImages();
    if (images.length === 0) return false;
    
    const container = document.getElementById('fr-zoom-container') || document.body;
    const containerRect = container.getBoundingClientRect();
    const viewportTop = container.scrollTop;
    const viewportMiddle = viewportTop + containerRect.height / 2;
    
    // Find current image (the one closest to viewport top)
    let currentIdx = -1;
    for (let i = 0; i < images.length; i++) {
      const imgTop = images[i].offsetTop;
      if (imgTop >= viewportTop - 50) {
        currentIdx = i;
        break;
      }
    }
    if (currentIdx === -1) currentIdx = images.length - 1;
    
    // Calculate next image index
    let nextIdx = currentIdx + direction;
    if (nextIdx < 0) nextIdx = 0;
    if (nextIdx >= images.length) nextIdx = images.length - 1;
    
    // Only scroll if we're moving to a different image
    if (nextIdx === currentIdx && direction > 0 && currentIdx === images.length - 1) {
      return false; // Already at last image
    }
    
    // Scroll to the next image
    images[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentImageIndex = nextIdx;
    return true;
  }
  
  window.addEventListener('keydown', (e) => {
    // Skip navigation shortcuts in input mode (for login forms etc.)
    if (inputModeEnabled) return;
    
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Send message to parent window/renderer to handle navigation
      try {
        ipcRenderer.sendToHost('article-nav', {
          direction: e.key === 'ArrowLeft' ? -1 : 1
        });
        e.preventDefault();
      } catch {}
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
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
          console.error('[webview-preload] Site cleanup failed:', e);
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
            console.log('[webview-preload] Cookie-Consent: Clicked Reddit reject button');
            return true;
          } else {
            // Fallback: Dialog entfernen wenn kein Button gefunden
            cookieDialog.remove();
            console.log('[webview-preload] Cookie-Consent: Removed Reddit cookie dialog (no button found)');
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
          console.error('[webview-preload] Cookie-Consent failed:', e);
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
    
    console.log('[webview-preload] Starting Auto Cookie-Consent');
    
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
          console.log('[webview-preload] Cookie-Consent complete, observer stopped');
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
    
    console.log('[webview-preload] Starting site cleanup');
    
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
          console.log('[webview-preload] Site cleanup complete, observer stopped');
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