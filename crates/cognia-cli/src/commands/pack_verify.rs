//! `cognia pack verify <file>` — check a `.cognia-pack.json`'s in-band signature.
//!
//! This is the author-side twin of the host's verification path
//! (`lib/plugin/character-pack/pack-trust.ts` →
//! `crates/cognia-plugin-runtime/src/signature.rs`). Running it before shipping
//! a pack answers the only question that matters: *will the host show this as
//! verified?*
//!
//! # Three outcomes, not two
//!
//! The host's trust model has exactly two states — `verified` and `unsigned` —
//! because an invalid signed pack never reaches the registry at all. The CLI
//! therefore reports three things:
//!
//!   * **verified** — signature checks out. Exit 0.
//!   * **unsigned** — no `signature` block. Exit 0: this is a legitimate,
//!     supported state that the host accepts and visibly labels. Use
//!     `--require-signature` in CI to make it an error.
//!   * **invalid** — a signature is present and does not check out. Exit
//!     non-zero, always. The host would refuse the import outright.
//!
//! Conflating "unsigned" with "invalid" would either make every unsigned pack
//! look compromised or make a tampered pack look merely unsigned. Neither is
//! true, so they stay distinct.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::engine::canonical_json::canonical_pack_bytes;
use crate::engine::signing::{fingerprint, verify_bundle};
use crate::shared::b64_decode;
use crate::ui::{style, RuntimeUi};

const PACK_SIGNATURE_ALGO: &str = "ed25519";

/// Mirrors `MAX_PACK_PAYLOAD_BYTES` in the host's `signature.rs`.
const MAX_PACK_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;

/// What the host would conclude about this file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Verified,
    Unsigned,
    Invalid,
}

impl Verdict {
    fn as_str(self) -> &'static str {
        match self {
            Verdict::Verified => "verified",
            Verdict::Unsigned => "unsigned",
            Verdict::Invalid => "invalid",
        }
    }
}

pub fn run(
    file: PathBuf,
    public_key: Option<String>,
    require_signature: bool,
    ui: &mut RuntimeUi,
) -> Result<()> {
    let raw =
        match std::fs::read_to_string(&file).with_context(|| format!("read {}", file.display())) {
            Ok(raw) => raw,
            Err(err) if ui.flags.json => return emit_failure(&file, "read", err),
            Err(err) => return Err(err),
        };
    let document: Value = match serde_json::from_str(&raw)
        .with_context(|| format!("parse {} as JSON", file.display()))
    {
        Ok(document) => document,
        Err(err) if ui.flags.json => return emit_failure(&file, "parse", err),
        Err(err) => return Err(err),
    };

    let Some(pack) = document.get("pack") else {
        let err = anyhow!("not a character pack file: missing a top-level `pack` object");
        if ui.flags.json {
            return emit_failure(&file, "parse", err);
        }
        return Err(err);
    };

    let outcome = match evaluate(pack, document.get("signature"), public_key.as_deref()) {
        Ok(outcome) => outcome,
        Err(err) if ui.flags.json => return emit_failure(&file, "verify", err),
        Err(err) => return Err(err),
    };

    report(&file, &outcome, ui)?;

    match outcome.verdict {
        Verdict::Invalid => fail(&file, &outcome, ui),
        Verdict::Unsigned if require_signature => {
            let err = anyhow!(
                "{} carries no signature and --require-signature was set",
                file.display()
            );
            if ui.flags.json {
                // The report above already printed the verdict; this only sets
                // the exit code.
                return Err(crate::shared::JsonFailureExit.into());
            }
            Err(err)
        }
        _ => Ok(()),
    }
}

struct Outcome {
    verdict: Verdict,
    pack_id: Option<String>,
    pack_version: Option<String>,
    public_key: Option<String>,
    fingerprint: Option<String>,
    signed_bytes: usize,
    reason: Option<String>,
}

