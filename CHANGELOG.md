# Changelog

All notable changes to Fluent Reader (this fork) are documented in this file.

## [Unreleased]

### Added

#### Visual Zoom (Pinch-to-Zoom)
- Native pinch-to-zoom support via Electron's Device Emulation
- Toggle option in Tools menu: "Visual Zoom (Pinch-to-Zoom)"
- When enabled: Native touch gestures for zooming (works on touchscreens and touchpads)
- When disabled: CSS-based zoom via keyboard (+/-/0)
- WebContentsView is automatically recreated when toggling to apply new CSS layout and touch handling

#### Mobile View (Mobile Mode)
A feature that displays websites as if viewed on a mobile device (iPhone).

**User-Agent Change:**
Sets the User-Agent to iPhone Safari:
```
Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1
```
This makes web servers deliver the mobile version of websites.

**Viewport Emulation (768px):**
The viewport is set to a fixed width of 768px (typical mobile/tablet breakpoint), which triggers responsive CSS layouts on websites.

**Auto-Scaling:**
The page is automatically scaled up to fill the available space:
- Example: 1086px wide window → `1086 / 768 ≈ 1.41×` scaling
- Keyboard zoom is applied on top of auto-scaling

**Adaptive Viewport Adjustment:**
At high zoom levels, the viewport is proportionally reduced to prevent content overflow.

**Per-Feed Setting:**
The option is saved per RSS feed (`source.mobileMode`), allowing each feed to have its own settings.

**Practical Uses:**
- Bypass paywalls: Some sites show less advertising or have weaker paywalls on mobile
- Better readability: Mobile layouts are often simpler and more text-oriented
- Test responsive designs: See how a site looks on mobile devices

Mobile Mode works independently of Visual Zoom and can be combined with it.

### Changed
- Migrated from WebView to WebContentsView for all article display modes
- Improved zoom behavior with separate handling for Visual Zoom and CSS zoom modes

### Fixed
- DevTools methods (isDevToolsOpened, closeDevTools) now properly exposed via bridge
- Simplified DevTools closing logic to prevent crashes on article change/unmount

---

## Previous Versions

For changes before this fork, see the original [Fluent Reader repository](https://github.com/yang991178/fluent-reader).
