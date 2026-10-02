//! Bootstrap credential handoff and session derivation for the managed broker.
//!
//! # Why a file and not the environment
//!
//! code-server hands its own environment to every process it starts: integrated
//! terminals, tasks, language servers, debug adapters. A broker secret placed in
//! that environment is therefore readable by every command a user (or an agent)
//! runs in the workbench, and anything holding it could authenticate as the
//! managed extension. So the secret travels as a file instead, and the
//! environment carries only the file's path:
//!
//! - The file lives in a per-user `0700` directory **outside** the code-server
//!   user-data dir (profile sync copies user-data trees between profiles).
//! - It is created `O_EXCL | O_NOFOLLOW` at `0600`, and the extension unlinks it
//!   as soon as it has read it.
//! - The secret inside is a **bootstrap** credential: single use. A successful
//!   hello consumes it and both sides derive a session key from it plus the two
//!   handshake nonces ([`derive_session_key`]). The session key never crosses
//!   the wire; reconnects prove possession of it instead.
//! - The host re-mints a bootstrap file whenever an instance has no live
//!   authenticated connection, so an extension host restart the host did not
//!   drive (a browser reload, a crash) can still find one.
//!
//! # What this does not defend against
//!
//! Code running as the same OS user can read a `0600` file before the extension
//! does, or read the session key out of the extension host's memory. The
//! single-use rule turns the first of those into a visible tripwire (see
//! `agent_channel`), but neither is prevented. The goal is to stop the secret
//! leaking by inheritance (environments, logs, crash dumps), not to sandbox the
//! user from themselves.

use std::path::{Path, PathBuf};

use hkdf::Hkdf;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Environment variable naming the bootstrap credential file. The file path is
/// not a secret: by the time anything could use it, the file is gone.
pub const CREDENTIAL_FILE_ENV: &str = "COGNIA_CS_AGENT_CREDENTIAL_FILE";

/// HKDF `info` prefix for the session key. Both sides must agree byte for byte
/// (`sidecar/codeserver-agent-ext/src/broker-credential.mjs`).
const SESSION_INFO: &[u8] = b"cognia-broker-session";
/// HMAC label for the content-handle bearer derived from a session key.
const CONTENT_LABEL: &[u8] = b"content";

/// The on-disk bootstrap credential.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapCredential {
    pub token_id: String,
    pub secret: String,
}

/// Redacts the secret, so a log line or a failing assertion never prints it.
impl std::fmt::Debug for BootstrapCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BootstrapCredential")
            .field("token_id", &self.token_id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

impl BootstrapCredential {
    pub(crate) fn mint() -> Self {
        Self {
            token_id: uuid::Uuid::new_v4().to_string(),
            secret: random_hex(32),
        }
    }
}

/// The per-user directory holding bootstrap credential files.
pub(crate) fn default_credential_dir() -> PathBuf {
    crate::process::session_socket_dir().join("broker")
}

/// The fixed per-instance credential file for `root` on `host_id`. Fixed so a
/// re-mint replaces the file the extension is already polling for.
pub(crate) fn credential_file_path(dir: &Path, root: &str, host_id: &str) -> PathBuf {
    let mut digest = Sha256::new();
    digest.update(host_id.as_bytes());
    digest.update([0]);
    digest.update(root.as_bytes());
    dir.join(format!("{}.cred", hex::encode(&digest.finalize()[..16])))
}

/// Create the credential directory (and its parent) as private directories.
pub(crate) fn prepare_credential_dir(dir: &Path) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        crate::process::prepare_private_dir(parent)?;
    }
    crate::process::prepare_private_dir(dir)
}

/// Replace `path` with a freshly written credential. Any previous file is
/// removed first so the create can insist on `O_EXCL`, which also refuses to
/// follow a symlink planted at the path.
pub(crate) fn write_credential_file(
    path: &Path,
    credential: &BootstrapCredential,
) -> Result<(), String> {
    use std::io::Write as _;
    let dir = path
        .parent()
        .ok_or_else(|| "broker credential path has no parent".to_string())?;
    prepare_credential_dir(dir)?;
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove stale broker credential: {error}")),
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("create broker credential: {error}"))?;
    let body = serde_json::to_vec(credential)
        .map_err(|error| format!("encode broker credential: {error}"))?;
    // No fsync: the file lives for seconds before the extension unlinks it,
    // and a lost write after a crash is re-minted by the next registration.
    file.write_all(&body)
        .map_err(|error| format!("write broker credential: {error}"))
}

/// Remove a credential file. Missing is fine: the extension unlinks it on read.
pub(crate) fn remove_credential_file(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!(
            "codeserver broker: remove credential {}: {error}",
            path.display()
        ),
    }
}

