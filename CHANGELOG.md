# Changelog

All notable changes to Fluent Reader (this fork) are documented in this file.

Based on the original [Fluent Reader v1.1.4](https://github.com/yang991178/fluent-reader) by Haoyuan Liu.

---

## [1.3.5] - 2025-12-30

### Added - Fullscreen Support
- **F11 keyboard shortcut** for fullscreen toggle (global, works everywhere)
- **View menu option** "Vollbild" / "Fullscreen" with F11 shortcut indicator
- Fullscreen checkbox shows current state in View menu

### Added - Video Fullscreen
- **Embedded videos** (YouTube, etc.) now expand to true fullscreen when clicking fullscreen button
- ContentView automatically expands to fill entire window during video fullscreen
- Window enters fullscreen mode (over taskbar) for immersive viewing
- Bounds are saved and restored when exiting video fullscreen
- P2P incoming notifications suppressed during video playback (articles go directly to bell)

### Fixed
- **ContentView bounds** now properly follow window resize/maximize/fullscreen
- Added listeners for maximize/unmaximize/enter-fullscreen/leave-fullscreen events
- Multiple delayed bounds updates to handle animation timing
- **F11/F12 double execution** fixed when ContentView has focus
- **JavaScript dialogs** (alert/confirm/prompt) from article pages now intercepted to prevent empty "Error:" dialogs

### Changed
- Removed verbose CookiePersist logging (error logs retained)

---

## [1.2.13] - 2025-12-27

### Added - Visual Zoom (Pinch-to-Zoom)
- Native pinch-to-zoom support via Electron's Device Emulation
- Toggle option in Tools menu: "Visual Zoom (Pinch-to-Zoom)"
- When enabled: Native touch gestures for zooming (works on touchscreens and touchpads)
- When disabled: CSS-based zoom via keyboard (+/-/0)
- WebContentsView is automatically recreated when toggling to apply new CSS layout and touch handling
- Adaptive viewport scaling prevents content overflow at high zoom levels

### Added - Mobile View (Mobile Mode)
- Display websites as if viewed on a mobile device (iPhone)
- User-Agent emulation (iPhone Safari iOS 17)
- Viewport emulation at 768px width (mobile/tablet breakpoint)
- Auto-scaling to fill available space
- Per-feed setting (saved individually for each RSS feed)
- Toggle with M key, indicator shows (M) or (D) in toolbar

### Changed
- **Major refactor**: Migrated from deprecated WebView to WebContentsView for all article display
- Native context menu for WebContentsView with image actions
- Improved zoom behavior with separate handling for Visual Zoom and CSS zoom modes

### Fixed
- Context menu image actions (save, copy, open) now working
- DevTools methods properly exposed via bridge
- Simplified DevTools closing logic to prevent crashes

---

## [1.2.12] - 2025-12

### Added
- P key toggle for article panel
- Keyboard zoom (+/-/0/#) for ContentView
- Input Mode support (disables keyboard navigation when typing in forms)

### Fixed
- Scroll fixes for article navigation
- P2P-LAN logging reduced

---

## [1.2.11] - 2025-12

### Added
- ContentView overlay menu integration with blur placeholder
- Menu blur placeholder for overlay handling (screenshot-based)

### Fixed
- ContentView initialization issues
- Tools menu overlay positioning

---

## [1.2.10] - 2025-11

### Added
- **WebContentsView Migration**: Complete replacement of deprecated WebView tag
- ContentViewManager for WebContentsView-based article display
- ContentView bridge for renderer communication

---

## [1.2.0] - 2025

### Added - P2P LAN Sharing
- **Peer-to-peer article sharing** over local network (LAN)
- Automatic peer discovery via mDNS/Bonjour
- Share articles directly to other Fluent Reader instances
- Receive articles with notification sound
- "Later" button to queue received articles
- Persistent peer ID across sessions
- Graceful disconnect with goodbye messages
- Handle system suspend/resume events
- P2P context menu: Share article, Subscribe to feed

### Added - SQLite Migration
- Migrated from Lovefield to SQLite (better-sqlite3)
- Improved database performance and reliability
- Backward compatible migration

### Added
- Auto-refresh feeds on system wake from sleep

---

## [1.1.10] - 2024

### Added
- P2P offline queue simplified
- Notification sound for received articles

---

## [1.1.9] - 2024

### Added
- P2P LAN improvements
- Dark mode fixes for P2P dialogs
- Room persistence
- Log menu integration

---

## [1.1.8] - 2024

### Added
- **Persistent Cookie Storage** for feeds requiring login
- Cookies saved per feed, restored on load
- Toggle in Tools menu: "Cookies speichern (Login)"

---

## [1.1.7] - 2024

### Added
- **Mobile Mode** with device emulation
- **Auto Cookie-Consent**: Automatic dismissal of cookie banners
- Mobile mode toggle with M key

### Fixed
- Database compatibility and migration for mobileMode field

---

## [1.1.6] - 2024

### Added
- **NSFW-Cleanup**: Reddit NSFW bypass via site-specific transformations
- Toggle in Tools menu: "NSFW-Cleanup (experimentell)"
- MutationObserver-based cleanup (no intervals)

### Added
- **Comic Mode** for image-heavy RSS feeds
- Space key navigation through images in galleries
- Shift+Space for backward navigation

### Added
- **Zoom Overlay**: Visual indicator showing current zoom level
- Keyboard zoom control (+/-/0) with improved behavior
- Separate DevTools for App and Article (F12 shortcut)

### Added
- **Article Extractor**: Replaced Mercury Parser with article-extractor
- Cookie and consent banner removal transformations
- Semantic HTML structure for extracted articles

### Changed
- Improved dark mode support
- Better webview focus handling
- Reduced touchpad zoom sensitivity

### Fixed
- Duplicate images in comic feeds (Fancybox/lightbox)
- Container with images preserved during content cleanup
- Scroll compensation disabled during touchpad/touch zoom
- Keyboard zoom auto-repeat issue fixed

---

## [1.1.5] - 2023

### Added
- **Persistent Default Zoom** per feed source
- openTarget saved to OPML export/import
- mobileMode saved to OPML export/import

### Changed
- Updated to Node.js 18.16+ / 24.x compatibility
- Updated Electron and dependencies
- Minimum window size adjusted for smaller screens

### Fixed
- Links open internally (configurable)
- Menu size adaptation

---

## [1.1.4] - 2022 (Original by Haoyuan Liu)

Base version this fork is built upon.

See [original repository](https://github.com/yang991178/fluent-reader) for earlier history.
