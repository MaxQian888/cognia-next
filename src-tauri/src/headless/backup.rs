//! Cloud-neutral, application-encrypted headless backups.
//!
//! The transport speaks the S3 HTTP contract directly with SigV4, so AWS,
//! MinIO, R2, and other S3-compatible endpoints share one implementation.

use aes_gcm::aead::{Aead, KeyInit as AeadKeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use chrono::{DateTime, Utc};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use hmac::{Hmac, KeyInit as HmacKeyInit, Mac};
use rand::RngCore;
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tar::{Archive, Builder};
use tempfile::Builder as TempBuilder;
use url::Url;

const ENVELOPE_MAGIC: &[u8; 5] = b"CGBK1";
const NONCE_LEN: usize = 12;
const BACKUP_SCHEMA: u32 = 1;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupManifest {
    pub schema: u32,
    pub build: String,
    pub backup_id: String,
    pub created_at: DateTime<Utc>,
    pub key_version: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPointReport {
    pub id: String,
    pub kind: String,
    pub manifest_sha256: String,
    pub size_bytes: i64,
    pub verified: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupResult {
    pub recovery_points: Vec<RecoveryPointReport>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreResult {
    pub recovery_point_id: String,
    pub destination: PathBuf,
    pub manifest_sha256: String,
    pub file_count: usize,
    pub read_only_smoke: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationResult {
    pub data_directory: PathBuf,
    pub file_count: usize,
    pub sqlite_integrity: bool,
}

#[derive(Clone)]
struct S3Config {
    endpoint: Url,
    region: String,
    bucket: String,
    path_style: bool,
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
    prefix: String,
}

impl S3Config {
    async fn from_env() -> Result<Option<Self>, String> {
        let Some(endpoint) = env_nonempty("COGNIA_S3_ENDPOINT") else {
            return Ok(None);
        };
        let endpoint = Url::parse(&endpoint).map_err(|error| format!("S3 endpoint: {error}"))?;
        if endpoint.scheme() != "https" && !endpoint.host_str().is_some_and(is_loopback_host) {
            return Err("S3 endpoint must use HTTPS except on loopback".into());
        }
        let access_key = read_required_secret_file("COGNIA_S3_ACCESS_KEY_FILE").await?;
        let secret_key = read_required_secret_file("COGNIA_S3_SECRET_KEY_FILE").await?;
        let session_token = match env_nonempty("COGNIA_S3_SESSION_TOKEN_FILE") {
            Some(path) => Some(read_secret_file(Path::new(&path)).await?),
            None => None,
        };
        Ok(Some(Self {
            endpoint,
            region: env_nonempty("COGNIA_S3_REGION").unwrap_or_else(|| "auto".into()),
            bucket: required_env("COGNIA_S3_BUCKET")?,
            path_style: env_nonempty("COGNIA_S3_PATH_STYLE")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
            access_key,
            secret_key,
            session_token,
            prefix: env_nonempty("COGNIA_BACKUP_PREFIX")
                .unwrap_or_else(|| "cognia".into())
                .trim_matches('/')
                .to_owned(),
        }))
    }

    fn object_key(&self, backup_id: &str) -> String {
        if self.prefix.is_empty() {
            format!("{backup_id}.cgbk")
        } else {
            format!("{}/{backup_id}.cgbk", self.prefix)
        }
    }

    fn object_url(&self, key: &str) -> Result<Url, String> {
        let mut url = self.endpoint.clone();
        let encoded_key = key
            .split('/')
            .map(percent_encode)
            .collect::<Vec<_>>()
            .join("/");
        let base_path = url.path().trim_end_matches('/').to_string();
        if self.path_style {
            url.set_path(&format!(
                "{base_path}/{}/{}",
                percent_encode(&self.bucket),
                encoded_key
            ));
        } else {
            let host = url
                .host_str()
                .ok_or_else(|| "S3 endpoint has no host".to_string())?;
            url.set_host(Some(&format!("{}.{}", self.bucket, host)))
                .map_err(|_| "S3 bucket cannot be used as a virtual host".to_string())?;
            url.set_path(&format!("{base_path}/{encoded_key}"));
        }
        Ok(url)
    }

    async fn put(&self, key: &str, body: Vec<u8>) -> Result<(), String> {
        let url = self.object_url(key)?;
        let response = self.signed_request(reqwest::Method::PUT, url, body).await?;
        if !response.status().is_success() {
            return Err(format!("S3 PUT failed with {}", response.status()));
        }
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        let url = self.object_url(key)?;
        let response = self
            .signed_request(reqwest::Method::GET, url, Vec::new())
            .await?;
        if !response.status().is_success() {
            return Err(format!("S3 GET failed with {}", response.status()));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("read S3 object: {error}"))
    }

    async fn signed_request(
        &self,
        method: reqwest::Method,
        url: Url,
        body: Vec<u8>,
    ) -> Result<reqwest::Response, String> {
        let now = Utc::now();
        let body_hash = hex::encode(Sha256::digest(&body));
        let signed = sign_v4(
            &method,
            &url,
            &body_hash,
            now,
            &self.region,
            &self.access_key,
            &self.secret_key,
            self.session_token.as_deref(),
        )?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|error| format!("build S3 client: {error}"))?;
        let mut request = client
            .request(method, url)
            .header("x-amz-date", signed.amz_date)
            .header("x-amz-content-sha256", body_hash)
            .header("authorization", signed.authorization)
            .body(body);
        if let Some(token) = &self.session_token {
            request = request.header("x-amz-security-token", token);
        }
        request
            .send()
            .await
            .map_err(|error| format!("S3 request: {error}"))
    }
}

struct SignedHeaders {
    amz_date: String,
    authorization: String,
}

#[allow(clippy::too_many_arguments)]
fn sign_v4(
    method: &reqwest::Method,
    url: &Url,
    body_hash: &str,
    now: DateTime<Utc>,
    region: &str,
    access_key: &str,
    secret_key: &str,
    session_token: Option<&str>,
) -> Result<SignedHeaders, String> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let host = canonical_host(url)?;
    let mut canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{body_hash}\nx-amz-date:{amz_date}\n");
    let mut signed_headers = "host;x-amz-content-sha256;x-amz-date".to_string();
    if let Some(token) = session_token {
        canonical_headers.push_str(&format!("x-amz-security-token:{}\n", token.trim()));
        signed_headers.push_str(";x-amz-security-token");
    }
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.as_str(),
        canonical_uri(url),
        url.query().unwrap_or_default(),
        canonical_headers,
        signed_headers,
        body_hash
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let date_key = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes())?;
    let region_key = hmac_sha256(&date_key, region.as_bytes())?;
    let service_key = hmac_sha256(&region_key, b"s3")?;
    let signing_key = hmac_sha256(&service_key, b"aws4_request")?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    Ok(SignedHeaders {
        amz_date,
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
        ),
    })
}

fn hmac_sha256(key: &[u8], input: &[u8]) -> Result<[u8; 32], String> {
    let mut mac = <Hmac<Sha256> as HmacKeyInit>::new_from_slice(key)
        .map_err(|_| "invalid HMAC key".to_string())?;
    mac.update(input);
    Ok(mac.finalize().into_bytes().into())
}

pub async fn create_backup(data_dir: &Path, backup_id: &str) -> Result<BackupResult, String> {
    validate_identifier(backup_id)?;
    let key_version = required_env("COGNIA_BACKUP_KEY_VERSION")?;
    validate_identifier(&key_version)?;
    let key = load_backup_key(&key_version).await?;
    let cache_dir = data_dir.join("backups");
    fs::create_dir_all(&cache_dir).map_err(|error| format!("create backup cache: {error}"))?;
    let archive = build_archive(data_dir, backup_id, &key_version)?;
    let manifest_hash = hex::encode(Sha256::digest(&archive.manifest_bytes));
    let envelope = encrypt_archive(&archive.archive_bytes, &key, &key_version)?;
    let local_path = cache_dir.join(format!("{backup_id}.cgbk"));
    atomic_write(&local_path, &envelope)?;

    let points = vec![RecoveryPointReport {
        id: backup_id.to_owned(),
        kind: "object-store".into(),
        manifest_sha256: manifest_hash,
        size_bytes: i64::try_from(envelope.len()).unwrap_or(i64::MAX),
        verified: true,
        created_at: archive.manifest.created_at,
    }];
    if let Some(s3) = S3Config::from_env().await? {
        s3.put(&s3.object_key(backup_id), envelope).await?;
    } else if env_nonempty("COGNIA_REQUIRE_OBJECT_BACKUP")
        .is_some_and(|value| value.eq_ignore_ascii_case("true"))
    {
        return Err("production backup requires an S3-compatible object store".into());
    }
    Ok(BackupResult {
        recovery_points: points,
    })
}

pub async fn restore_backup(
    data_dir: &Path,
    recovery_point_id: &str,
    destination: &Path,
    read_only_smoke: bool,
) -> Result<RestoreResult, String> {
    validate_identifier(recovery_point_id)?;
    validate_destination(data_dir, destination)?;
    let local_path = data_dir
        .join("backups")
        .join(format!("{recovery_point_id}.cgbk"));
    let envelope = match tokio::fs::read(&local_path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let s3 = S3Config::from_env().await?.ok_or_else(|| {
                "recovery point is not cached and S3 is not configured".to_string()
            })?;
            s3.get(&s3.object_key(recovery_point_id)).await?
        }
        Err(error) => return Err(format!("read recovery point: {error}")),
    };
    let key_version = envelope_key_version(&envelope)?;
    let key = load_backup_key(&key_version).await?;
    let archive_bytes = decrypt_archive(&envelope, &key)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "restore destination must have a parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create restore parent: {error}"))?;
    let staging = TempBuilder::new()
        .prefix(".cognia-restore-")
        .tempdir_in(parent)
        .map_err(|error| format!("create restore staging: {error}"))?;
    let unpacked = staging.path().join("unpacked");
    fs::create_dir(&unpacked).map_err(|error| format!("create unpack directory: {error}"))?;
    Archive::new(GzDecoder::new(archive_bytes.as_slice()))
        .unpack(&unpacked)
        .map_err(|error| format!("unpack recovery point: {error}"))?;
    let manifest_bytes = fs::read(unpacked.join("manifest.json"))
        .map_err(|error| format!("read backup manifest: {error}"))?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("parse backup manifest: {error}"))?;
    if manifest.schema != BACKUP_SCHEMA || manifest.backup_id != recovery_point_id {
        return Err("backup manifest identity or schema does not match".into());
    }
    let restored_data = unpacked.join("data");
    verify_manifest(&restored_data, &manifest)?;
    if read_only_smoke {
        sqlite_integrity_smoke(&restored_data)?;
    }
    if destination.exists() {
        copy_verified_restore(&restored_data, destination)?;
    } else {
        fs::rename(&restored_data, destination)
            .map_err(|error| format!("activate restored directory: {error}"))?;
    }
    verify_manifest(destination, &manifest)?;
    if read_only_smoke {
        sqlite_integrity_smoke(destination)?;
    }
    Ok(RestoreResult {
        recovery_point_id: recovery_point_id.to_owned(),
        destination: destination.to_owned(),
        manifest_sha256: hex::encode(Sha256::digest(&manifest_bytes)),
        file_count: manifest.files.len(),
        read_only_smoke,
    })
}

