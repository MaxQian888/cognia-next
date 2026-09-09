---
"cognia-next": patch
---

A browser that has never been paired with a Host now says so, instead of blaming the workspace. Starting a chat from an unpaired tab failed with "Workspace unavailable" and offered to bind the conversation to a folder, advice that cannot work when every host-owned call is rejected. The failure now raises `hostUnavailable`, whose action opens Settings and Remote hosts, and the underlying message no longer claims managed workspaces are a desktop-only feature when what is actually missing is a host-backed implementation.
