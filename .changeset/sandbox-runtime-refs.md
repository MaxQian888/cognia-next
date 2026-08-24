---
"cognia-next": minor
---

Sandbox placement is now resolved once per send into an immutable runtime reference instead of ambient per-session state. The bound "sandbox desktop" shell tier is withdrawn (it only attests remote GUI isolation today, so shell and file work was never actually sandboxed there) and stored workspace shell/file capabilities for `computer-server` connections are narrowed to unavailable on read. Sandbox connection start/stop/health/remove now report provider refusals instead of failing silently.

A sandbox placement that cannot be established no longer degrades to running unrestricted on your own machine: the resolved resource/network/writable-root ceiling still applies to work that legitimately runs on the host, while a microVM shell tier or a bound Computer Use desktop refuses the call instead of falling back to the local host or the local desktop. Refreshing a sandbox connection's health also keeps the diagnostic that explains why it is unreachable.
