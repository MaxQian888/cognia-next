---
"cognia-next": minor
---

Python plugins get their environment controls back: installer, scope, and the outbound RPC gate are now settable, and an install says where it landed.

The host has honoured `installer`, `venvScope` and `maxOutboundHostCalls` since ADR-0145, but nothing could set them — the Dexie row could not hold them and the settings card never offered them. The Configure tab now has an Environment block: pick the installer (automatic / uv / pip / a custom argv template), choose whether the virtual environment is shared with other Python plugins or isolated to this one, and cap concurrent plugin-to-host calls. Switching installers says up front that the next dependency install rebuilds the environment.

Installing dependencies now reports its outcome in place — which installer ran, whether the environment ended up shared or isolated, where it is on disk, and the reason a requested shared environment was downgraded. That reason was previously written only to a log.

When `uv` is missing from PATH, the card says so and offers to install it with the interpreter's own pip.
