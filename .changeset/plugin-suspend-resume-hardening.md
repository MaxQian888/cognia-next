---
"cognia-next": patch
---

Harden idle-suspended plugin wake-up so a suspended plugin is never unreachable or double-loaded. A plugin that idle-suspends can now be woken by any activation trigger (tool call, view, command, deep link, cross-plugin call) regardless of which activation events it declared — previously one that declared only "startup" became permanently unreachable via tools after suspending. Tool use now keeps a plugin's idle clock fresh so an actively-used plugin isn't suspended out from under a running agent, suspend/resume are serialized against every other lifecycle transition (no more double-wake races), and a hung onSuspend/onResume hook is bounded by a timeout instead of stalling the idle sweep.
