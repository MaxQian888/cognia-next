---
"cognia-next": minor
---

`cognia plugin new` now defaults to the `ts` (TypeScript frontend) template instead of `wasm`. 36 of 38 first-party plugins are `frontend`; the former default (`wasm`) is used by exactly one, so a new author's first `plugin new <name>` now scaffolds the shape they almost certainly want. The interactive wizard lists `ts` first and pre-selects it; pass `--kind wasm` (or python/hybrid/vscode-extension) for the others.
