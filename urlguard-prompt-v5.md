# Claude Code Prompt: URLGuard — Chrome Extension (MV3)
## Spam, Phishing & Malicious URL Detector

---

## Agent directive

**Favor correctness and resilience over UI completeness.** When tradeoffs arise, ship the simpler correct implementation. A working warning icon and a reliable score are worth more than a polished overlay that breaks on edge cases.

**Do not scaffold later phases speculatively.** Complete and manually verify each phase before writing a single line of the next. No forward stubs, no placeholder files for future phases.

---

## Non-goals

This extension will not:
- Use machine learning or any trained model
- Send browsing data to any remote server (except the optional GSB API, which is opt-in and documented)
- Classify page content or run in-page scripts for detection purposes
- Maintain a cloud backend or user accounts
- Auto-update rules from a proprietary feed requiring authentication by default

---

## Core product model — read before writing any code

### Two blocking modes, never conflated

**Mode A — Advisory (heuristic + feed detections):**
The extension detects a suspicious URL. It never prevents the page from loading. It warns via icon state and a best-effort overlay. The user decides. The page is always reachable.

**Mode B — Hard block (explicit user action only):**
When a user clicks "Block this domain permanently" in any warning UI, a DNR rule is created for that domain. Future navigations to that domain are blocked at the network level. This is the only path to a hard block. No score, no feed hit, no heuristic — however severe — ever creates a DNR rule automatically.

These two modes must never be conflated in code, UI copy, comments, or tests.

### Reliable surfaces vs. opportunistic surfaces

**Canonical:** icon state and popup. These always reflect current score. They work regardless of page type, CSP, or DOM structure.

**Opportunistic:** the full-page warning overlay. Injected via `chrome.scripting.executeScript` after navigation commits. It may fail silently on PDFs, certain sandboxed frames, or pages with aggressive DOM manipulation. When it does, the icon and popup are the fallback. Design the overlay as an enhancement, not as the primary gate.

### Storage is the source of truth — always

MV3 service workers terminate after ~30 seconds of inactivity. Module-level variables are ephemeral.

| Data | Authoritative location |
|---|---|
| User block/allow rules | `chrome.storage.sync` — key `urlguard_rules` |
| Per-session tab scores | `chrome.storage.session` — key `tab_{tabId}` |
| Redirect chains | `chrome.storage.session` — key `chain_{tabId}` |
| Scan state + results | `chrome.storage.session` — key `urlguard_scan_state` |
| History flags | `chrome.storage.session` — key `urlguard_history_flags` |
| Feed metadata | `chrome.storage.local` — key `urlguard_feed_meta` |
| Blocklist entries | IndexedDB — database `urlguard_db` |

In-memory Maps or variables are permitted as write-through caches only. On every handler entry, read from storage. On every mutation, write to storage. If the in-memory cache is empty (worker restarted), fall back to storage transparently.

---

## Build phases — strict gate policy

Each phase is independently testable. **Do not begin a phase until the previous one passes its full verification checklist.**

- **Phase 1:** Navigation scoring + advisory warning + basic popup
- **Phase 2:** Redirect tracking + user rules + DNR hard blocks
- **Phase 3:** History scan page
- **Phase 4:** Feed refresh alarm + optional GSB/PhishTank APIs

---

## File structure

```
urlguard/
├── manifest.json
├── background/
│   ├── service-worker.js
│   ├── scorer.js
│   ├── heuristics.js
│   ├── blocklist-manager.js
│   ├── redirect-tracker.js        (Phase 2)
│   └── rules-manager.js           (Phase 2)
├── content/
│   ├── click-monitor.js
│   └── warning-overlay.js
├── pages/
│   ├── popup.html + popup.js
│   └── history-report.html + history-report.js   (Phase 3)
├── lib/
│   └── psl.min.js                 (required — see below)
├── data/
│   └── risky-tlds.json
└── README.md
```

### Required: Public Suffix List library

Do not hand-roll eTLD+1 extraction. Security logic that depends on domain matching requires correct registered domain extraction across all TLDs.

Use the `psl` npm package. Bundle `psl.min.js` into `lib/`. All domain extraction must use:

```javascript
import psl from '../lib/psl.min.js';

function extractRegisteredDomain(urlString) {
  try {
    const hostname = new URL(urlString).hostname;
    const parsed = psl.parse(hostname);
    return parsed.domain || null;
  } catch {
    return null;
  }
}
```

README must include instructions for obtaining `psl.min.js` (npm install psl, copy from `node_modules/psl/dist/`).

---

## manifest.json

```json
{
  "manifest_version": 3,
  "name": "URLGuard",
  "version": "1.0.0",
  "description": "Detects suspicious URLs and warns you. You are always in control.",
  "permissions": [
    "webRequest", "webNavigation", "tabs", "history",
    "storage", "alarms", "scripting",
    "declarativeNetRequest", "declarativeNetRequestWithHostAccess",
    "notifications"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/click-monitor.js"],
      "run_at": "document_start",
      "all_frames": false
    }
  ],
  "action": {
    "default_popup": "pages/popup.html",
    "default_icon": { "16": "icons/icon-16.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" }
  },
  "declarative_net_request": { "rule_resources": [] },
  "web_accessible_resources": [
    { "resources": ["content/warning-overlay.js", "lib/psl.min.js"], "matches": ["<all_urls>"] }
  ]
}
```

---

---

# PHASE 1 — Core scoring + advisory warning

---

## P1 · service-worker.js

### Initialization

```javascript
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await BlocklistManager.initialize();
    chrome.notifications.create('urlguard-install', {
      type: 'basic', iconUrl: 'icons/icon-48.png',
      title: 'URLGuard installed',
      message: 'Downloading threat intelligence feeds. Takes a moment on first install.'
    });
  }
  chrome.alarms.create('blocklist-refresh', { periodInMinutes: 360 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'blocklist-refresh') BlocklistManager.refreshAll();
});
```

