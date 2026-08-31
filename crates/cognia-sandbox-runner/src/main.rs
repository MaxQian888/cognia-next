//! ADR-0028 Phase 4 — non-elevated Windows sandbox runner.
//!
//! Reads a JSON `RunnerInput` from `argv[1]` and launches the requested argv
//! under a **restricted, low-integrity token** assigned to a **Job Object**,
//! then prints a JSON `RunnerOutput` (exit code + captured stdout/stderr +
//! duration + timeout flag).
//!
//! Sandbox model (Chromium / codex-windows-sandbox lineage):
//!   * `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` strips every privilege
//!     from a copy of our own token — no SeDebug, SeTcb, SeImpersonate, etc.
//!   * `SetTokenInformation(TokenIntegrityLevel = LOW)` runs the child at low
//!     integrity, so it cannot WRITE the user's medium-integrity files or
//!     inject into normal processes (the Windows mandatory-integrity write-up
//!     block). This is the path-agnostic Windows analogue of the bwrap /
//!     sandbox-exec write confinement.
//!   * A Job Object caps memory + active processes and kills the whole tree on
//!     handle close (no orphaned grandchildren).
//!   * Output is captured to inheritable temp files (deadlock-free vs. pipes).
//!
//! Because the launch token is a *restricted subset of the caller's own*
//! token, `CreateProcessAsUserW` succeeds WITHOUT `SeAssignPrimaryToken`
//! privilege — i.e. no elevation / UAC and no synthetic users. Network is not
//! confined here; the sandbox dispatcher already routes allowlisted egress
//! through the host-side filtering proxy via injected `HTTP(S)_PROXY` env.
//!
//! Build/check in isolation: `cargo check -p cognia-sandbox-runner`.

use std::collections::BTreeMap;

#[derive(serde::Deserialize)]
// Every field but `target_user` is consumed only by the Windows `mod win`
// runner; the non-Windows stub ignores the payload, so the fields read as dead
// there. They stay live on Windows, so scope the allow to non-Windows builds.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct RunnerInput {
    /// Retained for backward compatibility with the desktop backend's payload
    /// (the synthetic-user model); ignored by the restricted-token runner.
    #[serde(default)]
    #[allow(dead_code)]
    target_user: String,
    argv: Vec<String>,
    cwd: String,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    timeout_seconds: u64,
    /// 0 = no Job-Object memory cap.
    #[serde(default)]
    max_memory_mb: u32,
}

