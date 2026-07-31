//! Subprocess helpers shared by `build` + `dev`.

use anyhow::{anyhow, Context, Result};
use std::process::Command;

/// Shell helper used by `build` + `dev` to run a subprocess and stream
/// its stdout/stderr to the user.
pub(crate) fn run_streaming(mut cmd: Command, label: &str) -> Result<()> {
    let status = cmd
        .status()
        .with_context(|| format!("spawn `{label}` failed"))?;
    if !status.success() {
        return Err(anyhow!("`{label}` exited with status {:?}", status.code()));
    }
    Ok(())
}
