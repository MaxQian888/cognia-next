//! Consented submission of a diagnostic package to a Cognia diagnostic service.
//!
//! One implementation of the upload state machine, shared by the desktop shell
//! and the CLI. They cannot share a transport — the CLI deliberately keeps
//! tokio out of its binary and uses `ureq`, while `src-tauri` already carries
//! async `reqwest` — but the sequence, the payload shapes, the resume rule and
//! the installation proof are exactly the same on both, and a second copy of
//! any of them would be a second thing to get wrong.
//!
//! The package is uploaded as **one part per package entry**, not as one
//! opaque blob. The service's pipeline dispatches on `x-artifact-kind`: a part
//! declared `minidump` is symbolicated, `events` and `attachment` parts are
//! scanned for stack frames, and the resulting frames are what the fingerprint
//! groups on. Sending the whole `.cognia-diagnostic` zip as a single
//! `attachment` — which is what the CLI did — yields no frames at all, so every
//! submission grouped by module and exception alone.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zip::ZipArchive;

use crate::diagnostic_package::{
    validate_diagnostic_package, AttachmentKind, DiagnosticManifestV1, PackageError,
};

/// File name of the per-install Ed25519 key, under the Cognia data directory.
///
/// The same key signs diagnostic packages and the installation proof, so the
/// identity a service sees on `/v1/grants/anonymous` is the identity that
/// signed the manifest it later receives.
pub const INSTALLATION_KEY_FILE: &str = "diagnostic-signing.key";

/// Cap on how much of the events stream is decompressed just to count records.
const MAX_EVENT_COUNT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum SubmitError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Package(#[from] PackageError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    /// The request never reached the service.
    #[error("diagnostic service unreachable: {0}")]
    Transport(String),
    /// The service answered with its own machine-readable code.
    #[error("diagnostic service refused the request: {code} (HTTP {status})")]
    Service { status: u16, code: String },
    #[error("diagnostic service answered HTTP {status} with an unreadable body")]
    Malformed { status: u16 },
    #[error("{0}")]
    Invalid(&'static str),
}

impl SubmitError {
    /// True when intake is switched off and the caller should keep its spool
    /// rather than discarding the report as rejected.
    pub fn is_ingest_disabled(&self) -> bool {
        matches!(self, Self::Service { code, .. } if code == "ingest_disabled")
    }

    /// True when the grant was refused — the caller should re-exchange rather
    /// than retry the same request.
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Service { status, .. } if *status == 401)
    }

    /// The service's error code, when the failure came from the service.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Service { code, .. } => Some(code),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Installation identity
// ---------------------------------------------------------------------------

/// The per-install Ed25519 identity.
pub struct InstallationIdentity {
    key: SigningKey,
}

impl InstallationIdentity {
    /// Load the key at `path`, creating it on first use.
    ///
    /// Written `0600` on unix. The key is the machine's only proof of which
    /// submissions are its own — losing it costs the ability to withdraw or
    /// delete anything already uploaded, which is why it is never regenerated
    /// silently over an existing file.
    pub fn load_or_create(path: &Path) -> Result<Self, SubmitError> {
        if path.exists() {
            let encoded = std::fs::read_to_string(path)?;
            let bytes = hex::decode(encoded.trim())
                .map_err(|_| SubmitError::Invalid("installation key is not hex"))?;
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| SubmitError::Invalid("installation key must contain 32 bytes"))?;
            return Ok(Self {
                key: SigningKey::from_bytes(&bytes),
            });
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut secret = [0_u8; 32];
        // Two v4 UUIDs, which are CSPRNG-derived, rather than pulling `rand`
        // into a crate that otherwise needs no randomness. 244 bits of entropy
        // for a 256-bit seed.
        secret[..16].copy_from_slice(Uuid::new_v4().as_bytes());
        secret[16..].copy_from_slice(Uuid::new_v4().as_bytes());
        let key = SigningKey::from_bytes(&secret);
        write_private_key(path, &hex::encode(key.to_bytes()))?;
        Ok(Self { key })
    }

    pub fn from_signing_key(key: SigningKey) -> Self {
        Self { key }
    }