### Navigation monitoring

```javascript
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;
  await handleNavigation(tabId, url);
});

async function handleNavigation(tabId, url) {
  const result = await Scorer.scoreUrl(url, tabId);

  if (result.verdict === 'safe') {
    await setIconNormal(tabId);
  } else if (result.verdict === 'warn') {
    await setIconWarn(tabId);
  } else {
    await setIconThreat(tabId);
    // Best-effort overlay injection — failure is acceptable, icon/popup remain canonical
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/warning-overlay.js'] });
    } catch (err) {
      console.warn('[URLGuard] overlay injection failed:', url, err.message);
    }
  }
}
```

### Icon helpers

```javascript
async function setIconNormal(tabId) {
  await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png' } });
  await chrome.action.setBadgeText({ tabId, text: '' });
}
async function setIconWarn(tabId) {
  await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon-warn-16.png', 48: 'icons/icon-warn-48.png' } });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#D97706' });
}
async function setIconThreat(tabId) {
  await chrome.action.setIcon({ tabId, path: { 16: 'icons/icon-threat-16.png', 48: 'icons/icon-threat-48.png' } });
  await chrome.action.setBadgeText({ tabId, text: '✕' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#DC2626' });
}
```

### Message handling — complete IPC contract

All handlers follow: read from storage → act → write to storage → return response.

**Important:** `sender.tab.id` is only reliably set for content scripts. Extension pages (popup, history report) do not inject as content scripts and `sender.tab` may be undefined. For those callers, the payload must include an explicit `targetTabId` field when a specific tab is needed.

```javascript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    console.error('[URLGuard] message handler error:', msg.type, err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});
```

#### `GET_TAB_STATE`
- **Callers:** popup.js (passes `targetTabId`), warning-overlay.js (content script — uses `sender.tab.id`)
- **Payload:** `{ type: 'GET_TAB_STATE', targetTabId?: number }`
- **Response:** cached score object or `null`
- **Side effects:** none
- **Logic:** `const tabId = msg.targetTabId ?? sender.tab?.id; read chrome.storage.session key tab_${tabId}`

#### `DISMISS_WARNING`
- **Caller:** warning-overlay.js (content script)
- **Payload:** `{ type: 'DISMISS_WARNING' }`
- **Response:** `{ ok: true }`
- **Side effects:** Downgrade icon to warn for `sender.tab.id` — domain remains suspicious, icon must not reset to normal

#### `MULTI_CLICK_DETECTED`
- **Caller:** click-monitor.js (content script)
- **Payload:** `{ type: 'MULTI_CLICK_DETECTED', count: number }`
- **Response:** none
- **Side effects:** Read tab state from `chrome.storage.session`. If no state exists yet for this tab (page not yet scored — valid cold-start), create a baseline: `{ score: 0, verdict: 'safe', source: 'behavior_signal', signals: [], redirectChain: [], url: sender.tab.url ?? '' }`. Add 40 pts to score, cap at 100, re-derive verdict, append a `multi_click` signal (see signal definition below), write back to storage, update icon if verdict changed.

`multi_click` signal: `{ id: 'multi_click', label: 'Multiple windows opened from one click', weight: 40, detail: \`${count} targets spawned within 600ms\` }`

#### `META_REFRESH_DETECTED`
- **Caller:** click-monitor.js
- **Payload:** `{ type: 'META_REFRESH_DETECTED', targetUrl: string, delay: number }`
- **Response:** none
- **Side effects:** `RedirectTracker.addHop(sender.tab.id, targetUrl, 'meta_refresh')` then re-score *(active in Phase 2)*

#### `JS_REDIRECT_DETECTED`
- **Caller:** click-monitor.js
- **Payload:** `{ type: 'JS_REDIRECT_DETECTED', targetUrl: string, fromUrl: string }`
- **Response:** none
- **Side effects:** `RedirectTracker.addHop(sender.tab.id, targetUrl, 'js_redirect')` then re-score *(active in Phase 2)*

#### `ADD_BLOCK` *(Phase 2)*
- **Callers:** warning-overlay.js, popup.js (passes `targetTabId`), history-report.js
- **Payload:** `{ type: 'ADD_BLOCK', domain: string }`
- **Response:** `{ ok: true }`
- **Side effects:** `RulesManager.addBlock(domain)` → writes to `chrome.storage.sync` → creates DNR rule

#### `ADD_EXCEPTION` *(Phase 2)*
- **Callers:** warning-overlay.js, popup.js, history-report.js
- **Payload:** `{ type: 'ADD_EXCEPTION', domain: string }`
- **Response:** `{ ok: true }`
- **Side effects:** `RulesManager.addException(domain)` → writes to `chrome.storage.sync`

#### `REMOVE_RULE` *(Phase 2)*
- **Caller:** popup.js
- **Payload:** `{ type: 'REMOVE_RULE', domain: string }`
- **Response:** `{ ok: true }`
- **Side effects:** `RulesManager.remove(domain)` → removes DNR rule if one exists → updates `chrome.storage.sync`

#### `GET_ALL_RULES` *(Phase 2)*
- **Caller:** popup.js
- **Payload:** `{ type: 'GET_ALL_RULES' }`
- **Response:** `{ rules: Rule[] }`
- **Side effects:** none

#### `START_HISTORY_SCAN` *(Phase 3)*
- **Caller:** history-report.js
- **Payload:** `{ type: 'START_HISTORY_SCAN', reportTabId: number }`
- **Response:** `{ ok: true }` (immediately; progress arrives via push `SCAN_PROGRESS` messages)
- **Side effects:** Starts `HistoryScanner.start(reportTabId)`. Scanner pushes progress to `reportTabId` via `chrome.tabs.sendMessage`.

