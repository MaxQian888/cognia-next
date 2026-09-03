---
"cognia-next": patch
---

Fix every renderer-owned tool hanging the turn when the chat runs on a paired host. Plugin tools, artifacts and canvas, web_fetch, ask_user, dispatch_agent and tool-result review are executed by whichever client started the turn, and two independent gates stopped that from working for a browser or phone: the host never advertised that it can proxy tools at all, so the client refused every request, and the command carrying the answer back demanded a human-confirmed lease that no caller mints, so even the refusal could not be delivered. The turn then waited two minutes for a timeout, or forever for ask_user and dispatch_agent.
