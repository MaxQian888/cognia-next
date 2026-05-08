fn main() {
    // Cargo's test binaries don't go through `tauri-build`'s manifest hook,
    // so they ship without the Common-Controls v6 dependency. That makes the
    // Windows loader bind `comctl32.dll` to the v5.82 stub, which lacks
    // `TaskDialogIndirect` (statically imported by `rfd` + `muda` under their
    // `common-controls-v6` feature) — the EXE then dies at startup with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139). `embed-manifest` only emits
    // `rustc-link-arg-bins` directives, so we mirror them as `-tests` here
    // pointing at the same `manifest.xml` it wrote into OUT_DIR.
    #[cfg(target_os = "windows")]
    {
        use embed_manifest::{embed_manifest, new_manifest};
        embed_manifest(new_manifest("Cognia.App")).expect("embed v6 manifest");
        let manifest_path = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("manifest.xml")
            .canonicalize()
            .expect("canonicalize manifest path");
        // Unscoped `rustc-link-arg` covers bins + tests + benches + examples
        // + cdylibs (including this crate's `cargo test --lib` binary).
        // tauri-build also stamps a manifest into the bin; the MSVC linker
        // merges inputs via mt.exe, so duplicates are harmless.
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
            manifest_path.display()
        );
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
    }
    tauri_build::build()
}
