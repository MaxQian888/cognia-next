//! ADR-0067 — embed the Common-Controls v6 manifest into this crate's test
//! binary on Windows.
//!
//! `cognia-mcp-server` depends on `tauri`, which transitively pulls `muda`;
//! that statically imports `TaskDialogIndirect`, which only resolves against
//! comctl32 **v6**. Without a v6 manifest the test executable dies at startup
//! with `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139) — the same failure
//! `src-tauri/build.rs` fixes for the app and `cognia-automation/build.rs`
//! fixes for its own test binary.
//!
//! The unscoped `rustc-link-arg` applies to this package's supported targets —
//! including the inline `#[cfg(test)]` unit-test binary (this crate has no
//! separate `[[test]]` target). Build-script link args do NOT propagate to
//! dependents, and as an rlib this crate is never linked directly, so the final
//! app binary still gets its (single) manifest from `src-tauri/build.rs` — no
//! duplicate-manifest CVT1100 / LNK1123. See tauri-apps/tauri #13419 and #13948.
fn main() {
    #[cfg(windows)]
    {
        let manifest = std::env::current_dir()
            .expect("cannot resolve build script cwd")
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
