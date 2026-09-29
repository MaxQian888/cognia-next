//! The Chrome extension store the local Chromium loads (ADR-0201).
//!
//! Layout: `<app_data>/browser/extensions/<dir>/` holds each unpacked
//! extension and `registry.json` the metadata (id, name, version, enabled,
//! source, install time, permissions, icons, popup and options paths). The
//! enabled directories become `--load-extension` for local sessions.
//!
//! Sources:
//! - **Chrome Web Store** by id or store URL: the CRX comes from the public
//!   update endpoint (`response=redirect`), through the user's proxy policy.
//! - **`.crx` file**.
//! - **Unpacked directory**: copied, never referenced in place.
//!
//! A CRX is accepted only as CRX3 (`Cr24`, version 3) whose protobuf header
//! (`CrxFileHeader`, parsed by hand) carries `signed_header_data.crx_id`, at
//! least one proof whose public key hashes to that id, and whose every proof
//! (`sha256_with_rsa`, `sha256_with_ecdsa`) verifies over
//! `"CRX3 SignedData\0" ‖ len ‖ signed_header_data ‖ archive`. The id is the
//! first 16 bytes of SHA-256(public key) written with the letters `a`–`p`.
//!
//! Chromium derives an unpacked extension's id from its manifest `key`, or —
//! without one — from the absolute path it was loaded from. So a CRX install
//! writes the CRX's public key into `manifest.json` (the id stays the store
//! id), and a key-less unpacked copy lives at a stable directory whose path
//! determines its id ([`id_for_path`]).
//!
//! Extraction rejects absolute paths, `..`, drive prefixes and symlinks
//! (`zip_path_traversal`), and drops the top-level `_`-prefixed entries
//! (`_metadata`, `__MACOSX`) Chromium refuses to load unpacked, except
//! `_locales`.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const REGISTRY_FILE: &str = "registry.json";
const STAGING_DIR: &str = ".staging";
const MAX_CRX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const CRX3_SIGNATURE_CONTEXT: &[u8] = b"CRX3 SignedData\x00";

/// Public Web Store update endpoint.
pub const WEBSTORE_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";

// ---------------------------------------------------------------- errors

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtensionErrorCode {
    UnsupportedBackend,
    CrxInvalid,
    CrxIdMismatch,
    ZipPathTraversal,
    ManifestInvalid,
    WebstoreUnavailable,
    ExtensionNotFound,
    Io,
}

impl ExtensionErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedBackend => "extensions_unsupported_backend",
            Self::CrxInvalid => "crx_invalid",
            Self::CrxIdMismatch => "crx_id_mismatch",
            Self::ZipPathTraversal => "zip_path_traversal",
            Self::ManifestInvalid => "manifest_invalid",
            Self::WebstoreUnavailable => "webstore_unavailable",
            Self::ExtensionNotFound => "extension_not_found",
            Self::Io => "extension_io_error",
        }
    }
}

/// A typed failure; `Display` is `"<code>: <message>"`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{}: {message}", code.as_str())]
pub struct ExtensionError {
    pub code: ExtensionErrorCode,
    pub message: String,
}

impl ExtensionError {
    pub fn new(code: ExtensionErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn io(context: impl std::fmt::Display, error: std::io::Error) -> Self {
        Self::new(ExtensionErrorCode::Io, format!("{context}: {error}"))
    }
}

type Result<T> = std::result::Result<T, ExtensionError>;

fn crx_invalid(message: impl Into<String>) -> ExtensionError {
    ExtensionError::new(ExtensionErrorCode::CrxInvalid, message)
}

fn manifest_invalid(message: impl Into<String>) -> ExtensionError {
    ExtensionError::new(ExtensionErrorCode::ManifestInvalid, message)
}

// ---------------------------------------------------------------- ids

/// Chromium's id alphabet: each hex nibble `0..f` becomes `a..p`.
pub fn id_from_hash_prefix(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(16)
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .map(|nibble| (b'a' + nibble) as char)
        .collect()
}

/// `crx_file::id_util::GenerateId`: SHA-256 of the input, first 16 bytes.
pub fn id_from_bytes(input: &[u8]) -> String {
    id_from_hash_prefix(&Sha256::digest(input))
}

/// A syntactically valid extension id (32 letters `a`–`p`).
pub fn is_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

/// The bytes Chromium hashes for a path-derived id
/// (`GenerateIdForPath`): UTF-8 on POSIX; on Windows the UTF-16LE code units
/// with an upper-cased drive letter.
pub fn path_id_bytes(path: &str, windows: bool) -> Vec<u8> {
    if !windows {
        return path.as_bytes().to_vec();
    }
    let mut normalized: Vec<char> = path.chars().collect();
    if normalized.len() >= 2 && normalized[1] == ':' && normalized[0].is_ascii_lowercase() {
        normalized[0] = normalized[0].to_ascii_uppercase();
    }
    normalized
        .into_iter()
        .collect::<String>()
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect()
}

/// Strip the `\\?\` verbatim prefix `canonicalize` adds on Windows.
fn strip_verbatim(path: &str) -> &str {
    match path.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest,
        _ => path,
    }
}

/// The id Chromium assigns to a key-less unpacked extension loaded from
/// `dir` (resolved like `MakeAbsoluteFilePath`).
pub fn id_for_path(dir: &Path) -> Result<String> {
    let absolute = dir
        .canonicalize()
        .map_err(|error| ExtensionError::io(dir.display(), error))?;
    let text = absolute.to_string_lossy();
    Ok(id_from_bytes(&path_id_bytes(
        strip_verbatim(&text),
        cfg!(windows),
    )))
}

// ---------------------------------------------------------------- protobuf

/// A minimal protobuf reader for the two CRX3 messages.
struct ProtoReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> ProtoReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn varint(&mut self) -> Result<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or_else(|| crx_invalid("truncated protobuf varint"))?;
            self.offset += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(crx_invalid("protobuf varint is too long"))
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(len)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| crx_invalid("truncated protobuf field"))?;
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        Ok(slice)
    }

    /// Next `(field number, length-delimited payload)`; other wire types are
    /// skipped.
    fn next_bytes_field(&mut self) -> Result<Option<(u64, &'a [u8])>> {
        while self.offset < self.bytes.len() {
            let key = self.varint()?;
            let field = key >> 3;
            match key & 0x7 {
                0 => {
                    self.varint()?;
                }
                1 => {
                    self.take(8)?;
                }
                2 => {
                    let len = usize::try_from(self.varint()?)
                        .map_err(|_| crx_invalid("protobuf length overflow"))?;
                    return Ok(Some((field, self.take(len)?)));
                }
                5 => {
                    self.take(4)?;
                }
                other => {
                    return Err(crx_invalid(format!(
                        "unsupported protobuf wire type {other}"
                    )))
                }
            }
        }
        Ok(None)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProofAlgorithm {
    RsaSha256,
    EcdsaSha256,
}

#[derive(Clone, Debug)]
struct Proof {
    algorithm: ProofAlgorithm,
    public_key: Vec<u8>,
    signature: Vec<u8>,
}

fn parse_proof(bytes: &[u8], algorithm: ProofAlgorithm) -> Result<Proof> {
    let mut reader = ProtoReader::new(bytes);
    let (mut public_key, mut signature) = (None, None);
    while let Some((field, payload)) = reader.next_bytes_field()? {
        match field {
            1 => public_key = Some(payload.to_vec()),
            2 => signature = Some(payload.to_vec()),
            _ => {}
        }
    }
    match (public_key, signature) {
        (Some(public_key), Some(signature)) => Ok(Proof {
            algorithm,
            public_key,
            signature,
        }),
        _ => Err(crx_invalid("a CRX proof lacks its key or signature")),
    }
}

// ---------------------------------------------------------------- DER / SPKI

fn der_element(bytes: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *bytes.first()?;
    let first = *bytes.get(1)?;
    let (len, header) = if first < 0x80 {
        (first as usize, 2)
    } else {
        let count = (first & 0x7f) as usize;
        if count == 0 || count > 4 {
            return None;
        }
        let mut len = 0usize;
        for index in 0..count {
            len = (len << 8) | *bytes.get(2 + index)? as usize;
        }
        (len, 2 + count)
    };
    let end = header.checked_add(len)?;
    let content = bytes.get(header..end)?;
    Some((tag, content, &bytes[end..]))
}

const OID_RSA_ENCRYPTION: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const OID_EC_PUBLIC_KEY: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const OID_PRIME256V1: &[u8] = &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

/// Split a SubjectPublicKeyInfo into its algorithm OID, curve OID (EC only)
/// and the BIT STRING key bytes.
/// `(algorithm OID, curve OID, key bytes)` of a SubjectPublicKeyInfo.
type SpkiParts<'a> = (&'a [u8], Option<&'a [u8]>, &'a [u8]);

