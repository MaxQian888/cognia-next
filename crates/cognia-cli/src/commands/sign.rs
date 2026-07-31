//! `cognia plugin sign <bundle> --key <path>` — produce `<bundle>.sig`.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::PathBuf;

use crate::engine::signing::{sign_bundle, Keypair};
use crate::ui::{style, RuntimeUi};

/// `cognia plugin sign` — Ed25519-sign the bundle and write `<bundle>.sig`.
///
/// Phase 3 behaviors:
///   * If the destination `.sig` already exists, prompt for overwrite
///     (default N). `--yes`/`-y` skips. Repeat-signing is common during
///     development, so the prompt nudges authors to be intentional.
///   * Output paints the success line, fingerprint dim, and labels bold.
pub fn run(bundle: PathBuf, key: PathBuf, out: Option<PathBuf>, ui: &mut RuntimeUi) -> Result<()> {
    let dest = out.unwrap_or_else(|| {
        let mut p = bundle.clone();
        let new_name = format!(
            "{}.sig",
            p.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        );
        p.set_file_name(new_name);
        p
    });

    let bytes = match std::fs::read(&bundle).with_context(|| format!("read {}", bundle.display())) {
        Ok(bytes) => bytes,
        Err(err) if ui.flags.json => return emit_json_failure(&bundle, &dest, "read", err),
        Err(err) => return Err(err),
    };
    let private_b64 =
        match std::fs::read_to_string(&key).with_context(|| format!("read {}", key.display())) {
            Ok(private_b64) => private_b64,
            Err(err) if ui.flags.json => return emit_json_failure(&bundle, &dest, "read", err),
            Err(err) => return Err(err),
        };
    let kp = match Keypair::from_private_base64(private_b64.trim()) {
        Ok(kp) => kp,
        Err(err) if ui.flags.json => return emit_json_failure(&bundle, &dest, "read", err),
        Err(err) => return Err(err),
    };
    let proceed = match ui
        .confirm_overwrite(&dest, "--yes to overwrite the existing signature")
        .map_err(|e| anyhow!("{e}"))
    {
        Ok(proceed) => proceed,
        Err(err) if ui.flags.json => return emit_json_failure(&bundle, &dest, "overwrite", err),
        Err(err) => return Err(err),
    };
    if !proceed {
        let err = anyhow!("sign aborted: {} would be overwritten", dest.display());
        if ui.flags.json {
            return emit_json_failure(&bundle, &dest, "overwrite", err);
        }
        return Err(err);
    }
    let signature = sign_bundle(&kp.signing_key, &bytes);
    // Create the destination's parent dir if `--out` points somewhere that
    // doesn't exist yet — consistent with `build`/`keygen`, which both
    // `create_dir_all` rather than erroring with a raw OS path error.
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(err) = std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))
            {
                if ui.flags.json {
                    return emit_json_failure(&bundle, &dest, "write", err);
                }
                return Err(err);
            }
        }
    }
    if let Err(err) =
        std::fs::write(&dest, &signature).with_context(|| format!("write {}", dest.display()))
    {
        if ui.flags.json {
            return emit_json_failure(&bundle, &dest, "write", err);
        }
        return Err(err);
    }
    let public_key = kp.public_base64();
    let fingerprint = kp.fingerprint_hex();
    if ui.flags.json {
        let payload = SignJsonPayload {
            schema_version: 1,
            ok: true,
            action: "sign",
            bundle: bundle.display().to_string(),
            signature: dest.display().to_string(),
            public_key,
            fingerprint,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!(
            "{}{} {} → {}",
            style::success_prefix(),
            style::ok("Signed"),
            style::bold(bundle.display().to_string()),
            style::bold(dest.display().to_string()),
        );
        println!("  {}  {}", style::dim("public key:"), public_key);
        println!(
            "  {}  {}",
            style::dim("fingerprint:"),
            style::dim(fingerprint)
        );
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct SignFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    bundle: String,
    signature: String,
    error: String,
}

#[derive(Debug, Serialize)]
struct SignJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    bundle: String,
    signature: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    fingerprint: String,
}

