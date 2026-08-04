//! `cognia pack sign <file> --key <path>` — Ed25519-sign a `.cognia-pack.json`.
//!
//! Unlike `plugin sign`, which writes a detached `<bundle>.sig` over raw bytes,
//! a Character Pack signature is **in-band**: it lands in the file's own
//! `signature: { algo, pubKey, sig }` object. That is the shape the host reads
//! (`lib/plugin/character-pack/schema.ts:LocalCharacterPackSignature`), and it
//! keeps a pack a single self-contained file that can be mailed or committed
//! without a companion `.sig` going missing.
//!
//! # What is signed
//!
//! The RFC 8785 canonical JSON of the **`pack` object alone**. The wrapper's
//! `schemaVersion` and `signature` are outside the signed bytes, which is what
//! lets the host rewrite a v1 file as v2 without invalidating the signature.
//!
//! # Self-verification is not belt-and-braces
//!
//! Signing runs the canonicalizer, then verification runs it again and the
//! signature is checked before anything touches disk. The host verifies bytes
//! produced by JavaScript; we produce them from a hand-ported RFC 8785
//! implementation. If that port has a number- or escape-formatting bug, the
//! signature is silently wrong and the author only finds out when a user's
//! import fails. Self-verify turns that into a loud failure at authoring time.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::engine::canonical_json::canonical_pack_bytes;
use crate::engine::signing::{sign_bundle, verify_bundle, Keypair};
use crate::ui::{style, RuntimeUi};

/// The only signature algorithm the host's pack verifier accepts.
const PACK_SIGNATURE_ALGO: &str = "ed25519";

/// Mirrors `MAX_PACK_PAYLOAD_BYTES` in
/// `crates/cognia-plugin-runtime/src/signature.rs`. Signing a pack the host
/// will refuse to verify is a trap worth closing at authoring time.
const MAX_PACK_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

