---
"cognia-next": patch
---

Headless (cognia-server) brains now rehydrate their persisted external agents on boot. The external-agent rehydration logic is shared with the desktop initializer (ADR-0059 T-A10), so a server restart brings ACP / OpenCode / plugin-contributed agents back into the manager and reconnects the ones set to auto-connect — previously only the desktop did this, and a headless restart left them dormant. The manager (and its health-check interval) is only instantiated when there is actually an agent to rehydrate.
