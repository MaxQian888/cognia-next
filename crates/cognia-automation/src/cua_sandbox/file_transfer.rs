//! Binary guest transfer over the existing supervised execution channel.
//! The embedded helper owns Linux-only anonymous-file publication; no host path
//! is opened and no file operation goes through the GUI WebSocket protocol.

use super::lifecycle;
use crate::automation::types::{AutomationError, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};

pub const MAX_TRANSFER_BYTES: usize = 8 * 1024 * 1024;
const MAX_BASE64_BYTES: usize = MAX_TRANSFER_BYTES.div_ceil(3) * 4;
const MAX_WIRE_BYTES: usize = MAX_BASE64_BYTES + 32768;
pub(crate) const HELPER: &str = include_str!("file_transfer.py");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxFileInfo {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxFileDownload {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub data_base64: String,
}

fn error(message: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: message.into(),
    }
}

pub(crate) fn validate_path(path: &str) -> Result<()> {
    if !path.starts_with('/')
        || path.len() > 4096
        || path.contains('\0')
        || path[1..]
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(error("file path must be an absolute guest path of at most 4096 bytes without empty, dot or parent components"));
    }
    Ok(())
}

pub(crate) fn validate_container_id(id: &str) -> Result<()> {
    if id.len() != 64 || !id.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err(error(
            "expected container ID must be the full Docker container identity",
        ));
    }
    Ok(())
}