#### `CANCEL_HISTORY_SCAN` *(Phase 3)*
- **Caller:** history-report.js
- **Payload:** `{ type: 'CANCEL_HISTORY_SCAN' }`
- **Response:** `{ ok: true }`
- **Side effects:** Sets `urlguard_scan_state.status = 'cancelled'` in `chrome.storage.session`

#### `GET_SCAN_RESULTS` *(Phase 3)*
- **Caller:** history-report.js
- **Payload:** `{ type: 'GET_SCAN_RESULTS' }`
- **Response:** Full scan state from `chrome.storage.session`
- **Side effects:** none

### Tab cleanup

```javascript
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await RedirectTracker.clear(tabId);  // no-op until Phase 2
  await chrome.storage.session.remove([`tab_${tabId}`, `chain_${tabId}`]);
});
```

---

## P1 · heuristics.js

Pure synchronous analysis. No async, no network, no imports beyond psl at module init.

Wrap the entire `analyzeUrl` call in `devTiming` (see dev instrumentation section). Log a warning if it exceeds 10ms.

```javascript
export function analyzeUrl(urlString) {
  // Returns { signals: Signal[], totalHeuristicScore: number }
  // Signal: { id, label, weight, detail }
  // Returns { signals: [], totalHeuristicScore: 0 } on parse failure
}
```

### Signals

Each is a named sub-function returning `Signal | null`. Call all in `analyzeUrl`, filter nulls, sum weights.

#### `ip_literal` — 25 pts
`/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)`

#### `at_trick` — 25 pts
`new URL(urlString).username !== ''` or `.password !== ''`

#### `homoglyph` — 30 pts
Two-step detection:
1. Check if hostname contains any non-ASCII character: `/[^\x00-\x7F]/.test(hostname)`. If not, skip.
2. Strip all non-ASCII characters from hostname to produce an ASCII-only approximation (e.g. `pаypal.com` with Cyrillic `а` → `pypal.com`). Compute levenshtein distance between this stripped form and each brand name below. Flag if distance ≤ 2.

Do not use punycode decoding or Unicode normalization — just strip non-ASCII bytes entirely for the comparison. This is conservative: it may miss some substitutions but avoids false positives from legitimate IDN domains.

Implement levenshtein inline (standard DP matrix, no library).

Brand list: `google, paypal, amazon, apple, microsoft, facebook, instagram, netflix, twitter, linkedin, chase, wellsfargo, bankofamerica, coinbase, binance, steam, discord, spotify, dropbox, adobe`

When the implementation detail is ambiguous across any heuristic, prefer the simpler conservative signal over aggressive matching.

#### `typosquatting` — 20 pts
Registered domain (without TLD) normalized with digit substitutions (`0→o, 1→i, 3→e, 4→a, 5→s`) has levenshtein distance ≤ 2 from any brand above AND is not an exact match.

#### `risky_tld` — 12 pts
TLD in the risky set. Note in README: this signal alone is weak — `.xyz` hosts many legitimate sites. It only contributes meaningfully when combined with other signals.

Risky set (store in `data/risky-tlds.json`): `.xyz .top .click .tk .ml .ga .cf .gq .buzz .work .loan .win .bid .stream .download .accountant .faith .review .trade .racing .party .date .men .science .kim .country .cricket .ninja .link .online .site .website .space .live`

#### `excess_subdomains` — 15 pts
`hostname.split('.').length - registeredDomain.split('.').length > 3`

#### `brand_in_domain` — 18 pts
Registered domain contains a brand keyword substring but is not that brand's known domain. Note in README: can false-positive on fan sites or commentary domains — use the exceptions list for legitimate cases.

Brand→domain map: `paypal→paypal.com, amazon→amazon.com, apple→apple.com, google→google.com, microsoft→microsoft.com, netflix→netflix.com, chase→chase.com, coinbase→coinbase.com, binance→binance.com, wellsfargo→wellsfargo.com, bankofamerica→bankofamerica.com, instagram→instagram.com, facebook→facebook.com, discord→discord.com, steam→steampowered.com, spotify→spotify.com`

#### `hyphen_spam` — 10 pts
`(registeredDomain.match(/-/g) || []).length >= 3`

#### `long_url` — 8 pts
`urlString.length > 200`

#### `many_params` — 8 pts
`[...new URL(urlString).searchParams].length > 8`

#### `url_shortener` — 10 pts
Hostname is a known shortener service as the final destination. Note in README: a shortener as the destination is a mild signal, not definitive. It contributes meaningfully only with other signals stacking.

Known shorteners: `bit.ly, tinyurl.com, t.co, ow.ly, buff.ly, is.gd, v.gd, rb.gy, cutt.ly, shorturl.at, tiny.cc, su.pr, snip.ly, rebrand.ly, bl.ink, short.io, t2m.io, clck.ru, lnkd.in`

#### `no_tls` — 8 pts
`new URL(urlString).protocol === 'http:'`

#### `numeric_domain` — 10 pts
Registered domain name part (without TLD) is > 60% digits AND length > 3.

#### `suspicious_encoding` — 15 pts
Two conditions, either triggers the signal:
1. Hostname contains any `%XX` sequence (legitimate hostnames are never percent-encoded): `/%[0-9a-fA-F]{2}/.test(hostname)`
2. Path contains more than 10 `%XX` sequences in total (count all occurrences, not just consecutive): `(pathname.match(/%[0-9a-fA-F]{2}/g) || []).length > 10`

### Heuristic calibration note

These weights are an untested baseline. Before declaring Phase 1 complete, manually score at least 20 known-safe and 20 known-bad URLs and verify thresholds produce sensible verdicts. Adjust weights if false-positive rate is unacceptable. Document the baseline and any adjustments in the README.

---

## P1 · blocklist-manager.js

### Feed definitions

