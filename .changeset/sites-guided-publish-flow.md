---
"cognia-next": minor
---

Sites: rework the deploy dashboard into a single-page guided publish flow. The detail pane now shows progressive Connect → Environment → Build → Preview → Publish steps with live per-operation progress (driven by the durable operation event stream), automatic Wrangler detection and approval (no more pasting an absolute binary path), and a responsive layout that respects `prefers-reduced-motion` with first-load skeletons. Advanced provider configuration (visitor access, custom domains, provider token, authoring policy, and observability) moves into a collapsible drawer, and site creation moves into a dialog.