fn parse_spki(spki: &[u8]) -> Option<SpkiParts<'_>> {
    let (tag, body, rest) = der_element(spki)?;
    if tag != 0x30 || !rest.is_empty() {
        return None;
    }
    let (tag, algorithm, rest) = der_element(body)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, oid, params) = der_element(algorithm)?;
    if tag != 0x06 {
        return None;
    }
    let curve = match der_element(params) {
        Some((0x06, curve, _)) => Some(curve),
        _ => None,
    };
    let (tag, bits, trailing) = der_element(rest)?;
    if tag != 0x03 || !trailing.is_empty() || bits.first() != Some(&0) {
        return None;
    }
    Some((oid, curve, &bits[1..]))
}

fn verify_proof(proof: &Proof, message: &[u8]) -> Result<()> {
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1, RSA_PKCS1_2048_8192_SHA256};
    let (oid, curve, key) = parse_spki(&proof.public_key)
        .ok_or_else(|| crx_invalid("a CRX proof key is not a SubjectPublicKeyInfo"))?;
    let verified = match proof.algorithm {
        ProofAlgorithm::RsaSha256 if oid == OID_RSA_ENCRYPTION => {
            UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, key)
                .verify(message, &proof.signature)
        }
        ProofAlgorithm::EcdsaSha256 if oid == OID_EC_PUBLIC_KEY && curve == Some(OID_PRIME256V1) => {
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, key).verify(message, &proof.signature)
        }
        _ => return Err(crx_invalid("a CRX proof uses an unsupported key type")),
    };
    verified.map_err(|_| crx_invalid("a CRX signature does not verify"))
}

// ---------------------------------------------------------------- CRX3

/// A verified CRX3.
#[derive(Clone, Debug)]
pub struct VerifiedCrx<'a> {
    pub id: String,
    /// The developer key (SPKI DER) whose hash is the id.
    pub public_key: Vec<u8>,
    pub archive: &'a [u8],
}

/// Parse and verify a CRX3 package.
pub fn parse_crx3(bytes: &[u8]) -> Result<VerifiedCrx<'_>> {
    if bytes.len() < 12 || &bytes[..4] != b"Cr24" {
        return Err(crx_invalid("not a CRX package (missing Cr24 magic)"));
    }
    let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    if version != 3 {
        return Err(crx_invalid(format!(
            "CRX version {version} is not supported (CRX3 only)"
        )));
    }
    let header_size = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let header_end = 12usize
        .checked_add(header_size)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| crx_invalid("CRX header is truncated"))?;
    let header = &bytes[12..header_end];
    let archive = &bytes[header_end..];
    if archive.is_empty() {
        return Err(crx_invalid("CRX carries no archive"));
    }

    let mut proofs = Vec::new();
    let mut signed_header_data = None;
    let mut reader = ProtoReader::new(header);
    while let Some((field, payload)) = reader.next_bytes_field()? {
        match field {
            2 => proofs.push(parse_proof(payload, ProofAlgorithm::RsaSha256)?),
            3 => proofs.push(parse_proof(payload, ProofAlgorithm::EcdsaSha256)?),
            10000 => signed_header_data = Some(payload),
            _ => {}
        }
    }
    let signed_header_data =
        signed_header_data.ok_or_else(|| crx_invalid("CRX header has no signed data"))?;
    let mut crx_id = None;
    let mut signed = ProtoReader::new(signed_header_data);
    while let Some((field, payload)) = signed.next_bytes_field()? {
        if field == 1 {
            crx_id = Some(payload);
        }
    }
    let crx_id = crx_id
        .filter(|id| id.len() == 16)
        .ok_or_else(|| crx_invalid("CRX signed data has no 16-byte crx_id"))?;
    let id = id_from_hash_prefix(crx_id);
    if proofs.is_empty() {
        return Err(crx_invalid("CRX carries no signature proofs"));
    }

    let mut message = Vec::with_capacity(
        CRX3_SIGNATURE_CONTEXT.len() + 4 + signed_header_data.len() + archive.len(),
    );
    message.extend_from_slice(CRX3_SIGNATURE_CONTEXT);
    message.extend_from_slice(&(signed_header_data.len() as u32).to_le_bytes());
    message.extend_from_slice(signed_header_data);
    message.extend_from_slice(archive);

    let mut developer_key = None;
    for proof in &proofs {
        verify_proof(proof, &message)?;
        if Sha256::digest(&proof.public_key)[..16] == *crx_id {
            developer_key = Some(proof.public_key.clone());
        }
    }
    let public_key = developer_key.ok_or_else(|| {
        ExtensionError::new(
            ExtensionErrorCode::CrxIdMismatch,
            format!("no CRX proof is signed by the key of the declared id {id}"),
        )
    })?;
    Ok(VerifiedCrx {
        id,
        public_key,
        archive,
    })
}

// ---------------------------------------------------------------- zip

/// Validate one archive entry name; `None` for the root itself.
fn safe_relative_path(name: &str) -> Result<Option<PathBuf>> {
    let traversal = || {
        ExtensionError::new(
            ExtensionErrorCode::ZipPathTraversal,
            format!("archive entry {name:?} escapes the extension directory"),
        )
    };
    if name.contains('\0') || name.starts_with('/') || name.starts_with('\\') {
        return Err(traversal());
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(traversal());
    }
    let mut path = PathBuf::new();
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err(traversal()),
            part => path.push(part),
        }
    }
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(traversal());
    }
    Ok((!path.as_os_str().is_empty()).then_some(path))
}

/// Top-level names Chromium refuses in an unpacked extension.
fn is_reserved_top_level(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    name.starts_with('_') && name != "_locales"
}

/// Extract `archive` into `dest` (which must exist and be empty).
pub fn extract_zip(archive: &[u8], dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive))
        .map_err(|error| crx_invalid(format!("the archive is not a zip: {error}")))?;
    if zip.len() > MAX_ENTRIES {
        return Err(crx_invalid("the archive has too many entries"));
    }
    let mut written = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| crx_invalid(format!("unreadable archive entry: {error}")))?;
        let name = entry.name().to_string();
        let Some(relative) = safe_relative_path(&name)? else {
            continue;
        };
        if entry.is_symlink() || entry.enclosed_name().is_none() {
            return Err(ExtensionError::new(
                ExtensionErrorCode::ZipPathTraversal,
                format!("archive entry {name:?} is a link or escapes the directory"),
            ));
        }
        let target = dest.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|error| ExtensionError::io(target.display(), error))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| ExtensionError::io(parent.display(), error))?;
        }
        let mut file = std::fs::File::create(&target)
            .map_err(|error| ExtensionError::io(target.display(), error))?;
        let budget = MAX_EXTRACTED_BYTES - written;
        let copied = std::io::copy(&mut (&mut entry).take(budget + 1), &mut file)
            .map_err(|error| crx_invalid(format!("cannot extract {name:?}: {error}")))?;
        if copied > budget {
            return Err(crx_invalid("the archive expands beyond the size limit"));
        }
        written += copied;
    }
    remove_reserved_entries(dest)
}

fn remove_reserved_entries(dir: &Path) -> Result<()> {
    let entries = std::fs::read_dir(dir).map_err(|error| ExtensionError::io(dir.display(), error))?;
    for entry in entries.flatten() {
        if is_reserved_top_level(&entry.file_name()) {
            let path = entry.path();
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            removed.map_err(|error| ExtensionError::io(path.display(), error))?;
        }
    }
    Ok(())
}

/// Copy an unpacked extension (regular files and directories only).
fn copy_unpacked(source: &Path, dest: &Path) -> Result<()> {
    let mut budget = MAX_EXTRACTED_BYTES;
    let mut entries = 0usize;
    fn walk(
        source: &Path,
        dest: &Path,
        top: bool,
        budget: &mut u64,
        entries: &mut usize,
    ) -> Result<()> {
        std::fs::create_dir_all(dest).map_err(|error| ExtensionError::io(dest.display(), error))?;
        let listing =
            std::fs::read_dir(source).map_err(|error| ExtensionError::io(source.display(), error))?;
        for entry in listing {
            let entry = entry.map_err(|error| ExtensionError::io(source.display(), error))?;
            let name = entry.file_name();
            if top && (is_reserved_top_level(&name) || name == ".git") {
                continue;
            }
            *entries += 1;
            if *entries > MAX_ENTRIES {
                return Err(manifest_invalid("the extension has too many files"));
            }
            let file_type = entry
                .file_type()
                .map_err(|error| ExtensionError::io(entry.path().display(), error))?;
            let target = dest.join(&name);
            if file_type.is_symlink() {
                continue;
            } else if file_type.is_dir() {
                walk(&entry.path(), &target, false, budget, entries)?;
            } else if file_type.is_file() {
                let size = entry
                    .metadata()
                    .map_err(|error| ExtensionError::io(entry.path().display(), error))?
                    .len();
                if size > *budget {
                    return Err(manifest_invalid("the extension exceeds the size limit"));
                }
                *budget -= size;
                std::fs::copy(entry.path(), &target)
                    .map_err(|error| ExtensionError::io(target.display(), error))?;
            }
        }
        Ok(())
    }
    walk(source, dest, true, &mut budget, &mut entries)
}

