---
title: ADR-0044 — Unified LSP Configuration
description: "A single declarative Language Server config source — builtin defaults overridable by user global settings and project-local .cognia/lsp.json — drives BOTH the agent runtime LSP and the editor LSP, replacing the formerly hard-coded agent registry and the divergent UserLspServerEntry / PluginLspServerDef shapes. Adds full-field configuration, real per-server workspace/configuration wiring, a first-class settings section, and a one-time settings migration."
---

# ADR-0044 — Unified LSP Configuration

**Status**: Accepted (2026-06-02)
**Authors**: Max Qian + Claude Opus 4.8
**Builds on**: the agent runtime LSP (`sidecar/lsp/*`), the editor / VS Code-shim LSP (ADR-0006 plugin system; `lib/plugin/lsp/*`, `lib/plugin/vscode-shim/*`), the multi-root workspace model (`activeProject.rootDir`), and the LSP binary trust policy
**Affects**: `types/lsp/config.ts` (new), `lib/lsp/` (new: `builtin-defaults`, `resolve-config`, `project-file-reader`, `migrate-settings`, `migrate-settings-initializer`), `lib/claude/types.ts` (`AppSettings.lsp`, `SendOptions.lsp`, `UserLspServerEntry` alias), `types/plugin/plugin.ts` (`PluginLspServerDef` alias), `lib/claude/build-options.ts`, `sidecar/lsp/{servers,resolver,service-loader}.mjs`, `sidecar/dispatch/anthropic.mjs`, `sidecar/vscode-ext-host/src/{lsp-client,lsp-service}.ts`, `lib/plugin/lsp/{lsp-user-servers,lsp-bootstrap}.ts`, `lib/plugin/vscode-shim/lsp-binary-policy.ts`, `lib/plugin/core/vscode-loader.ts`, `components/settings/lsp/*`, `components/settings/developer/lsp-dev-toggle.tsx`, `components/settings/settings-nav-config.ts` + `settings-shell.tsx`, `i18n/messages/{en,zh-CN}.json`

## Context

Two LSP subsystems existed in parallel and shared nothing:

1. **Agent runtime LSP** (`sidecar/lsp/*`) gave the Claude agent `lsp_*` tools plus a diagnostics-after-edit hook. Its server registry was **hard-coded** to four servers (typescript, pyright, rust-analyzer, gopls) with no user configuration of any kind.
2. **Editor LSP** (`lib/plugin/lsp/*` + `lib/plugin/vscode-shim/*`) powered hover / completion / diagnostics in the Skills, Canvas, and Artifact Monaco editors. It had a real configurable registry, but the settings UI exposed only four fields, the `UserLspServerEntry` model's `env` / `initializationOptions` / `settings` fields were never wired, and the per-server `settings` (the LSP `workspace/configuration` payload) had no runtime effect.

Consequences: a server a user added in Settings was invisible to the agent; the agent's defaults could not be extended or overridden; and server-specific configuration (e.g. `rust-analyzer.cargo.features`) had nowhere to live and never took effect. The shape was also duplicated as `UserLspServerEntry` (`lib/claude/types.ts`) and `PluginLspServerDef` (`types/plugin/plugin.ts`).

## Decision

Establish **one declarative configuration source** that drives both subsystems.

### One shape, one resolver

`types/lsp/config.ts` defines `LspServerConfig` — the authoritative shape carrying both `languages` (editor selection) and `extensions` / `rootMarkers` (agent file-match + workspace-root resolution), plus `env`, `initializationOptions`, `settings`, `workspaceFolderRequired`, and `enabled`. `UserLspServerEntry` and `PluginLspServerDef` are now aliases of it, so the shape lives in exactly one place.

`lib/lsp/resolve-config.ts:resolveLspServers` layers, by `id`:

```
builtin defaults  ←  plugin-contributed  ←  user global (settings.lsp.servers)  ←  project .cognia/lsp.json
```

Scalar/array fields are replaced by higher layers; `settings` / `env` / `initializationOptions` are **deep-merged** so a project file can tweak a single sub-key. `enabled: false` drops a server (including a builtin a user wants gone). The four formerly hard-coded servers become declarative `LspServerConfig` entries in `lib/lsp/builtin-defaults.ts`, overridable and disablable.

### Crossing the sidecar boundary

`sidecar/` is a separate Node project that cannot import `lib/` or `@/types`. So the **renderer owns resolution**: `lib/claude/build-options.ts:resolveSendOptions` resolves the merged list and serialises it onto `sendOptions.lsp` (`{ enabled, servers }`). The sidecar consumes it — `sidecar/lsp/servers.mjs` is now `buildServers(configList)` + `serversForFile(file, servers)` (no hard-coded registry); `resolver.mjs` / `service-loader.mjs` / `anthropic.mjs` thread the list through. The agent stays lazy + PATH-probed.

### Per-server settings actually take effect

Both subsystems spawn through the one `CogniaLspClient` (`sidecar/vscode-ext-host/src/lsp-client.ts`), so the wiring lives there once: it answers `workspace/configuration` pulls by resolving each requested `section` against the server's `settings`, and pushes `workspace/didChangeConfiguration` right after `initialized` (and on `updateConfiguration`). `settings` flows from the resolved config → `LspStartParams` → client.

### Editor activation policy

The editor registry spawns eagerly on register, so feeding it four default toolchains would surface noisy "crashed" states for uninstalled binaries. Decision: the editor runs **user / project / overridden-builtin** servers only (`editorEligibleServers` keeps `source !== "builtin"`); pure builtin defaults stay agent-only (lazy, PATH-probed). User-added and project servers — the unification's core value — work in both. `lib/plugin/lsp/lsp-bootstrap.ts` now resolves from `settings.lsp` + the active project and re-syncs on either change.

### Settings surface + migration

Language Servers is promoted to a first-class settings section with builtin rows (read-only, source badge, disable, override) and user rows (add / edit / remove), and a full-field add/edit dialog including a validated-JSON `settings` editor. The slice moves from `developer.userLspServers` / `developer.unsignedLspAllowed` to a first-class `AppSettings.lsp` (`{ servers, enabled, unsignedAllowed }`). `lib/lsp/migrate-settings.ts` performs a one-time, idempotent migration wired at app start before the registry bootstraps; the binary policy reads the new field with a legacy fallback.

## Consequences

- A server added once in Settings is available to the agent and every editor.
- Builtin defaults are overridable and disablable from one place; the agent registry is no longer hard-coded.
- Per-server `settings` finally drive `workspace/configuration` on both sides.
- Project repos can ship `.cognia/lsp.json` to pin LSP config per workspace.
- The config shape lives in exactly one file (`types/lsp/config.ts`).

**Trade-off accepted**: pure builtin defaults do not auto-run inside the editors (only their overrides do), to avoid eagerly spawning toolchains the user has not installed. A future lazy, language-activated editor registration could lift this without the eager-spawn cost.
