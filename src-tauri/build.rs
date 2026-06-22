fn main() {
    let mut attributes = tauri_build::Attributes::new();

    // Windows: take manifest embedding away from `tauri-build` so the SAME
    // Common-Controls v6 manifest is linked into bins AND test binaries from a
    // single source.
    //
    // `tauri-build` embeds its manifest via `rust-embed-resource`, which uses
    // `cargo:rustc-link-arg-bins` — bins only. So `cargo test` binaries get no
    // manifest, the loader binds the static `TaskDialogIndirect` import (pulled
    // in by `rfd` + `muda`) against comctl32 v5 instead of v6, the export is
    // missing, and the test process dies at startup with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139). See tauri-apps/tauri #13419 and
    // #13948.
    //
    // The fix is to disable tauri-build's auto manifest and embed our own with
    // an UNSCOPED `/MANIFEST:EMBED` link arg. Unscoped `rustc-link-arg` applies
    // to bins, tests (incl. inline `#[cfg(test)]` unit tests), examples and
    // cdylibs alike — one manifest source for every artifact. Keeping it to a
    // single source is what avoids the `CVT1100: duplicate resource` /
    // `LNK1123` collision that broke `pnpm tauri dev` when an earlier attempt
    // embedded the manifest twice (tauri-build's copy + a manual copy).
    #[cfg(windows)]
    {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        embed_windows_manifest();
    }

    tauri_build::try_build(attributes).expect("failed to run tauri-build");

    #[cfg(feature = "parse-liteparse")]
    copy_pdfium_next_to_binary();
}

/// `parse-liteparse` only — stage the PDFium shared library next to the
/// build outputs, mirroring `ort`'s `copy-dylibs` behavior for the
/// `ocr-paddle` feature. `liteparse-pdfium-sys`'s build script copies the
/// library into `target/<profile>/deps/`; we lift it one level up to
/// `target/<profile>/` so `cargo run` / `tauri dev` / packaged bundles find
/// it next to the executable (runtime search order: PDFIUM_LIB_PATH env →
/// compile-time cache path (build machine only) → exe-adjacent → PATH).
/// Best-effort: on a cold build the deps copy may land after this script
/// runs — the next build picks it up, and dev/test still work through the
/// compile-time cache path.
#[cfg(feature = "parse-liteparse")]
fn copy_pdfium_next_to_binary() {
    let dylib = if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else {
        "libpdfium.so"
    };

    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out → profile dir is 3 up.
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR not set"));
    let Some(profile_dir) = out_dir.ancestors().nth(3).map(std::path::Path::to_path_buf) else {
        println!("cargo:warning=parse-liteparse: cannot locate profile dir from OUT_DIR");
        return;
    };

    let src = profile_dir.join("deps").join(dylib);
    let dst = profile_dir.join(dylib);
    if dst.exists() {
        return;
    }
    if !src.exists() {
        println!(
            "cargo:warning=parse-liteparse: {} not found yet at {} — it is copied by \
             liteparse-pdfium-sys on first build; rebuild once or ship it next to the \
             executable when packaging",
            dylib,
            src.display()
        );
        return;
    }
    if let Err(e) = std::fs::copy(&src, &dst) {
        println!(
            "cargo:warning=parse-liteparse: failed to copy {} to {}: {e}",
            src.display(),
            dst.display()
        );
    }
}

#[cfg(windows)]
fn embed_windows_manifest() {
    let manifest = std::env::current_dir()
        .expect("cannot resolve build script cwd")
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    // Embed the application manifest into every linked artifact, tests included.
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}