pub fn verify_data_directory(data_directory: &Path) -> Result<VerificationResult, String> {
    if !data_directory.is_absolute() || !data_directory.is_dir() {
        return Err("verification target must be an existing absolute directory".into());
    }
    let mut file_count = 0;
    visit_files(data_directory, &mut |_| {
        file_count += 1;
        Ok(())
    })?;
    if file_count == 0 {
        return Err("verification target is empty".into());
    }
    sqlite_integrity_smoke(data_directory)?;
    Ok(VerificationResult {
        data_directory: data_directory.to_owned(),
        file_count,
        sqlite_integrity: true,
    })
}

struct BuiltArchive {
    archive_bytes: Vec<u8>,
    manifest_bytes: Vec<u8>,
    manifest: BackupManifest,
}

fn build_archive(
    data_dir: &Path,
    backup_id: &str,
    key_version: &str,
) -> Result<BuiltArchive, String> {
    let staging = tempfile::tempdir().map_err(|error| format!("create backup staging: {error}"))?;
    let staged_data = staging.path().join("data");
    fs::create_dir(&staged_data).map_err(|error| format!("create staged data: {error}"))?;
    copy_consistent_tree(data_dir, data_dir, &staged_data)?;
    let mut files = manifest_files(&staged_data)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let manifest = BackupManifest {
        schema: BACKUP_SCHEMA,
        build: env!("CARGO_PKG_VERSION").into(),
        backup_id: backup_id.to_owned(),
        created_at: Utc::now(),
        key_version: key_version.to_owned(),
        files,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("serialize manifest: {error}"))?;
    fs::write(staging.path().join("manifest.json"), &manifest_bytes)
        .map_err(|error| format!("write manifest: {error}"))?;
    let mut archive_bytes = Vec::new();
    {
        let encoder = GzEncoder::new(&mut archive_bytes, Compression::default());
        let mut tar = Builder::new(encoder);
        tar.append_path_with_name(staging.path().join("manifest.json"), "manifest.json")
            .map_err(|error| format!("archive manifest: {error}"))?;
        tar.append_dir_all("data", &staged_data)
            .map_err(|error| format!("archive data: {error}"))?;
        let encoder = tar
            .into_inner()
            .map_err(|error| format!("finish tar: {error}"))?;
        encoder
            .finish()
            .map_err(|error| format!("finish gzip: {error}"))?;
    }
    Ok(BuiltArchive {
        archive_bytes,
        manifest_bytes,
        manifest,
    })
}