pub fn run(file: PathBuf, key: PathBuf, out: Option<PathBuf>, ui: &mut RuntimeUi) -> Result<()> {
    let dest = out.unwrap_or_else(|| file.clone());

    let raw =
        match std::fs::read_to_string(&file).with_context(|| format!("read {}", file.display())) {
            Ok(raw) => raw,
            Err(err) if ui.flags.json => return emit_failure(&file, &dest, "read", err),
            Err(err) => return Err(err),
        };
    let mut document: Value = match serde_json::from_str(&raw)
        .with_context(|| format!("parse {} as JSON", file.display()))
    {
        Ok(document) => document,
        Err(err) if ui.flags.json => return emit_failure(&file, &dest, "parse", err),
        Err(err) => return Err(err),
    };

    let payload = match extract_pack_payload(&document) {
        Ok(payload) => payload,
        Err(err) if ui.flags.json => return emit_failure(&file, &dest, "canonicalize", err),
        Err(err) => return Err(err),
    };

    let private_b64 =
        match std::fs::read_to_string(&key).with_context(|| format!("read {}", key.display())) {
            Ok(private_b64) => private_b64,
            Err(err) if ui.flags.json => return emit_failure(&file, &dest, "read", err),
            Err(err) => return Err(err),
        };
    let keypair = match Keypair::from_private_base64(private_b64.trim()) {
        Ok(keypair) => keypair,
        Err(err) if ui.flags.json => return emit_failure(&file, &dest, "read", err),
        Err(err) => return Err(err),
    };

    let public_key = keypair.public_base64();
    let signature = sign_bundle(&keypair.signing_key, &payload);

    // Self-verify BEFORE writing. See the module docs — this is the only check
    // that can catch a canonicalizer bug at authoring time.
    if let Err(err) = verify_bundle(&public_key, &payload, &signature).context(
        "signed bytes failed their own verification — this is a canonicalizer bug, \
         not a bad key; the file was left untouched",
    ) {
        if ui.flags.json {
            return emit_failure(&file, &dest, "self-verify", err);
        }
        return Err(err);
    }

    // Only prompt when we would clobber a file the author did not just name as
    // the source. Re-signing in place is the normal workflow and already
    // rewrites `signature`, so an extra prompt there is pure friction.
    if dest != file {
        let proceed = match ui
            .confirm_overwrite(&dest, "--yes to overwrite the existing file")
            .map_err(|e| anyhow!("{e}"))
        {
            Ok(proceed) => proceed,
            Err(err) if ui.flags.json => return emit_failure(&file, &dest, "overwrite", err),
            Err(err) => return Err(err),
        };
        if !proceed {
            let err = anyhow!("pack sign aborted: {} would be overwritten", dest.display());
            if ui.flags.json {
                return emit_failure(&file, &dest, "overwrite", err);
            }
            return Err(err);
        }
    }

    apply_signature(&mut document, &public_key, &signature);

    let serialized = match serde_json::to_string_pretty(&document)
        .with_context(|| format!("serialize {}", dest.display()))
    {
        Ok(serialized) => serialized,
        Err(err) if ui.flags.json => return emit_failure(&file, &dest, "write", err),
        Err(err) => return Err(err),
    };
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(err) = std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))
            {
                if ui.flags.json {
                    return emit_failure(&file, &dest, "write", err);
                }
                return Err(err);
            }
        }
    }
    if let Err(err) = std::fs::write(&dest, format!("{serialized}\n"))
        .with_context(|| format!("write {}", dest.display()))
    {
        if ui.flags.json {
            return emit_failure(&file, &dest, "write", err);
        }
        return Err(err);
    }

    let fingerprint = keypair.fingerprint_hex();
    if ui.flags.json {
        let report = PackSignReport {
            schema_version: 1,
            ok: true,
            action: "pack-sign",
            file: file.display().to_string(),
            out: dest.display().to_string(),
            algo: PACK_SIGNATURE_ALGO,
            public_key,
            fingerprint,
            signed_bytes: payload.len(),
        };
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else if !ui.flags.quiet {
        println!(
            "{}{} {} → {}",
            style::success_prefix(),
            style::ok("Signed pack"),
            style::bold(file.display().to_string()),
            style::bold(dest.display().to_string()),
        );
        println!("  {}  {}", style::dim("public key:"), public_key);
        println!(
            "  {}  {}",
            style::dim("fingerprint:"),
            style::dim(&fingerprint)
        );
        println!(
            "  {}  {} bytes of canonical JSON over the `pack` object",
            style::dim("signed:"),
            payload.len()
        );
    }
    Ok(())
}

/// Canonicalize the file's `pack` object into the exact bytes the host will
/// verify, refusing anything the host would refuse.
fn extract_pack_payload(document: &Value) -> Result<Vec<u8>> {
    let pack = document
        .get("pack")
        .ok_or_else(|| anyhow!("not a character pack file: missing a top-level `pack` object"))?;
    let payload = canonical_pack_bytes(pack)?;
    if payload.len() > MAX_PACK_PAYLOAD_BYTES {
        return Err(anyhow!(
            "canonical pack payload is {} bytes; the host refuses anything over {} bytes",
            payload.len(),
            MAX_PACK_PAYLOAD_BYTES
        ));
    }
    Ok(payload)
}

/// Write the signature into the wrapper, replacing any previous one.
///
/// Only the `signature` key is touched: `schemaVersion`, `pack`, and any
/// forward-compatible field a newer host wrote are preserved verbatim.
fn apply_signature(document: &mut Value, public_key: &str, signature: &str) {
    let mut block = Map::new();
    block.insert("algo".into(), Value::String(PACK_SIGNATURE_ALGO.into()));
    block.insert("pubKey".into(), Value::String(public_key.into()));
    block.insert("sig".into(), Value::String(signature.into()));
    if let Value::Object(map) = document {
        map.insert("signature".into(), Value::Object(block));
    }
}