```javascript
const FEEDS = [
  {
    id: 'urlhaus',
    name: 'URLhaus (abuse.ch)',
    url: 'https://urlhaus.abuse.ch/downloads/csv_recent/',
    type: 'csv',
    // Columns: id, dateadded, url, url_status, ...
    // Keep rows where column[3] === 'online', extract column[2] as URL entry
    matchType: 'full_url',
    refreshIntervalHours: 6
  },
  {
    id: 'openphish',
    name: 'OpenPhish Community',
    url: 'https://openphish.com/feed.txt',
    type: 'text_lines',  // one URL per line
    matchType: 'full_url',
    refreshIntervalHours: 12
  },
  {
    id: 'stopforumspam',
    name: 'StopForumSpam',
    url: 'https://www.stopforumspam.com/downloads/toxic_domains_whole.txt',
    type: 'text_lines',  // one domain per line
    matchType: 'domain',
    refreshIntervalHours: 24
  }
];

export const GSB_API_KEY = '';       // Phase 4
export const PHISHTANK_API_KEY = ''; // Phase 4
```

### IndexedDB schema — `urlguard_db` v1

**Store `blocklist`:** keyPath `id` (auto), unique index `idx_entry` on `entry`, index `idx_feed` on `feedId`, index `idx_type` on `matchType`. Entry: `{ id, entry, feedId, matchType, addedAt }`.

**Store `feed_meta`:** keyPath `feedId`. Entry: `{ feedId, lastFetched, entryCount, status: 'ok'|'error'|'pending' }`.

Wrap all IDB operations in a promise helper. On any IDB error, log and return a safe fallback. Never throw from an IDB operation into the scoring pipeline.

### Methods

```javascript
export async function initialize()       // first-install fetch of all feeds
export async function refreshAll()       // called by alarm
export async function refreshFeed(feed)  // fetch, parse, delete old entries for feedId, batch-write (500/tx)
// In dev mode, log: feed name, response size in bytes, parse duration ms, insert duration ms, final entry count
export async function checkUrl(url)      // indexed lookup — never a full table scan
// Returns: { matched, feedId, matchType, entry } or { matched: false, ... }
export async function getFeedStatus()    // returns feed_meta entries for all feeds
export function extractRegisteredDomain(urlString)  // psl-based, exported for reuse
```

`checkUrl` steps: 1) exact `full_url` match via `idx_entry`, 2) registered domain match where `matchType === 'domain'` via `idx_entry`.

On any fetch error in `refreshFeed`: log, update `feed_meta.status` to `'error'`, do not throw. The extension must continue working on cached data.

---

## P1 · scorer.js

### Thresholds
- 0–29 → `safe`
- 30–69 → `warn`
- 70–100 → `threat`

### `scoreUrl(urlString, tabId)`

`tabId` may be `null` (history scanner, Phase 3). When null, skip storage write.

**Phase 1 scorer.js must not import or reference RulesManager or RedirectTracker at all. Do not add stubs or placeholder calls for those modules. They are added in Phase 2 and Phase 3 respectively by directly extending this file at that time.**

```javascript
export async function scoreUrl(urlString, tabId) {
  // 1. Blocklist check
  const bl = await BlocklistManager.checkUrl(urlString);

  // 2. Heuristics (synchronous)
  const hr = Heuristics.analyzeUrl(urlString);

  // 3. Aggregate
  const signals = [...hr.signals];
  let score = hr.totalHeuristicScore;

  if (bl.matched) {
    score += 85;
    signals.unshift({ id: 'blocklist_hit', label: `Found in ${bl.feedId}`, weight: 85,
                      detail: `Matched ${bl.matchType}: ${bl.entry}` });
  }

  score = Math.min(100, score);
  const verdict = score >= 70 ? 'threat' : score >= 30 ? 'warn' : 'safe';
  const result = { score, verdict, source: 'scan', signals, redirectChain: [], url: urlString };
  if (tabId !== null) await cacheTabResult(tabId, urlString, result);
  return result;
}

async function cacheTabResult(tabId, url, result) {
  await chrome.storage.session.set({ [`tab_${tabId}`]: { ...result, timestamp: Date.now() } });
}
```

**When Phase 2 begins**, extend `scoreUrl` to add user rule checks (RulesManager) and redirect scoring (RedirectTracker) at the top and middle of the function respectively. The Phase 2 section below shows the full extended version.

**When Phase 3 begins**, extend `scoreUrl` further to add history flag checks. The Phase 3 section shows the full extended version.

---

## P1 · warning-overlay.js

Injected via `chrome.scripting.executeScript`. Best-effort. Do not depend on it as the primary user-facing surface.

```javascript
(async function() {
  if (document.getElementById('urlguard-overlay')) return;

  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATE' });
    // Content scripts use sender.tab.id automatically — no targetTabId needed here
  } catch { return; }

  if (!state || state.verdict !== 'threat') return;

  buildAndShowOverlay(state);
})();
```

Append overlay div to `document.documentElement` (not body — may not exist on all pages). Use `position:fixed; inset:0; z-index:2147483647; overflow-y:auto`. Self-contained — inline styles only, no external resources.

### Overlay sections

**1. Header** — threat title, score badge, source label

**2. Flagged URL** — monospace code block

**3. Signals list** — sorted by weight descending. Each row: `[+NN] Signal name` + plain-English explanation.

