//! Bundle assembly + `cognia:api-version` custom-section injection.
//!
//! A cognia plugin bundle is a `.zip` containing at minimum:
//!   - `plugin.json`        — the manifest
//!   - the runtime entry artifact declared by the manifest (`wasmMain`,
//!     `pythonMain`, `vscodeMain`, `main`, etc.) when that runtime has one
//!
//! Optionally:
//!   - any additional asset paths the manifest references (icons,
//!     embedded JSON Schemas, etc.). For v0.1 we copy every file the
//!     author lists in `bundle_include[]` if present.
//!
//! Bundles are deterministic up to the file system order of inputs —
//! we sort the entry list before writing so two builds in a row produce
//! byte-identical zips (modulo the cargo-component cache).

use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Name of the WASM custom section the runtime parses to route to the
/// correct host linker.
const API_VERSION_SECTION: &str = "cognia:api-version";

/// Inject the `cognia:api-version` custom section into a wasm component
/// binary. If the section already exists, replace it in place. The
/// component is a wasm module wrapped in component-model framing — we
/// append the section at the end which is valid for both module and
/// component layouts.
pub fn embed_api_version(wasm: &[u8], version: &str) -> Result<Vec<u8>> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        bail!("input is not a wasm module (bad magic)");
    }
    // Strip any pre-existing `cognia:api-version` section so re-running
    // the embed doesn't accumulate duplicates.
    let stripped = strip_section(wasm, API_VERSION_SECTION)?;
    let mut out = stripped;
    // Custom section format: section id (0) + section size (LEB128) +
    // name length (LEB128) + name bytes + payload bytes. The payload is
    // the API version string verbatim.
    let name = API_VERSION_SECTION.as_bytes();
    let payload = version.as_bytes();
    let mut body = Vec::with_capacity(5 + name.len() + payload.len());
    write_leb128(&mut body, name.len() as u64);
    body.extend_from_slice(name);
    body.extend_from_slice(payload);
    out.push(0); // section id 0 = custom
    write_leb128(&mut out, body.len() as u64);
    out.extend_from_slice(&body);
    Ok(out)
}

fn write_leb128(buf: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
            buf.push(byte);
        } else {
            buf.push(byte);
            return;
        }
    }
}

/// Strip the top-level custom section named `target_name`, forwarding every
/// other section — of any kind — byte-for-byte.
///
/// Core modules and components share identical top-level framing: an 8-byte
/// header (magic + version, plus a layer word for components) followed by a
/// sequence of sections, each `[id: u8][size: u32 LEB128][contents]`. Custom
/// sections use id 0 and their contents begin with a LEB128-length-prefixed
/// name. We only interpret the *name* of id-0 sections — to decide whether to
/// drop them; every other section (and every non-target custom section) is
/// copied verbatim. That is deliberate: enumerating section kinds would be the
/// old bug with a longer whitelist. Copying raw bytes means unknown and
/// component-model section kinds (`ComponentTypeSection`, aliases, nested core
/// modules, …) round-trip losslessly — which is what real `cargo component`
/// output is made of. `cognia:api-version` is the only section ever removed,
/// so the build path can never strip its own version section.
fn strip_section(wasm: &[u8], target_name: &str) -> Result<Vec<u8>> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        bail!("input is not a wasm module (bad magic)");
    }
    let mut out = Vec::with_capacity(wasm.len());
    out.extend_from_slice(&wasm[..8]); // magic + version (+ layer for components)
    let mut pos = 8usize;
    while pos < wasm.len() {
        let section_start = pos;
        let id = wasm[pos];
        pos += 1;
        let (size, size_len) = read_leb128_u32(&wasm[pos..])
            .with_context(|| format!("malformed section length at offset {pos}"))?;
        pos += size_len;
        let contents_end = pos
            .checked_add(size as usize)
            .filter(|end| *end <= wasm.len())
            .ok_or_else(|| {
                anyhow!("section at offset {section_start} overruns the module bounds")
            })?;
        let contents = &wasm[pos..contents_end];
        pos = contents_end;

        let is_target =
            id == 0 && custom_section_name(contents).as_deref() == Some(target_name);
        if !is_target {
            out.extend_from_slice(&wasm[section_start..contents_end]);
        }
    }
    Ok(out)
}

