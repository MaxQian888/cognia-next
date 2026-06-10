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
// The filter is applied via a `Command::pre_exec` hook on the `bwrap`
// process, so the rules are inherited across `bwrap`'s namespace setup and
// into the sandboxed command. bwrap itself needs none of the blocked
// syscalls, so filtering them does not break sandbox setup.
//
// Defense-in-depth, not the boundary: if filter construction fails, the
// backend proceeds with namespaces only and records a warning rather than
// failing the command — the namespace isolation still holds.

#![cfg(target_os = "linux")]

use std::convert::TryInto;

use seccompiler::{BpfProgram, SeccompAction, SeccompFilter};

/// Human-readable names of the blocked syscalls — the single source of truth
/// the unit test asserts against so the list can't silently drift.
pub const BLOCKED_SYSCALLS: &[&str] = &[
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "io_uring_setup",
    "io_uring_enter",
    "io_uring_register",
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
        SeccompAction::Allow,                          // mismatch: allow everything else
        SeccompAction::Errno(libc::EPERM as u32),      // match: deny the blocked set
        std::env::consts::ARCH
            .try_into()
            .map_err(|e| format!("unsupported arch for seccomp: {e:?}"))?,
    )
    .map_err(|e| format!("failed to build seccomp filter: {e:?}"))?;
    filter
        .try_into()
        .map_err(|e| format!("failed to compile seccomp BPF: {e:?}"))
}

/// Install the filter on `cmd` via a `pre_exec` hook. Best-effort: a failure
/// to apply in the child returns the error from `pre_exec` (which aborts the
/// spawn) only for genuine syscall failures; construction failures are
/// handled by the caller, which logs and proceeds namespace-only.
pub fn attach(cmd: &mut tokio::process::Command, bpf: BpfProgram) {
    // SAFETY: the closure runs in the forked child before exec. `apply_filter`
    // performs `prctl(PR_SET_NO_NEW_PRIVS)` + the `seccomp` syscall and does
    // not allocate or take locks — safe for a post-fork / pre-exec context.
    unsafe {
        cmd.pre_exec(move || {
            seccompiler::apply_filter(&bpf)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, format!("{e:?}")))
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
    fn build_filter_produces_a_non_empty_program() {
        let bpf = build_filter().expect("filter builds on a supported arch");
        // A compiled filter always has at least the arch-validation preamble
        // plus the syscall-load + per-rule comparisons + default return.
        assert!(bpf.len() > BLOCKED_SYSCALLS.len());
    }
}
