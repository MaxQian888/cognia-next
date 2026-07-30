//! Signed, bundle-ID keyed application instruction packs.
//!
//! The schema intentionally contains only navigation hints and settling
//! guidance. It has no representation for policy, consent, redaction, target
//! allow-lists, or confirmations, so a signed pack still cannot weaken those
//! boundaries.

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionPack {
    pub bundle_id: String,
    pub version: u32,
    pub guidance: Vec<String>,
    pub preferred_locators: Vec<PreferredLocator>,
    pub loading_role_hints: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferredLocator {
    pub purpose: String,
    pub automation_id: Option<String>,
    pub role: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedInstructionPack {
    pub pack: InstructionPack,
    pub signature: String,
}

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum InstructionPackError {
    #[error("instruction pack signature is invalid")]
    InvalidSignature,
    #[error("instruction pack bundle ID is empty")]
    EmptyBundleId,
    #[error("instruction pack exceeds its bounded schema")]
    TooLarge,
}

pub fn load_signed_pack(
    envelope: SignedInstructionPack,
    cognia_key: &VerifyingKey,
) -> Result<InstructionPack, InstructionPackError> {
    validate_bounds(&envelope.pack)?;
    let signature = STANDARD_NO_PAD
        .decode(&envelope.signature)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or(InstructionPackError::InvalidSignature)?;
    let message =
        serde_json::to_vec(&envelope.pack).map_err(|_| InstructionPackError::InvalidSignature)?;
    cognia_key
        .verify(&message, &signature)
        .map_err(|_| InstructionPackError::InvalidSignature)?;
    Ok(envelope.pack)
}

pub fn load_builtin_pack(pack: InstructionPack) -> Result<InstructionPack, InstructionPackError> {
    validate_bounds(&pack)?;
    Ok(pack)
}

fn validate_bounds(pack: &InstructionPack) -> Result<(), InstructionPackError> {
    if pack.bundle_id.trim().is_empty() {
        return Err(InstructionPackError::EmptyBundleId);
    }
    if pack.guidance.len() > 64
        || pack.preferred_locators.len() > 256
        || pack.loading_role_hints.len() > 64
        || serde_json::to_vec(pack)
            .map(|encoded| encoded.len() > 256 * 1024)
            .unwrap_or(true)
    {
        return Err(InstructionPackError::TooLarge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn pack() -> InstructionPack {
        InstructionPack {
            bundle_id: "com.apple.Notes".into(),
            version: 1,
            guidance: vec!["Prefer the sidebar's AXIdentifier over its localized title.".into()],
            preferred_locators: vec![PreferredLocator {
                purpose: "new note".into(),
                automation_id: Some("new-note".into()),
                role: Some("AXButton".into()),
                name: None,
            }],
            loading_role_hints: vec!["AXProgressIndicator".into()],
        }
    }

    #[test]
    fn valid_cognia_signature_loads_and_tampering_fails() {
        let signing = SigningKey::from_bytes(&[9; 32]);
        let source = pack();
        let message = serde_json::to_vec(&source).unwrap();
        let mut envelope = SignedInstructionPack {
            pack: source,
            signature: STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes()),
        };
        assert_eq!(
            load_signed_pack(envelope.clone(), &signing.verifying_key())
                .unwrap()
                .bundle_id,
            "com.apple.Notes"
        );
        envelope.pack.bundle_id = "com.apple.Terminal".into();
        assert_eq!(
            load_signed_pack(envelope, &signing.verifying_key()),
            Err(InstructionPackError::InvalidSignature)
        );
    }

    #[test]
    fn unknown_policy_fields_are_rejected_by_the_wire_schema() {
        let json = serde_json::json!({
            "bundleId": "com.apple.Notes",
            "version": 1,
            "guidance": [],
            "preferredLocators": [],
            "loadingRoleHints": [],
            "overridePolicy": true
        });
        assert!(serde_json::from_value::<InstructionPack>(json).is_err());
    }
}
