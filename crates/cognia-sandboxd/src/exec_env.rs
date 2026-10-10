//! `exec-env`: environment and working directory for an exec that cannot
//! carry them (ADR-0221).
//!
//! Docker's exec API takes `Env` and `WorkingDir`; Kubernetes' pod exec takes
//! only an argv. A remote provider whose exec is argv-only therefore runs
//!
//! ```text
//! cognia-sandboxd exec-env -- <argv…>
//! ```
//!
//! and writes one frame to the exec's stdin before anything else:
//!
//! ```text
//! +----------------------+---------------------------------------------+
//! | length L: u32, BE    | L bytes of UTF-8 JSON                       |
//! +----------------------+---------------------------------------------+
//!   {"env":["KEY=VALUE",…],"cwd":"/absolute/path"}
//! ```
//!
//! - `L` is at most [`MAX_FRAME_LEN`] (1 MiB).
//! - `env` entries are added to the inherited environment (a later entry
//!   for the same name wins). Names match `[A-Za-z_][A-Za-z0-9_]*`; a value
//!   may contain `=` but no NUL byte. `env` may be omitted.
//! - `cwd`, when present, is an absolute path the command starts in. When
//!   omitted the command starts where the exec put it.
//! - Unknown fields are refused, so a newer Host cannot silently lose one.
//!
//! The frame is read with unbuffered reads of exactly the bytes it occupies:
//! everything after it is the command's stdin, which the command inherits
//! untouched. Then `exec-env` replaces itself with the command (`PATH` from
//! the resulting environment, as Docker's exec resolves it).
//!
//! Exit codes when the command never starts: 125 for a bad frame, 126 for a
//! command that cannot be executed, 127 for one that does not exist.

use std::collections::BTreeMap;
use std::io::{self, Read};

use serde::{Deserialize, Serialize};

/// The largest frame `exec-env` accepts.
pub const MAX_FRAME_LEN: u32 = 1024 * 1024;

/// Status for a frame that could not be read or validated.
pub const EXIT_BAD_FRAME: u8 = 125;
/// Status for a command that exists but cannot be executed.
pub const EXIT_NOT_EXECUTABLE: u8 = 126;
/// Status for a command that does not exist.
pub const EXIT_NOT_FOUND: u8 = 127;

/// The environment handoff of one exec.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecEnvFrame {
    /// `KEY=VALUE` entries added to the inherited environment.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<String>,
    /// Absolute working directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Why a frame was refused.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("cannot read the exec-env frame: {0}")]
    Read(#[source] io::Error),
    #[error("the exec-env frame is {0} bytes; at most {MAX_FRAME_LEN} are accepted")]
    TooLarge(u64),
    #[error("the exec-env frame is not valid JSON: {0}")]
    Json(#[source] serde_json::Error),
    #[error("invalid environment entry {0:?}: expected NAME=VALUE with NAME matching [A-Za-z_][A-Za-z0-9_]*")]
    InvalidEnv(String),
    #[error("environment value of {0} contains a NUL byte")]
    NulInValue(String),
    #[error("working directory {0:?} is not an absolute path")]
    InvalidCwd(String),
}

/// The validated content of a frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecEnv {
    /// Name to value; a later duplicate in the frame wins.
    pub env: BTreeMap<String, String>,
    pub cwd: Option<String>,
}

/// Encode a frame, validating it first so a Host never sends one the
/// sandbox would refuse.
pub fn encode_frame(frame: &ExecEnvFrame) -> Result<Vec<u8>, FrameError> {
    validate(frame)?;
    let json = serde_json::to_vec(frame).map_err(FrameError::Json)?;
    let len = u32::try_from(json.len())
        .ok()
        .filter(|len| *len <= MAX_FRAME_LEN)
        .ok_or(FrameError::TooLarge(json.len() as u64))?;
    let mut encoded = Vec::with_capacity(4 + json.len());
    encoded.extend_from_slice(&len.to_be_bytes());
    encoded.extend_from_slice(&json);
    Ok(encoded)
}

/// Read exactly one frame from `reader` and nothing more. `read_exact` asks
/// for no more than the bytes still missing, so an unbuffered reader (a raw
/// fd) is left positioned at the first byte after the frame.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<ExecEnvFrame, FrameError> {
    let mut header = [0u8; 4];
    reader.read_exact(&mut header).map_err(FrameError::Read)?;
    let len = u32::from_be_bytes(header);
    if len > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge(u64::from(len)));
    }
    let mut body = vec![0u8; len as usize];
    reader.read_exact(&mut body).map_err(FrameError::Read)?;
    serde_json::from_slice(&body).map_err(FrameError::Json)
}

