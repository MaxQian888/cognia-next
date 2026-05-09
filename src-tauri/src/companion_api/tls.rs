//! TLS scaffolding for the companion API (Wave 1.4 / M2.8).
//!
//! The mobile client trusts the desktop server by **public-key pinning**
//! rather than chain validation: the QR payload encodes the certificate's
//! SHA-256 SubjectPublicKeyInfo fingerprint, and the mobile transport layer
//! refuses to talk to any peer whose presented cert doesn't match.
//!
//! On first boot we generate a long-lived self-signed cert (10y) and persist
//! it to `<app_data>/cognia/companion/tls.{pem,key}`. Subsequent boots load
//! the same cert so the fingerprint stays stable (and the mobile app keeps
//! pairing).
//!
//! # Why not Let's Encrypt / ACME?
//!
//! The desktop server runs on a user's laptop with no public DNS. Issuing a
//! real cert would require a tunnel (cloudflared) which is opt-in (Wave 1.6).
//! The pinned-self-signed approach gives end-to-end encryption + identity
//! without any infrastructure dependency.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, SanType};
use sha2::{Digest, Sha256};

const CERT_FILE: &str = "tls.pem";
const KEY_FILE: &str = "tls.key";
const COMMON_NAME: &str = "cognia-companion";
const VALIDITY_YEARS: i64 = 10;

/// Loaded TLS material — paths plus the SHA-256 SubjectPublicKeyInfo
/// fingerprint that gets encoded into pair QR payloads.
///
/// The path fields are read by [`commands::companion_tls_paths`] (a
/// diagnostics command — surfaces where the cert lives so a user can
/// inspect / rotate it) and are also reserved for the eventual HTTPS
/// server bring-up (M2.9), at which point `axum-server` will load the
/// PEM + key from these paths.
#[derive(Debug, Clone)]
pub struct TlsMaterial {
    pub cert_pem_path: PathBuf,
    pub key_pem_path: PathBuf,
    /// Lower-case hex SHA-256 of the DER-encoded SubjectPublicKeyInfo.
    pub fingerprint_sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("rcgen: {0}")]
    Rcgen(#[from] rcgen::Error),
}

/// Resolve `<data_dir>/cognia/companion/` and ensure it exists.
fn companion_dir(data_dir: &Path) -> io::Result<PathBuf> {
    let dir = data_dir.join("cognia").join("companion");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Ensure a TLS cert exists in `<data_dir>/cognia/companion/`. If both PEM
/// files are present and parseable, returns the fingerprint of the existing
/// cert. Otherwise generates a fresh self-signed cert + 10y validity.
pub fn ensure_certificate(data_dir: &Path) -> Result<TlsMaterial, TlsError> {
    let dir = companion_dir(data_dir)?;
    let cert_path = dir.join(CERT_FILE);
    let key_path = dir.join(KEY_FILE);

    if cert_path.exists() && key_path.exists() {
        if let Ok(material) = load_existing(&cert_path, &key_path) {
            return Ok(material);
        }
        // Fall through to regenerate if parse fails.
    }

    generate_new(&cert_path, &key_path)
}

fn load_existing(cert_path: &Path, key_path: &Path) -> Result<TlsMaterial, TlsError> {
    let cert_pem = fs::read_to_string(cert_path)?;
    let fingerprint = fingerprint_from_pem(&cert_pem)?;
    Ok(TlsMaterial {
        cert_pem_path: cert_path.to_path_buf(),
        key_pem_path: key_path.to_path_buf(),
        fingerprint_sha256: fingerprint,
    })
}

fn generate_new(cert_path: &Path, key_path: &Path) -> Result<TlsMaterial, TlsError> {
    let mut params = CertificateParams::default();
    params.not_before = time_offset_now(0);
    params.not_after = time_offset_now(VALIDITY_YEARS);

    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, COMMON_NAME);
    dn.push(DnType::OrganizationName, "cognia");
    params.distinguished_name = dn;
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into().unwrap()),
        SanType::DnsName("cognia-companion.local".try_into().unwrap()),
        SanType::IpAddress("127.0.0.1".parse().unwrap()),
        SanType::IpAddress("::1".parse().unwrap()),
    ];

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();

    fs::write(cert_path, &cert_pem)?;
    fs::write(key_path, &key_pem)?;
    // Best-effort: lock down key file perms on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(key_path)?.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(key_path, perms);
    }

    let fingerprint = fingerprint_from_pem(&cert_pem)?;
    Ok(TlsMaterial {
        cert_pem_path: cert_path.to_path_buf(),
        key_pem_path: key_path.to_path_buf(),
        fingerprint_sha256: fingerprint,
    })
}

