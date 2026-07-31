//! `cognia plugin verify <bundle>` — verify `<bundle>.sig` against the
//! manifest's author public key (or an explicit one).

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;

use crate::engine::signing::{fingerprint, verify_bundle};
use crate::ui::{style, RuntimeUi};

/// `cognia plugin verify` — verify a bundle's `.sig` against the embedded
/// (or supplied) public key. Phase 2 paints the verdict and emits a
/// machine-readable JSON payload under `--json`.
pub fn run(
    bundle: PathBuf,
    public_key: Option<String>,
    signature: Option<PathBuf>,
    json: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let sig_path = signature.unwrap_or_else(|| {
        let mut p = bundle.clone();
        let n = format!(
            "{}.sig",
            p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        p.set_file_name(n);
        p
    });
    let bundle_bytes = match std::fs::read(&bundle) {
        Ok(bytes) => bytes,
        Err(err) if json => {
            return emit_json_failure(
                &bundle,
                &sig_path,
                "bundle",
                None,
                format!("read {}: {err}", bundle.display()),
            );
        }
        Err(err) => return Err(err).with_context(|| format!("read {}", bundle.display())),
    };

    let pk_b64 = match public_key {
        Some(s) => s,
        None => match extract_public_key_from_bundle(&bundle_bytes) {
            Ok(public_key) => public_key,
            Err(err) if json => {
                return emit_json_failure(&bundle, &sig_path, "public-key", None, err.to_string());
            }
            Err(err) => return Err(err),
        },
    };
    let fp = match public_key_fingerprint(&pk_b64) {
        Ok(fingerprint) => fingerprint,
        Err(err) if json => {
            return emit_json_failure(
                &bundle,
                &sig_path,
                "public-key",
                Some(pk_b64),
                err.to_string(),
            );
        }
        Err(err) => return Err(err),
    };
    let sig_str = match std::fs::read_to_string(&sig_path) {
        Ok(signature) => signature,
        Err(err) if json => {
            return emit_json_failure(
                &bundle,
                &sig_path,
                "signature",
                Some(pk_b64.clone()),
                format!("read {}: {err}", sig_path.display()),
            );
        }
        Err(err) => return Err(err).with_context(|| format!("read {}", sig_path.display())),
    };

    let verify_outcome = verify_bundle(&pk_b64, &bundle_bytes, sig_str.trim());

    match verify_outcome {
        Ok(()) => {
            if json {
                let payload = VerifyJsonPayload {
                    schema_version: 1,
                    ok: true,
                    action: "verify",
                    stage: None,
                    bundle: bundle.display().to_string(),
                    signature: sig_path.display().to_string(),
                    public_key: pk_b64.clone(),
                    fingerprint: fp.clone(),
                    error: None,
                };
                println!("{}", serde_json::to_string_pretty(&payload)?);
            } else if !ui.flags.quiet {
                println!(
                    "{}{}",
                    style::success_prefix(),
                    style::ok("signature valid")
                );
                println!("  bundle:      {}", bundle.display());
                println!("  signature:   {}", sig_path.display());
                println!("  public key:  {pk_b64}");
                println!("  fingerprint: {}", style::dim(&fp));
            }
            Ok(())
        }
        Err(e) => {
            if json {
                let payload = VerifyJsonPayload {
                    schema_version: 1,
                    ok: false,
                    action: "verify",
                    stage: Some(classify_verify_failure(&e)),
                    bundle: bundle.display().to_string(),
                    signature: sig_path.display().to_string(),
                    public_key: pk_b64.clone(),
                    fingerprint: fp.clone(),
                    error: Some(e.to_string()),
                };
                println!("{}", serde_json::to_string_pretty(&payload)?);
                // Still error out so the exit code distinguishes pass/fail
                // for scripts that don't parse the JSON.
                return Err(crate::shared::JsonFailureExit.into());
            }
            // Wrap with an actionable hint so plain-text consumers get a
            // helpful suggestion line under the cause chain.
            Err(e.context(
                "re-sign the bundle with the matching private key, or pass --public-key explicitly",
            ))
        }
    }
}

#[derive(Debug, Serialize)]
struct VerifyJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'static str>,
    bundle: String,
    signature: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_json_failure(
    bundle: &PathBuf,
    signature: &PathBuf,
    stage: &'static str,
    public_key: Option<String>,
    error: String,
) -> Result<()> {
    let fingerprint = json_failure_fingerprint(public_key.as_deref());
    let payload = VerifyJsonPayload {
        schema_version: 1,
        ok: false,
        action: "verify",
        stage: Some(stage),
        bundle: bundle.display().to_string(),
        signature: signature.display().to_string(),
        public_key: public_key.unwrap_or_default(),
        fingerprint,
        error: Some(error),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

fn public_key_fingerprint(public_key: &str) -> Result<String> {
    let bytes = crate::shared::b64_decode(public_key)?;
    if bytes.len() != 32 {
        return Err(anyhow!("public key must be 32 bytes (got {})", bytes.len()));
    }
    Ok(fingerprint(&bytes))
}

fn json_failure_fingerprint(public_key: Option<&str>) -> String {
    let Some(public_key) = public_key else {
        return "<unavailable>".into();
    };
    match crate::shared::b64_decode(public_key) {
        Ok(bytes) if bytes.len() == 32 => fingerprint(&bytes),
        Ok(_) => "<invalid public key>".into(),
        Err(_) => "<invalid base64>".into(),
    }
}

fn classify_verify_failure(err: &anyhow::Error) -> &'static str {
    let message = err.to_string();
    if message.contains("public key") || message.contains("invalid public key") {
        "public-key"
    } else if message.contains("signature must be") || message.contains("decode base64") {
        "signature"
    } else {
        "verify"
    }
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
    use crate::engine::signing::{sign_bundle, Keypair};
    use std::io::Write;
    use tempfile::tempdir;

    fn make_bundle_with_manifest(manifest: &str) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut w = zip::ZipWriter::new(cursor);
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(bundle_path, None, None, false, &mut ui).unwrap();
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        assert!(run(bundle_path, None, None, false, &mut ui).is_err());
    }

    #[test]
    fn verify_json_emits_ok_true_for_valid_signature() {
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
        // We can't easily capture stdout here, so just confirm the path
        // doesn't error out and the helper that serializes the payload
        // produces the expected shape.
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(bundle_path, None, None, true, &mut ui).unwrap();
        // Sanity: VerifyJsonPayload Serialize roundtrip.
        let payload = VerifyJsonPayload {
            schema_version: 1,
            ok: true,
            action: "verify",
            stage: None,
            bundle: "bundle.zip".into(),
            signature: "bundle.zip.sig".into(),
            public_key: "pk".into(),
            fingerprint: "fp".into(),
            error: None,
        };
        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"schemaVersion\":1"));
        assert!(s.contains("\"ok\":true"));
        assert!(s.contains("\"action\":\"verify\""));
        assert!(!s.contains("\"error\""));
    }

    #[test]
    fn verify_json_emits_ok_false_with_error_when_invalid() {
        let payload = VerifyJsonPayload {
            schema_version: 1,
            ok: false,
            action: "verify",
            stage: Some("verify"),
            bundle: "b.zip".into(),
            signature: "b.zip.sig".into(),
            public_key: "pk".into(),
            fingerprint: "fp".into(),
            error: Some("signature did not verify".into()),
        };
        let s = serde_json::to_string(&payload).unwrap();
        assert!(s.contains("\"ok\":false"));
        assert!(s.contains("signature did not verify"));
    }

    #[test]
    fn verify_errors_when_no_public_key_anywhere() {
        let kp = Keypair::generate();
        let manifest =
            r#"{"id":"x","type":"wasm","wasmMain":"main.wasm","wasm":{"apiVersion":"0.1.0"}}"#;
        let bundle = make_bundle_with_manifest(manifest);
        let sig = sign_bundle(&kp.signing_key, &bundle);
        let tmp = tempdir().unwrap();
        let bundle_path = tmp.path().join("p.zip");
        let sig_path = tmp.path().join("p.zip.sig");
        std::fs::write(&bundle_path, &bundle).unwrap();
        std::fs::write(&sig_path, &sig).unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        let err = run(bundle_path, None, None, false, &mut ui).unwrap_err();
        assert!(err.to_string().contains("publicKey"));
    }
}
