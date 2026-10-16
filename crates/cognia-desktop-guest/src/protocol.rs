//! Bounded Host-owned handoff framing. No guest output supplies source authority.
use cognia_desktop_guest::source_tree::{validate_path, MAX_SOURCE_BYTES, MAX_SOURCE_FILES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const HEADER_LIMIT: usize = 128 * 1024;
pub(crate) const REPORT_LIMIT: usize = 512 * 1024;
pub(crate) const RECEIPT_LIMIT: usize = 16 * 1024;
pub(crate) const BUNDLE_LIMIT: u64 = 512 * 1024 * 1024;
pub(crate) const ACCEPTANCE_LIMIT: u64 = 32 * 1024 * 1024;
pub(crate) fn invalid() -> io::Error {
    io::Error::other("handoff protocol refused")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Launch {
    pub script: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub operation_id: String,
    pub manifest: String,
    pub manifest_digest: String,
    pub deadline_at_ms: i64,
    pub launch: Option<Launch>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub commit: String,
    pub bundle_bytes: u64,
    pub bundle_sha256: String,
    pub source_tree_sha256: String,
    pub source_file_count: u64,
    pub source_bytes: u64,
    pub files: Vec<TransferFile>,
}
#[derive(Serialize, Deserialize)]
#[serde(
    tag = "phase",
    content = "request",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Report {
    Header(Request),
    Prepared,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub receipt_version: u32,
    pub boundary_generation: String,
    pub operation_id: String,
    pub commit: String,
    pub manifest_digest: String,
    pub source_tree_sha256: String,
    pub source_file_count: u64,
    pub source_bytes: u64,
    pub workspace: String,
    pub launched: bool,
}

pub(crate) fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}
fn hexadecimal(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn acceptance_path(path: &str) -> io::Result<()> {
    validate_path(path.as_bytes()).map_err(|_| invalid())?;
    if path.len() > 1024 || path.contains('\\') || path.chars().any(char::is_control) {
        return Err(invalid());
    }
    for component in path.split('/') {
        let part = component.to_ascii_lowercase();
        if part == ".env"
            || part.starts_with(".env.")
            || matches!(
                part.as_str(),
                ".ssh"
                    | ".aws"
                    | ".npmrc"
                    | ".pypirc"
                    | ".netrc"
                    | "credentials"
                    | "cookies"
                    | "cookies.sqlite"
                    | "login data"
                    | "local state"
                    | "id_rsa"
                    | "id_ed25519"
            )
            || part.ends_with(".pem")
            || part.ends_with(".key")
        {
            return Err(invalid());
        }
    }
    Ok(())
}
impl Request {
    pub fn validate(&self) -> io::Result<Manifest> {
        if !canonical_uuid(&self.operation_id)
            || self.manifest.len() > 120 * 1024
            || !hexadecimal(&self.manifest_digest, &[64])
            || hex::encode(Sha256::digest(self.manifest.as_bytes())) != self.manifest_digest
        {
            return Err(invalid());
        }
        if let Some(launch) = &self.launch {
            let value = launch.script.as_bytes();
            if value.is_empty()
                || value.len() > 100
                || !value[0].is_ascii_alphanumeric() && !b"_:".contains(&value[0])
                || !value
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_:.-".contains(byte))
            {
                return Err(invalid());
            }
        }
        let manifest: Manifest = serde_json::from_str(&self.manifest).map_err(|_| invalid())?;
        if manifest.version != 2
            || !hexadecimal(&manifest.commit, &[40, 64])
            || !hexadecimal(&manifest.bundle_sha256, &[64])
            || !hexadecimal(&manifest.source_tree_sha256, &[64])
            || manifest.bundle_bytes == 0
            || manifest.bundle_bytes > BUNDLE_LIMIT
            || manifest.source_file_count > MAX_SOURCE_FILES as u64
            || manifest.source_bytes > MAX_SOURCE_BYTES
            || manifest.files.len() > 100
        {
            return Err(invalid());
        }
        let mut total = 0_u64;
        let mut names = BTreeSet::new();
        for file in &manifest.files {
            acceptance_path(&file.path)?;
            if file.bytes > 8 * 1024 * 1024
                || !hexadecimal(&file.sha256, &[64])
                || !names.insert(file.path.as_str())
            {
                return Err(invalid());
            }
            total = total.checked_add(file.bytes).ok_or_else(invalid)?;
        }
        if total > ACCEPTANCE_LIMIT {
            return Err(invalid());
        }
        for path in &names {
            for (index, _) in path.match_indices('/') {
                if names.contains(&path[..index]) {
                    return Err(invalid());
                }
            }
        }
        self.deadline()?;
        Ok(manifest)
    }
    pub fn deadline(&self) -> io::Result<Instant> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| invalid())?
            .as_millis();
        let requested = u128::try_from(self.deadline_at_ms).map_err(|_| invalid())?;
        let remaining = requested
            .checked_sub(now)
            .filter(|value| *value > 0 && *value <= 3_600_000)
            .ok_or_else(invalid)?;
        Ok(Instant::now() + Duration::from_millis(remaining as u64))
    }
}

