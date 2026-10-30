# Copilot Instructions for Unblur Mobbin

## Project Overview

This is a **Chrome Extension (Manifest V3)** that unblurs pro scenes on mobbin.com. The architecture has two distinct parts:

1. **Content Script** ([public/content.js](../public/content.js)) - Vanilla JavaScript injected into mobbin.com pages
2. **Extension Popup** ([src/App.tsx](../src/App.tsx)) - React + TypeScript UI shown when clicking the extension icon

## Architecture & Data Flow

```
mobbin.com page load → content.js injected → DOM modifications applied
                                           → scroll events re-trigger modifications
extension icon click → popup opens → index.html loads React app
```

The content script runs independently of the popup. There is **no message passing** between popup and content script - they operate separately.

## Key Technical Patterns

### Content Script DOM Manipulation

The unblur logic in [public/content.js](../public/content.js) targets specific Mobbin elements.

**Current lock (2026):** Mobbin serves screen previews through signed Bytescale URLs. The `src` is a small preview, but `srcset` still contains the full-resolution `1920w` candidate. Images may also have `pointer-events-none` and a `backdrop-blur` veil.

**Unblur transformation:**
1. For every visible screen image, pick the largest `srcset` candidate (at least 700w) and pin it to `src`.
2. Remove `srcset` and `sizes` so the browser cannot switch back to the thumbnail.
3. If no large candidate exists, use the original Supabase `screenUrl` exposed in the page payload through its equivalent public Bytescale path.
4. Remove `pointer-events-none` from screen cards and hide `backdrop-blur-[...]` veil layers.
5. Re-run on scroll/DOM mutations, but only process images within ~800px of the viewport to avoid downloading every full-resolution screen at once.

CSS overrides live in [public/content.css](../public/content.css) (pseudo-element blurs, locked pointer events, sticky upsell banner).

**Key selectors:**
- Screen images: `img[data-sentry-component="CdnImg"]`, `img[srcset]`
- Screen/flow links: `a[href*="/explore/screens/"]`, `a[href*="/explore/flows/"]`
- Card wrappers: `[class*="mobile-screen-border-radius"]`, `[class*="screen-inset-border"]`
- Paywall veil: `[class*="backdrop-blur-[10px]"]`, `[class*="after:backdrop-blur"]`

Event-driven execution with rAF-throttled MutationObserver and IntersectionObserver:
```javascript
window.addEventListener("scroll", schedule, { passive: true, capture: true });
const observer = new MutationObserver(schedule);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "sizes", "class"],
});
```

### Build Output Structure

After `npm run build`, the `dist/` folder becomes the loadable extension:
- `dist/index.html` - Popup entry point
- `dist/content.js` - Copied from `public/` (not bundled by Vite)
- `dist/manifest.json` - Copied from `public/`

## Development Commands

```bash
npm install     # Install dependencies
npm run dev     # Start Vite dev server (for popup development only)
npm run build   # Build for production - creates loadable extension in dist/
npm run lint    # Run ESLint
```

**Important**: Changes to `public/content.js` require a full rebuild AND extension reload in Chrome.

## Extension Loading

1. Run `npm run build`
2. Go to `chrome://extensions/`
3. Enable Developer Mode
4. Click "Load unpacked" → select `dist/` folder
5. After code changes: rebuild → click refresh icon on extension card

## File Conventions

| Location | Purpose |
|----------|---------|
| `public/content.js` | Content script (vanilla JS, not processed by Vite) |
| `public/content.css` | CSS overrides for the paywall veil, pointer locks and banner |
| `public/manifest.json` | Extension manifest (Manifest V3) |
| `src/` | React popup UI (TypeScript + Tailwind) |
| `public/icons/` | Extension icons (16, 48, 128px) |

## Common Modification Points

- **Targeting new Mobbin elements**: Update selectors in `handleModifications()` in [public/content.js](../public/content.js)
- **Adding permissions**: Edit [public/manifest.json](../public/manifest.json)
- **Popup UI changes**: Modify [src/App.tsx](../src/App.tsx) (uses Tailwind CSS)
