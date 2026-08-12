//! `cognia plugin info <path>` — inspect a bundle or unpacked plugin directory without installing.
//!
//! Prints what the host would see when offered the input: manifest
//! summary, declared capabilities + permissions, file list, signature
//! verification result for bundles, public-key fingerprint, and (for wasm inputs)
//! the embedded `cognia:api-version` custom section.

use anyhow::{anyhow, Context, Result};
use comfy_table::{presets::UTF8_FULL, ContentArrangement, Table};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::{
    engine::signing::{fingerprint, verify_bundle},
    shared::b64_decode,
    ui::{style, RuntimeUi},
};

const API_VERSION_SECTION: &str = "cognia:api-version";

/// `cognia plugin info` — inspect a built bundle or unpacked plugin directory.
///
/// Phase 2 surfaces:
///   * `--json` ⇒ structured JSON with `schemaVersion: 1`.
///   * `--detailed` ⇒ comfy-table file list + full signature breakdown.
///   * default ⇒ compact human report: manifest summary, file count +
///                 total size, one-line signature status.
pub fn run(input: PathBuf, json: bool, detailed: bool, ui: &mut RuntimeUi) -> Result<()> {
    let report = match inspect_path(&input) {
        Ok(report) => report,
        Err(err) if json => return emit_json_failure(&input, "inspect", err),
        Err(err) => return Err(err),
    };
    if json {
        let payload = report.to_json_payload();
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if ui.flags.quiet {
        return Ok(());
    } else {
        if detailed {
            print_detailed(&report);
        } else {
            print_compact(&report);
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct InfoFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    path: String,
    error: String,
}

fn emit_json_failure(path: &Path, stage: &'static str, err: anyhow::Error) -> Result<()> {
    let payload = InfoFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "info",
        stage,
        path: path.display().to_string(),
        error: err.to_string(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InfoInputKind {
    Bundle,
    Directory,
}

impl InfoInputKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bundle => "bundle",
            Self::Directory => "directory",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Bundle => "Bundle",
            Self::Directory => "Directory",
        }
    }
}

#[derive(Debug)]
pub struct InfoReport {
    pub input_kind: InfoInputKind,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub manifest: serde_json::Value,
    pub files: Vec<EntryInfo>,
    pub signature: SignatureStatus,
    pub wasm_api_version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EntryInfo {
    pub name: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug)]
pub enum SignatureStatus {
    /// Signature verification is meaningful for immutable bundles only.
    NotApplicable,
    /// No `<bundle>.sig` file on disk alongside the bundle.
    NoSidecar,
    /// `.sig` present but the bundle declares no `author.publicKey`.
    NoPublicKey,
    /// `.sig` present and verification passed.
    Valid {
        public_key: String,
        fingerprint: String,
    },
    /// `.sig` present but verification failed (mismatch / corrupt).
    Invalid {
        reason: String,
        public_key: Option<String>,
    },
}

/// Wire shape for `--json`. Versioned so future changes are non-breaking.
#[derive(Debug, Serialize)]
pub struct InfoJsonPayload<'a> {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    #[serde(rename = "inputKind")]
    input_kind: &'static str,
    path: String,
    #[serde(rename = "sizeBytes")]
    size_bytes: u64,
    manifest: &'a serde_json::Value,
    files: &'a [EntryInfo],
    signature: JsonSignature<'a>,
    #[serde(rename = "wasmApiVersion", skip_serializing_if = "Option::is_none")]
    wasm_api_version: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status")]
pub enum JsonSignature<'a> {
    #[serde(rename = "not-applicable")]
    NotApplicable,
    #[serde(rename = "no-sidecar")]
    NoSidecar,
    #[serde(rename = "no-public-key")]
    NoPublicKey,
    #[serde(rename = "valid")]
    Valid {
        #[serde(rename = "publicKey")]
        public_key: &'a str,
        fingerprint: &'a str,
    },
    #[serde(rename = "invalid")]
    Invalid {
        reason: &'a str,
        #[serde(rename = "publicKey", skip_serializing_if = "Option::is_none")]
        public_key: Option<&'a str>,
    },
}

impl InfoReport {
    /// Project the report into the wire shape used by `--json`.
    pub fn to_json_payload(&self) -> InfoJsonPayload<'_> {
        let signature = match &self.signature {
            SignatureStatus::NotApplicable => JsonSignature::NotApplicable,
            SignatureStatus::NoSidecar => JsonSignature::NoSidecar,
            SignatureStatus::NoPublicKey => JsonSignature::NoPublicKey,
            SignatureStatus::Valid {
                public_key,
                fingerprint,
            } => JsonSignature::Valid {
                public_key,
                fingerprint,
            },
            SignatureStatus::Invalid { reason, public_key } => JsonSignature::Invalid {
                reason,
                public_key: public_key.as_deref(),
            },
        };
        InfoJsonPayload {
            schema_version: 1,
            // `info` is an inspection, not a gate (that's `verify`), but it must
            // not report `ok: true` for a bundle whose signature it just proved
            // *invalid* — a `jq -e .ok` check would pass for a tampered bundle.
            // Any other status (valid / not-applicable / no-key / no-sidecar)
            // leaves `ok` true; only a definitively bad signature flips it.
            ok: !matches!(self.signature, SignatureStatus::Invalid { .. }),
            action: "info",
            input_kind: self.input_kind.as_str(),
            path: self.path.display().to_string(),
            size_bytes: self.size_bytes,
            manifest: &self.manifest,
            files: &self.files,
            signature,
            wasm_api_version: self.wasm_api_version.as_deref(),
        }
    }

    /// Total size of all enumerated entries (excludes the zip overhead).
    pub fn total_entry_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size_bytes).sum()
    }
}

