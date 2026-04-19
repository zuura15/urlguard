# InControl TODOs

## P3: OAuth popup false positive mitigation
**What:** Add known OAuth/payment domains to an internal whitelist that suppresses the `multi_click` signal.
**Why:** Reduces false positives for legitimate auth flows (Google OAuth, Stripe, PayPal popups trigger +40 pts).
**Effort:** S
**Priority:** P3
**Depends on:** Phase 1 complete
**Context:** Current behavior: any page opening 2+ windows in 600ms gets +40 points. Real-world OAuth flows trigger this. Users can work around it by adding exceptions manually, but an internal whitelist would be cleaner.