/// Decide the verdict without touching the filesystem or the terminal.
///
/// Every recoverable problem — wrong algo, malformed base64, bad signature —
/// resolves to [`Verdict::Invalid`] with a reason rather than an `Err`, so the
/// caller has one branch for "the host would reject this" and `Err` is reserved
/// for "we could not even ask the question".
fn evaluate(
    pack: &Value,
    signature: Option<&Value>,
    public_key_override: Option<&str>,
) -> Result<Outcome> {
    let payload = canonical_pack_bytes(pack)?;
    let pack_id = pack.get("id").and_then(Value::as_str).map(str::to_string);
    let pack_version = pack
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string);

    let base = Outcome {
        verdict: Verdict::Unsigned,
        pack_id,
        pack_version,
        public_key: None,
        fingerprint: None,
        signed_bytes: payload.len(),
        reason: None,
    };

    if payload.len() > MAX_PACK_PAYLOAD_BYTES {
        return Ok(Outcome {
            verdict: Verdict::Invalid,
            reason: Some(format!(
                "canonical payload is {} bytes; the host refuses anything over {}",
                payload.len(),
                MAX_PACK_PAYLOAD_BYTES
            )),
            ..base
        });
    }

    let Some(signature) = signature else {
        return Ok(base);
    };
    // `"signature": null` is how an unsigned pack round-trips through some JSON
    // writers; treat it as absent rather than malformed.
    if signature.is_null() {
        return Ok(base);
    }

    let algo = signature.get("algo").and_then(Value::as_str);
    if algo != Some(PACK_SIGNATURE_ALGO) {
        return Ok(Outcome {
            verdict: Verdict::Invalid,
            reason: Some(format!(
                "unsupported signature algo {:?}; the host only accepts {PACK_SIGNATURE_ALGO}",
                algo.unwrap_or("<missing>")
            )),
            ..base
        });
    }
    let Some(sig) = signature.get("sig").and_then(Value::as_str) else {
        return Ok(Outcome {
            verdict: Verdict::Invalid,
            reason: Some("signature block is missing a string `sig`".into()),
            ..base
        });
    };
    // An explicit --public-key answers a different question than the embedded
    // one: "is this pack signed by the key I expect?" rather than "is this pack
    // internally consistent?". A pack is trivially self-consistent, so pinning
    // the key is the only check that means anything against a hostile author.
    let embedded = signature.get("pubKey").and_then(Value::as_str);
    let Some(public_key) = public_key_override.or(embedded) else {
        return Ok(Outcome {
            verdict: Verdict::Invalid,
            reason: Some("signature block is missing a string `pubKey`".into()),
            ..base
        });
    };

    let fingerprint = match b64_decode(public_key) {
        Ok(bytes) => Some(fingerprint(&bytes)),
        Err(err) => {
            return Ok(Outcome {
                verdict: Verdict::Invalid,
                reason: Some(format!("public key is not valid base64: {err}")),
                public_key: Some(public_key.to_string()),
                ..base
            })
        }
    };

    match verify_bundle(public_key, &payload, sig) {
        Ok(()) => Ok(Outcome {
            verdict: Verdict::Verified,
            public_key: Some(public_key.to_string()),
            fingerprint,
            ..base
        }),
        Err(err) => Ok(Outcome {
            verdict: Verdict::Invalid,
            public_key: Some(public_key.to_string()),
            fingerprint,
            reason: Some(err.to_string()),
            ..base
        }),
    }
}

