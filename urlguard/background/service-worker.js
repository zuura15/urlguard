// URLGuard — detect redirects and background requests, let user block them.
//
// Two things we catch:
// 1. Redirect hijacks: you click link to A, it redirects to B
// 2. Background fires: page loads but also fires hidden requests to other domains
//
// First time: log it and show in popup. User decides to block or ignore.
// Second time: if blocked, DNR kills it.

const MAX_EVENTS_PER_TAB = 50;

// In-memory log of recent suspicious activity per tab
// Shape: { [tabId]: { url, events: [...], blockedCount: number } }
const tabActivity = {};

// Cache of blocked domains (refreshed on change)
let blockedCache = new Set();
getBlocked().then(list => { blockedCache = new Set(list); });

// --- Track navigations to detect redirects ---

// Remember what URL the user intended to visit (before redirects)
const intendedUrls = {};

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;

  // Check if this domain is blocked — kill the navigation immediately
  const domain = getDomain(details.url);
  if (domain && blockedCache.has(domain)) {
    console.log('[URLGuard] Blocked navigation to:', domain, 'tab:', details.tabId);

    // Log to the source tab (the one with existing activity), not the dying new tab.
    // The dying tab won't have a tabActivity entry. Find the most recent tab that does.
    let logTo = details.tabId;
    if (!tabActivity[details.tabId]) {
      // Find the tab that has activity — that's where the user is
      const candidates = Object.keys(tabActivity).map(Number);
      if (candidates.length > 0) {
        logTo = candidates[candidates.length - 1];
        console.log('[URLGuard] Routing blocked event to source tab:', logTo, 'instead of dying tab:', details.tabId);
      }
    }
    await logBlockedNavigation(logTo, domain, details.url);

    try { await chrome.tabs.goBack(details.tabId); } catch {
      try { chrome.tabs.remove(details.tabId); } catch {}
    }
    return;
  }

  intendedUrls[details.tabId] = details.url;
  // Initialize tab activity
  tabActivity[details.tabId] = { url: details.url, events: [] };
  console.log('[URLGuard] Navigation started:', details.url);
});

// Detect HTTP redirects (301, 302, etc.)
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.tabId < 0) return;

    const fromDomain = getDomain(details.url);
    const toDomain = getDomain(details.redirectUrl);
    const initiator = details.initiator || details.documentUrl || null;

    if (fromDomain && toDomain && fromDomain !== toDomain) {
      console.log('[URLGuard] Redirect:', fromDomain, '→', toDomain, 'initiator:', initiator);
      addEvent(details.tabId, {
        type: 'redirect',
        from: fromDomain,
        to: toDomain,
        fromUrl: details.url,
        toUrl: details.redirectUrl,
        initiator: initiator,
        timestamp: Date.now()
      });
    }
  },
  { urls: ['<all_urls>'] }
);

// Detect when the final page is a different domain than intended
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  const intended = intendedUrls[details.tabId];
  if (!intended) return;

  const intendedDomain = getDomain(intended);
  const actualDomain = getDomain(details.url);

  if (intendedDomain && actualDomain && intendedDomain !== actualDomain) {
    console.log('[URLGuard] Landing mismatch:', intendedDomain, '→', actualDomain);
    addEvent(details.tabId, {
      type: 'redirect',
      from: intendedDomain,
      to: actualDomain,
      fromUrl: intended,
      toUrl: details.url,
      initiator: null, // direct navigation — no initiator
      timestamp: Date.now()
    });
  }

  // Update tab activity URL to the committed URL
  if (tabActivity[details.tabId]) {
    tabActivity[details.tabId].url = details.url;
  }

  updateBadge(details.tabId);
});

// --- Track background requests (3rd party requests from the page) ---

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === 'main_frame') return;

    const activity = tabActivity[details.tabId];
    if (!activity) return;

    const pageDomain = getDomain(activity.url);
    const reqDomain = getDomain(details.url);

    if (!pageDomain || !reqDomain || pageDomain === reqDomain) return;

    // Deduplicate: only log each background domain once per tab
    const alreadyLogged = activity.events.some(
      e => e.type === 'background' && e.to === reqDomain
    );
    if (alreadyLogged) return;

    const initiator = details.initiator || details.documentUrl || null;
    const wasBlocked = blockedCache.has(reqDomain);

    addEvent(details.tabId, {
      type: wasBlocked ? 'blocked' : 'background',
      from: pageDomain,
      to: reqDomain,
      fromUrl: activity.url,
      toUrl: details.url,
      initiator: initiator,
      timestamp: Date.now()
    });

    if (wasBlocked) {
      if (!activity.blockedCount) activity.blockedCount = 0;
      activity.blockedCount++;
      updateBadge(details.tabId);
    }
  },
  { urls: ['<all_urls>'] }
);