#[derive(serde::Serialize)]
struct RunnerOutput {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    timed_out: bool,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

const MAX_OUTPUT_BYTES: usize = 1_000_000;
const TRUNCATION_MARKER: &str = "\n... (truncated)";

fn read_capture(path: &std::path::Path) -> (String, bool) {
    use std::io::Read;

    let Ok(file) = std::fs::File::open(path) else {
        return (String::new(), false);
    };
    let mut bytes = Vec::with_capacity(8192);
    let _ = file
        .take((MAX_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes);
    let truncated = bytes.len() > MAX_OUTPUT_BYTES;
    bytes.truncate(MAX_OUTPUT_BYTES);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !truncated && text.len() <= MAX_OUTPUT_BYTES {
        return (text, false);
    }
    let content_cap = MAX_OUTPUT_BYTES.saturating_sub(TRUNCATION_MARKER.len());
    let mut end = content_cap.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}{}", &text[..end], TRUNCATION_MARKER), true)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let payload = match args.get(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: cognia-sandbox-runner <json-payload>");
            std::process::exit(2)
        }
    };
    let input: RunnerInput = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("invalid JSON payload: {e}");
            std::process::exit(2)
        }
    };
    match run(input) {
        Ok(result) => match serde_json::to_string(&result) {
            Ok(s) => println!("{s}"),
            Err(e) => {
                eprintln!("serialise output failed: {e}");
                std::process::exit(2)
            }
        },
        Err(e) => {
            eprintln!("runner failed: {e}");
            std::process::exit(2)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn run(_input: RunnerInput) -> Result<RunnerOutput, String> {
    Err("cognia-sandbox-runner runs on Windows only".into())
}

/// Convert a wait timeout to the `u32` milliseconds `WaitForSingleObject` wants,
/// without the silent `as u32` wrap that turned any timeout above ~49.7 days
/// (and, via `Duration::from_secs` overflow upstream, anything past ~71 minutes
/// in millis-as-u32 truncation) into a tiny value — making long-running commands
/// time out almost immediately. We saturate at `u32::MAX - 1` (≈49.7 days): a
/// finite, very-long ceiling that is deliberately NOT the `INFINITE`
/// (`u32::MAX`) sentinel, so a hung child can never wait forever.
///
/// Called by the Windows `mod win` runner and by the host-side unit tests
/// below; on a non-Windows, non-test build neither caller exists, so allow the
/// otherwise-dead symbol there rather than hard-gating it out of the tests.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn clamp_timeout_millis(timeout: std::time::Duration) -> u32 {
    const MAX_FINITE_MS: u128 = (u32::MAX - 1) as u128;
    timeout.as_millis().min(MAX_FINITE_MS) as u32
}

#[cfg(target_os = "windows")]
fn run(input: RunnerInput) -> Result<RunnerOutput, String> {
    win::run(input)
}

#[cfg(target_os = "windows")]
mod win {
    use super::{RunnerInput, RunnerOutput};
    use std::os::windows::ffi::OsStrExt;
    use std::time::{Duration, Instant};

    use windows::core::{BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows::Win32::Security::{
        CreateRestrictedToken, GetLengthSid, SetTokenInformation, TokenIntegrityLevel,
        DISABLE_MAX_PRIVILEGE, PSID, SID_AND_ATTRIBUTES, TOKEN_ACCESS_MASK, TOKEN_ADJUST_DEFAULT,
        TOKEN_ADJUST_PRIVILEGES, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL,
        TOKEN_QUERY,
    };

    /// `SE_GROUP_INTEGRITY` (0x20) — the attribute on a mandatory-integrity
    /// label. Inlined because the named constant moved across `windows`
    /// releases; the value is stable ABI.
    const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_ALWAYS, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
        ResumeThread, TerminateProcess, WaitForSingleObject, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    /// Owned HANDLE that closes itself on drop. Keeps the FFI bodies leak-free
    /// across the many early returns.
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Quote one argv element per the CreateProcess command-line rules.
    fn quote_arg(arg: &str) -> String {
        if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
            return arg.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0usize;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                    backslashes = 0;
                    out.push('"');
                }
                _ => {
                    out.extend(std::iter::repeat('\\').take(backslashes));
                    backslashes = 0;
                    out.push(c);
                }
            }
        }
        out.extend(std::iter::repeat('\\').take(backslashes * 2));
        out.push('"');
        out
    }

    /// Build the UTF-16 `KEY=VALUE\0...\0\0` block, merging `extra` over the
    /// current process environment so the child keeps PATH / SystemRoot etc.
    fn build_env_block(extra: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
        let mut merged: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        for (k, v) in extra {
            merged.insert(k.clone(), v.clone());
        }
        let mut block: Vec<u16> = Vec::new();
        for (k, v) in &merged {
            block.extend(wide(&format!("{k}={v}")));
        }
        block.push(0); // final terminating NUL after the last entry's NUL
        block
    }

    /// Create an inheritable, truncating temp file and return (handle, path).
    fn temp_capture_file(tag: &str) -> Result<(OwnedHandle, std::path::PathBuf), String> {
        let pid = std::process::id();
        let path = std::env::temp_dir().join(format!("cognia-sbx-{pid}-{tag}.tmp"));
        let wpath = wide(&path.to_string_lossy());
        // SECURITY_ATTRIBUTES { bInheritHandle: TRUE } via the raw struct.
        let sa = windows::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: BOOL(1),
        };
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wpath.as_ptr()),
                (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                Some(&sa),
                CREATE_ALWAYS,
                Default::default(),
                None,
            )
        }
        .map_err(|e| format!("create temp file failed: {e}"))?;
        if handle == INVALID_HANDLE_VALUE {
            return Err("create temp file returned INVALID_HANDLE_VALUE".into());
        }
        Ok((OwnedHandle(handle), path))
    }

    pub fn run(input: RunnerInput) -> Result<RunnerOutput, String> {
        if input.argv.is_empty() {
            return Err("argv is empty".into());
        }
        let started = Instant::now();
        let timeout = if input.timeout_seconds == 0 {
            Duration::from_secs(300)
        } else {
            Duration::from_secs(input.timeout_seconds)
        };

        // 1. Restricted, de-privileged token derived from our own.
        let mut proc_token = HANDLE::default();
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ACCESS_MASK(
                    TOKEN_DUPLICATE.0
                        | TOKEN_ASSIGN_PRIMARY.0
                        | TOKEN_QUERY.0
                        | TOKEN_ADJUST_DEFAULT.0
                        | TOKEN_ADJUST_PRIVILEGES.0,
                ),
                &mut proc_token,
            )
        }
        .map_err(|e| format!("OpenProcessToken failed: {e}"))?;
        let _proc_token = OwnedHandle(proc_token);

        let mut restricted = HANDLE::default();
        unsafe {
            CreateRestrictedToken(
                proc_token,
                DISABLE_MAX_PRIVILEGE,
                None,
                None,
                None,
                &mut restricted,
            )
        }
        .map_err(|e| format!("CreateRestrictedToken failed: {e}"))?;
        let restricted = OwnedHandle(restricted);

        // 2. Drop the token to LOW integrity (S-1-16-4096).
        set_low_integrity(restricted.0)?;

        // 3. Job object with resource limits, kill-on-close.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
        let job = OwnedHandle(job);
        configure_job(job.0, input.max_memory_mb)?;

        // 4. Inheritable stdout/stderr capture files.
        let (out_h, out_path) = temp_capture_file("out")?;
        let (err_h, err_path) = temp_capture_file("err")?;

        // 5. Spawn suspended under the restricted token, assign to the job.
        let mut cmdline: Vec<u16> = wide(
            &input
                .argv
                .iter()
                .map(|a| quote_arg(a))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let cwd = wide(&input.cwd);
        let mut env_block = build_env_block(&input.env);

        let mut si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdOutput: out_h.0,
            hStdError: err_h.0,
            hStdInput: HANDLE::default(),
            ..Default::default()
        };
        let mut pi = PROCESS_INFORMATION::default();

        unsafe {
            CreateProcessAsUserW(
                Some(restricted.0),
                PCWSTR::null(),
                Some(PWSTR(cmdline.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                Some(env_block.as_mut_ptr() as *mut _),
                PCWSTR(cwd.as_ptr()),
                &si,
                &mut pi,
            )
        }
        .map_err(|e| format!("CreateProcessAsUserW failed: {e}"))?;
        let _process = OwnedHandle(pi.hProcess);
        let _thread = OwnedHandle(pi.hThread);

        unsafe {
            let _ = AssignProcessToJobObject(job.0, pi.hProcess);
            ResumeThread(pi.hThread);
        }

        // Close our copies of the capture handles so only the child writes; the
        // files become readable once the child (and the job) close on exit.
        drop(out_h);
        drop(err_h);
        let _ = &mut si; // keep `si` alive across the call above

        // 6. Wait with timeout.
        let timed_out;
        let exit_code;
        let wait =
            unsafe { WaitForSingleObject(pi.hProcess, super::clamp_timeout_millis(timeout)) };
        if wait == WAIT_TIMEOUT {
            timed_out = true;
            unsafe {
                let _ = TerminateJobObject(job.0, 1);
                let _ = TerminateProcess(pi.hProcess, 1);
            }
            exit_code = -1;
        } else if wait == WAIT_OBJECT_0 {
            timed_out = false;
            let mut code: u32 = 0;
            unsafe {
                let _ = GetExitCodeProcess(pi.hProcess, &mut code);
            }
            exit_code = code as i32;
        } else {
            return Err(format!("WaitForSingleObject returned 0x{:x}", wait.0));
        }

        // 7. Read + clean up the capture files.
        let (stdout, stdout_truncated) = super::read_capture(&out_path);
        let (stderr, stderr_truncated) = super::read_capture(&err_path);
        let _ = std::fs::remove_file(&out_path);
        let _ = std::fs::remove_file(&err_path);

        Ok(RunnerOutput {
            exit_code,
            stdout,
            stderr,
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out,
            stdout_truncated,
            stderr_truncated,
        })
    }

    fn set_low_integrity(token: HANDLE) -> Result<(), String> {
        let sid_str = wide("S-1-16-4096");
        let mut psid = PSID::default();
        unsafe { ConvertStringSidToSidW(PCWSTR(sid_str.as_ptr()), &mut psid) }
            .map_err(|e| format!("ConvertStringSidToSidW failed: {e}"))?;
        let sid_len = unsafe { GetLengthSid(psid) };
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES {
                Sid: psid,
                Attributes: SE_GROUP_INTEGRITY,
            },
        };
        let res = unsafe {
            SetTokenInformation(
                token,
                TokenIntegrityLevel,
                &label as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + sid_len,
            )
        };
        // The SID from ConvertStringSidToSidW is LocalAlloc'd; this runner is a
        // one-shot process that exits immediately after, so the OS reclaims it —
        // no explicit LocalFree needed (and avoids pulling Win32_System_Memory).
        res.map_err(|e| format!("SetTokenInformation(integrity) failed: {e}"))
    }

    fn configure_job(job: HANDLE, max_memory_mb: u32) -> Result<(), String> {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        // A generous active-process cap bounds fork bombs without breaking
        // normal build tool fan-out.
        info.BasicLimitInformation.ActiveProcessLimit = 512;
        if max_memory_mb > 0 {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = (max_memory_mb as usize) * 1024 * 1024;
        }
        unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|e| format!("SetInformationJobObject failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::clamp_timeout_millis;
    use std::time::Duration;

    const INFINITE: u32 = u32::MAX;

    #[test]
    fn short_timeout_passes_through_unchanged() {
        assert_eq!(clamp_timeout_millis(Duration::from_secs(300)), 300_000);
    }

    #[test]
    fn ninety_minute_timeout_is_not_truncated() {
        // 90 min = 5_400_000 ms — above the old u32-wrap edge but well under the
        // saturation ceiling, so it must round-trip exactly (the bug returned a
        // tiny wrapped value here, causing an instant timeout).
        let ms = 90u64 * 60 * 1000;
        assert_eq!(
            clamp_timeout_millis(Duration::from_secs(90 * 60)),
            ms as u32
        );
    }

    #[test]
    fn huge_timeout_saturates_below_the_infinite_sentinel() {
        let clamped = clamp_timeout_millis(Duration::from_secs(60 * 60 * 24 * 365));
        assert_eq!(clamped, INFINITE - 1);
        assert_ne!(clamped, INFINITE, "must never become the INFINITE sentinel");
    }

    #[test]
    fn exactly_at_the_ceiling_clamps_to_max_finite() {
        let clamped = clamp_timeout_millis(Duration::from_millis(u32::MAX as u64));
        assert_eq!(clamped, INFINITE - 1);
    }
}
