//! `cognia plugin keygen` — generate an Ed25519 keypair for plugin signing.

use anyhow::{Context, Result};
use std::path::PathBuf;

use crate::signing::Keypair;

pub fn run(out_dir: PathBuf) -> Result<()> {
    std::fs::create_dir_all(&out_dir).with_context(|| format!("mkdir {}", out_dir.display()))?;
    let kp = Keypair::generate();
    let priv_path = out_dir.join("plugin.private.b64");
    let pub_path = out_dir.join("plugin.public.b64");
    std::fs::write(&priv_path, kp.private_base64())
        .with_context(|| format!("write {}", priv_path.display()))?;
    std::fs::write(&pub_path, kp.public_base64())
        .with_context(|| format!("write {}", pub_path.display()))?;
    println!("Generated Ed25519 keypair:");
    println!("  private key: {}", priv_path.display());
    println!("  public key:  {}", pub_path.display());
    println!();
    println!("Embed the public key in your plugin.json:");
    println!();
    println!("  \"author\": {{");
    println!("    \"name\": \"Your Name\",");
    println!("    \"publicKey\": \"{}\"", kp.public_base64());
    println!("  }}");
    println!();
    println!("Keep the private key file safe. To sign a bundle:");
    println!("  cognia plugin sign target/cognia/<id>-<version>.zip --key {}", priv_path.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn keygen_writes_both_files() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("keys");
        run(dir.clone()).unwrap();
        assert!(dir.join("plugin.private.b64").exists());
        assert!(dir.join("plugin.public.b64").exists());
    }

    #[test]
    fn keygen_creates_missing_parent_dirs() {
        let tmp = tempdir().unwrap();
        let dir = tmp.path().join("nested").join("dir").join("keys");
        run(dir.clone()).unwrap();
        assert!(dir.exists());
    }
}
