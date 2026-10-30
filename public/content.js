/*
 * Unblur Mobbin content script.
 *
 * Mobbin now serves screen previews through signed Bytescale URLs. The URL in
 * `src` is a small preview, but the `srcset` still contains the larger
 * candidates (360w / 720w / 1920w). The 1920w candidate is the full-resolution
 * screen, so the fix is to pin every screen image to that candidate and drop
 * `srcset`/`sizes` so the browser cannot switch back to the thumbnail.
 *
 * When the page also exposes the original Supabase `screenUrl` for a screen,
 * it is used as a fallback (through the equivalent public Bytescale path) in
 * case the largest `srcset` candidate is still a low-resolution preview.
 */

(() => {
  const VERSION = "1.2.0";
  const SCREEN_IMAGE_SELECTOR = 'img[data-sentry-component="CdnImg"], img[srcset]';
  const MIN_CANDIDATE_WIDTH = 700;
  const SCREEN_LINK_PATTERN = /\/explore\/(?:screens|flows)\//;
  const SCREEN_ID_PATTERN = /\/explore\/screens\/([0-9a-f-]{36})/i;

  const appliedUrl = new WeakMap();
  const visibleImages = new WeakMap();
  const failedOriginalUrl = new WeakSet();
  const screenUrlMap = new Map();

  let bytescaleBase = null;
  let lastMapRefresh = 0;
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

  function getScreenId(img) {
    const link = img.closest("a[href]");
    if (link) {
      const match = (link.getAttribute("href") || "").match(SCREEN_ID_PATTERN);
      if (match) {
        return match[1];
      }
    }

    // Detail pages render the main screenshot outside any screen link. Reuse
    // the page id, but only for images inside a screen frame so unrelated
    // images (avatars, logos) are never replaced.
    const inScreenFrame = img.closest(
      '[class*="mobile-screen-border-radius"], [class*="screen-inset-border"]'
    );
    if (inScreenFrame) {
      const pageMatch = window.location.pathname.match(SCREEN_ID_PATTERN);
      if (pageMatch) {
        return pageMatch[1];
      }
    }

    return null;
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
    if (!originalUrl || failedOriginalUrl.has(img)) {
      return;
    }

    const previousSrc = img.getAttribute("src");
    const previousSrcset = img.getAttribute("srcset");
    const previousSizes = img.getAttribute("sizes");

    if (!applyImageUrl(img, originalUrl)) {
      return;
    }

    const onError = () => {
      img.removeEventListener("error", onError);
      failedOriginalUrl.add(img);
      appliedUrl.delete(img);

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
  }

  function upgradeImage(img) {
    if (!visibleImages.get(img)) {
      return;
    }

    const screenId = getScreenId(img);
    const screenUrl = screenId ? screenUrlMap.get(screenId) : null;
    const originalUrl = screenUrl ? originalUrlFromScreenUrl(screenUrl) : null;
    const candidateUrl = getLargestCandidateUrl(img);
    const currentUrl = appliedUrl.get(img);

    // The canonical `app_screens/<id>.png` file is the real full-resolution
    // capture. It is not signed and is never a blurred preview, so prefer it
    // whenever the page payload exposes it. `applyOriginalFallback` restores
    // the previous image if a stale path fails to load.
    if (originalUrl && !failedOriginalUrl.has(img)) {
      applyOriginalFallback(img, originalUrl);
      return;
    }

    // A previous run may already have removed `srcset`. Re-apply the URL we
    // picked instead of falling back to the original image.
    const targetUrl = candidateUrl || currentUrl;

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

  function unlockElement(element) {
    const isScreenLink = element.matches('a[href*="/explore/screens/"], a[href*="/explore/flows/"]');
    const containsScreenImage = Boolean(
      element.querySelector('img[data-sentry-component="CdnImg"]')
    );

    if (!isScreenLink && !containsScreenImage) {
      return;
    }

    element.classList.remove("pointer-events-none");

    if (element.getAttribute("tabindex") === "-1") {
      element.setAttribute("tabindex", "0");
    }
  }

  function hidePaywallOverlays() {
    const overlays = document.querySelectorAll('[class*="backdrop-blur"]');

    overlays.forEach((element) => {
      if (element.tagName === "IMG") {
        return;
      }

      const className = typeof element.className === "string" ? element.className : "";
      if (!className.includes("backdrop-blur")) {
        return;
      }

      const inScreen = Boolean(
        element.closest(
          'a[href*="/explore/screens/"], a[href*="/explore/flows/"], [class*="mobile-screen-border-radius"], [class*="screen-inset-border"]'
        )
      );
      const isKnownPaywallVeil = /backdrop-blur-\[(?:8|10|12)px\]/.test(className);
      if (!inScreen && !isKnownPaywallVeil) {
        return;
      }

      // Never hide a wrapper that contains the screenshot itself.
      if (element.querySelector('img[data-sentry-component="CdnImg"]')) {
        return;
      }

      element.style.setProperty("display", "none", "important");
    });
  }

  function handleModifications() {
    refreshScreenUrlMap(false);

    document.querySelectorAll(SCREEN_IMAGE_SELECTOR).forEach(observeImage);

    document.querySelectorAll(".pointer-events-none").forEach(unlockElement);
    hidePaywallOverlays();
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
    { rootMargin: "800px 0px" }
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
              'a[href*="/explore/screens/"], a[href*="/explore/flows/"], [class*="mobile-screen-border-radius"], [class*="screen-inset-border"]'
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

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "sizes", "class"],
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

    schedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
