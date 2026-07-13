//! Cross-platform process-group helpers for spawned external agents.
//!
//! On Unix an external agent launched as `npx …` / `opencode serve` forks
//! grandchildren. Killing only the direct child (the default `Child::kill`)
//! leaves those grandchildren orphaned past app exit. We put each child in its
//! own process group at spawn (`process_group(0)` → pgid == child pid) and
//! signal the whole group on kill (`killpg`). On Windows there is no
//! process-group equivalent wired here — `CREATE_NO_WINDOW` + `kill_on_drop`
//! cover the leader and Job Objects are out of scope — so both helpers are
//! no-ops there.

use tokio::process::Command;

/// Configure `cmd` so the spawned child leads its own process group. No-op on
/// non-Unix platforms.
pub fn apply_process_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        // 0 → a new group whose id equals the child's pid; mirrors std's
        // `CommandExt::process_group` and is honored by tokio's `Command`.
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = cmd;
    }
}

/// Send `SIGKILL` to the whole process group led by `pid` (Unix only).
/// Best-effort: a stale/already-reaped group returns `ESRCH`, which is ignored.
/// No-op when `pid` is `None` or on non-Unix platforms.
pub fn kill_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            // SAFETY: `killpg` is async-signal-safe and takes no Rust state.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kill_process_group_none_is_noop() {
        // Must not panic for a process that never started / has no pid.
        kill_process_group(None);
    }

    #[test]
    fn apply_process_group_is_callable() {
        let mut cmd = Command::new("echo");
        apply_process_group(&mut cmd);
        // No assertion beyond "does not panic": the effect is observable only in
        // a spawned child, exercised by the Unix-gated test below.
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn kill_process_group_terminates_grandchild() {
        use std::process::Stdio;
        use std::time::Duration;
        use tokio::io::{AsyncBufReadExt, BufReader};

        // Parent shell spawns a long-lived grandchild (sleep) in the same group,
        // prints its pid, then waits. Killing the group must take the grandchild
        // down too — the whole point of process-group cleanup.
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg("sleep 30 & echo $!; wait")
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        apply_process_group(&mut cmd);
        let mut child = cmd.spawn().expect("spawn sh");
        let pid = child.id();

        let stdout = child.stdout.take().expect("stdout");
        let mut lines = BufReader::new(stdout).lines();
        let line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
            .await
            .expect("read grandchild pid in time")
            .expect("line ok")
            .expect("some line");
        let grandchild: i32 = line.trim().parse().expect("pid parse");

        kill_process_group(pid);
        let _ = child.wait().await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        // signal 0 → existence probe; non-zero (ESRCH) means it's gone.
        let alive = unsafe { libc::kill(grandchild as libc::pid_t, 0) } == 0;
        assert!(
            !alive,
            "grandchild {grandchild} should have been killed with the group"
        );
    }
}
