---
"cognia-next": minor
---

Add OpenCode V2 as an external agent backend. Point Cognia at a locally running `opencode2` service and it appears alongside the other external agents — usable in chat, bindable as an Agent Team teammate, and driven through the same permission modes (`default`, `acceptEdits`, `bypassPermissions`, `plan`) as every other backend, so approvals behave the way you already expect.

Connection is discovery-based rather than a command line you have to get right: Cognia finds the local service and checks its version, and an incompatible service says so by version instead of failing as a generic connection error. Session listing, forking and resuming report as available only once a connection proves the service supports them, rather than being advertised up front and failing when used.

Desktop only. The service is discovered over a local endpoint that the web and mobile shells cannot reach, so those shells report it as unavailable and tell you to connect from the desktop app rather than offering a control that could not work.
