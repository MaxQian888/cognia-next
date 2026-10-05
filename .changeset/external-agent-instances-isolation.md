---
"cognia-next": minor
---

External agents: several configurations of one runtime are now truly separate. New and duplicated configurations get their own state folder (their own sign-in, settings and history; existing ones keep the shared state until switched), launch with their own saved credentials after a restart, can bind their own Codex subscription account, and honour their session limit and approval lists. Duplicating asks for a name, state and enablement first; settings group agents by runtime and show what sets each apart, with inline rename and a responsive list → detail layout; the phone gains a per-agent detail screen and Host-side duplicate. Plugins get `ctx.externalAgents` (read / manage permissions, change events), and `runExternalAgent` is clamped to the configuration's own permission mode.
