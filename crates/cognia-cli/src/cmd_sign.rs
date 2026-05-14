//! `cognia plugin sign <bundle> --key <path>` — produce `<bundle>.sig`.

use anyhow::{Context, Result};
use std::path::PathBuf;

use crate::signing::{sign_bundle, Keypair};

pub fn run(bundle: PathBuf, key: PathBuf, out: Option<PathBuf>) -> Result<()> {
    let bytes = std::fs::read(&bundle).with_context(|| format!("read {}", bundle.display()))?;
    let private_b64 = std::fs::read_to_string(&key)
        .with_context(|| format!("read {}", key.display()))?;
    let kp = Keypair::from_private_base64(private_b64.trim())?;
    let signature = sign_bundle(&kp.signing_key, &bytes);
    let dest = out.unwrap_or_else(|| {
        let mut p = bundle.clone();
        let new_name = format!(
            "{}.sig",
            p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
        );
        p.set_file_name(new_name);
        p
    });
    std::fs::write(&dest, &signature).with_context(|| format!("write {}", dest.display()))?;
    println!("Signed {} → {}", bundle.display(), dest.display());
    println!("Public key (base64): {}", kp.public_base64());
    println!("Fingerprint (sha256): {}", kp.fingerprint_hex());
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
        run(bundle.clone(), key_path, None).unwrap();
        assert!(tmp.path().join("p.zip.sig").exists());
        let sig_bytes = std::fs::read(tmp.path().join("p.zip.sig")).unwrap();
        // Verify the signature we wrote matches the bundle.
        let sig_str = String::from_utf8(sig_bytes).unwrap();
        crate::signing::verify_bundle(&kp.public_base64(), b"-- bundle --", &sig_str).unwrap();
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
        run(bundle, key_path, Some(out_path.clone())).unwrap();
        assert!(out_path.exists());
    }
}