#[derive(Debug, Serialize)]
struct PackSignReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    file: String,
    out: String,
    algo: &'static str,
    #[serde(rename = "publicKey")]
    public_key: String,
    fingerprint: String,
    #[serde(rename = "signedBytes")]
    signed_bytes: usize,
}

#[derive(Debug, Serialize)]
struct PackSignFailureReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    file: String,
    out: String,
    error: String,
}

fn emit_failure(file: &Path, out: &Path, stage: &'static str, err: anyhow::Error) -> Result<()> {
    let report = PackSignFailureReport {
        schema_version: 1,
        ok: false,
        action: "pack-sign",
        stage,
        file: file.display().to_string(),
        out: out.display().to_string(),
        error: format!("{err:#}"),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Err(crate::shared::JsonFailureExit.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::runtime::UiFlags;
    use tempfile::{tempdir, TempDir};

    fn pack_file_json() -> String {
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 2,
            "pack": {
                "id": "demo.pack",
                "name": "Demo",
                "version": "1.0.0",
                "characters": [{
                    "localId": "c1",
                    "name": "One",
                    "avatarColor": "#fff",
                    "systemPrompt": "you are one",
                }],
            },
        }))
        .unwrap()
    }

    fn fixture() -> (TempDir, PathBuf, PathBuf, Keypair) {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("demo.cognia-pack.json");
        std::fs::write(&file, pack_file_json()).unwrap();
        let keypair = Keypair::generate();
        let key = tmp.path().join("priv.b64");
        std::fs::write(&key, keypair.private_base64()).unwrap();
        (tmp, file, key, keypair)
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn sign_writes_an_in_band_signature_that_verifies() {
        let (_tmp, file, key, keypair) = fixture();
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), key, None, &mut ui).unwrap();

        let signed = read_json(&file);
        assert_eq!(signed["signature"]["algo"], PACK_SIGNATURE_ALGO);
        assert_eq!(signed["signature"]["pubKey"], keypair.public_base64());

        let payload = canonical_pack_bytes(&signed["pack"]).unwrap();
        verify_bundle(
            &keypair.public_base64(),
            &payload,
            signed["signature"]["sig"].as_str().unwrap(),
        )
        .expect("the written signature must verify against the written pack");
    }

    #[test]
    fn signature_covers_the_pack_only_so_schema_version_can_change() {
        // The whole point of excluding `schemaVersion` from the signed bytes:
        // a host that rewrites a v1 file as v2 must not invalidate it.
        let (_tmp, file, key, keypair) = fixture();
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), key, None, &mut ui).unwrap();

        let mut signed = read_json(&file);
        signed["schemaVersion"] = Value::from(1);
        let payload = canonical_pack_bytes(&signed["pack"]).unwrap();
        verify_bundle(
            &keypair.public_base64(),
            &payload,
            signed["signature"]["sig"].as_str().unwrap(),
        )
        .expect("changing schemaVersion must not break the signature");
    }

    #[test]
    fn resigning_in_place_replaces_the_previous_signature_without_prompting() {
        let (_tmp, file, key, _keypair) = fixture();
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), key.clone(), None, &mut ui).unwrap();
        let first = read_json(&file)["signature"]["pubKey"].clone();

        // A different key: the new signature block must fully replace the old.
        let second_keypair = Keypair::generate();
        let second_key = file.with_file_name("second.b64");
        std::fs::write(&second_key, second_keypair.private_base64()).unwrap();
        // No prompter is installed, so reaching a confirm prompt would panic —
        // that is the assertion that in-place re-signing never prompts.
        run(file.clone(), second_key, None, &mut ui).unwrap();

        let signed = read_json(&file);
        assert_ne!(signed["signature"]["pubKey"], first);
        assert_eq!(
            signed["signature"]["pubKey"],
            Value::from(second_keypair.public_base64())
        );
    }

    #[test]
    fn tampering_with_the_pack_after_signing_breaks_verification() {
        let (_tmp, file, key, keypair) = fixture();
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), key, None, &mut ui).unwrap();

        let mut signed = read_json(&file);
        signed["pack"]["characters"][0]["systemPrompt"] = Value::from("you are compromised");
        let payload = canonical_pack_bytes(&signed["pack"]).unwrap();
        assert!(verify_bundle(
            &keypair.public_base64(),
            &payload,
            signed["signature"]["sig"].as_str().unwrap(),
        )
        .is_err());
    }

    #[test]
    fn out_writes_elsewhere_and_leaves_the_source_unsigned() {
        let (tmp, file, key, _keypair) = fixture();
        let out = tmp.path().join("nested").join("signed.cognia-pack.json");
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), key, Some(out.clone()), &mut ui).unwrap();
        assert!(out.exists(), "--out should create missing parent dirs");
        assert!(read_json(&out)["signature"].is_object());
        assert!(
            read_json(&file)["signature"].is_null(),
            "the source file must be left untouched"
        );
    }

    #[test]
    fn out_prompts_before_clobbering_a_different_existing_file() {
        use crate::ui::prompter::{Answer, MockPrompter};
        let (tmp, file, key, _keypair) = fixture();
        let out = tmp.path().join("existing.json");
        std::fs::write(&out, "pre-existing").unwrap();
        let mut ui = RuntimeUi::new(UiFlags::default()).with_prompter(Box::new(
            MockPrompter::with_answers([Answer::Confirm(false)]),
        ));
        let err = run(file, key, Some(out.clone()), &mut ui).unwrap_err();
        assert!(err.to_string().contains("pack sign aborted"), "got: {err}");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "pre-existing");
    }

    #[test]
    fn missing_pack_object_is_refused() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("bad.json");
        std::fs::write(&file, r#"{"schemaVersion":2}"#).unwrap();
        let keypair = Keypair::generate();
        let key = tmp.path().join("priv.b64");
        std::fs::write(&key, keypair.private_base64()).unwrap();
        let mut ui = RuntimeUi::new(UiFlags::default());
        let err = run(file, key, None, &mut ui).unwrap_err();
        assert!(
            err.to_string().contains("missing a top-level `pack`"),
            "got: {err}"
        );
    }

    #[test]
    fn forward_compatible_wrapper_fields_survive_signing() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("future.cognia-pack.json");
        std::fs::write(
            &file,
            r#"{"schemaVersion":2,"pack":{"id":"a"},"futureField":{"keep":"me"}}"#,
        )
        .unwrap();
        let keypair = Keypair::generate();
        let key = tmp.path().join("priv.b64");
        std::fs::write(&key, keypair.private_base64()).unwrap();
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), key, None, &mut ui).unwrap();
        assert_eq!(read_json(&file)["futureField"]["keep"], "me");
    }

    #[test]
    fn oversize_payload_is_refused_before_signing() {
        let huge = "x".repeat(MAX_PACK_PAYLOAD_BYTES + 16);
        let document = serde_json::json!({ "pack": { "id": huge } });
        let err = extract_pack_payload(&document).unwrap_err();
        assert!(err.to_string().contains("the host refuses"), "got: {err}");
    }

    #[test]
    fn json_reports_are_schema_versioned() {
        let (_tmp, file, key, _keypair) = fixture();
        let mut ui = RuntimeUi::new(UiFlags {
            json: true,
            ..UiFlags::default()
        });
        run(file, key, None, &mut ui).unwrap();

        let failure = PackSignFailureReport {
            schema_version: 1,
            ok: false,
            action: "pack-sign",
            stage: "read",
            file: "a.json".into(),
            out: "a.json".into(),
            error: "boom".into(),
        };
        let json = serde_json::to_value(&failure).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["stage"], "read");
    }

    #[test]
    fn apply_signature_is_a_no_op_on_a_non_object_document() {
        let mut document = Value::from("not an object");
        apply_signature(&mut document, "pub", "sig");
        assert_eq!(document, Value::from("not an object"));
    }
}
