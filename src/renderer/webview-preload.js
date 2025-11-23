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

  // Wende Zoom auf Container an - verankert am aktuellen Viewport-Center
  function applyZoom(newZoomLevel, options = { notify: true }) {
    // Stelle sicher, dass der Container existiert
    const container = ensureZoomContainer();
    const wrapper = container.parentElement;
    
    if (!wrapper) return;
    
    const oldFactor = zoomLevelToFactor(zoomLevel);
    zoomLevel = Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, newZoomLevel));
    const newFactor = zoomLevelToFactor(zoomLevel);
    
    // Hole die ursprüngliche Scroll-Position des inneren Body-Content
    const innerContent = container.querySelector('body') || container.firstChild;
    const viewportCenterX = (container.scrollLeft || 0) + wrapper.clientWidth / 2;
    const viewportCenterY = (container.scrollTop || 0) + wrapper.clientHeight / 2;
    
    // Position im ungeskalten Raum
    const docCenterX = viewportCenterX / oldFactor;
    const docCenterY = viewportCenterY / oldFactor;
    
    // Berechne neue Container-Größe basierend auf Skalierung
    const newContainerWidth = wrapper.clientWidth / newFactor;
    const newContainerHeight = wrapper.clientHeight / newFactor;
    
    // Setze Container-Größe und Scroll-Overflow
    container.style.width = newContainerWidth + 'px';
    container.style.height = newContainerHeight + 'px';
    container.style.overflow = 'auto';
    
    // Wende Scale an
    container.style.transform = `scale(${newFactor})`;
    
    // Berechne neue Scroll-Position, um die Viewport-Mitte beizubehalten
    requestAnimationFrame(() => {
      const newScrollX = Math.max(0, docCenterX * newFactor - wrapper.clientWidth / 2);
      const newScrollY = Math.max(0, docCenterY * newFactor - wrapper.clientHeight / 2);
      container.scrollLeft = newScrollX / newFactor;
      container.scrollTop = newScrollY / newFactor;
    });
    
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