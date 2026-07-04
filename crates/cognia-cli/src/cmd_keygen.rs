//! `cognia plugin keygen` — generate an Ed25519 keypair for plugin signing.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::PathBuf;

use crate::signing::Keypair;
use crate::ui::{style, RuntimeUi};

/// `cognia plugin keygen` — generate an Ed25519 keypair.
///
/// Phase 3 behaviors:
///   * If `plugin.private.b64` or `plugin.public.b64` already exists in
///     `out_dir`, prompt for overwrite (default N). `--yes` skips.
///   * Output is rendered as a copy-paste box so the public-key snippet
///     and the example `sign` command are visually distinct from any
///     surrounding shell prompt / git status.
pub fn run(out_dir: PathBuf, ui: &mut RuntimeUi) -> Result<()> {
    if let Err(err) =
        std::fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))
    {
        if ui.flags.json {
            let priv_path = out_dir.join("plugin.private.b64");
            let pub_path = out_dir.join("plugin.public.b64");
            return emit_json_failure(&priv_path, &pub_path, "prepare", err);
        }
        return Err(err);
    }
    let priv_path = out_dir.join("plugin.private.b64");
    let pub_path = out_dir.join("plugin.public.b64");

    // Overwrite gates — refuse silent clobber. Either existing file
    // triggers a prompt; either "No" answer aborts the whole operation.
    for (path, hint) in [
        (&priv_path, "--yes to overwrite the existing private key"),
        (&pub_path, "--yes to overwrite the existing public key"),
    ] {
        let proceed = match ui.confirm_overwrite(path, hint).map_err(|e| anyhow!("{e}")) {
            Ok(proceed) => proceed,
            Err(err) if ui.flags.json => {
                return emit_json_failure(&priv_path, &pub_path, "overwrite", err);
            }
            Err(err) => return Err(err),
        };
        if !proceed {
            let err = anyhow!("keygen aborted: {} would be overwritten", path.display());
            if ui.flags.json {
                return emit_json_failure(&priv_path, &pub_path, "overwrite", err);
            }
            return Err(err);
        }
    }

    let kp = Keypair::generate();
    if let Err(err) = std::fs::write(&priv_path, kp.private_base64())
        .with_context(|| format!("write {}", priv_path.display()))
    {
        if ui.flags.json {
            return emit_json_failure(&priv_path, &pub_path, "write", err);
        }
        return Err(err);
    }
    if let Err(err) = std::fs::write(&pub_path, kp.public_base64())
        .with_context(|| format!("write {}", pub_path.display()))
    {
        if ui.flags.json {
            return emit_json_failure(&priv_path, &pub_path, "write", err);
        }
        return Err(err);
    }

    let pub_b64 = kp.public_base64();
    let fp = kp.fingerprint_hex();
    if ui.flags.json {
        let payload = KeygenJsonPayload {
            schema_version: 1,
            ok: true,
            action: "keygen",
            private_key_path: priv_path.display().to_string(),
            public_key_path: pub_path.display().to_string(),
            public_key: pub_b64,
            fingerprint: fp,
        };
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        println!("{}Ed25519 keypair generated", style::success_prefix());
        println!(
            "  private key: {}",
            style::dim(priv_path.display().to_string())
        );
        println!(
            "  public key:  {}",
            style::dim(pub_path.display().to_string())
        );
        println!("  fingerprint: {}", style::dim(&fp));
        println!();
        println!("{}", style::bold("Embed the public key in plugin.json:"));
        println!("  ┌────────────────────────────────────────────────────────────────");
        println!("  │ \"author\": {{");
        println!("  │   \"name\": \"Your Name\",");
        println!("  │   \"publicKey\": \"{pub_b64}\"");
        println!("  │ }}");
        println!("  └────────────────────────────────────────────────────────────────");
        println!();
        println!("{}", style::bold("Sign a built bundle:"));
        println!(
            "  cognia plugin sign target/cognia/<id>-<version>.zip --key {}",
            priv_path.display()
        );
        println!();
        println!(
            "{}keep {} safe — anyone with that file can sign as you.",
            style::warn_prefix(),
            style::bold(priv_path.display().to_string())
        );
    }
    Ok(())
}