    /// Build an identity from a raw 32-byte seed.
    ///
    /// Exists so a consumer can construct one in a test without naming
    /// `ed25519_dalek::SigningKey`: `src-tauri` resolves a *different* major
    /// version of that crate than this one does, so the type is not
    /// nameable across the boundary even though values flow through it fine.
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(seed),
        }
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    /// Base64 of the raw 32-byte public key, as `/v1/grants/anonymous` expects.
    pub fn public_key_base64(&self) -> String {
        base64_encode(self.key.verifying_key().as_bytes())
    }

    /// Stable, non-identifying installation id derived from the public key.
    ///
    /// A hash rather than the key itself so the id is short enough for a
    /// database column and reveals nothing that is not already public, and
    /// derived rather than random so a reinstall that keeps the key keeps its
    /// submissions.
    pub fn installation_id(&self) -> String {
        let digest = Sha256::digest(self.key.verifying_key().as_bytes());
        format!("inst_{}", hex::encode(&digest[..16]))
    }

    fn sign_base64(&self, message: &[u8]) -> String {
        base64_encode(&self.key.sign(message).to_bytes())
    }
}

fn write_private_key(path: &Path, encoded: &str) -> Result<(), SubmitError> {
    #[cfg(unix)]
    {
        use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(encoded.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, encoded)?;
    Ok(())
}

/// Where the installation key lives under a Cognia data directory.
pub fn installation_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(INSTALLATION_KEY_FILE)
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct HttpRequest<'a> {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<&'a [u8]>,
}

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

/// Blocking on purpose.
///
/// The CLI has no async runtime by design and the desktop runs submission on a
/// blocking task, so a synchronous seam is the one shape both can implement
/// without either growing a dependency for the other's benefit.
pub trait DiagnosticTransport {
    fn execute(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String>;
}

// ---------------------------------------------------------------------------
// Target and payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SubmissionTarget {
    /// Service origin with any path prefix, no trailing slash.
    pub base_url: String,
    pub tenant_id: String,
    pub project_id: String,
}

impl SubmissionTarget {
    pub fn new(base_url: impl Into<String>, tenant_id: impl Into<String>, project_id: impl Into<String>) -> Self {
        let base_url = base_url.into();
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            tenant_id: tenant_id.into(),
            project_id: project_id.into(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }
}

/// One request-ready package entry.
pub struct PackagePart {
    pub part_number: i32,
    pub artifact_kind: &'static str,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionReceipt {
    pub incident_id: String,
    pub support_code: String,
    /// Present only when this call created the incident. A resumed submission
    /// keeps the credential stored the first time.
    pub deletion_credential: Option<String>,
    pub created: bool,
    pub client_state: String,
    pub processing_state: String,
    pub uploaded_parts: usize,
    /// Parts the service already held with a matching checksum.
    pub resumed_parts: usize,
}

/// Map a package entry to the artifact kind that steers server processing.
///
/// The events stream is matched by path rather than by `AttachmentKind`,
/// because `create_diagnostic_package` files it under `Log` alongside ordinary
/// log attachments and only its path distinguishes the two.
fn artifact_kind_for(path: &str, kind: AttachmentKind) -> &'static str {
    if path == "events/events.ndjson.zst" {
        return "events";
    }
    match kind {
        AttachmentKind::Minidump => "minidump",
        AttachmentKind::Screenshot => "screenshot",
        _ => "attachment",
    }
}

/// Read a validated package into the parts that will be uploaded.
///
/// Validation runs first and is not optional: it verifies the manifest
/// signature and every entry checksum, so a tampered package is refused before
/// a single byte leaves the machine.
pub fn read_package_parts(
    package: &Path,
) -> Result<(DiagnosticManifestV1, Vec<PackagePart>), SubmitError> {
    let validation = validate_diagnostic_package(package)?;
    let manifest = validation.manifest;
    let mut archive = ZipArchive::new(std::fs::File::open(package)?)?;

    let mut parts = Vec::with_capacity(manifest.inventory().len() + 1);
    // Part 1 is always the manifest: it carries the signature and the
    // inventory, and the service's own inspection surfaces read it first.
    let manifest_bytes = read_entry(&mut archive, "manifest.json")?;
    parts.push(PackagePart {
        part_number: 1,
        artifact_kind: "manifest",
        sha256: hex::encode(Sha256::digest(&manifest_bytes)),
        bytes: manifest_bytes,
    });
    for (index, entry) in manifest.inventory().iter().enumerate() {
        let bytes = read_entry(&mut archive, &entry.path)?;
        parts.push(PackagePart {
            // Part numbers are 1-based and the manifest took 1.
            part_number: index as i32 + 2,
            artifact_kind: artifact_kind_for(&entry.path, entry.kind),
            sha256: entry.sha256.clone(),
            bytes,
        });
    }
    Ok((manifest, parts))
}