pub fn inspect_path(input: &Path) -> Result<InfoReport> {
    let metadata = std::fs::metadata(input).with_context(|| format!("stat {}", input.display()))?;
    if metadata.is_dir() {
        inspect_directory(input)
    } else if metadata.is_file() {
        let bundle_bytes =
            std::fs::read(input).with_context(|| format!("read {}", input.display()))?;
        inspect(input, &bundle_bytes)
    } else {
        Err(anyhow!(
            "info path is neither a bundle file nor a plugin directory: {}",
            input.display()
        ))
    }
}

pub fn inspect(bundle_path: &Path, bundle_bytes: &[u8]) -> Result<InfoReport> {
    let reader = std::io::Cursor::new(bundle_bytes);
    let mut archive = zip::ZipArchive::new(reader).context("open bundle as zip")?;

    // 1. manifest
    let manifest = {
        let mut entry = archive
            .by_name("plugin.json")
            .map_err(|e| anyhow!("plugin.json not found in bundle: {e}"))?;
        let mut buf = String::new();
        entry.read_to_string(&mut buf)?;
        serde_json::from_str::<serde_json::Value>(&buf).context("parse plugin.json")?
    };

    // 2. file inventory
    let mut files = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            // Skip directory entries (zip records them as zero-length
            // entries with a trailing slash; they're noise for `info`).
            if entry.is_dir() {
                continue;
            }
            files.push(EntryInfo {
                name: entry.name().to_string(),
                size_bytes: entry.size(),
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));

    // 3. signature
    let signature = inspect_signature(bundle_path, bundle_bytes, &manifest);

    // 4. wasm api version (if a .wasm file is present)
    let wasm_api_version = extract_wasm_api_version(&mut archive, &manifest)?;

    Ok(InfoReport {
        input_kind: InfoInputKind::Bundle,
        path: bundle_path.to_path_buf(),
        size_bytes: bundle_bytes.len() as u64,
        manifest,
        files,
        signature,
        wasm_api_version,
    })
}

fn inspect_directory(dir: &Path) -> Result<InfoReport> {
    let manifest_path = dir.join("plugin.json");
    let manifest_text = std::fs::read_to_string(&manifest_path)
        .with_context(|| format!("read {}", manifest_path.display()))?;
    let manifest =
        serde_json::from_str::<serde_json::Value>(&manifest_text).context("parse plugin.json")?;

    let mut files = Vec::new();
    collect_directory_files(dir, dir, &mut files)?;
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let size_bytes = files.iter().map(|f| f.size_bytes).sum();
    let wasm_api_version = extract_wasm_api_version_from_directory(dir, &manifest)?;

    Ok(InfoReport {
        input_kind: InfoInputKind::Directory,
        path: dir.to_path_buf(),
        size_bytes,
        manifest,
        files,
        signature: SignatureStatus::NotApplicable,
        wasm_api_version,
    })
}

