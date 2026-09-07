---
"cognia-next": patch
---

Cognia Cloud can be stood up and proven locally: LOGTO.md gains a local runbook, `pnpm logto:seed` seeds Logto (API resource, apps, GitHub and Feishu connectors, organization roles) from a machine-to-machine credential and prints the exact env lines, and `compose-smoke --tier cloud` drives claim, invite and accept against the running stack.