fn report(file: &Path, outcome: &Outcome, ui: &mut RuntimeUi) -> Result<()> {
    if ui.flags.json {
        let payload = PackVerifyReport {
            schema_version: 1,
            ok: outcome.verdict != Verdict::Invalid,
            action: "pack-verify",
            file: file.display().to_string(),
            verdict: outcome.verdict.as_str(),
            pack_id: outcome.pack_id.clone(),
            pack_version: outcome.pack_version.clone(),
            public_key: outcome.public_key.clone(),
            fingerprint: outcome.fingerprint.clone(),
            signed_bytes: outcome.signed_bytes,
            reason: outcome.reason.clone(),
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
        return Ok(());
    }
    if ui.flags.quiet {
        return Ok(());
    }

    let label = outcome
        .pack_id
        .clone()
        .unwrap_or_else(|| file.display().to_string());
    match outcome.verdict {
        Verdict::Verified => println!(
            "{}{} {}",
            style::success_prefix(),
            style::ok("Verified"),
            style::bold(&label)
        ),
        Verdict::Unsigned => println!(
            "{}{} {}",
            style::warn_prefix(),
            style::warn("Unsigned"),
            style::bold(&label)
        ),
        Verdict::Invalid => println!(
            "{}{} {}",
            style::error_prefix(),
            style::error("Invalid signature"),
            style::bold(&label)
        ),
    }
    if let Some(version) = &outcome.pack_version {
        println!("  {}  {}", style::dim("version:"), version);
    }
    if let Some(public_key) = &outcome.public_key {
        println!("  {}  {}", style::dim("public key:"), public_key);
    }
    if let Some(fingerprint) = &outcome.fingerprint {
        println!(
            "  {}  {}",
            style::dim("fingerprint:"),
            style::dim(fingerprint)
        );
    }
    println!(
        "  {}  {} bytes of canonical JSON over the `pack` object",
        style::dim("signed:"),
        outcome.signed_bytes
    );
    if let Some(reason) = &outcome.reason {
        println!("  {}  {}", style::dim("reason:"), reason);
    }
    if outcome.verdict == Verdict::Unsigned {
        println!(
            "  {}",
            style::hint("Cognia accepts unsigned packs and labels them as such. Run `cognia pack sign` to sign it.")
        );
    }
    Ok(())
}

fn fail(file: &Path, outcome: &Outcome, ui: &RuntimeUi) -> Result<()> {
    if ui.flags.json {
        return Err(crate::shared::JsonFailureExit.into());
    }
    Err(anyhow!(
        "{} has an invalid signature: {}",
        file.display(),
        outcome
            .reason
            .clone()
            .unwrap_or_else(|| "signature verification failed".into())
    ))
}

#[derive(Debug, Serialize)]
struct PackVerifyReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    file: String,
    verdict: &'static str,
    #[serde(rename = "packId", skip_serializing_if = "Option::is_none")]
    pack_id: Option<String>,
    #[serde(rename = "packVersion", skip_serializing_if = "Option::is_none")]
    pack_version: Option<String>,
    #[serde(rename = "publicKey", skip_serializing_if = "Option::is_none")]
    public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(rename = "signedBytes")]
    signed_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct PackVerifyFailureReport {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    file: String,
    error: String,
}

