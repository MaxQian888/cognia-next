---
"cognia-next": minor
---

Rebuild the Gateway and External Bridge settings as master/detail panes, and surface the state they were already computing.

Both pages were a single ~2000px scroll of stacked cards. They are now grouped panels behind a secondary nav (Gateway: overview, listener, API keys, reliability, upstream protection, model exposure, request log, route tickets; External Bridge: server & token, permission scopes, wiki maintenance, client setup, audit log), deep-linkable via `?gatewayPanel=` / `?bridgePanel=`, and animated with the app's existing motion system — so they honour the Reduce motion preference.

Newly visible, all of it previously computed or implemented with nothing rendering it:

- Gateway overview shows requests served, last request time, and the routing snapshot's provider/alias counts and age.
- An upstream self-check runs the real routing path and reports each candidate's status and latency.
- Parked upstream keys show why they were parked and count down to recovery instead of showing a static timestamp behind a manual refresh.
- The request log gains a cost estimate, and per-request route, client IP, streaming flag and error detail.
- A route-tickets panel lists and revokes session-scoped tickets, with an explicit switch for the experimental capability that issues them.
- The audit log gains tool and denied-only filters and an adjustable row count, and shows each denial's reason.
- The External Bridge's 19 permission scopes are grouped by namespace, and the two deferred `user-repo` scopes now say why they cannot be granted.
- The bearer token shows when it was last rotated, and the HTTP port is configurable.

Fixes:

- The stdio setup snippet printed a `/path/to/cognia-mcp.js` placeholder instead of the real sidecar path.
- The bridge's HTTP port defaulted to 0 when starting the server but 3001 when generating the setup snippet, so a snippet copied before the first successful start pointed at the wrong port.
- Toggle rows built with the shared settings components had no accessible name.
- The bridge server status poll no longer runs while the window is hidden.
- Asking to delete an API key replaced the small icon trigger with a wide destructive button, re-flowing the row and shifting every neighbouring control out from under the cursor. The trigger now stays put and the confirmation opens beneath the row, with an explicit cancel.
- The API-key create and edit forms split into two columns at a viewport width, not their own, so they went two-up while the pane they sit in was still narrow.

The gateway's streaming idle timeout is now configurable (`streamIdleTimeoutSecs`, default 300s) rather than a hard-coded constant.
