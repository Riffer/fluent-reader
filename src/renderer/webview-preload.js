// Preload für Webviews: Pinch / Ctrl+Wheel Zoom nur für den Webview-Inhalt
try {
  const { webFrame } = require('electron');

  let zoom = 1;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 3.0;

  // Initial setzen
  try { webFrame.setZoomFactor(zoom); } catch {}

  // Ctrl+Wheel Zoom (Maus und Touchpad)
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = -e.deltaY;
        //const factor = Math.pow(1.0015, delta);
        const factor = Math.pow(1.004, delta);  // ← Von 1.0015 zu 1.003 (doppelte Schrittweite)
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
        webFrame.setZoomFactor(zoom);
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
        zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, touchStartZoom * scale));
        webFrame.setZoomFactor(zoom);
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
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * scale));
      webFrame.setZoomFactor(zoom);
    } catch {}
  }, { passive: false });
} catch {
  // Wenn preload kein electron/webFrame hat — nichts tun
}