#[derive(Debug, Serialize)]
struct KeygenFailureJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    stage: &'static str,
    #[serde(rename = "privateKeyPath")]
    private_key_path: String,
    #[serde(rename = "publicKeyPath")]
    public_key_path: String,
    error: String,
}

#[derive(Debug, Serialize)]
struct KeygenJsonPayload {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    ok: bool,
    action: &'static str,
    #[serde(rename = "privateKeyPath")]
    private_key_path: String,
    #[serde(rename = "publicKeyPath")]
    public_key_path: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    fingerprint: String,
}

fn emit_json_failure(
    private_key_path: &std::path::Path,
    public_key_path: &std::path::Path,
    stage: &'static str,
    err: anyhow::Error,
) -> Result<()> {
    let payload = KeygenFailureJsonPayload {
        schema_version: 1,
        ok: false,
        action: "keygen",
        stage,
        private_key_path: private_key_path.display().to_string(),
        public_key_path: public_key_path.display().to_string(),
        error: err.to_string(),
    };
    println!("{}", serde_json::to_string_pretty(&payload)?);
    Err(crate::JsonFailureExit.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn keygen_writes_both_files() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("keys");
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(dir.clone(), &mut ui).unwrap();
        assert!(dir.join("plugin.private.b64").exists());
        assert!(dir.join("plugin.public.b64").exists());
    }

    #[test]
    fn keygen_creates_missing_parent_dirs() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("nested").join("dir").join("keys");
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        run(dir.clone(), &mut ui).unwrap();
        assert!(dir.exists());
    }

    #[test]
    fn keygen_aborts_on_existing_file_without_yes_or_consent() {
        use crate::ui::prompter::{Answer, MockPrompter};
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("keys");
        // Seed an existing private key file.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.private.b64"), "seeded").unwrap();
        // Mock prompter says "no" to the overwrite confirmation.
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default()).with_prompter(
            Box::new(MockPrompter::with_answers([Answer::Confirm(false)])),
        );
        let err = run(dir.clone(), &mut ui).unwrap_err();
        assert!(err.to_string().contains("keygen aborted"), "got: {err}");
        // Ensure the seeded file is preserved.
        assert_eq!(
            std::fs::read_to_string(dir.join("plugin.private.b64")).unwrap(),
            "seeded"
        );
    }

    #[test]
    fn keygen_overwrites_when_yes_flag_set() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("keys");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.private.b64"), "stale").unwrap();
        std::fs::write(dir.join("plugin.public.b64"), "stale").unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            yes: true,
            ..crate::ui::runtime::UiFlags::default()
        });
        run(dir.clone(), &mut ui).unwrap();
        // Both files should be fresh base64-encoded 32-byte values (44 chars
        // standard base64 with padding).
        let priv_contents = std::fs::read_to_string(dir.join("plugin.private.b64")).unwrap();
        assert_ne!(priv_contents, "stale");
        assert_eq!(priv_contents.trim().len(), 44);
    }

    #[test]
    fn keygen_proceeds_when_mock_confirms() {
        use crate::ui::prompter::{Answer, MockPrompter};
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("keys");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.private.b64"), "stale").unwrap();
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default()).with_prompter(
            Box::new(MockPrompter::with_answers([
                Answer::Confirm(true), // overwrite private
                                       // public file doesn't exist yet, so no second prompt fires.
            ])),
        );
        run(dir.clone(), &mut ui).unwrap();
        let priv_contents = std::fs::read_to_string(dir.join("plugin.private.b64")).unwrap();
        assert_ne!(priv_contents, "stale");
    }

    #[test]
    fn keygen_json_payload_is_schema_versioned() {
        let payload = KeygenJsonPayload {
            schema_version: 1,
            ok: true,
            action: "keygen",
            private_key_path: ".cognia/plugin.private.b64".into(),
            public_key_path: ".cognia/plugin.public.b64".into(),
            public_key: "pub".into(),
            fingerprint: "abc".into(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "keygen");
        assert_eq!(json["privateKeyPath"], ".cognia/plugin.private.b64");
        assert_eq!(json["publicKeyPath"], ".cognia/plugin.public.b64");
        assert_eq!(json["publicKey"], "pub");
        assert_eq!(json["fingerprint"], "abc");
    }
}
