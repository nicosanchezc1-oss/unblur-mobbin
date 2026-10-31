/*
 * Unblur Mobbin content script.
 *
 * Mobbin renders every screen through a `CdnImg` component. Three different
 * things can hide the real screenshot:
 *
 *   1. Unlocked screens on /explore: `...content/app_screens/<asset>.png?w=15`
 *      (a downscaled transform of the real asset).
 *   2. Locked screens: `.../prod/file.webp?enc=...`, a signed placeholder whose
 *      URL does not contain the asset id at all, plus a
 *      `backdrop-blur-[10px]` veil layer on top.
 *   3. Some layouts blur the wrapper (`filter: blur(...)`) instead of a veil.
 *
 * The full-resolution asset can still be resolved:
 *   - the Next.js flight payload maps every screen `id` to a `screenUrl`; when
 *     the screen is restricted that URL is the signed placeholder, but the
 *     `screenCdnImgSources` block next to it lists the 1920w rendition,
 *   - `/api/app/fetch-app-versions-screens` returns the original
 *     `content/app_screens/<asset>.png` for every screen of the app, including
 *     the restricted ones.
 * The original asset is then requested from bytescale WITHOUT a transform
 * query (`.../prod/content/app_screens/<asset>.png`), which serves the native
 * capture (e.g. 1179x2556) instead of the 286px preview.
 *
 * Strategies per image, in order:
 *   1. canonical asset path already in the image URL -> drop the query,
 *   2. signed thumbnail URL -> screen id -> original asset,
 *   3. screen id from the surrounding link or the current route -> original,
 *   4. largest `srcset` candidate.
 * A failed replacement rolls back to the previous image.
 */