fn read_entry(archive: &mut ZipArchive<std::fs::File>, name: &str) -> Result<Vec<u8>, SubmitError> {
    let mut file = archive
        .by_name(name)
        .map_err(|_| PackageError::MissingFile(name.to_owned()))?;
    let mut bytes = Vec::with_capacity(file.size() as usize);
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Count records in the zstd-compressed NDJSON events part.
///
/// The service validates the declared count against its own ceiling, so
/// declaring zero — which is what the CLI did — understates the payload and
/// makes the limit check meaningless. Bounded so a hostile package cannot turn
/// a count into an allocation.
pub fn count_events(events_zstd: &[u8]) -> Result<usize, SubmitError> {
    let decoder = zstd::stream::read::Decoder::new(events_zstd)?;
    let mut reader = decoder.take(MAX_EVENT_COUNT_BYTES);
    let mut buffer = [0_u8; 64 * 1024];
    let mut records = 0_usize;
    let mut trailing = 0_u8;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        records += buffer[..read].iter().filter(|byte| **byte == b'\n').count();
        trailing = buffer[read - 1];
    }
    // A final record without a trailing newline still counts.
    if records > 0 && trailing != b'\n' {
        records += 1;
    }
    Ok(records)
}

// ---------------------------------------------------------------------------
// The sequence
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationProof {
    tenant_id: String,
    project_id: String,
    installation_id: String,
    public_key: String,
    signature: String,
    nonce: String,
    timestamp: i64,
}

/// Build the signed installation proof `/v1/grants/anonymous` verifies.
///
/// The message layout is load-bearing: the service reconstructs exactly this
/// string from the request fields before checking the signature, so any change
/// here is a breaking change there.
pub fn build_installation_proof_body(
    identity: &InstallationIdentity,
    target: &SubmissionTarget,
    nonce: &str,
    timestamp: i64,
) -> serde_json::Value {
    let installation_id = identity.installation_id();
    let message = format!(
        "{}\n{}\n{installation_id}\n{nonce}\n{timestamp}",
        target.tenant_id, target.project_id
    );
    serde_json::to_value(InstallationProof {
        tenant_id: target.tenant_id.clone(),
        project_id: target.project_id.clone(),
        installation_id,
        public_key: identity.public_key_base64(),
        signature: identity.sign_base64(message.as_bytes()),
        nonce: nonce.to_owned(),
        timestamp,
    })
    .expect("installation proof serializes")
}

/// Exchange an installation proof for an uploader grant.
///
/// The nonce is single-use and the service records it, so a replayed proof is
/// refused with `installation_proof_replayed` rather than quietly minting a
/// second grant.
pub fn exchange_installation_grant<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    identity: &InstallationIdentity,
    timestamp: i64,
) -> Result<String, SubmitError> {
    let nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let body = serde_json::to_vec(&build_installation_proof_body(
        identity, target, &nonce, timestamp,
    ))?;
    let response = json_request(
        transport,
        HttpRequest {
            method: "POST",
            url: target.url("/v1/grants/anonymous"),
            headers: vec![("content-type", "application/json".to_owned())],
            body: Some(&body),
        },
    )?;
    response
        .get("grant")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or(SubmitError::Invalid("grant response carried no grant"))
}

pub struct SubmissionRequest<'a> {
    pub package: &'a Path,
    /// Reported as the incident's module, e.g. `cognia-desktop`.
    pub module: &'a str,
    /// Reported as the incident's exception, e.g. `panic` or `sigsegv`.
    pub exception: &'a str,
}

