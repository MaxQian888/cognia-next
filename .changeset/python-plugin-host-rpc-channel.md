---
"cognia-next": minor
---

Python plugins can now call back into the host. Until now the runtime was one-way — a Python plugin could answer the app but never ask it anything, so it could implement an AI provider yet never invoke one, and had no route to storage, the filesystem, git, or the UI. A new `host_request` frame carries `cognia.ctx.<namespace>.<method>(...)` calls onto the same permission-guarded `ctx.*` APIs a TypeScript plugin uses, from both async tools (`await`) and sync ones (`cognia.ctx.run_sync`). The host loop is now asyncio, so a tool blocked on a host call no longer stalls the plugin and several calls can be in flight at once; reentrancy is supported (a host call may resolve a tool the same plugin owns) with a runaway-recursion guard and per-call timeouts above a per-plugin concurrency gate. Works under the desktop shell and headless. The Python Demo plugin gains `host_log`, `host_log_sync`, and `host_fanout` demonstrating all three shapes.
