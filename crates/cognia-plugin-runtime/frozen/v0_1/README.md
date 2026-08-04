# Frozen — WASM plugin host API v0.1.0

**These files are historical artifacts. They are not compiled and must never change.**

This directory holds the `cognia:plugin@0.1.0` contract and its wasmtime linker
exactly as they shipped, byte for byte. Nothing here is reachable from the crate
root, so `rustc`, `cargo clippy`, and `cargo fmt --all --check` never visit it.

## Why the sources moved out of `src/`

v0.2.0 is a hard cutover: the host registers no v0.1 linker and a v0.1 plugin
fails to load with `UPGRADE_REQUIRED`. Keeping `since_v0_1.rs` in the module tree
would have made the freeze impossible — it builds `HostState` with a full struct
literal, so every future field added to `HostState` would force an edit to a file
that is supposed to be immutable. Unregistering the linker means un-compiling it.

## What holds the freeze

Three independent checks, so a contributor who runs only one of them still trips:

| Check                                                    | Command                               |
| -------------------------------------------------------- | ------------------------------------- |
| Digest manifest (sha256 + byte length, three directions) | `pnpm lint:frozen-wasm-api`           |
| Compile-time byte stability of the WIT                   | `cargo test -p cognia-plugin-runtime` |
| Aggregate gate run                                       | `pnpm gates`                          |

The gate fails on a changed file, on a file added to this directory that is not
in the manifest, and on a manifest entry missing from disk.

## If you are here to change the contract

You are doing it wrong. Add `src/wasm/wit/since_v0_3.rs` and register it in
`src/wasm/wit/mod.rs` + `WasmPluginHost::version_linker`. The whole point of this
directory is that the v0.1 wire contract can still be read exactly as authors
compiled against it.

The only legitimate reason to touch anything here is an intentional re-freeze —
for example, adding a `v0_2/` sibling when v0.3 lands. In that case run
`pnpm freeze:wasm-api` to regenerate `scripts/gates/frozen-wasm-api.json` and say
why in the commit message.

## See also

- ADR-0013 (`docs/content/docs/{en,zh}/adr/0013-wasm-plugins.md`) — the cutover decision
- `src-tauri/wit/cognia-plugin.wit` — the live contract
- `crates/cognia-plugin-runtime/src/wasm/wit/` — the live linkers
