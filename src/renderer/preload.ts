import { contextBridge, webFrame } from 'electron';

// Haupt-Renderer (App UI) NICHT zoomen
try {
  webFrame.setVisualZoomLevelLimits(1, 1);
} catch {
  // ignore on unsupported electron versions
}

contextBridge.exposeInMainWorld('presentationZoom', {
  setLimits: (min: number, max: number) => {
    try { webFrame.setVisualZoomLevelLimits(min, max); } catch {}
  },
  setFactor: (f: number) => {
    try { webFrame.setZoomFactor(f); } catch {}
  },
});