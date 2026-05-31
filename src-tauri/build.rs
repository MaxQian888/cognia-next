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
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        );
        embed_windows_manifest();
    }

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
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