// ---------------------------------------------------------------- manifest

/// Remove `//` and `/* */` comments outside strings (Chromium accepts them in
/// `manifest.json`).
fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    while let Some(character) = chars.next() {
        if in_string {
            out.push(character);
            if character == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if character == '"' {
                in_string = false;
            }
            continue;
        }
        match (character, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(character);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut previous = '\0';
                for next in chars.by_ref() {
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            _ => out.push(character),
        }
    }
    out
}

fn read_json_file(path: &Path) -> Result<Value> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| manifest_invalid(format!("cannot read {}: {error}", path.display())))?;
    let raw = raw.trim_start_matches('\u{feff}');
    serde_json::from_str(&strip_json_comments(raw))
        .map_err(|error| manifest_invalid(format!("{} is not valid JSON: {error}", path.display())))
}

/// `_locales/<locale>/messages.json` as a lower-cased name → message map.
fn load_messages(dir: &Path, locale: &str) -> BTreeMap<String, String> {
    let path = dir.join("_locales").join(locale).join("messages.json");
    let Ok(Value::Object(messages)) = read_json_file(&path) else {
        return BTreeMap::new();
    };
    messages
        .into_iter()
        .filter_map(|(name, entry)| {
            let message = entry.get("message")?.as_str()?.to_string();
            Some((name.to_ascii_lowercase(), message))
        })
        .collect()
}

/// Replace every `__MSG_name__` whose message is known.
fn localize(text: &str, messages: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("__MSG_") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 6..];
        match after.find("__") {
            Some(end) => {
                let name = &after[..end];
                match messages.get(&name.to_ascii_lowercase()) {
                    Some(message) => out.push_str(message),
                    None => out.push_str(&rest[start..start + 6 + end + 2]),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// A relative in-extension path, or `None` if it would escape.
fn extension_relative(path: &str) -> Option<String> {
    let trimmed = path.trim().trim_start_matches('/');
    let trimmed = trimmed.split(['?', '#']).next().unwrap_or("");
    safe_relative_path(trimmed)
        .ok()
        .flatten()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    (1..=4).contains(&parts.len())
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 5
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
                && part.parse::<u32>().map(|value| value <= 65535).unwrap_or(false)
        })
}

fn is_host_pattern(permission: &str) -> bool {
    permission == "<all_urls>" || permission.contains("://")
}

/// What Cognia reads from `manifest.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedManifest {
    pub manifest_version: u64,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub host_permissions: Vec<String>,
    pub icons: BTreeMap<String, String>,
    pub popup_path: Option<String>,
    pub options_path: Option<String>,
    pub key: Option<String>,
}

/// Parse and validate the manifest in `dir`.
pub fn parse_manifest(dir: &Path) -> Result<ParsedManifest> {
    let value = read_json_file(&dir.join("manifest.json"))?;
    let manifest = value
        .as_object()
        .ok_or_else(|| manifest_invalid("manifest.json is not an object"))?;
    let manifest_version = manifest
        .get("manifest_version")
        .and_then(Value::as_u64)
        .filter(|version| matches!(version, 2 | 3))
        .ok_or_else(|| manifest_invalid("manifest_version must be 2 or 3"))?;

    let default_locale = manifest.get("default_locale").and_then(Value::as_str);
    let messages = match default_locale {
        Some(locale) => load_messages(dir, locale),
        None => load_messages(dir, "en"),
    };
    let text = |key: &str| -> Option<String> {
        manifest
            .get(key)
            .and_then(Value::as_str)
            .map(|value| localize(value, &messages).trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let name = text("name").ok_or_else(|| manifest_invalid("manifest has no name"))?;
    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|version| valid_version(version))
        .ok_or_else(|| manifest_invalid("manifest version must be 1-4 dot-separated integers"))?
        .to_string();

    let strings = |value: Option<&Value>| -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut permissions = Vec::new();
    let mut host_permissions = strings(manifest.get("host_permissions"));
    for permission in strings(manifest.get("permissions")) {
        if manifest_version == 2 && is_host_pattern(&permission) {
            host_permissions.push(permission);
        } else {
            permissions.push(permission);
        }
    }
    if let Some(scripts) = manifest.get("content_scripts").and_then(Value::as_array) {
        for script in scripts {
            host_permissions.extend(strings(script.get("matches")));
        }
    }
    let dedupe = |list: Vec<String>| -> Vec<String> {
        let mut seen = std::collections::BTreeSet::new();
        list.into_iter()
            .filter(|item| seen.insert(item.clone()))
            .collect()
    };

    let mut icons = BTreeMap::new();
    let action = manifest
        .get("action")
        .or_else(|| manifest.get("browser_action"))
        .or_else(|| manifest.get("page_action"));
    let mut add_icons = |value: Option<&Value>| match value {
        Some(Value::Object(map)) => {
            for (size, path) in map {
                if let Some(path) = path.as_str().and_then(extension_relative) {
                    icons.entry(size.clone()).or_insert(path);
                }
            }
        }
        Some(Value::String(path)) => {
            if let Some(path) = extension_relative(path) {
                icons.entry("0".into()).or_insert(path);
            }
        }
        _ => {}
    };
    add_icons(manifest.get("icons"));
    add_icons(action.and_then(|action| action.get("default_icon")));

    let popup_path = action
        .and_then(|action| action.get("default_popup"))
        .and_then(Value::as_str)
        .and_then(extension_relative);
    let options_path = manifest
        .get("options_ui")
        .and_then(|options| options.get("page"))
        .and_then(Value::as_str)
        .or_else(|| manifest.get("options_page").and_then(Value::as_str))
        .and_then(extension_relative);

    Ok(ParsedManifest {
        manifest_version,
        name,
        version,
        description: text("description"),
        permissions: dedupe(permissions),
        host_permissions: dedupe(host_permissions),
        icons,
        popup_path,
        options_path,
        key: manifest
            .get("key")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// Decode a manifest `key` (base64 SPKI, PEM armour tolerated).
fn decode_manifest_key(key: &str) -> Result<Vec<u8>> {
    let body: String = key
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect::<String>()
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|_| manifest_invalid("manifest key is not base64"))
}

/// Write `key` into `dir/manifest.json`.
fn inject_manifest_key(dir: &Path, public_key: &[u8]) -> Result<()> {
    let path = dir.join("manifest.json");
    let mut value = read_json_file(&path)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| manifest_invalid("manifest.json is not an object"))?;
    object.insert(
        "key".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(public_key)),
    );
    let text = serde_json::to_string_pretty(&value)
        .map_err(|error| manifest_invalid(error.to_string()))?;
    std::fs::write(&path, text).map_err(|error| ExtensionError::io(path.display(), error))
}

// ---------------------------------------------------------------- registry

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionSource {
    Webstore,
    Crx,
    Unpacked,
}

/// One `registry.json` row.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRecord {
    pub id: String,
    /// Directory name under the store root.
    pub dir: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub source: ExtensionSource,
    pub installed_at: i64,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub host_permissions: Vec<String>,
    #[serde(default)]
    pub icons: BTreeMap<String, String>,
    #[serde(default)]
    pub popup_path: Option<String>,
    #[serde(default)]
    pub options_path: Option<String>,
    #[serde(default)]
    pub update_available: Option<String>,
    /// The directory an unpacked extension was copied from (reinstalling the
    /// same directory keeps its id).
    #[serde(default)]
    pub source_path: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Registry {
    #[serde(default = "registry_version")]
    version: u32,
    #[serde(default)]
    extensions: Vec<ExtensionRecord>,
}

fn registry_version() -> u32 {
    1
}

/// The `BrowserExtension` IPC shape. `iconPath` is absolute (the largest
/// icon); `popupPath` / `optionsPath` are relative to the extension root, as
/// `browser.extension.open` expects.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExtension {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub source: ExtensionSource,
    pub installed_at: i64,
    pub permissions: Vec<String>,
    pub host_permissions: Vec<String>,
    pub icon_path: Option<String>,
    pub popup_path: Option<String>,
    pub options_path: Option<String>,
    pub description: Option<String>,
    pub update_available: Option<String>,
}

/// One available update.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUpdate {
    pub id: String,
    pub current_version: String,
    pub available_version: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Dotted-integer version comparison (`1.10` > `1.9`).
pub fn compare_versions(left: &str, right: &str) -> std::cmp::Ordering {
    let parse = |version: &str| -> Vec<u64> {
        version
            .split('.')
            .map(|part| part.parse().unwrap_or(0))
            .collect()
    };
    let (mut left, mut right) = (parse(left), parse(right));
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    left.cmp(&right)
}

// ---------------------------------------------------------------- store

/// The store. Clones share one lock.
#[derive(Clone, Debug)]
pub struct ExtensionStore {
    root: PathBuf,
    lock: Arc<parking_lot::Mutex<()>>,
}