fn copy_consistent_tree(root: &Path, current: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|error| format!("read data directory: {error}"))? {
        let entry = entry.map_err(|error| format!("read data entry: {error}"))?;
        let source = entry.path();
        let relative = source
            .strip_prefix(root)
            .map_err(|_| "data path escaped backup root".to_string())?;
        if relative
            .components()
            .next()
            .is_some_and(|component| component.as_os_str() == "backups")
        {
            continue;
        }
        let metadata = entry
            .file_type()
            .map_err(|error| format!("inspect data entry: {error}"))?;
        let target = destination.join(relative);
        if metadata.is_dir() {
            fs::create_dir_all(&target).map_err(|error| format!("stage directory: {error}"))?;
            copy_consistent_tree(root, &source, destination)?;
        } else if metadata.is_file() {
            if is_sqlite_sidecar(&source) {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("stage parent: {error}"))?;
            }
            if is_sqlite_database(&source)? {
                sqlite_online_copy(&source, &target)?;
            } else {
                fs::copy(&source, &target).map_err(|error| format!("stage file: {error}"))?;
            }
        }
    }
    Ok(())
}

fn sqlite_online_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let source = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("open SQLite source {}: {error}", source.display()))?;
    source
        .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")
        .map_err(|error| format!("checkpoint SQLite source: {error}"))?;
    let mut destination = Connection::open(destination)
        .map_err(|error| format!("open SQLite destination: {error}"))?;
    let backup = Backup::new(&source, &mut destination)
        .map_err(|error| format!("start SQLite backup: {error}"))?;
    backup
        .run_to_completion(128, Duration::from_millis(5), None)
        .map_err(|error| format!("copy SQLite database: {error}"))
}

