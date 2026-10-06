//! `cognia plugin build` for `type: "frontend"` plugins.
//!
//! Bundles the author entry and executable contributions into CommonJS under
//! `dist/`, then packages a normalized manifest and plugin-owned resources.
//! Author sources and plugin.json remain untouched.
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
    let mut plan = build_plan(crate_root, manifest, !skip_build)?;
    if !skip_build {
        run_esbuild(crate_root, &mut plan)?;
    } else if crate_root.join("dist/styles.bundle.css").is_file() {
        plan.manifest["styles"] = "dist/styles.bundle.css".into();
    }
    for output in plan.entries.values() {
        if !crate_root.join(output).is_file() {
            bail!(
                "expected bundled output at {} — run `cognia plugin build` first",
                crate_root.join(output).display()
            );
        }
    }
    let id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing id"))?;
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing version"))?;
    // These values are filename components, even when called without the lint gate.
    for value in [id, version] {
        if value.is_empty() || value.contains(['/', '\\']) || value == "." || value == ".." {
            bail!("plugin id/version must be safe filename components");
        }
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
    pack_frontend_bundle(&bundle_path, crate_root, &plan.manifest, "dist/index.js")?;
    Ok(bundle_path)
}

#[derive(Debug)]
struct FrontendBuildPlan {
    manifest: serde_json::Value,
    entries: std::collections::BTreeMap<String, String>,
    replacements: std::collections::BTreeMap<String, String>,
}

fn normalized_rel(value: &str) -> Result<String> {
    let value = value.replace('\\', "/");
    if value.is_empty()
        || value.starts_with('/')
        || value.contains(':')
        || value.split('/').any(|p| p == ".." || p.is_empty())
    {
        bail!("plugin path must be a contained relative path: {value}");
    }
    Ok(value.strip_prefix("./").unwrap_or(&value).to_string())
}

fn contained_existing(root: &Path, rel: &str) -> Result<PathBuf> {
    let path = root.join(normalized_rel(rel)?);
    let canonical = path
        .canonicalize()
        .with_context(|| format!("read {}", path.display()))?;
    if !canonical.starts_with(root.canonicalize()?) {
        bail!("plugin path escapes its root: {rel}");
    }
    Ok(path)
}

fn is_javascript_entry(value: &str) -> bool {
    matches!(
        Path::new(value).extension().and_then(|v| v.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts")
    )
}

fn path_values<'a>(value: &'a serde_json::Value, segments: &[&str], values: &mut Vec<&'a str>) {
    let Some((segment, rest)) = segments.split_first() else {
        if let Some(value) = value.as_str() {
            values.push(value);
        }
        return;
    };
    if let Some(key) = segment.strip_suffix("[]") {
        if let Some(array) = value.get(key).and_then(|v| v.as_array()) {
            for child in array {
                path_values(child, rest, values);
            }
        }
    } else if let Some(child) = value.get(*segment) {
        path_values(child, rest, values);
    }
}

fn collect_module_entries(
    value: &serde_json::Value,
    entries: &mut std::collections::BTreeSet<String>,
) -> Result<()> {
    for descriptor in super::contract::PLUGIN_PATH_FIELDS {
        if !descriptor.ends_with(".entry") && !descriptor.ends_with(".entrypoint") {
            continue;
        }
        let mut values = Vec::new();
        path_values(
            value,
            &descriptor.split('.').collect::<Vec<_>>(),
            &mut values,
        );
        for value in values {
            if is_javascript_entry(value) {
                entries.insert(normalized_rel(value)?);
            }
        }
    }
    Ok(())
}

fn rewrite_entry_paths(
    value: &mut serde_json::Value,
    replacements: &std::collections::BTreeMap<String, String>,
) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, value) in object {
                if matches!(key.as_str(), "main" | "entry" | "entrypoint") {
                    if let Some(rel) = value.as_str().and_then(|rel| normalized_rel(rel).ok()) {
                        if let Some(output) = replacements.get(&rel) {
                            *value = output.clone().into();
                        }
                    }
                }
                rewrite_entry_paths(value, replacements);
            }
        }
        serde_json::Value::Array(array) => {
            for value in array {
                rewrite_entry_paths(value, replacements);
            }
        }
        _ => {}
    }
}