impl ExtensionStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            lock: Arc::new(parking_lot::Mutex::new(())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn registry_path(&self) -> PathBuf {
        self.root.join(REGISTRY_FILE)
    }

    fn load(&self) -> Result<Registry> {
        let path = self.registry_path();
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                ExtensionError::new(
                    ExtensionErrorCode::Io,
                    format!("{} is corrupt: {error}", path.display()),
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Registry {
                version: 1,
                extensions: Vec::new(),
            }),
            Err(error) => Err(ExtensionError::io(path.display(), error)),
        }
    }

    fn save(&self, registry: &Registry) -> Result<()> {
        std::fs::create_dir_all(&self.root)
            .map_err(|error| ExtensionError::io(self.root.display(), error))?;
        let path = self.registry_path();
        let temporary = self.root.join(format!("{REGISTRY_FILE}.tmp"));
        let bytes = serde_json::to_vec_pretty(registry)
            .map_err(|error| ExtensionError::new(ExtensionErrorCode::Io, error.to_string()))?;
        let mut file = std::fs::File::create(&temporary)
            .map_err(|error| ExtensionError::io(temporary.display(), error))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| ExtensionError::io(temporary.display(), error))?;
        std::fs::rename(&temporary, &path).map_err(|error| ExtensionError::io(path.display(), error))
    }

    fn to_public(&self, record: &ExtensionRecord) -> BrowserExtension {
        let icon_path = record
            .icons
            .iter()
            .max_by_key(|(size, _)| size.parse::<u32>().unwrap_or(0))
            .map(|(_, path)| {
                self.root
                    .join(&record.dir)
                    .join(path)
                    .to_string_lossy()
                    .into_owned()
            });
        BrowserExtension {
            id: record.id.clone(),
            name: record.name.clone(),
            version: record.version.clone(),
            enabled: record.enabled,
            source: record.source,
            installed_at: record.installed_at,
            permissions: record.permissions.clone(),
            host_permissions: record.host_permissions.clone(),
            icon_path,
            popup_path: record.popup_path.clone(),
            options_path: record.options_path.clone(),
            description: record.description.clone(),
            update_available: record.update_available.clone(),
        }
    }

    fn not_found(id: &str) -> ExtensionError {
        ExtensionError::new(
            ExtensionErrorCode::ExtensionNotFound,
            format!("extension {id} is not installed"),
        )
    }

    pub fn list(&self) -> Result<Vec<BrowserExtension>> {
        let _guard = self.lock.lock();
        Ok(self
            .load()?
            .extensions
            .iter()
            .map(|record| self.to_public(record))
            .collect())
    }

    pub fn records(&self) -> Result<Vec<ExtensionRecord>> {
        let _guard = self.lock.lock();
        Ok(self.load()?.extensions)
    }

    pub fn get(&self, id: &str) -> Result<BrowserExtension> {
        let _guard = self.lock.lock();
        let registry = self.load()?;
        registry
            .extensions
            .iter()
            .find(|record| record.id == id)
            .map(|record| self.to_public(record))
            .ok_or_else(|| Self::not_found(id))
    }

    /// Absolute directories of enabled extensions (for `--load-extension`).
    pub fn enabled_paths(&self) -> Result<Vec<PathBuf>> {
        let _guard = self.lock.lock();
        Ok(self
            .load()?
            .extensions
            .iter()
            .filter(|record| record.enabled)
            .map(|record| self.root.join(&record.dir))
            .filter(|dir| dir.join("manifest.json").is_file())
            .collect())
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<BrowserExtension> {
        let _guard = self.lock.lock();
        let mut registry = self.load()?;
        let record = registry
            .extensions
            .iter_mut()
            .find(|record| record.id == id)
            .ok_or_else(|| Self::not_found(id))?;
        record.enabled = enabled;
        let public = self.to_public(record);
        self.save(&registry)?;
        Ok(public)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let _guard = self.lock.lock();
        let mut registry = self.load()?;
        let index = registry
            .extensions
            .iter()
            .position(|record| record.id == id)
            .ok_or_else(|| Self::not_found(id))?;
        let record = registry.extensions.remove(index);
        self.save(&registry)?;
        let dir = self.root.join(&record.dir);
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(ExtensionError::io(dir.display(), error)),
        }
    }

    /// Record the result of an update check.
    pub fn set_update_available(&self, updates: &[(String, Option<String>)]) -> Result<()> {
        let _guard = self.lock.lock();
        let mut registry = self.load()?;
        for (id, available) in updates {
            if let Some(record) = registry.extensions.iter_mut().find(|record| &record.id == id) {
                record.update_available = available.clone();
            }
        }
        self.save(&registry)
    }

    fn staging_dir(&self) -> Result<PathBuf> {
        let dir = self
            .root
            .join(STAGING_DIR)
            .join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&dir).map_err(|error| ExtensionError::io(dir.display(), error))?;
        Ok(dir)
    }

    /// Move `staged` into place as `dir_name` and upsert the registry row.
    fn commit(
        &self,
        staged: &Path,
        dir_name: &str,
        id: Option<String>,
        manifest: ParsedManifest,
        source: ExtensionSource,
        source_path: Option<String>,
    ) -> Result<BrowserExtension> {
        let _guard = self.lock.lock();
        let mut registry = self.load()?;
        let target = self.root.join(dir_name);
        let retired = self
            .root
            .join(STAGING_DIR)
            .join(format!("retired-{}", uuid::Uuid::new_v4().simple()));
        if target.exists() {
            std::fs::rename(&target, &retired)
                .map_err(|error| ExtensionError::io(target.display(), error))?;
        }
        if let Err(error) = std::fs::rename(staged, &target) {
            if retired.exists() {
                let _ = std::fs::rename(&retired, &target);
            }
            return Err(ExtensionError::io(target.display(), error));
        }
        let _ = std::fs::remove_dir_all(&retired);
        let id = match id {
            Some(id) => id,
            None => id_for_path(&target)?,
        };
        let existing = registry
            .extensions
            .iter()
            .position(|record| record.id == id || record.dir == dir_name);
        let enabled = existing
            .map(|index| registry.extensions[index].enabled)
            .unwrap_or(true);
        let record = ExtensionRecord {
            id,
            dir: dir_name.to_string(),
            name: manifest.name,
            version: manifest.version,
            enabled,
            source,
            installed_at: now_ms(),
            description: manifest.description,
            permissions: manifest.permissions,
            host_permissions: manifest.host_permissions,
            icons: manifest.icons,
            popup_path: manifest.popup_path,
            options_path: manifest.options_path,
            update_available: None,
            source_path,
        };
        let public = self.to_public(&record);
        match existing {
            Some(index) => registry.extensions[index] = record,
            None => registry.extensions.push(record),
        }
        self.save(&registry)?;
        Ok(public)
    }

    /// Install a CRX3 package. `expected_id` pins the id (Web Store installs).
    pub fn install_crx_bytes(
        &self,
        bytes: &[u8],
        source: ExtensionSource,
        expected_id: Option<&str>,
    ) -> Result<BrowserExtension> {
        let crx = parse_crx3(bytes)?;
        if let Some(expected) = expected_id {
            if expected != crx.id {
                return Err(ExtensionError::new(
                    ExtensionErrorCode::CrxIdMismatch,
                    format!("expected {expected}, the package is {}", crx.id),
                ));
            }
        }
        let staged = self.staging_dir()?;
        let result = (|| {
            extract_zip(crx.archive, &staged)?;
            let manifest = parse_manifest(&staged)?;
            match &manifest.key {
                Some(key) => {
                    if id_from_bytes(&decode_manifest_key(key)?) != crx.id {
                        return Err(ExtensionError::new(
                            ExtensionErrorCode::CrxIdMismatch,
                            "the manifest key does not match the package id",
                        ));
                    }
                }
                None => inject_manifest_key(&staged, &crx.public_key)?,
            }
            self.commit(&staged, &crx.id, Some(crx.id.clone()), manifest, source, None)
        })();
        let _ = std::fs::remove_dir_all(&staged);
        result
    }

    /// Install a `.crx` file from disk.
    pub fn install_crx_file(&self, path: &Path) -> Result<BrowserExtension> {
        let metadata =
            std::fs::metadata(path).map_err(|error| ExtensionError::io(path.display(), error))?;
        if metadata.len() > MAX_CRX_BYTES {
            return Err(crx_invalid("the package exceeds the size limit"));
        }
        let bytes = std::fs::read(path).map_err(|error| ExtensionError::io(path.display(), error))?;
        self.install_crx_bytes(&bytes, ExtensionSource::Crx, None)
    }

    /// Copy and install an unpacked extension directory.
    pub fn install_unpacked(&self, source: &Path) -> Result<BrowserExtension> {
        if !source.join("manifest.json").is_file() {
            return Err(manifest_invalid(format!(
                "{} has no manifest.json",
                source.display()
            )));
        }
        let source_path = source
            .canonicalize()
            .map_err(|error| ExtensionError::io(source.display(), error))?;
        if source_path.starts_with(
            self.root
                .canonicalize()
                .unwrap_or_else(|_| self.root.clone()),
        ) {
            return Err(manifest_invalid(
                "the directory is already inside the extension store",
            ));
        }
        let source_text = source_path.to_string_lossy().into_owned();
        let staged = self.staging_dir()?;
        let result = (|| {
            copy_unpacked(&source_path, &staged)?;
            let manifest = parse_manifest(&staged)?;
            let (dir_name, id) = match &manifest.key {
                Some(key) => {
                    let id = id_from_bytes(&decode_manifest_key(key)?);
                    (id.clone(), Some(id))
                }
                None => {
                    // Reinstalling the same source keeps its directory, and so
                    // its path-derived id.
                    let previous = self.records()?.into_iter().find(|record| {
                        record.source == ExtensionSource::Unpacked
                            && record.source_path.as_deref() == Some(source_text.as_str())
                    });
                    let dir = previous.map(|record| record.dir).unwrap_or_else(|| {
                        format!("unpacked-{}", uuid::Uuid::new_v4().simple())
                    });
                    (dir, None)
                }
            };
            self.commit(
                &staged,
                &dir_name,
                id,
                manifest,
                ExtensionSource::Unpacked,
                Some(source_text.clone()),
            )
        })();
        let _ = std::fs::remove_dir_all(&staged);
        result
    }
}

