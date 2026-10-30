# Mobbin Scene Unblur Extension

This browser extension removes the blur/veil on Mobbin.com screen previews and restores them to their full resolution.

## Features

- **Full-resolution screens**: Mobbin's `src` attribute only holds a small preview, but `srcset` still contains the full-size candidates. The extension pins each visible screen to its largest candidate (`1920w`) and removes `srcset`/`sizes` so the browser cannot fall back to the thumbnail.
- **Canonical original image**: When the page payload exposes the screen's `screenUrl`, the extension loads the original `app_screens/<id>.png` from Bytescale instead. That file is the real native capture (e.g. 1179×2556) and is never a blurred preview. If the URL is stale, the previous image is restored automatically.
- **Works on detail pages too**: The original image is also resolved from the URL when the screenshot is not wrapped in a screen link.
- **Paywall cleanup**: Removes the `pointer-events-none` lock and hides the `backdrop-blur` veil layers and the sticky upgrade banner.
- **Lazy processing**: Images are upgraded with an `IntersectionObserver` (about 800px around the viewport) so the extension does not download every full-resolution screen at once.

## Install without building (recommended)

Download the packaged extension from the latest release:

**[UNBLUR-MOBBIN-v1.2-INSTALAR.zip](https://github.com/nicosanchezc1-oss/unblur-mobbin/releases/latest/download/UNBLUR-MOBBIN-v1.2-INSTALAR.zip)**

> Do **not** use GitHub's "Source code (zip)" archive: it only contains the source and has no built extension.

1. Unzip the download.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`, Brave: `brave://extensions/`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `unblur-mobbin-v1.2` folder (the one containing `manifest.json`).
5. Open Mobbin and reload the page.
6. Optional check: open DevTools (F12) and look for `[Unblur Mobbin] v1.2.0 activo` in the Console.

If you still see blur, scroll the page: screens are upgraded only when they get near the viewport. Also remove any previous copy of the extension, then reload it from `chrome://extensions/`.

## Build from source

1. **Clone the Repository**

   \`\`\`sh
   gh repo clone nicosanchezc1-oss/unblur-mobbin
   cd unblur-mobbin
   \`\`\`

2. **Install Dependencies**

   This project uses Vite for bundling. Install dependencies with:

   \`\`\`sh
   npm install
   \`\`\`

   or

   \`\`\`sh
   yarn install
   \`\`\`

3. **Build the Extension**

   To build the extension for your browser, run:

   \`\`\`sh
   npm run build
   \`\`\`

   or

   \`\`\`sh
   yarn build
   \`\`\`

4. **Load the Extension**

   - Open your browser and navigate to the Extensions page (e.g., \`chrome://extensions/\` for Chrome).
   - Enable "Developer mode".
   - Click "Load unpacked" and select the \`dist\` directory created by the build process.

## Usage

Once installed, the extension works automatically on Mobbin.com. Open Mobbin and the screens you see will load at full resolution, without the blur veil or the locked pointer events.

## How it works

Mobbin serves screen previews through signed Bytescale URLs. The `src` attribute is a low-resolution preview, but the `srcset` still lists the larger candidates (`360w`, `720w`, `1920w`). For every screen image near the viewport, `content.js`:

1. Resolves the screen id from its link (or from the page URL on detail pages) and looks up the original `screenUrl` in the page payload.
2. Loads the canonical `app_screens/<id>.png` from Bytescale when available; otherwise picks the largest `srcset` candidate.
3. Removes `srcset`/`sizes` and restores the previous image if the canonical URL fails.
4. Removes `pointer-events-none` and hides the paywall blur layers.

The logic is split across `public/content.js` and `public/content.css`.

## Contributing

If you’d like to contribute to this project, please follow these steps:

1. Fork the repository.
2. Create a feature branch (\`git checkout -b feature/YourFeature\`).
3. Commit your changes (\`git commit -am 'Add new feature'\`).
4. Push to the branch (\`git push origin feature/YourFeature\`).
5. Create a Pull Request.
