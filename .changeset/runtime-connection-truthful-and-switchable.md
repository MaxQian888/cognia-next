---
"cognia-next": patch
---

Runtime connection: fix the target switch crashing, and stop a standalone browser from reading as a connected runtime. `switchAccountRuntimeTarget` built its transition context with a bare `toTargetId` — the field name, not a binding in scope — so every caller that relied on the default dependencies (the runtime-target menu's "This browser" row, and removing a paired Web Host) died with a `ReferenceError` before it could activate anything. The status-bar connection center also collapsed "this shell is the host" (Tauri) and "this browser runs what it can locally" (standalone) into one green _Local runtime_ badge, even though standalone resolves every host-backed operation to `requires-companion`; it now shows standalone as the mode it is, names what still needs a Host, and lists the Hosts already paired in this browser instead of offering only "Connect Host".