Plain-English explanations by signal ID:
- `blocklist_hit` → "This URL appears in a threat database maintained by security researchers."
- `history_flagged` → "URLGuard flagged this domain in a previous history scan."
- `ip_literal` → "The address uses a raw IP number. Legitimate websites almost never do this."
- `at_trick` → "The URL contains @ — browsers ignore everything before it, hiding the real destination."
- `homoglyph` → "The domain contains characters that look like normal letters but aren't — a brand impersonation tactic."
- `typosquatting` → "This domain closely resembles a well-known brand with a character or two changed."
- `brand_in_domain` → "A well-known brand name appears in this domain, but it is not that brand's real website."
- `risky_tld` → "This domain extension is disproportionately used in spam and phishing."
- `redirect_chain` → "You were redirected through multiple websites to arrive here."
- `excess_subdomains` → "The domain has an unusual number of nested subdomains."
- `no_tls` → "This page uses unencrypted HTTP."
- `url_shortener` → "This is a URL shortener service, hiding the real destination."
- `suspicious_encoding` → "The URL contains unusual character encoding that can disguise the real destination."
- `numeric_domain` → "This domain name is mostly numbers, which is uncommon for legitimate websites."
- `hyphen_spam` → "Excessive hyphens are common in auto-generated spam domains."
- `many_params` → "Unusually high number of URL parameters."
- `long_url` → "Unusually long URL, sometimes used to obscure the destination."
- (unknown) → display `signal.label` and `signal.detail` directly

**4. Redirect chain** — only if `state.redirectChain.length >= 2`. Numbered list of hops with type labels. Mark cross-origin hops.

**5. Action buttons** — always all three visible:
- "← Go back to safety" (green, primary) → `history.back()`, or `window.close()` if `history.length <= 1`
- "Block this domain" (red outline) → `ADD_BLOCK` message, then `history.back()`
- "I understand — proceed anyway" (gray link style) → remove overlay from DOM, restore scroll, send `DISMISS_WARNING`

**6. Footer** — "Add permanent exception" link → `ADD_EXCEPTION` then remove overlay. Score display.

If `GET_TAB_STATE` returns null after injection (worker restarted between trigger and execution): do nothing. Do not show a broken or empty overlay.

---

## P1 · click-monitor.js

```javascript
// Multi-window spawn detection
const _nativeOpen = window.open.bind(window);
let _openCount = 0, _openTimer = null;

window.open = function(...args) {
  _openCount++;
  clearTimeout(_openTimer);
  _openTimer = setTimeout(() => { _openCount = 0; }, 600);
  if (_openCount >= 2) {
    try { chrome.runtime.sendMessage({ type: 'MULTI_CLICK_DETECTED', count: _openCount }); } catch (_) {}
  }
  return _nativeOpen(...args);
};

// Meta-refresh detection
function checkMetaRefresh() {
  const meta = document.querySelector('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]');
  if (!meta) return;
  const content = meta.getAttribute('content') || '';
  const match = content.match(/url\s*=\s*["']?([^"'\s;]+)/i);
  if (!match) return;
  try { chrome.runtime.sendMessage({ type: 'META_REFRESH_DETECTED', targetUrl: match[1], delay: parseInt(content, 10) || 0 }); } catch (_) {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkMetaRefresh, { once: true });
} else { checkMetaRefresh(); }

// SPA / JS redirect detection
const _nativePush = history.pushState.bind(history);
const _nativeReplace = history.replaceState.bind(history);
let _lastHref = location.href;

function reportJsRedirect(to) {
  if (to === _lastHref) return;
  try { chrome.runtime.sendMessage({ type: 'JS_REDIRECT_DETECTED', targetUrl: to, fromUrl: _lastHref }); } catch (_) {}
  _lastHref = to;
}

history.pushState = function(...a) { _nativePush(...a); reportJsRedirect(location.href); };
history.replaceState = function(...a) { _nativeReplace(...a); reportJsRedirect(location.href); };
```

---

## P1 · popup.html + popup.js (Phase 1 version)

340px wide. Populate synchronously from storage — no spinners.

popup.js on load:
1. `const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })`
2. Send `GET_TAB_STATE` with `targetTabId: tab.id`
3. Render status card based on response. If null, show neutral state.

Sections: header with domain, status card (safe/warn/threat with score and top signals), feed status (last refreshed from `chrome.storage.local`). Rules panel and quick actions are Phase 2.

---

## Phase 1 verification checklist

**Complete all of these before starting Phase 2. Do not proceed on partial passes.**

1. Navigate to a URLhaus URL → red icon + "✕" badge + overlay appears with "Found in URLhaus" signal
2. Navigate to `http://1.2.3.4/` → `ip_literal` signal fires
3. Navigate to `http://gooogle.com` → `typosquatting` signal fires
4. Navigate to any `.xyz` domain → `risky_tld` signal fires (check score — alone it should not exceed 12, staying below the warn threshold without other signals)
5. A page calling `window.open` twice → `MULTI_CLICK_DETECTED`, icon upgrades if threshold crossed
6. Popup correctly shows score and top signals for current tab
7. "Proceed anyway" on overlay → overlay dismissed, icon downgrades to warn (amber), page accessible
8. Worker restart test: idle 60+ seconds, open popup → state still correct (loaded from storage)
9. Manual baseline: score 20 known-safe and 20 known-bad URLs, verify no safe URL exceeds 29 and most known-bad URLs exceed 30. Adjust weights if failing.

---

---

# PHASE 2 — Redirect tracking + rules management

---

## P2 · scorer.js extension

At the start of Phase 2, replace the Phase 1 `scoreUrl` with this extended version. It adds user rule checks (RulesManager) and redirect scoring (RedirectTracker). The blocklist and heuristics logic is unchanged.

