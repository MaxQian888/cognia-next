//! ADR-0028 Phase 4 — non-elevated Windows sandbox runner.
//!
//! Reads a strict v2 JSON request from stdin (or rootless legacy argv), turns it into a
//! [`LaunchPlan`](cognia_sandbox_runner::LaunchPlan) — which decides the
//! limits, the child's environment and what confinement is actually on offer
//! — and launches the requested argv under a **restricted, low-integrity
//! token** assigned to a **Job Object**, then prints a JSON `RunnerOutput`
//! (exit code + captured stdout/stderr + duration + timeout flag + the
//! confinement that was enforced).
//!
//! Sandbox model (Chromium / codex-windows-sandbox lineage):
//!   * `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE)` strips every privilege
//!     from a copy of our own token — no SeDebug, SeTcb, SeImpersonate, etc.
//!   * `SetTokenInformation(TokenIntegrityLevel = LOW)` runs the child at low
//!     integrity, so it cannot WRITE the user's medium-integrity files or
//!     inject into normal processes (the Windows mandatory-integrity write-up
//!     block). This is the path-agnostic Windows analogue of the bwrap /
//!     sandbox-exec write confinement.
//!   * A Job Object caps active processes, per-process and job-wide committed
//!     memory, and per-process CPU time, and kills the whole tree on handle
//!     close (no orphaned grandchildren).
//!   * The child's environment is the caller's plus an OS allowlist; the
//!     runner's own environment, provider keys and `DOCKER_HOST` included, is
//!     not inherited.
//!   * Output uses anonymous pipes drained concurrently with bounded buffers.
//!
//! Because the launch token is a *restricted subset of the caller's own*
//! token, `CreateProcessAsUserW` succeeds WITHOUT `SeAssignPrimaryToken`
//! privilege — i.e. no elevation / UAC and no synthetic users.
//!
//! **Egress is not confined on this tier.** A payload that asks for
//! `network: "off"` is refused with exit code
//! [`EXIT_CONFINEMENT_UNAVAILABLE`] rather than run with an open network; see
//! `lib.rs` for why that is the fail-closed answer and not a regression.
//!
//! Build/check in isolation: `cargo check -p cognia-sandbox-runner`.

use cognia_sandbox_runner::{
    capabilities_v2, parse_v2, plan, LaunchPlan, PlanError, RunnerOutput,
    EXIT_CONFINEMENT_UNAVAILABLE, MAX_OUTPUT_BYTES, TRUNCATION_MARKER,
};

/// Drain a stream to EOF while retaining at most the per-stream output cap.
/// Concurrent readers prevent one full pipe from blocking the other stream.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn read_capture(mut reader: impl std::io::Read) -> std::io::Result<(String, bool)> {
    let mut bytes = Vec::with_capacity(8192);
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        let keep = count.min(MAX_OUTPUT_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < count;
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !truncated && text.len() <= MAX_OUTPUT_BYTES {
        return Ok((text, false));
    }
    let content_cap = MAX_OUTPUT_BYTES.saturating_sub(TRUNCATION_MARKER.len());
    let mut end = content_cap.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    Ok((format!("{}{}", &text[..end], TRUNCATION_MARKER), true))
}

