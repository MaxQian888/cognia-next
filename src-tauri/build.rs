fn main() {
    // On Windows, `tauri-build` already embeds an app manifest (via the
    // resource compiler path) that declares the Common-Controls v6
    // dependency the static `TaskDialogIndirect` import in `rfd` + `muda`
    // needs — the bin starts cleanly without any extra manifest plumbing.
    //
    // Earlier this build script also called `embed_manifest::embed_manifest`
    // and emitted unscoped `rustc-link-arg=/MANIFESTINPUT:…` lines so that
    // `cargo test --lib` binaries would pick up the same manifest. Both
    // sources fed the same MANIFEST resource into the bin's `.res`, and the
    // MSVC toolchain rejected it with `CVT1100: duplicate resource` →
    // `LNK1123: failure during conversion to COFF`, breaking `pnpm tauri dev`
    // entirely. If lib unit tests ever need Common-Controls v6 again, scope
    // the link args to a real `[[test]]` integration target rather than
    // re-introducing this collision.
    tauri_build::build()
}