```javascript
export async function scoreUrl(urlString, tabId) {
  // 1. User exception check — highest priority
  const userRule = await RulesManager.checkUrl(urlString);
  if (userRule === 'allow') {
    const r = { score: 0, verdict: 'safe', source: 'user_exception', signals: [], redirectChain: [] };
    if (tabId !== null) await cacheTabResult(tabId, urlString, r);
    return r;
  }
  // 'block' rules are enforced by DNR at the network level and do not require special scoring behavior.
  // If scoring runs for a blocked domain (e.g. from history scanner), score it normally.

  // 2. Blocklist check
  const bl = await BlocklistManager.checkUrl(urlString);

  // 3. Heuristics
  const hr = Heuristics.analyzeUrl(urlString);

  // 4. Redirect score
  let redirectScore = 0, redirectChain = [];
  if (tabId !== null) {
    redirectScore = await RedirectTracker.getRedirectScore(tabId);
    redirectChain = await RedirectTracker.getChain(tabId);
  }

  // 5. Aggregate
  const signals = [...hr.signals];
  let score = hr.totalHeuristicScore + redirectScore;

  if (bl.matched) {
    score += 85;
    signals.unshift({ id: 'blocklist_hit', label: `Found in ${bl.feedId}`, weight: 85,
                      detail: `Matched ${bl.matchType}: ${bl.entry}` });
  }
  if (redirectScore > 0) {
    signals.push({ id: 'redirect_chain', label: 'Suspicious redirect chain', weight: redirectScore,
                   detail: buildRedirectSummary(redirectChain) });
  }

  score = Math.min(100, score);
  const verdict = score >= 70 ? 'threat' : score >= 30 ? 'warn' : 'safe';
  const result = { score, verdict, source: 'scan', signals, redirectChain, url: urlString };
  if (tabId !== null) await cacheTabResult(tabId, urlString, result);
  return result;
}

function buildRedirectSummary(chain) {
  if (chain.length < 2) return '';
  const x = chain.filter((h, i) => i > 0 && h.domain !== chain[i-1]?.domain).length;
  return `${chain.length} hops, ${x} cross-origin`;
}
```

**When Phase 3 begins**, add history flag check at the top of `scoreUrl`, before the user rule check:

```javascript
  // 0. History flag check — immediate threat for previously flagged domains
  const historyFlag = await RulesManager.checkHistoryFlag(urlString);
  if (historyFlag) {
    const score = Math.max(historyFlag.score, 75);
    const r = {
      score, verdict: 'threat', source: 'history_scan',
      signals: [{ id: 'history_flagged', label: 'Previously flagged in history scan',
                  weight: score, detail: `Flagged ${new Date(historyFlag.flaggedAt).toLocaleDateString()} with score ${historyFlag.score}` }],
      redirectChain: tabId !== null ? await RedirectTracker.getChain(tabId) : []
    };
    if (tabId !== null) await cacheTabResult(tabId, urlString, r);
    return r;
  }
```

---

## P2 · redirect-tracker.js

### Storage

Chain stored in `chrome.storage.session` keyed `chain_{tabId}`. Module-level Map is write-through cache only.

Chain entry shape: `{ url, domain, hopType: 'initial'|'http_redirect'|'js_redirect'|'meta_refresh'|'nav_redirect', timestamp, fromUrl }`

All methods are async. On read: check cache Map first, then storage. On write: update both.

```javascript
export async function startChain(tabId, url)
export async function addHop(tabId, url, hopType, fromUrl = null)
// Limit to 20 hops max. Initialize chain if missing.
export async function getChain(tabId)      // [] if not found
export async function getRedirectScore(tabId)
export async function clear(tabId)
```

`getRedirectScore` scoring:
- length ≥ 3: +15
- length ≥ 5: +25 additional (not cumulative with +15 — use the higher)
- any cross-origin hop: +20
- 2+ cross-origin hops: +10 additional
- any `meta_refresh` or `js_redirect` hop: +10
- loop detected (same URL twice): +35
- known shortener in intermediate hop: +15
- cap at 60

Add to service-worker.js:

```javascript
chrome.webRequest.onBeforeRedirect.addListener(
  (d) => { if (d.frameId === 0) RedirectTracker.addHop(d.tabId, d.redirectUrl, 'http_redirect', d.url); },
  { urls: ['<all_urls>'] }
);
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) RedirectTracker.startChain(d.tabId, d.url);
});
```

---

## P2 · rules-manager.js

### Storage keys
- `chrome.storage.sync` → `urlguard_rules`: `Rule[]`
- `chrome.storage.session` → `urlguard_history_flags`: `Record<domain, HistoryFlag>`

Rule shape: `{ domain, action: 'block'|'allow', addedAt, ruleId: number|null }`
HistoryFlag shape: `{ domain, score, url, flaggedAt }`

### Match logic
Extract registered domain via psl. Rule matches if: rule.domain equals registered domain, OR the URL's full hostname ends with `.${rule.domain}`.

### DNR rule ID

```javascript
function domainToRuleId(domain) {
  let h = 0;
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 90000) + 10000;
}
```

### Startup DNR drift repair

On `chrome.runtime.onStartup`, verify that stored block rules are reflected in active dynamic rules and repair any drift:

```javascript
chrome.runtime.onStartup.addListener(async () => {
  const rules = await RulesManager.getAll();
  const blockRules = rules.filter(r => r.action === 'block' && r.ruleId);
  const activeDNR = await chrome.declarativeNetRequest.getDynamicRules();
  const activeIds = new Set(activeDNR.map(r => r.id));

  const toAdd = blockRules.filter(r => !activeIds.has(r.ruleId));
  for (const rule of toAdd) {
    await createDNRBlock(rule.domain, rule.ruleId);
  }
  // Note: do not blindly re-apply all rules — only repair missing ones
});
```

### Methods

```javascript
export async function checkUrl(urlString)              // 'block' | 'allow' | null
export async function checkHistoryFlag(urlString)      // HistoryFlag | null
export async function addBlock(domain)                 // writes rule + creates DNR
export async function addException(domain)             // writes rule, no DNR
export async function remove(domain)                   // removes rule + DNR if applicable
export async function addHistoryFlag(domain, score, url, flaggedAt)
export async function removeHistoryFlag(domain)
export async function getAll()                         // Rule[]
```

```javascript
async function createDNRBlock(domain, ruleId) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{ id: ruleId, priority: 1, action: { type: 'block' },
                 condition: { requestDomains: [domain], resourceTypes: ['main_frame', 'sub_frame'] } }],
    removeRuleIds: []
  });
}
async function removeDNRBlock(ruleId) {
  await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [], removeRuleIds: [ruleId] });
}
```