fn read_input(args: &[String]) -> Result<cognia_sandbox_runner::RunnerInput, String> {
    if args.len() != 2 {
        return Err(
            "usage: cognia-sandbox-runner --protocol-v2 | --capabilities-v2 | <legacy-json>".into(),
        );
    }
    if args[1] == "--protocol-v2" {
        use std::io::Read;
        const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;
        let mut payload = String::new();
        std::io::stdin()
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_string(&mut payload)
            .map_err(|error| format!("read request: {error}"))?;
        if payload.len() as u64 > MAX_REQUEST_BYTES {
            return Err("runner request exceeds size limit".into());
        }
        parse_v2(&payload)
    } else {
        serde_json::from_str(&args[1]).map_err(|error| format!("invalid legacy payload: {error}"))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--capabilities-v2" {
        match serde_json::to_string(&capabilities_v2()) {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("serialise capabilities: {error}");
                std::process::exit(2);
            }
        }
        return;
    }
    let input = match read_input(&args) {
        Ok(input) => input,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    // Nothing is launched until the plan says the confinement the caller
    // asked for can be enforced.
    let launch = match plan(&input) {
        Ok(launch) => launch,
        Err(
            error @ (PlanError::NetworkConfinementUnavailable(_)
            | PlanError::FilesystemConfinementUnavailable),
        ) => {
            eprintln!("{error}");
            std::process::exit(EXIT_CONFINEMENT_UNAVAILABLE)
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2)
        }
    };
    match run(&launch) {
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
fn run(_launch: &LaunchPlan) -> Result<RunnerOutput, String> {
    Err("cognia-sandbox-runner runs on Windows only".into())
}

#[cfg(target_os = "windows")]
fn run(launch: &LaunchPlan) -> Result<RunnerOutput, String> {
    win::run(launch)
}

#[cfg(target_os = "windows")]
mod win {
    use cognia_sandbox_runner::{cpu_time_100ns, JobLimits, LaunchPlan, RunnerOutput};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::time::Instant;

    use windows::core::{BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
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
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JOB_OBJECT_LIMIT_PROCESS_TIME,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, STARTUPINFOW,
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
                    out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                    backslashes = 0;
                    out.push('"');
                }
                _ => {
                    out.extend(std::iter::repeat_n('\\', backslashes));
                    backslashes = 0;
                    out.push(c);
                }
            }
        }
        out.extend(std::iter::repeat_n('\\', backslashes * 2));
        out.push('"');
        out
    }

    /// Build the UTF-16 `KEY=VALUE\0...\0\0` block from the plan's
    /// environment. The plan already decided what the host contributes, so
    /// nothing is merged in here: the desktop app's own variables, provider
    /// keys included, stay out of the sandbox.
    fn build_env_block(environment: &std::collections::BTreeMap<String, String>) -> Vec<u16> {
        let mut block: Vec<u16> = Vec::new();
        for (k, v) in environment {
            block.extend(wide(&format!("{k}={v}")));
        }
        block.push(0); // final terminating NUL after the last entry's NUL
        block
    }

    /// Only the child end remains inheritable, and the explicit launch list
    /// below further limits inheritance to the three intended standard handles.
    fn anonymous_pipe(child_reads: bool) -> Result<(OwnedHandle, OwnedHandle), String> {
        let sa = windows::Win32::Security::SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<windows::Win32::Security::SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: BOOL(1),
        };
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        unsafe { CreatePipe(&mut read, &mut write, Some(&sa), 0) }
            .map_err(|error| format!("CreatePipe failed: {error}"))?;
        let read = OwnedHandle(read);
        let write = OwnedHandle(write);
        let parent = if child_reads { write.0 } else { read.0 };
        unsafe { SetHandleInformation(parent, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) }
            .map_err(|error| format!("SetHandleInformation failed: {error}"))?;
        Ok((read, write))
    }

    struct HandleList {
        // Pointer-aligned storage must outlive the initialized attribute list.
        _storage: Vec<usize>,
        pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    }
    impl Drop for HandleList {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
        }
    }
    impl HandleList {
        fn new(handles: &[HANDLE]) -> Result<Self, String> {
            let mut bytes = 0;
            unsafe {
                let _ = InitializeProcThreadAttributeList(None, 1, None, &mut bytes);
            }
            if bytes == 0 {
                return Err("attribute list size unavailable".into());
            }
            let mut storage = vec![0_usize; bytes.div_ceil(std::mem::size_of::<usize>())];
            let pointer = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
            unsafe { InitializeProcThreadAttributeList(Some(pointer), 1, None, &mut bytes) }
                .map_err(|error| format!("initialize handle list failed: {error}"))?;
            let list = Self {
                _storage: storage,
                pointer,
            };
            unsafe {
                UpdateProcThreadAttribute(
                    pointer,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    Some(handles.as_ptr().cast()),
                    std::mem::size_of_val(handles),
                    None,
                    None,
                )
            }
            .map_err(|error| format!("set handle list failed: {error}"))?;
            Ok(list)
        }
    }

    fn capture_reader(
        handle: OwnedHandle,
    ) -> std::thread::JoinHandle<std::io::Result<(String, bool)>> {
        let file = unsafe { std::fs::File::from_raw_handle(handle.0 .0) };
        std::mem::forget(handle); // File now owns and closes the pipe handle.
        std::thread::spawn(move || super::read_capture(file))
    }

    pub fn run(launch: &LaunchPlan) -> Result<RunnerOutput, String> {
        let started = Instant::now();

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

        // 3. Job object with the plan's resource limits, kill-on-close.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;
        let job = OwnedHandle(job);
        configure_job(job.0, &launch.job)?;

        // 4. Anonymous pipes: stdin is EOF, output is drained concurrently.
        let (out_read, out_h) = anonymous_pipe(false)?;
        let (err_read, err_h) = anonymous_pipe(false)?;
        let (stdin_h, stdin_write) = anonymous_pipe(true)?;
        drop(stdin_write);
        let inherited_handles = [stdin_h.0, out_h.0, err_h.0];
        let handle_list = HandleList::new(&inherited_handles)?;

        // 5. Spawn suspended under the restricted token, assign to the job.
        let mut cmdline: Vec<u16> = wide(
            &launch
                .argv
                .iter()
                .map(|a| quote_arg(a))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let cwd = wide(&launch.cwd);
        let mut env_block = build_env_block(&launch.environment);

        let si = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                dwFlags: STARTF_USESTDHANDLES,
                hStdOutput: out_h.0,
                hStdError: err_h.0,
                hStdInput: stdin_h.0,
                ..Default::default()
            },
            lpAttributeList: handle_list.pointer,
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
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
                Some(env_block.as_mut_ptr() as *mut _),
                PCWSTR(cwd.as_ptr()),
                &si.StartupInfo,
                &mut pi,
            )
        }
        .map_err(|e| format!("CreateProcessAsUserW failed: {e}"))?;
        let _process = OwnedHandle(pi.hProcess);
        let _thread = OwnedHandle(pi.hThread);

        if let Err(error) = unsafe { AssignProcessToJobObject(job.0, pi.hProcess) } {
            unsafe { TerminateProcess(pi.hProcess, 1) }.map_err(|terminate_error| {
                format!("AssignProcessToJobObject failed: {error}; suspended child termination failed: {terminate_error}")
            })?;
            return Err(format!(
                "AssignProcessToJobObject failed; suspended child terminated: {error}"
            ));
        }
        if unsafe { ResumeThread(pi.hThread) } == u32::MAX {
            let error = windows::core::Error::from_thread();
            unsafe { TerminateProcess(pi.hProcess, 1) }.map_err(|terminate_error| {
                format!("ResumeThread failed: {error}; suspended child termination failed: {terminate_error}")
            })?;
            return Err(format!(
                "ResumeThread failed; suspended child terminated: {error}"
            ));
        }

        drop(out_h);
        drop(err_h);
        drop(stdin_h);
        let stdout_reader = capture_reader(out_read);
        let stderr_reader = capture_reader(err_read);

        // 6. Wait with timeout.
        let timed_out;
        let exit_code;
        let wait = unsafe {
            WaitForSingleObject(
                pi.hProcess,
                cognia_sandbox_runner::clamp_timeout_millis(launch.timeout),
            )
        };
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
            unsafe { GetExitCodeProcess(pi.hProcess, &mut code) }
                .map_err(|error| format!("GetExitCodeProcess failed: {error}"))?;
            exit_code = code as i32;
        } else {
            return Err(format!("WaitForSingleObject returned 0x{:x}", wait.0));
        }

        // Closing the kill-on-close job ends any descendants retaining pipe
        // writers, so both drainers reach EOF even after the main child exits.
        drop(job);
        let (stdout, stdout_truncated) = stdout_reader
            .join()
            .map_err(|_| "stdout reader panicked".to_string())?
            .map_err(|error| format!("stdout read failed: {error}"))?;
        let (stderr, stderr_truncated) = stderr_reader
            .join()
            .map_err(|_| "stderr reader panicked".to_string())?
            .map_err(|error| format!("stderr read failed: {error}"))?;

        Ok(RunnerOutput {
            exit_code,
            stdout,
            stderr,
            duration_ms: started.elapsed().as_millis() as u64,
            timed_out,
            stdout_truncated,
            stderr_truncated,
            confinement: launch.confinement,
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

    /// Apply the plan's bounds. Every one of them is a cap the caller's
    /// policy already declared and the Windows backend used to drop on the
    /// floor: memory, CPU time and the process count now reach the kernel.
    fn configure_job(job: HANDLE, limits: &JobLimits) -> Result<(), String> {
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let mut flags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        if limits.kill_on_close {
            flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        }
        info.BasicLimitInformation.ActiveProcessLimit = limits.active_processes;
        if let Some(bytes) = limits.process_memory_bytes {
            flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = bytes as usize;
        }
        if let Some(bytes) = limits.job_memory_bytes {
            flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = bytes as usize;
        }
        if let Some(cpu) = limits.per_process_cpu {
            flags |= JOB_OBJECT_LIMIT_PROCESS_TIME;
            info.BasicLimitInformation.PerProcessUserTimeLimit = cpu_time_100ns(cpu);
        }
        info.BasicLimitInformation.LimitFlags = flags;
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
    use super::*;

    #[test]
    fn capture_drains_beyond_cap_and_preserves_marker() {
        let mut bytes = std::io::Cursor::new(vec![b'x'; MAX_OUTPUT_BYTES * 3]);
        let (text, truncated) = read_capture(&mut bytes).unwrap();
        assert_eq!(bytes.position(), (MAX_OUTPUT_BYTES * 3) as u64);
        assert!(truncated);
        assert_eq!(text.len(), MAX_OUTPUT_BYTES);
        assert!(text.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn capture_keeps_short_output_and_bounds_invalid_utf8() {
        assert_eq!(
            read_capture(&b"hello"[..]).unwrap(),
            ("hello".into(), false)
        );
        let (text, truncated) = read_capture(&vec![0xff; MAX_OUTPUT_BYTES][..]).unwrap();
        assert!(truncated);
        assert!(text.len() <= MAX_OUTPUT_BYTES);
        assert!(text.ends_with(TRUNCATION_MARKER));
    }

    #[test]
    fn arguments_refuse_extra_flags_and_unknown_protocol_switches() {
        assert!(read_input(&["runner".into(), "--protocol-v3".into()]).is_err());
        assert!(
            read_input(&["runner".into(), "--capabilities-v2".into(), "extra".into()]).is_err()
        );
    }
}