/// `HKDF-SHA256(ikm = presented secret, info = label ‖ server nonce ‖ client
/// nonce)`. The nonces bind the key to one handshake, so a session can only be
/// derived by someone who held the secret for that exact exchange.
pub(crate) fn derive_session_key(
    secret: &[u8],
    server_nonce: &str,
    client_nonce: &str,
) -> [u8; 32] {
    let hkdf = Hkdf::<Sha256>::new(None, secret);
    let mut info = Vec::with_capacity(SESSION_INFO.len() + server_nonce.len() + client_nonce.len());
    info.extend_from_slice(SESSION_INFO);
    info.extend_from_slice(server_nonce.as_bytes());
    info.extend_from_slice(client_nonce.as_bytes());
    let mut key = [0_u8; 32];
    hkdf.expand(&info, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

/// Hex `HMAC-SHA256(session key, "content")`, the content endpoint's bearer.
pub(crate) fn content_bearer(session_key: &[u8]) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(session_key)
        .expect("HMAC accepts keys of any length");
    mac.update(CONTENT_LABEL);
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time comparison for secrets and derived values.
pub(crate) fn secrets_equal(left: &[u8], right: &[u8]) -> bool {
    use subtle::ConstantTimeEq as _;
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0_u8; bytes];
    rand::fill(buffer.as_mut_slice());
    hex::encode(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_files_are_private_and_replace_their_predecessor() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("cgncs").join("broker");
        let path = credential_file_path(&dir, "/work/a", "local");
        let first = BootstrapCredential::mint();
        write_credential_file(&path, &first).unwrap();
        let second = BootstrapCredential::mint();
        write_credential_file(&path, &second).unwrap();
        let read: BootstrapCredential =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read, second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(file_mode & 0o777, 0o600);
            let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode();
            assert_eq!(dir_mode & 0o777, 0o700);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_planted_at_the_credential_path_is_replaced_not_followed() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("cgncs").join("broker");
        prepare_credential_dir(&dir).unwrap();
        let victim = temp.path().join("victim");
        std::fs::write(&victim, b"untouched").unwrap();
        let path = credential_file_path(&dir, "/work/a", "local");
        std::os::unix::fs::symlink(&victim, &path).unwrap();
        write_credential_file(&path, &BootstrapCredential::mint()).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
        assert!(!std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_world_readable_credential_directory_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("cgncs");
        let dir = parent.join("broker");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = credential_file_path(&dir, "/work/a", "local");
        assert!(write_credential_file(&path, &BootstrapCredential::mint()).is_err());
    }

    #[test]
    fn credential_paths_are_scoped_by_host_and_root() {
        let dir = Path::new("/tmp/broker");
        let local = credential_file_path(dir, "/work/a", "local");
        assert_eq!(local, credential_file_path(dir, "/work/a", "local"));
        assert_ne!(local, credential_file_path(dir, "/work/b", "local"));
        assert_ne!(local, credential_file_path(dir, "/work/a", "host-2"));
    }

    #[test]
    fn session_keys_depend_on_secret_and_both_nonces() {
        let key = derive_session_key(b"secret", "server", "client");
        assert_eq!(key, derive_session_key(b"secret", "server", "client"));
        assert_ne!(key, derive_session_key(b"other", "server", "client"));
        assert_ne!(key, derive_session_key(b"secret", "server2", "client"));
        assert_ne!(key, derive_session_key(b"secret", "server", "client2"));
    }

    /// Pinned against Node's `hkdfSync("sha256", "secret", "", info, 32)` and
    /// `createHmac("sha256", key).update("content")`, which the extension uses.
    /// If this vector moves, `broker-credential.test.mjs` must move with it.
    #[test]
    fn derivation_matches_the_extension_test_vector() {
        let key = derive_session_key(b"bootstrap-secret", "server-nonce", "client-nonce");
        assert_eq!(hex::encode(key), SESSION_KEY_VECTOR);
        assert_eq!(content_bearer(&key), CONTENT_BEARER_VECTOR);
    }

    const SESSION_KEY_VECTOR: &str =
        include_str!("../../../sidecar/codeserver-agent-ext/tests/fixtures/session-key.vector")
            .trim_ascii();
    const CONTENT_BEARER_VECTOR: &str =
        include_str!("../../../sidecar/codeserver-agent-ext/tests/fixtures/content-bearer.vector")
            .trim_ascii();

    #[test]
    fn secret_comparison_requires_equal_length_and_bytes() {
        assert!(secrets_equal(b"abc", b"abc"));
        assert!(!secrets_equal(b"abc", b"abd"));
        assert!(!secrets_equal(b"abc", b"abcd"));
    }

    #[test]
    fn debug_output_never_contains_the_secret() {
        let credential = BootstrapCredential::mint();
        let rendered = format!("{credential:?}");
        assert!(rendered.contains(&credential.token_id));
        assert!(!rendered.contains(&credential.secret));
    }

    #[test]
    fn minted_credentials_are_unique() {
        let first = BootstrapCredential::mint();
        let second = BootstrapCredential::mint();
        assert_ne!(first.token_id, second.token_id);
        assert_ne!(first.secret, second.secret);
        assert_eq!(first.secret.len(), 64);
    }
}
