// Preload for ContentView: CSS-Transform-based zoom (Chrome-like)
// This script runs in the WebContentsView that displays article content.
// The entire page is scaled, not just visually zoomed.
console.log('[ContentPreload] Script loading...');
try {
  const { ipcRenderer, contextBridge } = require('electron');
  console.log('[ContentPreload] ipcRenderer loaded successfully');
  
  // Debug: Send logs to main process so they appear in terminal
  function logToMain(message) {
    console.log(message);
    try {
      ipcRenderer.send('cvp-preload-log', message);
    } catch (e) {}
  }
  logToMain('[ContentPreload] Preload script initialized');

  // ===== ContentViewPool Support =====
  // isActiveView: Only the active view should send events to the main process
  // When using ContentViewPool, multiple views exist but only one is "active"
  // Non-active views should not send keyboard, scroll, or zoom events
  let isActiveView = true;  // Default: true for backward compatibility with single-view mode
  
  // Listen for active state changes from ContentViewPool
  ipcRenderer.on('cvp-set-active-state', (event, active) => {
    isActiveView = active;
    console.log('[ContentPreload] Active state changed:', active);
  });
  
  // Helper: Only send IPC if this view is active
  function sendIfActive(channel, ...args) {
    if (isActiveView) {
      ipcRenderer.send(channel, ...args);
    }
  }

  // ===== JavaScript Dialog Interceptor =====
  // Intercept alert/confirm/prompt from article pages to prevent mysterious empty dialogs
  // and to log what the website is trying to show the user.
  // These dialogs would otherwise appear as native Electron dialogs.
  
  // Store original functions before any page script can modify them
  const originalAlert = window.alert;
  const originalConfirm = window.confirm;
  const originalPrompt = window.prompt;
  
  // Override alert() - just log and suppress (or show in console)
  window.alert = function(message) {
    const msg = message !== undefined ? String(message) : '';
    console.warn('[ContentPreload] Website called alert():', msg || '(empty message)');
    // Log via IPC for main process visibility (only if active view)
    try {
      sendIfActive('content-view-js-dialog', { type: 'alert', message: msg });
    } catch (e) {}
    // Suppress the dialog - don't call originalAlert
    // If you want to allow alerts, uncomment: return originalAlert.call(window, message);
  };
  
  // Override confirm() - log and return false (deny)
  window.confirm = function(message) {
    const msg = message !== undefined ? String(message) : '';
    console.warn('[ContentPreload] Website called confirm():', msg || '(empty message)');
    try {
      sendIfActive('content-view-js-dialog', { type: 'confirm', message: msg });
    } catch (e) {}
    // Return false to deny the action
    return false;
  };
  
  // Override prompt() - log and return null (cancelled)
  window.prompt = function(message, defaultValue) {
    const msg = message !== undefined ? String(message) : '';
    console.warn('[ContentPreload] Website called prompt():', msg || '(empty message)', 'default:', defaultValue);
    try {
      sendIfActive('content-view-js-dialog', { type: 'prompt', message: msg, defaultValue: defaultValue });
    } catch (e) {}
    // Return null to indicate cancelled
    return null;
  };

  let zoomLevel = 0; // zoomLevel: 0 = 100%, 1 = 110%, -1 = 90%, etc. (lineare 10%-Schritte)
  const MIN_ZOOM_LEVEL = -6;  // 40% minimum zoom (100% - 6*10%)
  const MAX_ZOOM_LEVEL = 40;  // 500% maximum zoom (100% + 40*10%)

  // Load initial zoom level synchronously (to prevent 100% flash)
  try {
    zoomLevel = ipcRenderer.sendSync('get-css-zoom-level') || 0;
  } catch (e) {
    console.warn('[ContentPreload] Could not load initial zoom level:', e);
  }

  // Zoom-Overlay Einstellung - load synchronously to show overlay on first load
  let showZoomOverlayEnabled = false;
  try {
    showZoomOverlayEnabled = ipcRenderer.sendSync('get-zoom-overlay');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Zoom Overlay state:', e);
  }
  
  // Mobile Mode Status - load synchronously to prevent wrong overlay display
  let mobileMode = false;
  try {
    mobileMode = ipcRenderer.sendSync('get-mobile-mode');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Mobile Mode state:', e);
  }
  
  // Original viewport width - stored when zoom container is created
  // Used to prevent responsive styles from compensating zoom effect
  let originalViewportWidth = null;
  
  // Visual Zoom Mode: When enabled, touch events are NOT intercepted
  // so that native browser pinch-zoom works
  // Load initial value synchronously to prevent CSS zoom flash
  let visualZoomEnabled = false;
  try {
    visualZoomEnabled = ipcRenderer.sendSync('get-visual-zoom');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Visual Zoom state:', e);
  }

  // Overlay for debug display (Zoom, NSFW-Cleanup, etc.)
  let infoOverlay = null;
  let infoOverlayTimeout = null;
  
  // Status messages displayed together with zoom
  let statusMessages = [];

  /**
   * Adds a status message that will be shown on the next overlay update
   * @param {string} message - The status message
   * @param {number} duration - How long the message stays in status (ms)
   */
  function addStatusMessage(message, duration = 3000) {
    statusMessages.push(message);
    // Remove message after duration
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

  /**
   * Shows mode indicator overlay (Mobile Mode only, zoom is now shown in badge)
   */
  function showZoomOverlay(level) {
    // Zoom is now displayed in the React badge, not in overlay
    // Only show Mobile Mode indicator if enabled
    if (mobileMode) {
      updateOverlay('📱 Mobile Mode');
    } else {
      // Clear overlay if no mobile mode
      updateOverlay(null);
    }
  }

  // Konvertierung: zoomLevel -> Faktor (linear: 10% pro Stufe)
  // Level 0 = 100%, Level 1 = 110%, Level -1 = 90%, etc.
  function zoomLevelToFactor(level) {
    return 1 + (level * 0.1);
  }

  // Conversion: Factor -> zoomLevel (linear)
  function factorToZoomLevel(factor) {
    return (factor - 1) / 0.1;
  }

  // Create zoom container that holds entire page
  function ensureZoomContainer() {
    let wrapper = document.getElementById('fr-zoom-wrapper');
    if (!wrapper) {
      // Create wrapper as fixed viewport (not scrollable)
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
      
      // Create inner container for transform (this one scrolls!)
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
      
      // Store original viewport width to prevent responsive compensation
      if (originalViewportWidth === null) {
        originalViewportWidth = window.innerWidth;
      }
      
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
      return;
    }
    
    // Move all children back to body
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
    
    // Reset original viewport width
    originalViewportWidth = null;
  }

  /**
   * Apply or remove min-width freeze to prevent responsive compensation
   * When zooming > 100%, set min-width to original viewport to prevent content shrinking
   * When zooming <= 100%, remove min-width to allow normal responsive behavior
   */
  function applyViewportFreeze(zoomFactor) {
    const container = document.getElementById('fr-zoom-container');
    if (!container) return;
    
    if (zoomFactor > 1 && originalViewportWidth) {
      // Zooming in: freeze content width to prevent responsive shrinking
      // The container shrinks (viewport / zoomFactor), but content should stay at original width
      container.style.minWidth = originalViewportWidth + 'px';
    } else {
      // Zooming out or 100%: allow normal responsive behavior
      container.style.minWidth = '';
    }
  }

  // Apply zoom to container - Zoom can originate from any point
  // IMPORTANT: With Visual Zoom (Device Emulation) this function is NOT executed,
  // so that native browser pinch-zoom works!
  function applyZoom(newZoomLevel, options = { notify: true, zoomPointX: null, zoomPointY: null, preserveScroll: true }) {
    logToMain(`[ContentPreload] applyZoom called: newZoomLevel=${newZoomLevel}, visualZoomEnabled=${visualZoomEnabled}`);
    // With Visual Zoom: NO CSS-based zoom manipulation!
    // The native browser zoom (via enableDeviceEmulation) takes over.
    if (visualZoomEnabled) {
      logToMain(`[ContentPreload] applyZoom: skipping due to visualZoomEnabled`);
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
    
    // Calculate new container size based on scaling
    const newContainerWidth = wrapper.clientWidth / newFactor;
    const newContainerHeight = wrapper.clientHeight / newFactor;
    
    // Set container size and scroll overflow
    container.style.width = newContainerWidth + 'px';
    container.style.height = newContainerHeight + 'px';
    container.style.overflow = 'auto';
    
    // Wende Scale an
    container.style.transform = `scale(${newFactor})`;
    
    // Apply viewport freeze to prevent responsive compensation when zooming in
    applyViewportFreeze(newFactor);
    
    // Berechne neue Scroll-Position
    requestAnimationFrame(() => {
      if (options.preserveScroll) {
        // For keyboard zoom: Simply keep current scroll position
        // (in unscaled space) - don't change scroll position
        // container.scrollLeft and container.scrollTop stay the same
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
    
    // Show zoom overlay (always when zoom changes)
    showZoomOverlay(zoomLevel);
    
    // Sende Notification an Main-Prozess (only if this view is active)
    if (options.notify) {
      try { sendIfActive('content-view-zoom-changed', zoomLevel); } catch {}
    }
  }

  // Initial: Wait for DOM
  // BUT: Skip if Visual Zoom is enabled (Device Emulation handles zoom)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!visualZoomEnabled) {
        applyZoom(zoomLevel, { notify: false });
      } else {
        // But still show overlay if enabled (for Visual Zoom)
        if (showZoomOverlayEnabled) {
          showZoomOverlay(zoomLevel);
        }
      }
    });
  } else {
    if (!visualZoomEnabled) {
      applyZoom(zoomLevel, { notify: false });
    } else {
      // But still show overlay if enabled (for Visual Zoom)
      if (showZoomOverlayEnabled) {
        showZoomOverlay(zoomLevel);
      }
    }
  }

  // Listener for external zoom commands (from keyboard - preserve scroll position)
  // BUT: With Visual Zoom only track the level, DO NOT apply CSS zoom!
  ipcRenderer.on('content-view-set-css-zoom', (event, zoomLevel_) => {
    logToMain(`[ContentPreload] Received 'content-view-set-css-zoom': level=${zoomLevel_}, visualZoomEnabled=${visualZoomEnabled}, readyState=${document.readyState}`);
    zoomLevel = zoomLevel_;
    
    // With Visual Zoom: Do not apply CSS zoom (Device Emulation handles zoom)
    if (!visualZoomEnabled) {
      // Ensure DOM is ready before applying zoom (important after navigation)
      if (document.readyState === 'loading') {
        logToMain(`[ContentPreload] DOM loading - deferring applyZoom`);
        document.addEventListener('DOMContentLoaded', () => {
          logToMain(`[ContentPreload] DOMContentLoaded - calling applyZoom`);
          applyZoom(zoomLevel, { notify: false, preserveScroll: true, zoomPointX: null, zoomPointY: null });
        }, { once: true });
      } else {
        logToMain(`[ContentPreload] DOM ready - calling applyZoom now`);
        applyZoom(zoomLevel, { notify: false, preserveScroll: true, zoomPointX: null, zoomPointY: null });
      }
    } else {
      logToMain(`[ContentPreload] Visual Zoom enabled - skipping CSS zoom`);
    }
    
    // Show zoom overlay on article change if enabled
    if (showZoomOverlayEnabled) {
      showZoomOverlay(zoomLevel);
    }
  });

  // Listener for zoom overlay setting
  ipcRenderer.on('set-zoom-overlay-setting', (event, enabled) => {
    showZoomOverlayEnabled = !!enabled;
    // If enabled, immediately show current zoom level
    if (showZoomOverlayEnabled) {
      showZoomOverlay(zoomLevel);
    }
  });
  
  // Listener for Visual Zoom level update (for overlay display with Device Emulation)
  // The CSS-based zoomLevel is not used with Visual Zoom,
  // but we still need a level for overlay display
  ipcRenderer.on('set-visual-zoom-level', (event, level) => {
    zoomLevel = level;  // Update internal tracking
    if (showZoomOverlayEnabled) {
      showZoomOverlay(level);
    }
  });
  
  // Listener for Mobile Mode Status
  ipcRenderer.on('set-mobile-mode', (event, enabled) => {
    const wasEnabled = mobileMode;
    mobileMode = !!enabled;
    // Briefly show overlay to indicate mode change (even if overlay is otherwise disabled)
    if (wasEnabled !== mobileMode) {
      const modeText = mobileMode ? '📱 Mobile Mode' : '🖥️ Desktop Mode';
      // Temporarily show even if overlay is disabled
      const wasOverlayEnabled = showZoomOverlayEnabled;
      showZoomOverlayEnabled = true;
      updateOverlay(modeText);
      showZoomOverlayEnabled = wasOverlayEnabled;
    }
  });

  // Listener for Visual Zoom Mode (enables native browser pinch-zoom)
  ipcRenderer.on('set-visual-zoom-mode', (event, enabled) => {
    const wasEnabled = visualZoomEnabled;
    visualZoomEnabled = !!enabled;
    
    // When Visual Zoom is enabled, remove CSS zoom container
    // so native browser pinch-zoom (via enableDeviceEmulation) works
    if (visualZoomEnabled) {
      removeZoomContainer();
    }
    
    if (wasEnabled !== visualZoomEnabled) {
      // Show status message
      const wasOverlayEnabled = showZoomOverlayEnabled;
      showZoomOverlayEnabled = true;
      updateOverlay(visualZoomEnabled ? 'Visual Zoom: ON (Pinch-to-Zoom active)' : 'Visual Zoom: OFF');
      showZoomOverlayEnabled = wasOverlayEnabled;
    }
  });

  // Listener for Input Mode Status (disables keyboard navigation for login forms etc.)
  let inputModeEnabled = false;
  ipcRenderer.on('set-input-mode', (event, enabled) => {
    inputModeEnabled = !!enabled;
  });

  // EXPERIMENTAL: JavaScript-based navigation (to test if Device Emulation survives)
  ipcRenderer.on('navigate-via-js', (event, url) => {
    // Navigate using JavaScript - this might preserve Device Emulation!
    window.location.href = url;
  });

  // NSFW-Cleanup setting - load synchronously at start
  let nsfwCleanupEnabled = false;
  try {
    nsfwCleanupEnabled = ipcRenderer.sendSync('get-nsfw-cleanup');
  } catch (e) {
    console.warn('[ContentPreload] Could not load NSFW-Cleanup setting:', e);
  }

  // Auto Cookie-Consent setting - load synchronously at start
  let autoCookieConsentEnabled = false;
  try {
    autoCookieConsentEnabled = ipcRenderer.sendSync('get-auto-cookie-consent');
  } catch (e) {
    console.warn('[ContentPreload] Could not load Auto Cookie-Consent setting:', e);
  }

  // Ctrl+Wheel Zoom (Touchpad) - zooms from cursor position
  window.addEventListener('wheel', (e) => {
    try {
      if (e.ctrlKey) {
        // With Visual Zoom: Pass events through for native browser zoom
        if (visualZoomEnabled) return;
        
        e.preventDefault();
        const delta = -e.deltaY;
        // Touchpad control: With larger steps (higher sensitivity)
        // The larger this value, the less sensitive
        const steps = (delta > 0 ? 1 : -1) * 0.125;
        
        // TEMP: Scroll compensation disabled for testing
        // Calculate mouse position relative to container
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

  // Touch Pinch-Zoom - zooms from midpoint between both fingers
  // IMPORTANT: When Visual Zoom is enabled, these events are NOT intercepted,
  // so native browser pinch-zoom (via enableDeviceEmulation) works
  let lastDistance = 0;
  let touchStartZoomLevel = zoomLevel;
  let lastTouchMidpointX = 0;
  let lastTouchMidpointY = 0;

  // Touch event registration as function that is called on each navigation
  // For data: URLs the document is replaced on each navigation, so
  // event listeners must be re-registered on the new document
  let touchEventsRegistered = false;
  
  function registerTouchEvents() {
    // IMPORTANT: In Electron Preload the document is replaced on data: URL navigations!
    // We must register events on the CURRENT document
    const touchTarget = document;
    
    // Check if already registered on this document
    if (touchTarget._touchEventsRegistered) {
      return;
    }
    touchTarget._touchEventsRegistered = true;
    
    touchTarget.addEventListener('touchstart', (e) => {
      try {
        // With Visual Zoom: Pass events through for native browser zoom
        if (visualZoomEnabled) return;
        
        if (e.touches.length === 2) {
          const touch1 = e.touches[0];
          const touch2 = e.touches[1];
          lastDistance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
          );
          touchStartZoomLevel = zoomLevel;
          
          // Calculate midpoint between both fingers
          lastTouchMidpointX = (touch1.clientX + touch2.clientX) / 2;
          lastTouchMidpointY = (touch1.clientY + touch2.clientY) / 2;
        }
      } catch (err) { console.error('[ContentPreload] touchstart error:', err); }
    }, { passive: false, capture: true });

    touchTarget.addEventListener('touchmove', (e) => {
      try {
        // With Visual Zoom: Pass events through for native browser zoom
        if (visualZoomEnabled) {
          return;
        }
        
        if (e.touches.length === 2 && lastDistance > 0) {
          e.preventDefault();
          const touch1 = e.touches[0];
          const touch2 = e.touches[1];
          const currentDistance = Math.hypot(
            touch2.clientX - touch1.clientX,
            touch2.clientY - touch1.clientY
          );
          const scale = currentDistance / lastDistance;
          // Half speed for touchscreen (less sensitive)
          const scaleFactor = 1 + (scale - 1) / 2;
          const newFactor = zoomLevelToFactor(touchStartZoomLevel) * scaleFactor;
          
          // Calculate current finger midpoint
          const currentMidX = (touch1.clientX + touch2.clientX) / 2;
          const currentMidY = (touch1.clientY + touch2.clientY) / 2;
          
          // TEMP: Scroll compensation disabled for testing
          // Calculate touch position relative to container
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
      lastDistance = 0;
    }, { capture: true });
  }
  
  // Register touch events immediately (for the initial document)
  registerTouchEvents();
  
  // On each navigation a new document is created - re-register then
  // DOMContentLoaded fires on each navigation, also for data: URLs
  document.addEventListener('DOMContentLoaded', () => {
    registerTouchEvents();
  });
  
  // Export for executeJavaScript injection from Main Process
  // After navigation the Main Process can call this function to re-register
  // touch events in the new document context
  // 
  // IMPORTANT: Since contextIsolation=true, the preload runs in an isolated context.
  // executeJavaScript runs in Main World and sees a different window object.
  // Therefore we must use contextBridge to expose the function.
  const reRegisterTouchEvents = function() {
    // Force re-registration by clearing the flag on current document
    if (document._touchEventsRegistered) {
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
  } catch (e) {
    console.warn('[ContentPreload] contextBridge failed:', e);
  }

  // macOS Gesture Events
  window.addEventListener('gesturechange', (e) => {
    try {
      // With Visual Zoom: Pass events through for native browser zoom
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
    const ctx = getScrollContext();
    const viewportTop = ctx.scrollTop;
    const viewportHeight = ctx.viewportHeight;
    const viewportBottom = viewportTop + viewportHeight;
    
    // Maximum scroll distance = one page (80% of viewport for overlap)
    const maxScrollDistance = viewportHeight * 0.8;
    // Threshold: element must be at least this far into viewport to be "current"
    const visibilityThreshold = viewportHeight * 0.15;
    
    // If no substantial images, use page scrolling with overlap
    if (images.length === 0) {
      scrollByPage(direction);
      return true;
    }
    
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
            maxScrollDistance // But not more than one page
          );
          ctx.scrollBy(scrollAmount);
          return true;
        }
      }
      
      // No overflowing image - find next anchor point within reach
      // "Within reach" = within one page scroll distance
      const maxTargetPosition = viewportTop + maxScrollDistance;
      let nextTarget = null;
      let nextTargetIndex = -1;
      
      for (let i = 0; i < targets.length; i++) {
        const targetTop = targets[i].target.offsetTop;
        
        // Target must be below current view (not already visible at top)
        if (targetTop > viewportTop + visibilityThreshold) {
          // Check if target is within one page distance
          if (targetTop <= maxTargetPosition) {
            // Found an anchor within reach - scroll to it
            nextTarget = targets[i];
            nextTargetIndex = i;
            break;
          } else {
            // Target exists but is too far - do page scroll and check if we reveal an anchor
            break;
          }
        }
      }
      
      if (nextTarget) {
        // Scroll to the anchor point
        nextTarget.target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        currentImageIndex = nextTargetIndex;
        return true;
      }
      
      // No anchor within reach - scroll by one page
      // Then check if an anchor appeared in the new viewport
      const newScrollTop = viewportTop + maxScrollDistance;
      
      // Find if there's an anchor that will be visible after page scroll
      let anchorInNewView = null;
      let anchorIndex = -1;
      for (let i = 0; i < targets.length; i++) {
        const targetTop = targets[i].target.offsetTop;
        // Will this anchor be near the top of the new viewport?
        if (targetTop >= newScrollTop && targetTop <= newScrollTop + viewportHeight * 0.3) {
          anchorInNewView = targets[i];
          anchorIndex = i;
          break;
        }
      }
      
      if (anchorInNewView) {
        // An anchor will appear in the upper part of new view - snap to it
        anchorInNewView.target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        currentImageIndex = anchorIndex;
      } else {
        // No anchor in new view - just do page scroll
        ctx.scrollBy(maxScrollDistance);
      }
      return true;
      
    } else {
      // Backward navigation (Shift+Space)
      
      // Check if any currently visible image has its top above the viewport
      // (meaning we're in the middle of a tall image)
      for (let i = images.length - 1; i >= 0; i--) {
        const img = images[i];
        const imgTop = img.offsetTop;
        const imgBottom = imgTop + img.offsetHeight;
        
        // Image is visible and its top is above the viewport
        const topIsAbove = imgTop < viewportTop;
        const isStillVisible = imgBottom > viewportTop + visibilityThreshold;
        
        if (topIsAbove && isStillVisible) {
          // We're in the middle of a tall image - scroll up to show its top
          // But limit to one page
          const distanceToTop = viewportTop - imgTop;
          const scrollAmount = Math.min(distanceToTop, maxScrollDistance);
          ctx.scrollBy(-scrollAmount);
          return true;
        }
      }
      
      // Find the previous anchor point within reach
      const minTargetPosition = viewportTop - maxScrollDistance;
      let prevTarget = null;
      let prevTargetIndex = -1;
      
      // Find current position in target list
      let currentIndex = -1;
      for (let i = 0; i < targets.length; i++) {
        const targetTop = targets[i].target.offsetTop;
        if (targetTop >= viewportTop - 50 && targetTop <= viewportTop + visibilityThreshold) {
          currentIndex = i;
          break;
        }
        if (targetTop > viewportTop + visibilityThreshold) {
          currentIndex = i - 1;
          break;
        }
      }
      
      // Look for previous anchor within reach
      const searchStartIndex = currentIndex >= 0 ? currentIndex - 1 : targets.length - 1;
      for (let i = searchStartIndex; i >= 0; i--) {
        const targetTop = targets[i].target.offsetTop;
        
        // Target must be above current view
        if (targetTop < viewportTop - 10) {
          // Check if target is within one page distance
          if (targetTop >= minTargetPosition) {
            prevTarget = targets[i];
            prevTargetIndex = i;
            break;
          } else {
            // Target exists but is too far - do page scroll
            break;
          }
        }
      }
      
      if (prevTarget) {
        // Scroll to the anchor point
        prevTarget.target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        currentImageIndex = prevTargetIndex;
        return true;
      }
      
      // Check if we're at/near the first target - scroll to top
      if (currentIndex === 0 || viewportTop < maxScrollDistance) {
        ctx.scrollTo(0);
        return true;
      }
      
      // No anchor within reach - scroll by one page
      const newScrollTop = Math.max(0, viewportTop - maxScrollDistance);
      
      // Find if there's an anchor that will be visible after page scroll
      let anchorInNewView = null;
      let anchorIndex = -1;
      for (let i = targets.length - 1; i >= 0; i--) {
        const targetTop = targets[i].target.offsetTop;
        // Will this anchor be near the top of the new viewport?
        if (targetTop >= newScrollTop && targetTop <= newScrollTop + viewportHeight * 0.3) {
          anchorInNewView = targets[i];
          anchorIndex = i;
          break;
        }
      }
      
      if (anchorInNewView) {
        // An anchor will appear in the upper part of new view - snap to it
        anchorInNewView.target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        currentImageIndex = anchorIndex;
      } else {
        // No anchor in new view - just do page scroll
        ctx.scrollBy(-maxScrollDistance);
      }
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
      // Reddit: Remove NSFW dialogs, app promo, QR codes, modals, cookie banners
      patterns: [/reddit\.com/],
      cleanup: () => {
        // NSFW/18+ Blocking Modals and Dialogs
        document.querySelectorAll('faceplate-modal, faceplate-dialog').forEach(el => el.remove());
        document.querySelectorAll('#nsfw-qr-dialog, #blocking-modal').forEach(el => el.remove());
        
        // NSFW Blocking Container - manipulate Shadow DOM
        document.querySelectorAll('xpromo-nsfw-blocking-container').forEach(container => {
          // Remove "View in App" buttons in Light DOM
          container.querySelectorAll('.viewInApp, a[slot="view-in-app-button"]').forEach(el => el.remove());
          
          // Shadow DOM: Hide prompt ("18+ content" text)
          if (container.shadowRoot) {
            const prompt = container.shadowRoot.querySelector('.prompt');
            if (prompt) prompt.style.display = 'none';
          }
        });
        
        // Blurred container for NSFW - manipulate Shadow DOM
        document.querySelectorAll('shreddit-blurred-container').forEach(el => {
          el.removeAttribute('blurred');
          el.setAttribute('mode', 'revealed');
          
          // Shadow DOM: Remove overlay and blur
          if (el.shadowRoot) {
            // Hide "Show 18+ content" button/overlay
            const overlay = el.shadowRoot.querySelector('.overlay');
            if (overlay) overlay.style.display = 'none';
            
            // Remove blur filter - all possible selectors
            el.shadowRoot.querySelectorAll('.inner.blurred, .blurred, [class*="blur"]').forEach(blurredEl => {
              blurredEl.style.filter = 'none';
              blurredEl.style.webkitFilter = 'none';
              blurredEl.classList.remove('blurred');
            });
            
            // Also handle .inner directly (in case without .blurred class)
            const inner = el.shadowRoot.querySelector('.inner');
            if (inner) {
              inner.style.filter = 'none';
              inner.style.webkitFilter = 'none';
            }
            
            // Remove scrim (dark overlay)
            el.shadowRoot.querySelectorAll('.bg-scrim, .scrim, [class*="scrim"]').forEach(scrim => {
              scrim.style.display = 'none';
            });
          }
          
          // Light DOM: Show revealed slot, hide blurred slot
          const revealed = el.querySelector('[slot="revealed"]');
          const blurred = el.querySelector('[slot="blurred"]');
          if (revealed) {
            revealed.style.display = 'block';
            revealed.style.visibility = 'visible';
          }
          if (blurred) {
            blurred.style.display = 'none';
          }
          
          // Also handle direct children with blur
          el.querySelectorAll('[style*="blur"], [style*="filter"]').forEach(child => {
            child.style.filter = 'none';
            child.style.webkitFilter = 'none';
          });
        });
        
        // Remove modal wrapper with dialog role (app promo, login prompts)
        document.querySelectorAll('#wrapper[role="dialog"][aria-modal="true"]').forEach(el => el.remove());
        
        // App download banners and prompts
        document.querySelectorAll('[data-testid="xpromo-nsfw-blocking-modal"]').forEach(el => el.remove());
        document.querySelectorAll('[data-testid="xpromo-app-selector"]').forEach(el => el.remove());
        document.querySelectorAll('.XPromoPopupRpl, .XPromoBlockingModal').forEach(el => el.remove());
        
        // Other annoying elements
        document.querySelectorAll('[class*="bottom-sheet"]').forEach(el => el.remove());
        document.querySelectorAll('[class*="overlay-container"]').forEach(el => el.remove());
        
        // Remove scrim/backdrop (gray overlay)
        document.querySelectorAll('[class*="scrim"]').forEach(el => el.remove());
        document.querySelectorAll('[class*="backdrop"]').forEach(el => el.remove());
        
        // Re-enable body scroll if blocked
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
            // NSFW elements
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
        // Cookie/Consent/Privacy Banner - try to click "Reject"
        const cookieDialog = document.querySelector('#data-protection-consent-dialog');
        if (cookieDialog) {
          // Search for "Reject" button (secondary-button slot)
          const rejectButton = cookieDialog.querySelector('[slot="secondary-button"]') ||
                               cookieDialog.querySelector('button[data-testid="reject-nonessential-cookies-button"]');
          if (rejectButton) {
            rejectButton.click();
            return true;
          } else {
            // Fallback: Remove dialog if no button found
            cookieDialog.remove();
            return true;
          }
        }
        
        // Other cookie banners
        let handled = false;
        document.querySelectorAll('[data-testid="cookie-policy-banner"]').forEach(el => { el.remove(); handled = true; });
        document.querySelectorAll('shreddit-cookie-banner').forEach(el => { el.remove(); handled = true; });
        
        return handled;
      }
    },
    // More sites can be added here:
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
          showOverlayMessage('Cookie-Consent done', 1500);
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

  // Observer and cleanup are only started when NSFW-Cleanup is enabled
  let siteCleanupObserver = null;
  let siteCleanupStarted = false;

  function startSiteCleanup() {
    if (siteCleanupStarted || !hasSiteTransformations()) return;
    siteCleanupStarted = true;
    
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
          showOverlayMessage('Site cleanup complete', 2000);
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

  // Start cleanup automatically when enabled (setting was loaded synchronously above)
  if (nsfwCleanupEnabled && hasSiteTransformations()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startSiteCleanup);
    } else {
      startSiteCleanup();
    }
  }

  // Start Auto Cookie-Consent automatically when enabled
  if (autoCookieConsentEnabled && hasCookieConsentPatterns()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startCookieConsent);
    } else {
      startCookieConsent();
    }
  }

} catch {
  // Error handling: Silent error suppression
}