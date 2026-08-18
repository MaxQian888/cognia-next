---
"cognia-next": patch
---

Fix the E2B workspace backend being unreachable after the plugin migrated to
`ctx.workspace.registerBackend`.

The e2b-sandbox plugin registers its backend under the plugin-namespaced id
`cognia-e2b-sandbox:e2b`, but the host's clone / commit / remove dispatch only
ever looked up the bare `e2b` id, so `worktreeMode: "e2b"` integrations failed
with "e2b workspace backend not registered" even with the plugin enabled. The
host now resolves backends by kind (`resolveWorkspaceBackendByKind`), and the
deprecated `setE2BBackend` / `getE2BBackend` shims that masked this are removed.
