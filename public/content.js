/*
 * Unblur Mobbin content script.
 *
 * Mobbin renders every screen through a `CdnImg` component. The visible `src`
 * can be a downscaled preview (`?w=15`) and locked screens additionally get a
 * `backdrop-blur-[10px]` veil layer on top of the screenshot.
 *
 * The real asset path is always in the image URL, in the canonical unsigned
 * form `.../content/app_screens/<asset>.png`. Stripping the transform query
 * from that path returns the native capture (e.g. 1179x2556). This works on
 * every route, including app detail pages, because it does not depend on the
 * page payload being present in the HTML.
 *
 * This script therefore:
 *   1. hides the paywall veil and re-enables pointer events on screen frames,
 *   2. rewrites screen images to the canonical asset path (no query string),
 *   3. falls back to the screen's `screenUrl` from the page payload, then to
 *      the largest `srcset` candidate,
 *   4. rolls back to the previous image if a replacement fails to load.
 */

(() => {
  const VERSION = "1.3.0";
  const SCREEN_IMAGE_SELECTOR =
    'img[data-sentry-component="CdnImg"], img[data-sentry-source-file="ScreenCellImage.tsx"], img[srcset], img[src*="app_screens"], img[src*="app_fullpage_screens"], img[src*="user_screens"]';
  const MIN_CANDIDATE_WIDTH = 700;
  const SCREEN_ID_PATTERN = /\/screens\/([0-9a-f-]{36})/i;
  const SCREEN_FRAME_SELECTOR =
    '[class*="screen-border-radius"], [class*="screen-inset-border"]';
  const ASSET_PATH_PATTERN =
    /\/(?:content|public)\/(app_screens|app_fullpage_screens|user_screens)\/[0-9a-f-]{36}\.[a-z0-9]+/i;
  const DIAGNOSTICS_DELAY = 6000;

  const appliedUrl = new WeakMap();
  const visibleImages = new WeakMap();
  const failedUrls = new WeakMap();
  const screenUrlMap = new Map();
  const signedUrlToScreenUrl = new Map();

  let bytescaleBase = null;
  let lastMapRefresh = 0;
  let appScreensRequested = false;
  let scheduled = false;

  const screenUrlPatterns = [
    /\\"id\\":\\"([0-9a-f-]{36})\\",\\"screenUrl\\":\\"(https:[^\\"]+)\\"/g,
    /"id":"([0-9a-f-]{36})","screenUrl":"(https:[^"]+)"/g,
  ];

  function schedule() {
    if (scheduled) return;
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

  function refreshScreenUrlMap(force) {
    const now = Date.now();
    if (!force && now - lastMapRefresh < 10000) {
      return;
    }
    lastMapRefresh = now;

    let text = "";
    try {
      text = Array.from(document.scripts, (script) => script.textContent || "").join("\n");
    } catch (error) {
      return;
    }

    for (const pattern of screenUrlPatterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (!screenUrlMap.has(match[1])) {
          screenUrlMap.set(match[1], match[2]);
        }
      }
    }
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
      const url = bits[0];
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
      return new URL(url, window.location.href).href;
    } catch (error) {
      return url;
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

  function originalUrlFromScreenUrl(screenUrl) {
    const marker = "/content/";
    const index = screenUrl.indexOf(marker);
    if (index === -1) {
      return null;
    }

    const base = detectBytescaleBase();
    if (!base) {
      return null;
    }

    // The `base` already points at `/image/mobbin.com/prod/`, so `content/`
    // must be kept. Dropping it yields `/prod/app_screens/...`, which is a 502.
    return base + screenUrl.slice(index + 1);
  }

  /**
   * Return the canonical unsigned asset URL for this image, if its current
   * URL points at a Mobbin screenshot asset. Query params (`?w=15`, `enc=...`)
   * are dropped on purpose: they only request a transformed derivative.
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

  function getScreenId(img) {
    const link = img.closest("a[href]");
    if (link) {
      const id = screenIdFromText(link.getAttribute("href"));
      if (id) {
        return id;
      }
    }

    // Detail pages render the main screenshot outside any screen link. Reuse
    // the page id, but only for images inside a screen frame so unrelated
    // images (avatars, logos) are never replaced.
    const inScreenFrame = img.closest(SCREEN_FRAME_SELECTOR);
    if (inScreenFrame) {
      return screenIdFromText(window.location.pathname);
    }

    return null;
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

    const onError = () => {
      img.removeEventListener("error", onError);
      markFailed(img, originalUrl);
      appliedUrl.delete(img);

      // Another run may have swapped the image in the meantime; only restore
      // when the failed URL is still the one in use.
      if (img.getAttribute("src") !== originalUrl) {
        return;
      }

      // The original path can be stale for some screens. Put the previous
      // image back when that happens instead of leaving a broken thumbnail.
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

    img.addEventListener("error", onError, { once: true });
    return true;
  }

  function screenUrlFromSignedUrl(img) {
    if (!signedUrlToScreenUrl.size) {
      return null;
    }

    const urls = [];
    if (img.currentSrc) {
      urls.push(img.currentSrc);
    }
    if (img.getAttribute("src")) {
      urls.push(img.getAttribute("src"));
    }
    for (const candidate of parseSrcset(img.getAttribute("srcset"))) {
      urls.push(candidate.url);
    }

    for (const raw of urls) {
      const match = signedUrlToScreenUrl.get(raw);
      if (match) {
        return match;
      }
    }

    return null;
  }

  function upgradeImage(img) {
    if (!visibleImages.get(img)) {
      return;
    }

    // 1. The canonical path is already in the URL: drop the transform query.
    //    This is the only strategy that works on app detail pages, where the
    //    payload is fetched client-side and never appears in `document.scripts`.
    const canonicalUrl = canonicalFromImageUrl(img);
    if (applyOriginalFallback(img, canonicalUrl)) {
      return;
    }

    // 2. Page payload (explore/flow pages) or the app screens API.
    const screenId = getScreenId(img);
    const payloadUrl = screenId ? screenUrlMap.get(screenId) : null;
    const matchedUrl = payloadUrl || screenUrlFromSignedUrl(img);
    const originalUrl = matchedUrl ? originalUrlFromScreenUrl(matchedUrl) : null;
    if (applyOriginalFallback(img, originalUrl)) {
      return;
    }

    // 3. A previous run may already have removed `srcset`. Re-apply the URL we
    //    picked instead of falling back to the thumbnail.
    const targetUrl = getLargestCandidateUrl(img) || appliedUrl.get(img);
    if (targetUrl) {
      applyImageUrl(img, targetUrl);
    }
  }

  function observeImage(img) {
    if (!visibleImages.has(img)) {
      visibleImages.set(img, false);
      intersectionObserver.observe(img);
    }

    if (visibleImages.get(img)) {
      upgradeImage(img);
    }
  }

  function isScreenRelated(element) {
    if (
      element.matches(
        'a[href*="/screens/"], a[href*="/explore/flows/"], a[href*="/explore/screens/"]'
      )
    ) {
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
      if (
        element.querySelector(
          'img[data-sentry-component="CdnImg"], img[data-sentry-source-file="ScreenCellImage.tsx"]'
        )
      ) {
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

      const inScreen = Boolean(element.closest(SCREEN_FRAME_SELECTOR));
      // The exact veil Mobbin renders on locked cells:
      // `<div class="absolute inset-0 bg-[hsl(var(--neutral-0)/40%)] backdrop-blur-[10px]">`.
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
      if (!screenUrlMap.has(value.id)) {
        screenUrlMap.set(value.id, value.screenUrl);
      }

      const sources = value.screenCdnImgSources;
      if (sources) {
        const urls = [sources.src];
        if (Array.isArray(sources.srcSet)) {
          for (const entry of sources.srcSet) {
            urls.push(entry && entry.url);
          }
        }
        for (const url of urls) {
          if (typeof url === "string" && !signedUrlToScreenUrl.has(url)) {
            signedUrlToScreenUrl.set(url, value.screenUrl);
          }
        }
      }
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
   * On `/apps/<slug>/<appId>/<versionId>/screens`, the screens payload is
   * fetched client-side. Ask Mobbin's own endpoint for it so `screenUrl` (and
   * the signed variants) are available for the canonical fallback.
   */
  function enrichFromAppApi() {
    if (appScreensRequested) {
      return;
    }

    const segments = window.location.pathname.split("/").filter(Boolean);
    if (segments[0] !== "apps" || segments.length < 4) {
      return;
    }

    const idMatch = segments[1].match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    if (!idMatch) {
      return;
    }

    appScreensRequested = true;

    fetch("/api/app/fetch-app-versions-screens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: idMatch[0] }),
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((json) => {
        if (!json) {
          return;
        }
        collectScreenObjects(json, 0);
        schedule();
      })
      .catch(() => {
        // Not fatal: the canonical URL rewrite does not need the API.
      });
  }

  function logDiagnostics() {
    const images = Array.from(document.querySelectorAll(SCREEN_IMAGE_SELECTOR));
    const screenImages = images.filter((img) => img.closest(SCREEN_FRAME_SELECTOR));
    const report = screenImages.slice(0, 6).map((img) => {
      const frame = img.closest(SCREEN_FRAME_SELECTOR);
      const rect = img.getBoundingClientRect();
      return {
        src: (img.currentSrc || img.getAttribute("src") || "").slice(-70),
        srcset: img.hasAttribute("srcset"),
        shown: Math.round(rect.width) + "x" + Math.round(rect.height),
        veil: Boolean(frame && frame.querySelector('[class*="backdrop-blur"]')),
        frame: frame ? frame.className.slice(0, 80) : null,
      };
    });

    console.info("[Unblur Mobbin] diagnóstico", {
      version: VERSION,
      path: window.location.pathname,
      screenImages: screenImages.length,
      canonical: screenImages.length ? canonicalFromImageUrl(screenImages[0]) : null,
      payloadScreens: screenUrlMap.size,
      apiScreens: signedUrlToScreenUrl.size,
      sample: report,
    });
  }

  function handleModifications() {
    try {
      refreshScreenUrlMap(false);
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
    { rootMargin: "1200px 0px" }
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

    refreshScreenUrlMap(true);
    handleModifications();
    enrichFromAppApi();

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "sizes", "class", "style"],
    });

    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("popstate", schedule);

    // The Next.js payload can still be streaming when this script starts, so
    // refresh the original-screen map once more after hydration settles.
    window.setTimeout(() => {
      refreshScreenUrlMap(true);
      schedule();
    }, 2500);

    window.setTimeout(logDiagnostics, DIAGNOSTICS_DELAY);

    schedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