/// Compute the SHA-256 fingerprint of the certificate's DER-encoded
/// SubjectPublicKeyInfo. We hash the SPKI rather than the whole certificate
/// so the fingerprint stays valid across re-issuance with the same key (if
/// the user ever rotates only the validity period).
fn fingerprint_from_pem(cert_pem: &str) -> Result<String, TlsError> {
    let der = pem_to_der(cert_pem)?;
    let spki = extract_spki(&der)?;
    let mut hasher = Sha256::new();
    hasher.update(&spki);
    let digest = hasher.finalize();
    Ok(hex::encode(digest))
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, TlsError> {
    let mut iter = pem.lines().filter(|l| !l.starts_with("-----"));
    let body: String = iter.by_ref().collect();
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    STANDARD
        .decode(body.trim())
        .map_err(|e| TlsError::Io(io::Error::new(io::ErrorKind::InvalidData, e)))
}

/// Walk the X.509 ASN.1 DER tree and extract the SubjectPublicKeyInfo.
///
/// Avoids pulling in a full X.509 parser; only needs the offsets to reach
/// the SPKI sequence which lives at fixed nesting in tbsCertificate.
fn extract_spki(der: &[u8]) -> Result<Vec<u8>, TlsError> {
    // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    let (tbs, _) = read_sequence(der)?;
    // tbsCertificate ::= SEQUENCE {
    //   [0] EXPLICIT Version DEFAULT v1,
    //   serialNumber INTEGER,
    //   signature AlgorithmIdentifier,
    //   issuer Name,
    //   validity Validity,
    //   subject Name,
    //   subjectPublicKeyInfo SubjectPublicKeyInfo,  ← target
    //   ...
    // }
    let (tbs_body, _) = read_sequence(tbs)?;
    let mut cur = tbs_body;
    // Skip optional [0] version
    if !cur.is_empty() && cur[0] == 0xA0 {
        cur = skip_tlv(cur)?;
    }
    cur = skip_tlv(cur)?; // serialNumber
    cur = skip_tlv(cur)?; // signature
    cur = skip_tlv(cur)?; // issuer
    cur = skip_tlv(cur)?; // validity
    cur = skip_tlv(cur)?; // subject
    // Now cur starts with the SubjectPublicKeyInfo SEQUENCE. We want the
    // entire TLV (including tag + length + body) for the hash.
    let spki = take_tlv(cur)?;
    Ok(spki.to_vec())
}

fn read_sequence(der: &[u8]) -> Result<(&[u8], &[u8]), TlsError> {
    if der.is_empty() || der[0] != 0x30 {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected SEQUENCE",
        )));
    }
    let (len, rest) = read_length(&der[1..])?;
    if rest.len() < len {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated",
        )));
    }
    Ok((&rest[..len], &rest[len..]))
}

fn skip_tlv(der: &[u8]) -> Result<&[u8], TlsError> {
    if der.is_empty() {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "EOF in TLV",
        )));
    }
    let (len, rest) = read_length(&der[1..])?;
    if rest.len() < len {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated TLV",
        )));
    }
    Ok(&rest[len..])
}

fn take_tlv(der: &[u8]) -> Result<&[u8], TlsError> {
    if der.is_empty() {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "EOF in TLV",
        )));
    }
    let (len, rest) = read_length(&der[1..])?;
    let header = der.len() - rest.len();
    if rest.len() < len {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "truncated TLV",
        )));
    }
    let total = header + len;
    Ok(&der[..total])
}

fn read_length(buf: &[u8]) -> Result<(usize, &[u8]), TlsError> {
    if buf.is_empty() {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "no length byte",
        )));
    }
    let first = buf[0];
    if first < 0x80 {
        return Ok((first as usize, &buf[1..]));
    }
    let n = (first & 0x7F) as usize;
    if n == 0 || n > 4 || buf.len() < 1 + n {
        return Err(TlsError::Io(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid length",
        )));
    }
    let mut len = 0usize;
    for byte in &buf[1..1 + n] {
        len = (len << 8) | (*byte as usize);
    }
    Ok((len, &buf[1 + n..]))
}

fn time_offset_now(years_offset: i64) -> time::OffsetDateTime {
    let now = time::OffsetDateTime::now_utc();
    if years_offset == 0 {
        now
    } else {
        now + time::Duration::days(365 * years_offset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ensure_certificate_creates_files() {
        let tmp = tempdir().unwrap();
        let mat = ensure_certificate(tmp.path()).expect("first call");
        assert!(mat.cert_pem_path.exists());
        assert!(mat.key_pem_path.exists());
        assert_eq!(mat.fingerprint_sha256.len(), 64); // hex sha256
        assert!(mat.fingerprint_sha256.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn second_call_reuses_existing_cert() {
        let tmp = tempdir().unwrap();
        let first = ensure_certificate(tmp.path()).expect("first");
        let second = ensure_certificate(tmp.path()).expect("second");
        assert_eq!(first.fingerprint_sha256, second.fingerprint_sha256);
    }

    #[test]
    fn corrupt_cert_triggers_regeneration() {
        let tmp = tempdir().unwrap();
        let first = ensure_certificate(tmp.path()).expect("first");
        // Corrupt the cert file.
        fs::write(&first.cert_pem_path, "garbage").unwrap();
        let second = ensure_certificate(tmp.path()).expect("regen");
        // New cert means different fingerprint.
        assert_ne!(first.fingerprint_sha256, second.fingerprint_sha256);
    }

    #[test]
    fn fingerprint_is_stable_across_loads() {
        let tmp = tempdir().unwrap();
        let m = ensure_certificate(tmp.path()).expect("ensure");
        let pem = fs::read_to_string(&m.cert_pem_path).unwrap();
        let again = fingerprint_from_pem(&pem).unwrap();
        assert_eq!(m.fingerprint_sha256, again);
    }
}