/// Decode an unsigned LEB128 `u32` from the front of `bytes`, returning the
/// value and the number of bytes consumed. Errors if the encoding is truncated
/// or does not fit in 32 bits (a u32 LEB128 is at most 5 bytes).
fn read_leb128_u32(bytes: &[u8]) -> Result<(u32, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for (i, &byte) in bytes.iter().enumerate().take(5) {
        result |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            let value =
                u32::try_from(result).map_err(|_| anyhow!("LEB128 value exceeds 32 bits"))?;
            return Ok((value, i + 1));
        }
        shift += 7;
    }
    bail!("truncated LEB128 value (or wider than 32 bits)")
}

/// For an id-0 custom section, decode its name from `[len LEB][name bytes]…`.
/// Returns `None` if the contents are truncated or the name isn't valid UTF-8,
/// in which case the section is treated as non-matching and forwarded intact.
fn custom_section_name(contents: &[u8]) -> Option<String> {
    let (name_len, consumed) = read_leb128_u32(contents).ok()?;
    let end = consumed.checked_add(name_len as usize)?;
    let name_bytes = contents.get(consumed..end)?;
    std::str::from_utf8(name_bytes).ok().map(str::to_owned)
}

#[derive(Debug, Clone)]
pub struct BundlePlan {
    pub manifest_path: PathBuf,
    pub wasm_path: PathBuf,
    pub extra_files: Vec<PathBuf>,
}

#[derive(Debug, Clone)]
struct ExistingEntry {
    rel: String,
    source: PathBuf,
}

/// Resolve everything that should go in the bundle. The wasm path is
/// derived from manifest.wasmMain relative to the crate root.
pub fn plan_bundle(crate_root: &Path, manifest: &serde_json::Value) -> Result<BundlePlan> {
    let manifest_path = crate_root.join("plugin.json");
    let wasm_main = manifest
        .get("wasmMain")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json is missing wasmMain"))?
        .to_string();
    let candidate_dirs = [
        crate_root
            .join("target")
            .join("wasm32-wasip2")
            .join("release"),
        crate_root
            .join("target")
            .join("wasm32-wasip1")
            .join("release"),
    ];
    let wasm_path = candidate_dirs
        .iter()
        .find_map(|dir| {
            let primary = dir.join(&wasm_main);
            if primary.exists() {
                return Some(primary);
            }
            std::fs::read_dir(dir).ok().and_then(|entries| {
                entries
                    .flatten()
                    .find(|e| {
                        e.path()
                            .extension()
                            .and_then(|x| x.to_str())
                            .map(|s| s.eq_ignore_ascii_case("wasm"))
                            .unwrap_or(false)
                    })
                    .map(|e| e.path())
            })
        })
        .ok_or_else(|| {
            anyhow!(
                "could not locate a built .wasm under target/. Did you run `cargo component build --release`?"
            )
        })?;
    let extra_files = manifest
        .get("bundle_include")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|p| crate_root.join(p))
                .collect()
        })
        .unwrap_or_default();
    Ok(BundlePlan {
        manifest_path,
        wasm_path,
        extra_files,
    })
}

/// Write the bundle. The wasm component is renamed to whatever the
/// manifest's `wasmMain` says — typically `<crate_name>.wasm`.
pub fn write_bundle(
    out_path: &Path,
    plan: &BundlePlan,
    manifest: &serde_json::Value,
) -> Result<()> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let file = std::fs::File::create(out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    // 1. plugin.json — pretty-printed so users can `unzip -p bundle.zip plugin.json | jq`.
    writer.start_file("plugin.json", options)?;
    let pretty = serde_json::to_vec_pretty(manifest)?;
    writer.write_all(&pretty)?;
    // 2. wasm artifact at the manifest-declared path.
    let wasm_main = manifest
        .get("wasmMain")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json is missing wasmMain"))?;
    let wasm_bytes = std::fs::read(&plan.wasm_path)
        .with_context(|| format!("read {}", plan.wasm_path.display()))?;
    writer.start_file(wasm_main, options)?;
    writer.write_all(&wasm_bytes)?;
    // 3. extra files declared by manifest.bundle_include[].
    let mut seen = HashSet::new();
    seen.insert(wasm_main.to_string());
    seen.insert("plugin.json".to_string());
    for extra in &plan.extra_files {
        if let Some(rel) = extra
            .strip_prefix(&plan.manifest_path.parent().unwrap_or(Path::new(".")))
            .ok()
        {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if seen.contains(&rel_str) {
                continue;
            }
            let mut f =
                std::fs::File::open(extra).with_context(|| format!("open {}", extra.display()))?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            writer.start_file(&rel_str, options)?;
            writer.write_all(&buf)?;
            seen.insert(rel_str);
        }
    }
    writer.finish()?;
    Ok(())
}

