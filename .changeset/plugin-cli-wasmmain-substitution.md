---
"cognia-next": patch
---

`cognia plugin new --kind wasm` now writes a correct `wasmMain`. Previously every wasm scaffold shipped the template's own `wasmMain: "cognia_plugin_template.wasm"` regardless of the plugin's name, because substitution only replaced the hyphenated package name. A scaffold named `hello-wasm` now correctly declares `wasmMain: "hello_wasm.wasm"` — matching the underscore-normalized artifact `cargo-component` emits.