fn sqlite_integrity_smoke(root: &Path) -> Result<(), String> {
    visit_files(root, &mut |path| {
        if !is_sqlite_database(path)? {
            return Ok(());
        }
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("open restored SQLite {}: {error}", path.display()))?;
        let result: String = connection
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|error| format!("integrity-check SQLite {}: {error}", path.display()))?;
        if result != "ok" {
            return Err(format!(
                "SQLite integrity check failed for {}",
                path.display()
            ));
        }
        Ok(())
    })
}

fn manifest_files(root: &Path) -> Result<Vec<ManifestFile>, String> {
    let mut files = Vec::new();
    visit_files(root, &mut |path| {
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "manifest path escaped staging root".to_string())?;
        let path_string = relative
            .to_str()
            .ok_or_else(|| "backup paths must be UTF-8".to_string())?
            .replace('\\', "/");
        let bytes = fs::read(path).map_err(|error| format!("hash staged file: {error}"))?;
        files.push(ManifestFile {
            path: path_string,
            sha256: hex::encode(Sha256::digest(&bytes)),
            size_bytes: bytes.len() as u64,
        });
        Ok(())
    })?;
    Ok(files)
}

fn verify_manifest(root: &Path, manifest: &BackupManifest) -> Result<(), String> {
    let mut actual = manifest_files(root)?;
    actual.sort_by(|left, right| left.path.cmp(&right.path));
    let mut expected = manifest.files.clone();
    expected.sort_by(|left, right| left.path.cmp(&right.path));
    if actual != expected {
        return Err("restored files do not match the backup manifest".into());
    }
    Ok(())
}

