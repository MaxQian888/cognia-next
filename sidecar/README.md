# Cognia Sidecars

Node-only hosts that ship as Tauri runtime resources. Each is intentionally
**outside** the root pnpm workspace so its dependencies do not pollute the main
`pnpm-lock.yaml` — they are private to the desktop runtime.

| Host                                               | Package                   | Manager | Entry                                                                                                  | Spawned by                                                                                                                   |
| -------------------------------------------------- | ------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Claude / A2UI** at `./` root                     | `cognia-claude-sidecar`   | pnpm    | `agent-host.mjs` (stdio JSON-lines; `claude-host.mjs` is its legacy alias), `a2ui-mcp.mjs` (stdio MCP) | Tauri (`src-tauri/src/claude/sidecar.rs::resolve_sidecar_script`), the CLI sidecar role; external agents for `a2ui-mcp.mjs`. |
| **VS Code extension host** at `./vscode-ext-host/` | `@cognia/vscode-ext-host` | npm     | `dist/host.js` (compiled from `src/host.ts`)                                                           | Tauri per VS Code extension (`crates/cognia-plugin-runtime/src/vscode/`).                                                    |

A third Node component, the **web-clone engine** at `./webclone/`
(`@cognia/webclone`, npm, built with `tsc` → `dist/`), is not a persistent host:
it is spawned on demand as a short child process (`dist/runner.js`) by the
`web_clone_snapshot` Tauri command and by the `web_clone` builtin tool. It
vendors the web-page snapshot engine (HTML + asset mirroring, component
extraction, framework codegen) with its Node-only deps (linkedom / @babel /
proxy-agents) kept out of the app bundle. See `webclone/VENDOR.md`. Build:
`pnpm sidecar:webclone:build` (auto-runs on `prebuild`); test:
`pnpm sidecar:webclone:test`.

Requires Node.js **≥ 26** when run outside Cognia's default bundled-runtime
desktop profile.

## Layout and TypeScript (ADR-0197)

The Claude sidecar is moving, one layer per batch, from untyped `.mjs` into
strict TypeScript under `src/`, which Node 26 runs **unbuilt** by stripping the
types. See `docs/content/docs/en/adr/0197-the-sidecar-runs-its-typescript-unbuilt.md`.

- **Launchers.** `agent-host.mjs`, `claude-host.mjs`, `cognia-tool-bridge.mjs`,
  `mcp-stdio-relay.mjs`, `mcp-oauth-helper.mjs` and
  `codex-app-control/control-cli.mjs` keep their paths: Rust, the CLI, Docker,
  `COGNIA_SIDECAR_SCRIPT` and users' stored MCP configs name them.
- **`src/<layer>/`.** `shared` → `platform` → `policy` / `services` /
  `context` / `providers` → `tools` → `hooks` → `mcp` → `runtimes` → `host` →
  `entry`. A layer imports only itself and the layers before it
  (`scripts/gates/sidecar-architecture.json`). `src/` never imports the legacy
  `dispatch/`, `builtin-tools/`, `lsp/` or `a2ui-tools/` code that has not moved
  yet; the legacy code may import `src/`.
- **Writing `.ts` here.** Erasable syntax only (no `enum`, `namespace` or
  parameter properties), relative imports spell `.ts`, types come in through
  `import type`, no path aliases. Run `pnpm sidecar:typecheck`.
- **Linked workspace packages** (`link:` in `package.json`) are loaded from
  their compiled `dist/` through the `node` export condition, because the app
  bundle copies them under `node_modules`, where Node will not strip types.
  `node scripts/build/build-sidecar-linked-packages.mjs` keeps `dist/` current
  (postinstall, `predev`, `prebuild` and `sidecar:test` run it).

### Moved paths

Each migration batch appends its moves here (old → new).