/// Whether `name` is a portable environment variable name.
pub fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Check a frame and resolve its entries.
pub fn validate(frame: &ExecEnvFrame) -> Result<ExecEnv, FrameError> {
    let mut env = BTreeMap::new();
    for entry in &frame.env {
        let (name, value) = entry
            .split_once('=')
            .ok_or_else(|| FrameError::InvalidEnv(entry.clone()))?;
        if !is_valid_env_name(name) {
            return Err(FrameError::InvalidEnv(entry.clone()));
        }
        if value.contains('\0') {
            return Err(FrameError::NulInValue(name.to_string()));
        }
        env.insert(name.to_string(), value.to_string());
    }
    if let Some(cwd) = &frame.cwd {
        if !cwd.starts_with('/') || cwd.contains('\0') {
            return Err(FrameError::InvalidCwd(cwd.clone()));
        }
    }
    Ok(ExecEnv {
        env,
        cwd: frame.cwd.clone(),
    })
}

/// Read the frame from this process's stdin without buffering: the read goes
/// through a duplicate of fd 0, so nothing past the frame is consumed.
#[cfg(unix)]
pub fn read_stdin_frame() -> Result<ExecEnv, FrameError> {
    use std::os::fd::AsFd;
    let fd = io::stdin()
        .as_fd()
        .try_clone_to_owned()
        .map_err(FrameError::Read)?;
    let mut raw = std::fs::File::from(fd);
    let frame = read_frame(&mut raw)?;
    validate(&frame)
}