// ---------------------------------------------------------------- Web Store

/// An id from a bare id or a Chrome Web Store URL
/// (`chromewebstore.google.com/detail/<slug>/<id>`,
/// `chrome.google.com/webstore/detail/<slug>/<id>`).
pub fn parse_webstore_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if is_extension_id(trimmed) {
        return Some(trimmed.to_string());
    }
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))?;
    let rest = rest.split(['?', '#']).next()?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.to_ascii_lowercase();
    let store = host == "chromewebstore.google.com"
        || (host == "chrome.google.com" && path.starts_with("webstore/"));
    if !store {
        return None;
    }
    path.split('/')
        .find(|segment| is_extension_id(segment))
        .map(str::to_string)
}

/// The CRX download URL (`response=redirect`).
pub fn crx_download_url(id: &str, prodversion: &str) -> String {
    format!(
        "{WEBSTORE_UPDATE_URL}?response=redirect&prodversion={prodversion}&acceptformat=crx2,crx3&x=id%3D{id}%26uc"
    )
}

/// The batched update-check URL (`response=updatecheck`).
pub fn update_check_url(extensions: &[(String, String)], prodversion: &str) -> String {
    let mut url = format!("{WEBSTORE_UPDATE_URL}?response=updatecheck&prodversion={prodversion}&acceptformat=crx2,crx3");
    for (id, version) in extensions {
        url.push_str(&format!("&x=id%3D{id}%26v%3D{version}%26uc"));
    }
    url
}

/// One `<app>` of an update-check response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateCheckResult {
    pub app_id: String,
    pub status: String,
    pub version: Option<String>,
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Attributes of the element whose start tag begins at `tag` (after `<name`).
fn xml_attributes(tag: &str) -> BTreeMap<String, String> {
    let end = tag.find('>').unwrap_or(tag.len());
    let mut rest = &tag[..end];
    let mut attributes = BTreeMap::new();
    while let Some(equals) = rest.find('=') {
        let name = rest[..equals]
            .trim()
            .rsplit(char::is_whitespace)
            .next()
            .unwrap_or("")
            .to_string();
        let after = rest[equals + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            break;
        };
        let Some(close) = after[1..].find(quote) else {
            break;
        };
        attributes.insert(name, xml_unescape(&after[1..1 + close]));
        rest = &after[close + 2..];
    }
    attributes
}

/// Parse a `gupdate` response by hand (it is flat: `<app>` elements each
/// holding one `<updatecheck/>`).
pub fn parse_update_response(xml: &str) -> Vec<UpdateCheckResult> {
    let mut results = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<app ") {
        let body = &rest[start + 5..];
        let end = body
            .find("</app>")
            .or_else(|| body.find("<app "))
            .unwrap_or(body.len());
        let element = &body[..end];
        let app = xml_attributes(element);
        let check = element
            .find("<updatecheck")
            .map(|index| xml_attributes(&element[index + "<updatecheck".len()..]))
            .unwrap_or_default();
        if let Some(app_id) = app.get("appid") {
            let status = check
                .get("status")
                .or_else(|| app.get("status"))
                .cloned()
                .unwrap_or_default();
            results.push(UpdateCheckResult {
                app_id: app_id.clone(),
                version: (status == "ok").then(|| check.get("version").cloned()).flatten(),
                status,
            });
        }
        rest = &body[end..];
    }
    results
}

fn webstore_unavailable(message: impl Into<String>) -> ExtensionError {
    ExtensionError::new(ExtensionErrorCode::WebstoreUnavailable, message)
}

fn webstore_client(url: &str) -> Result<reqwest::Client> {
    let builder = reqwest::Client::builder()
        .user_agent("cognia-desktop")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300));
    cognia_net::proxy_config::managed_client(builder, url)
        .map_err(|error| webstore_unavailable(error.to_string()))
}

