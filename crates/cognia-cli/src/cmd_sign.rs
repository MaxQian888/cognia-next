//! `cognia plugin sign <bundle> --key <path>` — produce `<bundle>.sig`.

use anyhow::{anyhow, bail, Context, Result};
use std::path::PathBuf;

use crate::signing::{sign_bundle, Keypair};
use crate::ui::{style, RuntimeUi};

/// `cognia plugin sign` — Ed25519-sign the bundle and write `<bundle>.sig`.
///
/// Phase 3 behaviors:
///   * If the destination `.sig` already exists, prompt for overwrite
///     (default N). `--yes`/`-y` skips. Repeat-signing is common during
///     development, so the prompt nudges authors to be intentional.
///   * Output paints the success line, fingerprint dim, and labels bold.
pub fn run(bundle: PathBuf, key: PathBuf, out: Option<PathBuf>, ui: &mut RuntimeUi) -> Result<()> {
    let bytes = std::fs::read(&bundle).with_context(|| format!("read {}", bundle.display()))?;
    let private_b64 = std::fs::read_to_string(&key)
        .with_context(|| format!("read {}", key.display()))?;
    let kp = Keypair::from_private_base64(private_b64.trim())?;
    let dest = out.unwrap_or_else(|| {
        let mut p = bundle.clone();
        let new_name = format!(
            "{}.sig",
            p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        );
        p.set_file_name(new_name);
        p
    });
    let proceed = ui
        .confirm_overwrite(&dest, "--yes to overwrite the existing signature")
        .map_err(|e| anyhow!("{e}"))?;
    if !proceed {
        bail!(
            "sign aborted: {} would be overwritten",
            dest.display()
        );
    }
    let signature = sign_bundle(&kp.signing_key, &bytes);
    std::fs::write(&dest, &signature).with_context(|| format!("write {}", dest.display()))?;
    println!(
        "{}{} {} → {}",
        style::success_prefix(),
        style::ok("Signed"),
        style::bold(bundle.display().to_string()),
        style::bold(dest.display().to_string()),
    );
    println!("  {}  {}", style::dim("public key:"), kp.public_base64());
    println!("  {}  {}", style::dim("fingerprint:"), style::dim(kp.fingerprint_hex()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::Keypair;
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
        crate::signing::verify_bundle(&kp.public_base64(), b"-- bundle --", &sig_str).unwrap();
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
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default())
            .with_prompter(Box::new(MockPrompter::with_answers([Answer::Confirm(false)])));
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
        crate::signing::verify_bundle(&kp.public_base64(), b"bundle", actual.trim()).unwrap();
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
}
