//! `cognia plugin info <bundle.zip>` — inspect a built bundle without installing.
//!
//! Prints what the host would see when offered the bundle: manifest
//! summary, declared capabilities + permissions, file list, signature
//! verification result, public-key fingerprint, and (for wasm bundles)
//! the embedded `cognia:api-version` custom section.

use anyhow::{anyhow, Context, Result};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::{
    b64_decode,
    signing::{fingerprint, verify_bundle},
};

const API_VERSION_SECTION: &str = "cognia:api-version";

pub fn run(bundle: PathBuf) -> Result<()> {
    let bundle_bytes =
        std::fs::read(&bundle).with_context(|| format!("read {}", bundle.display()))?;
    let report = inspect(&bundle, &bundle_bytes)?;
    print_human(&report);
    Ok(())
}

#[derive(Debug)]
pub struct BundleReport {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub manifest: serde_json::Value,
    pub files: Vec<EntryInfo>,
    pub signature: SignatureStatus,
    pub wasm_api_version: Option<String>,
}

#[derive(Debug)]
pub struct EntryInfo {
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug)]
pub enum SignatureStatus {
    /// No `<bundle>.sig` file on disk alongside the bundle.
    NoSidecar,
    /// `.sig` present but the bundle declares no `author.publicKey`.
    NoPublicKey,
    /// `.sig` present and verification passed.
    Valid { public_key: String, fingerprint: String },
    /// `.sig` present but verification failed (mismatch / corrupt).
    Invalid { reason: String, public_key: Option<String> },
}

pub fn inspect(bundle_path: &Path, bundle_bytes: &[u8]) -> Result<BundleReport> {
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

    Ok(BundleReport {
        path: bundle_path.to_path_buf(),
        size_bytes: bundle_bytes.len() as u64,
        manifest,
        files,
        signature,
        wasm_api_version,
    })
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
    let wasm_main = match manifest.get("wasmMain").and_then(|v| v.as_str()) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Ok(None),
    };
    let mut entry = match archive.by_name(&wasm_main) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    Ok(find_custom_section(&bytes, API_VERSION_SECTION))
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
                    wasmparser::Payload::CustomSection(reader)
                        if reader.name() == target_name =>
                    {
                        return Some(
                            String::from_utf8_lossy(reader.data()).into_owned(),
                        );
                    }
                    wasmparser::Payload::End(_) => return None,
                    _ => {}
                }
            }
            Err(_) => return None,
        }
    }
}

fn print_human(report: &BundleReport) {
    println!("Bundle: {}", report.path.display());
    println!("Size:   {} bytes", report.size_bytes);
    println!();

    let m = &report.manifest;
    println!("Manifest");
    println!("  id:          {}", m.get("id").and_then(|v| v.as_str()).unwrap_or("<missing>"));
    println!("  name:        {}", m.get("name").and_then(|v| v.as_str()).unwrap_or("<missing>"));
    println!("  version:     {}", m.get("version").and_then(|v| v.as_str()).unwrap_or("<missing>"));
    println!("  type:        {}", m.get("type").and_then(|v| v.as_str()).unwrap_or("<missing>"));
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
    println!();

    if let Some(ver) = &report.wasm_api_version {
        println!("WASM contract: cognia:api-version = {ver}");
        println!();
    }

    println!("Files ({}):", report.files.len());
    for f in &report.files {
        println!("  {:>10} bytes  {}", f.size_bytes, f.name);
    }
    println!();

    println!("Signature:");
    match &report.signature {
        SignatureStatus::NoSidecar => {
            println!("  no `<bundle>.sig` next to the bundle (unsigned)");
        }
        SignatureStatus::NoPublicKey => {
            println!("  `.sig` present but plugin.json lacks `author.publicKey`");
            println!("  → cannot verify; pass --public-key explicitly to `cognia plugin verify`");
        }
        SignatureStatus::Valid { public_key, fingerprint } => {
            println!("  ✓ valid");
            println!("  public key:  {public_key}");
            println!("  fingerprint: {fingerprint}");
        }
        SignatureStatus::Invalid { reason, public_key } => {
            println!("  ✗ INVALID — {reason}");
            if let Some(pk) = public_key {
                println!("  manifest public key was: {pk}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::{sign_bundle, Keypair};
    use std::io::Write;
    use tempfile::tempdir;

    fn make_bundle(manifest: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions =
                zip::write::SimpleFileOptions::default()
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
        let manifest =
            r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"dist/index.js"}"#;
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
            SignatureStatus::Valid { public_key, fingerprint } => {
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
        let manifest =
            r#"{"id":"x","name":"X","version":"0.1.0","type":"frontend","capabilities":["tools"],"main":"d.js"}"#;
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
        let manifest =
            r#"{"id":"hw","name":"HW","version":"0.1.0","type":"wasm","capabilities":["tools"],"wasmMain":"hw.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        // Minimal wasm + embed via the packaging helper.
        let min_wasm = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        let patched = crate::packaging::embed_api_version(&min_wasm, "0.1.0").unwrap();
        let bundle = make_bundle(manifest, &[("hw.wasm", &patched)]);
        let tmp = tempdir().unwrap();
        let path = tmp.path().join("p.zip");
        std::fs::write(&path, &bundle).unwrap();
        let report = inspect(&path, &bundle).unwrap();
        assert_eq!(report.wasm_api_version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn inspect_errors_when_plugin_json_missing() {
        let bundle = {
            let mut buf = Vec::new();
            {
                let cursor = std::io::Cursor::new(&mut buf);
                let mut w = zip::ZipWriter::new(cursor);
                w.start_file::<_, ()>(
                    "other.txt",
                    zip::write::SimpleFileOptions::default(),
                )
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
}
