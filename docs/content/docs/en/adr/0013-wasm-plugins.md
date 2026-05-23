---
title: "0013 — WASM Component Model Plugins"
description: "cognia-next adds Rust-compiled WebAssembly plugins (wasmtime + WASI Preview 2 + WIT) as a fourth, isolation-first plugin type alongside frontend / python / hybrid, with Zed-style capability declaration, multi-version host linkers, and Ed25519-signed distribution from local files, HTTP URLs, or Git repositories."
---

# ADR 0013 — WASM Component Model Plugins

**Status:** Accepted
**Date:** 2026-05-14
**Branch:** `feat/wasm-plugins`

---

## Context

cognia-next's plugin surface already supports three types — `frontend`
(TypeScript loaded via `eval()`), `python` (PyO3 sidecar), and `hybrid`
(both). Both existing paths have two recurring complaints:

1. **Isolation is weak.** TS plugins share the webview heap with the rest
   of cognia and can read any IndexedDB row + any window global; Python
   plugins inherit the sidecar process's filesystem and network privileges.
   The permission guard in `lib/plugin/security/permission-guard.ts` is the
   only line of defense, and it's an opt-in check at the API boundary —
   plugin code with `eval` access trivially bypasses it.
2. **Native capability is uneven.** TS plugins can't reliably open files,
   spawn processes, or hit the OS keyring; Python plugins can but ship a
   500 MB Python runtime to do it.