fn build_plan(
    root: &Path,
    manifest: &serde_json::Value,
    resolve_source: bool,
) -> Result<FrontendBuildPlan> {
    let main = normalized_rel(
        manifest
            .get("main")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("plugin.json missing main"))?,
    )?;
    let source = if resolve_source {
        resolve_ts_entry(root, manifest)?
            .strip_prefix(root)?
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        main.clone()
    };
    let mut entries = std::collections::BTreeMap::new();
    let mut replacements = std::collections::BTreeMap::new();
    entries.insert(source.clone(), "dist/index.js".to_string());
    replacements.insert(main, "dist/index.js".to_string());
    replacements.insert(source, "dist/index.js".to_string());
    let mut references = std::collections::BTreeSet::new();
    collect_module_entries(manifest, &mut references)?;
    for entry in references {
        if replacements.contains_key(&entry) {
            continue;
        }
        // A contribution can refer directly to the conventional source while main already names dist.
        if matches!(
            entry.as_str(),
            "src/index.ts" | "src/index.tsx" | "src/main.ts"
        ) && !resolve_source
        {
            replacements.insert(entry, "dist/index.js".to_string());
            continue;
        }
        let output = format!(
            "dist/entries/{}.js",
            Path::new(&entry)
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/")
        );
        if entries.values().any(|existing| existing == &output) {
            bail!("multiple plugin entries resolve to {output}");
        }
        entries.insert(entry.clone(), output.clone());
        replacements.insert(entry, output);
    }
    let mut manifest = manifest.clone();
    rewrite_entry_paths(&mut manifest, &replacements);
    manifest
        .as_object_mut()
        .ok_or_else(|| anyhow!("plugin manifest must be an object"))?
        .remove("tsEntry");
    Ok(FrontendBuildPlan {
        manifest,
        entries,
        replacements,
    })
}

/// Prefer an explicit author entry, then a source-valued main, then conventional source paths.
fn resolve_ts_entry(crate_root: &Path, manifest: &serde_json::Value) -> Result<PathBuf> {
    if let Some(custom) = manifest.get("tsEntry").and_then(|v| v.as_str()) {
        return contained_existing(crate_root, custom)
            .context("manifest.tsEntry must name an existing contained file");
    }
    if let Some(main) = manifest.get("main").and_then(|v| v.as_str()) {
        if !main.starts_with("dist/") && crate_root.join(main).is_file() {
            return contained_existing(crate_root, main);
        }
    }
    let candidates = [
        "src/index.ts",
        "src/index.tsx",
        "src/main.ts",
        "src/index.js",
        "src/index.jsx",
    ];
    for candidate in candidates {
        if crate_root.join(candidate).is_file() {
            return contained_existing(crate_root, candidate);
        }
    }
    bail!("no TypeScript entry point found. Set `tsEntry` in plugin.json or use --skip-build for prebuilt plugins.")
}

pub(crate) fn build_only(crate_root: &Path, manifest: &serde_json::Value) -> Result<()> {
    let mut plan = build_plan(crate_root, manifest, true)?;
    run_esbuild(crate_root, &mut plan)
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
    // esbuild matches import paths literally, so the bare package above does
    // not cover its subpaths. Every published subpath is host-shared: most are
    // registries (`api/skill`, `api/i18n`, …) and `api/effort-surface` reads
    // host stores, so a bundled copy registers into — or answers from — state
    // the host never sees. The loader primes the ones a bundle requires.
    "@cognia/plugin-sdk/*",
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
        "--platform=browser".to_string(),
        "--target=es2022".to_string(),
        format!("--outfile={}", outfile.display()),
    ];
    args.extend(ESBUILD_EXTERNALS.iter().map(|e| format!("--external:{e}")));
    for extension in [
        "png", "jpg", "jpeg", "gif", "webp", "svg", "woff", "woff2", "ttf", "otf", "wasm",
    ] {
        args.push(format!("--loader:.{extension}=dataurl"));
    }
    args.push("--log-level=warning".to_string());
    args
}