/// Download a CRX from the Web Store (bounded).
pub async fn download_webstore_crx(id: &str, prodversion: &str) -> Result<Vec<u8>> {
    let url = crx_download_url(id, prodversion);
    let client = webstore_client(&url)?;
    let mut response = client
        .get(&url)
        .send()
        .await
        .map_err(|error| webstore_unavailable(error.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT || status == reqwest::StatusCode::NOT_FOUND {
        return Err(ExtensionError::new(
            ExtensionErrorCode::ExtensionNotFound,
            format!("the Chrome Web Store has no extension {id}"),
        ));
    }
    if !status.is_success() {
        return Err(webstore_unavailable(format!(
            "the Chrome Web Store answered {status}"
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CRX_BYTES)
    {
        return Err(crx_invalid("the package exceeds the size limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| webstore_unavailable(error.to_string()))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_CRX_BYTES {
            return Err(crx_invalid("the package exceeds the size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(ExtensionError::new(
            ExtensionErrorCode::ExtensionNotFound,
            format!("the Chrome Web Store has no extension {id}"),
        ));
    }
    Ok(bytes)
}

impl ExtensionStore {
    /// Install (or reinstall) from the Chrome Web Store.
    pub async fn install_webstore(
        &self,
        id_or_url: &str,
        prodversion: &str,
    ) -> Result<BrowserExtension> {
        let id = parse_webstore_id(id_or_url).ok_or_else(|| {
            ExtensionError::new(
                ExtensionErrorCode::ExtensionNotFound,
                format!("{id_or_url:?} is not a Chrome Web Store id or URL"),
            )
        })?;
        let bytes = download_webstore_crx(&id, prodversion).await?;
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            store.install_crx_bytes(&bytes, ExtensionSource::Webstore, Some(&id))
        })
        .await
        .map_err(|error| ExtensionError::new(ExtensionErrorCode::Io, error.to_string()))?
    }

    /// Ask the Web Store for newer versions of every store-installed
    /// extension; records and returns the available ones.
    pub async fn check_updates(&self, prodversion: &str) -> Result<Vec<ExtensionUpdate>> {
        let installed: Vec<(String, String)> = self
            .records()?
            .into_iter()
            .filter(|record| record.source == ExtensionSource::Webstore)
            .map(|record| (record.id, record.version))
            .collect();
        if installed.is_empty() {
            return Ok(Vec::new());
        }
        let url = update_check_url(&installed, prodversion);
        let client = webstore_client(&url)?;
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|error| webstore_unavailable(error.to_string()))?;
        if !response.status().is_success() {
            return Err(webstore_unavailable(format!(
                "the Chrome Web Store answered {}",
                response.status()
            )));
        }
        let xml = response
            .text()
            .await
            .map_err(|error| webstore_unavailable(error.to_string()))?;
        let results = parse_update_response(&xml);
        let mut updates = Vec::new();
        let mut marks = Vec::new();
        for (id, current) in &installed {
            let available = results
                .iter()
                .find(|result| &result.app_id == id)
                .and_then(|result| result.version.clone())
                .filter(|version| compare_versions(version, current).is_gt());
            if let Some(version) = &available {
                updates.push(ExtensionUpdate {
                    id: id.clone(),
                    current_version: current.clone(),
                    available_version: version.clone(),
                });
            }
            marks.push((id.clone(), available));
        }
        self.set_update_available(&marks)?;
        Ok(updates)
    }

    /// Reinstall a store extension at its latest version (keeps `enabled`).
    pub async fn update(&self, id: &str, prodversion: &str) -> Result<BrowserExtension> {
        let record = self
            .records()?
            .into_iter()
            .find(|record| record.id == id)
            .ok_or_else(|| Self::not_found(id))?;
        if record.source != ExtensionSource::Webstore {
            return Err(ExtensionError::new(
                ExtensionErrorCode::WebstoreUnavailable,
                format!("{id} was not installed from the Chrome Web Store"),
            ));
        }
        self.install_webstore(id, prodversion).await
    }
}

/// Serialize `records` into a `Value` map keyed by id (used by tests and the
/// shell's diagnostics).
pub fn records_by_id(records: &[ExtensionRecord]) -> Map<String, Value> {
    records
        .iter()
        .filter_map(|record| {
            serde_json::to_value(record)
                .ok()
                .map(|value| (record.id.clone(), value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{
        EcdsaKeyPair, KeyPair, RsaKeyPair, ECDSA_P256_SHA256_ASN1_SIGNING, RSA_PKCS1_SHA256,
    };
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    /// A throwaway 2048-bit RSA key (PKCS#1 DER) used only to build fixtures.
    const TEST_RSA_KEY: &str = "MIIEowIBAAKCAQEAtt33sCebUxcw/WN2usEZLjzsCQLxZwLHkfZtI4mbYYZSC1BHBk9nRUSUndTzwrbakSzJilLP0BljGURXaeYb3uFJG2IItcb6DaMKifhJrO9CPgTWM0cLDF8UvjNpCQ7QDqVzCBxnr8qD5oSxXe/aheXWOhRJeoQ9ekk0bn2Rqa/zEuEJkEYJeLswQ2/V+ueQJ3NxhunsNgVVzvrBH0V0EtoUpzToc1PKkbELnfVthQx7BEAhrhPn2ZXPSvUCzQLeuyur6ICCLxscUBDflVGFMX2DZVUsdIGp9Q69FE4zcmigpj7XX170RTbzLYRnbbUDpH0lM3qlI7xmNfZTAwx0awIDAQABAoIBAAtjeIUCenRqydTGCINp+jj8d1C6W7FoJWisObDQZZplxJ9KwRmeAVb5he3scL/sJmGLMgQI00NpCVht/qmsOIkha62mZdd4TGNkB4h/K4t3HR+Cqppn7sK2+zI7PmvffcqjuC3Foxl6GcvV8Lvib7AOF9DnKYpVSQTgIUFOVa+FGDXzyV5Oa0RR+nKIJukFouOoDkXbvdt+rfhZi37Edl2gSvdAdAZtW/GxCeFH6jkeeWjeG5lIIucvP55xDYQAGy4mUhMumgc5gAZ2SwzvB1Z1j28JWR97/4+evNFsrZLl7iyQQbRoesoriKD0q+KWDW9idVz86MVvSD4ANk0sNyECgYEA5VRISQCQ5/vFGTCz0fA19n4ac1yB1wTURxAXG+rkB7r6N2r3CYXmCIyCFVe4KZp7GrNpiq2cf2R8qUHwqweMvyX6DGYdvghL/y7JUpOGCecjQxA2FoYfIJ8S+MXCn55aykXZ4ePqCUw+mWdYxfpZ6StH6XW9FEiuiD0hc7FEJuECgYEAzCJjOu0dLp0HOlKEOmkufEIEOnpwYUJYAptrQpYClEKiE8TzDrKiU7hpqlRNSl/gh5b12+Cm0HY3vOayfkeCB3tCGtofc8jBbLoE4GG5JlWOCPlndPcwk1UmO8g56djKD8yIEQHDrzBlZ9MShT2rcvJkwtkJ8e2Fv8jyNRFVoMsCgYA2+C3fechCIwJKmHbx4o88x1tVvZ3NyXWMlxnC8lm4VKQ3dmdCnBrYf72Kmh0ls8bATrMEr7qseoy7EXg7trKQ+uxl3nBQpbJ5t2BAb+YYJ5Q3NgKRAZMigZ7NjLGrCw0eIQIp+DSYB/OVV8Vapzi4AEzbdAJfg1B6jZSgI6R/YQKBgQCNue5FEi0pmNJU1seBOleQ49DFvQ5bKFGsdbVxhG8D+oNG0H2kHbgAAlAydtc2pPxhhxjpcL7AiuNF3rHcZM9NXHFX7Ura+233i+so0hBXIh0789S1a42pLPwfk3NJ/T7E2084542yCxrMi8oXAesQImR8t21lL3Cl5+DpoUBfIwKBgCE1hucAOA/F2uvlONyPgKNW+6ixLFrbupG/gIJhFt5q6WxN6P0oKVpcIuEIh/JihqERJ0hQ+oLRyttPx4BrSq6mzqnEV89S6YBUSAVeZicmvLrDE692nMZHFgLIhV2a93B22pJEd3Akwx48awEFie5wARb9P5VnGueDAy4Cy3O8";

    fn der(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let len = content.len();
        if len < 0x80 {
            out.push(len as u8);
        } else if len < 0x100 {
            out.extend([0x81, len as u8]);
        } else {
            out.extend([0x82, (len >> 8) as u8, len as u8]);
        }
        out.extend_from_slice(content);
        out
    }

    fn spki(algorithm: &[u8], key: &[u8]) -> Vec<u8> {
        let mut bits = vec![0u8];
        bits.extend_from_slice(key);
        let mut body = der(0x30, algorithm);
        body.extend(der(0x03, &bits));
        der(0x30, &body)
    }

    fn rsa_algorithm() -> Vec<u8> {
        let mut algorithm = der(0x06, OID_RSA_ENCRYPTION);
        algorithm.extend([0x05, 0x00]);
        algorithm
    }

    fn ec_algorithm() -> Vec<u8> {
        let mut algorithm = der(0x06, OID_EC_PUBLIC_KEY);
        algorithm.extend(der(0x06, OID_PRIME256V1));
        algorithm
    }

    fn varint(mut value: u64, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return;
            }
            out.push(byte | 0x80);
        }
    }

    fn field(number: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        varint((number << 3) | 2, &mut out);
        varint(payload.len() as u64, &mut out);
        out.extend_from_slice(payload);
        out
    }

    enum Signer {
        Rsa(RsaKeyPair),
        Ecdsa(EcdsaKeyPair),
    }

    impl Signer {
        fn rsa() -> Self {
            let der = base64::engine::general_purpose::STANDARD
                .decode(TEST_RSA_KEY)
                .unwrap();
            Self::Rsa(RsaKeyPair::from_der(&der).unwrap())
        }

        fn ecdsa() -> Self {
            let rng = SystemRandom::new();
            let pkcs8 =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
            Self::Ecdsa(
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
                    .unwrap(),
            )
        }

        fn spki(&self) -> Vec<u8> {
            match self {
                Self::Rsa(key) => spki(&rsa_algorithm(), key.public_key().as_ref()),
                Self::Ecdsa(key) => spki(&ec_algorithm(), key.public_key().as_ref()),
            }
        }

        fn field_number(&self) -> u64 {
            match self {
                Self::Rsa(_) => 2,
                Self::Ecdsa(_) => 3,
            }
        }

        fn sign(&self, message: &[u8]) -> Vec<u8> {
            let rng = SystemRandom::new();
            match self {
                Self::Rsa(key) => {
                    let mut signature = vec![0; key.public().modulus_len()];
                    key.sign(&RSA_PKCS1_SHA256, &rng, message, &mut signature)
                        .unwrap();
                    signature
                }
                Self::Ecdsa(key) => key.sign(&rng, message).unwrap().as_ref().to_vec(),
            }
        }
    }

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    /// Build a CRX3: `id_key` decides the declared id; every signer signs.
    fn build_crx(signers: &[&Signer], id_key: &[u8], archive: &[u8]) -> Vec<u8> {
        let crx_id = &Sha256::digest(id_key)[..16];
        let signed_header_data = field(1, crx_id);
        let mut message = CRX3_SIGNATURE_CONTEXT.to_vec();
        message.extend_from_slice(&(signed_header_data.len() as u32).to_le_bytes());
        message.extend_from_slice(&signed_header_data);
        message.extend_from_slice(archive);
        let mut header = Vec::new();
        for signer in signers {
            let mut proof = field(1, &signer.spki());
            proof.extend(field(2, &signer.sign(&message)));
            header.extend(field(signer.field_number(), &proof));
        }
        header.extend(field(10000, &signed_header_data));
        let mut crx = b"Cr24".to_vec();
        crx.extend_from_slice(&3u32.to_le_bytes());
        crx.extend_from_slice(&(header.len() as u32).to_le_bytes());
        crx.extend_from_slice(&header);
        crx.extend_from_slice(archive);
        crx
    }

    const MANIFEST: &[u8] = br#"{
        // Chromium tolerates comments.
        "manifest_version": 3,
        "name": "__MSG_appName__",
        "description": "__MSG_appDesc__ /* not a comment */",
        "version": "1.2.3",
        "default_locale": "en",
        "permissions": ["storage", "tabs"],
        "host_permissions": ["https://*.example.com/*"],
        "content_scripts": [{"matches": ["https://docs.example.org/*"], "js": ["c.js"]}],
        "icons": {"16": "icons/16.png", "128": "/icons/128.png"},
        "action": {"default_popup": "popup.html"},
        "options_ui": {"page": "options/index.html"}
    }"#;
    const MESSAGES: &[u8] = br#"{"appName": {"message": "Ad Blocker"}, "APPDESC": {"message": "Blocks ads"}}"#;

    fn extension_zip() -> Vec<u8> {
        zip_of(&[
            ("manifest.json", MANIFEST),
            ("_locales/en/messages.json", MESSAGES),
            ("popup.html", b"<html></html>"),
            ("_metadata/verified_contents.json", b"[]"),
            ("__MACOSX/._popup.html", b""),
        ])
    }

    #[test]
    fn ids_use_the_a_to_p_alphabet() {
        // Chromium's own vector (id_util_unittest.cc).
        assert_eq!(id_from_bytes(b"test"), "jpignaibiiemhngfjkcpokkamffknabf");
        assert!(is_extension_id("jpignaibiiemhngfjkcpokkamffknabf"));
        assert!(!is_extension_id("jpignaibiiemhngfjkcpokkamffknabq"));
        assert!(!is_extension_id("short"));
    }

    #[test]
    fn path_ids_follow_chromium_normalization() {
        assert_eq!(path_id_bytes("/a/b", false), b"/a/b".to_vec());
        let windows = path_id_bytes(r"c:\ext", true);
        assert_eq!(windows[..2], [b'C', 0]);
        assert_eq!(windows.len(), 6 * 2);
        assert_eq!(strip_verbatim(r"\\?\C:\x"), r"C:\x");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\x"), r"\\?\UNC\server\x");
        let dir = tempfile::tempdir().unwrap();
        let id = id_for_path(dir.path()).unwrap();
        assert!(is_extension_id(&id));
        assert_eq!(id, id_for_path(dir.path()).unwrap());
    }

    #[test]
    fn verifies_rsa_and_ecdsa_crx3_packages() {
        let archive = extension_zip();
        let developer = Signer::rsa();
        let publisher = Signer::ecdsa();
        let crx = build_crx(&[&developer, &publisher], &developer.spki(), &archive);
        let verified = parse_crx3(&crx).unwrap();
        assert_eq!(verified.id, id_from_bytes(&developer.spki()));
        assert_eq!(verified.public_key, developer.spki());
        assert_eq!(verified.archive, archive.as_slice());

        let ecdsa_only = Signer::ecdsa();
        let crx = build_crx(&[&ecdsa_only], &ecdsa_only.spki(), &archive);
        assert_eq!(
            parse_crx3(&crx).unwrap().id,
            id_from_bytes(&ecdsa_only.spki())
        );
    }

    #[test]
    fn rejects_forged_or_malformed_packages() {
        let archive = extension_zip();
        let developer = Signer::rsa();

        // Tampered archive: the signature no longer verifies.
        let mut crx = build_crx(&[&developer], &developer.spki(), &archive);
        let last = crx.len() - 1;
        crx[last] ^= 0xff;
        assert_eq!(parse_crx3(&crx).unwrap_err().code, ExtensionErrorCode::CrxInvalid);

        // Declared id belongs to a key nobody signed with.
        let crx = build_crx(&[&developer], b"someone else's key", &archive);
        assert_eq!(
            parse_crx3(&crx).unwrap_err().code,
            ExtensionErrorCode::CrxIdMismatch
        );

        assert_eq!(parse_crx3(b"PK\x03\x04").unwrap_err().code, ExtensionErrorCode::CrxInvalid);
        let mut crx2 = b"Cr24".to_vec();
        crx2.extend_from_slice(&2u32.to_le_bytes());
        crx2.extend_from_slice(&[0; 8]);
        assert!(parse_crx3(&crx2).unwrap_err().message.contains("CRX3 only"));
        let mut truncated = b"Cr24".to_vec();
        truncated.extend_from_slice(&3u32.to_le_bytes());
        truncated.extend_from_slice(&1000u32.to_le_bytes());
        assert!(parse_crx3(&truncated).unwrap_err().message.contains("truncated"));
    }

    #[test]
    fn zip_extraction_rejects_traversal_and_links() {
        for name in ["../evil.js", "a/../../evil.js", "/etc/passwd", "C:/win.ini", "a\\..\\..\\b"] {
            let dir = tempfile::tempdir().unwrap();
            let error = extract_zip(&zip_of(&[(name, b"x")]), dir.path()).unwrap_err();
            assert_eq!(error.code, ExtensionErrorCode::ZipPathTraversal, "{name}");
        }

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink("link", "/etc/passwd", SimpleFileOptions::default())
            .unwrap();
        let archive = writer.finish().unwrap().into_inner();
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            extract_zip(&archive, dir.path()).unwrap_err().code,
            ExtensionErrorCode::ZipPathTraversal
        );

        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            extract_zip(b"not a zip", dir.path()).unwrap_err().code,
            ExtensionErrorCode::CrxInvalid
        );
    }

    #[test]
    fn zip_extraction_drops_reserved_entries() {
        let dir = tempfile::tempdir().unwrap();
        extract_zip(&extension_zip(), dir.path()).unwrap();
        assert!(dir.path().join("manifest.json").is_file());
        assert!(dir.path().join("_locales/en/messages.json").is_file());
        assert!(!dir.path().join("_metadata").exists());
        assert!(!dir.path().join("__MACOSX").exists());
    }

    #[test]
    fn manifest_parsing_resolves_messages_and_paths() {
        let dir = tempfile::tempdir().unwrap();
        extract_zip(&extension_zip(), dir.path()).unwrap();
        let manifest = parse_manifest(dir.path()).unwrap();
        assert_eq!(manifest.name, "Ad Blocker");
        assert_eq!(
            manifest.description.as_deref(),
            Some("Blocks ads /* not a comment */")
        );
        assert_eq!(manifest.version, "1.2.3");
        assert_eq!(manifest.permissions, vec!["storage", "tabs"]);
        assert_eq!(
            manifest.host_permissions,
            vec!["https://*.example.com/*", "https://docs.example.org/*"]
        );
        assert_eq!(manifest.icons.get("128").map(String::as_str), Some("icons/128.png"));
        assert_eq!(manifest.popup_path.as_deref(), Some("popup.html"));
        assert_eq!(manifest.options_path.as_deref(), Some("options/index.html"));
        assert_eq!(manifest.key, None);
    }

    #[test]
    fn manifest_v2_splits_host_permissions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("manifest.json"),
            br#"{"manifest_version": 2, "name": "Old", "version": "3.0",
                 "permissions": ["cookies", "<all_urls>", "http://a.com/*"],
                 "browser_action": {"default_popup": "../escape.html", "default_icon": "i.png"},
                 "options_page": "opts.html"}"#,
        )
        .unwrap();
        let manifest = parse_manifest(dir.path()).unwrap();
        assert_eq!(manifest.permissions, vec!["cookies"]);
        assert_eq!(manifest.host_permissions, vec!["<all_urls>", "http://a.com/*"]);
        assert_eq!(manifest.popup_path, None, "an escaping popup path is dropped");
        assert_eq!(manifest.icons.get("0").map(String::as_str), Some("i.png"));
        assert_eq!(manifest.options_path.as_deref(), Some("opts.html"));
    }

    #[test]
    fn invalid_manifests_are_typed() {
        for manifest in [
            r#"{"manifest_version": 1, "name": "x", "version": "1"}"#,
            r#"{"manifest_version": 3, "version": "1"}"#,
            r#"{"manifest_version": 3, "name": "x", "version": "1.2.3.4.5"}"#,
            r#"{"manifest_version": 3, "name": "x", "version": "01"}"#,
            r#"{"manifest_version": 3, "name": "x", "version": "70000"}"#,
            r#"[1]"#,
            r#"{"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("manifest.json"), manifest).unwrap();
            assert_eq!(
                parse_manifest(dir.path()).unwrap_err().code,
                ExtensionErrorCode::ManifestInvalid,
                "{manifest}"
            );
        }
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            parse_manifest(empty.path()).unwrap_err().code,
            ExtensionErrorCode::ManifestInvalid
        );
    }

    #[test]
    fn localize_leaves_unknown_messages() {
        let messages = BTreeMap::from([("known".to_string(), "K".to_string())]);
        assert_eq!(localize("__MSG_known__ & __MSG_other__", &messages), "K & __MSG_other__");
        assert_eq!(localize("__MSG_open", &messages), "__MSG_open");
    }

    #[test]
    fn crx_install_injects_the_key_and_manages_the_registry() {
        let root = tempfile::tempdir().unwrap();
        let store = ExtensionStore::new(root.path().join("extensions"));
        let developer = Signer::rsa();
        let crx = build_crx(&[&developer], &developer.spki(), &extension_zip());
        let id = id_from_bytes(&developer.spki());

        let wrong = store
            .install_crx_bytes(&crx, ExtensionSource::Webstore, Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
            .unwrap_err();
        assert_eq!(wrong.code, ExtensionErrorCode::CrxIdMismatch);

        let installed = store
            .install_crx_bytes(&crx, ExtensionSource::Webstore, Some(&id))
            .unwrap();
        assert_eq!(installed.id, id);
        assert_eq!(installed.name, "Ad Blocker");
        assert!(installed.enabled);
        assert_eq!(installed.source, ExtensionSource::Webstore);
        assert!(installed
            .icon_path
            .as_deref()
            .unwrap()
            .ends_with("icons/128.png"));

        // The key makes Chromium load it under the store id.
        let dir = store.root().join(&id);
        let manifest = parse_manifest(&dir).unwrap();
        let key = decode_manifest_key(manifest.key.as_deref().unwrap()).unwrap();
        assert_eq!(id_from_bytes(&key), id);

        assert_eq!(store.enabled_paths().unwrap(), vec![dir.clone()]);
        let disabled = store.set_enabled(&id, false).unwrap();
        assert!(!disabled.enabled);
        assert!(store.enabled_paths().unwrap().is_empty());

        // Reinstall keeps the enabled flag and one row.
        store
            .install_crx_bytes(&crx, ExtensionSource::Webstore, None)
            .unwrap();
        let listed = store.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);

        let json = serde_json::to_value(&listed[0]).unwrap();
        for key in ["id", "name", "version", "enabled", "source", "installedAt", "permissions", "hostPermissions", "iconPath", "popupPath", "optionsPath", "description", "updateAvailable"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert_eq!(json["source"], "webstore");

        store.remove(&id).unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(!dir.exists());
        assert_eq!(
            store.remove(&id).unwrap_err().code,
            ExtensionErrorCode::ExtensionNotFound
        );
        assert_eq!(
            store.set_enabled(&id, true).unwrap_err().code,
            ExtensionErrorCode::ExtensionNotFound
        );
    }

    #[test]
    fn crx_file_install_rejects_a_mismatched_manifest_key() {
        let root = tempfile::tempdir().unwrap();
        let store = ExtensionStore::new(root.path().join("extensions"));
        let developer = Signer::rsa();
        let other = Signer::ecdsa();
        let manifest = format!(
            r#"{{"manifest_version": 3, "name": "K", "version": "1", "key": "{}"}}"#,
            base64::engine::general_purpose::STANDARD.encode(other.spki())
        );
        let archive = zip_of(&[("manifest.json", manifest.as_bytes())]);
        let crx = build_crx(&[&developer], &developer.spki(), &archive);
        let path = root.path().join("k.crx");
        std::fs::write(&path, crx).unwrap();
        assert_eq!(
            store.install_crx_file(&path).unwrap_err().code,
            ExtensionErrorCode::CrxIdMismatch
        );
        // Nothing half-installed remains.
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn unpacked_install_copies_and_keeps_a_stable_id() {
        let root = tempfile::tempdir().unwrap();
        let store = ExtensionStore::new(root.path().join("extensions"));
        let source = root.path().join("my-ext");
        std::fs::create_dir_all(source.join("_metadata")).unwrap();
        std::fs::write(
            source.join("manifest.json"),
            br#"{"manifest_version": 3, "name": "Mine", "version": "0.1"}"#,
        )
        .unwrap();
        std::fs::write(source.join("_metadata/x.json"), b"{}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", source.join("leak")).unwrap();

        let first = store.install_unpacked(&source).unwrap();
        assert_eq!(first.source, ExtensionSource::Unpacked);
        let record = store.records().unwrap().remove(0);
        let dir = store.root().join(&record.dir);
        assert_eq!(first.id, id_for_path(&dir).unwrap());
        assert!(dir.join("manifest.json").is_file());
        assert!(!dir.join("_metadata").exists());
        assert!(!dir.join("leak").exists(), "symlinks are not copied");

        // Editing the source changes nothing until reinstalled, and the
        // reinstall keeps the id.
        std::fs::write(
            source.join("manifest.json"),
            br#"{"manifest_version": 3, "name": "Mine", "version": "0.2"}"#,
        )
        .unwrap();
        assert_eq!(store.list().unwrap()[0].version, "0.1");
        let second = store.install_unpacked(&source).unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.version, "0.2");
        assert_eq!(store.list().unwrap().len(), 1);

        let missing = store.install_unpacked(&root.path().join("nope")).unwrap_err();
        assert_eq!(missing.code, ExtensionErrorCode::ManifestInvalid);
    }

    #[test]
    fn unpacked_install_with_a_key_uses_the_key_id() {
        let root = tempfile::tempdir().unwrap();
        let store = ExtensionStore::new(root.path().join("extensions"));
        let signer = Signer::ecdsa();
        let key = base64::engine::general_purpose::STANDARD.encode(signer.spki());
        let source = root.path().join("keyed");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("manifest.json"),
            format!(r#"{{"manifest_version": 3, "name": "Keyed", "version": "1", "key": "{key}"}}"#),
        )
        .unwrap();
        let installed = store.install_unpacked(&source).unwrap();
        assert_eq!(installed.id, id_from_bytes(&signer.spki()));
        assert!(store.root().join(&installed.id).join("manifest.json").is_file());
    }

    #[test]
    fn webstore_ids_and_urls() {
        let id = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
        assert_eq!(parse_webstore_id(id).as_deref(), Some(id));
        assert_eq!(
            parse_webstore_id(&format!("https://chromewebstore.google.com/detail/ublock-origin/{id}?hl=en")).as_deref(),
            Some(id)
        );
        assert_eq!(
            parse_webstore_id(&format!("https://chrome.google.com/webstore/detail/ublock/{id}")).as_deref(),
            Some(id)
        );
        assert_eq!(parse_webstore_id(&format!("https://evil.example/detail/{id}")), None);
        assert_eq!(parse_webstore_id("not an id"), None);
        assert_eq!(
            crx_download_url(id, "153.0.8010.12"),
            format!("https://clients2.google.com/service/update2/crx?response=redirect&prodversion=153.0.8010.12&acceptformat=crx2,crx3&x=id%3D{id}%26uc")
        );
        assert_eq!(
            update_check_url(&[(id.into(), "1.0".into())], "153"),
            format!("https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=153&acceptformat=crx2,crx3&x=id%3D{id}%26v%3D1.0%26uc")
        );
    }

    #[test]
    fn parses_update_check_responses() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod">
  <daystart elapsed_days="6848" elapsed_seconds="100"/>
  <app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" cohort="1::" status="ok">
    <updatecheck codebase="https://x/a.crx?a=1&amp;b=2" hash_sha256="00" size="10" status="ok" version="1.62.0"/>
  </app>
  <app appid='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' status="ok"><updatecheck status="noupdate"/></app>
  <app appid="cccccccccccccccccccccccccccccccc" status="error-unknownApplication"/>
</gupdate>"#;
        let results = parse_update_response(xml);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].version.as_deref(), Some("1.62.0"));
        assert_eq!(results[1].status, "noupdate");
        assert_eq!(results[1].version, None);
        assert_eq!(results[2].status, "error-unknownApplication");
    }

    #[test]
    fn version_comparison_is_numeric() {
        use std::cmp::Ordering;
        assert_eq!(compare_versions("1.10", "1.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.0", "1"), Ordering::Equal);
        assert_eq!(compare_versions("2.0.1", "2.0.10"), Ordering::Less);
    }

    #[test]
    fn update_marks_persist() {
        let root = tempfile::tempdir().unwrap();
        let store = ExtensionStore::new(root.path().join("extensions"));
        let developer = Signer::rsa();
        let crx = build_crx(&[&developer], &developer.spki(), &extension_zip());
        let installed = store
            .install_crx_bytes(&crx, ExtensionSource::Webstore, None)
            .unwrap();
        store
            .set_update_available(&[(installed.id.clone(), Some("9.9".into()))])
            .unwrap();
        assert_eq!(store.get(&installed.id).unwrap().update_available.as_deref(), Some("9.9"));
        let map = records_by_id(&store.records().unwrap());
        assert!(map.contains_key(&installed.id));
    }

    #[tokio::test]
    async fn update_refuses_non_store_extensions() {
        let root = tempfile::tempdir().unwrap();
        let store = ExtensionStore::new(root.path().join("extensions"));
        assert_eq!(
            store.update("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1").await.unwrap_err().code,
            ExtensionErrorCode::ExtensionNotFound
        );
        let source = root.path().join("u");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(
            source.join("manifest.json"),
            br#"{"manifest_version": 3, "name": "U", "version": "1"}"#,
        )
        .unwrap();
        let installed = store.install_unpacked(&source).unwrap();
        assert_eq!(
            store.update(&installed.id, "1").await.unwrap_err().code,
            ExtensionErrorCode::WebstoreUnavailable
        );
        assert!(store.check_updates("1").await.unwrap().is_empty());
        assert_eq!(
            store.install_webstore("nonsense", "1").await.unwrap_err().code,
            ExtensionErrorCode::ExtensionNotFound
        );
    }

    #[test]
    fn error_strings_lead_with_the_code() {
        let error = ExtensionError::new(ExtensionErrorCode::ZipPathTraversal, "x");
        assert_eq!(error.to_string(), "zip_path_traversal: x");
        assert_eq!(ExtensionErrorCode::UnsupportedBackend.as_str(), "extensions_unsupported_backend");
    }
}