/// Create (or resume) an incident, push every missing part, and complete it.
///
/// Resumable by construction: incident creation is idempotent on the package
/// hash, and a part the service already holds with a matching source checksum
/// is skipped. Re-running after a network failure therefore costs only the
/// parts that did not land.
pub fn submit_package<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    grant: &str,
    request: SubmissionRequest<'_>,
) -> Result<SubmissionReceipt, SubmitError> {
    let package_bytes = std::fs::read(request.package)?;
    let artifact_hash = hex::encode(Sha256::digest(&package_bytes));
    drop(package_bytes);

    let (manifest, parts) = read_package_parts(request.package)?;
    let event_count = parts
        .iter()
        .find(|part| part.artifact_kind == "events")
        .map(|part| count_events(&part.bytes))
        .transpose()?
        .unwrap_or(0);
    let total_bytes: u64 = parts.iter().map(|part| part.bytes.len() as u64).sum();
    let largest_attachment = parts
        .iter()
        .filter(|part| part.artifact_kind != "minidump")
        .map(|part| part.bytes.len() as u64)
        .max()
        .unwrap_or(0);
    let largest_minidump = parts
        .iter()
        .filter(|part| part.artifact_kind == "minidump")
        .map(|part| part.bytes.len() as u64)
        .max()
        .unwrap_or(0);

    let create_body = serde_json::to_vec(&serde_json::json!({
        "artifactHash": artifact_hash,
        "buildId": manifest.build_id(),
        "platform": manifest.platform(),
        "module": request.module,
        "exception": request.exception,
        // The manifest is not an attachment; the service's ceiling is about
        // how much a client may attach, not how many parts it sends.
        "attachmentCount": parts.len().saturating_sub(1),
        "eventCount": event_count,
        "totalBytes": total_bytes,
        "largestAttachmentBytes": largest_attachment,
        "largestMinidumpBytes": largest_minidump,
        "consent": true,
    }))?;
    let created = json_request(
        transport,
        HttpRequest {
            method: "POST",
            url: target.url("/v1/incidents"),
            headers: authorized(grant, Some("application/json")),
            body: Some(&create_body),
        },
    )?;
    let incident_id = created
        .pointer("/incident/id")
        .and_then(serde_json::Value::as_str)
        .ok_or(SubmitError::Invalid("create response carried no incident id"))?
        .to_owned();

    let already_stored = stored_part_checksums(transport, target, grant, &incident_id)?;
    let mut uploaded = 0_usize;
    let mut resumed = 0_usize;
    for part in &parts {
        if already_stored.get(&part.part_number) == Some(&part.sha256) {
            resumed += 1;
            continue;
        }
        json_request(
            transport,
            HttpRequest {
                method: "PUT",
                url: target.url(&format!(
                    "/v1/incidents/{incident_id}/parts/{}",
                    part.part_number
                )),
                headers: {
                    let mut headers = authorized(grant, Some("application/octet-stream"));
                    headers.push(("x-part-sha256", part.sha256.clone()));
                    headers.push(("x-artifact-kind", part.artifact_kind.to_owned()));
                    headers
                },
                body: Some(&part.bytes),
            },
        )?;
        uploaded += 1;
    }

    let receipt = json_request(
        transport,
        HttpRequest {
            method: "POST",
            url: target.url(&format!("/v1/incidents/{incident_id}/complete")),
            headers: authorized(grant, Some("application/json")),
            body: Some(b"{}"),
        },
    )?;

    Ok(SubmissionReceipt {
        incident_id,
        support_code: receipt
            .get("supportCode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        deletion_credential: created
            .get("deletionCredential")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        created: created
            .get("created")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        client_state: receipt
            .get("clientState")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("processing")
            .to_owned(),
        processing_state: receipt
            .get("processingState")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("received")
            .to_owned(),
        uploaded_parts: uploaded,
        resumed_parts: resumed,
    })
}

/// Withdraw consent for an already-submitted incident.
///
/// Distinct from deletion: it blocks processing *and* schedules removal, and
/// it is the one route that stays available while intake is switched off.
pub fn withdraw_consent<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    grant: &str,
    incident_id: &str,
) -> Result<(), SubmitError> {
    json_request(
        transport,
        HttpRequest {
            method: "POST",
            url: target.url(&format!("/v1/incidents/{incident_id}/withdraw")),
            headers: authorized(grant, None),
            body: None,
        },
    )?;
    Ok(())
}