---

## P2 · Popup updates

Add to popup:

**Quick actions:** Block/unblock domain toggle, add/remove exception toggle for current tab's domain.

**Rules panel** (`<details>/<summary>` — no JS needed for expand/collapse):
- Blocked domains list with ✕ remove buttons
- Exceptions list with ✕ remove buttons
- "Clear all rules" with inline double-confirm

popup.js for rules actions: include `targetTabId: tab.id` in `ADD_BLOCK` and `ADD_EXCEPTION` payloads so service worker can re-score and update the icon for that tab after rule change.

---

## Phase 2 verification checklist

1. Add block rule → navigate to domain → page does not load (DNR hard block)
2. Remove block rule → navigate → page loads normally
3. Add exception for suspicious domain → score forced to 0, icon stays normal
4. Force browser restart → navigate to previously blocked domain → still blocked (drift repair on startup)
5. 4-hop redirect chain → redirect signals appear in overlay and popup
6. Meta-refresh cross-domain detected → `meta_refresh` hop in chain
7. Popup rules panel shows current rules with working remove buttons
8. `ADD_BLOCK` from popup with `targetTabId` → icon for that tab updates correctly

---

---

# PHASE 3 — History scan

---

## P3 · history-scanner.js

### This is a domain reputation scan

Group all history items by registered domain. Pick the most-frequently-visited URL as the representative URL (not most recent — a single unusual visit to a normal domain must not corrupt the whole domain's score). Score at the domain level using `Scorer.scoreUrl(representativeUrl, null)`.

All scan state lives in `chrome.storage.session` under `urlguard_scan_state`.

```javascript
// Scan state shape:
{
  status: 'idle'|'running'|'done'|'cancelled',
  totalDomains: number,
  scannedDomains: number,
  results: ScanResult[],  // maintained sorted by score desc
  startedAt: number|null,
  completedAt: number|null
}

// ScanResult shape:
{
  domain, representativeUrl, topUrls: string[],  // up to 3 most-visited URLs
  score, verdict, signals,
  visitCount, lastVisit
}
```

### `start(reportTabId)`

1. Initialize state in storage
2. Fetch 30 days of history via `chrome.history.search({ text:'', startTime: now-30days, maxResults: 100000 })`
3. Group by registered domain using psl. For each domain: track URL visit counts, pick highest-count URL as representative, collect top 3 URLs, accumulate total visit count and latest visit time
4. Score in batches of 20. Between batches: check cancellation flag from storage, yield with `await new Promise(r => setTimeout(r, 0))`, push progress to report tab
5. Only store results with score ≥ 30. Insert in score-descending order, write to storage after each insert
6. On completion: write `status: 'done'`, persist domains scoring ≥ 70 as history flags via `RulesManager.addHistoryFlag`
7. Push final progress

Push progress via `chrome.tabs.sendMessage(reportTabId, { type: 'SCAN_PROGRESS', state })`. This targets the history-report extension page by its tab ID — extension pages receive messages sent to their tab ID via `chrome.tabs.sendMessage` just like any other tab, and they listen with `chrome.runtime.onMessage`. The `reportTabId` is passed in the `START_HISTORY_SCAN` payload by history-report.js when it starts the scan (see P3 · history-report.js below). If `chrome.tabs.sendMessage` throws because the tab was closed, catch and continue the scan silently.

```javascript
export async function start(reportTabId)
export async function cancel()   // sets status = 'cancelled' in storage
export async function getResults()  // returns scan state from storage
```

---

## P3 · history-report.html + history-report.js

### Page states

**Pre-scan:** description of domain reputation scan, "This scan groups your history by domain. Individual page URLs are not scored separately." Start button.

**Scanning:** Progress bar with live count `X / Y domains`, "Z flagged so far", Cancel link.

**Done/Cancelled:** Summary bar. Filter bar. Results list.

### Filter bar
- Search input: live domain string filter
- Score dropdown: All / High risk (70+) / Suspicious (30–69)
- Source dropdown: All / URLhaus / OpenPhish / StopForumSpam / Heuristics only

Filtering is pure client-side on the full results array. No re-scan on filter change.

### Result card

Score badge (red ≥ 70, amber 30–69), domain, visit count, relative last-visit time, top 3 signal tags, representative URL as non-clickable text, four action buttons:

- **Block domain** → `ADD_BLOCK`, card updates to "Blocked ✓", `removeHistoryFlag`
- **Add exception** → `ADD_EXCEPTION`, card updates to "Exception added ✓", `removeHistoryFlag`
- **Open URL** → `chrome.tabs.create({ url: result.representativeUrl })` — warning overlay will fire if domain remains flagged
- **Remove from history** → `chrome.history.deleteUrl` for all topUrls, `removeHistoryFlag`, fade-out card

### history-report.js behavior

```javascript
const myTab = await chrome.tabs.getCurrent();
const myTabId = myTab.id;
```

On load: `GET_SCAN_RESULTS` → if status is done/cancelled, show results immediately (survives page refresh).
"Start scan": send `START_HISTORY_SCAN` with `reportTabId: myTabId`.

**Progress updates — push with polling fallback:**
Primary: listen for `SCAN_PROGRESS` push messages via `chrome.runtime.onMessage`. On receipt, update progress bar and live counts.
Fallback: also start a `setInterval` polling `GET_SCAN_RESULTS` every 750ms while status is `running`. If push messages arrive reliably, the polling reads will be redundant but harmless. If push messaging proves unreliable (extension page messaging can be inconsistent in some Chrome versions), the polling ensures the UI stays live regardless. Cancel the interval when status transitions to `done` or `cancelled`.

---

## Phase 3 verification checklist

1. Pre-scan state renders correctly with domain-scan description
2. Start scan → progress bar updates with live domain counts
3. Scan completes → results sorted by score descending
4. Score filter works live
5. Domain search filters live
6. Block result domain → card shows "Blocked ✓" → navigate to domain → hard blocked
7. Add exception → card shows "Exception added ✓" → navigate → no warning
8. Remove from history → card fades out, history entry deleted
9. Refresh history-report page mid-scan → progress and partial results restored from storage
10. Navigate to domain that scored ≥ 70 in scan → immediate threat overlay with `history_flagged` signal

---

---

# PHASE 4 — Feed refresh + optional APIs

---

## P4 · Google Safe Browsing v4

**Privacy:** The v4 `threatMatches:find` API sends full URLs to Google's servers. This is a direct privacy tradeoff — not a hash-based privacy-preserving lookup. When `GSB_API_KEY` is non-empty, display a persistent notice in the popup feed status panel: "Google Safe Browsing is enabled — visited URLs are sent to Google for checking."

```javascript
export async function checkUrlWithGSB(urlString) {
  if (!GSB_API_KEY) return null;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${GSB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'urlguard', clientVersion: '1.0.0' },
        threatInfo: {
          threatTypes: ['MALWARE','SOCIAL_ENGINEERING','UNWANTED_SOFTWARE','POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: [{ url: urlString }]
        }
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.matches?.length > 0 ? { threatType: data.matches[0].threatType } : null;
  } catch { return null; }
}
```

Add GSB check in `scorer.js` after local blocklist check. Positive result adds +85 and a `gsb_hit` signal.

## P4 · PhishTank

Add as an optional feed when `PHISHTANK_API_KEY` is set:
```javascript
{ id: 'phishtank', name: 'PhishTank', matchType: 'full_url', refreshIntervalHours: 12,
  url: `https://data.phishtank.com/data/${PHISHTANK_API_KEY}/online-valid.json.gz`,
  type: 'json_gz' }
