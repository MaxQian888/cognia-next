---
"cognia-next": patch
---

`cognia plugin build` now works on real wasm plugins — the default scaffold kind. Embedding the `cognia:api-version` custom section previously errored (`section forwarding for TypeSection(...) is not implemented`) on any module with a non-custom section, i.e. every module `cargo component` actually emits. The section walker now forwards every top-level section kind byte-for-byte — core-module and component alike — stripping only the prior `cognia:api-version`, so re-embedding stays idempotent and unknown/component-model sections round-trip losslessly.