pub(crate) fn decode_bytes(encoded: &str) -> Result<Vec<u8>> {
    if encoded.len() > MAX_BASE64_BYTES {
        return Err(error("file exceeds the 8 MiB transfer limit"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| error("invalid file base64"))?;
    if bytes.len() > MAX_TRANSFER_BYTES {
        return Err(error("file exceeds the 8 MiB transfer limit"));
    }
    Ok(bytes)
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// A known file error is returned *inside* the successful cleanup confirmation,
/// so EEXIST/permission/size failures do not quarantine an otherwise safe guest.
pub(crate) struct TransferReply(pub std::result::Result<serde_json::Value, String>);

pub(crate) async fn execute(
    container_id: &str,
    exec_user: Option<&str>,
    path: &str,
    data_base64: Option<&str>,
) -> Result<TransferReply> {
    let request = serde_json::json!({
        "operation": if data_base64.is_some() { "upload" } else { "download" },
        "path": path,
        "dataBase64": data_base64,
    })
    .to_string();
    // Use the same trusted absolute interpreter discovery as the supervisor.
    let argv = vec![
        "/bin/sh".into(),
        "-c".into(),
        lifecycle::execution::PYTHON_BOOTSTRAP.into(),
        "cognia-file-transfer".into(),
        HELPER.into(),
    ];
    let output = lifecycle::supervised_exec_with_limits(
        container_id,
        &argv,
        None,
        &BTreeMap::new(),
        Some(&request),
        Duration::from_secs(30),
        exec_user,
        MAX_WIRE_BYTES,
        MAX_WIRE_BYTES,
    )
    .await?;
    // From this point the supervisor has confirmed that no child remains.
    if output.outcome.timed_out || output.outcome.exit_code != 0 {
        return Ok(TransferReply(Err(
            "guest file operation failed or timed out after confirmed cleanup".into(),
        )));
    }
    if output.outcome.stdout_truncated {
        return Ok(TransferReply(Err(
            "guest file response exceeds transfer limit".into(),
        )));
    }
    let response: serde_json::Value = serde_json::from_slice(&output.stdout_bytes)
        .map_err(|_| error("invalid guest file response"))?;
    if let Some(message) = response.get("error").and_then(|value| value.as_str()) {
        return Ok(TransferReply(Err(message.to_owned())));
    }
    Ok(TransferReply(Ok(response
        .get("ok")
        .cloned()
        .ok_or_else(|| error("missing guest file response"))?)))
}

impl TransferReply {
    pub(crate) fn upload(self, path: &str, size: usize, hash: &str) -> Result<SandboxFileInfo> {
        let info: SandboxFileInfo = serde_json::from_value(self.0.map_err(error)?)
            .map_err(|_| error("invalid guest upload response"))?;
        if info.path != path || info.size != size as u64 || info.sha256 != hash {
            return Err(error(
                "guest upload result does not match the requested file",
            ));
        }
        Ok(info)
    }

    pub(crate) fn download(self, path: &str) -> Result<SandboxFileDownload> {
        let info: SandboxFileDownload = serde_json::from_value(self.0.map_err(error)?)
            .map_err(|_| error("invalid guest download response"))?;
        let bytes = decode_bytes(&info.data_base64)?;
        if info.path != path || info.size != bytes.len() as u64 || info.sha256 != sha256(&bytes) {
            return Err(error("guest download result failed integrity validation"));
        }
        Ok(info)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn run_helper(request: serde_json::Value) -> serde_json::Value {
        use std::io::Write;
        let mut child = std::process::Command::new("python3")
            .args(["-I", "-c", HELPER])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn actual_helper_reads_binary_and_rejects_symlinks_directories_and_oversize() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let path = root.join("binary");
        std::fs::write(&path, [0, 255, 128, 10]).unwrap();
        let response = run_helper(serde_json::json!({"operation":"download","path":path}));
        assert_eq!(
            TransferReply(Ok(response["ok"].clone()))
                .download(path.to_str().unwrap())
                .unwrap()
                .data_base64,
            "AP+ACg=="
        );
        let alias = root.join("alias");
        symlink(&path, &alias).unwrap();
        let parent_alias = root.join("parent-alias");
        symlink(&root, &parent_alias).unwrap();
        for rejected in [alias, parent_alias.join("binary"), root.clone()] {
            assert!(
                run_helper(serde_json::json!({"operation":"download","path":rejected}))["error"]
                    .is_string()
            );
        }
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_TRANSFER_BYTES as u64 + 1).unwrap();
        assert!(
            run_helper(serde_json::json!({"operation":"download","path":path}))["error"]
                .as_str()
                .unwrap()
                .contains("8 MiB")
        );
        assert!(run_helper(
            serde_json::json!({"operation":"upload","path":path,"dataBase64":"Zh=="})
        )["error"]
            .is_string());
    }

    #[test]
    fn transfer_bounds_binary_data_paths_and_full_container_identity() {
        let bytes = [0, 255, 128, 10];
        assert_eq!(
            decode_bytes(&base64::engine::general_purpose::STANDARD.encode(bytes)).unwrap(),
            bytes
        );
        assert_eq!(decode_bytes("").unwrap(), Vec::<u8>::new());
        for invalid in ["Zg", "Zh==", "Zg==\n", "!!!!"] {
            assert!(decode_bytes(invalid).is_err());
        }
        assert!(decode_bytes(&"A".repeat(MAX_BASE64_BYTES + 1)).is_err());
        let max = vec![0; MAX_TRANSFER_BYTES];
        assert_eq!(
            decode_bytes(&base64::engine::general_purpose::STANDARD.encode(&max))
                .unwrap()
                .len(),
            MAX_TRANSFER_BYTES
        );
        assert!(
            decode_bytes(&base64::engine::general_purpose::STANDARD.encode(vec![
                0;
                MAX_TRANSFER_BYTES
                    + 1
            ]))
            .is_err()
        );
        for path in ["relative", "/", "/a/../b", "/a//b", "/a/./b", "/a\0b"] {
            assert!(validate_path(path).is_err(), "{path}");
        }
        assert!(validate_path("/home/cua/literal ' file").is_ok());
        assert!(validate_container_id("short").is_err());
        assert!(validate_container_id(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn transfer_response_rejects_wrong_path_size_hash_and_preserves_known_errors() {
        let reply = |path: &str, size: u64, hash: &str| {
            TransferReply(Ok(
                serde_json::json!({"path":path,"size":size,"sha256":hash,"dataBase64":"AP8="}),
            ))
        };
        let hash = sha256(&[0, 255]);
        assert_eq!(reply("/file", 2, &hash).download("/file").unwrap().size, 2);
        assert!(reply("/other", 2, &hash).download("/file").is_err());
        assert!(reply("/file", 3, &hash).download("/file").is_err());
        assert!(reply("/file", 2, &"0".repeat(64))
            .download("/file")
            .is_err());
        assert!(TransferReply(Err("File exists".into()))
            .upload("/file", 2, &hash)
            .unwrap_err()
            .to_string()
            .contains("File exists"));
    }
}