fn run_esbuild(crate_root: &Path, plan: &mut FrontendBuildPlan) -> Result<()> {
    // Normalize only executable path fields; functions in the runtime manifest survive.
    let replacements = serde_json::to_string(&plan.replacements)?;
    let footer = format!(
        r#";(()=>{{const paths={replacements};const seen=new WeakSet();const visit=v=>{{if(!v||typeof v!=="object"||seen.has(v))return;seen.add(v);for(const [k,x] of Object.entries(v)){{if(["main","entry","entrypoint"].includes(k)&&typeof x==="string"&&paths[x.replaceAll("\\","/").replace(/^\.\//,"")])v[k]=paths[x.replaceAll("\\","/").replace(/^\.\//,"")];else visit(x)}}}};const d=module.exports.default||module.exports.plugin||module.exports;visit(d.manifest)}})();"#
    );
    for (input, output) in &plan.entries {
        let entry = contained_existing(crate_root, input)?;
        let outfile = crate_root.join(normalized_rel(output)?);
        let parent = outfile
            .parent()
            .ok_or_else(|| anyhow!("output has no parent"))?;
        // Validate existing ancestors before mkdir follows an attacker-controlled symlink.
        let mut ancestor = parent;
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| anyhow!("invalid output path"))?;
        }
        if !ancestor
            .canonicalize()?
            .starts_with(crate_root.canonicalize()?)
        {
            bail!("compiled output escapes plugin root: {output}");
        }
        if outfile.exists() {
            let canonical = outfile.canonicalize()?;
            if !canonical.starts_with(crate_root.canonicalize()?)
                || canonical == entry.canonicalize()?
            {
                bail!("compiled output would overwrite its source or escape the plugin: {output}");
            }
        }
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
        let npx_program = if cfg!(target_os = "windows") {
            "npx.cmd"
        } else {
            "npx"
        };
        let mut cmd = Command::new(npx_program);
        cmd.current_dir(crate_root)
            .args(esbuild_args(&entry, &outfile))
            .arg(format!("--footer:js={footer}"));
        run_streaming(cmd, "npx esbuild").with_context(|| format!("esbuild failed for {}. Install the plugin's declared dependencies first (`pnpm install`).", entry.display()))?;
    }
    bundle_styles(crate_root, plan)?;
    Ok(())
}

