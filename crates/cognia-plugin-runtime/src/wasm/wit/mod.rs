//! Per-api-version host bindings.
//!
//! One module per supported `cognia:plugin` MAJOR.MINOR. `WasmPluginHost::
//! version_linker` reads the `cognia:api-version` custom section out of the
//! component binary and routes to the matching `build_linker`.
//!
//! **v0.1 is deliberately absent.** v0.2.0 was a hard cutover: no v0.1 linker is
//! registered, so a v0.1 plugin fails at load with `UPGRADE_REQUIRED` and is
//! never compiled. The v0.1 sources live, byte-for-byte and uncompiled, in
//! `crates/cognia-plugin-runtime/frozen/v0_1/` — see the README there for why
//! they had to leave the module tree, and `pnpm lint:frozen-wasm-api` for what
//! keeps them stable.

pub mod since_v0_2;