pub fn delete_incident<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    grant: &str,
    incident_id: &str,
) -> Result<(), SubmitError> {
    json_request(
        transport,
        HttpRequest {
            method: "DELETE",
            url: target.url(&format!("/v1/incidents/{incident_id}")),
            headers: authorized(grant, None),
            body: None,
        },
    )?;
    Ok(())
}

/// Fetch the current receipt for an incident.
pub fn fetch_receipt<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    grant: &str,
    incident_id: &str,
) -> Result<serde_json::Value, SubmitError> {
    json_request(
        transport,
        HttpRequest {
            method: "GET",
            url: target.url(&format!("/v1/incidents/{incident_id}")),
            headers: authorized(grant, None),
            body: None,
        },
    )
}

/// Which parts the service already holds, by part number and source checksum.
///
/// A missing or unreadable inventory is treated as "nothing stored" rather
/// than an error: re-uploading a part is idempotent on the server, so the cost
/// of guessing wrong is bandwidth, while failing here would strand a report
/// that could have been delivered.
fn stored_part_checksums<T: DiagnosticTransport>(
    transport: &T,
    target: &SubmissionTarget,
    grant: &str,
    incident_id: &str,
) -> Result<BTreeMap<i32, String>, SubmitError> {
    let response = match json_request(
        transport,
        HttpRequest {
            method: "GET",
            url: target.url(&format!("/v1/incidents/{incident_id}/parts")),
            headers: authorized(grant, None),
            body: None,
        },
    ) {
        Ok(response) => response,
        Err(SubmitError::Service { .. }) | Err(SubmitError::Malformed { .. }) => {
            return Ok(BTreeMap::new())
        }
        Err(error) => return Err(error),
    };
    let mut stored = BTreeMap::new();
    if let Some(parts) = response.get("parts").and_then(serde_json::Value::as_array) {
        for part in parts {
            let number = part.get("partNumber").and_then(serde_json::Value::as_i64);
            let checksum = part.get("sourceSha256").and_then(serde_json::Value::as_str);
            if let (Some(number), Some(checksum)) = (number, checksum) {
                stored.insert(number as i32, checksum.to_owned());
            }
        }
    }
    Ok(stored)
}

fn authorized(grant: &str, content_type: Option<&str>) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("authorization", format!("Bearer {grant}")),
        ("accept", "application/json".to_owned()),
    ];
    if let Some(content_type) = content_type {
        headers.push(("content-type", content_type.to_owned()));
    }
    headers
}

/// Execute a request and decode the service's answer.
///
/// A non-2xx answer is turned into the service's own error code rather than a
/// status alone, because that is what every caller branches on — `503
/// ingest_disabled` means "keep the spool", `401` means "re-exchange the
/// grant", and an HTTP status cannot distinguish either from a gateway.
fn json_request<T: DiagnosticTransport>(
    transport: &T,
    request: HttpRequest<'_>,
) -> Result<serde_json::Value, SubmitError> {
    let response = transport.execute(request).map_err(SubmitError::Transport)?;
    if response.status == 204 || response.body.is_empty() {
        if (200..300).contains(&response.status) {
            return Ok(serde_json::Value::Null);
        }
        return Err(SubmitError::Malformed {
            status: response.status,
        });
    }
    let value: serde_json::Value = match serde_json::from_slice(&response.body) {
        Ok(value) => value,
        Err(_) if (200..300).contains(&response.status) => serde_json::Value::Null,
        Err(_) => {
            return Err(SubmitError::Malformed {
                status: response.status,
            })
        }
    };
    if (200..300).contains(&response.status) {
        return Ok(value);
    }
    let code = value
        .pointer("/error/code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown_error")
        .to_owned();
    Err(SubmitError::Service {
        status: response.status,
        code,
    })
}

