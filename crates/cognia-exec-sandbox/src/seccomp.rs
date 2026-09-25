// ADR-0028 — seccomp-bpf defense-in-depth for the Linux `bwrap` backend.
//
// The namespace isolation in `linux.rs` (`--unshare-user/pid/ipc/uts/net`,
// `--die-with-parent`, FS binds) is the PRIMARY boundary. This filter adds a
// second layer that both reference sandboxes also ship:
//
//   * `ptrace` / `process_vm_readv` / `process_vm_writev` — block one
//     sandboxed process from reading or hijacking another's memory
//     (`anthropic-experimental/sandbox-runtime`, `openai/codex`).
//   * `io_uring_setup` / `io_uring_enter` / `io_uring_register` — io_uring is
//     a documented seccomp-bypass surface (it can perform queued operations
//     in kernel context that a syscall filter never sees); srt blocks it
//     explicitly.
//
// The filter is handed to bwrap on a file descriptor (`--seccomp FD`) and
// bwrap installs it on the sandboxed process immediately before exec'ing it.
//
// It must NOT be installed on the bwrap process itself. bwrap's own setup
// calls `mount` (`MS_SLAVE` on `/`, then every bind), `unshare` and
// `pivot_root`, all of which this filter denies with EPERM, so a filter
// applied before `execve(bwrap)` aborts the sandbox before it exists. That
// was the shipped behaviour until this comment was written: every Linux
// sandbox call returned `exit_code: 1` with empty stdout and
// `bwrap: Failed to make / slave: Operation not permitted` on stderr, while
// the cheap health probe still reported the backend as available. Verified on
// Ubuntu 24.04 / aarch64 against the real binary.
//
// Defense-in-depth, not the boundary: if filter construction fails, the
// backend proceeds with namespaces only and records a warning rather than
// failing the command — the namespace isolation still holds.

#![cfg(target_os = "linux")]

use std::convert::TryInto;
use std::os::fd::{FromRawFd, RawFd};

use seccompiler::{BpfProgram, SeccompAction, SeccompFilter};

/// Human-readable names of the blocked syscalls — the single source of truth
/// the unit test asserts against so the list can't silently drift.
///
/// Beyond the memory-introspection (`ptrace`, `process_vm_*`) and io_uring
/// surface, we deny the kernel-keyring (`keyctl` / `add_key` / `request_key`
/// — keyring poisoning), `bpf` (a documented privilege-escalation surface),
/// and the namespace / mount manipulation calls (`unshare` / `setns` /
/// `mount` / `umount2` / `pivot_root`). The unprivileged user namespace bwrap
/// sets up already blocks privileged variants of the latter, so these are
/// defense-in-depth against nested-namespace and keyring tricks the reference
/// sandboxes also deny. `bwrap` itself needs none of them once its own
/// namespace setup is done (the filter is inherited AFTER bwrap execs the
/// target), so denying them does not break sandbox setup.
pub const BLOCKED_SYSCALLS: &[&str] = &[
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
    "keyctl",
    "add_key",
    "request_key",
    "bpf",
    "unshare",
    "setns",
    "mount",
    "umount2",
    "pivot_root",
    // New-mount-API family (Linux 5.2+ / 5.12+). The legacy `mount` syscall is
    // already denied above, but `fsopen`/`fsconfig`/`fsmount` +
    // `open_tree`/`move_mount`/`mount_setattr` are an ENTIRELY separate code
    // path that can construct and graft a filesystem without ever calling
    // `mount(2)` — a documented bwrap-era bypass that srt / codex also deny.
    // `clone`/`clone3` are deliberately NOT blocked: glibc uses `clone3` for
    // thread creation and only falls back on ENOSYS (not EPERM), so denying it
    // would break threaded programs inside the sandbox.
    "open_tree",
    "move_mount",
    "fsopen",
    "fsconfig",
    "fsmount",
    "mount_setattr",
];

/// Syscall numbers to deny (EPERM). Kept beside `BLOCKED_SYSCALLS` so the two
/// stay 1:1 (asserted by the test).
fn blocked_syscall_numbers() -> Vec<i64> {
    vec![
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_bpf,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_mount_setattr,
    ]
}

/// Build the compiled BPF program: blocked syscalls return `EPERM`
/// (`match_action`), everything else is allowed (`mismatch_action`).
pub fn build_filter() -> Result<BpfProgram, String> {
    let rules = blocked_syscall_numbers()
        .into_iter()
        .map(|nr| (nr, vec![]))
        .collect();
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow, // mismatch: allow everything else
        SeccompAction::Errno(libc::EPERM as u32), // match: deny the blocked set
        std::env::consts::ARCH
            .try_into()
            .map_err(|e| format!("unsupported arch for seccomp: {e:?}"))?,
    )
    .map_err(|e| format!("failed to build seccomp filter: {e:?}"))?;
    filter
        .try_into()
        .map_err(|e| format!("failed to compile seccomp BPF: {e:?}"))
}

/// The descriptor number the compiled program is handed to `bwrap` on.
///
/// Any number clear of the three stdio descriptors works. `dup2` onto it in
/// the pre-exec hook also clears `FD_CLOEXEC`, which is what lets the program
/// survive `execve` into bwrap.
pub const SECCOMP_FD: RawFd = 10;

