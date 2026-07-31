---
"cognia-next": patch
---

Fix the app hard-freezing as soon as an external agent (Codex, Claude Code, …) is added or auto-connected on startup. Two independent runaway loops in the external-agent layer are fixed:

- The agent status projection wrote the store on every pass — its guard treated "this agent has a validity snapshot" (true for the entire life of a connected agent) as "the validity changed" — and the store subscriber re-ran the projection on every write. The two drove each other forever, starving the browser's task queue (so the window stopped repainting and the desktop white-screen watchdog reloaded three times and gave up) while re-serializing the whole store to localStorage each turn, which ran the renderer up to tens of GB of memory. The projection now only writes when the connection status or validity genuinely changed.
- The store's selectors re-hydrated each agent's `createdAt`/`updatedAt` into fresh `Date` objects on every call, so subscribed components could never read an equal snapshot and re-rendered forever. Hydrated configs are now cached per stored agent.

Both only triggered once at least one agent existed, and both recurred on every restart because agents are persisted and reconnected on boot.