/// Pack a manifest whose runtime entry files already exist on disk. This is
/// used for build-free plugin types (`python`, `hybrid`, `vscode-extension`):
/// the CLI validates and packages declared artifacts, but it does not invent a
/// compiler step for runtimes that the host itself treats as prebuilt.
pub fn pack_existing_entry_bundle(
    crate_root: &Path,
    manifest: &serde_json::Value,
    out: Option<PathBuf>,
    entry_fields: &[&str],
) -> Result<PathBuf> {
    let id = manifest_string(manifest, "id")?;
    let version = manifest_string(manifest, "version")?;
    let bundle_path = out.unwrap_or_else(|| {
        crate_root
            .join("target")
            .join("cognia")
            .join(format!("{id}-{version}.zip"))
    });
    let entries = collect_existing_entries(crate_root, manifest, entry_fields)?;
    write_existing_entry_bundle(&bundle_path, manifest, &entries)?;
    Ok(bundle_path)
}

fn manifest_string<'a>(manifest: &'a serde_json::Value, field: &str) -> Result<&'a str> {
    manifest
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("plugin.json missing {field}"))
}

fn collect_existing_entries(
    crate_root: &Path,
    manifest: &serde_json::Value,
    entry_fields: &[&str],
) -> Result<Vec<ExistingEntry>> {
    let mut seen = HashSet::new();
    seen.insert("plugin.json".to_string());
    let mut entries = Vec::new();

    for field in entry_fields {
        if let Some(rel) = manifest
            .get(*field)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            push_existing_entry(crate_root, &mut seen, &mut entries, field, rel)?;
        }
    }

    if let Some(arr) = manifest.get("bundle_include").and_then(|v| v.as_array()) {
        for (idx, entry) in arr.iter().enumerate() {
            let Some(rel) = entry.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            push_existing_entry(
                crate_root,
                &mut seen,
                &mut entries,
                &format!("bundle_include[{idx}]"),
                rel,
            )?;
        }
    }

    Ok(entries)
}

fn push_existing_entry(
    crate_root: &Path,
    seen: &mut HashSet<String>,
    entries: &mut Vec<ExistingEntry>,
    field: &str,
    rel: &str,
) -> Result<()> {
    let rel_in_zip = normalize_bundle_rel(field, rel)?;
    if seen.contains(&rel_in_zip) {
        return Ok(());
    }
    let source = crate_root.join(rel);
    if !source.exists() {
        bail!("{field} points at missing file {}", source.display());
    }
    if source.is_dir() {
        bail!(
            "{field} points at a directory {}, expected a file",
            source.display()
        );
    }
    entries.push(ExistingEntry {
        rel: rel_in_zip.clone(),
        source,
    });
    seen.insert(rel_in_zip);
    Ok(())
}

fn normalize_bundle_rel(field: &str, rel: &str) -> Result<String> {
    if rel.is_empty()
        || rel.contains('\0')
        || rel.starts_with('/')
        || rel.starts_with('\\')
        || rel
            .as_bytes()
            .get(1)
            .is_some_and(|b| *b == b':' && rel.as_bytes()[0].is_ascii_alphabetic())
        || rel.split(['/', '\\']).any(|part| part == "..")
    {
        bail!("{field} must be a relative file path inside the plugin directory");
    }
    Ok(rel.replace('\\', "/"))
}

