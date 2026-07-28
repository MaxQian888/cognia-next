---
"cognia-next": patch
---

Verify signed compatibility manifests through the Web Crypto API instead of `node:crypto`. The deployment certification store no longer pulls a Node builtin into the static export the desktop and mobile shells load, so signature verification stays available wherever the app runs; verifying a manifest is now asynchronous.
