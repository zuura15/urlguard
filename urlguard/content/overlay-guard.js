// InControl — Overlay guard (content script, isolated world, all frames).
//
// Removes ad overlays stacked on top of video players. An "overlay" is an
// element that sits above a <video> (or a large embedded player iframe) in the
// stacking order, covers most of it, and contains a link or iframe pointing at
// a third-party domain. Player controls, posters and big-play buttons are all
// first-party and never match; visible image ads, click-jacking anchors and
// third-party ad iframes do.
//
// Two triggers:
//   1. Scans on DOM mutations, scroll/resize and a slow interval, so an overlay
//      is removed shortly after it appears.
//   2. A capture-phase click shield, so a click landing on an overlay that
//      slipped in between scans is swallowed and the overlay is removed instead
//      of firing the ad's handler.
//
// Every removal is reported to the service worker so the third-party domains
// show up in the popup's Activity tree and can be blocked at the network layer.

(() => {
  if (window.__incontrolOverlayGuard) return;
  window.__incontrolOverlayGuard = true;

  const MIN_SURFACE_W = 200;      // ignore tiny players / thumbnails
  const MIN_SURFACE_H = 120;
  const MIN_OVERLAP = 0.4;        // overlay must cover >= 40% of the player
  const MAX_AREA_RATIO = 3;       // overlay > 3x player area is a page modal, not a video overlay
  const RESCAN_DEBOUNCE_MS = 200;
  const INTERVAL_MS = 1500;

  let enabled = false;
  let allowed = new Set();        // user's Allowed list — overlays linking only here are left alone
  let settings = null;            // last GET_OVERLAY_SETTINGS response, forwarded to the MAIN-world popup guard
  const reportedDomains = new Set();
  const pageSite = registrable(location.hostname);

  // --- Settings -------------------------------------------------------------

  function loadSettings() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_OVERLAY_SETTINGS' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        enabled = !!res.enabled;
        allowed = new Set(res.allowed || []);
        settings = res;
        pushConfig();
        if (enabled) scheduleScan();
      });
    } catch { /* extension context gone */ }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.urlguard_overlay_guard || changes.urlguard_ignored || changes.urlguard_blocked) loadSettings();
    });
  } catch {}

  // --- Bridge to the MAIN-world popup guard ---------------------------------
  // Only strings cross the world boundary. The MAIN script asks for config as
  // soon as it starts and we answer whenever settings are (re)loaded.

  function pushConfig() {
    if (!settings) return;
    try {
      document.dispatchEvent(new CustomEvent('incontrol:config', {
        detail: JSON.stringify({
          enabled: !!settings.enabled,
          blockAll: !!settings.blockAll,
          blocked: settings.blocked || [],
          allowed: settings.allowed || []
        })
      }));
    } catch {}
  }
  document.addEventListener('incontrol:config-request', pushConfig);
  document.addEventListener('incontrol:popup', (e) => {
    let d;
    try { d = JSON.parse(e.detail); } catch { return; }
    if (!d || (d.action !== 'blocked' && d.action !== 'opened')) return;
    try {
      chrome.runtime.sendMessage({
        type: 'POPUP_EVENT',
        action: d.action,
        url: String(d.url || ''),
        reason: String(d.reason || ''),
        host: String(d.host || ''),
        frameUrl: location.href
      }, () => void chrome.runtime.lastError);
    } catch {}
  });

  // --- Domain helpers -------------------------------------------------------

  function registrable(host) {
    if (!host) return '';
    const parts = host.toLowerCase().split('.');
    if (parts.length <= 2) return parts.join('.');
    // Rough eTLD+1: keep three labels for short second-level names (co.uk, com.au).
    const sld = parts[parts.length - 2];
    const keep = sld.length <= 3 && parts.length >= 3 ? 3 : 2;
    return parts.slice(-keep).join('.');
  }

  function hostOf(url, base) {
    try {
      const u = new URL(url, base || location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname;
    } catch { return null; }
  }

  function isThirdParty(host) {
    return !!host && registrable(host) !== pageSite;
  }

  // --- Geometry -------------------------------------------------------------

  function area(r) { return Math.max(0, r.width) * Math.max(0, r.height); }

  function overlapFraction(el, surfaceRect) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, surfaceRect.right) - Math.max(r.left, surfaceRect.left);
    const h = Math.min(r.bottom, surfaceRect.bottom) - Math.max(r.top, surfaceRect.top);
    if (w <= 0 || h <= 0) return 0;
    const sa = area(surfaceRect);
    return sa > 0 ? (w * h) / sa : 0;
  }

  // Fraction of the element's own area that lies inside the surface rect.
  function containedFraction(el, surfaceRect) {
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, surfaceRect.right) - Math.max(r.left, surfaceRect.left);
    const h = Math.min(r.bottom, surfaceRect.bottom) - Math.max(r.top, surfaceRect.top);
    if (w <= 0 || h <= 0) return 0;
    const a = area(r);
    return a > 0 ? (w * h) / a : 0;
  }

  function sharesPlayerSubtree(a, b) {
    // True when a and b have a common ancestor below <body>, i.e. the overlay
    // lives inside the player's own wrapper rather than being appended to body.
    let n = a.parentElement;
    while (n && n !== document.body && n !== document.documentElement) {
      if (n.contains(b)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function inViewport(r) {
    return r.right > 0 && r.bottom > 0 &&
      r.left < window.innerWidth && r.top < window.innerHeight;
  }

  // --- Detection ------------------------------------------------------------

  function surfaces() {
    const out = [];
    for (const v of document.getElementsByTagName('video')) out.push(v);
    for (const f of document.getElementsByTagName('iframe')) {
      const r = f.getBoundingClientRect();
      if (r.width >= 300 && r.height >= 150) out.push(f);
    }
    return out.filter(s => {
      const r = s.getBoundingClientRect();
      return r.width >= MIN_SURFACE_W && r.height >= MIN_SURFACE_H && inViewport(r);
    });
  }

  function thirdPartyDomains(container) {
    const found = new Set();
    const consider = (url) => {
      const h = hostOf(url);
      if (isThirdParty(h)) found.add(h);
    };
    if (container.tagName === 'A') consider(container.getAttribute('href'));
    if (container.tagName === 'IFRAME') consider(container.getAttribute('src'));
    for (const a of container.querySelectorAll('a[href]')) consider(a.getAttribute('href'));
    for (const f of container.querySelectorAll('iframe[src]')) consider(f.getAttribute('src'));
    return [...found];
  }

  function hasFormControls(el) {
    return !!el.querySelector('input, textarea, select, form');
  }

  // Walk up from a hit element to the outermost ancestor that is still an
  // overlay on this surface (covers it, is not much bigger than it, does not
  // contain it). That yields the whole ad container rather than just the <a>.
  function overlayContainer(el, surface, surfaceRect) {
    if (el === surface || el.contains(surface)) return null;
    let container = el;
    const sa = area(surfaceRect);
    for (;;) {
      const p = container.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      if (p.contains(surface)) break;
      if (overlapFraction(p, surfaceRect) < MIN_OVERLAP) break;
      if (area(p.getBoundingClientRect()) > MAX_AREA_RATIO * sa) break;
      container = p;
    }
    if (container === document.body || container === document.documentElement) return null;
    if (overlapFraction(container, surfaceRect) < MIN_OVERLAP) return null;
    if (area(container.getBoundingClientRect()) > MAX_AREA_RATIO * sa) return null;
    if (hasFormControls(container)) return null;
    // An overlay appended outside the player's wrapper (typical for page
    // modals and dialogs) must sit almost entirely within the player's box to
    // count. Overlays injected inside the player only need to cover it.
    if (!sharesPlayerSubtree(container, surface) &&
        containedFraction(container, surfaceRect) < 0.85) return null;
    return container;
  }

  function classify(el, surface, surfaceRect) {
    const container = overlayContainer(el, surface, surfaceRect);
    if (!container) return null;
    const domains = thirdPartyDomains(container);
    if (domains.length === 0) return null;
    if (domains.every(d => allowed.has(d))) return null;
    return { container, domains };
  }

  function samplePoints(r) {
    const xs = [r.left + r.width * 0.25, r.left + r.width * 0.5, r.left + r.width * 0.75];
    const ys = [r.top + r.height * 0.25, r.top + r.height * 0.5, r.top + r.height * 0.75];
    const pts = [];
    for (const x of xs) for (const y of ys) {
      if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) pts.push([x, y]);
    }
    return pts;
  }

  function findOverlays() {
    const hits = new Map(); // container -> domains
    for (const surface of surfaces()) {
      const rect = surface.getBoundingClientRect();
      for (const [x, y] of samplePoints(rect)) {
        const stack = document.elementsFromPoint(x, y);
        for (const el of stack) {
          if (el === surface) break;            // everything below the surface is irrelevant
          if (el.contains(surface)) continue;   // ancestors of the player are the player
          const hit = classify(el, surface, rect);
          if (hit && !hits.has(hit.container)) hits.set(hit.container, hit.domains);
        }
      }
    }
    return hits;
  }

  // --- Removal + reporting --------------------------------------------------

  function removeOverlay(container, domains) {
    try { container.remove(); } catch { return; }
    const fresh = domains.filter(d => !reportedDomains.has(d));
    fresh.forEach(d => reportedDomains.add(d));
    if (fresh.length === 0) return;
    try {
      chrome.runtime.sendMessage({
        type: 'OVERLAY_REMOVED',
        domains: fresh,
        frameUrl: location.href,
        tag: container.tagName.toLowerCase()
      }, () => void chrome.runtime.lastError);
    } catch {}
  }

  function scan() {
    if (!enabled) return;
    if (!document.body) return;
    if (!document.getElementsByTagName('video').length &&
        !document.getElementsByTagName('iframe').length) return;
    for (const [container, domains] of findOverlays()) removeOverlay(container, domains);
  }

  let scanTimer = null;
  function scheduleScan() {
    if (!enabled || scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, RESCAN_DEBOUNCE_MS);
  }

  // --- Click shield ---------------------------------------------------------
  // Registered at document_start in the capture phase on window, so it runs
  // before any listener the page attaches later. If the click lands on an
  // overlay, swallow it and remove the overlay instead.

  function shield(e) {
    if (!enabled) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    let matched = null;
    for (const surface of surfaces()) {
      const rect = surface.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) continue;
      if (surface === target || surface.contains(target)) continue;
      const hit = classify(target, surface, rect);
      if (hit) { matched = hit; break; }
    }
    if (!matched) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    removeOverlay(matched.container, matched.domains);
  }

  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick']) {
    window.addEventListener(type, shield, true);
  }

  // --- Wiring ---------------------------------------------------------------

  function start() {
    if (!document.body) return;
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'src', 'href'] });
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    setInterval(() => { if (!document.hidden) scan(); }, INTERVAL_MS);
    scan();
  }

  loadSettings();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