fn visit_files(
    root: &Path,
    visitor: &mut impl FnMut(&Path) -> Result<(), String>,
) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|error| format!("read directory: {error}"))? {
        let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect directory entry: {error}"))?;
        if file_type.is_dir() {
            visit_files(&entry.path(), visitor)?;
        } else if file_type.is_file() {
            visitor(&entry.path())?;
        }
    }
    Ok(())
}

fn is_sqlite_database(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|error| format!("inspect file: {error}"))?;
    let mut header = [0_u8; 16];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("inspect file header: {error}"))?;
    Ok(read == header.len() && &header == b"SQLite format 3\0")
}

fn is_sqlite_sidecar(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    name.ends_with("-wal") || name.ends_with("-shm") || name.ends_with("-journal")
}

fn encrypt_archive(archive: &[u8], key: &[u8; 32], key_version: &str) -> Result<Vec<u8>, String> {
    let version = key_version.as_bytes();
    let version_len = u16::try_from(version.len()).map_err(|_| "key version is too long")?;
    let mut nonce = [0_u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "invalid backup key")?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), archive)
        .map_err(|_| "encrypt backup archive".to_string())?;
    let mut envelope =
        Vec::with_capacity(ENVELOPE_MAGIC.len() + 2 + version.len() + NONCE_LEN + ciphertext.len());
    envelope.extend_from_slice(ENVELOPE_MAGIC);
    envelope.extend_from_slice(&version_len.to_be_bytes());
    envelope.extend_from_slice(version);
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

fn envelope_key_version(envelope: &[u8]) -> Result<String, String> {
    if !envelope.starts_with(ENVELOPE_MAGIC) || envelope.len() < ENVELOPE_MAGIC.len() + 2 {
        return Err("backup envelope has an unsupported format".into());
    }
    let offset = ENVELOPE_MAGIC.len();
    let len = u16::from_be_bytes([envelope[offset], envelope[offset + 1]]) as usize;
    let end = offset + 2 + len;
    let version = envelope
        .get(offset + 2..end)
        .ok_or_else(|| "backup envelope key version is truncated".to_string())?;
    std::str::from_utf8(version)
        .map(str::to_owned)
        .map_err(|_| "backup envelope key version is not UTF-8".to_string())
}

fn decrypt_archive(envelope: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let version = envelope_key_version(envelope)?;
    let nonce_start = ENVELOPE_MAGIC.len() + 2 + version.len();
    let nonce_end = nonce_start + NONCE_LEN;
    let nonce = envelope
        .get(nonce_start..nonce_end)
        .ok_or_else(|| "backup envelope nonce is truncated".to_string())?;
    let ciphertext = envelope
        .get(nonce_end..)
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| "backup envelope ciphertext is empty".to_string())?;
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| "invalid backup key")?
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "backup authentication failed".to_string())
}

