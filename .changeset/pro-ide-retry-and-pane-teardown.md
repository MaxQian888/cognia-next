---
"cognia-next": patch
---

Pro IDE (embedded code-server): the pane's Retry button now actually recovers. An instance the health watchdog gave up on is flagged unhealthy backend-side, so `codeserver_ensure` kills that child and spawns a fresh one instead of handing back the port of a process that is alive but no longer serving — previously Retry flipped straight back to a dead VS Code page and only Performance → Managed Processes could recover it. Stopping or restarting a code-server from Managed Processes, and reclaiming disk from Settings → Pro IDE, now also tear down the native pane instead of leaving a dead page pinned above the app.
