---
"cognia-next": patch
---

The plugin SDK's `api/*` subpaths no longer re-export host wiring that no plugin used: the `create*API` factories behind `ctx.*`, the host's manifest bridges (`register*ForPlugin` / `unregister*ForPlugin`), teardown helpers, the chat-middleware breaker bookkeeping, the density DOM appliers and the tool-route database helpers. Plugins keep reaching all of it through `ctx.*` and their manifest contributions; the deprecated monorepo-only `host` entry is gone.