/// Standard base64. Hand-rolled to keep a dependency out of a crate that needs
/// exactly two encodes.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let packed = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(packed >> 18) as usize & 63] as char);
        out.push(ALPHABET[(packed >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(packed >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[packed as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    use crate::diagnostic_package::{create_diagnostic_package, DiagnosticPackageInput};
    use chrono::Utc;

    /// One request as the transport saw it.
    struct SeenRequest {
        method: String,
        url: String,
        artifact_kind: Option<String>,
        headers: Vec<(&'static str, String)>,
    }

    impl SeenRequest {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_str())
        }
    }

    struct RecordingTransport {
        responses: RefCell<Vec<(u16, String)>>,
        seen: RefCell<Vec<SeenRequest>>,
    }

    impl RecordingTransport {
        fn new(responses: Vec<(u16, &str)>) -> Self {
            Self {
                responses: RefCell::new(
                    responses
                        .into_iter()
                        .map(|(status, body)| (status, body.to_owned()))
                        .collect(),
                ),
                seen: RefCell::new(Vec::new()),
            }
        }
    }

    impl DiagnosticTransport for RecordingTransport {
        fn execute(&self, request: HttpRequest<'_>) -> Result<HttpResponse, String> {
            self.seen.borrow_mut().push(SeenRequest {
                method: request.method.to_owned(),
                url: request.url.clone(),
                artifact_kind: request
                    .headers
                    .iter()
                    .find(|(name, _)| *name == "x-artifact-kind")
                    .map(|(_, value)| value.clone()),
                headers: request.headers.clone(),
            });
            let mut responses = self.responses.borrow_mut();
            if responses.is_empty() {
                return Err("no scripted response".to_owned());
            }
            let (status, body) = responses.remove(0);
            Ok(HttpResponse {
                status,
                body: body.into_bytes(),
            })
        }
    }

    fn identity() -> InstallationIdentity {
        InstallationIdentity::from_signing_key(SigningKey::from_bytes(&[7_u8; 32]))
    }

    fn target() -> SubmissionTarget {
        SubmissionTarget::new(
            "https://diag.example.com/",
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        )
    }

    fn sample_package(dir: &Path, with_minidump: bool) -> PathBuf {
        let minidump_path = dir.join("crash.dmp");
        std::fs::write(&minidump_path, b"MDMP-not-a-real-dump").unwrap();
        let attachments = if with_minidump {
            vec![crate::diagnostic_package::AttachmentInput {
                name: "crash.dmp".to_owned(),
                path: minidump_path,
                media_type: "application/octet-stream".to_owned(),
                kind: AttachmentKind::Minidump,
            }]
        } else {
            Vec::new()
        };
        let output = dir.join("incident.cognia-diagnostic");
        create_diagnostic_package(
            &output,
            DiagnosticPackageInput {
                incident_id: Uuid::new_v4(),
                created_at: Utc::now(),
                build_id: "1.2.3".to_owned(),
                app_version: "1.2.3".to_owned(),
                platform: "macos".to_owned(),
                events: vec![
                    serde_json::json!({"kind": "log", "message": "one"}),
                    serde_json::json!({"kind": "crash", "stackFrames": ["a", "b"]}),
                ],
                attachments,
                source_watermarks: Default::default(),
                missing_sources: Default::default(),
                redaction_version: "client-v1".to_owned(),
            },
            identity().signing_key(),
        )
        .unwrap();
        output
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(&[0xff, 0xef, 0xbf]), "/++/");
    }

    #[test]
    fn installation_id_is_derived_stably_from_the_public_key() {
        let first = identity().installation_id();
        assert_eq!(first, identity().installation_id());
        assert!(first.starts_with("inst_"));
        assert_eq!(first.len(), "inst_".len() + 32);
        // A different key is a different installation.
        let other = InstallationIdentity::from_signing_key(SigningKey::from_bytes(&[8_u8; 32]));
        assert_ne!(first, other.installation_id());
    }

    #[test]
    fn a_created_key_is_reloaded_rather_than_regenerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = installation_key_path(dir.path());
        let first = InstallationIdentity::load_or_create(&path).unwrap();
        let second = InstallationIdentity::load_or_create(&path).unwrap();
        // Losing the key would cost the ability to withdraw prior submissions.
        assert_eq!(first.installation_id(), second.installation_id());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn the_proof_message_is_the_exact_string_the_service_reconstructs() {
        let identity = identity();
        let target = target();
        let body = build_installation_proof_body(&identity, &target, "nonce-value", 1_700_000_000);
        assert_eq!(body["tenantId"], serde_json::json!(target.tenant_id));
        assert_eq!(body["installationId"], serde_json::json!(identity.installation_id()));
        assert_eq!(body["nonce"], serde_json::json!("nonce-value"));
        assert_eq!(body["timestamp"], serde_json::json!(1_700_000_000_i64));

        // Verify against the message layout `verify_installation_signature` is
        // handed on the other side. A change to either half breaks this.
        let expected = format!(
            "{}\n{}\n{}\nnonce-value\n1700000000",
            target.tenant_id,
            target.project_id,
            identity.installation_id()
        );
        let signature_bytes = base64_decode(body["signature"].as_str().unwrap());
        let signature =
            ed25519_dalek::Signature::from_slice(&signature_bytes).expect("signature parses");
        use ed25519_dalek::Verifier;
        identity
            .signing_key()
            .verifying_key()
            .verify(expected.as_bytes(), &signature)
            .expect("proof verifies against the reconstructed message");
    }

    fn base64_decode(value: &str) -> Vec<u8> {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buffer = 0_u32;
        let mut bits = 0_u32;
        for byte in value.bytes().filter(|byte| *byte != b'=') {
            let index = ALPHABET.iter().position(|c| *c == byte).unwrap() as u32;
            buffer = (buffer << 6) | index;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
            }
        }
        out
    }

    #[test]
    fn a_package_becomes_one_part_per_entry_with_processing_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), true);
        let (manifest, parts) = read_package_parts(&package).unwrap();
        assert_eq!(manifest.build_id(), "1.2.3");

        let kinds: Vec<&str> = parts.iter().map(|part| part.artifact_kind).collect();
        // Manifest first, then the events stream, then the attachments. The
        // kinds are what make the service symbolicate and extract frames at
        // all — one opaque `attachment` yields neither.
        assert_eq!(kinds, vec!["manifest", "events", "minidump"]);
        assert_eq!(
            parts.iter().map(|part| part.part_number).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        for part in &parts {
            assert_eq!(hex::encode(Sha256::digest(&part.bytes)), part.sha256);
        }
    }

    #[test]
    fn a_package_without_a_minidump_still_carries_its_events() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), false);
        let (_, parts) = read_package_parts(&package).unwrap();
        assert_eq!(
            parts.iter().map(|part| part.artifact_kind).collect::<Vec<_>>(),
            vec!["manifest", "events"]
        );
    }

    #[test]
    fn events_are_counted_rather_than_declared_as_zero() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), false);
        let (_, parts) = read_package_parts(&package).unwrap();
        let events = parts
            .iter()
            .find(|part| part.artifact_kind == "events")
            .unwrap();
        assert_eq!(count_events(&events.bytes).unwrap(), 2);
        // Empty stays zero rather than counting a phantom trailing record.
        let empty = zstd::stream::encode_all(&b""[..], 1).unwrap();
        assert_eq!(count_events(&empty).unwrap(), 0);
    }

    #[test]
    fn submission_creates_uploads_every_part_and_completes() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), true);
        let transport = RecordingTransport::new(vec![
            (
                201,
                r#"{"incident":{"id":"inc-1"},"created":true,"deletionCredential":"del_x"}"#,
            ),
            (200, r#"{"incidentId":"inc-1","parts":[],"storedBytes":0}"#),
            (201, r#"{"partNumber":1}"#),
            (201, r#"{"partNumber":2}"#),
            (201, r#"{"partNumber":3}"#),
            (
                200,
                r#"{"supportCode":"ABC123","clientState":"processing","processingState":"received"}"#,
            ),
        ]);
        let receipt = submit_package(
            &transport,
            &target(),
            "grant-token",
            SubmissionRequest {
                package: &package,
                module: "cognia-desktop",
                exception: "panic",
            },
        )
        .unwrap();

        assert_eq!(receipt.incident_id, "inc-1");
        assert_eq!(receipt.support_code, "ABC123");
        assert_eq!(receipt.deletion_credential.as_deref(), Some("del_x"));
        assert!(receipt.created);
        assert_eq!(receipt.uploaded_parts, 3);
        assert_eq!(receipt.resumed_parts, 0);

        let seen = transport.seen.borrow();
        assert_eq!(seen[0].method, "POST");
        assert_eq!(seen[0].url, "https://diag.example.com/v1/incidents");
        assert_eq!(seen[2].artifact_kind.as_deref(), Some("manifest"));
        assert_eq!(seen[3].artifact_kind.as_deref(), Some("events"));
        assert_eq!(seen[4].artifact_kind.as_deref(), Some("minidump"));
        // Every request carries the grant, including the resume probe.
        assert!(seen
            .iter()
            .all(|request| request.header("authorization") == Some("Bearer grant-token")));
    }

    #[test]
    fn a_resumed_submission_skips_parts_the_service_already_holds() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), true);
        let (_, parts) = read_package_parts(&package).unwrap();
        let inventory = serde_json::json!({
            "incidentId": "inc-1",
            "parts": [
                {"partNumber": 1, "sourceSha256": parts[0].sha256},
                {"partNumber": 2, "sourceSha256": parts[1].sha256},
                // Part 3 landed with the wrong checksum — a truncated retry.
                {"partNumber": 3, "sourceSha256": "0".repeat(64)},
            ],
            "storedBytes": 10
        });
        let transport = RecordingTransport::new(vec![
            (201, r#"{"incident":{"id":"inc-1"},"created":false}"#),
            (200, &inventory.to_string()),
            (201, r#"{"partNumber":3}"#),
            (200, r#"{"supportCode":"ABC123"}"#),
        ]);
        let receipt = submit_package(
            &transport,
            &target(),
            "grant-token",
            SubmissionRequest {
                package: &package,
                module: "cognia-desktop",
                exception: "panic",
            },
        )
        .unwrap();
        assert_eq!(receipt.resumed_parts, 2);
        assert_eq!(receipt.uploaded_parts, 1);
        // A resumed incident must not hand back a credential that cannot verify.
        assert!(!receipt.created);
        assert_eq!(receipt.deletion_credential, None);
    }

    #[test]
    fn the_intake_kill_switch_is_distinguishable_from_a_rejection() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), false);
        let transport =
            RecordingTransport::new(vec![(503, r#"{"error":{"code":"ingest_disabled"}}"#)]);
        let error = submit_package(
            &transport,
            &target(),
            "grant-token",
            SubmissionRequest {
                package: &package,
                module: "cognia-desktop",
                exception: "panic",
            },
        )
        .unwrap_err();
        assert!(error.is_ingest_disabled());
        assert!(!error.is_unauthorized());
        assert_eq!(error.code(), Some("ingest_disabled"));
    }

    #[test]
    fn an_expired_grant_is_reported_as_such_rather_than_as_a_transport_failure() {
        let transport =
            RecordingTransport::new(vec![(401, r#"{"error":{"code":"invalid_upload_grant"}}"#)]);
        let error = withdraw_consent(&transport, &target(), "stale", "inc-1").unwrap_err();
        assert!(error.is_unauthorized());
    }

    #[test]
    fn a_204_is_success_and_a_gateway_body_is_not_mistaken_for_one() {
        let transport = RecordingTransport::new(vec![(204, "")]);
        withdraw_consent(&transport, &target(), "grant", "inc-1").unwrap();

        let gateway = RecordingTransport::new(vec![(502, "<html>bad gateway</html>")]);
        let error = withdraw_consent(&gateway, &target(), "grant", "inc-1").unwrap_err();
        assert!(matches!(error, SubmitError::Malformed { status: 502 }));
    }

    #[test]
    fn an_unreachable_service_is_never_mistaken_for_a_refusal() {
        let transport = RecordingTransport::new(Vec::new());
        let error = delete_incident(&transport, &target(), "grant", "inc-1").unwrap_err();
        assert!(matches!(error, SubmitError::Transport(_)));
        assert_eq!(error.code(), None);
        assert!(!error.is_ingest_disabled());
    }

    #[test]
    fn a_tampered_package_is_refused_before_anything_leaves_the_machine() {
        let dir = tempfile::tempdir().unwrap();
        let package = sample_package(dir.path(), false);
        let mut bytes = std::fs::read(&package).unwrap();
        let last = bytes.len() - 200;
        bytes[last] ^= 0xff;
        std::fs::write(&package, bytes).unwrap();
        assert!(read_package_parts(&package).is_err());
    }
}
