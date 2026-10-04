---
title: "0197 — The sidecar runs its TypeScript unbuilt"
description: "The Claude sidecar had about 50k lines of untyped `.mjs` in a flat `dispatch/` and a partly organized `builtin-tools/`. It had directory cycles, 2,000-line closures and helpers duplicated up to seven times. Moves it to layered strict TypeScript in `sidecar/src/`, which Node 26 runs directly by stripping types. Keeps process entry points at their existing paths as small `.mjs` launchers. Adds a layer gate, standalone type-check, one test runner and a fail-closed bundle guard."
---

# ADR 0197 — The sidecar runs its TypeScript unbuilt

**Status:** Accepted — in progress (foundation landed; the layer-by-layer move is tracked below)
**Date:** 2026-09-26
**Related:** [ADR-0090](./0090-unified-agent-execution-and-gateway-compatibility) (the sidecar's runtime contract), [ADR-0063](./0063-optical-context-compaction) (optical compaction files), [ADR-0119](./0119-pi-native-rpc-integration) (the SHA-pinned Pi extension), [ADR-0059](./0059-cloud-deployment-headless-brain) (the brain layout), [ADR-0196](./0196-a-library-crate-links-tauri-only-when-asked) (the Rust layer gate this one mirrors)

## Context

`sidecar/` is the Node host the desktop app, the headless server and the CLI
spawn for every agent session. By September 2026 it held about 50k lines of
`.mjs` and no types:

- `dispatch/` was a flat folder of about 60 modules mixing the host wire
  protocol, both agent rails (`anthropic.mjs` for the Claude Agent SDK,
  `ai-sdk.mjs` for the AI SDK), permission policy, hooks, MCP, compaction and
  a test harness.
- `builtin-tools/` kept half its tool categories in folders and half as
  top-level files, next to middleware, confinement policy and a separate MCP
  server (`plugin-tools.mjs`), plus a `__tests__/` folder that duplicated
  co-located suites.
- Directories imported each other in cycles: `dispatch ⇄ builtin-tools`,
  `dispatch → lsp → builtin-tools → dispatch`, and `dispatch →` a process
  entry file (`mcp-oauth-helper.mjs`) used as a library.
- `ai-sdk.mjs` was one 1,700-line closure; `agent-host.mjs` (1,399 lines) mixed
  the stdin protocol, the session registry, control, smoke mode and command
  routing.
- The same logic existed several times: two permission-decision ladders, five
  pending-reply waiters with timers, four copies of per-session tool setup, two
  hand-written MCP stdio servers, seven JSON-line writers.
- Nothing type-checked it, ESLint ignored it, and the root and package test
  scripts listed different folders: five `run-code` suites ran nowhere.

Converting it to TypeScript used to mean a build step. It no longer does: Node
≥ 22.18 strips erasable TypeScript natively, the desktop app ships Node 26.3.1
(`scripts/build/prepare-plugin-node.mjs`), CI and Docker run Node 26, and the
sidecar already loaded `@cognia/redact`'s `.ts` source that way.

That path had a trap, found while planning this move. Tauri's
`copy_resources` dereferences symlinks when it stages
`../sidecar/node_modules/**`, so the `link:`ed workspace packages landed in the
bundle as real `.ts` files **under `node_modules`**, where Node refuses to strip
types (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The staged sidecar died
at its first import; `unbash`, declared only at the repo root, was missing from
the bundle as well.

## Decision

### 1. `.ts`, run unbuilt

Sidecar source is `.ts` (not `.mts`): `sidecar/package.json` is
`"type": "module"`, so the two are equivalent for Node, and Next's webpack
rule, the Jest SWC transform, lint-staged, the router-fusion scanner and the
image path filters recognise `.ts` but not `.mts`. The renderer and
`packages/provider-core` import a few sidecar modules directly, so this
matters.

Node runs the files as-is. The code is therefore written in the erasable
subset: no `enum`, no `namespace`, no parameter properties; relative imports
spell `.ts`; `import type` for types (`verbatimModuleSyntax`); no path aliases.
Nothing TypeScript may be loaded from under a `node_modules` directory.

### 2. Layout

```
sidecar/
  agent-host.mjs claude-host.mjs cognia-tool-bridge.mjs
  mcp-stdio-relay.mjs mcp-oauth-helper.mjs      launchers (paths are a contract)
  a2ui-mcp.mjs                                  generated self-contained bundle
  codex-app-control/                            self-contained CLI (own launchers)
  pi-extension/                                 SHA-pinned, loaded by Pi
  test-support/                                 harness + fixtures, not shipped
  src/
    shared/  platform/  policy/  services/  context/  providers/
    tools/   hooks/     mcp/     runtimes/  host/     entry/
```

- **Launchers.** Every process entry point keeps its current path — Rust
  (`src-tauri/src/claude/sidecar.rs`), the CLI role stubs, Docker,
  `COGNIA_SIDECAR_SCRIPT` and users' stored MCP configs name them — as a `.mjs`
  file of a few lines that imports `src/entry/*` and keeps the existing entry
  guard (argv or `COGNIA_ROLE`), so the CLI can import a launcher without
  starting it twice.
- **`a2ui-mcp.mjs`** is launched by external agents with whatever `node` is on
  the user's `PATH`, which may predate type stripping, so it becomes a
  self-contained esbuild bundle at the same path.
- **Layers.** `src/` has twelve layers. Each may import only itself and the
  layers the gate config lists: `shared` → `platform` → the sibling layers
  `policy`, `services`, `context` and `providers` → `tools` → `hooks` → `mcp` →
  `runtimes` → `host` → `entry`. A builtin tool category never imports another; the two runtime
  rails share code only through `runtimes/common`.

### 3. A gate holds the structure

`pnpm audit:sidecar-architecture` (`scripts/gates/check-sidecar-architecture.mjs`,
config `sidecar-architecture.json`) enforces the layer map. It prohibits `src/`
from importing code that has not yet moved. Legacy code may import `src/` to
allow migration from lower layers upward. Production modules cannot import
launchers, tests or test-support. Imports must use explicit extensions and can
leave the sidecar only for the three `lib/*.json` data files. Trees must be
self-contained. Modules bundled by the renderer must be isomorphic: no Node
built-ins, packages or `import.meta`. Code outside the sidecar may import only
the listed `public` modules. Directory import cycles are prohibited. Legacy
violations are baselined, and the baseline may only shrink.

### 4. A standalone type contract

`pnpm sidecar:typecheck` (check-all, `types` group) runs the root TypeScript
over `sidecar/tsconfig.json` — no dev dependencies in `sidecar/node_modules`,
which ships inside the app:

- `tsconfig.base.json`: `es2025`, no DOM, `strict`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`;
  `moduleResolution: bundler`, because the linked packages' own sources use
  extensionless imports (the gate enforces extensions on the sidecar's).
- `tsconfig.json` adds `noUncheckedIndexedAccess` and `noUnusedLocals`; files
  are migrated to it strict from their first commit, never loose-then-tightened.
- `tsconfig.pi-extension.json` checks the SHA-pinned extension without
  `noUncheckedIndexedAccess`, until it is next re-pinned.

The `@cognia/agent-config-types` hub (`SendOptions`, `ClaudeEvent`) reaches the
app through `@/` aliases, so the standalone program cannot import it. The
sidecar owns its wire types (`src/shared/wire/`), and a root-side contract test
keeps the app's types assignable to them. Leaf modules of that package with a
clean closure may be imported.

The root `tsconfig.json` allows `.ts` import specifiers (`noEmit`), so the app
keeps importing the few public sidecar modules after they become `.ts`. Those
modules are also compiled by the root `tsc`, Jest and webpack, so they stay
within the root options (ES2018 target) and use no `import.meta`, top-level
`await` or JSON import attributes.

### 5. Linked workspace packages ship compiled

Every `link:` dependency of the sidecar routes Node's `node` export condition
to a tsup-built `dist/`; the app, Jest and `tsc` keep resolving source.
`scripts/build/build-sidecar-linked-packages.mjs` rebuilds those outputs only
when a source moved and fails if any `@cognia/*` import of the sidecar would
still resolve to TypeScript. It runs from postinstall, `predev`, `prebuild` and
`sidecar:test`. `sidecar/tsconfig.base.json`'s `paths` send bundlers (the CLI's
esbuild and Bun builds, Pi staging) to the same source the root tsconfig does.

`scripts/build/sidecar-bundle-resources.mjs` guards `bundle.resources` and now
fails closed: it follows `.ts`, reads imports from the TypeScript AST, reports
unresolved relative imports, unknown file types and bare imports the owning
`package.json` does not declare, and checks Rust's `REQUIRED_SIDECAR_ENTRIES`
are staged.

### 6. One test runner

`scripts/test/run-sidecar-tests.mjs` discovers `sidecar/**/*.test.{mjs,ts}`
(nested packages excluded). `pnpm sidecar:test` runs the unit suites;
`pnpm sidecar:test:live` runs `*.live.test.*`, which spawn the real host and
the Agent SDK subprocess against a mock server, as their own CI step. Tests are
co-located; `builtin-tools/__tests__/` is dissolved as its subjects move.

### 7. The move goes bottom-up, one layer per batch

Each batch moves one layer's files, renames them to `.ts`, types them strictly
and splits or deduplicates them in the same change, updating every path that
names them (Rust, `tauri.conf.json`, Docker, the CLI resolvers and bundlers,
gate baselines, `lib/` importers) in the same commit. Characterization tests
pin behaviour before any deduplication, notably the two permission ladders,
which differ today in ways the merged ladder must reproduce exactly.

| Phase | Scope | State |
| --- | --- | --- |
| −1 | Compiled linked packages, `unbash` declared | done |
| 0 | tsconfigs + `sidecar:typecheck`, test runner, fail-closed guard, layer gate, this ADR | done |
| 1 | `shared/`, `test-support/`, isomorphic provider tables (pilot) | planned |
| 2 | `codex-app-control` in place | planned |
| 3 | `platform/` (process, fs, net, telemetry, host-rpc) | planned |
| 4 | `policy/` (one permission ladder, confinement, shell rules) | planned |
| 5 | `context/`, `providers/` | planned |
| 6 | `services/` (LSP, code graph) | planned |
| 7–8 | `tools/` kernel, adapters, then every builtin category | planned |
| 9 | `hooks/`, `mcp/` library | planned |
| 10 | `runtimes/` (both rails split) | planned |
| 11 | MCP process entries and their launchers | planned |
| 12 | `host/`, the host launchers, `dispatch/` removed, gate in final mode | planned |

## Consequences

- The sidecar is type-checked for the first time, with no build step and no
  change to how any shell starts it.
- Cold start pays for type stripping (about 25 ms of stripper setup plus
  roughly 40 ms per 1.5 MiB of source). The budget is a median regression of at
  most 75 ms and 12 % on `agent-host.mjs --smoke`; `module.enableCompileCache()`
  in the launchers is the first remedy if it is exceeded.
- Running the sidecar from a checkout needs the linked packages' `dist/`,
  which postinstall builds and `predev`, `prebuild` and `sidecar:test` refresh.
- Moving files in a tree other sessions edit concurrently is the main risk;
  batches are short, prepared in a private worktree, and land with explicit
  paths.

## Alternatives considered

- **`.mts`.** Same semantics under `"type": "module"`, but every tool that
  reads the renderer-visible sidecar modules would need a new rule.
- **Compile to `dist/` with `tsc`.** Adds a build to every consumer and moves
  every spawn path to `dist/`, for no runtime benefit now that Node strips
  types.
- **Rename entry points to `.ts` and update the callers.** The paths live in
  users' stored MCP configs and external agents' configs, not only in this
  repo; launchers keep them stable for free.