fn emit_failure(file: &Path, stage: &'static str, err: anyhow::Error) -> Result<()> {
    let report = PackVerifyFailureReport {
        schema_version: 1,
        ok: false,
        action: "pack-verify",
        stage,
        file: file.display().to_string(),
        error: format!("{err:#}"),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Err(crate::shared::JsonFailureExit.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::signing::{sign_bundle, Keypair};
    use crate::ui::runtime::UiFlags;
    use tempfile::tempdir;

    fn pack() -> Value {
        serde_json::json!({
            "id": "demo.pack",
            "name": "Demo",
            "version": "1.0.0",
            "characters": [{
                "localId": "c1",
                "name": "One",
                "avatarColor": "#fff",
                "systemPrompt": "you are one",
            }],
        })
    }

    fn signed_document(keypair: &Keypair) -> Value {
        let pack = pack();
        let payload = canonical_pack_bytes(&pack).unwrap();
        let sig = sign_bundle(&keypair.signing_key, &payload);
        serde_json::json!({
            "schemaVersion": 2,
            "pack": pack,
            "signature": { "algo": "ed25519", "pubKey": keypair.public_base64(), "sig": sig },
        })
    }

    #[test]
    fn a_correctly_signed_pack_verifies() {
        let keypair = Keypair::generate();
        let document = signed_document(&keypair);
        let outcome = evaluate(&document["pack"], document.get("signature"), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Verified);
        assert_eq!(outcome.pack_id.as_deref(), Some("demo.pack"));
        assert_eq!(
            outcome.public_key.as_deref(),
            Some(&*keypair.public_base64())
        );
        assert_eq!(
            outcome.fingerprint.as_deref(),
            Some(&*keypair.fingerprint_hex())
        );
        assert!(outcome.reason.is_none());
    }

    #[test]
    fn an_absent_signature_is_unsigned_not_invalid() {
        let outcome = evaluate(&pack(), None, None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Unsigned);
        assert!(outcome.signed_bytes > 0);
    }

    #[test]
    fn a_null_signature_is_treated_as_absent() {
        let outcome = evaluate(&pack(), Some(&Value::Null), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Unsigned);
    }

    #[test]
    fn a_tampered_pack_is_invalid() {
        let keypair = Keypair::generate();
        let mut document = signed_document(&keypair);
        document["pack"]["characters"][0]["systemPrompt"] = Value::from("compromised");
        let outcome = evaluate(&document["pack"], document.get("signature"), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Invalid);
        assert!(outcome.reason.is_some());
    }

    #[test]
    fn a_foreign_key_override_is_invalid_even_when_the_pack_is_self_consistent() {
        // The check that actually means something: a hostile author can always
        // re-sign with their own key, so only pinning the expected key detects it.
        let keypair = Keypair::generate();
        let document = signed_document(&keypair);
        let other = Keypair::generate();
        let outcome = evaluate(
            &document["pack"],
            document.get("signature"),
            Some(&other.public_base64()),
        )
        .unwrap();
        assert_eq!(outcome.verdict, Verdict::Invalid);
    }

    #[test]
    fn an_unknown_algo_is_invalid() {
        let keypair = Keypair::generate();
        let mut document = signed_document(&keypair);
        document["signature"]["algo"] = Value::from("rsa");
        let outcome = evaluate(&document["pack"], document.get("signature"), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Invalid);
        assert!(outcome
            .reason
            .unwrap()
            .contains("unsupported signature algo"));
    }

    #[test]
    fn a_missing_sig_or_pubkey_is_invalid_with_a_specific_reason() {
        let keypair = Keypair::generate();
        let mut document = signed_document(&keypair);
        document["signature"]["sig"] = Value::Null;
        let outcome = evaluate(&document["pack"], document.get("signature"), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Invalid);
        assert!(outcome.reason.unwrap().contains("`sig`"));

        let mut document = signed_document(&keypair);
        document["signature"]["pubKey"] = Value::Null;
        let outcome = evaluate(&document["pack"], document.get("signature"), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Invalid);
        assert!(outcome.reason.unwrap().contains("`pubKey`"));
    }

    #[test]
    fn a_malformed_public_key_is_invalid_not_an_error() {
        let keypair = Keypair::generate();
        let mut document = signed_document(&keypair);
        document["signature"]["pubKey"] = Value::from("!!!not base64!!!");
        let outcome = evaluate(&document["pack"], document.get("signature"), None).unwrap();
        assert_eq!(outcome.verdict, Verdict::Invalid);
        assert!(outcome.reason.unwrap().contains("base64"));
    }

    #[test]
    fn verify_exits_non_zero_on_an_invalid_signature() {
        let tmp = tempdir().unwrap();
        let keypair = Keypair::generate();
        let mut document = signed_document(&keypair);
        document["pack"]["name"] = Value::from("tampered");
        let file = tmp.path().join("p.cognia-pack.json");
        std::fs::write(&file, serde_json::to_string(&document).unwrap()).unwrap();
        let mut ui = RuntimeUi::new(UiFlags::default());
        let err = run(file, None, false, &mut ui).unwrap_err();
        assert!(err.to_string().contains("invalid signature"), "got: {err}");
    }

    #[test]
    fn verify_exits_zero_on_an_unsigned_pack_unless_require_signature_is_set() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("p.cognia-pack.json");
        std::fs::write(
            &file,
            serde_json::to_string(&serde_json::json!({ "schemaVersion": 2, "pack": pack() }))
                .unwrap(),
        )
        .unwrap();
        let mut ui = RuntimeUi::new(UiFlags::default());
        run(file.clone(), None, false, &mut ui).expect("unsigned is a supported state");
        let err = run(file, None, true, &mut ui).unwrap_err();
        assert!(
            err.to_string().contains("--require-signature"),
            "got: {err}"
        );
    }

    #[test]
    fn a_file_without_a_pack_object_is_an_error_not_a_verdict() {
        let tmp = tempdir().unwrap();
        let file = tmp.path().join("bad.json");
        std::fs::write(&file, r#"{"schemaVersion":2}"#).unwrap();
        let mut ui = RuntimeUi::new(UiFlags::default());
        let err = run(file, None, false, &mut ui).unwrap_err();
        assert!(
            err.to_string().contains("missing a top-level `pack`"),
            "got: {err}"
        );
    }

    #[test]
    fn json_report_marks_invalid_as_not_ok() {
        let report = PackVerifyReport {
            schema_version: 1,
            ok: false,
            action: "pack-verify",
            file: "p.json".into(),
            verdict: "invalid",
            pack_id: Some("demo.pack".into()),
            pack_version: None,
            public_key: None,
            fingerprint: None,
            signed_bytes: 12,
            reason: Some("boom".into()),
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], false);
        assert_eq!(json["verdict"], "invalid");
        assert_eq!(json["packId"], "demo.pack");
        assert!(
            json.get("packVersion").is_none(),
            "absent optionals must not serialize as null"
        );
    }
}