fn write_existing_entry_bundle(
    out_path: &Path,
    manifest: &serde_json::Value,
    entries: &[ExistingEntry],
) -> Result<()> {
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let file = std::fs::File::create(out_path)
        .with_context(|| format!("create {}", out_path.display()))?;
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    writer.start_file("plugin.json", options)?;
    let pretty = serde_json::to_vec_pretty(manifest)?;
    writer.write_all(&pretty)?;

    for entry in entries {
        let bytes = std::fs::read(&entry.source)
            .with_context(|| format!("read {}", entry.source.display()))?;
        writer.start_file(&entry.rel, options)?;
        writer.write_all(&bytes)?;
    }

    writer.finish()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn min_wasm() -> Vec<u8> {
        // Minimal valid wasm module: magic + version + nothing else.
        vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    /// A core module with a *real* section graph. `min_wasm()` (magic+version
    /// only) is a degenerate shape that survives section handling no matter how
    /// broken it is — it is not a regression test. Every real module has at
    /// least a type section: `01 04 01 60 00 00` = section id 1, len 4, one
    /// entry, `0x60` functype, 0 params, 0 results.
    fn wasm_with_type_section() -> Vec<u8> {
        let mut v = min_wasm();
        v.extend_from_slice(&[0x01, 0x04, 0x01, 0x60, 0x00, 0x00]);
        v
    }

    /// A component-shaped module. `cargo component` (wasip2) emits a *component*,
    /// not a core module: the version word is `0x0d 0x00` and a layer word
    /// `0x01 0x00` follows. Top-level framing is identical to a core module
    /// (`[id][leb len][contents]`), so a raw section walker round-trips both.
    /// This fixture pins that a non-custom component section and a non-target
    /// custom section both survive re-embedding — the core-module fixture alone
    /// would let a fix pass here and still corrupt real `cargo component` output.
    fn component_with_sections() -> Vec<u8> {
        let mut v = vec![
            0x00, 0x61, 0x73, 0x6d, // \0asm
            0x0d, 0x00, // version 0x0d
            0x01, 0x00, // layer 0x01 (component)
        ];
        // A non-target custom section named "producers": contents are
        // [name_len][name][data].
        let mut contents = vec![b"producers".len() as u8];
        contents.extend_from_slice(b"producers");
        contents.extend_from_slice(b"x");
        v.push(0x00); // custom section id
        v.push(contents.len() as u8); // section length (fits in one LEB byte)
        v.extend_from_slice(&contents);
        // An opaque non-custom top-level section (id 7 = component type); the
        // contents are deliberately arbitrary — the walker forwards it verbatim
        // without interpreting them.
        v.extend_from_slice(&[0x07, 0x03, 0xaa, 0xbb, 0xcc]);
        v
    }

    fn count_marker(bytes: &[u8], marker: &[u8]) -> usize {
        bytes.windows(marker.len()).filter(|w| *w == marker).count()
    }

    #[test]
    fn embed_api_version_forwards_non_custom_sections() {
        // The core defect: `embed_api_version` errored on any module with a
        // non-custom section (i.e. every real module). It must forward the
        // type section and add exactly one version section.
        let out = embed_api_version(&wasm_with_type_section(), "0.1.0")
            .expect("embed must succeed on a module with a real section graph");

        let mut saw_type = false;
        let mut version_sections = 0usize;
        for payload in wasmparser::Parser::new(0).parse_all(&out) {
            match payload.expect("output must re-parse as valid wasm") {
                wasmparser::Payload::TypeSection(_) => saw_type = true,
                wasmparser::Payload::CustomSection(reader)
                    if reader.name() == API_VERSION_SECTION =>
                {
                    version_sections += 1;
                    assert_eq!(reader.data(), b"0.1.0");
                }
                _ => {}
            }
        }
        assert!(saw_type, "type section must be forwarded, not dropped");
        assert_eq!(version_sections, 1, "exactly one cognia:api-version section");
    }

    #[test]
    fn embed_api_version_is_idempotent_on_real_module() {
        let once = embed_api_version(&wasm_with_type_section(), "0.2.0").unwrap();
        let twice = embed_api_version(&once, "0.2.0")
            .expect("re-embedding a previously-embedded real module must succeed");

        let mut saw_type = false;
        let mut version_sections = 0usize;
        for payload in wasmparser::Parser::new(0).parse_all(&twice) {
            match payload.expect("re-embedded output must re-parse") {
                wasmparser::Payload::TypeSection(_) => saw_type = true,
                wasmparser::Payload::CustomSection(r) if r.name() == API_VERSION_SECTION => {
                    version_sections += 1
                }
                _ => {}
            }
        }
        assert!(saw_type, "type section must survive re-embedding");
        assert_eq!(version_sections, 1, "re-embed must replace, not append");
    }

    #[test]
    fn embed_api_version_round_trips_component_sections() {
        let input = component_with_sections();
        let out = embed_api_version(&input, "0.3.0")
            .expect("embed must succeed on a component (cargo-component's real output shape)");

        assert_eq!(&out[..8], &input[..8], "component header must be preserved");
        assert!(
            count_marker(&out, b"producers") == 1,
            "non-target custom section must be forwarded intact"
        );
        assert!(
            out.windows(5).any(|w| w == [0x07, 0x03, 0xaa, 0xbb, 0xcc]),
            "non-custom component section must round-trip verbatim"
        );
        assert_eq!(
            count_marker(&out, API_VERSION_SECTION.as_bytes()),
            1,
            "exactly one cognia:api-version section"
        );
        assert!(count_marker(&out, b"0.3.0") == 1);

        // Re-embedding strips only the prior version section, never the
        // component's own sections.
        let twice = embed_api_version(&out, "0.3.0").expect("re-embed on a component must succeed");
        assert_eq!(
            count_marker(&twice, API_VERSION_SECTION.as_bytes()),
            1,
            "re-embed must replace, not append"
        );
        assert_eq!(count_marker(&twice, b"producers"), 1);
        assert!(twice.windows(5).any(|w| w == [0x07, 0x03, 0xaa, 0xbb, 0xcc]));
    }

    #[test]
    fn embed_api_version_appends_custom_section() {
        let out = embed_api_version(&min_wasm(), "0.1.0").unwrap();
        assert!(out
            .windows(API_VERSION_SECTION.len())
            .any(|w| w == API_VERSION_SECTION.as_bytes()));
        assert!(out.windows(5).any(|w| w == b"0.1.0"));
        // Output is larger than input (we appended a section).
        assert!(out.len() > min_wasm().len());
    }

    #[test]
    fn embed_api_version_rejects_non_wasm_input() {
        let err = embed_api_version(b"not wasm", "0.1.0").unwrap_err();
        assert!(err.to_string().contains("not a wasm"));
    }

    #[test]
    fn leb128_writes_single_byte_for_small_values() {
        let mut buf = Vec::new();
        write_leb128(&mut buf, 0);
        assert_eq!(buf, vec![0]);
        let mut buf = Vec::new();
        write_leb128(&mut buf, 127);
        assert_eq!(buf, vec![127]);
        let mut buf = Vec::new();
        write_leb128(&mut buf, 128);
        assert_eq!(buf, vec![0x80, 0x01]);
    }

    fn zip_entry_names(path: &Path) -> Vec<String> {
        let bytes = std::fs::read(path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn pack_existing_entry_bundle_writes_declared_entries_and_bundle_include() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("backend")).unwrap();
        std::fs::write(
            tmp.path().join("backend/main.py"),
            "def activate(ctx): pass\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("README.md"), "# demo\n").unwrap();
        let manifest = json!({
            "id": "py",
            "version": "0.1.0",
            "type": "python",
            "pythonMain": "backend/main.py",
            "bundle_include": ["README.md", "backend/main.py"]
        });
        let out = tmp.path().join("py.zip");

        let path =
            pack_existing_entry_bundle(tmp.path(), &manifest, Some(out.clone()), &["pythonMain"])
                .unwrap();

        assert_eq!(path, out);
        assert_eq!(
            zip_entry_names(&path),
            vec!["README.md", "backend/main.py", "plugin.json"]
        );
    }

    #[test]
    fn pack_existing_entry_bundle_errors_when_declared_entry_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = json!({
            "id": "vscode-demo",
            "version": "0.1.0",
            "type": "vscode-extension",
            "vscodeMain": "extension/out/extension.js"
        });

        let err =
            pack_existing_entry_bundle(tmp.path(), &manifest, None, &["vscodeMain"]).unwrap_err();

        assert!(err.to_string().contains("vscodeMain"), "got: {err}");
        assert!(err.to_string().contains("extension.js"), "got: {err}");
    }

    #[test]
    fn pack_existing_entry_bundle_rejects_paths_outside_plugin_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = json!({
            "id": "bad",
            "version": "0.1.0",
            "type": "python",
            "pythonMain": "../main.py"
        });

        let err =
            pack_existing_entry_bundle(tmp.path(), &manifest, None, &["pythonMain"]).unwrap_err();

        assert!(err.to_string().contains("relative file path"), "got: {err}");
    }
}