/// Bundle explicit and imported CSS together so CSS assets remain relative to one entry.
fn bundle_styles(root: &Path, plan: &mut FrontendBuildPlan) -> Result<()> {
    let mut styles = std::collections::BTreeSet::new();
    if let Some(stylesheet) = plan.manifest.get("styles").and_then(|value| value.as_str()) {
        styles.insert(contained_existing(root, stylesheet)?);
    }
    for output in plan.entries.values() {
        let css = root.join(output).with_extension("css");
        if css.is_file() {
            styles.insert(css);
        }
    }
    if styles.is_empty() {
        return Ok(());
    }
    let outfile = root.join("dist/styles.bundle.css");
    if outfile.exists() && !outfile.canonicalize()?.starts_with(root.canonicalize()?) {
        bail!("styles output escapes the plugin root");
    }
    if outfile.exists()
        && styles
            .iter()
            .any(|source| source.canonicalize().ok() == outfile.canonicalize().ok())
    {
        bail!("styles output would overwrite an authored stylesheet; keep sources outside dist/styles.bundle.css");
    }
    let input = root.join(format!("dist/.cognia-styles-{}.css", uuid::Uuid::new_v4()));
    let imports = styles
        .iter()
        .map(|source| {
            serde_json::to_string(&source.to_string_lossy().replace('\\', "/"))
                .map(|path| format!("@import {path};\n"))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("");
    std::fs::write(&input, imports)?;
    let mut command = Command::new(if cfg!(target_os = "windows") {
        "npx.cmd"
    } else {
        "npx"
    });
    command
        .current_dir(root)
        .args(esbuild_args(&input, &outfile));
    let result = run_streaming(command, "npx esbuild CSS");
    let removed = std::fs::remove_file(&input);
    result?;
    removed?;
    plan.manifest["styles"] = "dist/styles.bundle.css".into();
    // Keep the module's manifest aligned with the distribution without replacing executable values.
    for output in plan.entries.values() {
        use std::io::Write as _;
        std::fs::OpenOptions::new().append(true).open(root.join(output))?.write_all(
            b"\n;(()=>{const d=module.exports.default||module.exports.plugin||module.exports;if(d.manifest)d.manifest.styles=\"dist/styles.bundle.css\";})();\n"
        )?;
    }
    Ok(())
}

/// Collect assets before opening the archive, validating every symlink and path.
fn collect_bundle_files(
    root: &Path,
    manifest: &serde_json::Value,
    main: &str,
) -> Result<std::collections::BTreeSet<String>> {
    fn add(root: &Path, rel: &str, files: &mut std::collections::BTreeSet<String>) -> Result<()> {
        let rel = normalized_rel(rel)?;
        let source = contained_existing(root, &rel)?;
        // Directory symlinks can introduce cycles even when their targets remain contained.
        if source.is_dir() {
            if std::fs::symlink_metadata(&source)?.file_type().is_symlink() {
                bail!("bundle directory cannot be a symlink: {rel}");
            }
            for entry in std::fs::read_dir(source)? {
                let entry = entry?;
                let child = format!("{rel}/{}", entry.file_name().to_string_lossy());
                add(root, &child, files)?;
            }
        } else if source.is_file() {
            files.insert(rel);
        } else {
            bail!("bundle entry is not a regular file: {rel}");
        }
        Ok(())
    }
    let mut files = std::collections::BTreeSet::new();
    add(root, main, &mut files)?;
    let mut entries = std::collections::BTreeSet::new();
    collect_module_entries(manifest, &mut entries)?;
    for entry in entries {
        add(root, &entry, &mut files)?;
    }
    // The generated authoring catalog is the same path contract used by lint and native installs.
    for descriptor in super::contract::PLUGIN_PATH_FIELDS {
        let mut values = Vec::new();
        path_values(
            manifest,
            &descriptor.split('.').collect::<Vec<_>>(),
            &mut values,
        );
        for value in values {
            add(root, value, &mut files)?;
        }
    }
    if let Some(icon) = manifest.get("icon").and_then(|v| v.as_str()) {
        if !icon.contains(':') && (icon.contains('/') || Path::new(icon).extension().is_some()) {
            add(root, icon, &mut files)?;
        }
    }
    // Executable sources distinguish package-owned files from PATH-installed commands.
    if let Some(servers) = manifest
        .get("lspServers")
        .and_then(|value| value.as_array())
    {
        for server in servers {
            if let Some(command) = server.get("command").and_then(|value| value.as_str()) {
                if command.contains(['/', '\\'])
                    && !Path::new(command).is_absolute()
                    && !command.contains(':')
                {
                    add(root, command, &mut files)?;
                }
            }
        }
    }
    if let Some(executables) = manifest
        .pointer("/ide/executables")
        .and_then(|value| value.as_array())
    {
        for executable in executables {
            if executable
                .pointer("/source/kind")
                .and_then(|value| value.as_str())
                == Some("plugin-resource")
            {
                let source = executable
                    .pointer("/source/path")
                    .and_then(|value| value.as_str())
                    .ok_or_else(|| {
                        anyhow!("IDE plugin-resource executable requires source.path")
                    })?;
                add(root, source, &mut files)?;
            }
        }
    }
    // esbuild-emitted CSS/assets and conventional plugin-owned resource trees.
    for directory in ["dist", "assets", "public", "locales"] {
        if root.join(directory).is_dir() {
            add(root, directory, &mut files)?;
        }
    }
    if let Some(array) = manifest.get("bundle_include").and_then(|v| v.as_array()) {
        for value in array {
            let rel = value
                .as_str()
                .ok_or_else(|| anyhow!("bundle_include entries must be strings"))?;
            add(root, rel, &mut files).with_context(|| {
                format!("bundle_include references missing or unsafe file {rel}")
            })?;
        }
    }
    files.remove("plugin.json");
    Ok(files)
}

fn pack_frontend_bundle(
    out_path: &Path,
    crate_root: &Path,
    manifest: &serde_json::Value,
    main_rel: &str,
) -> Result<()> {
    use std::io::Write as _;
    let files = collect_bundle_files(crate_root, manifest, main_rel)?;
    if out_path.exists() {
        let output = out_path.canonicalize()?;
        if output
            == crate_root
                .join("plugin.json")
                .canonicalize()
                .unwrap_or_default()
            || files
                .iter()
                .any(|rel| crate_root.join(rel).canonicalize().ok().as_ref() == Some(&output))
        {
            bail!("archive output would overwrite a plugin input file");
        }
    }
    let file = std::fs::File::create(out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file("plugin.json", options)?;
    writer.write_all(&serde_json::to_vec_pretty(manifest)?)?;
    for rel in files {
        let source = contained_existing(crate_root, &rel)?;
        #[cfg(unix)]
        let options = {
            use std::os::unix::fs::PermissionsExt;
            options.unix_permissions(std::fs::metadata(&source)?.permissions().mode() & 0o777)
        };
        writer.start_file(&rel, options)?;
        writer.write_all(&std::fs::read(source)?)?;
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
            "@cognia/plugin-sdk/*",
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
    fn esbuild_emits_a_browser_cjs_bundle_the_loader_can_eval() {
        let args = esbuild_args(Path::new("src/index.ts"), Path::new("dist/index.js"));
        for expected in [
            "--bundle",
            "--format=cjs",
            "--platform=browser",
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
    fn skip_build_normalizes_source_entry_and_preserves_source() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("src/index.ts"), "const value: number = 1;").unwrap();
        std::fs::write(root.join("dist/index.js"), "module.exports = {};").unwrap();
        let manifest = json!({"id":"safe", "version":"1.0.0", "main":"src/index.ts",
            "extensions":[{"entry":"src/index.ts", "export":"Panel"}],
            "runtimeCompatibility":{"browser":{"entrypoint":"src/index.ts"}}});
        let path = build_and_pack(root, &manifest, Some(root.join("safe.zip")), true).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
        let mut encoded = String::new();
        archive
            .by_name("plugin.json")
            .unwrap()
            .read_to_string(&mut encoded)
            .unwrap();
        let packed: serde_json::Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(packed["main"], "dist/index.js");
        assert_eq!(packed["extensions"][0]["entry"], "dist/index.js");
        assert_eq!(
            packed["runtimeCompatibility"]["browser"]["entrypoint"],
            "dist/index.js"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("src/index.ts")).unwrap(),
            "const value: number = 1;"
        );
        assert!(archive.by_name("src/index.ts").is_err());
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
    #[test]
    fn archive_includes_declared_resources_and_secondary_entries() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        for (path, bytes) in [
            ("dist/index.js", "main"),
            ("dist/entries/src/panel.js", "panel"),
            ("styles.css", "body{}"),
            ("assets/icon.png", "icon"),
            ("fonts/demo.woff2", "font"),
            ("docs/nested/readme.md", "docs"),
        ] {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }
        let manifest = json!({"id":"resource", "version":"1", "main":"dist/index.js", "styles":"styles.css", "icon":"assets/icon.png",
            "fonts":[{"files":[{"src":"fonts/demo.woff2"}]}], "extensions":[{"entry":"dist/entries/src/panel.js"}], "bundle_include":["docs"]});
        pack_frontend_bundle(&root.join("plugin.zip"), root, &manifest, "dist/index.js").unwrap();
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(root.join("plugin.zip")).unwrap()).unwrap();
        for path in [
            "styles.css",
            "assets/icon.png",
            "fonts/demo.woff2",
            "dist/entries/src/panel.js",
            "docs/nested/readme.md",
        ] {
            assert!(archive.by_name(path).is_ok(), "missing {path}");
        }
    }

    #[test]
    fn build_rejects_escaping_author_entries_before_invoking_esbuild() {
        let tmp = tempdir().unwrap();
        let manifest = json!({"main":"src/index.ts", "tsEntry":"../secret.ts"});
        assert!(build_plan(tmp.path(), &manifest, true).is_err());
    }

    #[test]
    fn archive_rejects_parent_traversal_and_preserves_existing_output() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "main").unwrap();
        std::fs::write(root.join("plugin.zip"), "previous").unwrap();
        let manifest = json!({"main":"dist/index.js", "bundle_include":["../secret"]});
        assert!(
            pack_frontend_bundle(&root.join("plugin.zip"), root, &manifest, "dist/index.js")
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(root.join("plugin.zip")).unwrap(),
            "previous"
        );
    }

    #[cfg(unix)]
    #[test]
    fn archive_rejects_assets_symlink_outside_plugin_root() {
        let tmp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/index.js"), "main").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("assets")).unwrap();
        assert!(pack_frontend_bundle(
            &root.join("plugin.zip"),
            root,
            &json!({"main":"dist/index.js"}),
            "dist/index.js"
        )
        .is_err());
    }
    #[test]
    fn archive_includes_plugin_owned_lsp_and_ide_executables() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        for path in ["dist/index.js", "servers/lsp.mjs", "servers/dap.mjs"] {
            let file = root.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "server").unwrap();
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                root.join("servers/lsp.mjs"),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let manifest = json!({"main":"dist/index.js", "lspServers":[{"command":"servers/lsp.mjs"},{"command":"node"}],
            "ide":{"executables":[{"source":{"kind":"plugin-resource","path":"servers/dap.mjs"}}]}});
        pack_frontend_bundle(&root.join("plugin.zip"), root, &manifest, "dist/index.js").unwrap();
        let mut archive =
            zip::ZipArchive::new(std::fs::File::open(root.join("plugin.zip")).unwrap()).unwrap();
        assert!(archive.by_name("servers/dap.mjs").is_ok());
        let lsp = archive.by_name("servers/lsp.mjs").unwrap();
        #[cfg(unix)]
        assert_eq!(lsp.unix_mode().unwrap() & 0o777, 0o755);
        #[cfg(not(unix))]
        assert_eq!(lsp.name(), "servers/lsp.mjs");
    }
}