| Old path                                                                 | New path                                                           | Batch       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------- |
| `dispatch/a2ui-mcp-protocol.test.mjs`                                    | `a2ui-tools/protocol-version.test.mjs`                             | test runner |
| `dispatch/input-stream.mjs`                                              | `src/shared/input-stream.ts`                                       | 1           |
| `builtin-tools/shared/truncate.mjs`                                      | `src/shared/text/truncate.ts`                                      | 1           |
| `builtin-tools/shared/mime.mjs`                                          | `src/shared/mime.ts`                                               | 1           |
| `dispatch/protocol-adapters/provider-protocol.mjs` (+ `.d.mts`, deleted) | `src/providers/provider-protocol.ts`                               | 1           |
| `dispatch/protocol-adapters/reasoning-effort-tables.mjs`                 | `src/providers/reasoning-effort-tables.ts`                         | 1           |
| `dispatch/live-harness.mjs`                                              | `test-support/live-harness.ts`                                     | 1           |
| `builtin-tools/git/_fixtures.mjs`                                        | `test-support/git-repo.ts`                                         | 1           |
| `dispatch/agent-event-envelope.fixture.json`                             | `test-support/fixtures/agent-event-envelope.json`                  | 1           |
| `dispatch/fixtures/gpt-oss-raw-analysis-stream.json`                     | `test-support/fixtures/gpt-oss-raw-analysis-stream.json`           | 1           |
| `codex-app-control/*.mjs` modules                                        | `codex-app-control/*.ts` (same names)                              | 2           |
| `codex-app-control/control-cli.mjs` (implementation)                     | `codex-app-control/cli.ts`; `control-cli.mjs` is now its launcher  | 2           |
| `codex-app-control/cdp-only-relaunch-worker.mjs` (implementation)        | `codex-app-control/relaunch-worker.ts`; the `.mjs` is its launcher | 2           |
| `codex-app-control/one-shot-launcher.mjs` (implementation)               | `codex-app-control/one-shot.ts`; the `.mjs` is its launcher        | 2           |

## Scripts (run from repo root)

```bash
# Aggregate — covers every sidecar in one shot
pnpm sidecars:install     # install deps for all of them
pnpm sidecars:build       # build vscode-ext-host, webclone, codeserver-agent-ext
pnpm sidecars:test        # run all sidecar tests

# Claude / A2UI
pnpm sidecar:install      # pnpm --dir sidecar install
pnpm sidecar:start        # node sidecar/claude-host.mjs   (stdio protocol)
pnpm sidecar:smoke        # one-shot smoke test
pnpm sidecar:test         # every sidecar/**/*.test.{mjs,ts} (scripts/test/run-sidecar-tests.mjs)
pnpm sidecar:test:live    # the *.live.test.* suites (real host + SDK subprocess, mock server)
pnpm sidecar:typecheck    # strict tsc over the sidecar (root toolchain)
pnpm audit:sidecar-architecture   # layer map, import cycles, public surface

# VS Code extension host
pnpm sidecar:vscode:install   # idempotent npm install in vscode-ext-host/
pnpm sidecar:vscode:build     # tsc → dist/host.js (auto-runs on prebuild)
pnpm sidecar:vscode:test      # node --test on tests/**/*.test.mjs
pnpm sidecar:vscode:clean     # rm -rf vscode-ext-host/dist
```

`SIDECAR_TEST_CONCURRENCY` caps `sidecar:test` (default: half the cores, at
most 4); pass file paths to run a subset:
`node scripts/test/run-sidecar-tests.mjs sidecar/dispatch/ai-sdk.test.mjs`.

`prebuild` (root) automatically runs `sidecar:vscode:build` so `pnpm build` and
`tauri build` always pick up a fresh `dist/host.js`. `predev` does not — VS Code
extension loading is opt-in at runtime and tsc on every cold start would harm
DX.

## Debugging

The Claude sidecar honours `COGNIA_SIDECAR_VERBOSE=1` for extra stderr logging.
The Tauri dev launch config in `.vscode/launch.json` ("Tauri Dev (with sidecar
logs)") sets this for you.

Standalone runs:

```bash
node sidecar/claude-host.mjs --smoke       # one-shot, exits cleanly
COGNIA_SIDECAR_VERBOSE=1 node sidecar/claude-host.mjs  # verbose stderr

# vscode-ext-host tests in watch mode
npm --prefix sidecar/vscode-ext-host test -- --watch
```

## Lockfile policy (intentional)

- `sidecar/pnpm-lock.yaml` — Claude / A2UI host. **Do not** add a
  `package-lock.json` here.
- `sidecar/vscode-ext-host/package-lock.json` — VS Code host. **Do not** add a
  `pnpm-lock.yaml` here.

The two hosts pin different package managers because their dependency sets are
disjoint (Claude SDK vs `vscode-jsonrpc`) and each is installed by a different
caller (`pnpm sidecar:install` vs the bundled `npm install` inside
`scripts/build-vscode-ext-host-sidecar.mjs`). Mixing them re-introduces the
lockfile drift this layout was created to prevent.

Every dependency the sidecar imports at runtime must be declared in
`sidecar/package.json`: the app bundle ships only `sidecar/node_modules`, so a
package that resolves in a checkout through the repo root's `node_modules` is
missing in the bundle. `scripts/build/sidecar-bundle-resources.test.mjs` fails
on such an import.