// Also log blocked redirect navigations
chrome.webRequest.onErrorOccurred.addListener(
  async (details) => {
    if (details.tabId < 0) return;
    if (details.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;

    const reqDomain = getDomain(details.url);
    if (!reqDomain || !blockedCache.has(reqDomain)) return;

    const activity = tabActivity[details.tabId];
    if (!activity) return;

    const alreadyLogged = activity.events.some(
      e => e.type === 'blocked' && e.to === reqDomain
    );
    if (alreadyLogged) return;

    const pageDomain = getDomain(activity.url);
    addEvent(details.tabId, {
      type: 'blocked',
      from: pageDomain || 'unknown',
      to: reqDomain,
      fromUrl: activity.url,
      toUrl: details.url,
      initiator: details.initiator || null,
      timestamp: Date.now()
    });

    if (!activity.blockedCount) activity.blockedCount = 0;
    activity.blockedCount++;
    updateBadge(details.tabId);
  },
  { urls: ['<all_urls>'] }
);

// --- Kill tabs that try to open blocked domains ---

chrome.tabs.onCreated.addListener(async (tab) => {
  const url = tab.pendingUrl || tab.url;
  if (!url || url === 'chrome://newtab/' || url === 'about:blank') return;

  const domain = getDomain(url);
  if (!domain || !blockedCache.has(domain)) return;

  console.log('[URLGuard] Killing new tab for blocked domain:', domain, 'opener:', tab.openerTabId);

  // Log to opener tab, or the tab with activity
  let logTo = tab.openerTabId;
  if (!logTo || !tabActivity[logTo]) {
    const candidates = Object.keys(tabActivity).map(Number);
    logTo = candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }
  if (logTo) {
    await logBlockedNavigation(logTo, domain, url);
  }

  try { chrome.tabs.remove(tab.id); } catch {}
});

// --- Cleanup on tab close ---

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabActivity[tabId];
  delete intendedUrls[tabId];
});

// --- Badge: show count of suspicious events ---

function updateBadge(tabId) {
  const activity = tabActivity[tabId];
  if (!activity || activity.events.length === 0) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const blockedCount = activity.blockedCount || 0;
  if (blockedCount > 0) {
    // Red badge showing blocked count
    chrome.action.setBadgeText({ tabId, text: String(blockedCount) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#DC2626' });
  } else {
    // Amber badge showing total event count
    chrome.action.setBadgeText({ tabId, text: String(activity.events.length) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#D97706' });
  }
}

// --- Message handling for popup ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_TAB_ACTIVITY') {
    const activity = tabActivity[msg.tabId] || { url: '', events: [] };
    sendResponse(activity);
  }
  else if (msg.type === 'GET_BLOCKED_LOG') {
    chrome.storage.session.get('urlguard_blocked_log').then(result => {
      sendResponse({ log: result.urlguard_blocked_log || [] });
    });
    return true;
  }
  else if (msg.type === 'CLEAR_BLOCKED_LOG') {
    chrome.storage.session.remove('urlguard_blocked_log').then(() => sendResponse({ ok: true }));
    return true;
  }
  else if (msg.type === 'BLOCK_DOMAIN') {
    blockDomain(msg.domain).then(() => sendResponse({ ok: true }));
    return true;
  }
  else if (msg.type === 'UNBLOCK_DOMAIN') {
    unblockDomain(msg.domain).then(() => sendResponse({ ok: true }));
    return true;
  }
  else if (msg.type === 'GET_BLOCKED') {
    getBlocked().then(list => sendResponse({ blocked: list }));
    return true;
  }
  else if (msg.type === 'IGNORE_DOMAIN') {
    ignoreDomain(msg.domain).then(() => sendResponse({ ok: true }));
    return true;
  }
  else if (msg.type === 'UNIGNORE_DOMAIN') {
    unignoreDomain(msg.domain).then(() => sendResponse({ ok: true }));
    return true;
  }
  else if (msg.type === 'GET_IGNORED') {
    getIgnored().then(list => sendResponse({ ignored: list }));
    return true;
  }
});

// --- Block/unblock via DNR ---

function domainToRuleId(domain) {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 90000) + 10000;
}

