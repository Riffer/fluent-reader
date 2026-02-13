/**
 * Centralized Overlay Visibility Management
 * 
 * This module provides a unified event system for managing ContentView visibility
 * when overlays (dialogs, menus, panels) are opened or closed.
 * 
 * Problem solved:
 * The WebContentsView is a native OS window that sits above React DOM elements.
 * When overlays open, they would appear BEHIND the ContentView without this system.
 * We need to hide the ContentView (with a screenshot placeholder) when any overlay opens.
 * 
 * Previously, this was handled by multiple fragmented mechanisms:
 * - Redux overlayActive prop (settings, log menu, context menu)
 * - Fluent UI callbacks (dropdown menus)
 * - Local component state (P2P dialogs)
 * - CustomEvents (P2P incoming notification)
 * 
 * This centralized system:
 * - Tracks ALL overlay sources in a single Map
 * - Uses a single event type for all visibility changes
 * - Automatically determines when to hide/show ContentView
 * - Makes it trivial to add new overlay types
 * 
 * Usage:
 * 
 * // When opening an overlay:
 * import { setOverlayVisible } from '../scripts/overlay-visibility'
 * setOverlayVisible('my-dialog', true)
 * 
 * // When closing an overlay:
 * setOverlayVisible('my-dialog', false)
 * 
 * // In Article component - one listener handles everything:
 * window.addEventListener(OVERLAY_VISIBILITY_EVENT, handler)
 */

/**
 * Known overlay sources for type safety and documentation
 * Add new overlay types here as needed
 */
export type OverlaySource = 
    | 'redux-settings'      // Settings panel (from Redux state)
    | 'redux-logmenu'       // Log menu / notification bell (from Redux state)
    | 'redux-contextmenu'   // Context menu (from Redux state)
    | 'fluent-dropdown'     // Fluent UI dropdown menus (Tools menu, etc.)
    | 'p2p-incoming'        // P2P incoming article notification dialog
    | 'p2p-share'           // P2P share dialog
    | 'prefetch-preview'    // Prefetch preview tooltip (hover on prefetch badge)
    | 'local-dialog'        // Generic local dialog (fallback)

/**
 * Event name for overlay visibility changes
 */
export const OVERLAY_VISIBILITY_EVENT = 'overlay-visibility-change'

/**
 * Event detail interface
 */
export interface OverlayVisibilityEventDetail {
    source: OverlaySource
    visible: boolean
}

/**
 * Typed CustomEvent for overlay visibility
 */
export type OverlayVisibilityEvent = CustomEvent<OverlayVisibilityEventDetail>

/**
 * Dispatch an overlay visibility change event
 * Call this when any overlay opens or closes
 * 
 * @param source - The overlay source identifier
 * @param visible - true when overlay opens, false when it closes
 */
export function setOverlayVisible(source: OverlaySource, visible: boolean): void {
    const event = new CustomEvent<OverlayVisibilityEventDetail>(OVERLAY_VISIBILITY_EVENT, {
        detail: { source, visible }
    })
    window.dispatchEvent(event)
}

/**
 * Helper class to manage overlay states in Article component
 * Tracks which overlays are currently open and provides computed state
 */
export class OverlayStateManager {
    private states = new Map<OverlaySource, boolean>()
    
    /**
     * Update the state of an overlay source
     * @returns true if any overlay is now open
     */
    update(source: OverlaySource, visible: boolean): boolean {
        if (visible) {
            this.states.set(source, true)
        } else {
            this.states.delete(source)
        }
        return this.isAnyOpen()
    }
    
    /**
     * Check if any overlay is currently open
     */
    isAnyOpen(): boolean {
        return this.states.size > 0
    }
    
    /**
     * Get list of currently open overlays (for debugging)
     */
    getOpenOverlays(): OverlaySource[] {
        return Array.from(this.states.keys())
    }
    
    /**
     * Clear all states (used on unmount)
     */
    clear(): void {
        this.states.clear()
    }
}

// ===== Video Fullscreen State =====
// Special state that suppresses overlay dialogs (P2P incoming, etc.)
// when a video is playing in fullscreen mode.

/**
 * Event name for video fullscreen changes
 */
export const VIDEO_FULLSCREEN_EVENT = 'video-fullscreen-change'

/**
 * Global flag for video fullscreen state
 * When true, components should avoid showing disruptive overlays
 */
let videoFullscreenActive = false

/**
 * Check if video fullscreen mode is currently active
 */
export function isVideoFullscreen(): boolean {
    return videoFullscreenActive
}

/**
 * Set video fullscreen state and notify listeners
 * Called by ContentViewManager when HTML fullscreen events occur
 * 
 * @param active - true when entering video fullscreen, false when leaving
 */
export function setVideoFullscreen(active: boolean): void {
    videoFullscreenActive = active
    const event = new CustomEvent<boolean>(VIDEO_FULLSCREEN_EVENT, { detail: active })
    window.dispatchEvent(event)
}
