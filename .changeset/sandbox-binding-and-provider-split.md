---
"cognia-next": minor
---

Unify the sandbox execution model. A session's shell/file tier and its Computer Use target now resolve into a single binding, so a `cua-desktop` character can no longer drive a remote desktop while `Bash` quietly runs on the host machine. A binding that names a tier but no connection is refused and reported rather than silently downgraded to unsandboxed execution.

Sandbox connections gain a provider (`docker` / `cua-cloud` / `lume`) × driver (`computer-server` / `cua-driver`) split with a normalized lifecycle state and a per-connection capability matrix, so unsupported operations fail with a typed error instead of falling back to the host. Existing Docker connections migrate automatically and keep their old fields for one release, so a downgrade still works.
