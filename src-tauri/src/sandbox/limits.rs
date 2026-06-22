// ADR-0028 — resource limits (rlimit) for sandboxed commands.
//
// The per-platform backends already enforce a **wall-clock** timeout (the
// `SandboxCommand.timeout` watchdog), which is the default and safest time
// control. rlimits are an *opt-in* backstop on top of that:
//
//   * `RLIMIT_CPU` (CPU-seconds) is summed across cores, so a parallel build
//     (`make -j8`) burns it far faster than wall-clock — only applied when
//     the caller sets `max_cpu_seconds` explicitly (0 = leave to the
//     wall-clock watchdog).
//   * `RLIMIT_AS` (virtual address space) is blunt: Go runtimes, jemalloc,
//     and ASAN reserve huge virtual mappings, so a low cap kills healthy
//     programs. Only applied when the caller sets `max_memory_mb` explicitly.
//
// Reference sandboxes (`openai/codex`, `anthropic-experimental/
// sandbox-runtime`) enforce neither by default for exactly these reasons;
// we mirror that and make both an informed opt-in. cgroup-v2 memory
// accounting is the correct long-term answer and is tracked as a follow-up.
//
// The value resolution is pure + host-tested; the `setrlimit` application is
// `cfg(unix)` and exercised by the per-platform integration tests on CI.

/// Resolved rlimit values. `None` = leave the limit at the inherited /
/// unlimited value (let the wall-clock watchdog handle it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResolvedLimits {
    /// `RLIMIT_CPU` ceiling in CPU-seconds.
    pub cpu_seconds: Option<u64>,
    /// `RLIMIT_AS` ceiling in bytes.
    pub address_space_bytes: Option<u64>,
}

impl ResolvedLimits {
    /// True when neither limit needs to be applied (so the backend can skip
    /// installing a `pre_exec` hook entirely).
    pub fn is_empty(&self) -> bool {
        self.cpu_seconds.is_none() && self.address_space_bytes.is_none()
    }
}

/// Translate the policy's `max_cpu_seconds` / `max_memory_mb` (0 = no cap)
/// into concrete rlimit values. Memory MB is converted to bytes with
/// saturating arithmetic so an absurd value can't overflow.
pub fn resolve_rlimits(max_cpu_seconds: u32, max_memory_mb: u32) -> ResolvedLimits {
    ResolvedLimits {
        cpu_seconds: if max_cpu_seconds == 0 {
            None
        } else {
            Some(u64::from(max_cpu_seconds))
        },
        address_space_bytes: if max_memory_mb == 0 {
            None
        } else {
            Some(u64::from(max_memory_mb).saturating_mul(1024 * 1024))
        },
    }
}

/// Install a `pre_exec` hook on `cmd` that applies the resolved rlimits in
/// the child just before `exec`. No-op when both limits are unset.
///
/// On the Linux backend `cmd` is the `bwrap` process — rlimits are inherited
/// across the `bwrap` → target exec, so the cap lands on the sandboxed
/// command. On macOS `cmd` is `sandbox-exec`, same inheritance.
#[cfg(unix)]
pub fn apply_rlimits(cmd: &mut tokio::process::Command, limits: ResolvedLimits) {
    if limits.is_empty() {
        return;
    }
    let cpu = limits.cpu_seconds;
    let addr = limits.address_space_bytes;
    // SAFETY: the closure runs in the forked child before exec. It only calls
    // `setrlimit` (async-signal-safe) and constructs stack values — no heap
    // allocation, no locks, nothing that could deadlock a half-forked child.
    unsafe {
        cmd.pre_exec(move || {
            if let Some(secs) = cpu {
                set_one(libc::RLIMIT_CPU, secs)?;
            }
            // RLIMIT_AS is well-defined on Linux; on macOS it is unreliable
            // (aliased / absent across releases), so the address-space cap is
            // Linux-only. macOS callers still get the wall-clock watchdog +
            // RLIMIT_CPU.
            #[cfg(target_os = "linux")]
            if let Some(bytes) = addr {
                set_one(libc::RLIMIT_AS, bytes)?;
            }
            #[cfg(not(target_os = "linux"))]
            let _ = addr;
            Ok(())
        });
    }
}

/// Resource id type for `setrlimit` — Linux types it as `__rlimit_resource_t`,
/// other unices as `c_int`.
#[cfg(target_os = "linux")]
type RlimitResource = libc::__rlimit_resource_t;
#[cfg(all(unix, not(target_os = "linux")))]
type RlimitResource = libc::c_int;

#[cfg(unix)]
fn set_one(resource: RlimitResource, value: u64) -> std::io::Result<()> {
    let lim = libc::rlimit {
        rlim_cur: value as libc::rlim_t,
        rlim_max: value as libc::rlim_t,
    };
    // SAFETY: `lim` is a fully-initialised, correctly-typed rlimit struct.
    if unsafe { libc::setrlimit(resource, &lim) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_caps_resolve_to_none() {
        let r = resolve_rlimits(0, 0);
        assert!(r.is_empty());
        assert_eq!(r.cpu_seconds, None);
        assert_eq!(r.address_space_bytes, None);
    }

    #[test]
    fn cpu_seconds_pass_through() {
        let r = resolve_rlimits(30, 0);
        assert_eq!(r.cpu_seconds, Some(30));
        assert_eq!(r.address_space_bytes, None);
        assert!(!r.is_empty());
    }

    #[test]
    fn memory_mb_converts_to_bytes() {
        let r = resolve_rlimits(0, 512);
        assert_eq!(r.address_space_bytes, Some(512 * 1024 * 1024));
        assert_eq!(r.cpu_seconds, None);
    }

    #[test]
    fn both_caps_set() {
        let r = resolve_rlimits(10, 256);
        assert_eq!(r.cpu_seconds, Some(10));
        assert_eq!(r.address_space_bytes, Some(256 * 1024 * 1024));
    }

    #[test]
    fn absurd_memory_saturates_instead_of_overflowing() {
        let r = resolve_rlimits(0, u32::MAX);
        // u32::MAX MB in bytes exceeds u32 but fits u64 — no panic, no wrap.
        assert_eq!(
            r.address_space_bytes,
            Some(u64::from(u32::MAX) * 1024 * 1024)
        );
    }
}
