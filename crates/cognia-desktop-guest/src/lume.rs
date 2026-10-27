//! Versioned Darwin guest protocol. This module has no VM or Host authority.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const VERSION: u32 = 1;
pub const MAX_HEADER: usize = 256 * 1024;
pub const MAX_PAYLOAD: usize = 8 * 1024 * 1024;
pub const MAX_WORKSPACE_FILES: usize = 512;

pub const DRIVER_APP: &str = "/Applications/CuaDriver.app";
pub const DRIVER_EXECUTABLE: &str = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DriverIdentity {
    pub executable: String,
    pub executable_hash: String,
    pub team_id: String,
    pub designated_requirement: String,
    pub code_hash: String,
    pub daemon_pid: u32,
    pub daemon_uid: u32,
}
impl DriverIdentity {
    pub fn same_artifact(&self, other: &Self) -> bool {
        self.executable == other.executable
            && self.executable_hash == other.executable_hash
            && self.team_id == other.team_id
            && self.designated_requirement == other.designated_requirement
            && self.code_hash == other.code_hash
            && self.daemon_uid == other.daemon_uid
    }
    pub fn from_codesign(
        output: &str,
        executable_hash: String,
        daemon_pid: u32,
        daemon_uid: u32,
    ) -> Result<Self, String> {
        let value = |prefix: &str| {
            output
                .lines()
                .find_map(|line| line.trim().strip_prefix(prefix))
                .unwrap_or("")
                .to_string()
        };
        if value("Identifier=") != "com.trycua.driver" {
            return Err("driver_identity".into());
        }
        let identity = Self {
            executable: DRIVER_EXECUTABLE.into(),
            executable_hash,
            team_id: value("TeamIdentifier="),
            designated_requirement: value("designated => "),
            code_hash: value("CDHash="),
            daemon_pid,
            daemon_uid,
        };
        identity.validate()?;
        Ok(identity)
    }
    pub fn validate(&self) -> Result<(), String> {
        if self.executable != DRIVER_EXECUTABLE
            || self.executable_hash.len() != 64
            || !self.executable_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || self.team_id.len() != 10
            || !self.team_id.bytes().all(|b| b.is_ascii_alphanumeric())
            || !self
                .designated_requirement
                .contains("identifier \"com.trycua.driver\"")
            || !self.designated_requirement.contains("anchor apple generic")
            || self.designated_requirement.len() > 4096
            || !matches!(self.code_hash.len(), 40 | 64)
            || !self.code_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || self.daemon_pid == 0
            || self.daemon_uid == 0
        {
            return Err("driver_identity".into());
        }
        Ok(())
    }
}

