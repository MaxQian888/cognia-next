//! `cognia plugin build` for `type: "frontend"` plugins.
//!
//! Bundles `src/index.ts` (or whatever `manifest.main` points at, with
//! the `.js` extension swapped for `.ts` if needed) into a single
//! CommonJS file at `dist/index.js` via esbuild, then zips it with the
//! manifest.
//!
//! esbuild is invoked via `npx --no-install esbuild …` so authors can
//! pull in their preferred version through `package.json`. The CLI
//! refuses to silently install a global esbuild — that would corrupt
//! authors' lockfiles. If esbuild isn't reachable, the error explains
//! how to add it.

use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::shared::run_streaming;

/// Build a frontend TS plugin and pack its bundle. The caller (commands::build)
/// has already validated the manifest.
pub fn build_and_pack(
    crate_root: &Path,
    manifest: &serde_json::Value,
    out: Option<PathBuf>,
    skip_build: bool,
) -> Result<PathBuf> {
    if !skip_build {
        run_esbuild(crate_root, manifest)?;
    }
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing id"))?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing version"))?;
    let main_rel = manifest
        .get("main")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing main"))?;
    let bundled_js = crate_root.join(main_rel);
    if !bundled_js.exists() {
        bail!(
            "expected bundled output at {} (manifest.main); did esbuild produce it?",
            bundled_js.display()
        );
    }

    let bundle_path = out.unwrap_or_else(|| {
        crate_root
            .join("target")
            .join("cognia")
            .join(format!("{id}-{version}.zip"))
    });
    if let Some(parent) = bundle_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    pack_frontend_bundle(&bundle_path, crate_root, manifest, main_rel)?;
    Ok(bundle_path)
}

/// Resolve the TS entry file from the manifest. For `main: "dist/index.js"`
/// we look for `src/index.ts` (the convention the template uses); authors
/// who layout their crate differently can declare `tsEntry` in
/// `plugin.json` to override.
fn resolve_ts_entry(crate_root: &Path, manifest: &serde_json::Value) -> Result<PathBuf> {
    if let Some(custom) = manifest.get("tsEntry").and_then(|v| v.as_str()) {
        let p = crate_root.join(custom);
        if !p.exists() {
            bail!(
                "manifest.tsEntry points at {} but the file doesn't exist",
                p.display()
            );
        }
        return Ok(p);
    }
    // Default convention: src/index.ts maps to dist/index.js.
    let candidates = ["src/index.ts", "src/index.tsx", "src/main.ts"];
    for candidate in candidates {
        let p = crate_root.join(candidate);
        if p.exists() {
            return Ok(p);
        }
    }
    bail!(
        "no TypeScript entry point found. Looked for: {}. Set `tsEntry` in plugin.json to override.",
        candidates.join(", ")
    )
}

/// Bundle a frontend plugin's entry without packing a `.zip`.
///
/// `cognia plugin import` uses this for its trailing build: the author
/// wants an installable directory, not a distributable archive, and the
/// zip step would only produce a file they have to ignore.
pub(crate) fn build_only(crate_root: &Path, manifest: &serde_json::Value) -> Result<()> {
    run_esbuild(crate_root, manifest)
}

/// Specifiers the bundle must leave for the host to resolve.
///
/// The first two are the host's path aliases. The rest mirror the loader's
/// shared-module whitelist (`lib/plugin/core/shared-modules.ts`) exactly, and
/// the mirroring is load-bearing in both directions:
///
///   * Inlining any of them is fatal for `react` and its jsx runtimes — a
///     second React instance carries its own hook dispatcher, so a plugin
///     component rendered inside the host's tree throws `Invalid hook call`.
///     Note `--external:react` does NOT cover `react/jsx-runtime`: esbuild
///     matches the import path literally, so the subpaths esbuild's own
///     automatic JSX transform emits need their own entries or they get
///     bundled and silently reintroduce the second copy.
///   * Externalising something the host does *not* share only moves the
///     failure to `require()` time — which is the intent for `react-dom`.
///     Keeping it external means it is never bundled, and the author gets the
///     loader's explicit "not available to plugins" error instead of a second
///     reconciler quietly rendering into a detached tree.
const ESBUILD_EXTERNALS: &[&str] = &[
    "@/types/plugin",
    "@/lib/*",
    "react",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom",
    "@cognia/plugin-sdk",
    "@cognia/plugin-ui",
    "lucide-react",
];