fn collect_directory_files(root: &Path, dir: &Path, files: &mut Vec<EntryInfo>) -> Result<()> {
    for entry in std::fs::read_dir(dir).with_context(|| format!("read dir {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_directory_files(root, &path, files)?;
            continue;
        }
        if file_type.is_file() {
            let rel = path
                .strip_prefix(root)
                .with_context(|| format!("relativize {}", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            files.push(EntryInfo {
                name: rel,
                size_bytes: entry.metadata()?.len(),
            });
        }
    }
    Ok(())
}

fn inspect_signature(
    bundle_path: &Path,
    bundle_bytes: &[u8],
    manifest: &serde_json::Value,
) -> SignatureStatus {
    let sig_path = sig_path_for(bundle_path);
    if !sig_path.exists() {
        return SignatureStatus::NoSidecar;
    }
    let sig_str = match std::fs::read_to_string(&sig_path) {
        Ok(s) => s,
        Err(e) => {
            return SignatureStatus::Invalid {
                reason: format!("read {}: {e}", sig_path.display()),
                public_key: None,
            }
        }
    };
    let pk_opt = manifest
        .get("author")
        .and_then(|a| a.get("publicKey"))
        .and_then(|p| p.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());
    let pk = match pk_opt {
        Some(k) => k,
        None => return SignatureStatus::NoPublicKey,
    };
    match verify_bundle(&pk, bundle_bytes, sig_str.trim()) {
        Ok(()) => {
            let fp = b64_decode(&pk)
                .map(|bytes| fingerprint(&bytes))
                .unwrap_or_else(|_| "<invalid base64>".into());
            SignatureStatus::Valid {
                public_key: pk,
                fingerprint: fp,
            }
        }
        Err(e) => SignatureStatus::Invalid {
            reason: e.to_string(),
            public_key: Some(pk),
        },
    }
}

fn sig_path_for(bundle: &Path) -> PathBuf {
    let mut p = bundle.to_path_buf();
    let fname = bundle
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    p.set_file_name(format!("{fname}.sig"));
    p
}

fn extract_wasm_api_version(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    manifest: &serde_json::Value,
) -> Result<Option<String>> {
    let Some(wasm_main) = wasm_main_from_manifest(manifest) else {
        return Ok(None);
    };
    let mut entry = match archive.by_name(&wasm_main) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    Ok(find_custom_section(&bytes, API_VERSION_SECTION))
}

fn extract_wasm_api_version_from_directory(
    root: &Path,
    manifest: &serde_json::Value,
) -> Result<Option<String>> {
    let Some(wasm_main) = wasm_main_from_manifest(manifest) else {
        return Ok(None);
    };
    if !is_safe_manifest_file_path(&wasm_main) {
        return Ok(None);
    }
    let wasm_path = root.join(wasm_main);
    if !wasm_path.exists() {
        return Ok(None);
    }
    let bytes =
        std::fs::read(&wasm_path).with_context(|| format!("read {}", wasm_path.display()))?;
    Ok(find_custom_section(&bytes, API_VERSION_SECTION))
}

fn wasm_main_from_manifest(manifest: &serde_json::Value) -> Option<String> {
    manifest
        .get("wasmMain")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn is_safe_manifest_file_path(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\0')
        && !rel.starts_with('/')
        && !rel.starts_with('\\')
        && !rel
            .as_bytes()
            .get(1)
            .is_some_and(|b| *b == b':' && rel.as_bytes()[0].is_ascii_alphabetic())
        && !rel.split(['/', '\\']).any(|part| part == "..")
}

/// Walk wasm sections and return the contents of the named custom section
/// as a UTF-8 string, if present. Tolerant of binary corruption — returns
/// `None` rather than erroring so `info` is always best-effort.
fn find_custom_section(wasm: &[u8], target_name: &str) -> Option<String> {
    if wasm.len() < 8 || &wasm[..4] != b"\0asm" {
        return None;
    }
    let mut parser = wasmparser::Parser::new(0);
    let mut buf = wasm;
    loop {
        match parser.parse(buf, true) {
            Ok(wasmparser::Chunk::NeedMoreData(_)) => return None,
            Ok(wasmparser::Chunk::Parsed { consumed, payload }) => {
                buf = &buf[consumed..];
                match payload {
                    wasmparser::Payload::CustomSection(reader) if reader.name() == target_name => {
                        return Some(String::from_utf8_lossy(reader.data()).into_owned());
                    }
                    wasmparser::Payload::End(_) => return None,
                    _ => {}
                }
            }
            Err(_) => return None,
        }
    }
}

/// Compact human report — default mode. Shows the manifest summary, a
/// one-line file/size rollup, and a one-line signature verdict. Designed
/// to fit in a terminal-height paging buffer for the common case.
fn print_compact(report: &InfoReport) {
    println!(
        "{}: {}",
        report.input_kind.title(),
        style::bold(report.path.display().to_string())
    );
    println!(
        "Size:   {} bytes  ({} files, {} bytes inside)",
        report.size_bytes,
        report.files.len(),
        report.total_entry_bytes()
    );
    println!();
    print_manifest_summary(&report.manifest);
    if let Some(ver) = &report.wasm_api_version {
        println!();
        println!("WASM contract: cognia:api-version = {}", style::bold(ver));
    }
    println!();
    print_signature_line(&report.signature);
}

/// Detailed human report — `--detailed`. Adds the full comfy-table file
/// list and the multi-line signature breakdown.
fn print_detailed(report: &InfoReport) {
    print_compact(report);
    println!();
    println!("Files:");
    let mut t = Table::new();
    t.load_style(UTF8_FULL)
        .set_content_arrangement(ContentArrangement::Dynamic)
        .set_header(["Path", "Size (bytes)"]);
    for f in &report.files {
        t.add_row([f.name.as_str(), &f.size_bytes.to_string()]);
    }
    println!("{t}");
    println!();
    print_signature_block(&report.signature);
}

fn print_manifest_summary(m: &serde_json::Value) {
    println!("Manifest");
    println!(
        "  id:          {}",
        style::bold(m.get("id").and_then(|v| v.as_str()).unwrap_or("<missing>"))
    );
    println!(
        "  name:        {}",
        m.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("<missing>")
    );
    println!(
        "  version:     {}",
        m.get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("<missing>")
    );
    println!(
        "  type:        {}",
        m.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("<missing>")
    );
    if let Some(desc) = m.get("description").and_then(|v| v.as_str()) {
        println!("  description: {desc}");
    }
    if let Some(arr) = m.get("capabilities").and_then(|v| v.as_array()) {
        let caps: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        println!("  capabilities: [{}]", caps.join(", "));
    }
    if let Some(arr) = m.get("permissions").and_then(|v| v.as_array()) {
        let perms: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
        println!("  permissions:  [{}]", perms.join(", "));
    }
}

fn print_signature_line(sig: &SignatureStatus) {
    match sig {
        SignatureStatus::NotApplicable => {
            println!(
                "Signature: {} not applicable for unpacked directories",
                style::dim("·")
            );
        }
        SignatureStatus::NoSidecar => {
            println!(
                "Signature: {} unsigned (no `<bundle>.sig` next to the bundle)",
                style::dim("·")
            );
        }
        SignatureStatus::NoPublicKey => {
            println!(
                "Signature: {}{}",
                style::warn_prefix(),
                "`.sig` present but plugin.json lacks `author.publicKey`"
            );
        }
        SignatureStatus::Valid { fingerprint, .. } => {
            println!(
                "Signature: {}valid  fingerprint:{}",
                style::success_prefix(),
                style::dim(format!(" {fingerprint}"))
            );
        }
        SignatureStatus::Invalid { reason, .. } => {
            println!("Signature: {}INVALID — {reason}", style::error_prefix());
        }
    }
}

fn print_signature_block(sig: &SignatureStatus) {
    println!("Signature:");
    match sig {
        SignatureStatus::NotApplicable => {
            println!("  not applicable for unpacked directories");
        }
        SignatureStatus::NoSidecar => {
            println!("  no `<bundle>.sig` next to the bundle (unsigned)");
        }
        SignatureStatus::NoPublicKey => {
            println!(
                "  {}`.sig` present but plugin.json lacks `author.publicKey`",
                style::warn_prefix()
            );
            println!(
                "  {}cognia plugin verify --public-key <base64>",
                style::hint_prefix()
            );
        }
        SignatureStatus::Valid {
            public_key,
            fingerprint,
        } => {
            println!("  {}{}", style::success_prefix(), style::ok("valid"));
            println!("  public key:  {public_key}");
            println!("  fingerprint: {}", style::dim(fingerprint));
        }
        SignatureStatus::Invalid { reason, public_key } => {
            println!(
                "  {}{} — {reason}",
                style::error_prefix(),
                style::error("INVALID")
            );
            if let Some(pk) = public_key {
                println!("  manifest public key was: {pk}");
            }
            println!(
                "  {}re-sign the bundle with the matching private key, or pass --public-key explicitly",
                style::hint_prefix()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::signing::{sign_bundle, Keypair};
    use std::io::Write;
    use tempfile::tempdir;

    fn make_bundle(manifest: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            w.start_file("plugin.json", opts).unwrap();
            w.write_all(manifest.as_bytes()).unwrap();
            for (name, bytes) in extra {
                w.start_file(*name, opts).unwrap();
                w.write_all(bytes).unwrap();
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn inspect_reads_manifest_and_files() {
        let manifest = r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"dist/index.js"}"#;
        let bundle = make_bundle(manifest, &[("dist/index.js", b"console.log(1)")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        assert_eq!(report.manifest["id"], serde_json::Value::String("x".into()));
        assert!(report.files.iter().any(|f| f.name == "dist/index.js"));
        assert!(matches!(report.signature, SignatureStatus::NoSidecar));
        assert!(report.wasm_api_version.is_none());
    }

    #[test]
    fn inspect_path_reads_directory_manifest_and_files() {
        let tmp = tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("dist")).unwrap();
        std::fs::write(
            tmp.path().join("plugin.json"),
            r#"{"id":"local","name":"Local","version":"0.1.0","type":"frontend","main":"dist/index.js"}"#,
        )
        .unwrap();
        std::fs::write(tmp.path().join("dist").join("index.js"), b"console.log(1)").unwrap();

        let report = inspect_path(tmp.path()).unwrap();

        assert_eq!(report.input_kind, InfoInputKind::Directory);
        assert_eq!(
            report.manifest["id"],
            serde_json::Value::String("local".into())
        );
        assert!(report.files.iter().any(|f| f.name == "plugin.json"));
        assert!(report.files.iter().any(|f| f.name == "dist/index.js"));
        assert!(matches!(report.signature, SignatureStatus::NotApplicable));
    }

    #[test]
    fn inspect_reports_valid_signature_when_present() {
        let kp = Keypair::generate();
        let manifest = format!(
            r#"{{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js","author":{{"publicKey":"{}"}}}}"#,
            kp.public_base64()
        );
        let bundle = make_bundle(&manifest, &[("d.js", b"x")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let sig = sign_bundle(&kp.signing_key, &bundle);
        std::fs::write(tmp.path().join("p.zip.sig"), &sig).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        match report.signature {
            SignatureStatus::Valid {
                public_key,
                fingerprint,
            } => {
                assert_eq!(public_key, kp.public_base64());
                assert_eq!(fingerprint.len(), 64);
            }
            other => panic!("expected Valid, got {other:?}"),
        }
    }

    #[test]
    fn inspect_reports_invalid_signature_when_tampered() {
        let kp = Keypair::generate();
        let manifest = format!(
            r#"{{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js","author":{{"publicKey":"{}"}}}}"#,
            kp.public_base64()
        );
        let bundle = make_bundle(&manifest, &[("d.js", b"x")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        // Sign different bytes — produces a sig that won't validate.
        let bad_sig = sign_bundle(&kp.signing_key, b"different");
        std::fs::write(tmp.path().join("p.zip.sig"), &bad_sig).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        assert!(matches!(report.signature, SignatureStatus::Invalid { .. }));
    }

    #[test]
    fn inspect_reports_no_public_key_when_manifest_lacks_one() {
        let manifest = r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#;
        let bundle = make_bundle(manifest, &[("d.js", b"x")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        std::fs::write(tmp.path().join("p.zip.sig"), "sig").unwrap();
        let report = inspect(&path, &bundle).unwrap();
        assert!(matches!(report.signature, SignatureStatus::NoPublicKey));
    }

    #[test]
    fn inspect_extracts_wasm_api_version_when_present() {
        let manifest = r#"{"id":"hw","name":"HW","version":"0.1.0","type":"wasm","capabilities":["tools"],"wasmMain":"hw.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        // Minimal wasm + embed via the packaging helper.
        let min_wasm = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let patched = crate::engine::packaging::embed_api_version(&min_wasm, "0.1.0").unwrap();
        let bundle = make_bundle(manifest, &[("hw.wasm", &patched)]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        assert_eq!(report.wasm_api_version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn inspect_directory_does_not_read_wasm_main_outside_plugin_root() {
        let parent = tempdir().unwrap();
        let plugin_dir = parent.path().join("plugin");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        let min_wasm = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let outside = crate::engine::packaging::embed_api_version(&min_wasm, "9.9.9").unwrap();
        std::fs::write(parent.path().join("outside.wasm"), outside).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{"id":"escape","name":"Escape","version":"0.1.0","type":"wasm","capabilities":["tools"],"wasmMain":"../outside.wasm","wasm":{"apiVersion":"0.1.0"}}"#,
        )
        .unwrap();

        let report = inspect_path(&plugin_dir).unwrap();

        assert_eq!(report.wasm_api_version, None);
        assert!(!report.files.iter().any(|f| f.name.contains("outside.wasm")));
    }

    #[test]
    fn inspect_errors_when_plugin_json_missing() {
        let bundle = {
            let mut buf = Vec::new();
            {
                let cursor = std::io::Cursor::new(&mut buf);
                let mut w = zip::ZipWriter::new(cursor);
                w.start_file::<_, ()>("other.txt", zip::write::SimpleFileOptions::default())
                    .unwrap();
                w.write_all(b"x").unwrap();
                w.finish().unwrap();
            }
            buf
        };
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let err = inspect(&path, &bundle).unwrap_err();
        assert!(err.to_string().contains("plugin.json"));
    }

    #[test]
    fn sig_path_for_appends_sig_suffix() {
        let p = sig_path_for(Path::new("/tmp/hello-0.1.0.zip"));
        let s = p.to_string_lossy().to_string();
        // Tolerant of \ vs / so the assertion passes on both Windows and unix.
        let normalized = s.replace('\\', "/");
        assert_eq!(normalized, "/tmp/hello-0.1.0.zip.sig");
    }

    #[test]
    fn find_custom_section_returns_none_on_non_wasm() {
        assert!(find_custom_section(b"not wasm at all", "cognia:api-version").is_none());
    }

    #[test]
    fn json_payload_carries_schema_version_and_signature_status() {
        let manifest = r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#;
        let bundle = make_bundle(manifest, &[("d.js", b"x")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        let payload = report.to_json_payload();
        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"schemaVersion\":1"), "got: {s}");
        // No `.sig` file beside the bundle → status "no-sidecar".
        assert!(s.contains("\"status\":\"no-sidecar\""), "got: {s}");
        assert!(s.contains("\"sizeBytes\""), "got: {s}");
    }

    #[test]
    fn json_payload_emits_valid_signature_block() {
        let kp = Keypair::generate();
        let manifest = format!(
            r#"{{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js","author":{{"publicKey":"{}"}}}}"#,
            kp.public_base64()
        );
        let bundle = make_bundle(&manifest, &[("d.js", b"x")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let sig = sign_bundle(&kp.signing_key, &bundle);
        std::fs::write(tmp.path().join("p.zip.sig"), &sig).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        let payload = report.to_json_payload();
        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"status\":\"valid\""), "got: {s}");
        assert!(s.contains("\"publicKey\""), "got: {s}");
        assert!(s.contains("\"fingerprint\""), "got: {s}");
    }

    #[test]
    fn json_payload_emits_invalid_signature_block_with_reason() {
        let kp = Keypair::generate();
        let manifest = format!(
            r#"{{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js","author":{{"publicKey":"{}"}}}}"#,
            kp.public_base64()
        );
        let bundle = make_bundle(&manifest, &[("d.js", b"x")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let bad_sig = sign_bundle(&kp.signing_key, b"different");
        std::fs::write(tmp.path().join("p.zip.sig"), &bad_sig).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        let payload = report.to_json_payload();
        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"status\":\"invalid\""), "got: {s}");
        assert!(s.contains("\"reason\""), "got: {s}");
        // `info` must not report ok:true for a bundle it just proved tampered —
        // otherwise `info --json | jq -e .ok` passes for an invalid signature.
        assert!(!payload.ok, "invalid signature must flip ok to false: {s}");
    }

    #[test]
    fn total_entry_bytes_sums_file_sizes() {
        let manifest = r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#;
        let bundle = make_bundle(manifest, &[("a.js", b"1234"), ("b.js", b"56")]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        // plugin.json (manifest len) + 4 + 2.
        let m_size = manifest.as_bytes().len() as u64;
        assert_eq!(report.total_entry_bytes(), m_size + 4 + 2);
    }
}