/// Shared import/export floor; excluded trees are pruned before traversal.
pub fn workspace_excluded(path: &str) -> bool {
    path.to_lowercase().split('/').any(|part| {
        matches!(
            part,
            ".git"
                | ".ssh"
                | ".config"
                | ".aws"
                | ".gnupg"
                | ".kube"
                | ".docker"
                | "node_modules"
                | ".next"
                | ".cache"
                | "target"
                | "dist"
                | "build"
                | "out"
                | ".venv"
                | "venv"
                | "__pycache__"
                | "coverage"
        ) || part.starts_with(".env")
            || matches!(
                part,
                "credentials.json"
                    | "credentials.yaml"
                    | "credentials.yml"
                    | "id_rsa"
                    | "id_ed25519"
                    | "known_hosts"
            )
            || [".pem", ".key", ".p12", ".pfx"]
                .iter()
                .any(|suffix| part.ends_with(suffix))
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceFile {
    pub path: String,
    pub size: usize,
    pub hash: String,
    #[serde(default)]
    pub executable: bool,
}

/// One bounded binary body, with hashes and collision-checked relative names.
pub fn pack_workspace(
    files: Vec<(String, Vec<u8>)>,
) -> Result<(Vec<WorkspaceFile>, Vec<u8>), String> {
    let mut manifest = Vec::new();
    let mut body = Vec::new();
    for (path, bytes) in files {
        manifest.push(WorkspaceFile {
            path,
            size: bytes.len(),
            hash: content_hash(&bytes),
            executable: false,
        });
        if body.len().saturating_add(bytes.len()) > MAX_PAYLOAD {
            return Err("workspace_limit".into());
        }
        body.extend_from_slice(&bytes);
    }
    unpack_workspace(&manifest, &body)?;
    Ok((manifest, body))
}

pub fn unpack_workspace(
    manifest: &[WorkspaceFile],
    body: &[u8],
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    use unicode_normalization::UnicodeNormalization;
    if manifest.len() > MAX_WORKSPACE_FILES || body.len() > MAX_PAYLOAD {
        return Err("workspace_limit".into());
    }
    let mut names = std::collections::BTreeSet::new();
    let mut files = BTreeMap::new();
    let mut offset = 0usize;
    for file in manifest {
        // The same case/normalization rules are checked on both sides before IO.
        let key = file.path.nfc().collect::<String>().to_lowercase();
        if file.path.len() > 256 || file.path.contains('\\') || !names.insert(key.clone()) {
            return Err("workspace_path_collision".into());
        }
        if Path::new(&file.path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
            || file.path.is_empty()
            || file.path.chars().any(char::is_control)
            || key.split('/').any(|part| {
                matches!(
                    part,
                    ".git"
                        | ".ssh"
                        | ".config"
                        | ".aws"
                        | ".gnupg"
                        | ".kube"
                        | ".docker"
                        | "node_modules"
                ) || part.starts_with(".env")
                    || matches!(
                        part,
                        "credentials.json"
                            | "credentials.yaml"
                            | "credentials.yml"
                            | "id_rsa"
                            | "id_ed25519"
                            | "known_hosts"
                    )
                    || [".pem", ".key", ".p12", ".pfx"]
                        .iter()
                        .any(|suffix| part.ends_with(suffix))
            })
        {
            return Err("workspace_path_refused".into());
        }
        let end = offset.checked_add(file.size).ok_or("workspace_limit")?;
        let bytes = body.get(offset..end).ok_or("workspace_body")?;
        if content_hash(bytes) != file.hash {
            return Err("workspace_hash".into());
        }
        files.insert(file.path.clone(), bytes.to_vec());
        offset = end;
    }
    if offset != body.len() {
        return Err("workspace_body".into());
    }
    // A file and directory cannot share a spelling on APFS.
    for name in &names {
        for (index, _) in name.match_indices('/') {
            if names.contains(&name[..index]) {
                return Err("workspace_path_collision".into());
            }
        }
    }
    Ok(files)
}

#[cfg(unix)]
pub fn import_workspace(
    root: &Path,
    manifest: &[WorkspaceFile],
    body: &[u8],
) -> Result<(), String> {
    let files = unpack_workspace(manifest, body)?;
    if std::fs::symlink_metadata(root)
        .map_err(|_| "workspace_missing")?
        .file_type()
        .is_symlink()
        || std::fs::read_dir(root)
            .map_err(|_| "workspace_read")?
            .next()
            .is_some()
    {
        return Err("workspace_not_empty".into());
    }
    for file in manifest {
        AnchoredFile::create_parents(root, &file.path)?;
        file_operation(
            root,
            &FileOperation::WriteNew {
                path: file.path.clone(),
            },
            &files[&file.path],
        )?;
        if file.executable {
            AnchoredFile::open(root, &file.path)?.set_executable()?;
        }
    }
    Ok(())
}

#[cfg(unix)]
pub fn export_workspace(root: &Path) -> Result<(Vec<WorkspaceFile>, Vec<u8>), String> {
    use std::os::unix::fs::MetadataExt;
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut executable = std::collections::BTreeSet::new();
    let mut visited = 0;
    let mut total = 0usize;
    while let Some(directory) = pending.pop() {
        visited += 1;
        if visited > 4096 {
            return Err("workspace_limit".into());
        }
        for entry in std::fs::read_dir(directory).map_err(|_| "workspace_read")? {
            let entry = entry.map_err(|_| "workspace_read")?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "workspace_path")?
                .to_str()
                .ok_or("workspace_encoding")?
                .to_string();
            if workspace_excluded(&relative) {
                continue;
            }
            let metadata = std::fs::symlink_metadata(&path).map_err(|_| "workspace_stat")?;
            if metadata.file_type().is_symlink() {
                return Err("workspace_symlink".into());
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            let bytes = AnchoredFile::open(root, &relative)?
                .read()?
                .ok_or("workspace_changed")?;
            total = total.saturating_add(bytes.len());
            if total > MAX_PAYLOAD || files.len() >= MAX_WORKSPACE_FILES {
                return Err("workspace_limit".into());
            }
            if metadata.mode() & 0o111 != 0 {
                executable.insert(relative.clone());
            }
            files.push((relative, bytes));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let (mut manifest, body) = pack_workspace(files)?;
    for file in &mut manifest {
        file.executable = executable.contains(&file.path);
    }
    Ok((manifest, body))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope {
    pub version: u32,
    pub operation_id: String,
    pub instance_nonce: String,
    pub binding_id: String,
    pub generation: u64,
    pub boot_epoch: String,
    pub payload_len: usize,
    pub request: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Hello,
    GuiProfile,
    WorkspaceImport {
        files: Vec<WorkspaceFile>,
    },
    WorkspaceExport,
    Exec {
        argv: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: BTreeMap<String, String>,
        timeout_ms: u64,
        readable: Vec<String>,
        writable: Vec<String>,
    },
    File {
        operation: FileOperation,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum FileOperation {
    Read {
        path: String,
    },
    WriteNew {
        path: String,
    },
    Write {
        path: String,
        expected_hash: Option<String>,
    },
    Replace {
        path: String,
        expected_hash: String,
        old: String,
        new: String,
    },
    Insert {
        path: String,
        expected_hash: String,
        line: usize,
        text: String,
    },
}

impl FileOperation {
    pub fn path(&self) -> &str {
        match self {
            Self::Read { path }
            | Self::WriteNew { path }
            | Self::Write { path, .. }
            | Self::Replace { path, .. }
            | Self::Insert { path, .. } => path,
        }
    }
    pub fn writes(&self) -> bool {
        !matches!(self, Self::Read { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    pub version: u32,
    pub operation_id: String,
    pub payload_len: usize,
    pub result: serde_json::Value,
    pub error_code: Option<String>,
}

pub fn write_frame<T: Serialize>(
    writer: &mut impl Write,
    header: &T,
    payload: &[u8],
) -> Result<(), String> {
    let bytes = serde_json::to_vec(header).map_err(|_| "frame_encode")?;
    if bytes.len() > MAX_HEADER || payload.len() > MAX_PAYLOAD {
        return Err("frame_limit".into());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|_| "frame_write")?;
    writer.write_all(&bytes).map_err(|_| "frame_write")?;
    writer.write_all(payload).map_err(|_| "frame_write")?;
    writer.flush().map_err(|_| "frame_flush".into())
}

pub fn read_header<T: serde::de::DeserializeOwned>(reader: &mut impl Read) -> Result<T, String> {
    let mut size = [0; 4];
    reader.read_exact(&mut size).map_err(|_| "frame_eof")?;
    let size = u32::from_be_bytes(size) as usize;
    if size == 0 || size > MAX_HEADER {
        return Err("frame_limit".into());
    }
    let mut header = vec![0; size];
    reader.read_exact(&mut header).map_err(|_| "frame_eof")?;
    serde_json::from_slice(&header).map_err(|_| "frame_schema".into())
}

pub fn read_payload(reader: &mut impl Read, size: usize) -> Result<Vec<u8>, String> {
    if size > MAX_PAYLOAD {
        return Err("payload_limit".into());
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).map_err(|_| "payload_eof")?;
    Ok(bytes)
}

pub fn content_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Bound worst-case JSON escaping as well as UTF-8 bytes in the reply header.
pub fn bounded_exec_output(value: &str) -> (&str, bool) {
    let mut end = value.len().min(16 * 1024);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], end < value.len())
}

#[cfg(test)]
mod output_tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn editing_imported_executable_preserves_its_owner_execute_bit() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = std::env::temp_dir().join(format!("lume-mode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("script"), b"old").unwrap();
        std::fs::set_permissions(root.join("script"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        file_operation(
            &root,
            &FileOperation::Write {
                path: "script".into(),
                expected_hash: Some(content_hash(b"old")),
            },
            b"updated",
        )
        .unwrap();
        assert_ne!(
            std::fs::metadata(root.join("script")).unwrap().mode() & 0o100,
            0
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn replica_round_trip_is_exclusive_and_preserves_binary_and_nested_files() {
        let root = std::env::temp_dir().join(format!("lume-replica-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let (manifest, bytes) = pack_workspace(vec![
            ("src/x".into(), b"text".to_vec()),
            ("image.bin".into(), vec![0, 255]),
        ])
        .unwrap();
        import_workspace(&root, &manifest, &bytes).unwrap();
        let (exported, body) = export_workspace(&root).unwrap();
        assert_eq!(
            unpack_workspace(&exported, &body).unwrap()["src/x"],
            b"text"
        );
        assert_eq!(
            unpack_workspace(&exported, &body).unwrap()["image.bin"],
            [0, 255]
        );
        std::fs::create_dir(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/ignored"), b"dependency").unwrap();
        std::fs::write(root.join(".env.local"), b"secret").unwrap();
        let (exported, body) = export_workspace(&root).unwrap();
        assert_eq!(unpack_workspace(&exported, &body).unwrap().len(), 2);
        assert!(import_workspace(&root, &manifest, &bytes).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn workspace_manifest_refuses_case_and_unicode_collisions_and_tampered_bytes() {
        assert!(pack_workspace(vec![("A".into(), vec![]), ("a".into(), vec![])]).is_err());
        assert!(pack_workspace(vec![("é".into(), vec![]), ("e\u{301}".into(), vec![])]).is_err());
        assert!(pack_workspace(vec![("a".into(), vec![]), ("a/x".into(), vec![])]).is_err());
        let (files, mut body) = pack_workspace(vec![("a".into(), vec![1])]).unwrap();
        body[0] = 2;
        assert!(unpack_workspace(&files, &body).is_err());
    }
    #[test]
    fn escaped_and_multibyte_output_fits_the_reply_frame() {
        for text in ["\0".repeat(1_000_000), "你好".repeat(100_000)] {
            let (output, truncated) = bounded_exec_output(&text);
            assert!(truncated);
            let reply = Reply {
                version: VERSION,
                operation_id: "o".into(),
                payload_len: 0,
                result: serde_json::json!({"stdout":output,"stderr":output,"stdoutTruncated":truncated,"stderrTruncated":truncated}),
                error_code: None,
            };
            let mut frame = Vec::new();
            write_frame(&mut frame, &reply, &[]).unwrap();
            let decoded: Reply = read_header(&mut frame.as_slice()).unwrap();
            assert_eq!(decoded.result["stdout"], output);
        }
    }
    #[cfg(unix)]
    #[test]
    fn exclusive_binary_upload_never_clobbers_an_existing_file() {
        let root = std::env::temp_dir().join(format!("lume-upload-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let operation = FileOperation::WriteNew {
            path: "upload.bin".into(),
        };
        file_operation(&root, &operation, &[0, 255, 1]).unwrap();
        assert!(file_operation(&root, &operation, b"replacement").is_err());
        assert_eq!(std::fs::read(root.join("upload.bin")).unwrap(), [0, 255, 1]);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Logical paths never address the guest account, SSH keys, or OS directories.
/// Resolve existing ancestors so symlinks cannot escape the workspace.
pub fn workspace_path(root: &Path, logical: &str) -> Result<PathBuf, String> {
    if logical.is_empty() || logical.chars().any(char::is_control) {
        return Err("path_invalid".into());
    }
    let relative = Path::new(logical);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("path_invalid".into());
    }
    if relative
        .components()
        .any(|part| matches!(part.as_os_str().to_str(), Some(".ssh" | ".git" | ".config")))
    {
        return Err("path_protected".into());
    }
    let root = root.canonicalize().map_err(|_| "workspace_missing")?;
    let candidate = root.join(relative);
    let mut ancestor = candidate.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("path_invalid")?;
    }
    if !ancestor
        .canonicalize()
        .map_err(|_| "path_resolve")?
        .starts_with(&root)
    {
        return Err("path_escape".into());
    }
    Ok(candidate)
}

/// Caller holds the workspace's cross-process mutation lock and excludes
/// arbitrary Shell/GUI writers. The Host refuses typed writes after those
/// surfaces are used; a fresh clean clone is required, because Stop cannot
/// attest the absence of jobs that restart on the next boot. Flock cannot exclude
/// their detached writers. Publication never follows a final symlink.
pub fn file_operation(
    root: &Path,
    operation: &FileOperation,
    payload: &[u8],
) -> Result<(serde_json::Value, Vec<u8>), String> {
    let file = AnchoredFile::open(root, operation.path())?;
    let existing = file.read()?;
    let previous = existing.clone().unwrap_or_default();
    let hash = content_hash(&previous);
    let expected = match operation {
        FileOperation::Read { .. } => {
            if existing.is_none() {
                return Err("file_missing".into());
            }
            return Ok((serde_json::json!({"hash":hash}), previous));
        }
        FileOperation::Write { expected_hash, .. } => expected_hash.as_ref(),
        FileOperation::WriteNew { .. } => {
            if existing.is_some() {
                return Err("file_exists".into());
            }
            None
        }
        FileOperation::Replace { expected_hash, .. }
        | FileOperation::Insert { expected_hash, .. } => Some(expected_hash),
    };
    if expected.is_some_and(|expected| expected != &hash) {
        return Err("file_conflict".into());
    }
    let updated = match operation {
        FileOperation::Write { .. } | FileOperation::WriteNew { .. } => payload.to_vec(),
        FileOperation::Replace { old, new, .. } => {
            let text = String::from_utf8(previous).map_err(|_| "file_encoding")?;
            if old.is_empty() || text.matches(old).count() != 1 {
                return Err("replace_ambiguous".into());
            }
            text.replacen(old, new, 1).into_bytes()
        }
        FileOperation::Insert { line, text, .. } => {
            let old = String::from_utf8(previous).map_err(|_| "file_encoding")?;
            let offset = if *line == 0 {
                0
            } else {
                old.match_indices('\n')
                    .nth(line - 1)
                    .map(|(i, _)| i + 1)
                    .ok_or("line_invalid")?
            };
            format!("{}{}{}", &old[..offset], text, &old[offset..]).into_bytes()
        }
        FileOperation::Read { .. } => unreachable!(),
    };
    if updated.len() > MAX_PAYLOAD {
        return Err("file_limit".into());
    }
    file.replace(
        &updated,
        matches!(operation, FileOperation::WriteNew { .. }),
    )?;
    Ok((
        serde_json::json!({"hash":content_hash(&updated)}),
        Vec::new(),
    ))
}

#[cfg(unix)]
struct AnchoredFile {
    parent: std::fs::File,
    name: std::ffi::CString,
}

#[cfg(unix)]
impl AnchoredFile {
    fn create_parents(root: &Path, logical: &str) -> Result<(), String> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        };
        let mut parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .map_err(|_| "workspace_open")?;
        let parts: Vec<_> = Path::new(logical).components().collect();
        for part in &parts[..parts.len() - 1] {
            let name = std::ffi::CString::new(part.as_os_str().as_encoded_bytes())
                .map_err(|_| "path_invalid")?;
            unsafe {
                libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700);
            }
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err("path_parent_refused".into());
            }
            parent = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        Ok(())
    }
    fn set_executable(&self) -> Result<(), String> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        };
        let fd = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("file_open_refused".into());
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let metadata = file.metadata().map_err(|_| "file_stat")?;
        if !metadata.is_file()
            || metadata.nlink() != 1
            || unsafe { libc::fchmod(file.as_raw_fd(), 0o700) } != 0
        {
            return Err("file_mode".into());
        }
        Ok(())
    }
    fn open(root: &Path, logical: &str) -> Result<Self, String> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::OpenOptionsExt,
        };
        workspace_path(root, logical)?;
        let mut parent = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .map_err(|_| "workspace_open")?;
        let parts: Vec<_> = Path::new(logical).components().collect();
        for part in &parts[..parts.len() - 1] {
            let name = std::ffi::CString::new(part.as_os_str().as_encoded_bytes())
                .map_err(|_| "path_invalid")?;
            // SAFETY: owned directory fd and NUL-terminated component; the
            // returned descriptor is uniquely owned by File on success.
            let fd = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err("path_parent_refused".into());
            }
            parent = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        let name = std::ffi::CString::new(
            parts
                .last()
                .ok_or("path_invalid")?
                .as_os_str()
                .as_encoded_bytes(),
        )
        .map_err(|_| "path_invalid")?;
        Ok(Self { parent, name })
    }
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        use std::os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::MetadataExt,
        };
        let fd = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err("file_open_refused".into())
            };
        }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let meta = file.metadata().map_err(|_| "file_stat")?;
        if !meta.is_file() || meta.nlink() != 1 || meta.len() > MAX_PAYLOAD as u64 {
            return Err("file_type_or_limit".into());
        }
        let mut bytes = Vec::new();
        file.take((MAX_PAYLOAD + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "file_read")?;
        if bytes.len() > MAX_PAYLOAD {
            return Err("file_limit".into());
        }
        Ok(Some(bytes))
    }
    fn replace(&self, bytes: &[u8], exclusive: bool) -> Result<(), String> {
        self.replace_with_sync(bytes, exclusive, |directory| directory.sync_all())
    }

    fn replace_with_sync(
        &self,
        bytes: &[u8],
        exclusive: bool,
        sync_directory: impl FnOnce(&std::fs::File) -> std::io::Result<()>,
    ) -> Result<(), String> {
        use std::os::fd::{AsRawFd, FromRawFd};
        // Atomic replacement must preserve a source script's executable bit.
        // Observe through the anchored parent, without following a swapped leaf.
        let mut previous: libc::stat = unsafe { std::mem::zeroed() };
        let exists = unsafe {
            libc::fstatat(
                self.parent.as_raw_fd(),
                self.name.as_ptr(),
                &mut previous,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0;
        if exists && (previous.st_mode & libc::S_IFMT != libc::S_IFREG || previous.st_nlink != 1) {
            return Err("file_type_or_limit".into());
        }
        let mode = if exists && previous.st_mode & 0o111 != 0 {
            0o700
        } else {
            0o600
        };
        let temporary = std::ffi::CString::new(format!(".cognia-{}", uuid::Uuid::new_v4()))
            .map_err(|_| "file_name")?;
        let fd = unsafe {
            libc::openat(
                self.parent.as_raw_fd(),
                temporary.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                mode,
            )
        };
        if fd < 0 {
            return Err("file_create".into());
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let result = (|| {
            file.write_all(bytes)
                .and_then(|_| file.sync_all())
                .map_err(|_| "file_write")?;
            let status = if exclusive {
                unsafe {
                    libc::linkat(
                        self.parent.as_raw_fd(),
                        temporary.as_ptr(),
                        self.parent.as_raw_fd(),
                        self.name.as_ptr(),
                        0,
                    )
                }
            } else {
                unsafe {
                    libc::renameat(
                        self.parent.as_raw_fd(),
                        temporary.as_ptr(),
                        self.parent.as_raw_fd(),
                        self.name.as_ptr(),
                    )
                }
            };
            if status != 0 {
                return Err("file_publish".into());
            }
            sync_directory(&self.parent).map_err(|_| "file_sync".into())
        })();
        unsafe { libc::unlinkat(self.parent.as_raw_fd(), temporary.as_ptr(), 0) };
        result
    }
}

#[cfg(not(unix))]
struct AnchoredFile;
#[cfg(not(unix))]
impl AnchoredFile {
    fn open(_: &Path, _: &str) -> Result<Self, String> {
        Err("darwin_required".into())
    }
    fn read(&self) -> Result<Option<Vec<u8>>, String> {
        Err("darwin_required".into())
    }
    fn replace(&self, _: &[u8], _: bool) -> Result<(), String> {
        Err("darwin_required".into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn driver_identity_rejects_shims_unsigned_apps_and_changed_artifacts() {
        let signing = format!("Identifier=com.trycua.driver\nTeamIdentifier=TEAM123456\nCDHash={}\ndesignated => identifier \"com.trycua.driver\" and anchor apple generic\n", "a".repeat(40));
        let identity =
            super::DriverIdentity::from_codesign(&signing, "b".repeat(64), 42, 501).unwrap();
        let mut shim = identity.clone();
        shim.executable = "/usr/local/bin/replacement".into();
        assert!(shim.validate().is_err());
        assert!(super::DriverIdentity::from_codesign(
            &signing.replace("TEAM123456", "not set"),
            "b".repeat(64),
            42,
            501
        )
        .is_err());
        assert!(super::DriverIdentity::from_codesign(
            &signing.replace("com.trycua.driver", "com.other.app"),
            "b".repeat(64),
            42,
            501
        )
        .is_err());
        let mut replaced = identity.clone();
        replaced.executable_hash = "c".repeat(64);
        assert!(!identity.same_artifact(&replaced));
        let mut restarted = identity.clone();
        restarted.daemon_pid += 1;
        assert_ne!(identity, restarted);
        assert!(identity.same_artifact(&restarted));
    }
    use super::*;

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("lume-protocol-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn framing_preserves_metacharacters_and_rejects_oversize_and_unknown_fields() {
        let request = Envelope {
            version: VERSION,
            operation_id: "op".into(),
            instance_nonce: "nonce".into(),
            binding_id: "binding".into(),
            generation: 1,
            boot_epoch: "boot".into(),
            payload_len: 4,
            request: Request::Exec {
                argv: vec!["printf".into(), "a '$()`\n".into()],
                cwd: "workspace".into(),
                env: BTreeMap::new(),
                timeout_ms: 1000,
                readable: vec![],
                writable: vec![],
            },
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &request, b"data").unwrap();
        let mut cursor = std::io::Cursor::new(bytes);
        let decoded: Envelope = read_header(&mut cursor).unwrap();
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(request).unwrap()
        );
        assert_eq!(read_payload(&mut cursor, 4).unwrap(), b"data");
        assert!(
            read_header::<Envelope>(&mut std::io::Cursor::new(u32::MAX.to_be_bytes())).is_err()
        );
        assert!(serde_json::from_value::<FileOperation>(
            serde_json::json!({"kind":"read","path":"x","argv":["sh"]})
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn typed_edits_are_compare_and_swap_and_refuse_ambiguous_replacements() {
        let root = root();
        let write = FileOperation::Write {
            path: "x".into(),
            expected_hash: None,
        };
        file_operation(&root, &write, b"one\ntwo\n").unwrap();
        let edit = FileOperation::Replace {
            path: "x".into(),
            expected_hash: content_hash(b"one\ntwo\n"),
            old: "two".into(),
            new: "three".into(),
        };
        file_operation(&root, &edit, &[]).unwrap();
        assert_eq!(
            file_operation(&root, &edit, &[]).unwrap_err(),
            "file_conflict"
        );
        assert_eq!(std::fs::read(root.join("x")).unwrap(), b"one\nthree\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_sync_failure_is_reported_after_the_file_is_published() {
        let root = root();
        let file = AnchoredFile::open(&root, "x").unwrap();
        assert_eq!(
            file.replace_with_sync(b"applied", false, |_| Err(std::io::Error::other(
                "injected directory fsync failure"
            )))
            .unwrap_err(),
            "file_sync"
        );
        assert_eq!(std::fs::read(root.join("x")).unwrap(), b"applied");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn anchored_io_refuses_hardlinks_and_keeps_parent_identity_after_rename() {
        let root = root();
        std::fs::create_dir(root.join("parent")).unwrap();
        std::fs::write(root.join("outside"), b"secret").unwrap();
        std::fs::hard_link(root.join("outside"), root.join("parent/hard")).unwrap();
        assert!(file_operation(
            &root,
            &FileOperation::Read {
                path: "parent/hard".into()
            },
            &[]
        )
        .is_err());
        let anchored = AnchoredFile::open(&root, "parent/file").unwrap();
        std::fs::rename(root.join("parent"), root.join("original")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), root.join("parent")).unwrap();
        anchored.replace(b"owned", false).unwrap();
        assert_eq!(std::fs::read(root.join("original/file")).unwrap(), b"owned");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn logical_paths_cannot_reach_credentials_or_escape_via_symlinks() {
        let root = root();
        for path in ["/etc/passwd", "../secret", ".ssh/key", "x/../../a", "a\nb"] {
            assert!(workspace_path(&root, path).is_err(), "{path}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::env::temp_dir(), root.join("escape")).unwrap();
            assert!(workspace_path(&root, "escape/secret").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