/// Build the esbuild argument vector. Split out from `run_esbuild` so the
/// externals contract can be asserted without spawning npx.
fn esbuild_args(entry: &Path, outfile: &Path) -> Vec<String> {
    let mut args = vec![
        "--no-install".to_string(), // refuse to silently install globally
        "esbuild".to_string(),
        entry.to_string_lossy().into_owned(),
        "--bundle".to_string(),
        "--format=cjs".to_string(),
        "--platform=neutral".to_string(),
        "--target=es2022".to_string(),
        format!("--outfile={}", outfile.display()),
    ];
    args.extend(ESBUILD_EXTERNALS.iter().map(|e| format!("--external:{e}")));
    args.push("--log-level=warning".to_string());
    args
}

fn run_esbuild(crate_root: &Path, manifest: &serde_json::Value) -> Result<()> {
    let entry = resolve_ts_entry(crate_root, manifest)?;
    let outfile = crate_root.join(
        manifest
            .get("main")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("plugin.json missing main"))?,
    );
    if let Some(parent) = outfile.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }

    // Use the platform's standard npx invocation. Windows resolves `npx.cmd`;
    // unix resolves `npx`. We rely on the OS shell to find it, so authors
    // need Node.js installed (a reasonable assumption for a TS plugin).
    let npx_program = if cfg!(target_os = "windows") {
        "npx.cmd"
    } else {
        "npx"
    };
    let mut cmd = Command::new(npx_program);
    cmd.current_dir(crate_root)
        .args(esbuild_args(&entry, &outfile));
    run_streaming(cmd, "npx esbuild").with_context(|| {
        format!(
            "esbuild failed for {}. If npx says \"could not determine executable\", run `pnpm install` in {} first.",
            entry.display(),
            crate_root.display()
        )
    })
}

