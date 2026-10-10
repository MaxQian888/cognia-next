//! Credential minting and verification (ADR-0222 §7.1, §9.2).
//!
//! - Usernames are `cg-` plus ten base32 characters (50 random bits): they
//!   carry nothing about the conversation and collide rarely enough that a
//!   retry on a taken one is all it takes.
//! - Passwords are 32 base32 characters (160 random bits). Built-in
//!   credentials keep only an Argon2id PHC hash at the shared account cost
//!   (`cognia_secrets::password_kdf`); SFTPGo credentials keep nothing.
//! - Verification is expensive by design, and WebDAV clients send the
//!   password on every request, so a successful check is remembered for a few
//!   minutes as a keyed digest ([`VerifiedCache`]). Revoking or rotating a
//!   credential forgets it.

use std::collections::HashMap;
use std::time::Duration;

use data_encoding::BASE32_NOPAD;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::error::{FileShareError, FileShareResult};

const USERNAME_PREFIX: &str = "cg-";
const USERNAME_RANDOM_BYTES: usize = 7; // 56 bits → 12 base32 chars, truncated to 10
const USERNAME_CHARS: usize = 10;
const PASSWORD_RANDOM_BYTES: usize = 20; // 160 bits → 32 base32 chars

/// How long a verified password is trusted without re-running Argon2id.
pub const VERIFIED_TTL: Duration = Duration::from_secs(300);

/// A fresh random username.
pub fn new_username() -> String {
    let mut bytes = [0_u8; USERNAME_RANDOM_BYTES];
    rand::fill(&mut bytes);
    let encoded = BASE32_NOPAD.encode(&bytes).to_ascii_lowercase();
    format!("{USERNAME_PREFIX}{}", &encoded[..USERNAME_CHARS])
}

/// Whether `value` has the shape [`new_username`] produces.
pub fn is_username(value: &str) -> bool {
    value
        .strip_prefix(USERNAME_PREFIX)
        .is_some_and(|rest| {
            rest.len() == USERNAME_CHARS
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
        })
}

/// A fresh random password.
pub fn new_password() -> String {
    let mut bytes = [0_u8; PASSWORD_RANDOM_BYTES];
    rand::fill(&mut bytes);
    BASE32_NOPAD.encode(&bytes).to_ascii_lowercase()
}

/// A fresh opaque id with a type prefix (`fg_`, `fc_`).
pub fn new_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    rand::fill(&mut bytes);
    format!("{prefix}{}", BASE32_NOPAD.encode(&bytes).to_ascii_lowercase())
}

/// Hash a password for storage.
pub fn hash_password(password: &str) -> FileShareResult<String> {
    cognia_secrets::password_kdf::hash_phc(password.as_bytes())
        .map_err(|error| FileShareError::new("credential_hash_failed", error))
}

/// Check a password against its stored hash. A malformed hash is a refusal.
pub fn verify_password(password: &str, hash: &str) -> bool {
    cognia_secrets::password_kdf::verify_phc(password.as_bytes(), hash).unwrap_or(false)
}

/// An OpenSSH public key accepted for SFTP: its canonical text and SHA-256
/// fingerprint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshKey {
    pub openssh: String,
    pub fingerprint: String,
}

/// Parse an OpenSSH public key line (`ssh-ed25519 AAAA… comment`).
pub fn parse_ssh_public_key(value: &str) -> FileShareResult<SshKey> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 16 * 1024 {
        return Err(FileShareError::invalid("the SSH public key is empty or too long"));
    }
    let key = russh::keys::PublicKey::from_openssh(trimmed)
        .map_err(|error| FileShareError::invalid(format!("not an OpenSSH public key: {error}")))?;
    let openssh = key
        .to_openssh()
        .map_err(|error| FileShareError::invalid(format!("unusable SSH public key: {error}")))?;
    Ok(SshKey {
        openssh,
        fingerprint: key
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string(),
    })
}

/// Remembers recently verified `(username, password)` pairs as a keyed digest,
/// so the next request skips Argon2id. The key is per process and never
/// leaves memory; the digest is useless without it.
pub struct VerifiedCache {
    key: [u8; 32],
    entries: Mutex<HashMap<String, (Vec<u8>, std::time::Instant)>>,
}

