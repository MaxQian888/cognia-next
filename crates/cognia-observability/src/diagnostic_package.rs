use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub const PACKAGE_EXTENSION: &str = "cognia-diagnostic";
pub const PACKAGE_FORMAT_VERSION: u32 = 1;
pub const MAX_ATTACHMENTS: usize = 20;
pub const MAX_EVENTS: usize = 50_000;
pub const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_MINIDUMP_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct AttachmentInput {
    pub name: String,
    pub path: PathBuf,
    pub media_type: String,
    pub kind: AttachmentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Metadata,
    Log,
    Minidump,
    Screenshot,
    UserDescription,
    Symbol,
}

#[derive(Debug, Clone)]
pub struct DiagnosticPackageInput {
    pub incident_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub build_id: String,
    pub app_version: String,
    pub platform: String,
    pub events: Vec<Value>,
    pub attachments: Vec<AttachmentInput>,
    pub source_watermarks: BTreeMap<String, u64>,
    pub missing_sources: BTreeSet<String>,
    pub redaction_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub kind: AttachmentKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnsignedManifest {
    package_format_version: u32,
    incident_id: Uuid,
    created_at: DateTime<Utc>,
    build_id: String,
    app_version: String,
    platform: String,
    redaction_version: String,
    source_watermarks: BTreeMap<String, u64>,
    missing_sources: BTreeSet<String>,
    inventory: Vec<InventoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSignature {
    pub algorithm: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticManifestV1 {
    #[serde(flatten)]
    unsigned: UnsignedManifest,
    pub signature: PackageSignature,
}

impl DiagnosticManifestV1 {
    pub fn incident_id(&self) -> Uuid {
        self.unsigned.incident_id
    }

    pub fn build_id(&self) -> &str {
        &self.unsigned.build_id
    }

    pub fn platform(&self) -> &str {
        &self.unsigned.platform
    }

    pub fn inventory(&self) -> &[InventoryEntry] {
        &self.unsigned.inventory
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticPackageValidation {
    pub manifest: DiagnosticManifestV1,
    pub verified_files: usize,
    pub verified_bytes: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("diagnostic package must use the .cognia-diagnostic extension")]
    InvalidExtension,
    #[error("diagnostic package exceeds {0}")]
    LimitExceeded(&'static str),
    #[error("invalid diagnostic package path: {0}")]
    UnsafePath(String),
    #[error("diagnostic package is missing {0}")]
    MissingFile(String),
    #[error("diagnostic package contains duplicate path {0}")]
    DuplicatePath(String),
    #[error("diagnostic package checksum mismatch for {0}")]
    ChecksumMismatch(String),
    #[error("diagnostic package signature is invalid")]
    InvalidSignature,
    #[error("diagnostic package format version is unsupported")]
    UnsupportedVersion,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub fn create_diagnostic_package(
    output: &Path,
    input: DiagnosticPackageInput,
    signing_key: &SigningKey,
) -> Result<DiagnosticManifestV1, PackageError> {
    validate_extension(output)?;
    if input.attachments.len() > MAX_ATTACHMENTS {
        return Err(PackageError::LimitExceeded("attachment count"));
    }
    if input.events.len() > MAX_EVENTS {
        return Err(PackageError::LimitExceeded("structured event count"));
    }

    let ndjson = encode_ndjson(&input.events)?;
    let events_zstd = zstd::stream::encode_all(ndjson.as_slice(), 9)?;
    let mut payloads = vec![(
        "events/events.ndjson.zst".to_owned(),
        events_zstd,
        "application/x-ndjson+zstd".to_owned(),
        AttachmentKind::Log,
    )];
    let mut total_bytes = payloads[0].1.len() as u64;
    for attachment in input.attachments {
        validate_relative_path(&attachment.name)?;
        let bytes = std::fs::read(&attachment.path)?;
        let limit = if attachment.kind == AttachmentKind::Minidump {
            MAX_MINIDUMP_BYTES
        } else {
            MAX_ATTACHMENT_BYTES
        };
        if bytes.len() as u64 > limit {
            return Err(PackageError::LimitExceeded(
                if attachment.kind == AttachmentKind::Minidump {
                    "minidump size"
                } else {
                    "attachment size"
                },
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        let package_path = format!("attachments/{}", attachment.name);
        payloads.push((package_path, bytes, attachment.media_type, attachment.kind));
    }
    if total_bytes > MAX_TOTAL_BYTES {
        return Err(PackageError::LimitExceeded("total size"));
    }

    let mut seen = BTreeSet::new();
    let inventory = payloads
        .iter()
        .map(|(path, bytes, media_type, kind)| {
            if !seen.insert(path.clone()) {
                return Err(PackageError::DuplicatePath(path.clone()));
            }
            Ok(InventoryEntry {
                path: path.clone(),
                sha256: sha256_hex(bytes),
                bytes: bytes.len() as u64,
                media_type: media_type.clone(),
                kind: *kind,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let unsigned = UnsignedManifest {
        package_format_version: PACKAGE_FORMAT_VERSION,
        incident_id: input.incident_id,
        created_at: input.created_at,
        build_id: input.build_id,
        app_version: input.app_version,
        platform: input.platform,
        redaction_version: input.redaction_version,
        source_watermarks: input.source_watermarks,
        missing_sources: input.missing_sources,
        inventory,
    };
    let canonical = serde_json::to_vec(&unsigned)?;
    let signature = signing_key.sign(&canonical);
    let manifest = DiagnosticManifestV1 {
        unsigned,
        signature: PackageSignature {
            algorithm: "Ed25519".to_owned(),
            public_key: hex::encode(signing_key.verifying_key().to_bytes()),
            signature: hex::encode(signature.to_bytes()),
        },
    };

    let file = File::create(output)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(true);
    zip.start_file("manifest.json", options)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    for (path, bytes, _, _) in payloads {
        zip.start_file(path, options)?;
        zip.write_all(&bytes)?;
    }
    zip.finish()?.sync_all()?;
    Ok(manifest)
}

pub fn validate_diagnostic_package(
    package: &Path,
) -> Result<DiagnosticPackageValidation, PackageError> {
    validate_extension(package)?;
    let mut zip = ZipArchive::new(File::open(package)?)?;
    let manifest: DiagnosticManifestV1 = {
        let mut manifest_file = zip
            .by_name("manifest.json")
            .map_err(|_| PackageError::MissingFile("manifest.json".to_owned()))?;
        let mut bytes = Vec::new();
        manifest_file.read_to_end(&mut bytes)?;
        serde_json::from_slice(&bytes)?
    };
    if manifest.unsigned.package_format_version != PACKAGE_FORMAT_VERSION {
        return Err(PackageError::UnsupportedVersion);
    }
    verify_manifest_signature(&manifest)?;

    let mut verified_bytes = 0_u64;
    let mut verified_paths = BTreeSet::new();
    for entry in &manifest.unsigned.inventory {
        validate_relative_path(&entry.path)?;
        if !verified_paths.insert(entry.path.clone()) {
            return Err(PackageError::DuplicatePath(entry.path.clone()));
        }
        let mut file = zip
            .by_name(&entry.path)
            .map_err(|_| PackageError::MissingFile(entry.path.clone()))?;
        if file.size() != entry.bytes {
            return Err(PackageError::ChecksumMismatch(entry.path.clone()));
        }
        let mut hasher = Sha256::new();
        let copied = std::io::copy(&mut file, &mut HashWriter(&mut hasher))?;
        if copied != entry.bytes || hex::encode(hasher.finalize()) != entry.sha256 {
            return Err(PackageError::ChecksumMismatch(entry.path.clone()));
        }
        verified_bytes = verified_bytes.saturating_add(copied);
        if verified_bytes > MAX_TOTAL_BYTES {
            return Err(PackageError::LimitExceeded("total size"));
        }
    }
    Ok(DiagnosticPackageValidation {
        verified_files: verified_paths.len(),
        verified_bytes,
        manifest,
    })
}

fn verify_manifest_signature(manifest: &DiagnosticManifestV1) -> Result<(), PackageError> {
    if manifest.signature.algorithm != "Ed25519" {
        return Err(PackageError::InvalidSignature);
    }
    let public_key: [u8; 32] = hex::decode(&manifest.signature.public_key)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(PackageError::InvalidSignature)?;
    let signature = hex::decode(&manifest.signature.signature)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or(PackageError::InvalidSignature)?;
    let canonical = serde_json::to_vec(&manifest.unsigned)?;
    VerifyingKey::from_bytes(&public_key)
        .and_then(|key| key.verify(&canonical, &signature))
        .map_err(|_| PackageError::InvalidSignature)
}

fn validate_extension(path: &Path) -> Result<(), PackageError> {
    if path.extension().and_then(|value| value.to_str()) != Some(PACKAGE_EXTENSION) {
        return Err(PackageError::InvalidExtension);
    }
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<(), PackageError> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(PackageError::UnsafePath(path.display().to_string()));
    }
    Ok(())
}

fn encode_ndjson(events: &[Value]) -> Result<Vec<u8>, PackageError> {
    let mut output = Vec::new();
    for event in events {
        serde_json::to_writer(&mut output, event)?;
        output.push(b'\n');
    }
    Ok(output)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

struct HashWriter<'a>(&'a mut Sha256);

impl Write for HashWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(dir: &Path) -> DiagnosticPackageInput {
        let attachment = dir.join("report.json");
        std::fs::write(&attachment, br#"{"safe":true}"#).unwrap();
        DiagnosticPackageInput {
            incident_id: Uuid::nil(),
            created_at: DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
            build_id: "build-1".to_owned(),
            app_version: "1.0.0".to_owned(),
            platform: "macos".to_owned(),
            events: vec![serde_json::json!({"schemaVersion": 1, "kind": "crash"})],
            attachments: vec![AttachmentInput {
                name: "report.json".to_owned(),
                path: attachment,
                media_type: "application/json".to_owned(),
                kind: AttachmentKind::Metadata,
            }],
            source_watermarks: BTreeMap::from([("renderer".to_owned(), 42)]),
            missing_sources: BTreeSet::from(["sidecar".to_owned()]),
            redaction_version: "client-v1".to_owned(),
        }
    }

    #[test]
    fn creates_and_validates_signed_zip64_package() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("incident.cognia-diagnostic");
        let manifest = create_diagnostic_package(
            &package,
            input(dir.path()),
            &SigningKey::from_bytes(&[9; 32]),
        )
        .unwrap();
        assert_eq!(manifest.unsigned.inventory.len(), 2);

        let validation = validate_diagnostic_package(&package).unwrap();
        assert_eq!(validation.verified_files, 2);
        assert!(validation.verified_bytes > 0);
        assert_eq!(validation.manifest.signature.algorithm, "Ed25519");
    }

    #[test]
    fn refuses_unsafe_attachment_paths_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("incident.cognia-diagnostic");
        let mut input = input(dir.path());
        input.attachments[0].name = "../secret".to_owned();
        assert!(matches!(
            create_diagnostic_package(&package, input, &SigningKey::from_bytes(&[9; 32])),
            Err(PackageError::UnsafePath(_))
        ));
    }

    #[test]
    fn requires_contract_extension_and_limits() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = input(dir.path());
        input.events = vec![Value::Null; MAX_EVENTS + 1];
        assert!(matches!(
            create_diagnostic_package(
                &dir.path().join("incident.cognia-diagnostic"),
                input,
                &SigningKey::from_bytes(&[9; 32])
            ),
            Err(PackageError::LimitExceeded("structured event count"))
        ));
        assert!(matches!(
            validate_diagnostic_package(&dir.path().join("incident.zip")),
            Err(PackageError::InvalidExtension)
        ));
    }
}
