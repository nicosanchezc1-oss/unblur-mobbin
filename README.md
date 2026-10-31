# Mobbin Scene Unblur Extension

This browser extension removes the blur/veil on Mobbin.com screen previews and restores them to their full resolution.

## Features

- **Full-resolution screens**: Mobbin's image URL contains the canonical unsigned asset (`.../content/app_screens/<asset>.png`). Some pages render it with a downscale query (`?w=15`); the extension strips the query and pins the image to the native capture (e.g. 1179×2556) on every route.
- **Paywall cleanup**: Hides the `backdrop-blur` veil layers (the exact `bg-[hsl(var(--neutral-0)/40%)] backdrop-blur-[10px]` overlay used on locked cells), removes wrapper blur filters and re-enables pointer events.
- **Works on app detail pages too**: The asset path is resolved directly from the image URL, so it does not depend on the page payload being present in the HTML. When a signed URL is used instead, the extension also reads Mobbin's payload and app screens API.
- **Lazy processing**: Images are upgraded with an `IntersectionObserver` (about 1200px around the viewport) so the extension does not download every full-resolution screen at once.

## Install without building (recommended)

Download the packaged extension from the latest release:

**[UNBLUR-MOBBIN-v1.3-INSTALAR.zip](https://github.com/nicosanchezc1-oss/unblur-mobbin/releases/download/v1.3/UNBLUR-MOBBIN-v1.3-INSTALAR.zip)**

Release page: <https://github.com/nicosanchezc1-oss/unblur-mobbin/releases/tag/v1.3>

> Do **not** use GitHub's "Source code (zip)" archive: it only contains the source and has no built extension.

1. Unzip the download.
2. Open `chrome://extensions/` (Edge: `edge://extensions/`, Brave: `brave://extensions/`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `unblur-mobbin-v1.3` folder (the one containing `manifest.json`).
5. Remove any older copy of this extension (and any other "Mobbin Cracker" extension) so two scripts do not fight over the same images.
6. Open Mobbin and reload the page.
7. Optional check: open DevTools (F12) and look for `[Unblur Mobbin] v1.3.0 activo` in the Console.

If you still see blur, scroll the page: screens are upgraded when they get near the viewport. If a specific page still fails, the console prints an `[Unblur Mobbin] diagnóstico` object with the image URL, decoded size and whether a blur veil was found.

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

Mobbin serves each screenshot through a `CdnImg` component. The rendered URL either points to the canonical unsigned asset (`/content/app_screens/<asset>.png`) or to a transformed derivative (`?w=15`, `enc=...`). For every screen image near the viewport, `content.js`:

1. Derives the canonical asset URL from the image itself and drops the transform query.
2. Falls back to the screen's `screenUrl` from the page payload (and, on app pages, from `/api/app/fetch-app-versions-screens`), then to the largest `srcset` candidate.
3. Removes `srcset`/`sizes` and restores the previous image if the canonical URL fails.
4. Removes `pointer-events-none` and hides the paywall `backdrop-blur` veil layers on every route.

The logic is split across `public/content.js` and `public/content.css`.

## Contributing

If you’d like to contribute to this project, please follow these steps:

1. Fork the repository.
2. Create a feature branch (\`git checkout -b feature/YourFeature\`).
3. Commit your changes (\`git commit -am 'Add new feature'\`).
4. Push to the branch (\`git push origin feature/YourFeature\`).
5. Create a Pull Request.
