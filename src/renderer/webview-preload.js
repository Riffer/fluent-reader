// Preload für Webviews: Pinch / Ctrl+Wheel Zoom nur für den Webview-Inhalt
try {
  const { webFrame, ipcRenderer } = require('electron');

  let zoom = 1;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3.0;

  // Image-Zoom (Strg+Pinch/Strg+Wheel): nur Hauptbild skalieren
  let imageZoom = 1;
  const MIN_IMAGE_ZOOM = 0.5;
  const MAX_IMAGE_ZOOM = 3.0;
  let mainImages = []; // Array statt einzelnes Bild
  let imageZoomStyle = null;
  const IMAGE_SIZE_TOLERANCE = 0.85; // 85% der max-Größe werden als "gleich groß" behandelt

  // Hilfsfunktion zum Anwenden und Speichern des Zoom-Levels
  function applyZoom(newZoom, options = { notify: true }) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    try { 
      webFrame.setZoomFactor(zoom); 
      // Zoom-Level an Hauptprozess senden für Persistierung (nur bei User-Gesten)
      if (options.notify) {
        try { ipcRenderer.send('webview-zoom-changed', zoom); } catch {}
        // Zusätzlich direkt an den Embedder senden (zuverlässiger für den Host-Renderer)
        try { ipcRenderer.sendToHost('webview-zoom-changed', zoom); } catch {}
      }
    } catch {}
  }

  // Hilfsfunktion: gerenderte Größe des Bildes ermitteln (BoundingClientRect = das was der User sieht)
  function getRenderedSize(img) {
    const rect = img.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      area: rect.width * rect.height
    };
  }

  // Hauptbild(er) erkennen (Heuristik: größte Bilder + ähnlich große Bilder)
  function findMainImages() {
    const images = Array.from(document.querySelectorAll('img')).filter(img => {
      if (!img.offsetParent) return false; // unsichtbar
      const rect = img.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) return false; // zu klein
      const parent = img.closest('header, footer, nav');
      if (parent) return false; // in Navigation/Header/Footer
      return true;
    });
    if (!images.length) return [];
    
    // Größtes Bild nach GERENDETER Größe finden (was der User sieht)
    const maxImage = images.reduce((max, img) => {
      const maxSize = getRenderedSize(max);
      const imgSize = getRenderedSize(img);
      return imgSize.area > maxSize.area ? img : max;
    });
    
    const maxSize = getRenderedSize(maxImage);
    const minArea = maxSize.area * IMAGE_SIZE_TOLERANCE;
    
    // Alle Bilder mit ähnlich großer gerendeter Größe sammeln
    const result = images.filter(img => {
      const size = getRenderedSize(img);
      return size.area >= minArea;
    });
    
    return result;
  }

  // Findet die direkten Container (tr, td, div, etc.) der Hauptbilder
  function findImageContainers() {
    const containers = new Set();
    mainImages.forEach(img => {
      // Suche den nächsten aussagekräftigen Container: tr, td, div (aber nicht body/html)
      let parent = img.parentElement;
      let depth = 0;
      while (parent && parent !== document.body && depth < 5) {
        if (parent.tagName.match(/^(TR|TD|TH|DIV|FIGURE|ARTICLE|SECTION)$/i)) {
          containers.add(parent);
          break;
        }
        parent = parent.parentElement;
        depth++;
      }
    });
    return Array.from(containers);
  }

  // Image-Zoom anwenden (CSS-basiert, width-basiert statt transform-scale)
  function applyImageZoom(newImageZoom, options = { notify: true }) {
    imageZoom = Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, newImageZoom));
    
    // Hauptbilder suchen/aktualisieren
    if (!mainImages || mainImages.length === 0) {
      mainImages = findMainImages();
    }
    
    if (mainImages && mainImages.length > 0) {
      // Stylesheet einmalig erstellen/finden
      if (!imageZoomStyle) {
        imageZoomStyle = document.createElement('style');
        imageZoomStyle.id = 'fr-image-zoom-style';
        document.head.appendChild(imageZoomStyle);
      }
      
      // Alle Bilder mit eindeutigem Marker markieren (falls nicht)
      mainImages.forEach(img => {
        if (!img.dataset.frMainImage) {
          img.dataset.frMainImage = 'true';
        }
      });
      
      // CSS Rule: Bilder durch width-Anpassung skalieren (beeinflusst den Layout-Flow)
      imageZoomStyle.textContent = `
        img[data-fr-main-image="true"] {
          display: block;
          width: ${100 * imageZoom}% !important;
          height: auto !important;
          max-width: none !important;
          margin-left: auto;
          margin-right: auto;
        }
      `;
      
      if (options.notify) {
        try { ipcRenderer.sendToHost('webview-image-zoom-changed', imageZoom); } catch {}
      }
    }
  }

  // Initial setzen
  // WICHTIG: initial nicht melden, sonst wird ein gespeichertes Zoom auf 1 überschrieben
  applyZoom(zoom, { notify: false });

  // Listener für Zoom-Änderungen vom Hauptprozess (z.B. beim Laden)
  ipcRenderer.on('set-webview-zoom', (event, zoomLevel) => {
    zoom = zoomLevel;
    // Vom Host gesetzte Werte nicht zurückmelden, um Schleifen/Duplikate zu vermeiden
    applyZoom(zoom, { notify: false });
  });

  // Fallback: Nachrichten vom Embedder via postMessage akzeptieren
  window.addEventListener('message', (event) => {
    try {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'set-webview-zoom' && typeof data.zoom === 'number') {
        zoom = data.zoom;
        applyZoom(zoom, { notify: false });
      }
      if (data.type === 'set-image-zoom' && typeof data.zoom === 'number') {
        imageZoom = data.zoom;
        applyImageZoom(imageZoom, { notify: false });
      }
    } catch {}
  });

  // Ctrl+Wheel Zoom (Maus und Touchpad)
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY;
        const factor = Math.pow(1.003, delta);
        // Strg+Wheel: Image-Zoom
        applyImageZoom(imageZoom * factor, { notify: true });
      }
    } catch {}
  }, { passive: false });

  // Touch Pinch-Zoom (für Windows-Touchscreens)
  let lastDistance = 0;
  let touchStartZoom = zoom;

  window.addEventListener('touchstart', (e) => {
    try {
      if (e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        lastDistance = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        // Merke: ist es eine Strg-Taste gedrückt? Leider per Touch nicht erkennbar.
        // Wir nutzen: wenn Meta (CMD) gedrückt ist, dann Image-Zoom, sonst Page-Zoom.
        // Fallback: immer Page-Zoom bei Touch, Image-Zoom nur per Strg+Wheel
        touchStartZoom = zoom;
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
        applyZoom(touchStartZoom * scale, { notify: true });
      }
    } catch {}
  }, { passive: false });

  window.addEventListener('touchend', () => {
    lastDistance = 0;
  });

  // Fallback: Gesture-Events (macOS)
  window.addEventListener('gesturechange', (e) => {
    try {
      e.preventDefault();
      const scale = typeof e.scale === 'number' ? e.scale : 1;
      applyZoom(zoom * scale, { notify: true });
    } catch {}
  }, { passive: false });

} catch {
  // Fehlerbehandlung
}