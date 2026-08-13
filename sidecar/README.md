# Cognia Sidecars

Two Node-only hosts that ship as Tauri runtime resources. Each is intentionally
**outside** the root pnpm workspace so its dependencies do not pollute the main
`pnpm-lock.yaml` — they are private to the desktop runtime.

| Host                                               | Package                   | Manager | Entry                                                            | Spawned by                                                                                             |
| -------------------------------------------------- | ------------------------- | ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Claude / A2UI** at `./` root                     | `cognia-claude-sidecar`   | pnpm    | `claude-host.mjs` (stdio JSON-lines), `a2ui-mcp.mjs` (stdio MCP) | Tauri (`src-tauri/src/claude/sidecar.rs::resolve_sidecar_script`); external agents for `a2ui-mcp.mjs`. |
| **VS Code extension host** at `./vscode-ext-host/` | `@cognia/vscode-ext-host` | npm     | `dist/host.js` (compiled from `src/host.ts`)                     | Tauri per VS Code extension (`src-tauri/src/plugin_api/vscode/host.rs::Sidecar::spawn`).               |

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

## Scripts (run from repo root)

```bash
# Aggregate — covers both hosts in one shot
pnpm sidecars:install     # install deps for both
pnpm sidecars:build       # build vscode-ext-host (Claude needs no build)
pnpm sidecars:test        # run all sidecar tests

# Claude / A2UI
pnpm sidecar:install      # pnpm --dir sidecar install
pnpm sidecar:start        # node sidecar/claude-host.mjs   (stdio protocol)
pnpm sidecar:smoke        # one-shot smoke test
pnpm sidecar:test         # builtin-tools + dispatch tests (node --test)

# VS Code extension host
pnpm sidecar:vscode:install   # idempotent npm install in vscode-ext-host/
pnpm sidecar:vscode:build     # tsc → dist/host.js (auto-runs on prebuild)
pnpm sidecar:vscode:test      # node --test on tests/**/*.test.mjs
pnpm sidecar:vscode:clean     # rm -rf vscode-ext-host/dist
```

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