pub(crate) fn wait_read(fd: i32, deadline: Instant) -> io::Result<()> {
    let idle = Instant::now() + Duration::from_secs(30);
    loop {
        let remaining = deadline
            .min(idle)
            .checked_duration_since(Instant::now())
            .ok_or_else(invalid)?;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        let result = unsafe {
            libc::poll(
                &mut poll,
                1,
                remaining.as_millis().min(i32::MAX as u128).max(1) as i32,
            )
        };
        if result < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        if result <= 0 || poll.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(invalid());
        }
        return Ok(());
    }
}
pub(crate) fn read_some<R: Read + AsRawFd>(
    reader: &mut R,
    bytes: &mut [u8],
    deadline: Instant,
) -> io::Result<usize> {
    wait_read(reader.as_raw_fd(), deadline)?;
    reader.read(bytes)
}
pub(crate) fn read_line<R: Read + AsRawFd>(
    reader: &mut R,
    limit: usize,
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    loop {
        let mut byte = [0];
        if read_some(reader, &mut byte, deadline)? != 1 || output.len() >= limit {
            return Err(invalid());
        }
        output.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(output);
        }
    }
}
pub(crate) fn write_json(
    writer: &mut impl Write,
    value: &impl Serialize,
    limit: usize,
) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err(invalid());
    }
    writer.write_all(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        let manifest = serde_json::json!({"version":2,"commit":"a".repeat(40),"bundleBytes":1,"bundleSha256":"b".repeat(64),"sourceTreeSha256":"c".repeat(64),"sourceFileCount":1,"sourceBytes":1,"files":[]}).to_string();
        Request {
            operation_id: "12345678-1234-4234-8234-123456789abc".into(),
            manifest_digest: hex::encode(Sha256::digest(manifest.as_bytes())),
            manifest,
            deadline_at_ms: (SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis()
                + 60_000) as i64,
            launch: None,
        }
    }
    #[test]
    fn host_manifest_cannot_be_substituted_or_downgraded() {
        let mut value = request();
        assert!(value.validate().is_ok());
        value.manifest.push(' ');
        assert!(value.validate().is_err());
        value = request();
        value.manifest = value.manifest.replace("\"version\":2", "\"version\":1");
        value.manifest_digest = hex::encode(Sha256::digest(value.manifest.as_bytes()));
        assert!(value.validate().is_err());
        value = request();
        value.deadline_at_ms = 1;
        assert!(value.validate().is_err());
        value = request();
        value.launch = Some(Launch {
            script: "--prefix=/root".into(),
        });
        assert!(value.validate().is_err());
    }
    #[test]
    fn frame_limits_and_eof_are_not_authorization() {
        use std::os::unix::net::UnixStream;
        let (mut read, mut write) = UnixStream::pair().unwrap();
        write.write_all(b"12345\n").unwrap();
        assert!(read_line(&mut read, 4, Instant::now() + Duration::from_secs(1)).is_err());
        let (mut read, write) = UnixStream::pair().unwrap();
        drop(write);
        assert!(read_line(
            &mut read,
            HEADER_LIMIT,
            Instant::now() + Duration::from_secs(1)
        )
        .is_err());
    }
    #[test]
    fn acceptance_names_cannot_select_control_or_secret_paths() {
        for name in [
            "../receipt",
            ".git/HEAD",
            "a/.env",
            "file.key",
            "a\\b",
            "/absolute",
        ] {
            assert!(acceptance_path(name).is_err());
        }
        assert!(acceptance_path("checks/readme.md").is_ok());
    }
    #[test]
    fn operation_ids_are_canonical_non_nil_and_never_paths() {
        assert!(canonical_uuid("12345678-1234-4234-8234-123456789abc"));
        assert!(!canonical_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!canonical_uuid("../12345678-1234-4234-8234-123456789abc"));
    }
}
