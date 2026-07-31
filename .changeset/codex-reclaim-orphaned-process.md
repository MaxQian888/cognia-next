---
"cognia-next": patch
---

Fix an external agent becoming permanently unconnectable with "Agent … is already running". The desktop process manager keys running agents by their saved agent id and outlives the page, so anything that restarts the page's JavaScript — the white-screen watchdog reloading, a dev hot-reload, or a connect that failed partway — left behind a process nothing was listening to, while every reconnect was refused because that id was still taken. The only way out was restarting the whole app. Reconnecting now reclaims the abandoned process instead of failing, for Codex, OpenCode and ACP agents alike. A Codex connect that fails partway also shuts its process down rather than leaving one behind, so a single failed attempt no longer poisons every retry. Spawn failures that aren't an id collision are still reported as before.
