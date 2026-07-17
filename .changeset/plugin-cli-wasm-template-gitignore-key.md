---
"cognia-next": patch
---

`cognia plugin new --kind wasm` no longer leaks your Ed25519 private signing key into git. The wasm starter template's `.gitignore` now ignores `.cognia/` — where `--with-keygen` writes `plugin.private.b64` — matching the other four templates. A cross-template test pins the invariant so no future template can silently regress it.
