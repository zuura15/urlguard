// InControl — Popup guard (content script, MAIN world, all frames incl. about:blank).
//
// Popunder ad scripts listen for any click on the page and, inside that click,
// call window.open() on an ad URL so the new tab inherits the user gesture and
// steals focus. This script runs in the page's own JS world so it can wrap
// window.open and see synthetic link clicks, which the isolated world cannot.
//
// Rules, evaluated for every window.open() and for link clicks:
//   1. Target domain is on the user's Blocked list      -> cancel.
//   2. Target host is accounts.google.com (Sign in with Google / Google
//      OAuth), or is on the user's Allowed list         -> allow, and do not
//      report. This sits above block-all and the hijack rules so GIS and
//      classic OAuth popups still open. It is an exact host, not all of
//      google.com. An explicit Block of that host still wins (rule 1).
//   3. Target is third-party (or about:blank) and either the triggering click
//      landed inside a <video> box, or this frame is a video-embed frame (it
//      contains a video) -> cancel. Video embeds host the popunder scripts and
//      never legitimately open another site; the ad often fires from a sibling
//      embed frame that did not itself receive the click, which is why a
//      frame-local video test is needed on top of the click test.
//   4. The triggering click was on a first-party link or navigation element
//      (a page number, a same-site link) yet a third-party tab is opening ->
//      cancel. Clicking a link that stays on the site must not spawn an ad
//      tab; this is the document-level popunder that rides ordinary clicks.
//   5. Block-all (on by default) cancels every other third-party window.open.
//   6. Any other third-party open                        -> allow, but report
//      it so the domain shows in Activity and can be blocked.
//
// Config (enabled flag, blocked/allowed lists) arrives from the isolated-world
// script over a DOM CustomEvent; verdicts go back the same way. Only strings
// cross the boundary.