/// Replace this process with `argv` under `env`. Returns only on failure,
/// with the exit status that failure maps to.
#[cfg(unix)]
pub fn exec(argv: &[std::ffi::OsString], env: &ExecEnv) -> (io::Error, u8) {
    use std::os::unix::process::CommandExt;
    let Some((program, args)) = argv.split_first() else {
        return (
            io::Error::new(io::ErrorKind::InvalidInput, "exec-env needs a command"),
            EXIT_BAD_FRAME,
        );
    };
    // Change directory here rather than in the exec, so a missing working
    // directory is reported as a bad frame, not as a missing command.
    if let Some(cwd) = &env.cwd {
        if let Err(error) = std::env::set_current_dir(cwd) {
            return (
                io::Error::new(
                    error.kind(),
                    format!("cannot enter working directory {cwd}: {error}"),
                ),
                EXIT_BAD_FRAME,
            );
        }
    }
    let error = std::process::Command::new(program)
        .args(args)
        .envs(&env.env)
        .exec();
    let status = match error.kind() {
        io::ErrorKind::NotFound => EXIT_NOT_FOUND,
        io::ErrorKind::PermissionDenied => EXIT_NOT_EXECUTABLE,
        _ => EXIT_BAD_FRAME,
    };
    (error, status)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn frame(env: &[&str], cwd: Option<&str>) -> ExecEnvFrame {
        ExecEnvFrame {
            env: env.iter().map(|entry| entry.to_string()).collect(),
            cwd: cwd.map(str::to_string),
        }
    }

    /// A reader that hands out at most one byte per call, as a pipe may.
    struct Trickle {
        inner: Cursor<Vec<u8>>,
    }

    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let take = buf.len().min(1);
            self.inner.read(&mut buf[..take])
        }
    }

    #[test]
    fn a_frame_round_trips_and_leaves_the_rest_of_stdin() {
        let sent = frame(&["A=1", "PATH=/usr/bin:/bin", "EQ=a=b"], Some("/workspace"));
        let mut bytes = encode_frame(&sent).unwrap();
        let frame_len = bytes.len();
        bytes.extend_from_slice(b"child stdin");
        let mut reader = Cursor::new(bytes);
        assert_eq!(read_frame(&mut reader).unwrap(), sent);
        assert_eq!(reader.position() as usize, frame_len);
        let mut rest = String::new();
        reader.read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "child stdin");
    }

    #[test]
    fn short_reads_still_consume_exactly_the_frame() {
        let sent = frame(&["K=V"], None);
        let mut bytes = encode_frame(&sent).unwrap();
        let frame_len = bytes.len();
        bytes.extend_from_slice(&[0xff, 0x00, 0x01]);
        let mut reader = Trickle {
            inner: Cursor::new(bytes),
        };
        assert_eq!(read_frame(&mut reader).unwrap(), sent);
        assert_eq!(reader.inner.position() as usize, frame_len);
    }

    #[test]
    fn the_header_is_big_endian_length_then_json() {
        let bytes = encode_frame(&frame(&[], Some("/w"))).unwrap();
        let json = br#"{"cwd":"/w"}"#;
        assert_eq!(&bytes[..4], &(json.len() as u32).to_be_bytes());
        assert_eq!(&bytes[4..], json);
        // An empty frame is an empty object.
        assert_eq!(&encode_frame(&ExecEnvFrame::default()).unwrap()[4..], b"{}");
    }

    #[test]
    fn oversized_and_truncated_frames_are_refused() {
        let mut huge = (MAX_FRAME_LEN + 1).to_be_bytes().to_vec();
        huge.extend_from_slice(b"{}");
        assert!(matches!(
            read_frame(&mut Cursor::new(huge)),
            Err(FrameError::TooLarge(_))
        ));
        let mut truncated = 10u32.to_be_bytes().to_vec();
        truncated.extend_from_slice(b"{}");
        assert!(matches!(
            read_frame(&mut Cursor::new(truncated)),
            Err(FrameError::Read(_))
        ));
        assert!(matches!(
            read_frame(&mut Cursor::new(vec![0, 0])),
            Err(FrameError::Read(_))
        ));
        let big_value = "x".repeat(MAX_FRAME_LEN as usize);
        assert!(matches!(
            encode_frame(&frame(&[&format!("A={big_value}")], None)),
            Err(FrameError::TooLarge(_))
        ));
    }

    #[test]
    fn unknown_fields_and_malformed_json_are_refused() {
        let body = br#"{"env":[],"cwd":"/w","user":"root"}"#;
        let mut bytes = (body.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(body);
        assert!(matches!(
            read_frame(&mut Cursor::new(bytes)),
            Err(FrameError::Json(_))
        ));
        let mut bytes = 3u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{x}");
        assert!(matches!(
            read_frame(&mut Cursor::new(bytes)),
            Err(FrameError::Json(_))
        ));
    }

    #[test]
    fn env_names_and_values_are_validated() {
        for bad in ["NOEQUALS", "=v", "1A=v", "A-B=v", "A B=v", "Ä=v"] {
            assert!(
                matches!(
                    validate(&frame(&[bad], None)),
                    Err(FrameError::InvalidEnv(_))
                ),
                "{bad}"
            );
        }
        assert!(matches!(
            validate(&frame(&["A=x\0y"], None)),
            Err(FrameError::NulInValue(name)) if name == "A"
        ));
        let resolved = validate(&frame(&["_A1=", "A=1", "A=2", "B=x=y"], None)).unwrap();
        assert_eq!(resolved.env.get("_A1").map(String::as_str), Some(""));
        assert_eq!(resolved.env.get("A").map(String::as_str), Some("2"));
        assert_eq!(resolved.env.get("B").map(String::as_str), Some("x=y"));
        assert!(encode_frame(&frame(&["1BAD=v"], None)).is_err());
    }

    #[test]
    fn the_working_directory_must_be_absolute() {
        assert!(matches!(
            validate(&frame(&[], Some("workspace"))),
            Err(FrameError::InvalidCwd(_))
        ));
        assert!(matches!(
            validate(&frame(&[], Some(""))),
            Err(FrameError::InvalidCwd(_))
        ));
        assert_eq!(
            validate(&frame(&[], Some("/workspace/repo")))
                .unwrap()
                .cwd
                .as_deref(),
            Some("/workspace/repo")
        );
        assert_eq!(validate(&frame(&[], None)).unwrap().cwd, None);
    }

    #[test]
    fn env_names_follow_the_portable_grammar() {
        assert!(is_valid_env_name("PATH"));
        assert!(is_valid_env_name("_x9"));
        assert!(!is_valid_env_name(""));
        assert!(!is_valid_env_name("9x"));
        assert!(!is_valid_env_name("a.b"));
    }

    #[cfg(unix)]
    #[test]
    fn exec_failures_map_to_docker_exit_statuses() {
        let env = validate(&frame(&["PATH=/nonexistent-cognia"], None)).unwrap();
        let (error, status) = exec(&["cognia-no-such-command".into()], &env);
        assert_eq!(status, EXIT_NOT_FOUND, "{error}");
        let (error, status) = exec(&[], &env);
        assert_eq!(status, EXIT_BAD_FRAME, "{error}");

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("not-executable");
        std::fs::write(&script, b"#!/bin/sh\n").unwrap();
        let (error, status) = exec(&[script.into_os_string()], &env);
        assert_eq!(status, EXIT_NOT_EXECUTABLE, "{error}");

        let missing = validate(&frame(&[], Some("/nonexistent-cognia-cwd"))).unwrap();
        let (error, status) = exec(&["true".into()], &missing);
        assert_eq!(status, EXIT_BAD_FRAME, "{error}");
        assert!(error.to_string().contains("working directory"), "{error}");
    }
}