async fn load_backup_key(version: &str) -> Result<[u8; 32], String> {
    let path = if let Some(directory) = env_nonempty("COGNIA_BACKUP_KEY_DIR") {
        PathBuf::from(directory).join(format!("{version}.key"))
    } else {
        PathBuf::from(required_env("COGNIA_BACKUP_KEY_FILE")?)
    };
    let raw = read_secret_file(&path).await?;
    let decoded = hex::decode(raw).map_err(|_| "backup key must be 64 hexadecimal characters")?;
    decoded
        .try_into()
        .map_err(|_| "backup key must decode to 32 bytes".to_string())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("cgbk.tmp");
    let mut file = File::create(&temporary).map_err(|error| format!("create backup: {error}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("persist backup: {error}"))?;
    fs::rename(temporary, path).map_err(|error| format!("publish backup: {error}"))
}

fn validate_destination(data_dir: &Path, destination: &Path) -> Result<(), String> {
    if !destination.is_absolute() || destination.parent().is_none() || destination == Path::new("/")
    {
        return Err("restore destination must be a non-root absolute path".into());
    }
    if destination == data_dir
        || destination.starts_with(data_dir)
        || data_dir.starts_with(destination)
    {
        return Err("restore destination must be separate from the live data directory".into());
    }
    if destination.exists() {
        if !destination.is_dir() {
            return Err(
                "restore destination must be a new directory or empty mounted volume".into(),
            );
        }
        let mut entries = fs::read_dir(destination)
            .map_err(|error| format!("inspect restore destination: {error}"))?;
        if entries
            .next()
            .transpose()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("restore destination is not empty; in-place restore is forbidden".into());
        }
    }
    Ok(())
}

fn copy_verified_restore(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|error| format!("read restore staging: {error}"))? {
        let entry = entry.map_err(|error| format!("read restore entry: {error}"))?;
        let target = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("inspect restore entry: {error}"))?;
        if file_type.is_dir() {
            fs::create_dir(&target)
                .map_err(|error| format!("create restored directory: {error}"))?;
            copy_verified_restore(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|error| format!("copy restored file: {error}"))?;
        }
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        || matches!(value, "." | "..")
    {
        return Err("backup identifier must be a safe stable identifier".into());
    }
    Ok(())
}

fn canonical_uri(url: &Url) -> String {
    if url.path().is_empty() {
        "/".into()
    } else {
        url.path().to_owned()
    }
}