// Parse: JSON array of objects, extract the 'url' field from each entry
// Response is gzip-compressed — use DecompressionStream if available in the browser context
```

## P4 · Popup feed status panel

Collapsible panel showing for each feed: name, last updated (relative time), entry count, status dot (green=ok, amber=>24h, red=error). GSB shows "per-URL check — live" when active. "Refresh feeds now" button triggers `BlocklistManager.refreshAll()`.

---

## Phase 4 verification checklist

1. Set GSB_API_KEY → navigate to a GSB-listed URL → `gsb_hit` signal fires at +85
2. GSB privacy notice visible in popup when key is set
3. Feed status panel shows correct timestamps and entry counts
4. "Refresh feeds now" updates timestamps
5. Simulate feed fetch failure → status dot red, extension continues on cached data

---

---

# CROSS-CUTTING REQUIREMENTS

## Error handling rule

Do not use broad `try/catch` blocks that swallow logic errors silently. `try/catch` is appropriate only at browser API boundaries — places where Chrome APIs may throw due to tab closure, context invalidation, or storage unavailability. It is not appropriate around application logic, scoring, parsing, or rule evaluation.

**Correct use:**
```javascript
// Browser API boundary — catch is appropriate
try {
  await chrome.tabs.sendMessage(tabId, payload);
} catch { /* tab closed — ignore */ }
```

**Incorrect use:**
```javascript
// Logic wrapped in catch — hides bugs
try {
  const result = await scoreUrl(url, tabId);
  updateIcon(result.verdict);
} catch { /* silent */ }
```

If `scoreUrl` throws, that is a bug that needs to surface, not be absorbed. Let logic errors propagate so they appear in the service worker's error log during development.

```javascript
const DEV_MODE = true; // set false before release

function devLog(...args) { if (DEV_MODE) console.log('[URLGuard]', ...args); }

function devTiming(label, fn) {
  if (!DEV_MODE) return fn();
  const t0 = performance.now();
  const result = fn();
  const elapsed = performance.now() - t0;
  if (elapsed > 10) console.warn(`[URLGuard] SLOW: ${label} took ${elapsed.toFixed(1)}ms`);
  return result;
}
```

Wrap `Heuristics.analyzeUrl` in `devTiming`. Log score results with `devLog`.

## Visual design

Colors: safe `#059669`, warn `#D97706`, threat `#DC2626`. Background light `#FFFFFF` / dark `#1A1A1A`. Surface light `#F9FAFB` / dark `#262626`. Text primary light `#111827` / dark `#F9FAFB`. Border light `#E5E7EB` / dark `#374151`.

Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`

Popup: 340px wide. No animations. Synchronous population from storage.

Overlay: max content width 680px, centered, 40px side padding. Tone is professional and informative — not alarmist. Always show all three action choices.

Icons: shield SVG in three states (neutral gray, amber with "!", red with ✕) at 16px, 48px, 128px. Legible at 16px.

## README — required sections

1. What URLGuard does and does not do (advisory model)
2. The two blocking modes and why this distinction exists
3. Non-goals (no ML, no telemetry, no cloud backend, no page content analysis)
4. How to load as unpacked extension
5. How to obtain and bundle `psl.min.js`
6. Google Safe Browsing: how to add the API key and the privacy tradeoff
7. PhishTank: how to add the API key
8. Detection signals — plain-English explanation of each
9. History scan — what "domain reputation scan" means, how representative URLs are chosen, how to read results
10. Heuristic baseline disclaimer — weights are untested starting points; false positives are possible; use the exceptions list
11. Known limitations:
    - Advisory-only: detected threats cannot stop a page from loading
    - Overlay is best-effort and may appear briefly after page loads or fail silently on some page types
    - Icon and popup are the canonical warning surfaces
    - Service worker restarts after ~30s idle — state is preserved in storage
    - Feed coverage: new URLs may not appear for hours or days
12. Privacy: what stays local, what GSB optionally sends to Google, nothing else leaves the browser