impl Default for VerifiedCache {
    fn default() -> Self {
        let mut key = [0_u8; 32];
        rand::fill(&mut key);
        Self {
            key,
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl VerifiedCache {
    fn digest(&self, username: &str, password: &str) -> Vec<u8> {
        let mut hasher = Sha256::new();
        hasher.update(self.key);
        hasher.update(username.as_bytes());
        hasher.update([0]);
        hasher.update(password.as_bytes());
        hasher.finalize().to_vec()
    }

    /// Whether this exact pair verified within [`VERIFIED_TTL`].
    pub fn hit(&self, username: &str, password: &str) -> bool {
        let digest = self.digest(username, password);
        let mut entries = self.entries.lock();
        match entries.get(username) {
            Some((stored, at)) if at.elapsed() < VERIFIED_TTL => {
                cognia_secrets::password_kdf::constant_time_eq(stored, &digest)
            }
            Some(_) => {
                entries.remove(username);
                false
            }
            None => false,
        }
    }

    pub fn remember(&self, username: &str, password: &str) {
        let digest = self.digest(username, password);
        let mut entries = self.entries.lock();
        entries.retain(|_, (_, at)| at.elapsed() < VERIFIED_TTL);
        entries.insert(username.to_string(), (digest, std::time::Instant::now()));
    }

    pub fn forget(&self, username: &str) {
        self.entries.lock().remove(username);
    }

    pub fn clear(&self) {
        self.entries.lock().clear();
    }
}

/// A short, stable, non-reversible tag for a remote address in backoff keys.
pub fn backoff_key(username: &str, remote: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(username.as_bytes());
    hasher.update([b'|']);
    hasher.update(remote.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_and_passwords_have_their_shape_and_are_random() {
        let a = new_username();
        let b = new_username();
        assert!(is_username(&a), "{a}");
        assert_ne!(a, b);
        assert!(!is_username("cg-ABCDEFGHIJ"));
        assert!(!is_username("cg-abc"));
        assert!(!is_username("root"));
        let password = new_password();
        assert_eq!(password.len(), 32);
        assert_ne!(password, new_password());
        assert!(new_id("fg_").starts_with("fg_"));
    }

    #[test]
    fn a_hashed_password_verifies_only_itself() {
        let hash = hash_password("hunter2hunter2").unwrap();
        assert!(verify_password("hunter2hunter2", &hash));
        assert!(!verify_password("hunter2hunter3", &hash));
        assert!(!verify_password("hunter2hunter2", "garbage"));
    }

    #[test]
    fn ssh_public_keys_parse_to_canonical_text_and_fingerprint() {
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIHnXLB2/rV5vjoZMTLHHGlIIitsmvAND8BNBOQoMilv cognia-test-client";
        let key = parse_ssh_public_key(line).unwrap();
        assert!(key.openssh.starts_with("ssh-ed25519 AAAAC3"));
        // The fingerprint `ssh-keygen -lf` prints for the same key.
        assert_eq!(
            key.fingerprint,
            "SHA256:WLdgiNiBQnpeNfsv1LdY5/oGZJuy0YkVdr3Uvo5oxeI"
        );
        assert!(parse_ssh_public_key("ssh-ed25519 not-base64").is_err());
        assert!(parse_ssh_public_key("").is_err());
    }

    #[test]
    fn the_verified_cache_remembers_exact_pairs_and_forgets_on_demand() {
        let cache = VerifiedCache::default();
        assert!(!cache.hit("cg-a", "pw"));
        cache.remember("cg-a", "pw");
        assert!(cache.hit("cg-a", "pw"));
        assert!(!cache.hit("cg-a", "other"));
        assert!(!cache.hit("cg-b", "pw"));
        cache.forget("cg-a");
        assert!(!cache.hit("cg-a", "pw"));
        cache.remember("cg-a", "pw");
        cache.clear();
        assert!(!cache.hit("cg-a", "pw"));
    }

    #[test]
    fn backoff_keys_separate_users_and_remotes() {
        assert_ne!(backoff_key("cg-a", "1.2.3.4"), backoff_key("cg-a", "1.2.3.5"));
        assert_ne!(backoff_key("cg-a", "1.2.3.4"), backoff_key("cg-b", "1.2.3.4"));
        assert_eq!(backoff_key("cg-a", "x").len(), 64);
    }
}