(() => {
  if (window.__incontrolPopupGuard) return;
  window.__incontrolPopupGuard = true;

  const GESTURE_TTL_MS = 1500;
  const MAX_REPORTS = 25;

  // Popup targets the current Google Identity Services client opens, confirmed
  // against https://accounts.google.com/gsi/client:
  //   window.open("https://accounts.google.com/gsi/select?...")
  //   window.open("https://accounts.google.com/o/oauth2/v2/auth?...")
  //     with display=popup and redirect_uri=gis_transform (button popup),
  //     and the same /o/oauth2/v2/auth URL for initCodeClient / initTokenClient.
  // Classic client-side Google OAuth uses that host too
  // (/o/oauth2/v2/auth or the older /o/oauth2/auth). The open is the absolute
  // URL, not about:blank. Host-level so a new GIS path on this host keeps
  // working. www.google.com, youtube.com, and ad hosts are intentionally absent.
  const GOOGLE_AUTH_POPUP_HOSTS = new Set([
    'accounts.google.com'
  ]);

  function isGoogleAuthPopup(host) {
    return !!host && GOOGLE_AUTH_POPUP_HOSTS.has(host);
  }

  let cfg = null;                 // null until the isolated world sends config
  let blockedSet = new Set();
  let allowedSet = new Set();
  let reports = 0;
  const pageSite = registrable(location.hostname);

  // Frames created on the fly (an about:blank iframe used to reach a fresh
  // window.open) may have this script but not yet the isolated-world relay.
  // They borrow config from, and report through, the nearest same-origin
  // ancestor, which always has both.
  function sameOriginAncestors() {
    const out = [];
    let w = window;
    for (let i = 0; i < 8; i++) {
      let p;
      try { p = w.parent; } catch { break; }
      if (!p || p === w) break;
      try { void p.document; } catch { break; } // cross-origin: stop
      out.push(p);
      w = p;
    }
    return out;
  }

  function effectiveConfig() {
    if (cfg) return { cfg, blockedSet, allowedSet };
    for (const w of sameOriginAncestors()) {
      try {
        if (w.__incontrolPopupCfg) return w.__incontrolPopupCfg;
      } catch {}
    }
    return { cfg: { enabled: false }, blockedSet, allowedSet };
  }

  // Last trusted pointer gesture in this frame. Same-origin child frames
  // (about:blank ad frames) read it through window.parent to judge opens
  // that a script routes through a fresh iframe's window.open.
  window.__incontrolGesture = null;

  // --- Config bridge --------------------------------------------------------

  document.addEventListener('incontrol:config', (e) => {
    try {
      const c = JSON.parse(e.detail);
      cfg = { enabled: !!c.enabled, blockAll: !!c.blockAll };
      blockedSet = new Set(c.blocked || []);
      allowedSet = new Set(c.allowed || []);
      window.__incontrolPopupCfg = { cfg, blockedSet, allowedSet };
    } catch {}
  });
  try { document.dispatchEvent(new CustomEvent('incontrol:config-request')); } catch {}

  function report(action, url, reason, host) {
    if (reports++ >= MAX_REPORTS) return;
    const detail = JSON.stringify({ action, url: String(url || '').slice(0, 2000), reason, host });
    // Dispatch on the outermost same-origin document so the relay there
    // picks it up even if this frame's isolated script is not injected yet.
    const ancestors = sameOriginAncestors();
    const target = ancestors.length ? ancestors[ancestors.length - 1] : window;
    try {
      target.document.dispatchEvent(new target.CustomEvent('incontrol:popup', { detail }));
    } catch {}
  }

  // --- Domain helpers (mirror of overlay-guard.js) -------------------------

  function registrable(host) {
    if (!host) return '';
    const parts = host.toLowerCase().split('.');
    if (parts.length <= 2) return parts.join('.');
    const sld = parts[parts.length - 2];
    const keep = sld.length <= 3 && parts.length >= 3 ? 3 : 2;
    return parts.slice(-keep).join('.');
  }

  function hostOf(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.hostname;
    } catch { return null; }
  }

  function isThirdParty(host) {
    return !!host && registrable(host) !== pageSite;
  }

  // --- Gesture tracking -----------------------------------------------------

  function inVideoBox(x, y) {
    for (const v of document.getElementsByTagName('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  function frameHasVideo() {
    for (const v of document.getElementsByTagName('video')) {
      const r = v.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 60) return true;
    }
    return false;
  }

  // A subframe that holds a video player: a video embed. Popunder ad scripts
  // ride inside these; legitimate popups come from the top document instead.
  function isEmbedFrame() {
    let isSub = false;
    try { isSub = window.top !== window; } catch { isSub = true; } // cross-origin top => we are a subframe
    return isSub && frameHasVideo();
  }

  // The click landed on (or inside) a link that keeps the user on this site:
  // a same-registrable-site href, or an in-page nav (#, javascript:) link.
  // Clicking such a control is a navigation intent, never a request to open a
  // third-party tab, so a third-party window.open during it is a popunder.
  function isFirstPartyLink(el) {
    const a = el && el.closest ? el.closest('a[href], area[href]') : null;
    if (!a) return false;
    const h = hostOf(a.getAttribute('href'));
    if (!h) return true;              // #, javascript:, relative-to-nothing -> in-site UI click
    return !isThirdParty(h);
  }

  function recordGesture(e) {
    if (!e.isTrusted) return;
    window.__incontrolGesture = {
      t: Date.now(),
      media: inVideoBox(e.clientX, e.clientY),
      fpLink: isFirstPartyLink(e.target)
    };
  }
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick']) {
    window.addEventListener(type, recordGesture, true);
  }

  function recentGesture() {
    let best = null;
    let w = window;
    for (let i = 0; i < 8; i++) {
      try {
        const g = w.__incontrolGesture;
        if (g && (!best || g.t > best.t)) best = g;
      } catch {}
      let p;
      try { p = w.parent; } catch { break; }
      if (!p || p === w) break;
      w = p;
    }
    return best && (Date.now() - best.t) < GESTURE_TTL_MS ? best : null;
  }

  // --- Verdicts -------------------------------------------------------------

  // Returns null (nothing to do), { block: false } (allow but report) or
  // { block: true } with a reason.
  function verdict(rawUrl) {
    const { cfg: c, blockedSet: blocked, allowedSet: allowed } = effectiveConfig();
    if (!c.enabled) return null;
    const host = hostOf(rawUrl);
    if (host && blocked.has(host)) return { block: true, reason: 'blocked-domain', host };
    if (host && !isThirdParty(host)) return null;
    // Same effect as the user's Allowed list: skip block-all, video-click,
    // video-embed, and link-hijack, and do not log the open. Built-in so
    // Sign in with Google works without a per-site toggle.
    if (host && (allowed.has(host) || isGoogleAuthPopup(host))) return null;
    // Per-site "block all pop-ups to other sites": cancel every third-party (or
    // blank) window.open, whatever triggered it. Same-site targets, the user's
    // Allowed list, and accounts.google.com already returned above. Ordinary
    // hyperlinks never reach here (they navigate natively, not through
    // window.open), so links keep working.
    if (c.blockAll) return { block: true, reason: 'block-all', host: host || 'about:blank' };
    const g = recentGesture();
    if (g && g.media) return { block: true, reason: 'video-click', host: host || 'about:blank' };
    // Popunder fired from a video-embed subframe (this frame, or a sibling
    // embed that borrowed the page's user activation). A dedicated video-embed
    // subframe opening a new tab to another site is always an ad. Scoped to
    // subframes so a legit popup from a top page that merely contains a video
    // (a sign-in button next to a player) is left alone.
    if (isEmbedFrame() && (g || !host)) return { block: true, reason: 'video-embed', host: host || 'about:blank' };
    // Document-level popunder: the click was on a first-party link/nav element
    // (pagination, an in-site link) but a third-party (or blank) tab is opening.
    if (g && g.fpLink) return { block: true, reason: 'link-hijack', host: host || 'about:blank' };
    if (host) return { block: false, reason: 'third-party', host };
    return null;
  }

  // --- window.open ----------------------------------------------------------

  const nativeOpen = window.open;
  window.open = function (url, target, features) {
    const raw = url == null ? '' : String(url);
    const v = verdict(raw);
    if (v) report(v.block ? 'blocked' : 'opened', raw, v.reason, v.host);
    if (v && v.block) return null;
    return nativeOpen.apply(this, arguments);
  };

  // --- Link clicks ----------------------------------------------------------
  // Two popunder variants that bypass window.open:
  //   a) the ad script builds <a target=_blank href=ad> and calls a.click()
  //      inside the user's gesture (untrusted click, real navigation);
  //   b) the player is literally wrapped in <a href=ad target=_blank>.

  window.addEventListener('click', (e) => {
    const { cfg: c, blockedSet: blocked, allowedSet: allowed } = effectiveConfig();
    if (!c.enabled) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const a = target.closest('a[href]');
    if (!a) return;
    const host = hostOf(a.href);
    if (!host) return;

    if (blocked.has(host)) {
      e.preventDefault(); e.stopImmediatePropagation();
      report('blocked', a.href, 'blocked-domain', host);
      return;
    }
    if (!isThirdParty(host) || allowed.has(host) || isGoogleAuthPopup(host)) return;

    if (!e.isTrusted) {
      const g = recentGesture();
      if (g && g.media) {
        e.preventDefault(); e.stopImmediatePropagation();
        report('blocked', a.href, 'synthetic-click', host);
      }
      return;
    }

    const onVideo = inVideoBox(e.clientX, e.clientY);
    if (onVideo || isEmbedFrame()) {
      e.preventDefault(); e.stopImmediatePropagation();
      report('blocked', a.href, onVideo ? 'video-link' : 'video-embed', host);
      if (a.querySelector('video')) {
        // Unwrap the player so the next click reaches the video itself.
        try { a.replaceWith(...a.childNodes); } catch {}
      }
    }
  }, true);
})();
