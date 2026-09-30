---
"cognia-next": patch
---

Fix the perf HUD auto-mounting on production web/Pages bundles: `globalThis.process` is absent in real browsers, so the `NODE_ENV !== "production"` gate read `""` and treated production as dev. Non-production auto-mount now requires an explicit non-empty `NODE_ENV`. Also ship `public/_worker.js`, a Pages Function that scopes the public share host to `/share/view` and real assets, redirecting all other routes instead of exposing the full app shell.
