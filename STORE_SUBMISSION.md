# Chrome Web Store Submission Guide — URLGuard

## Privacy Policy (REQUIRED)

Google requires a privacy policy URL for extensions using `<all_urls>`, `webRequest`, or `tabs` permissions.

You need to host a privacy policy page that states:

1. **What data is collected**: URLGuard monitors web request URLs and domain names to detect redirects and background requests. All data is stored locally on the user's device using `chrome.storage.local` and `chrome.storage.session`.
2. **What data is NOT collected**: No data is transmitted to any external server. No analytics, no telemetry, no user tracking.
3. **What permissions are used and why**:
   - `webRequest` — Monitor HTTP requests to detect redirects and background requests
   - `webNavigation` — Detect when navigations start and complete, to identify redirect chains
   - `tabs` — Read the active tab URL to show per-site activity in the popup
   - `storage` — Persist blocked/allowed domain lists locally
   - `declarativeNetRequest` + `declarativeNetRequestWithHostAccess` — Block requests to domains the user has chosen to block
   - `notifications` — (currently unused, consider removing before submission)
   - `<all_urls>` host permission — Required to monitor requests across all websites
4. **Data retention**: Session data is cleared when the browser closes. Blocked/allowed lists persist until the user removes them.

**Where to host**: GitHub Pages, a simple static site, or a GitHub repo page all work.

## Permission Justifications (entered during submission)

During Chrome Web Store submission, you must justify each permission. Use these:

| Permission | Justification |
|---|---|
| `webRequest` | Required to detect HTTP redirects and third-party background requests on behalf of the user |
| `webNavigation` | Required to detect navigation start/commit to identify redirect chains and domain mismatches |
| `tabs` | Required to identify the active tab URL and show per-site activity |
| `storage` | Required to persist user's blocked and allowed domain lists across sessions |
| `declarativeNetRequest` | Required to block network requests to domains the user has explicitly chosen to block |
| `declarativeNetRequestWithHostAccess` | Required to apply blocking rules across all websites |
| `host_permissions: <all_urls>` | Required to monitor and block requests on any website the user visits |

## `notifications` Permission

The `notifications` permission is declared but never used in the code. **Remove it before submission** to avoid an unnecessary permission review flag. (Already handled in the manifest cleanup.)

## Store Listing Assets Needed

Before uploading to the Chrome Web Store developer dashboard, prepare:

1. **Extension icon** — 128x128 PNG (already have: `icons/icon-128.png`)
2. **Screenshots** — At least 1, up to 5. Size: 1280x800 or 640x400. Show the popup in action.
3. **Promotional images** (optional but recommended):
   - Small promo tile: 440x280
   - Marquee promo: 1400x560
4. **Detailed description** — Longer than manifest description. Explain what the extension does, how it protects users.
5. **Category** — "Productivity" or "Developer Tools"
6. **Language** — English

## Submission ZIP

The zip should contain only the `urlguard/` directory contents (not the parent). See the build script or run:

```bash
cd urlguard && zip -r ../urlguard-1.0.0.zip . -x '.*'
```