/// Write the zip bundle. Always contains pretty-printed plugin.json and
/// the bundled JS at its manifest-declared path; everything else listed
/// in `manifest.bundle_include[]` is copied verbatim.
fn pack_frontend_bundle(
    out_path: &Path,
    crate_root: &Path,
    manifest: &serde_json::Value,
    main_rel: &str,
) -> Result<()> {
    use std::io::Write as _;
    let file = std::fs::File::create(out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. plugin.json
    writer.start_file("plugin.json", options)?;
    let pretty = serde_json::to_vec_pretty(manifest)?;
    writer.write_all(&pretty)?;

    // 2. bundled JS at manifest.main path
    let bundled_path = crate_root.join(main_rel);
    let js_bytes =
        std::fs::read(&bundled_path).with_context(|| format!("read {}", bundled_path.display()))?;
    // Normalize path separators inside the zip — windows paths get
    // backslashes from Path::join, but zip entries are required to use `/`.
    let main_rel_in_zip = main_rel.replace('\\', "/");
    writer.start_file(&main_rel_in_zip, options)?;
    writer.write_all(&js_bytes)?;

    // 3. bundle_include[]
    let mut seen = std::collections::HashSet::new();
    seen.insert("plugin.json".to_string());
    seen.insert(main_rel_in_zip);
    if let Some(arr) = manifest.get("bundle_include").and_then(|v| v.as_array()) {
        for entry in arr {
            let rel = match entry.as_str() {
                Some(s) => s,
                None => continue,
            };
            let src = crate_root.join(rel);
            if !src.exists() {
                bail!("bundle_include references missing file {}", src.display());
            }
            let rel_in_zip = rel.replace('\\', "/");
            if seen.contains(&rel_in_zip) {
                continue;
            }
            let bytes = std::fs::read(&src).with_context(|| format!("read {}", src.display()))?;
            writer.start_file(&rel_in_zip, options)?;
            writer.write_all(&bytes)?;
            seen.insert(rel_in_zip);
        }
    }
    writer.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read;
    use tempfile::tempdir;

    fn write_plugin_json(root: &Path, manifest: &serde_json::Value) {
        std::fs::write(
            root.join("plugin.json"),
            serde_json::to_vec_pretty(manifest).unwrap(),
        )
        .unwrap();
    }

    /// The loader's shared-module whitelist and this externals list are one
    /// contract split across two languages. If they drift, plugins break at
    /// load time with either "Invalid hook call" (module inlined that should
    /// have been shared) or "not available to plugins" (module externalised
    /// that the host does not hand out). Keep this list in sync with
    /// `PLUGIN_SHARED_MODULES` in `lib/plugin/core/shared-modules.ts`.
    #[test]
    fn esbuild_externalises_every_host_shared_module() {
        let args = esbuild_args(Path::new("src/index.ts"), Path::new("dist/index.js"));
        for shared in [
            "react",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "@cognia/plugin-sdk",
            "@cognia/plugin-ui",
            "lucide-react",
        ] {
            assert!(
                args.iter().any(|a| a == &format!("--external:{shared}")),
                "missing --external:{shared} — it would be inlined into the plugin bundle"
            );
        }
    }

    #[test]
    fn esbuild_externalises_react_dom_without_the_host_sharing_it() {
        // Externalised so it is never bundled; the loader then rejects the
        // require() with a specific message instead of a second reconciler
        // rendering into a tree the host does not own.
        let args = esbuild_args(Path::new("src/index.ts"), Path::new("dist/index.js"));
        assert!(args.iter().any(|a| a == "--external:react-dom"));
    }

    #[test]
    fn esbuild_emits_a_neutral_cjs_bundle_the_loader_can_eval() {
        let args = esbuild_args(Path::new("src/index.ts"), Path::new("dist/index.js"));
        for expected in [
            "--bundle",
            "--format=cjs",
            "--platform=neutral",
            "--target=es2022",
        ] {
            assert!(args.iter().any(|a| a == expected), "missing {expected}");
        }
        assert!(args.iter().any(|a| a == "--outfile=dist/index.js"));
        assert_eq!(args[0], "--no-install");
        assert_eq!(args[1], "esbuild");
    }

    #[test]
    fn resolve_ts_entry_prefers_src_index_ts() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/index.ts"), "// x").unwrap();
        let m = json!({"main": "dist/index.js"});
        let entry = resolve_ts_entry(root, &m).unwrap();
        assert_eq!(entry, root.join("src/index.ts"));
    }

    #[test]
    fn resolve_ts_entry_honors_explicit_ts_entry() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("custom")).unwrap();
        std::fs::write(root.join("custom/entry.ts"), "// x").unwrap();
        let m = json!({"main": "dist/index.js", "tsEntry": "custom/entry.ts"});
        let entry = resolve_ts_entry(root, &m).unwrap();
        assert_eq!(entry, root.join("custom/entry.ts"));
    }

    #[test]
    fn resolve_ts_entry_errors_when_nothing_found() {
        let tmp = tempdir().unwrap();
        let m = json!({"main": "dist/index.js"});
        let err = resolve_ts_entry(tmp.path(), &m).unwrap_err();
        assert!(err.to_string().contains("no TypeScript entry point found"));
    }

    #[test]
    fn pack_frontend_bundle_writes_manifest_and_main_js() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "console.log('hi')").unwrap();
        let manifest = json!({
            "id": "x",
            "version": "0.1.0",
            "type": "frontend",
            "main": "dist/index.js"
        });
        write_plugin_json(root, &manifest);
        let out_path = root.join("p.zip");
        pack_frontend_bundle(&out_path, root, &manifest, "dist/index.js").unwrap();

        let bytes = std::fs::read(&out_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
            .collect();
        names.sort();
        assert_eq!(names, vec!["dist/index.js", "plugin.json"]);
        let mut entry = archive.by_name("dist/index.js").unwrap();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        assert!(content.contains("hi"));
    }

    #[test]
    fn pack_frontend_bundle_includes_extra_files() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "x").unwrap();
        std::fs::write(root.join("README.md"), "# hi").unwrap();
        let manifest = json!({
            "id": "x",
            "version": "0.1.0",
            "type": "frontend",
            "main": "dist/index.js",
            "bundle_include": ["README.md"]
        });
        write_plugin_json(root, &manifest);
        let out_path = root.join("p.zip");
        pack_frontend_bundle(&out_path, root, &manifest, "dist/index.js").unwrap();
        let bytes = std::fs::read(&out_path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert!(archive.by_name("README.md").is_ok());
    }

    #[test]
    fn pack_frontend_bundle_errors_when_bundle_include_missing() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "x").unwrap();
        let manifest = json!({
            "id": "x",
            "version": "0.1.0",
            "type": "frontend",
            "main": "dist/index.js",
            "bundle_include": ["assets/icon.svg"]
        });
        write_plugin_json(root, &manifest);
        let err = pack_frontend_bundle(&root.join("p.zip"), root, &manifest, "dist/index.js")
            .unwrap_err();
        assert!(err.to_string().contains("assets/icon.svg"));
    }

    #[test]
    fn build_and_pack_errors_when_skip_build_and_bundle_missing() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let manifest = json!({
            "id": "x",
            "version": "0.1.0",
            "type": "frontend",
            "main": "dist/index.js"
        });
        write_plugin_json(root, &manifest);
        let err = build_and_pack(root, &manifest, Some(root.join("p.zip")), true).unwrap_err();
        assert!(err.to_string().contains("expected bundled output"));
    }

    #[test]
    fn build_and_pack_succeeds_with_skip_build_when_bundle_exists() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "x").unwrap();
        let manifest = json!({
            "id": "hello",
            "version": "0.2.0",
            "type": "frontend",
            "main": "dist/index.js"
        });
        write_plugin_json(root, &manifest);
        let out = root.join("p.zip");
        let result = build_and_pack(root, &manifest, Some(out.clone()), true).unwrap();
        assert_eq!(result, out);
        assert!(out.exists());
    }
}
