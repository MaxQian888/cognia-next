---
"cognia-next": minor
---

System-1 decisions as a platform capability: a new Settings → Conversation → Decision provider card picks who answers typed yes/no, pick-one and score questions — the local laya plugin ("Laya (local)", now a decision provider) or a remote TypeSafe-compatible endpoint (OpenRouter, Bocha Jev, TypeSafe, Vercel, OpenCode Zen, custom URL; key kept in the keyring) — with a one-click connection test. Plugins get `ctx.decisions` (`decisions:run`) and can contribute providers via `decisionProviders[]` (`decisions:provide`); every request is redacted and PII-gated before any provider sees it.
