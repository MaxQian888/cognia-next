// `!cmd` mode in the chat composer routes through this command. We intentionally
// invoke the platform's default shell so users can write the same one-liners
// they would in their terminal (`ls -la`, `dir`, pipes, &&, ...). Output is
// captured and returned to the renderer as a single blob — no streaming.
//
// Safety: this is a desktop app for a developer audience, not a sandboxed
// surface. We still bound runtime via `wait-timeout` so a hung command can't
// pin a Tauri worker thread, and we cap captured output so a chatty command
// can't blow up the IPC channel.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 5 * 60;

#[derive(Debug, Serialize, Deserialize)]
pub struct ShellResult {
    pub stdout: String,
    pub stderr: String,
    /// `None` when the process was killed by the timeout.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Spawn `cmd` via the platform shell inside `cwd` and capture stdout+stderr
/// up to the configured cap. Times out after `timeout_secs` (default 30, hard
/// max 5 minutes) — the child is killed and `timed_out` is set.
#[tauri::command]
pub fn shell_exec(
    cmd: String,
    cwd: String,
    timeout_secs: Option<u64>,
) -> Result<ShellResult, String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    let cwd_path = std::path::PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("cwd is not a directory: {}", cwd));
    }
    let timeout = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);

    let mut command = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(trimmed);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(trimmed);
        c
    };
    command
        .current_dir(&cwd_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    let mut child = command.spawn().map_err(|e| format!("spawn shell: {}", e))?;

    let status = match child.wait_timeout(Duration::from_secs(timeout)) {
        Ok(Some(s)) => Some(s),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
        Err(e) => {
            let _ = child.kill();
            return Err(format!("wait shell: {}", e));
        }
    };

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();
    let stdout_truncated = if let Some(mut s) = child.stdout.take() {
        read_capped(&mut s, &mut stdout_buf)
    } else {
        false
    };
    let stderr_truncated = if let Some(mut s) = child.stderr.take() {
        read_capped(&mut s, &mut stderr_buf)
    } else {
        false
    };

    Ok(ShellResult {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code: status.and_then(|s| s.code()),
        timed_out: status.is_none(),
        stdout_truncated,
        stderr_truncated,
    })
}

fn read_capped<R: Read>(src: &mut R, dest: &mut String) -> bool {
    let mut raw = Vec::with_capacity(4096);
    let mut buf = [0u8; 4096];
    let mut truncated = false;
    loop {
        match src.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if raw.len() + n > MAX_OUTPUT_BYTES {
                    let take = MAX_OUTPUT_BYTES.saturating_sub(raw.len());
                    raw.extend_from_slice(&buf[..take]);
                    truncated = true;
                    // drain rest so the child can finish closing its pipe
                    let _ = std::io::copy(src, &mut std::io::sink());
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
            }
            Err(_) => break,
        }
    }
    *dest = String::from_utf8_lossy(&raw).into_owned();
    if truncated {
        dest.push_str("\n... (truncated)");
    }
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_cwd() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("cognia-shell-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    #[test]
    fn echoes_text() {
        let cwd = temp_cwd();
        let res = shell_exec(
            if cfg!(target_os = "windows") {
                "echo hi".into()
            } else {
                "printf hi".into()
            },
            cwd.to_string_lossy().to_string(),
            Some(5),
        )
        .unwrap();
        assert!(res.stdout.contains("hi"), "stdout: {:?}", res.stdout);
        assert!(!res.timed_out);
        assert_eq!(res.exit_code, Some(0));
        let _ = std::fs::remove_dir_all(&cwd);
    }

    #[test]
    fn rejects_empty() {
        let res = shell_exec(
            "   ".into(),
            std::env::temp_dir().to_string_lossy().into(),
            Some(1),
        );
        assert!(res.is_err());
    }

    #[test]
    fn rejects_bad_cwd() {
        let res = shell_exec(
            "echo hi".into(),
            "/definitely/not/a/real/path-xyz".into(),
            Some(1),
        );
        assert!(res.is_err());
    }
}