fn canonical_host(url: &Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn percent_encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn required_env(name: &str) -> Result<String, String> {
    env_nonempty(name).ok_or_else(|| format!("{name} is required"))
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

async fn read_required_secret_file(env_name: &str) -> Result<String, String> {
    let path = PathBuf::from(required_env(env_name)?);
    read_secret_file(&path).await
}

async fn read_secret_file(path: &Path) -> Result<String, String> {
    let value = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| format!("read secret file {}: {error}", path.display()))?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Err(format!("secret file {} is empty", path.display()));
    }
    Ok(value)
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn archive_round_trip_uses_online_sqlite_copy_and_rejects_tampering() {
        let source = tempfile::tempdir().unwrap();
        let db_path = source.path().join("cognia-server.sqlite");
        let connection = Connection::open(&db_path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(value TEXT); INSERT INTO items VALUES ('durable');")
            .unwrap();
        fs::write(source.path().join("config.json"), b"{\"ok\":true}").unwrap();

        let built = build_archive(source.path(), "backup-1", "key-v1").unwrap();
        assert_eq!(built.manifest.schema, BACKUP_SCHEMA);
        assert_eq!(built.manifest.files.len(), 2);
        assert!(built
            .manifest
            .files
            .iter()
            .all(|file| !file.path.ends_with("-wal")));

        let key = [7_u8; 32];
        let envelope = encrypt_archive(&built.archive_bytes, &key, "key-v1").unwrap();
        assert_eq!(envelope_key_version(&envelope).unwrap(), "key-v1");
        assert_eq!(
            decrypt_archive(&envelope, &key).unwrap(),
            built.archive_bytes
        );
        let mut tampered = envelope;
        *tampered.last_mut().unwrap() ^= 1;
        assert!(decrypt_archive(&tampered, &key).is_err());
    }

    #[test]
    fn sigv4_is_deterministic_and_signs_session_tokens() {
        let url = Url::parse("https://bucket.s3.example.com/cognia/backup.cgbk").unwrap();
        let signed = sign_v4(
            &reqwest::Method::PUT,
            &url,
            &hex::encode(Sha256::digest(b"payload")),
            DateTime::parse_from_rfc3339("2026-08-01T10:11:12Z")
                .unwrap()
                .with_timezone(&Utc),
            "auto",
            "access",
            "secret",
            Some("session-token"),
        )
        .unwrap();
        assert_eq!(signed.amz_date, "20260801T101112Z");
        assert!(signed
            .authorization
            .contains("Credential=access/20260801/auto/s3/aws4_request"));
        assert!(signed.authorization.contains("x-amz-security-token"));
    }

    #[test]
    fn restore_never_targets_live_or_parent_directories() {
        let root = Path::new("/srv/cognia");
        assert!(validate_destination(root, Path::new("/srv/cognia")).is_err());
        assert!(validate_destination(root, Path::new("/srv")).is_err());
        assert!(validate_destination(root, Path::new("/srv/cognia/restore")).is_err());
        assert!(validate_destination(root, Path::new("relative")).is_err());
    }

    #[test]
    fn object_urls_support_path_style_and_virtual_host_endpoints() {
        let base = S3Config {
            endpoint: Url::parse("https://s3.example.com/base").unwrap(),
            region: "auto".into(),
            bucket: "cognia-backups".into(),
            path_style: true,
            access_key: "access".into(),
            secret_key: "secret".into(),
            session_token: None,
            prefix: "tenant one".into(),
        };
        assert_eq!(
            base.object_url(&base.object_key("backup-1"))
                .unwrap()
                .as_str(),
            "https://s3.example.com/base/cognia-backups/tenant%20one/backup-1.cgbk"
        );
        let virtual_host = S3Config {
            path_style: false,
            ..base
        };
        assert_eq!(
            virtual_host
                .object_url(&virtual_host.object_key("backup-1"))
                .unwrap()
                .as_str(),
            "https://cognia-backups.s3.example.com/base/tenant%20one/backup-1.cgbk"
        );
    }

    #[tokio::test]
    async fn complete_backup_and_new_directory_restore_preserve_verified_data() {
        let _guard = ENV_LOCK.lock().unwrap();
        let source = tempfile::tempdir().unwrap();
        let destination_parent = tempfile::tempdir().unwrap();
        let secrets = tempfile::tempdir().unwrap();
        let key_file = secrets.path().join("backup.key");
        fs::write(&key_file, hex::encode([9_u8; 32])).unwrap();
        fs::write(source.path().join("state.json"), b"{\"durable\":true}").unwrap();
        let database = Connection::open(source.path().join("cognia-server.sqlite")).unwrap();
        database
            .execute_batch("CREATE TABLE durable(value TEXT); INSERT INTO durable VALUES ('yes');")
            .unwrap();
        drop(database);

        std::env::set_var("COGNIA_BACKUP_KEY_VERSION", "key-v1");
        std::env::set_var("COGNIA_BACKUP_KEY_FILE", &key_file);
        std::env::remove_var("COGNIA_BACKUP_KEY_DIR");
        std::env::remove_var("COGNIA_S3_ENDPOINT");
        std::env::remove_var("COGNIA_REQUIRE_OBJECT_BACKUP");

        let backup = create_backup(source.path(), "recovery-1").await.unwrap();
        assert_eq!(backup.recovery_points.len(), 1);
        assert!(backup.recovery_points[0].verified);
        let destination = destination_parent.path().join("restored-data");
        let restored = restore_backup(source.path(), "recovery-1", &destination, true)
            .await
            .unwrap();
        assert!(restored.read_only_smoke);
        assert_eq!(
            fs::read(destination.join("state.json")).unwrap(),
            b"{\"durable\":true}"
        );
        let restored_db = Connection::open(destination.join("cognia-server.sqlite")).unwrap();
        let value: String = restored_db
            .query_row("SELECT value FROM durable", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, "yes");

        std::env::remove_var("COGNIA_BACKUP_KEY_VERSION");
        std::env::remove_var("COGNIA_BACKUP_KEY_FILE");
    }
}
