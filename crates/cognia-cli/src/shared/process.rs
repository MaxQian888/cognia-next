//! Subprocess helpers shared by `build` + `dev`.

use anyhow::{anyhow, Context, Result};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static INTERRUPT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub(crate) struct ProcessInterrupted;

impl std::fmt::Display for ProcessInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("subprocess interrupted")
    }
}

impl std::error::Error for ProcessInterrupted {}

/// Ask the currently streaming build subprocess to stop. The request is
/// process-wide because `ctrlc` installs one process-wide handler and the CLI
/// runs at most one foreground build subprocess at a time.
pub(crate) fn request_process_interrupt() {
    INTERRUPT_REQUESTED.store(true, Ordering::SeqCst);
}

pub(crate) fn clear_process_interrupt() {
    INTERRUPT_REQUESTED.store(false, Ordering::SeqCst);
}

/// Shell helper used by `build` + `dev` to run a subprocess and stream
/// its stdout/stderr to the user.
pub(crate) fn run_streaming(mut cmd: Command, label: &str) -> Result<()> {
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn `{label}` failed"))?;
    let status = loop {
        if INTERRUPT_REQUESTED.swap(false, Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ProcessInterrupted.into());
        }
        if let Some(status) = child
            .try_wait()
            .with_context(|| format!("wait for `{label}` failed"))?
        {
            break status;
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    if !status.success() {
        return Err(anyhow!("`{label}` exited with status {:?}", status.code()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_interrupt_terminates_a_streaming_process() {
        clear_process_interrupt();
        request_process_interrupt();

        let command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };

        let error = run_streaming(command, "blocking test process").unwrap_err();
        assert!(error.downcast_ref::<ProcessInterrupted>().is_some());
        assert!(!INTERRUPT_REQUESTED.load(Ordering::SeqCst));
    }
}
