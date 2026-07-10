---
paths:
  - "src-tauri/**"
---

# Rust (src-tauri) rules

- Toolchain pinned via `rust-toolchain.toml` (1.93.0; MSRV `rust-version = 1.89.0`, edition 2021).
- Unit tests are in-file `#[cfg(test)] mod tests { ... }`; integration tests in `src-tauri/tests/` are allowed. No separate test dirs.
- Gate: `cargo test --manifest-path src-tauri/Cargo.toml`. Piping through rtk/tee can mask cargo's exit code — read the log, don't trust `$?` alone.
- Known trap classes (the `tauri-rust-reviewer` agent checks these): parking_lot guards held across `.await`, detached tokio tasks that hang `cargo test`, tuple returns serializing as JSON arrays, unregistered commands, missing capability/ACL entries.
- All keyring access goes through the `secret_store` module — never create a new `keyring::Entry`.
