//! `cognia plugin verify <bundle>` — verify `<bundle>.sig` against the
//! manifest's author public key (or an explicit one).

use anyhow::{anyhow, Context, Result};
use std::io::Read;
use std::path::PathBuf;

use crate::signing::{fingerprint, verify_bundle};

pub fn run(bundle: PathBuf, public_key: Option<String>, signature: Option<PathBuf>) -> Result<()> {
    let bundle_bytes =
        std::fs::read(&bundle).with_context(|| format!("read {}", bundle.display()))?;
    let sig_path = signature.unwrap_or_else(|| {
        let mut p = bundle.clone();
        let n = format!(
            "{}.sig",
            p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        );
        p.set_file_name(n);
        p
    });
    let sig_str =
        std::fs::read_to_string(&sig_path).with_context(|| format!("read {}", sig_path.display()))?;

    let pk_b64 = match public_key {
        Some(s) => s,
        None => extract_public_key_from_bundle(&bundle_bytes)?,
    };

    verify_bundle(&pk_b64, &bundle_bytes, sig_str.trim())?;
    let fp = match crate::b64_decode(&pk_b64) {
        Ok(bytes) => fingerprint(&bytes),
        Err(_) => "<invalid base64>".to_string(),
    };
    println!("✓ signature valid");
    println!("  bundle:      {}", bundle.display());
    println!("  signature:   {}", sig_path.display());
    println!("  public key:  {}", pk_b64);
    println!("  fingerprint: {fp}");
    Ok(())
}

fn extract_public_key_from_bundle(bundle: &[u8]) -> Result<String> {
    let reader = std::io::Cursor::new(bundle);
    let mut archive = zip::ZipArchive::new(reader).context("open bundle as zip")?;
    let mut entry = archive
        .by_name("plugin.json")
        .map_err(|e| anyhow!("plugin.json not found in bundle: {e}"))?;
    let mut buf = String::new();
    entry.read_to_string(&mut buf)?;
    let value: serde_json::Value = serde_json::from_str(&buf).context("parse plugin.json")?;
    value
        .get("author")
        .and_then(|a| a.get("publicKey"))
        .and_then(|p| p.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("plugin.json has no author.publicKey; pass --public-key explicitly"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::{sign_bundle, Keypair};
    use std::io::Write;
    use tempfile::tempdir;

    fn make_bundle_with_manifest(manifest: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions =
                zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            w.start_file("plugin.json", opts).unwrap();
            w.write_all(manifest.as_bytes()).unwrap();
            w.start_file("main.wasm", opts).unwrap();
            w.write_all(&[0u8; 16]).unwrap();
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn verify_succeeds_for_valid_signature_and_embedded_key() {
        let kp = Keypair::generate();
        let manifest = format!(
            r#"{{"id":"x","type":"wasm","wasmMain":"main.wasm","wasm":{{"apiVersion":"0.1.0"}},"author":{{"publicKey":"{}"}}}}"#,
            kp.public_base64()
        );
        let bundle = make_bundle_with_manifest(&manifest);
        let sig = sign_bundle(&kp.signing_key, &bundle);
        let tmp = tempdir().unwrap();
        let bundle_path = tmp.path().join("p.zip");
        let sig_path = tmp.path().join("p.zip.sig");
        std::fs::write(&bundle_path, &bundle).unwrap();
        std::fs::write(&sig_path, &sig).unwrap();
        run(bundle_path, None, None).unwrap();
    }

    #[test]
    fn verify_fails_when_signature_does_not_match() {
        let kp = Keypair::generate();
        let manifest = format!(
            r#"{{"id":"x","type":"wasm","wasmMain":"main.wasm","wasm":{{"apiVersion":"0.1.0"}},"author":{{"publicKey":"{}"}}}}"#,
            kp.public_base64()
        );
        let bundle = make_bundle_with_manifest(&manifest);
        let bad_sig = sign_bundle(&kp.signing_key, b"different");
        let tmp = tempdir().unwrap();
        let bundle_path = tmp.path().join("p.zip");
        let sig_path = tmp.path().join("p.zip.sig");
        std::fs::write(&bundle_path, &bundle).unwrap();
        std::fs::write(&sig_path, &bad_sig).unwrap();
        assert!(run(bundle_path, None, None).is_err());
    }

    #[test]
    fn verify_errors_when_no_public_key_anywhere() {
        let kp = Keypair::generate();
        let manifest = r#"{"id":"x","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let bundle = make_bundle_with_manifest(manifest);
        let sig = sign_bundle(&kp.signing_key, &bundle);
        let tmp = tempdir().unwrap();
        let bundle_path = tmp.path().join("p.zip");
        let sig_path = tmp.path().join("p.zip.sig");
        std::fs::write(&bundle_path, &bundle).unwrap();
        std::fs::write(&sig_path, &sig).unwrap();
        let err = run(bundle_path, None, None).unwrap_err();
        assert!(err.to_string().contains("publicKey"));
    }
}
