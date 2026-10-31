# Unblur Mobbin

A browser extension that removes the blur on Mobbin.com screen previews and restores the **original full-resolution screenshots**, including on app detail pages where most screens are "locked" behind the paywall.

## What it fixes (v1.4)

- **Locked / restricted screens**: Mobbin serves most app-detail cells as a signed placeholder (`.../prod/file.webp?enc=...`, about 286 px wide) plus a `backdrop-blur-[10px]` veil. The extension resolves the real asset for those cells and loads the native capture (e.g. 1179x2556) instead of the placeholder.
- **All routes**: works on app detail (`/apps/.../screens` and `/flows`), screen pages (`/screens/...`), explore and discover lists, including the small preview carousels inside app cards.
- **Paywall veil**: hides the `bg-[hsl(var(--neutral-0)/40%)] backdrop-blur-[10px]` overlay, clears wrapper `filter`/`backdrop-filter` and re-enables pointer events.
- **No broken images**: if a replacement fails, the previous image is restored.
- **Visible confirmation**: a green badge appears bottom-right for a few seconds — `Unblur Mobbin v1.4.0 · N capturas nítidas`.

## Install without building (recommended)

Download the packaged extension from the latest release:

**[UNBLUR-MOBBIN-v1.4-INSTALAR.zip](https://github.com/nicosanchezc1-oss/unblur-mobbin/releases/download/v1.4/UNBLUR-MOBBIN-v1.4-INSTALAR.zip)**

Release page: <https://github.com/nicosanchezc1-oss/unblur-mobbin/releases/tag/v1.4>

> Do **not** use GitHub's "Source code (zip)" archive: it only contains the source and has no built extension.

1. Unzip the download.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`, Brave: `brave://extensions/`).
3. Enable **Developer mode**.
4. **Remove any older copy** of this extension, and disable/remove other Mobbin extensions (e.g. "Mobbin Cracker") so two scripts do not fight over the same images.
5. Click **Load unpacked** and select the `unblur-mobbin-v1.4` folder (the one containing `manifest.json`).
6. Open Mobbin and reload the page.

Optional check: open DevTools (F12). The console prints `[Unblur Mobbin] v1.4.0 activo` and, after a few seconds, an `[Unblur Mobbin] diagnóstico` object with the number of mapped screens, upgraded images and any remaining veil.

If a screenshot still looks soft:

- Scroll it into view; screens are upgraded when they get near the viewport.
- Check that the green badge appeared. If it did not, the extension is not loaded (or another folder was loaded).
- Copy the `diagnóstico` object from the console: it lists the remaining image URLs, their decoded size and whether a blur veil is still present.

## How it works

Mobbin renders every screenshot through a `CdnImg` component and hides the real asset in one of three ways:

1. `...content/app_screens/<asset>.png?w=15` — a downscaled transform of the real asset.
2. `.../prod/file.webp?enc=...` — a signed placeholder that does not contain the asset id at all, plus a `backdrop-blur` veil.
3. A wrapper with `filter: blur(...)`.

`content.js` recovers the original asset from the Next.js flight payload and from Mobbin's own `POST /api/app/fetch-app-versions-screens`, which returns `screenUrl` (`content/app_screens/<asset>.png`) for every screen of the app, restricted ones included. The asset is then requested from bytescale **without** a transform query (`.../prod/content/app_screens/<asset>.png`), which serves the native capture (1179x2556, 1125x2436, ...).

Per image, in order:

1. Canonical asset path already in the URL -> drop the query.
2. Signed thumbnail URL or screen id -> original asset from the payload/API map.
3. Largest signed rendition (`1920w`) as a fallback while the API answers.
4. Largest `srcset` candidate.

Images are processed near the viewport (IntersectionObserver plus a direct viewport check, because some lazy lists never report intersection), and the same `src` is force-reloaded once when the element keeps a stale low-resolution bitmap.

The logic lives in `public/content.js` and `public/content.css`.

## Build from source

```sh
gh repo clone nicosanchezc1-oss/unblur-mobbin
cd unblur-mobbin
npm install
npm run build
```

Then open `chrome://extensions/`, enable **Developer mode**, click **Load unpacked** and select the generated `dist` folder.

## Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/YourFeature`).
3. Commit your changes (`git commit -am 'Add new feature'`).
4. Push to the branch (`git push origin feature/YourFeature`).
5. Open a Pull Request.
