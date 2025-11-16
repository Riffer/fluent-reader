// Preload für <webview> Inhalten: sorgt dafür, dass Pinch auch in Webviews funktioniert
const { webFrame } = require('electron');

try {
  webFrame.setVisualZoomLevelLimits(1, 3);
} catch {
  // ignore
}

// Optional: expose minimal API falls Webview-Inhalte kontrolliert werden sollen
try {
  const { contextBridge } = require('electron');
  contextBridge.exposeInMainWorld('presentationZoom', {
    setLimits: (min: number, max: number) => {
      try { webFrame.setVisualZoomLevelLimits(min, max); } catch {}
    },
    setFactor: (f: number) => {
      try { webFrame.setZoomFactor(f); } catch {}
    },
  });
} catch {
  // if contextBridge not available, ignore
}