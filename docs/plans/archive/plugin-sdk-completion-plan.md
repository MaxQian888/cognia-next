# Plugin SDK Completion Plan (feat/im-connectors-crm-inbox)

Origin: full-chain audit (4 agents) of the Plugin SDK. Verdict: main runtime chain
runs end-to-end; gaps are in security boundary, dormant native APIs, marketplace
install, and contract path guard. User approved a 4-batch effort.

## B1 — DONE ✅ (committed? NO — uncommitted)

- secrets `store()`→`secrets:set`, `has()`→`secrets:get` non-null (context.ts). The
  Rust router only speaks get/set/delete; store/has were NOT_SUPPORTED.
- `shell.spawn` throws NOT_SUPPORTED instead of returning a fake pid:0 ChildProcess.
- `context.test.ts` 101/101, eslint clean, repo tsc 0.
- window placeholders (getSize/getPosition/isMaximized hardcoded) DEFERRED to B4
  (window gets real impl there; throw-now-rewrite-later is churn).

## B2 — native ctx security boundary (A network egress + C consent gate) — IN PROGRESS

User chose "tier+consent" (no per-plugin manifest allowlist this batch).

Key infra discovered:

- `createGuardedAPI(pluginId, api, permMap, {consentExempt?, unguarded?})` (permission-guard.ts:790)
  Proxy: unmapped+not-unguarded → fail closed; silent/exempt → sync `guard.require`;
  confirm-tier → async consent via broker `checkWithConsent`.
- `registerPlugin` auto-grants declared perms (grantedBy manifest) + sets dangerous→confirm tier
  (confirmDangerousByDefault:true is the singleton default).
- jest.setup.ts:367 auto-responds consent (default "allow"); flip via globalThis.\_\_PLUGIN_CONSENT_AUTO.
- Production order: loadPlugin registerPluginPermissions (1550) BEFORE activate (1567). Safe.
- **Desktop ledger coupling (THE subtlety):** per-call consent (broker session grant) does
  NOT write the Rust ledger. Only writers: mirrorDeclaredPermissionsToLedger (silent perms on
  enable, manager.ts:2036) and plugin-store rememberedPermissions==="allow" (plugin-store.ts:410).
  So moving network→dangerous stops the silent mirror; on desktop the gateway call
  (invokePluginApi→Rust has_permission) then fails-closed until a ledger grant exists.

Design (3 parts):

1. **A** — add `"network:fetch"`,`"network:websocket"` to DANGEROUS_PERMISSIONS (permission-guard.ts:186).
   - Update permission-guard.test.ts: tests at 294/297, 308/312, 315/318 use network:fetch as the
     canonical NON-dangerous example → swap to `clipboard:read` (still silent) to keep tier-machinery
     intent; ADD assertion network:fetch/websocket ARE dangerous (near line 505).
2. **C** — wrap createFileSystemAPI/createSecretsAPI/createClipboardAPI/createNetworkAPI returns
   with createGuardedAPI in context.ts. Maps:
   - fs: readText/readBinary/readJson/exists/readDir/stat/watch→filesystem:read;
     writeText/writeBinary/writeJson/appendText/mkdir/remove/copy/move→filesystem:write;
     getDataDir/getCacheDir/getTempDir→unguarded.
   - secrets: store/delete→secrets:write (dangerous→confirm); get/has→secrets:read.
   - clipboard: readText/readImage/hasText/hasImage→clipboard:read; writeText/writeImage/clear→clipboard:write.
   - network: get/post/put/delete/patch/fetch/download/upload→network:fetch (now dangerous→confirm).
   - context.test.ts beforeEach: resetPermissionGuard()+register "test-plugin" with the superset of
     perms its ~50 call-sites exercise; otherwise wrapped calls fail closed.
3. **Bridge** — extend createGuardedAPI with optional `onConsentGranted?(permission)` hook called
   after a confirm-tier consent resolves allowed. Native API wrappers pass a hook that best-effort
   `grantPluginPermission(pluginId, permission, "user")` (transport→Rust ledger; web no-op via
   canUseTauriInvoke guard) so desktop gateway calls pass after first consent. Feature APIs omit it.
   Add test: hook fires on approval, not on silent-tier.

Needs Tauri smoke (desktop gateway round-trip after consent).

## B3 — WASM guest-export tool bridge

callWasmExport/plugin_wasm_call (wasm-loader.ts:131, commands.rs:133) registered, ZERO prod caller.
On enablePlugin for type==="wasm", enumerate guest tool exports → register into registry.registerTool
/ store tools[] (what buildPluginToolsManifest reads, sidecar-tools-bridge.ts:152), each execute →
callWasmExport(pluginId, exportName, args). Seam: manager.registerPluginContributions (manager.ts:2548).

## B4 — real implementations (heavy, each independently sizeable, each needs Tauri smoke)

- ctx.db SQL backend: handle "db" in api_bridge.rs dispatch (currently NOT_SUPPORTED:557); per-plugin
  sqlite file under plugin data dir; query/execute/tx/createTable/dropTable/tableExists. Add
  database:\* permission to union + required_permission + capability_table (today phantom).
- ctx.window multi-window: implement create/close/setTitle/setSize/getSize/setPosition/getPosition/
  center/show/hide/focus/isMaximized in window_ops + api_bridge handle_window; getSize/getPosition/
  isMaximized must become real async (interface change) — fix the lying placeholders here.
- Marketplace real install: plugin_download_version (marketplace.rs:58 writes b"placeholder") → real
  reqwest download+checksum; plugin_install (lifecycle.rs:117 manifest-only) → unpack archive. Mirror
  the working GitHub installer (installer.rs:341).

## Deferred / not in user scope

- Contract path guard broken (plugin-capabilities.ts:952 only checks non-empty; plugin-sdk/python/
  absent, most TS SDK paths phantom). Audit-only finding; fix later (add fs-existence guard).
- Per-plugin manifest network allowlist (chose tier+consent instead).
- ctx.shell real backend (stays NOT_SUPPORTED; spawn now throws honestly).
- ctx.workspace plugin-backend dispatch (host only runs legacy "e2b").
- ctx.network download/upload, clipboard image ops (stay NOT_SUPPORTED, already honest).