async function blockDomain(domain) {
  // Save to storage
  const result = await chrome.storage.local.get('urlguard_blocked');
  const blocked = result.urlguard_blocked || [];
  if (!blocked.includes(domain)) {
    blocked.push(domain);
    await chrome.storage.local.set({ urlguard_blocked: blocked });
  }

  // Remove from ignored if it was there
  const igResult = await chrome.storage.local.get('urlguard_ignored');
  const ignored = igResult.urlguard_ignored || [];
  const filtered = ignored.filter(d => d !== domain);
  if (filtered.length !== ignored.length) {
    await chrome.storage.local.set({ urlguard_ignored: filtered });
  }

  // Refresh cache
  blockedCache = new Set(await getBlocked());

  // Create DNR rule
  const ruleId = domainToRuleId(domain);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: 'block' },
        condition: { requestDomains: [domain], resourceTypes: [
          'main_frame', 'sub_frame', 'script', 'xmlhttprequest',
          'image', 'stylesheet', 'ping', 'other'
        ]}
      }],
      removeRuleIds: [ruleId]
    });
    console.log('[URLGuard] Blocked domain:', domain, 'ruleId:', ruleId);
  } catch (err) {
    console.error('[URLGuard] DNR block error:', err);
  }
}

async function unblockDomain(domain) {
  const result = await chrome.storage.local.get('urlguard_blocked');
  const blocked = (result.urlguard_blocked || []).filter(d => d !== domain);
  await chrome.storage.local.set({ urlguard_blocked: blocked });

  const ruleId = domainToRuleId(domain);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [],
      removeRuleIds: [ruleId]
    });
    console.log('[URLGuard] Unblocked domain:', domain);
  } catch (err) {
    console.error('[URLGuard] DNR unblock error:', err);
  }

  // Refresh cache
  blockedCache = new Set(await getBlocked());
}

async function getBlocked() {
  const result = await chrome.storage.local.get('urlguard_blocked');
  return result.urlguard_blocked || [];
}

async function ignoreDomain(domain) {
  const result = await chrome.storage.local.get('urlguard_ignored');
  const ignored = result.urlguard_ignored || [];
  if (!ignored.includes(domain)) {
    ignored.push(domain);
    await chrome.storage.local.set({ urlguard_ignored: ignored });
  }
}

async function getIgnored() {
  const result = await chrome.storage.local.get('urlguard_ignored');
  return result.urlguard_ignored || [];
}

async function unignoreDomain(domain) {
  const result = await chrome.storage.local.get('urlguard_ignored');
  const ignored = (result.urlguard_ignored || []).filter(d => d !== domain);
  await chrome.storage.local.set({ urlguard_ignored: ignored });
}

// --- Log blocked navigations to the source tab ---

async function logBlockedNavigation(sourceTabId, blockedDomain, blockedUrl) {
  console.log('[URLGuard] logBlockedNavigation:', blockedDomain, '→ storing persistently');

  // Persist to chrome.storage.session — survives worker restarts
  // Key: urlguard_blocked_log
  // Shape: [ { to, toUrl, timestamp }, ... ]
  try {
    const result = await chrome.storage.session.get('urlguard_blocked_log');
    const log = result.urlguard_blocked_log || [];

    // Deduplicate
    if (!log.some(e => e.to === blockedDomain)) {
      log.push({
        to: blockedDomain,
        toUrl: blockedUrl,
        timestamp: Date.now()
      });
      await chrome.storage.session.set({ urlguard_blocked_log: log });
      console.log('[URLGuard] Persisted blocked event, total:', log.length);
    }
  } catch (err) {
    console.error('[URLGuard] Failed to persist blocked event:', err);
  }

  // Also log to in-memory tabActivity if available
  if (tabActivity[sourceTabId]) {
    const activity = tabActivity[sourceTabId];
    const pageDomain = getDomain(activity.url) || 'unknown';
    addEvent(sourceTabId, {
      type: 'blocked', from: pageDomain, to: blockedDomain,
      fromUrl: activity.url, toUrl: blockedUrl,
      initiator: activity.url, timestamp: Date.now()
    });
    if (!activity.blockedCount) activity.blockedCount = 0;
    activity.blockedCount++;
  }

  // Set badge globally (no tabId) so it shows on ALL tabs
  try {
    const result = await chrome.storage.session.get('urlguard_blocked_log');
    const count = (result.urlguard_blocked_log || []).length;
    if (count > 0) {
      await chrome.action.setBadgeText({ text: String(count) });
      await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
    }
  } catch {}
}

// --- Helpers ---

function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function addEvent(tabId, event) {
  if (!tabActivity[tabId]) {
    tabActivity[tabId] = { url: '', events: [] };
  }
  const activity = tabActivity[tabId];
  if (activity.events.length < MAX_EVENTS_PER_TAB) {
    activity.events.push(event);
    updateBadge(tabId);
  }
}
