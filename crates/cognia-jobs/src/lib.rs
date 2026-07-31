//! Background-job supervisor — the single owner of non-interactive
//! long-running commands started by the built-in agent and by scheduled tasks.
//!
//! # Why this crate exists
//!
//! Background commands used to live in a plain `Map` inside the chat sidecar
//! (`sidecar/builtin-tools/core/bash-sessions.mjs`). That location made four
//! things impossible and one thing wrong:
//!
//! - a scheduled task could not leave work running past its turn,
//! - a headless host had no background execution at all,
//! - a remote client could not see or stop what the desktop was running,
//! - nothing survived a sidecar restart, and
//! - `child.kill()` reaped only the wrapper shell, orphaning grandchildren.
//!
//! Moving ownership into Rust fixes all five at once: the supervisor lives in a
//! crate linked by both the Tauri app and the headless `cognia-server` binary,
//! persists to SQLite, and spawns into process groups.
//!
//! # Deliberately not a PTY
//!
//! [`cognia-terminal`](../cognia_terminal/index.html) owns interactive PTY
//! sessions. This crate owns the *non-interactive* case, where separate
//! stdout/stderr pipes and a real exit code matter more than a TTY. The two are
//! siblings, not layers.
//!
//! # Shape
//!
//! ```text
//! JobSupervisor  ── spawn / read / wait_for_output / kill
//!   ├─ JobStore   (SQLite: the source of truth, read by renderer + remote + headless)
//!   └─ JobOutput  (in-memory ring for the live tail + append-only disk log)
//! ```

pub mod limits;
pub mod monitor;
pub mod output;
pub mod store;
pub mod supervisor;
pub mod types;

pub use monitor::{MonitorListener, MonitorRegistry};
pub use output::JobOutput;
pub use store::JobStore;
pub use supervisor::{ExitListener, JobSupervisor};
pub use types::{
    JobError, JobExit, JobOutputSlice, JobOwner, JobRecord, JobStatus, MonitorCondition,
    MonitorRecord, MonitorStatus, Result, SpawnJobRequest,
};
