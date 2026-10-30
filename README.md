# Mobbin Scene Unblur Extension

This browser extension removes the blur/veil on Mobbin.com screen previews and restores them to their full resolution.

## Features

- **Full-resolution screens**: Mobbin's `src` attribute only holds a small preview, but `srcset` still contains the full-size candidates. The extension pins each visible screen to its largest candidate (`1920w`) and removes `srcset`/`sizes` so the browser cannot fall back to the thumbnail.
- **Original-image fallback**: When a screen has no large `srcset` candidate, the extension reuses the original `screenUrl` exposed in the page payload through its equivalent public Bytescale path. If that URL is stale, the previous image is restored.
- **Paywall cleanup**: Removes the `pointer-events-none` lock and hides the `backdrop-blur` veil layers and the sticky upgrade banner.
- **Lazy processing**: Images are upgraded with an `IntersectionObserver` (about 800px around the viewport) so the extension does not download every full-resolution screen at once.

## Install without building (recommended)

Download the packaged extension from the latest release:

**[UNBLUR-MOBBIN-v1.1-INSTALAR.zip](https://github.com/nicosanchezc1-oss/unblur-mobbin/releases/latest/download/UNBLUR-MOBBIN-v1.1-INSTALAR.zip)**

> Do **not** use GitHub's "Source code (zip)" archive: it only contains the source and has no built extension.

1. Unzip the download.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`, Brave: `brave://extensions/`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `unblur-mobbin-v1.1` folder (the one containing `manifest.json`).
5. Open Mobbin and reload the page.

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

1. Picks the largest `srcset` candidate and sets it as `src`.
2. Removes `srcset` and `sizes`.
3. Falls back to the original Supabase `screenUrl` (via Bytescale) when no large candidate exists.
4. Removes `pointer-events-none` and hides the paywall blur layers.

The logic is split across `public/content.js` and `public/content.css`.

## Contributing

If you’d like to contribute to this project, please follow these steps:

1. Fork the repository.
2. Create a feature branch (\`git checkout -b feature/YourFeature\`).
3. Commit your changes (\`git commit -am 'Add new feature'\`).
4. Push to the branch (\`git push origin feature/YourFeature\`).
5. Create a Pull Request.