(() => {
  const VERSION = "1.4.0";
  const SCREEN_FRAME_SELECTOR =
    '[class*="screen-border-radius"], [class*="screen-inset-border"]';
  const SCREEN_ANCHOR_SELECTOR =
    'a[href*="/screens/"], a[href*="/explore/screens/"], a[href*="/explore/flows/"]';
  const SCREEN_IMAGE_SELECTOR = [
    'img[data-sentry-component="CdnImg"]',
    'img[data-sentry-source-file="ScreenCellImage.tsx"]',
    "img[srcset]",
    'img[src*="app_screens"]',
    'img[src*="app_fullpage_screens"]',
    'img[src*="user_screens"]',
    'img[src*="file.webp"]',
  ].join(", ");
  const ASSET_PATH_PATTERN =
    /\/(?:content|public)\/(app_screens|app_fullpage_screens|user_screens)\/[0-9a-f-]{36}\.[a-z0-9]+/i;
  const SCREEN_ID_PATTERN = /\/screens\/([0-9a-f-]{36})/i;
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const MIN_CANDIDATE_WIDTH = 700;
  const DIAGNOSTICS_DELAY = 6000;
  const BACKSLASH_QUOTE = String.fromCharCode(92) + '"';

  /**
   * id -> { originalPath, signed, best }
   * `originalPath` is `content/app_screens/<asset>.png`, `best` is the largest
   * signed rendition (1920w) used until the API provides the original.
   */
  const screenEntries = new Map();
  /** every URL seen for a screen (thumbnail, srcset renditions) -> screen id */
  const urlToScreenId = new Map();

  const appliedUrl = new WeakMap();
  const visibleImages = new WeakMap();
  const failedUrls = new WeakMap();
  const reloadedUrls = new WeakMap();

  let bytescaleBase = null;
  let lastPayloadSignature = null;
  let lastPathname = window.location.pathname;
  let appScreensRequested = false;
  let appScreensAttempts = 0;
  let scheduled = false;

  function schedule() {
    if (scheduled) {
      return;
    }
    scheduled = true;

    const run = () => {
      scheduled = false;
      try {
        handleModifications();
      } catch (error) {
        console.error("Unblur Mobbin:", error);
      }
    };

    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(run);
    } else {
      window.setTimeout(run, 50);
    }
  }

  function normalizeUrl(raw) {
    if (!raw) {
      return "";
    }
    return String(raw).replace(/&amp;/g, "&").trim();
  }

  function parseJsonish(raw) {
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw.split(BACKSLASH_QUOTE).join('"'));
    } catch (error) {
      return null;
    }
  }

  function assetPathFromUrl(url) {
    const value = normalizeUrl(url);
    const match = value.match(ASSET_PATH_PATTERN);
    return match ? value.slice(match.index + 1) : null;
  }

  function widthsFromSources(sources) {
    const list = [];
    if (!sources) {
      return list;
    }
    if (sources.src) {
      list.push({ url: normalizeUrl(sources.src), width: 0 });
    }
    if (Array.isArray(sources.srcSet)) {
      for (const entry of sources.srcSet) {
        if (!entry || !entry.url) {
          continue;
        }
        const widthMatch = String(entry.descriptor || "").match(/(\d+)\s*w/i);
        list.push({
          url: normalizeUrl(entry.url),
          width: widthMatch ? Number(widthMatch[1]) : 0,
        });
      }
    }
    return list;
  }

  function recordScreen(id, screenUrl, sources) {
    if (!id) {
      return;
    }

    let entry = screenEntries.get(id);
    if (!entry) {
      entry = { originalPath: null, signed: null, best: null };
      screenEntries.set(id, entry);
    }

    const path = assetPathFromUrl(screenUrl);
    if (path) {
      entry.originalPath = path;
    } else if (screenUrl) {
      entry.signed = normalizeUrl(screenUrl);
    }

    const variants = widthsFromSources(sources);
    let best = entry.best;
    let bestWidth = -1;
    for (const variant of variants) {
      if (!variant.url) {
        continue;
      }
      if (variant.width > bestWidth) {
        bestWidth = variant.width;
        best = variant.url;
      }
      if (!urlToScreenId.has(variant.url)) {
        urlToScreenId.set(variant.url, id);
      }
    }
    if (bestWidth > 0 && best) {
      entry.best = best;
    }

    const own = screenUrl ? normalizeUrl(screenUrl) : null;
    if (own && !urlToScreenId.has(own)) {
      urlToScreenId.set(own, id);
    }
  }

  /**
   * The flight payload is one long escaped string. Each screen object keeps
   * `id` and `screenUrl` far apart, so walking back to the closest `"id"`
   * (instead of requiring adjacent keys) is what makes the map complete.
   */
  function scanPayload() {
    let text = "";
    try {
      text = Array.from(document.scripts, (script) => script.textContent || "").join("\n");
    } catch (error) {
      return false;
    }

    const signature = document.scripts.length + ":" + text.length;
    if (signature === lastPayloadSignature) {
      return false;
    }
    lastPayloadSignature = signature;

    const idPattern = new RegExp('\\\\?"id\\\\?":\\\\?"(' + UUID + ')\\\\?"', "g");
    const ids = [];
    let match;
    while ((match = idPattern.exec(text)) !== null) {
      ids.push({ id: match[1], at: match.index });
    }
    if (!ids.length) {
      return false;
    }

    const before = screenEntries.size + urlToScreenId.size;
    const urlPattern = /\\?"screenUrl\\?":\\?"(https:[^"\\]+)\\?"/g;
    while ((match = urlPattern.exec(text)) !== null) {
      const screenUrl = normalizeUrl(match[1]);
      const at = match.index;

      let owner = null;
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        if (ids[index].at < at) {
          owner = ids[index];
          break;
        }
      }
      // A screen object is a few KB; anything farther away is a different one.
      if (!owner || at - owner.at > 12000) {
        continue;
      }

      recordScreen(owner.id, screenUrl, sourcesBlockBefore(text, at, owner.at));
    }

    // Some routes (discover, flows) list screens with `id` + `screenCdnImgSources`
    // but no `screenUrl`; index their signed renditions anyway.
    const sourcesPattern = /screenCdnImgSources/g;
    while ((match = sourcesPattern.exec(text)) !== null) {
      const at = match.index;

      let owner = null;
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        if (ids[index].at < at) {
          owner = ids[index];
          break;
        }
      }
      if (!owner || at - owner.at > 4000) {
        continue;
      }

      const open = text.indexOf("{", at);
      if (open === -1) {
        continue;
      }

      let depth = 0;
      let close = -1;
      for (let index = open; index < text.length; index += 1) {
        const char = text[index];
        if (char === "{") {
          depth += 1;
        } else if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            close = index;
            break;
          }
        }
      }
      if (close === -1) {
        continue;
      }

      recordScreen(owner.id, null, parseJsonish(text.slice(open, close + 1)));
    }

    return screenEntries.size + urlToScreenId.size > before;
  }

  /** Parse the `screenCdnImgSources` object that precedes `at` in `text`. */
  function sourcesBlockBefore(text, at, ownerAt) {
    const keyAt = text.lastIndexOf("screenCdnImgSources", at);
    if (keyAt === -1 || keyAt < ownerAt) {
      return null;
    }

    const open = text.indexOf("{", keyAt);
    if (open === -1 || open > at) {
      return null;
    }

    let depth = 0;
    for (let index = open; index < at; index += 1) {
      const char = text[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return parseJsonish(text.slice(open, index + 1));
        }
      }
    }

    return null;
  }

  function screenIdFromText(value) {
    if (!value) {
      return null;
    }
    const match = String(value).match(SCREEN_ID_PATTERN);
    return match ? match[1] : null;
  }

  function parseSrcset(srcset) {
    if (!srcset) {
      return [];
    }

    const candidates = [];
    for (const part of srcset.split(",")) {
      const bits = part.trim().split(/\s+/);
      const url = normalizeUrl(bits[0]);
      if (!url || url.startsWith("data:")) {
        continue;
      }

      let width = 0;
      for (let index = 1; index < bits.length; index += 1) {
        const widthMatch = bits[index].match(/^(\d+)w$/i);
        if (widthMatch) {
          width = Number(widthMatch[1]);
        }

        const densityMatch = bits[index].match(/^([\d.]+)x$/i);
        if (densityMatch) {
          width = Math.round(Number(densityMatch[1]) * 1000);
        }
      }

      candidates.push({ url, width });
    }

    return candidates;
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(normalizeUrl(url), window.location.href).href;
    } catch (error) {
      return normalizeUrl(url);
    }
  }

  function getLargestCandidateUrl(img) {
    const candidates = parseSrcset(img.getAttribute("srcset"));
    if (!candidates.length) {
      return null;
    }

    let best = candidates[0];
    for (const candidate of candidates) {
      if (candidate.width > best.width) {
        best = candidate;
      }
    }

    if (best.width < MIN_CANDIDATE_WIDTH) {
      return null;
    }

    return toAbsoluteUrl(best.url);
  }

  function bytescaleBaseFromUrl(src) {
    if (!src) {
      return null;
    }

    try {
      const url = new URL(src, window.location.href);
      if (!url.hostname.endsWith("bytescale.mobbin.com")) {
        return null;
      }

      const marker = "/image/mobbin.com/prod/";
      const index = url.pathname.indexOf(marker);
      if (index === -1) {
        return null;
      }

      return url.origin + url.pathname.slice(0, index + marker.length);
    } catch (error) {
      return null;
    }
  }

  function detectBytescaleBase() {
    if (bytescaleBase) {
      return bytescaleBase;
    }

    const img = document.querySelector('img[src*="bytescale.mobbin.com"]');
    if (img) {
      bytescaleBase = bytescaleBaseFromUrl(img.currentSrc || img.src);
    }

    return bytescaleBase;
  }

  /** `content/app_screens/<asset>.png` -> unsigned bytescale asset URL. */
  function bytescaleUrlForAssetPath(path) {
    const base = detectBytescaleBase();
    return base && path ? base + path : null;
  }

  /**
   * Canonical unsigned asset URL when the image URL already carries it.
   * Query params (`?w=15`, `enc=...`, `f=png`) only request a derivative.
   */
  function canonicalFromImageUrl(img) {
    const candidates = [];
    if (img.currentSrc) {
      candidates.push(img.currentSrc);
    }

    const src = img.getAttribute("src");
    if (src) {
      candidates.push(src);
    }

    for (const candidate of parseSrcset(img.getAttribute("srcset"))) {
      candidates.push(candidate.url);
    }

    for (const raw of candidates) {
      let url;
      try {
        url = new URL(raw, window.location.href);
      } catch (error) {
        continue;
      }

      if (!url.hostname.endsWith("bytescale.mobbin.com")) {
        continue;
      }

      const match = url.pathname.match(ASSET_PATH_PATTERN);
      if (!match) {
        continue;
      }

      const path = url.pathname.slice(0, match.index) + match[0];
      return url.origin + path;
    }

    return null;
  }

  function imageUrls(img) {
    const urls = [];
    if (img.currentSrc) {
      urls.push(normalizeUrl(img.currentSrc));
    }
    const src = img.getAttribute("src");
    if (src) {
      urls.push(normalizeUrl(src));
    }
    for (const candidate of parseSrcset(img.getAttribute("srcset"))) {
      urls.push(candidate.url);
    }
    return urls;
  }

  function screenIdForImage(img) {
    for (const url of imageUrls(img)) {
      const id = urlToScreenId.get(url);
      if (id) {
        return id;
      }
    }

    const link = img.closest("a[href]");
    if (link) {
      const id = screenIdFromText(link.getAttribute("href"));
      if (id) {
        return id;
      }
    }

    // Detail pages render the main screenshot outside any screen link. Reuse
    // the page id, but only for images inside a screen frame.
    if (img.closest(SCREEN_FRAME_SELECTOR)) {
      return screenIdFromText(window.location.pathname);
    }

    return null;
  }

  /**
   * Signed renditions are a fallback for restricted screens, not a goal by
   * themselves: only swap when the current pixels are clearly below 2x the
   * rendered size, otherwise small cards would download huge images for nothing.
   */
  function shouldUseSignedRendition(img, url) {
    const displayWidth = img.getBoundingClientRect().width;
    if (!displayWidth) {
      return false;
    }
    if (url === (img.currentSrc || img.getAttribute("src"))) {
      return false;
    }
    return (img.naturalWidth || 0) < Math.max(displayWidth * 2, 320);
  }

  /**
   * Mobbin sometimes sets the full-size URL while the element keeps a small
   * bitmap loaded earlier (the attribute already has the right URL, so it does
   * not reload). Re-assigning the very same `src` is a no-op, so drop the
   * attribute first. Done at most once per URL and element.
   */
  function forceReload(img, url) {
    let seen = reloadedUrls.get(img);
    if (!seen) {
      seen = new Set();
      reloadedUrls.set(img, seen);
    }
    if (seen.has(url)) {
      return false;
    }
    seen.add(url);

    img.removeAttribute("src");
    if (img.hasAttribute("srcset")) {
      img.removeAttribute("srcset");
    }
    img.setAttribute("src", url);
    return true;
  }

  function needsReload(img) {
    const displayWidth = img.getBoundingClientRect().width;
    if (!displayWidth || !img.complete) {
      return false;
    }

    const current = img.getAttribute("src");
    if (!current) {
      return false;
    }

    // Only for URLs we know belong to a screen; other images (logos, avatars)
    // can legitimately be small.
    const id = urlToScreenId.get(current);
    const entry = id ? screenEntries.get(id) : null;
    if (!entry) {
      return false;
    }

    const naturalWidth = img.naturalWidth || 0;
    return naturalWidth > 0 && naturalWidth < displayWidth * 1.1;
  }

  function isScreenImage(img) {
    if (img.closest(SCREEN_FRAME_SELECTOR) || img.closest(SCREEN_ANCHOR_SELECTOR)) {
      return true;
    }

    const className = typeof img.className === "string" ? img.className : "";
    return /object-top/.test(className) && /object-cover/.test(className);
  }

  function hasFailed(img, url) {
    const failed = failedUrls.get(img);
    return Boolean(failed && failed.has(url));
  }

  function markFailed(img, url) {
    let failed = failedUrls.get(img);
    if (!failed) {
      failed = new Set();
      failedUrls.set(img, failed);
    }
    failed.add(url);
  }

  function applyImageUrl(img, url) {
    if (!url) {
      return false;
    }

    const alreadyApplied =
      appliedUrl.get(img) === url &&
      img.getAttribute("src") === url &&
      !img.hasAttribute("srcset") &&
      !img.hasAttribute("sizes");

    if (alreadyApplied) {
      return false;
    }

    if (img.hasAttribute("srcset")) {
      img.removeAttribute("srcset");
    }
    if (img.hasAttribute("sizes")) {
      img.removeAttribute("sizes");
    }
    if (img.getAttribute("src") !== url) {
      img.src = url;
    }

    appliedUrl.set(img, url);
    return true;
  }

  function applyOriginalFallback(img, originalUrl) {
    if (!originalUrl || hasFailed(img, originalUrl)) {
      return false;
    }

    const previousSrc = img.getAttribute("src");
    const previousSrcset = img.getAttribute("srcset");
    const previousSizes = img.getAttribute("sizes");

    if (!applyImageUrl(img, originalUrl)) {
      return false;
    }

    const markUpgraded = () => {
      img.dataset.unblur = VERSION;
    };

    const onLoad = () => {
      img.removeEventListener("error", onError);
      markUpgraded();
    };

    const onError = () => {
      img.removeEventListener("load", onLoad);
      markFailed(img, originalUrl);
      appliedUrl.delete(img);
      if (img.dataset.unblur) {
        delete img.dataset.unblur;
      }

      // Another run may have swapped the image in the meantime; only restore
      // when the failed URL is still the one in use.
      if (img.getAttribute("src") !== originalUrl) {
        return;
      }

      if (previousSrc === null) {
        img.removeAttribute("src");
      } else {
        img.setAttribute("src", previousSrc);
      }
      if (previousSrcset !== null) {
        img.setAttribute("srcset", previousSrcset);
      }
      if (previousSizes !== null) {
        img.setAttribute("sizes", previousSizes);
      }
    };

    img.addEventListener("load", onLoad, { once: true });
    img.addEventListener("error", onError, { once: true });

    if (img.complete && img.naturalWidth > 0) {
      img.removeEventListener("error", onError);
      markUpgraded();
    }

    return true;
  }

  function upgradeImage(img) {
    if (!isScreenImage(img)) {
      return;
    }

    // 1. The canonical asset path is already in the URL: drop the query.
    const current = img.getAttribute("src") || "";
    const canonicalUrl = canonicalFromImageUrl(img);
    if (canonicalUrl === current) {
      if (img.complete && img.naturalWidth > 0) {
        img.dataset.unblur = VERSION;
      }
    } else if (applyOriginalFallback(img, canonicalUrl)) {
      return;
    }

    // 2. Signed thumbnail URL / screen link -> screen entry.
    const id = screenIdForImage(img);
    const entry = id ? screenEntries.get(id) : null;

    if (entry) {
      const originalUrl = entry.originalPath
        ? bytescaleUrlForAssetPath(entry.originalPath)
        : null;
      const targetUrl = originalUrl || entry.best || entry.signed || null;

      if (targetUrl && !hasFailed(img, targetUrl)) {
        if (targetUrl === current) {
          // The URL is already right; a smaller bitmap means the element kept
          // a stale load and has to be refreshed.
          if (needsReload(img)) {
            if (forceReload(img, targetUrl)) {
              return;
            }
          } else if (img.complete && img.naturalWidth > 0) {
            img.dataset.unblur = VERSION;
          }
        } else if (originalUrl || shouldUseSignedRendition(img, targetUrl)) {
          if (applyOriginalFallback(img, targetUrl)) {
            return;
          }
        }
      }
    }

    // 3. A previous run may already have removed `srcset`. Re-apply the URL we
    //    picked instead of falling back to the thumbnail.
    const targetUrl = getLargestCandidateUrl(img) || appliedUrl.get(img);
    if (targetUrl) {
      applyImageUrl(img, targetUrl);
    }
  }

  /**
   * The observer is only an optimisation: some layouts (and lazy lists) never
   * report intersection before the first paint, so fall back to a direct
   * viewport test. Otherwise a visible card can stay blurred forever.
   */
  function isNearViewport(img) {
    const rect = img.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      return false;
    }
    return rect.bottom > -1500 && rect.top < window.innerHeight + 1500;
  }

  function observeImage(img) {
    if (!isScreenImage(img)) {
      return;
    }

    if (!visibleImages.has(img)) {
      visibleImages.set(img, false);
      intersectionObserver.observe(img);
    }

    if (visibleImages.get(img) || isNearViewport(img)) {
      upgradeImage(img);
    }
  }

  function isScreenRelated(element) {
    if (element.matches(SCREEN_ANCHOR_SELECTOR)) {
      return true;
    }

    return Boolean(
      element.querySelector(
        'img[data-sentry-component="CdnImg"], img[data-sentry-source-file="ScreenCellImage.tsx"]'
      )
    );
  }

  function unlockElement(element) {
    if (!isScreenRelated(element)) {
      return;
    }

    element.classList.remove("pointer-events-none");

    if (element.getAttribute("tabindex") === "-1") {
      element.setAttribute("tabindex", "0");
    }
  }

  function hidePaywallOverlays() {
    const overlays = document.querySelectorAll(
      '[class*="backdrop-blur"], [style*="backdrop-filter"], [style*="backdropFilter"]'
    );

    overlays.forEach((element) => {
      if (element.tagName === "IMG") {
        return;
      }

      // Never hide a wrapper that contains the screenshot itself.
      if (element.querySelector("img")) {
        return;
      }

      const className =
        typeof element.className === "string" ? element.className : "";
      const style = element.getAttribute("style") || "";
      const hasBlurClass = className.includes("backdrop-blur");
      const hasBlurStyle = /backdrop-?filter/i.test(style);
      if (!hasBlurClass && !hasBlurStyle) {
        return;
      }

      const inScreen = Boolean(
        element.closest(SCREEN_FRAME_SELECTOR) ||
          element.closest(SCREEN_ANCHOR_SELECTOR)
      );
      // The exact veil Mobbin renders on locked cells:
      // <div class="absolute inset-0 bg-[hsl(var(--neutral-0)/40%)] backdrop-blur-[10px]">
      const isKnownPaywallVeil =
        /backdrop-blur-\[(?:6|8|10|12|16)px\]/.test(className) ||
        /hsl\(var\(--neutral-0\)\/40%\)/.test(className);

      if (!inScreen && !isKnownPaywallVeil) {
        return;
      }

      element.style.setProperty("display", "none", "important");
    });
  }

  function clearWrapperBlur() {
    document.querySelectorAll(SCREEN_FRAME_SELECTOR).forEach((frame) => {
      const style = frame.getAttribute("style") || "";
      if (!/blur|filter/i.test(style)) {
        return;
      }
      frame.style.setProperty("filter", "none", "important");
      frame.style.setProperty("-webkit-backdrop-filter", "none", "important");
      frame.style.setProperty("backdrop-filter", "none", "important");
    });
  }

  function collectScreenObjects(value, depth) {
    if (!value || typeof value !== "object" || depth > 10) {
      return;
    }

    if (typeof value.id === "string" && typeof value.screenUrl === "string") {
      recordScreen(value.id, value.screenUrl, value.screenCdnImgSources || null);
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        collectScreenObjects(entry, depth + 1);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      collectScreenObjects(value[key], depth + 1);
    }
  }

  /**
   * On `/apps/<slug>/<appId>/<version>/screens` the list is paginated; this
   * endpoint returns every screen with its original `screenUrl`, restricted
   * ones included. The URL is absolute on purpose: a relative URL inside an
   * isolated content-script world can resolve against the extension origin.
   */
  function enrichFromAppApi() {
    if (appScreensRequested) {
      return;
    }

    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments[0] !== "apps" || segments.length < 4) {
      return;
    }

    const idMatch = segments[1].match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    if (!idMatch) {
      return;
    }

    appScreensRequested = true;
    appScreensAttempts += 1;

    fetch(window.location.origin + "/api/app/fetch-app-versions-screens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: idMatch[0] }),
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (!json) {
          throw new Error("empty response");
        }
        collectScreenObjects(json, 0);
        schedule();
      })
      .catch(() => {
        // The payload scan already covers the first page; retry once in case
        // the endpoint was momentarily unavailable.
        if (appScreensAttempts < 2) {
          appScreensRequested = false;
          window.setTimeout(enrichFromAppApi, 3000);
        }
      });
  }

  function countUpgraded() {
    return document.querySelectorAll("img[data-unblur]").length;
  }

  function screenImages() {
    return Array.from(document.querySelectorAll(SCREEN_IMAGE_SELECTOR)).filter(
      isScreenImage
    );
  }

  function logDiagnostics() {
    const images = screenImages();
    const report = images.slice(0, 6).map((img) => {
      const frame = img.closest(SCREEN_FRAME_SELECTOR);
      const url = img.currentSrc || img.getAttribute("src") || "";
      return {
        src: url.slice(-58),
        kind: assetPathFromUrl(url) ? "original" : url.includes("enc=") ? "signed" : "other",
        upgraded: Boolean(img.dataset.unblur),
        veil: Boolean(
          frame &&
            frame.querySelector('[class*="backdrop-blur"],[style*="backdrop-filter"]')
        ),
      };
    });

    console.info("[Unblur Mobbin] diagnóstico", {
      version: VERSION,
      path: window.location.pathname,
      screenImages: images.length,
      upgraded: countUpgraded(),
      screens: screenEntries.size,
      urlIndex: urlToScreenId.size,
      apiRequests: appScreensAttempts,
      sample: report,
    });
  }

  function showToast() {
    const badge = document.createElement("div");
    badge.id = "unblur-mobbin-badge";
    badge.textContent = "Unblur Mobbin v" + VERSION + " activo";
    badge.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "padding:8px 12px",
      "border-radius:999px",
      "background:#16a34a",
      "color:#fff",
      "font:600 12px/1.2 system-ui,sans-serif",
      "box-shadow:0 6px 20px rgba(0,0,0,.25)",
      "pointer-events:none",
      "transition:opacity .4s ease",
    ].join(";");
    document.body.appendChild(badge);

    window.setTimeout(() => {
      badge.textContent =
        "Unblur Mobbin v" + VERSION + " · " + countUpgraded() + " capturas nítidas";
    }, 4000);

    window.setTimeout(() => {
      badge.style.opacity = "0";
      window.setTimeout(() => badge.remove(), 500);
    }, 8000);
  }

  function handleModifications() {
    try {
      scanPayload();
    } catch (error) {
      console.error("Unblur Mobbin (payload):", error);
    }

    try {
      document.querySelectorAll(SCREEN_IMAGE_SELECTOR).forEach(observeImage);
    } catch (error) {
      console.error("Unblur Mobbin (images):", error);
    }

    try {
      document.querySelectorAll(".pointer-events-none").forEach(unlockElement);
    } catch (error) {
      console.error("Unblur Mobbin (pointer):", error);
    }

    try {
      hidePaywallOverlays();
      clearWrapperBlur();
    } catch (error) {
      console.error("Unblur Mobbin (overlays):", error);
    }
  }

  function handleRouteChange() {
    if (window.location.pathname === lastPathname) {
      return;
    }

    lastPathname = window.location.pathname;
    appScreensRequested = false;
    appScreensAttempts = 0;
    lastPayloadSignature = null;
    scanPayload();
    enrichFromAppApi();
    schedule();
  }

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      let shouldSchedule = false;

      entries.forEach((entry) => {
        visibleImages.set(entry.target, entry.isIntersecting);
        if (entry.isIntersecting) {
          shouldSchedule = true;
        }
      });

      if (shouldSchedule) {
        schedule();
      }
    },
    { rootMargin: "1500px 0px" }
  );

  const mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList" && mutation.addedNodes.length) {
        schedule();
        return;
      }

      if (mutation.type === "attributes") {
        if (mutation.attributeName === "class") {
          const target = mutation.target;
          const inScreen =
            target &&
            typeof target.closest === "function" &&
            target.closest(
              'a[href*="/screens/"], [class*="screen-border-radius"], [class*="screen-inset-border"]'
            );
          if (inScreen) {
            schedule();
            return;
          }
          continue;
        }

        schedule();
        return;
      }
    }
  });

  function start() {
    console.info(
      "%c[Unblur Mobbin] v" + VERSION + " activo",
      "color:#22c55e;font-weight:bold"
    );

    scanPayload();
    handleModifications();
    enrichFromAppApi();
    showToast();

    // Debug handle: useful to inspect the maps from the page console.
    window.__unblurMobbin = {
      version: VERSION,
      screenEntries,
      urlToScreenId,
      scan: scanPayload,
      sweep: handleModifications,
    };

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "sizes", "class", "style"],
    });

    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("popstate", schedule);
    window.addEventListener("load", schedule);

    // Fast sweeps while the page hydrates and streams more screens, then a slow
    // periodic sweep for client-side navigation and lazy sections.
    let fastTicks = 0;
    const fastSweep = () => {
      fastTicks += 1;
      handleRouteChange();
      scanPayload();
      schedule();
      if (fastTicks < 15) {
        window.setTimeout(fastSweep, 2000);
      }
    };
    window.setTimeout(fastSweep, 2000);

    window.setInterval(() => {
      handleRouteChange();
      if (scanPayload()) {
        schedule();
      }
    }, 10000);

    window.setTimeout(logDiagnostics, DIAGNOSTICS_DELAY);
    schedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
