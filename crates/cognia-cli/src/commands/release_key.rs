//! `cognia release-key` - inspect the embedded CLI release-signing key.

use anyhow::Result;
use serde::Serialize;

use crate::engine::release_key;
use crate::ui::{style, RuntimeUi};

const PLACEHOLDER_POLICY: &str = "sha256-only-until-release-key-is-provisioned";
const STRICT_POLICY: &str = "sha256-and-ed25519-release-signature";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub(crate) struct ReleaseKeyJsonPayload {
    #[serde(rename = "schemaVersion")]
    pub(crate) schema_version: u32,
    pub(crate) ok: bool,
    pub(crate) action: &'static str,
    #[serde(rename = "publicKey")]
    pub(crate) public_key: String,
    pub(crate) placeholder: bool,
    pub(crate) fingerprint: String,
    #[serde(rename = "signaturePolicy")]
    pub(crate) signature_policy: &'static str,
}

pub fn run(json: bool, ui: &mut RuntimeUi) -> Result<()> {
    let payload = release_key_payload()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&payload)?);
    } else if !ui.flags.quiet {
        print_human(&payload);
    }
    Ok(())
}

fn release_key_payload() -> Result<ReleaseKeyJsonPayload> {
    let placeholder = release_key::is_placeholder_key();
    Ok(ReleaseKeyJsonPayload {
        schema_version: 1,
        ok: true,
        action: "release-key",
        public_key: release_key::RELEASE_PUBLIC_KEY_BASE64.to_string(),
        placeholder,
        fingerprint: release_key::release_key_fingerprint_hex()?,
        signature_policy: if placeholder {
            PLACEHOLDER_POLICY
        } else {
            STRICT_POLICY
        },
    })
}

fn print_human(payload: &ReleaseKeyJsonPayload) {
    println!("{}Release key", style::bold("cognia "));
    println!("  public key:  {}", style::dim(&payload.public_key));
    println!("  fingerprint: {}", style::dim(&payload.fingerprint));
    println!(
        "  status:      {}",
        if payload.placeholder {
            style::warn("placeholder")
        } else {
            style::ok("provisioned")
        }
    );
    println!("  policy:      {}", payload.signature_policy);
    if payload.placeholder {
        println!(
            "{}CLI release downloads enforce SHA-256; Ed25519 verification activates after the release key is provisioned.",
            style::warn_prefix()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_key_payload_is_schema_versioned() {
        let payload = release_key_payload().unwrap();
        let json = serde_json::to_value(&payload).unwrap();

        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["ok"], true);
        assert_eq!(json["action"], "release-key");
        assert_eq!(json["placeholder"], true);
        assert_eq!(json["publicKey"].as_str().unwrap().len(), 44);
        assert_eq!(json["fingerprint"].as_str().unwrap().len(), 64);
        assert_eq!(json["signaturePolicy"], PLACEHOLDER_POLICY);
    }
}