fn emit_json_failure(
    bundle: &std::path::Path,
    signature: &std::path::Path,
    stage: &'static str,
    err: anyhow::Error,
) -> Result<()> {
    let payload = SignFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "sign",
        stage,
        bundle: bundle.display().to_string(),
        signature: signature.display().to_string(),
        error: err.to_string(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::shared::JsonFailureExit.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::signing::Keypair;
    use tempfile::tempdir;

    #[test]
    fn sign_writes_sig_next_to_bundle() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("p.zip");
        std::fs::write(&bundle, b"-- bundle --").unwrap();
        let kp = Keypair::generate();
        let key_path = tmp.path().join("priv.b64");
        std::fs::write(&key_path, kp.private_base64()).unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(bundle.clone(), key_path, None, &mut ui).unwrap();
        assert!(tmp.path().join("p.zip.sig").exists());
        let sig_bytes = std::fs::read(tmp.path().join("p.zip.sig")).unwrap();
        // Verify the signature we wrote matches the bundle.
        let sig_str = String::from_utf8(sig_bytes).unwrap();
        crate::engine::signing::verify_bundle(&kp.public_base64(), b"-- bundle --", &sig_str)
            .unwrap();
    }

    #[test]
    fn sign_aborts_when_sig_exists_and_user_declines() {
        use crate::ui::prompter::{Answer, MockPrompter};
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("p.zip");
        std::fs::write(&bundle, b"bundle").unwrap();
        let kp = Keypair::generate();
        let key_path = tmp.path().join("priv.b64");
        std::fs::write(&key_path, kp.private_base64()).unwrap();
        // Pre-existing sig that should be preserved.
        std::fs::write(tmp.path().join("p.zip.sig"), "pre-existing").unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default()).with_prompter(
            Box::new(MockPrompter::with_answers([Answer::Confirm(false)])),
        );
        let err = run(bundle.clone(), key_path, None, &mut ui).unwrap_err();
        assert!(err.to_string().contains("sign aborted"), "got: {err}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("p.zip.sig")).unwrap(),
            "pre-existing"
        );
    }

    #[test]
    fn sign_overwrites_when_yes_flag_set() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("p.zip");
        std::fs::write(&bundle, b"bundle").unwrap();
        let kp = Keypair::generate();
        let key_path = tmp.path().join("priv.b64");
        std::fs::write(&key_path, kp.private_base64()).unwrap();
        std::fs::write(tmp.path().join("p.zip.sig"), "stale").unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            yes: true,
            ..crate::ui::runtime::UiFlags::default()
        });
        run(bundle, key_path, None, &mut ui).unwrap();
        let actual = std::fs::read_to_string(tmp.path().join("p.zip.sig")).unwrap();
        assert_ne!(actual, "stale");
        crate::engine::signing::verify_bundle(&kp.public_base64(), b"bundle", actual.trim())
            .unwrap();
    }

    #[test]
    fn sign_creates_missing_parent_dir_for_out() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("p.zip");
        std::fs::write(&bundle, b"x").unwrap();
        let kp = Keypair::generate();
        let key_path = tmp.path().join("priv.b64");
        std::fs::write(&key_path, kp.private_base64()).unwrap();
        // --out points into a directory tree that does not exist yet.
        let out_path = tmp.path().join("nested").join("dir").join("custom.sig");
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(bundle, key_path, Some(out_path.clone()), &mut ui).unwrap();
        assert!(
            out_path.exists(),
            "sign should create the parent dir for --out"
        );
    }

    #[test]
    fn sign_writes_to_custom_out_when_provided() {
        let tmp = tempdir().unwrap();
        let bundle = tmp.path().join("p.zip");
        std::fs::write(&bundle, b"x").unwrap();
        let kp = Keypair::generate();
        let key_path = tmp.path().join("priv.b64");
        std::fs::write(&key_path, kp.private_base64()).unwrap();
        let out_path = tmp.path().join("custom.sig");
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(bundle, key_path, Some(out_path.clone()), &mut ui).unwrap();
        assert!(out_path.exists());
    }

    #[test]
    fn sign_json_payload_is_schema_versioned() {
        let payload = SignJsonPayload {
            schema_version: 1,
            ok: true,
            action: "sign",
            bundle: "target/plugin.zip".into(),
            signature: "target/plugin.zip.sig".into(),
            public_key: "pub".into(),
            fingerprint: "abc".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "sign");
        assert_eq!(json["bundle"], "target/plugin.zip");
        assert_eq!(json["signature"], "target/plugin.zip.sig");
        assert_eq!(json["publicKey"], "pub");
        assert_eq!(json["fingerprint"], "abc");
    }
}
