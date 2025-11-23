// Preload für Webviews: Echter Zoom via CSS-Transform (Chrome-ähnlich)
// Die gesamte Seite wird skaliert, nicht nur optisch verkleinert
try {
  const { ipcRenderer } = require('electron');

  let zoomLevel = 0; // zoomLevel: 0 = 100%, 1 = 110%, -1 = 90%, etc.
  const MIN_ZOOM_LEVEL = -8;  // ~0.4x (40%) - minimum zoom
  const MAX_ZOOM_LEVEL = 17;  // ~5x (500%) - maximum zoom

  // Konvertierung: zoomLevel -> Faktor
  function zoomLevelToFactor(level) {
    return Math.pow(1.1, level);
  }

  // Konvertierung: Faktor -> zoomLevel (OHNE Runden für smoothen Touch-Zoom)
  function factorToZoomLevel(factor) {
    return Math.log(factor) / Math.log(1.1);
  }

  // Erstelle Zoom-Container der gesamte Seite enthält
  function ensureZoomContainer() {
    let wrapper = document.getElementById('fr-zoom-wrapper');
    if (!wrapper) {
      // Erstelle Wrapper als scrollbarer Container
      wrapper = document.createElement('div');
      wrapper.id = 'fr-zoom-wrapper';
      wrapper.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        overflow: auto;
        z-index: 0;
        margin: 0;
        padding: 0;
      `;
      
      // Erstelle inneren Container für Transform
      let container = document.createElement('div');
      container.id = 'fr-zoom-container';
      container.style.cssText = `
        transform-origin: top left;
        transition: none;
        will-change: transform;
        margin: 0;
        padding: 0;
        display: inline-block;
        width: auto;
        white-space: pre-wrap;
        word-wrap: break-word;
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
        #fr-zoom-wrapper {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
        }
        #fr-zoom-wrapper::-webkit-scrollbar {
          width: 8px;
          height: 0px;
        }
        #fr-zoom-wrapper::-webkit-scrollbar-track {
          background: transparent;
        }
        #fr-zoom-wrapper::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.3);
          border-radius: 4px;
        }
        #fr-zoom-wrapper::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.5);
        }
      `;
      document.head.appendChild(style);
    }
    return wrapper.querySelector('#fr-zoom-container');
  }

  // Wende Zoom auf Container an
  function applyZoom(newZoomLevel, options = { notify: true }) {
    zoomLevel = Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, newZoomLevel));
    const factor = zoomLevelToFactor(zoomLevel);
    
    // Stelle sicher, dass der Container existiert
    const container = ensureZoomContainer();
    
    // Wende Transform an
    container.style.transform = `scale(${factor})`;
    
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

  // Listener für externe Zoom-Befehle
  ipcRenderer.on('set-webview-zoom', (event, zoomLevel_) => {
    zoomLevel = zoomLevel_;
    applyZoom(zoomLevel, { notify: false });
  });

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

  // Ctrl+Wheel Zoom (Touchpad)
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY;
        // Feinere Kontrolle für Touchpad: 1/3 der Geschwindigkeit
        const steps = (delta > 0 ? 1 : -1) / 3;
        applyZoom(zoomLevel + steps, { notify: true });
      }
    } catch {}
  }, { passive: false });

  // Touch Pinch-Zoom
  let lastDistance = 0;
  let touchStartZoomLevel = zoomLevel;

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
        applyZoom(factorToZoomLevel(newFactor), { notify: true });
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

} catch {
  // Fehlerbehandlung: Stille Fehlerignorierung
}