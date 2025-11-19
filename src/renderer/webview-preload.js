// Preload für Webviews: Echter Zoom via CSS-Transform (Chrome-ähnlich)
try {
  const { ipcRenderer } = require('electron');

  let zoomLevel = 0; // zoomLevel: 0 = 100%, 1 = 110%, -1 = 90%, etc.
  const MIN_ZOOM_LEVEL = 0;  // 1.0x (100%) - Zoom startet bei 1
  const MAX_ZOOM_LEVEL = 17; // ~5x (500%)

  // Konvertierung: zoomLevel -> Faktor
  function zoomLevelToFactor(level) {
    return Math.pow(1.1, level);
  }

  // Konvertierung: Faktor -> zoomLevel
  function factorToZoomLevel(factor) {
    return Math.log(factor) / Math.log(1.1);
  }

  // Hilfsfunktion: Erstelle Wrapper für den Zoom (separater Scroll-Container)
  function ensureZoomContainer() {
    let wrapper = document.getElementById('fr-zoom-wrapper');
    if (!wrapper) {
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
      `;
      
      let container = document.createElement('div');
      container.id = 'fr-zoom-container';
      container.style.cssText = `
        transform-origin: top left;
        transition: none;
        will-change: transform;
      `;
      
      // Bewege den Body-Inhalt in den Container
      while (document.body.firstChild) {
        container.appendChild(document.body.firstChild);
      }
      wrapper.appendChild(container);
      document.body.appendChild(wrapper);
      
      // Stylesheet für HTML, Body und Container
      const style = document.createElement('style');
      style.id = 'fr-zoom-style';
      style.textContent = `
        html, body {
          margin: 0;
          padding: 0;
          width: 100%;
          height: 100%;
        }
        body {
          overflow: hidden;
        }
        #fr-zoom-wrapper {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          overflow: auto;
          overflow-x: hidden;
        }
        /* Verstecke nur die horizontale Scrollbar, vertikale bleibt sichtbar */
        #fr-zoom-wrapper::-webkit-scrollbar {
          width: auto;
          height: 0;
        }
        /* Firefox: Verstecke horizontale Scrollbar */
        #fr-zoom-wrapper {
          scrollbar-width: auto;
        }
        #fr-zoom-container {
          transform-origin: top left;
          will-change: transform;
          margin: 0;
          padding: 0;
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

  // Wende Zoom zentriert zur Mausposition an (Chrome-ähnlich)
  function applyZoomAt(newZoomLevel, mouseX, mouseY, options = { notify: true }) {
    const oldFactor = zoomLevelToFactor(zoomLevel);
    zoomLevel = Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, newZoomLevel));
    const newFactor = zoomLevelToFactor(zoomLevel);
    
    const container = ensureZoomContainer();
    const wrapper = container.parentElement;
    
    // Aktuelle Scrollposition vom Wrapper
    const scrollX = wrapper.scrollLeft || 0;
    const scrollY = wrapper.scrollTop || 0;
    
    // Punkt unter der Maus im ungeskalten Raum
    const docPointX = (mouseX + scrollX) / oldFactor;
    const docPointY = (mouseY + scrollY) / oldFactor;
    
    // Setze Scale
    container.style.transform = `scale(${newFactor})`;
    
    // Berechne neue Scrollposition
    const newScrollX = Math.max(0, docPointX * newFactor - mouseX);
    const newScrollY = Math.max(0, docPointY * newFactor - mouseY);
    
    // Scrollen mit requestAnimationFrame
    requestAnimationFrame(() => {
      wrapper.scrollLeft = newScrollX;
      wrapper.scrollTop = newScrollY;
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

  // Ctrl+Wheel Zoom
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY;
        // Noch schneller! (1.012 statt 1.006)
        const factor = Math.pow(1.012, delta);
        const currentFactor = zoomLevelToFactor(zoomLevel);
        const newFactor = currentFactor * factor;
        applyZoomAt(factorToZoomLevel(newFactor), e.clientX, e.clientY, { notify: true });
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
        const startFactor = zoomLevelToFactor(touchStartZoomLevel);
        const newFactor = startFactor * scale;
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
      const currentFactor = zoomLevelToFactor(zoomLevel);
      const newFactor = currentFactor * scale;
      applyZoom(factorToZoomLevel(newFactor), { notify: true });
    } catch {}
  }, { passive: false });

} catch {
  // Fehlerbehandlung
}