---
paths:
  - "src-tauri/**"
  - "crates/**"
---

# Rust (src-tauri + crates) rules

- Toolchain pinned via `rust-toolchain.toml` (1.95 — the floor `oar-ocr` 0.9 needs; edition 2021).
- **Where new code goes (ADR-0196):** new Rust logic lives in the lowest-layer crate under `crates/` that can own it (layers in `scripts/gates/rust-architecture.json`). `src-tauri/src` only assembles the desktop app. A library crate's `#[tauri::command]` shells and `AppHandle` adapters sit behind its `tauri-host` feature, which only `src-tauri` enables. `pnpm audit:rust-architecture` enforces the layers.
- Unit tests are in-file `#[cfg(test)] mod tests { ... }`; integration tests in `src-tauri/tests/` are allowed. No separate test dirs.
- Gate: `cargo test -p <crate>` for a workspace crate (add `--features tauri-host` when the crate has it), `cargo test --manifest-path src-tauri/Cargo.toml` for the app. Piping through rtk/tee can mask cargo's exit code — read the log, don't trust `$?` alone.
- Known trap classes (the `tauri-rust-reviewer` agent checks these): parking_lot guards held across `.await`, detached tokio tasks that hang `cargo test`, tuple returns serializing as JSON arrays, unregistered commands, missing capability/ACL entries.
- All keyring access goes through the `secret_store` module — never create a new `keyring::Entry`.
