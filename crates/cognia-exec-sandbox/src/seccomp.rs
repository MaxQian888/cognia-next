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
// Allowlist runs require both filters: construction or installation failure
// refuses the run, because denying pathname Unix IPC is part of the boundary.

use std::convert::TryInto;
use std::os::fd::{FromRawFd, RawFd};

use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule,
};

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
    "pidfd_getfd",
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
        libc::SYS_pidfd_getfd,
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
    build_filter_with_socket_families(None, false)
}

/// The namespace supervisor needs only pathname Unix IPC and IPv4 loopback.
pub fn build_allowlist_supervisor_filter() -> Result<BpfProgram, String> {
    build_filter_with_socket_families(Some(&[libc::AF_UNIX, libc::AF_INET]), false)
}

/// The target may create IP sockets, but cannot reach mounted host Unix sockets.
/// Stream `socketpair` remains available for local process IPC. Datagram pairs
/// must be denied: either endpoint can reconnect to a mounted pathname socket.
pub fn build_allowlist_target_filter() -> Result<BpfProgram, String> {
    build_filter_with_socket_families(Some(&[libc::AF_INET, libc::AF_INET6]), true)
}

fn build_filter_with_socket_families(
    families: Option<&[i32]>,
    stream_pairs_only: bool,
) -> Result<BpfProgram, String> {
    let mut rules: std::collections::BTreeMap<i64, Vec<SeccompRule>> = blocked_syscall_numbers()
        .into_iter()
        .map(|nr| (nr, vec![]))
        .collect();
    if let Some(families) = families {
        let conditions = families
            .iter()
            .map(|family| {
                SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, *family as u64)
                    .map_err(|error| format!("invalid socket-family condition: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let rule = SeccompRule::new(conditions)
            .map_err(|error| format!("invalid socket-family rule: {error}"))?;
        rules.insert(libc::SYS_socket, vec![rule]);
    }
    if stream_pairs_only {
        // seccompiler exposes MaskedEq but not MaskedNe. Enumerating these four
        // accepted values is exactly `(type & !(NONBLOCK | CLOEXEC)) == STREAM`;
        // the conjunction denies every other value, including unknown flags.
        let conditions = [
            0,
            libc::SOCK_CLOEXEC,
            libc::SOCK_NONBLOCK,
            libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
        ]
        .into_iter()
        .map(|flags| {
            SeccompCondition::new(
                1,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                (libc::SOCK_STREAM | flags) as u64,
            )
            .map_err(|error| format!("invalid socketpair-type condition: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
        let rule = SeccompRule::new(conditions)
            .map_err(|error| format!("invalid socketpair-type rule: {error}"))?;
        rules.insert(libc::SYS_socketpair, vec![rule]);
    }
    let filter = SeccompFilter::new(
        rules,
        SeccompAction::Allow, // mismatch: allow everything else
        SeccompAction::Errno(libc::EPERM as u32), // match: deny the blocked set
        std::env::consts::ARCH
            .try_into()
            .map_err(|e| format!("unsupported arch for seccomp: {e:?}"))?,
    )
    .map_err(|e| format!("failed to build seccomp filter: {e:?}"))?;
    let program: BpfProgram = filter
        .try_into()
        .map_err(|e| format!("failed to compile seccomp BPF: {e:?}"))?;
    #[cfg(target_arch = "x86_64")]
    {
        // x32 shares AUDIT_ARCH_X86_64 but uses different syscall numbers.
        // Reject the entire ABI, including unknown calls, before native rules.
        // Other audit architectures still reach seccompiler's kill guard.
        use seccompiler::sock_filter;
        let mut guarded = vec![
            sock_filter {
                code: 0x20,
                jt: 0,
                jf: 0,
                k: 4,
            }, // LD arch
            sock_filter {
                code: 0x15,
                jt: 0,
                jf: 3,
                k: 0xc000_003e,
            },
            sock_filter {
                code: 0x20,
                jt: 0,
                jf: 0,
                k: 0,
            }, // LD nr
            sock_filter {
                code: 0x45,
                jt: 0,
                jf: 1,
                k: 0x4000_0000,
            }, // JSET x32
            sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
            },
        ];
        guarded.extend(program);
        Ok(guarded)
    }
    #[cfg(not(target_arch = "x86_64"))]
    Ok(program)
}

/// Install an already-compiled filter in a child immediately before exec.
/// Only raw syscalls are used; no allocator or lock is touched after fork.
pub fn install_target_filter(bpf: &BpfProgram) -> std::io::Result<()> {
    if bpf.is_empty() || bpf.len() > u16::MAX as usize {
        return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
    }
    let program = libc::sock_fprog {
        len: bpf.len() as u16,
        filter: bpf.as_ptr().cast::<libc::sock_filter>().cast_mut(),
    };
    // SAFETY: the program refers to initialized BPF memory for the duration of
    // prctl; NO_NEW_PRIVS is mandatory before an unprivileged filter install.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Mandatory desktop filter, installed by bwrap only AFTER namespace setup.
/// Unlike the generic one-shot backend, callers must propagate every error.
/// Namespace creation via `clone` is denied without denying ordinary process
/// or thread creation. `clone3` takes a pointer classic BPF cannot inspect;
/// ENOSYS makes libc fall back to the inspectable `clone` syscall.
pub fn build_desktop_filter() -> Result<BpfProgram, String> {
    let mut rules: std::collections::BTreeMap<i64, Vec<SeccompRule>> = blocked_syscall_numbers()
        .into_iter()
        .map(|nr| (nr, vec![]))
        .collect();
    let namespace_rules = DESKTOP_CLONE_NAMESPACE_FLAGS
        .iter()
        .map(|flag| {
            let condition = SeccompCondition::new(
                0,
                SeccompCmpArgLen::Qword,
                SeccompCmpOp::MaskedEq(*flag),
                *flag,
            )
            .map_err(|e| format!("invalid desktop clone condition: {e:?}"))?;
            SeccompRule::new(vec![condition])
                .map_err(|e| format!("invalid desktop clone rule: {e:?}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    rules.insert(libc::SYS_clone, namespace_rules);
    let arch = std::env::consts::ARCH
        .try_into()
        .map_err(|e| format!("unsupported desktop seccomp arch: {e:?}"))?;
    let primary = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        arch,
    )
    .map_err(|e| format!("invalid desktop seccomp filter: {e:?}"))?;
    let mut primary: BpfProgram = primary
        .try_into()
        .map_err(|e| format!("failed to compile desktop seccomp: {e:?}"))?;
    let fallback = SeccompFilter::new(
        [(libc::SYS_clone3, vec![])].into(),
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
        arch,
    )
    .map_err(|e| format!("invalid desktop clone3 filter: {e:?}"))?;
    let fallback: BpfProgram = fallback
        .try_into()
        .map_err(|e| format!("failed to compile desktop clone3 filter: {e:?}"))?;
    // seccompiler gives a filter one match action. Chain its ALLOW exits to
    // the second filter to preserve both distinct errno results on one FD.
    // Existing relative jumps and architecture-kill exits stay unchanged.
    let primary_len = primary.len();
    for (index, instruction) in primary.iter_mut().enumerate() {
        if instruction.code == 0x06 && instruction.k == libc::SECCOMP_RET_ALLOW {
            instruction.code = 0x05; // BPF_JMP | BPF_JA
            instruction.k = (primary_len - index - 1) as u32;
        }
    }
    primary.extend(fallback);
    // x32 shares AUDIT_ARCH_X86_64 but uses a different syscall-number ABI.
    // seccompiler validates the audit architecture only; accepting that ABI
    // would bypass the native-number deny list above. The desktop image is
    // native 64-bit, so kill x32 calls rather than translating them.
    #[cfg(target_arch = "x86_64")]
    {
        let mut native_only = vec![
            seccompiler::sock_filter {
                code: 0x20,
                jt: 0,
                jf: 0,
                k: 0,
            },
            seccompiler::sock_filter {
                code: 0x45,
                jt: 0,
                jf: 1,
                k: 0x40000000,
            },
            seccompiler::sock_filter {
                code: 0x06,
                jt: 0,
                jf: 0,
                k: libc::SECCOMP_RET_KILL_PROCESS,
            },
        ];
        native_only.extend(primary);
        primary = native_only;
    }
    Ok(primary)
}

const DESKTOP_CLONE_NAMESPACE_FLAGS: &[u64] = &[
    libc::CLONE_NEWNS as u64,
    libc::CLONE_NEWCGROUP as u64,
    libc::CLONE_NEWUTS as u64,
    libc::CLONE_NEWIPC as u64,
    libc::CLONE_NEWUSER as u64,
    libc::CLONE_NEWPID as u64,
    libc::CLONE_NEWNET as u64,
    0x00000080, // CLONE_NEWTIME (Linux 5.6); unavailable in older libc headers.
];

/// A mandatory desktop filter cannot leak into a concurrent unrelated exec.
/// The launcher explicitly duplicates this CLOEXEC descriptor to its fixed FD.
pub fn park_desktop_filter() -> std::io::Result<std::fs::File> {
    use std::io::{Seek, SeekFrom, Write};
    let filter = build_desktop_filter().map_err(std::io::Error::other)?;
    let bytes = program_bytes(&filter);
    if bytes.is_empty() {
        return Err(std::io::Error::other(
            "empty mandatory desktop seccomp filter",
        ));
    }
    // SAFETY: constant NUL-terminated name, fresh owned descriptor.
    let raw = unsafe { libc::memfd_create(c"cognia-desktop-seccomp".as_ptr(), libc::MFD_CLOEXEC) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: memfd_create returned a new descriptor owned by this function.
    let mut file = unsafe { std::fs::File::from_raw_fd(raw) };
    file.write_all(&bytes)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(file)
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

    // Evaluate the actual compiled program without installing a filter or
    // requiring kernel x32 support. Unexpected instructions fail the test.
    fn evaluate(program: &BpfProgram, arch: u32, nr: u32, args: [u64; 6]) -> u32 {
        let mut data = [0u32; 16];
        data[0] = nr;
        data[1] = arch;
        for (index, arg) in args.into_iter().enumerate() {
            data[4 + index * 2] = arg as u32;
            data[5 + index * 2] = (arg >> 32) as u32;
        }
        let mut accumulator = 0;
        let mut pc = 0;
        for _ in 0..program.len() {
            let insn = &program[pc];
            pc += 1;
            match insn.code {
                0x20 => accumulator = data[insn.k as usize / 4],
                0x05 => pc += insn.k as usize,
                0x15 | 0x25 | 0x35 | 0x45 => {
                    let yes = match insn.code {
                        0x15 => accumulator == insn.k,
                        0x25 => accumulator > insn.k,
                        0x35 => accumulator >= insn.k,
                        _ => accumulator & insn.k != 0,
                    };
                    pc += if yes { insn.jt } else { insn.jf } as usize;
                }
                0x54 => accumulator &= insn.k,
                0x06 => return insn.k,
                code => panic!("unsupported BPF instruction {code:#x}"),
            }
        }
        panic!("BPF did not return an action");
    }

    #[test]
    fn compiled_filters_reject_x32_and_preserve_native_policy() {
        let arch = match std::env::consts::ARCH {
            "x86_64" => 0xc000_003e,
            "aarch64" => 0xc000_00b7,
            "riscv64" => 0xc000_00f3,
            other => panic!("unsupported test arch {other}"),
        };
        let denied = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
        for (program, unix_allowed) in [
            (build_allowlist_supervisor_filter().unwrap(), true),
            (build_allowlist_target_filter().unwrap(), false),
        ] {
            for nr in blocked_syscall_numbers() {
                assert_eq!(evaluate(&program, arch, nr as u32, [0; 6]), denied);
            }
            for family in [libc::AF_UNIX, libc::AF_INET, libc::AF_INET6] {
                let allowed = family == libc::AF_INET
                    || (family == libc::AF_UNIX && unix_allowed)
                    || (family == libc::AF_INET6 && !unix_allowed);
                assert_eq!(
                    evaluate(
                        &program,
                        arch,
                        libc::SYS_socket as u32,
                        [family as u64, libc::SOCK_STREAM as u64, 0, 0, 0, 0]
                    ),
                    if allowed {
                        libc::SECCOMP_RET_ALLOW
                    } else {
                        denied
                    }
                );
            }
            assert_eq!(
                evaluate(
                    &program,
                    arch,
                    libc::SYS_socketpair as u32,
                    [libc::AF_UNIX as u64, libc::SOCK_STREAM as u64, 0, 0, 0, 0]
                ),
                libc::SECCOMP_RET_ALLOW
            );
            // x32 socket, socketpair, all io_uring calls, and an unknown number.
            for nr in [41, 53, 425, 426, 427, 0xffff] {
                assert_eq!(
                    evaluate(
                        &program,
                        arch,
                        0x4000_0000 | nr,
                        [libc::AF_UNIX as u64, libc::SOCK_STREAM as u64, 0, 0, 0, 0]
                    ),
                    if cfg!(target_arch = "x86_64") {
                        denied
                    } else {
                        libc::SECCOMP_RET_ALLOW
                    }
                );
            }
            assert_eq!(
                evaluate(&program, 0x4000_0003, 0x4000_0029, [0; 6]),
                libc::SECCOMP_RET_KILL_PROCESS
            );
        }
    }

    #[test]
    fn allowlist_target_denies_unix_and_non_ip_socket_families_but_keeps_socketpair() {
        // Install only on a disposable thread, never on the parallel test
        // runner. Filters are inherited downward, not by the parent thread.
        std::thread::spawn(|| {
            let filter = build_allowlist_target_filter().unwrap();
            install_target_filter(&filter).unwrap();
            for family in [libc::AF_UNIX, libc::AF_NETLINK, libc::AF_PACKET] {
                assert_eq!(unsafe { libc::socket(family, libc::SOCK_STREAM, 0) }, -1);
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::EPERM)
                );
            }
            let inet = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
            assert!(inet >= 0);
            unsafe {
                libc::close(inet);
            }
            let mut pair = [-1; 2];
            assert_eq!(
                unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, pair.as_mut_ptr()) },
                0
            );
            unsafe {
                libc::close(pair[0]);
                libc::close(pair[1]);
            }
        })
        .join()
        .unwrap();
    }

    #[test]
    fn target_denies_pidfd_getfd_even_for_its_own_descriptor() {
        std::thread::spawn(|| {
            use std::os::fd::AsRawFd;
            let file = std::fs::File::open("/dev/null").unwrap();
            let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, libc::getpid(), 0) };
            assert!(pidfd >= 0);
            let pidfd = unsafe { std::os::fd::OwnedFd::from_raw_fd(pidfd as i32) };
            install_target_filter(&build_allowlist_target_filter().unwrap()).unwrap();
            assert_eq!(
                unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_getfd,
                        pidfd.as_raw_fd(),
                        file.as_raw_fd(),
                        0,
                    )
                },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM)
            );
        })
        .join()
        .unwrap();
    }

    #[test]
    fn target_socketpair_rejects_datagrams_with_all_creation_flags() {
        std::thread::spawn(|| {
            install_target_filter(&build_allowlist_target_filter().unwrap()).unwrap();
            for flags in [
                0,
                libc::SOCK_CLOEXEC,
                libc::SOCK_NONBLOCK,
                libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
            ] {
                let mut pair = [-1; 2];
                assert_eq!(
                    unsafe {
                        libc::socketpair(
                            libc::AF_UNIX,
                            libc::SOCK_DGRAM | flags,
                            0,
                            pair.as_mut_ptr(),
                        )
                    },
                    -1
                );
                assert_eq!(
                    std::io::Error::last_os_error().raw_os_error(),
                    Some(libc::EPERM)
                );
                assert_eq!(
                    unsafe {
                        libc::socketpair(
                            libc::AF_UNIX,
                            libc::SOCK_STREAM | flags,
                            0,
                            pair.as_mut_ptr(),
                        )
                    },
                    0
                );
                unsafe {
                    libc::close(pair[0]);
                    libc::close(pair[1]);
                }
            }
        })
        .join()
        .unwrap();
    }

    #[test]
    fn allowlist_supervisor_keeps_unix_but_denies_packet_sockets() {
        std::thread::spawn(|| {
            install_target_filter(&build_allowlist_supervisor_filter().unwrap()).unwrap();
            let unix = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
            assert!(unix >= 0);
            unsafe {
                libc::close(unix);
            }
            let mut pair = [-1; 2];
            assert_eq!(
                unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_DGRAM, 0, pair.as_mut_ptr()) },
                0
            );
            unsafe {
                libc::close(pair[0]);
                libc::close(pair[1]);
            }
            assert_eq!(
                unsafe { libc::socket(libc::AF_PACKET, libc::SOCK_RAW, 0) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM)
            );
        })
        .join()
        .unwrap();
    }


    // Interpret the small classic-BPF instruction set seccompiler emits. This
    // tests errno and clone argument behavior without installing a permanent
    // filter on the Rust test runner itself.
    fn evaluate_desktop(program: &BpfProgram, syscall: i64, flags: u64, arch: u32) -> u32 {
        let mut data = [0_u8; 64];
        data[..4].copy_from_slice(&(syscall as i32).to_ne_bytes());
        data[4..8].copy_from_slice(&arch.to_ne_bytes());
        data[16..24].copy_from_slice(&flags.to_ne_bytes());
        let mut accumulator = 0_u32;
        let mut pc = 0;
        for _ in 0..program.len() * 2 {
            let instruction = &program[pc];
            match instruction.code {
                0x20 => {
                    let offset = instruction.k as usize;
                    accumulator = u32::from_ne_bytes(data[offset..offset + 4].try_into().unwrap());
                }
                0x54 => accumulator &= instruction.k,
                0x05 => pc += instruction.k as usize,
                0x15 | 0x25 | 0x35 | 0x45 => {
                    let matched = match instruction.code {
                        0x15 => accumulator == instruction.k,
                        0x25 => accumulator > instruction.k,
                        0x35 => accumulator >= instruction.k,
                        _ => accumulator & instruction.k != 0,
                    };
                    pc += if matched {
                        instruction.jt
                    } else {
                        instruction.jf
                    } as usize;
                }
                0x06 => return instruction.k,
                other => panic!("unsupported BPF instruction {other:#x}"),
            }
            pc += 1;
        }
        panic!("BPF filter did not terminate");
    }

    fn native_audit_arch() -> u32 {
        match std::env::consts::ARCH {
            "x86_64" => 0xc000003e,
            "aarch64" => 0xc00000b7,
            "riscv64" => 0xc00000f3,
            other => panic!("unsupported test architecture {other}"),
        }
    }

    #[test]
    fn desktop_filter_denies_namespace_creation_but_preserves_threads() {
        let filter = build_desktop_filter().unwrap();
        let arch = native_audit_arch();
        let denied = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
        for flag in DESKTOP_CLONE_NAMESPACE_FLAGS {
            assert_eq!(evaluate_desktop(&filter, libc::SYS_clone, *flag, arch), denied);
        }
        let thread_flags = (libc::CLONE_VM
            | libc::CLONE_FS
            | libc::CLONE_FILES
            | libc::CLONE_SIGHAND
            | libc::CLONE_THREAD
            | libc::CLONE_SYSVSEM) as u64;
        assert_eq!(
            evaluate_desktop(&filter, libc::SYS_clone, thread_flags, arch),
            libc::SECCOMP_RET_ALLOW
        );
        assert_eq!(
            evaluate_desktop(&filter, libc::SYS_clone, libc::SIGCHLD as u64, arch),
            libc::SECCOMP_RET_ALLOW
        );
        assert_eq!(
            evaluate_desktop(&filter, libc::SYS_clone3, 0, arch),
            libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32
        );
        assert_eq!(
            evaluate_desktop(&filter, libc::SYS_getpid, 0, arch),
            libc::SECCOMP_RET_ALLOW
        );
        for syscall in blocked_syscall_numbers() {
            assert_eq!(evaluate_desktop(&filter, syscall, 0, arch), denied);
        }
        assert_ne!(
            evaluate_desktop(&filter, libc::SYS_getpid, 0, 0),
            libc::SECCOMP_RET_ALLOW
        );
        #[cfg(target_arch = "x86_64")]
        assert_eq!(
            evaluate_desktop(&filter, libc::SYS_unshare | 0x40000000, 0, arch),
            libc::SECCOMP_RET_KILL_PROCESS
        );
    }

    #[test]
    fn generic_filter_still_allows_clone3_and_desktop_memfd_is_cloexec() {
        use std::os::fd::AsRawFd;
        let generic = build_filter().unwrap();
        assert_eq!(
            evaluate_desktop(&generic, libc::SYS_clone3, 0, native_audit_arch()),
            libc::SECCOMP_RET_ALLOW
        );
        let parked = park_desktop_filter().unwrap();
        // SAFETY: reads flags for a valid descriptor owned by parked.
        let flags = unsafe { libc::fcntl(parked.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }

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
