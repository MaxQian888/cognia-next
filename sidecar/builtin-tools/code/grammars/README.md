# Code-graph tree-sitter grammars

These `tree-sitter-*.wasm` files are the per-language parsers the code-graph
subsystem loads via `web-tree-sitter`. They are **build artifacts**, not source:
`scripts/build/copy-codegraph-grammars.mjs` copies them here from
`sidecar/node_modules/tree-sitter-wasms/out/` during `predev` / `prebuild`, and
they are git-ignored (`*.wasm`).

## Provenance

- Source package: [`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms)
  (pinned in `sidecar/package.json` `optionalDependencies`). It ships prebuilt
  `.wasm` grammars so no `tree-sitter` CLI / emscripten toolchain is needed.
- Runtime: `web-tree-sitter` (also pinned in `sidecar/package.json`).

## Files

One `.wasm` per grammar key (see `../languages/index.mjs` → `grammarAssets()`):

- `tree-sitter-typescript.wasm` — `.ts` / `.mts` / `.cts`
- `tree-sitter-tsx.wasm` — `.tsx` / `.jsx` / `.js` / `.mjs` / `.cjs` (JSX-capable superset)
- `tree-sitter-rust.wasm` — `.rs`
- `tree-sitter-python.wasm` — `.py` / `.pyi`

## Resolution

`../parser.mjs` `resolveGrammarWasm()` looks for these in order:

1. this directory (packaged Tauri resource / CLI bundle sibling — the copy above),
2. a Tauri-resource-relative `code/grammars` path,
3. `node_modules/tree-sitter-wasms/out` (dev, and the fallback that always works
   when the sidecar's `node_modules` ships — which it does for both Tauri and the
   CLI binary).

A missing/incompatible grammar surfaces as a per-language structured error; other
languages keep working.
