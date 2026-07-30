//! Signed, bundle-ID keyed application instruction packs.
//!
//! The schema intentionally contains only navigation hints and settling
//! guidance. It has no representation for policy, consent, redaction, target
//! allow-lists, or confirmations, so a signed pack still cannot weaken those
//! boundaries.

use std::collections::HashMap;

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
    #[error("instruction pack version must be newer than the installed version")]
    VersionNotNewer,
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

#[derive(Debug, Clone)]
pub struct InstructionPackRegistry {
    packs: HashMap<String, InstructionPack>,
}

impl Default for InstructionPackRegistry {
    fn default() -> Self {
        let mut registry = Self::empty();
        for pack in builtin_instruction_packs() {
            registry
                .install_builtin(pack)
                .expect("bundled instruction packs must be valid and uniquely versioned");
        }
        registry
    }
}

impl InstructionPackRegistry {
    pub fn empty() -> Self {
        Self {
            packs: HashMap::new(),
        }
    }

    pub fn install_builtin(&mut self, pack: InstructionPack) -> Result<(), InstructionPackError> {
        let pack = load_builtin_pack(pack)?;
        self.install_verified(pack)
    }

    pub fn install_signed(
        &mut self,
        envelope: SignedInstructionPack,
        cognia_key: &VerifyingKey,
    ) -> Result<(), InstructionPackError> {
        let pack = load_signed_pack(envelope, cognia_key)?;
        self.install_verified(pack)
    }

    pub fn for_bundle_id(&self, bundle_id: &str) -> Option<&InstructionPack> {
        self.packs.get(bundle_id)
    }

    fn install_verified(&mut self, pack: InstructionPack) -> Result<(), InstructionPackError> {
        if self
            .packs
            .get(&pack.bundle_id)
            .is_some_and(|installed| installed.version >= pack.version)
        {
            return Err(InstructionPackError::VersionNotNewer);
        }
        self.packs.insert(pack.bundle_id.clone(), pack);
        Ok(())
    }
}

fn builtin_instruction_packs() -> Vec<InstructionPack> {
    vec![
        InstructionPack {
            bundle_id: "com.apple.Notes".into(),
            version: 1,
            guidance: vec![
                "Prefer AX identifiers and the focused editor over localized toolbar labels."
                    .into(),
                "Treat the notes list, editor, and folders sidebar as separate scroll containers."
                    .into(),
            ],
            preferred_locators: vec![PreferredLocator {
                purpose: "new note".into(),
                automation_id: None,
                role: Some("AXButton".into()),
                name: None,
            }],
            loading_role_hints: vec!["AXProgressIndicator".into()],
        },
        InstructionPack {
            bundle_id: "com.apple.Safari".into(),
            version: 1,
            guidance: vec![
                "Resolve the active tab's web area before querying page content.".into(),
                "Use the address field only for navigation, never as evidence of page ownership."
                    .into(),
            ],
            preferred_locators: vec![PreferredLocator {
                purpose: "address and search".into(),
                automation_id: None,
                role: Some("AXTextField".into()),
                name: None,
            }],
            loading_role_hints: vec!["AXProgressIndicator".into(), "AXBusyIndicator".into()],
        },
        InstructionPack {
            bundle_id: "com.google.Chrome".into(),
            version: 1,
            guidance: vec![
                "Expand the active tab's out-of-process web area before querying page content."
                    .into(),
                "Prefer page accessibility nodes over browser chrome coordinates.".into(),
            ],
            preferred_locators: vec![PreferredLocator {
                purpose: "address and search".into(),
                automation_id: None,
                role: Some("AXTextField".into()),
                name: None,
            }],
            loading_role_hints: vec!["AXProgressIndicator".into(), "AXBusyIndicator".into()],
        },
    ]
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

    #[test]
    fn registry_resolves_only_built_in_bundle_ids() {
        let registry = InstructionPackRegistry::default();

        let notes = registry
            .for_bundle_id("com.apple.Notes")
            .expect("built-in Notes pack");
        assert_eq!(notes.version, 1);
        assert!(!notes.preferred_locators.is_empty());
        assert!(registry.for_bundle_id("com.example.Unknown").is_none());
    }

    #[test]
    fn signed_updates_must_be_newer_and_keep_the_bundle_key_stable() {
        let signing = SigningKey::from_bytes(&[7; 32]);
        let mut registry = InstructionPackRegistry::empty();
        let mut source = pack();
        source.version = 2;
        let message = serde_json::to_vec(&source).unwrap();
        let envelope = SignedInstructionPack {
            pack: source.clone(),
            signature: STANDARD_NO_PAD.encode(signing.sign(&message).to_bytes()),
        };

        registry
            .install_signed(envelope.clone(), &signing.verifying_key())
            .expect("first signed pack");
        assert_eq!(
            registry
                .for_bundle_id("com.apple.Notes")
                .expect("installed pack")
                .version,
            2
        );
        assert_eq!(
            registry.install_signed(envelope, &signing.verifying_key()),
            Err(InstructionPackError::VersionNotNewer)
        );
    }
}
