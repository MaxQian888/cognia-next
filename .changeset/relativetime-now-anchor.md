---
"cognia-next": patch
---

Fix an `ENVIRONMENT_FALLBACK` runtime warning and non-deterministic relative timestamps across the app. Several surfaces rendered "3 minutes ago"-style times via next-intl's `relativeTime` without passing a `now` reference, so next-intl fell back to reading the wall clock at format time — logging a console error and risking SSR/hydration mismatch. Every such call now anchors to a stable render-time `now` from `useNow()`: the Inbox conversation list and activity log, the Memory row and detail panel, the mobile channel list, command history, Today stats card and recent-runs feed, and the workflow editor node footer.
