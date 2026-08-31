---
"cognia-next": minor
---

Embed the Pro IDE workbench in a browser running on the host's own machine. The workbench answers on a loopback port on the host, and the only route across a network authenticates the device on every request, which an iframe cannot do. The host now discloses that port to a caller that arrived on its loopback-bound plaintext listener, and only to that caller, so a browser on the same machine frames the workbench directly instead of being told to go and use the desktop app. Everything else keeps the explanation it had. If code-server refuses to be framed, the same URL is offered as a link.