[Zed](https://github.com/zed-industries/zed) demonstrated that a third
option is viable: **WebAssembly Component Model plugins** with
[`wasmtime`](https://github.com/bytecodealliance/wasmtime), WASI Preview 2,
and a typed WIT contract. The host explicitly imports each capability the
plugin can use, the user grants them once, and a per-store `StoreLimits`
caps memory + epoch interruption stops infinite loops. We adopt this
approach for cognia, with concessions for the Tauri + Next.js host:

- Tauri-only at runtime — the renderer in web mode shows a "desktop
  required" card. The wasmtime engine lives in `src-tauri/` and is reached
  via Tauri commands.
- Three install sources (local file, HTTP URL with Ed25519 signature,
  Git repo with `cargo-component` build) — no monorepo registry of the
  Zed shape is required for v0.1.
- A single WIT version (`0.1.0`) ships with the infrastructure for
  per-version host linkers in place so v0.2 breaking changes don't strand
  existing plugins.

---

## Decision

### Architecture overview

```
┌──────── Renderer (Next.js webview) ───────────────────────────────────┐
│                                                                        │
│  lib/plugin/                                                           │
│   ├─ core/wasm-loader.ts        IPC client (plugin_wasm_*)             │
│   ├─ core/loader.ts             case "wasm" → loadWasmDefinition       │
│   ├─ core/manager.ts            installWasmPluginFromLocalFile,        │
│   │                              uninstall → clearWasmCapabilityGrant  │
│   ├─ security/wasm-grant.ts     applyWasmCapabilityGrant + preopens    │
│   ├─ security/signature.ts      verifyDetachedBundleSignature          │
│   └─ package/                                                          │
│       ├─ http-installer.ts      installFromUrl + trust ledger          │
│       └─ git-installer.ts       installFromGit + toolchain hints       │
│                                                                        │
│  components/plugins/                                                   │
│   ├─ wasm-capability-grant-sheet.tsx   one-shot grant UI               │
│   ├─ use-wasm-capability-grant.tsx     imperative hook                 │
│   ├─ install-wasm-plugin-button.tsx    local-file picker entry         │
│   └─ install-from-url-dialog.tsx       HTTP URL + signature flow       │
│                                                                        │
│  lib/db/trusted-publishers.ts  Dexie ledger of accepted author keys    │
└────────────────────────────────────────────────────────────────────────┘
                                │
                                │ Tauri IPC
                                ▼
┌──────── Tauri host (Rust) ────────────────────────────────────────────┐
│                                                                        │
│  src-tauri/wit/cognia-plugin.wit          v0.1.0 contract              │
│                                                                        │
│  src-tauri/src/plugin_api/wasm/                                        │
│   ├─ mod.rs            HOST_API_VERSION = "0.1.0"                      │
│   ├─ engine.rs         shared Engine + 100 ms epoch ticker             │
│   ├─ store.rs          HostState + StoreLimits + CapabilitySet         │
│   ├─ host.rs           WasmPluginHost + version_linker router          │
│   ├─ wit/since_v0_1.rs bindgen! + Host impls for each interface        │
│   ├─ capabilities/     per-interface gates (capability strings)        │
│   ├─ installer.rs      plugin_wasm_install_from_{url,git}              │
│   └─ commands.rs       Tauri commands                                  │
│                                                                        │
│  wasmtime 26 · component-model · async · epoch_interruption            │
└────────────────────────────────────────────────────────────────────────┘
```

### Plugin type triad becomes a quartet

```ts
PluginType = "frontend" | "python" | "hybrid" | "wasm"
```

`type: "wasm"` adds three new manifest fields:

```jsonc
{
  "type": "wasm",
  "wasmMain": "main.wasm",
  "wasm": {
    "apiVersion": "0.1.0",
    "memoryLimitMb": 64,
    "callTimeoutMs": 30000,
    "fs": { "preopens": ["~/Documents/cognia-output"] },
  },
  "author": {
    "name": "Alice",
    "publicKey": "base64(Ed25519 32-byte public key)",
  },
}
```

Validation lives in `lib/plugin/core/validation.ts` — `wasmMain` must end
in `.wasm`, `apiVersion` must be semver MAJOR.MINOR.PATCH, memory limit
must be ≤ 4096 MiB, timeout ≤ 600 000 ms, and preopens must be
non-empty strings without NUL bytes.

### WIT contract v0.1

`src-tauri/wit/cognia-plugin.wit` defines a `cognia-plugin` world with
seven import interfaces and four guest exports:

| Surface                               | Direction    | Capability key                    | Stub today?                 |
| ------------------------------------- | ------------ | --------------------------------- | --------------------------- |
| `logger.log`                          | host import  | (always allowed)                  | full impl                   |
| `notification.notify`                 | host import  | `notification`                    | logs only                   |
| `secrets.{get,set,delete}`            | host import  | `secrets:{read,write}`            | full impl                   |
| `process.exec`                        | host import  | `process:spawn` / `shell:execute` | full impl                   |
| `clipboard.{read-text,write-text}`    | host import  | `clipboard:{read,write}`          | stub (v0.2 wires `arboard`) |
| `ai.generate-text`                    | host import  | `network:fetch`                   | deterministic stub          |
| `workflow.emit-event`                 | host import  | (always allowed)                  | logs only                   |
| `init(config: list<u8>)`              | guest export | —                                 | called on activate          |
| `on-event(kind, payload)`             | guest export | —                                 | called by plugin_wasm_call  |
| `tool-execute(name, args)`            | guest export | —                                 | optional                    |
| `workflow-node-execute(kind, inputs)` | guest export | —                                 | optional                    |

The bindgen invocation is a single `wasmtime::component::bindgen!` in
`since_v0_1.rs`. Each `Host` trait is implemented for `HostState`; each
method consults `CapabilitySet` via the `capabilities::<area>::check_*`
helpers before delegating to the actual OS call.

### Capability granter (Zed-style)

Permissions are **declared in the manifest** and **granted once at
install time**. Per-call runtime prompts are out — Zed proved they
become noise, and our existing `permission-guard.ts` already uses a
declarative grant ledger that we reuse here.

`WasmCapabilityGrantSheet` opens at install time, shows manifest
permissions grouped by category, the author's Ed25519 fingerprint
(when signed), and any extra filesystem preopens. The user toggles
each, presses **Install with selected access**, and:

1. `applyWasmCapabilityGrant` writes every granted permission into the
   permission guard's in-memory ledger via `grant(pluginId, permission,
{ grantedBy: "user" })`.
2. Extra preopens are persisted to `localStorage` under the
   `cognia:wasm-plugin:preopens` key. The Rust host reads this list at
   `plugin_wasm_activate` time and adds each path to the `WasiCtxBuilder`
   preopen set.

Uninstall calls `clearWasmCapabilityGrant` which revokes every grant
and drops the preopen entry, mirroring the existing `revokePluginPermissions`
flow for TS/Python plugins.

### Resource limits

Every WASM plugin instance runs in a fresh `Store<HostState>` with:

- **Linear memory cap**: 64 MiB default, configurable via
  `manifest.wasm.memoryLimitMb` (≤ 4096).
- **Table elements cap**: 10 000 (fixed for v0.1).
- **Instances / tables / memories**: 1 / 4 / 1.
- **Epoch interruption**: `Config::epoch_interruption(true)`, deadline
  computed from `manifest.wasm.callTimeoutMs` (default 30 s).
- **Background ticker**: one tokio task per process bumps the engine's
  epoch every 100 ms (`engine::EPOCH_TICK_MS`).
- **Per-call timeout**: 30 s wall-clock by default, configurable via the
  same manifest field. The `process.exec` import wraps `wait-timeout`
  around the child so an OS subprocess can't outlive the plugin call.

`StoreLimitsBuilder::memory_size(bytes)` is bound to the store via
`store.limiter(|s| &mut s.limits)` so violations trap with a typed
out-of-memory error the guest sees as a wasm trap.

### ABI versioning

The contract version is embedded as a `cognia:api-version` custom
section in the produced `.wasm`. The bundled `cognia plugin build` CLI
injects it during packaging. At load time `engine::parse_plugin_api_version`
reads the section; `host::version_linker` routes to
`wit/since_v0_<MINOR>.rs` based on the parsed MAJOR.MINOR.

v0.x bumps **MINOR** for breaking changes (per the
[0.x semver convention](https://semver.org/#spec-item-4)); for v1.x and
later MAJOR is the breaking signal. The `api_version_compatible` predicate
encodes this. A plugin with a non-existent `since_v0_N.rs` linker errors
at load time with `"no linker registered for v0.N.x"` so users never
get a half-instantiated plugin.

### Install sources

Three commands cover the three sources:

| Source     | Rust command                                     | TS entry                                                     | Trust check                                                                              |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Local file | `plugin_install` (existing) → `plugin_wasm_load` | `installWasmPluginFromLocalFile` + `InstallWasmPluginButton` | manifest validation only                                                                 |
| HTTP URL   | `plugin_wasm_install_from_url`                   | `installFromUrl` + `PluginSignedInstallFromUrlDialog`        | Ed25519 detached signature + `trustedPublishers` ledger                                  |
| Git repo   | `plugin_wasm_install_from_git`                   | `installFromGit`                                             | runtime detection of `cargo-component` toolchain; surfaced as `GitToolchainMissingError` |

Signed bundles ship as `<bundle>.zip` + `<bundle>.zip.sig`. The signature
covers the raw zip bytes (not a `(id || version)` prefix as
`plugin_create_signature` does — see `plugin_verify_detached_signature`
in `src-tauri/src/plugin_api/signature.rs`). The first install of a key
prompts; the `trustedPublishers` Dexie table (schema v29) records the
accept and auto-trusts subsequent updates from the same key.

---

## Consequences

- **Authors get a real toolchain.** Plugin authors install Rust +
  `cargo-component` once, then `cognia plugin new` / `build` / `sign`
  scaffold their plugin against the WIT contract. Build artifacts are
  reproducible and signable.
- **Security model is enforced by the engine, not the API surface.**
  A WASM plugin without `process:spawn` cannot exec a subprocess; the
  `process::check` gate fires before `std::process::Command` runs, and
  even if it didn't, the WASI sandbox only exposes the preopened dirs.
- **Browser mode degrades cleanly.** `isWasmHostAvailable()` returns
  false in the webview; the loader returns a stub with a warn-log
  activate hook. UI install entries surface the "Tauri required" alert.
- **wasmtime is heavy.** Adding wasmtime 26 + cranelift + WASI Preview 2
  added ~25 MB to the debug binary. Release builds amortize through
  cranelift's lazy compilation; the engine itself is constructed once
  per process.
- **MSRV bumped from 1.77.2 → 1.82.** Required for the `wasm32-wasip2`
  target on the guest side; transitive deps (wasmtime, ed25519-dalek 2)
  also require ≥ 1.78.

---

## Deferred

- **AI generate-text** is a deterministic stub. v0.2 will route it
  through `lib/ai/*` over a Tauri event so the user's configured
  provider chain handles the request.
- **Clipboard** read/write are stubbed (always-empty + log-and-return).
  v0.2 will bind to `tauri-plugin-clipboard-manager`.
- **Notification** posts to `log::info!` instead of triggering an OS
  toast. v0.2 wires `tauri-plugin-notification`.
- **Workflow `emit-event`** logs the intent; v0.2 routes the event back
  into the workflow runtime via the existing
  `lib/plugin/bridge/workflow-integration.ts` bridge.
- **Sigstore** is _not_ used; v0.1 only verifies the manifest-pinned
  Ed25519 key. Sigstore can land as a v0.2 optional backend if the user
  community asks for it.
- **Per-version host linkers**: scaffold is in place, but only v0.1.0 is
  registered. v0.2 will copy `since_v0_1.rs` → `since_v0_2.rs` and add
  the matching arm in `host::version_linker`.

---

## References

- WIT contract: `src-tauri/wit/cognia-plugin.wit`
- Plan: `~/.claude/plans/rust-wasm-zed-swirling-planet.md`
- Zed extension host: `crates/extension_host/src/wasm_host.rs` in
  [zed-industries/zed](https://github.com/zed-industries/zed)
- wasmtime component bindgen:
  <https://docs.wasmtime.dev/api/wasmtime/component/macro.bindgen.html>
- `cargo-component`:
  <https://github.com/bytecodealliance/cargo-component>
- WASI Preview 2 interfaces: <https://wasi.dev/interfaces>
