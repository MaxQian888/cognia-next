---
title: ADR-0046 — LSP Maturity
description: "npm-first auto-install ladder for missing language servers, a crash supervisor with backoff restarts and a broken set, diagnostics debounce/dedupe/version-guard, a sidecar log ring, and a renderer status surface (health badges, one-click install, logs dialog, editor hint). Expands the builtin registry to nine servers."
---

# ADR-0046 — LSP Maturity

**Status**: Accepted (2026-06-07)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: ADR-0044 (unified LSP configuration) — this ADR also lands the half of ADR-0044 that was lost to a concurrent-tree clobber (the migration wiring, `settings.lsp` readers, full-field dialog, `buildServers`, and `workspace/configuration` support survived only in the `qc-stash-backup` baseline and are recovered here)
**Affects**: `sidecar/vscode-ext-host/src/{lsp-installer,lsp-diagnostics-buffer}.ts` (new), `sidecar/vscode-ext-host/src/{lsp-client,lsp-service,host}.ts`, `sidecar/lsp/{servers,resolver,service-loader}.mjs`, `sidecar/dispatch/anthropic.mjs`, `types/lsp/config.ts`, `lib/lsp/{builtin-defaults,lsp-status-store}.ts`, `lib/claude/build-options.ts`, `lib/plugin/lsp/lsp-client-adapter-tauri.ts`, `components/settings/lsp/*`, `components/editor/lsp-server-hint.tsx`, `hooks/use-lsp-status-for-language.ts`

## Context

ADR-0044 unified *configuration*, but the runtime stayed brittle, OpenCode- and Claude-Code-class behaviours were missing:

- A missing binary degraded **silently** — the agent skipped the server, the editor showed nothing, and the user had no install path short of reading docs.
- A crashed server stayed dead for the session; a hung `initialize` blocked its caller forever.
- Diagnostics passed through raw: burst frames, duplicates, and — worst — **stale pre-edit frames** could be attributed to post-edit text (the bug class Claude Code shipped fixes for).
- Server stderr went to the sidecar's own stderr only; nothing was user-visible.
- Only 4 builtin servers; no provisioning metadata.

## Decision

### npm-first install ladder (`sidecar/vscode-ext-host/src/lsp-installer.ts`)

Resolution, first hit wins:

1. explicit path (never installed over) → 2. project `node_modules/.bin` walk-up → 3. managed dir `<appData>/lsp/node/<npmPackage>/node_modules/.bin` → 4. PATH (PATHEXT-aware) → 5. `npm install <pkg> --prefix <managed dir>` then re-resolve 3.

The managed dir is keyed by **package**, not server id — `vscode-langservers-extracted` ships four binaries and installs once. Kill-switches: `COGNIA_DISABLE_LSP_DOWNLOAD` env (hard) and `AppSettings.lsp.autoInstall` (user). Concurrent installs serialise through an atomic-mkdir advisory lock. `LspServerConfig` gains `install?: { npmPackage, version? }`; the builtin registry expands to **nine** (adds json/css/html via `vscode-langservers-extracted`, yaml, bash; eslint deliberately omitted pending an ESLint-specific configuration handshake; rust-analyzer/gopls stay detect-only — binary/go-install rungs are follow-ups).

Both consumers share the one implementation: the renderer through `lsp:detect` / `lsp:install` RPCs, the agent through `resolver.mjs`'s `ensureCommand` seam (dynamic import of `dist/lsp-installer.js`) with a **30 s turn budget** — an npm install never holds an agent turn hostage; it continues detached and the binary is picked up on a later touch. The resolver also caches failed servers per session so one missing toolchain doesn't re-run the ladder per edit.

### Crash supervisor (`lsp-service.ts`)

`CogniaLspClient` gains `startupTimeout` (default 10 s, races `initialize`, kills the hung child), `onStateChange`, and `onLog`. The service supervises: an unexpected `crashed` transition schedules a backoff restart (`min(30s, 1s·2ⁿ)`); after 4 failed attempts the key is **broken** (no auto-restarts; a manual `lsp:start` resets it). Open documents replay (`didOpen` with last text) into the restarted client. Restart timers are cancelled on `stop`/`stopAll`. Transitions push `lsp:state` notifications.

### Diagnostics quality (`lsp-diagnostics-buffer.ts`)

Between client and consumers: 150 ms per-`key:uri` debounce (far below the agent's 800 ms wait), exact-duplicate drop (severity|code|source|message|range), and a **version guard** — a frame tagged with a document version older than the client's current `didChange` version is dropped, killing stale post-edit attribution.

### Observability

The service keeps a 500-entry ring of stderr + lifecycle lines (`lsp:logs`). The renderer's `lib/lsp/lsp-status-store` merges `lsp:detect` (installed/managed/missing) with `lsp:status` + live `lsp:state` pushes (agent composite ids `<id>#<rootHash>` roll up by base id). Surfaces: status/health badges and one-click Install per row in Settings → Language Servers, a Logs dialog, and a dismissible editor hint (`components/editor/lsp-server-hint.tsx`) when the owning server is missing or broken. Everything is inert on web/mobile.

## Consequences

- Opening a TS/Python/JSON/YAML/bash file can self-provision its server (one click in the UI, automatic under the agent) instead of failing silently.
- A flapping server converges to `broken` with the reason in the log ring instead of crash-looping invisibly; a healthy crash recovers with documents intact.
- The model no longer sees pre-edit diagnostics attributed to post-edit text.
- Trade-offs accepted: npm-only provisioning this round (no GitHub-release/go-install rungs); the editor hint is mounted in the Skill editor first (Canvas/Artifacts follow with the mobile-editor work); `startupTimeout` is config-file-only (no dialog field yet).
