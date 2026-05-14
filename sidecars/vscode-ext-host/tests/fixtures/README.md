# VS Code extension test fixtures

Synthetic `.vsix`-shaped extensions used by the cognia VS Code reuse layer
(see `~/.claude/plans/vscode-snug-squid.md`).

These fixtures live outside the renderer Jest tree (`testPathIgnorePatterns`
excludes `/sidecar/` in `jest.config.ts`) and are consumed by:

1. **Sidecar runtime tests** (Phase M1+) via `pnpm sidecar:test` — Node's
   built-in `--test` runner picks them up from
   `sidecars/vscode-ext-host/tests/`.
2. **Renderer tests** (Phase M0+) that import the `package.json` directly to
   exercise the manifest adapter against realistic shapes.

## Layout

| Path               | Purpose                                                                                                                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello-extension/` | Minimal extension — one command, one configuration property, `onCommand` activation. Used to verify the happy path: manifest adapter → permission inference (none required) → vscode-loader stub → activate/deactivate lifecycle.                                                         |
| `cline-mock/`      | Synthetic Cline-style extension — sidebar webview + lazy `require("child_process")` + lazy `require("fs/promises")` + `fetch()` + `context.secrets`. Identifier-aliased indirection (`r = require; n = r`) defeats static analysis so the runtime permission gate must catch the imports. |

## Why pre-built `out/extension.js`

The fixtures check in their compiled CJS output (~30 LOC each) so the
sidecar test suite has zero build step — running `pnpm sidecar:test`
exercises the fixtures directly. If you change a `src/extension.ts`,
mirror the change into the corresponding `out/extension.js`.

## Adding a new fixture

Drop a new folder under this directory with the same shape:

```
my-fixture/
  package.json       # VS Code manifest (must declare `name`, `publisher`, `engines.vscode`)
  out/extension.js   # Pre-built CJS bundle (or omit for theme-only fixtures)
```