/// The compiled program as the raw `struct sock_filter[]` bytes `bwrap
/// --seccomp` reads back, the same layout `seccomp_export_bpf` writes.
pub fn program_bytes(bpf: &BpfProgram) -> Vec<u8> {
    if bpf.is_empty() {
        return Vec::new();
    }
    // SAFETY: `sock_filter` is a `#[repr(C)]` POD (u16, u8, u8, u32) with no
    // padding and no pointers, so its in-memory representation IS the wire
    // format. The slice borrowed here lives as long as `bpf`.
    let raw = unsafe {
        std::slice::from_raw_parts(bpf.as_ptr() as *const u8, std::mem::size_of_val(&bpf[..]))
    };
    raw.to_vec()
}

/// Park the compiled program on an anonymous in-memory file, positioned at
/// byte 0 and WITHOUT `FD_CLOEXEC`, ready to be handed to bwrap.
///
/// The returned `File` owns the descriptor: keep it alive until after the
/// child has been spawned, or the program vanishes before bwrap reads it.
pub fn park_program(bpf: &BpfProgram) -> std::io::Result<std::fs::File> {
    use std::io::{Seek, SeekFrom, Write};

    let bytes = program_bytes(bpf);
    if bytes.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing to park an empty seccomp program",
        ));
    }
    // SAFETY: a nul-terminated literal name and flags 0. Flags deliberately
    // omit `MFD_CLOEXEC`: the descriptor has to survive the exec into bwrap.
    let raw = unsafe { libc::memfd_create(c"cognia-sandbox-seccomp".as_ptr(), 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `memfd_create` just returned a fresh descriptor that nothing
    // else owns, so taking ownership of it here is sound.
    let mut file = unsafe { std::fs::File::from_raw_fd(raw) };
    file.write_all(&bytes)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
}

/// Move the parked program onto [`SECCOMP_FD`] in the child, so the number
/// passed to `bwrap --seccomp` resolves there after exec.
pub fn attach_program_fd(cmd: &mut tokio::process::Command, source: RawFd) {
    // SAFETY: the closure runs in the forked child before exec and calls only
    // `dup2`, which is async-signal-safe. It allocates nothing and takes no
    // locks, which is the requirement for a post-fork / pre-exec context.
    unsafe {
        cmd.pre_exec(move || {
            if source != SECCOMP_FD && libc::dup2(source, SECCOMP_FD) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocked_names_and_numbers_stay_one_to_one() {
        assert_eq!(BLOCKED_SYSCALLS.len(), blocked_syscall_numbers().len());
    }

    #[test]
    fn includes_ptrace_and_io_uring() {
        assert!(BLOCKED_SYSCALLS.contains(&"ptrace"));
        assert!(BLOCKED_SYSCALLS.contains(&"io_uring_setup"));
    }

    #[test]
    fn includes_keyring_bpf_and_namespace_calls() {
        for s in [
            "keyctl",
            "add_key",
            "request_key",
            "bpf",
            "unshare",
            "setns",
            "mount",
            "umount2",
            "pivot_root",
        ] {
            assert!(BLOCKED_SYSCALLS.contains(&s), "{s} should be blocked");
        }
    }

    #[test]
    fn includes_new_mount_api_family() {
        for s in [
            "open_tree",
            "move_mount",
            "fsopen",
            "fsconfig",
            "fsmount",
            "mount_setattr",
        ] {
            assert!(BLOCKED_SYSCALLS.contains(&s), "{s} should be blocked");
        }
    }

    #[test]
    fn program_bytes_are_eight_per_instruction() {
        let bpf = build_filter().expect("filter builds on a supported arch");
        // `struct sock_filter` is exactly 8 bytes wide. bwrap divides the fd's
        // length by that to get the instruction count, so a mismatch here
        // means bwrap would read a truncated or over-long program.
        assert_eq!(program_bytes(&bpf).len(), bpf.len() * 8);
    }

    #[test]
    fn parked_program_is_readable_from_byte_zero_and_survives_exec() {
        use std::io::Read;
        use std::os::fd::AsRawFd;

        let bpf = build_filter().expect("filter builds on a supported arch");
        let mut file = park_program(&bpf).expect("memfd is available");

        let mut read_back = Vec::new();
        file.read_to_end(&mut read_back).expect("readable");
        assert_eq!(read_back, program_bytes(&bpf));

        // bwrap reads the program AFTER exec, so the descriptor must not be
        // close-on-exec. Parking it with `FD_CLOEXEC` set would leave bwrap
        // reading a closed fd and refusing to start.
        // SAFETY: `F_GETFD` only reads the descriptor's flags.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0, "F_GETFD failed");
        assert_eq!(flags & libc::FD_CLOEXEC, 0);
    }

    #[test]
    fn build_filter_produces_a_non_empty_program() {
        let bpf = build_filter().expect("filter builds on a supported arch");
        // A compiled filter always has at least the arch-validation preamble
        // plus the syscall-load + per-rule comparisons + default return.
        assert!(bpf.len() > BLOCKED_SYSCALLS.len());
    }
}
