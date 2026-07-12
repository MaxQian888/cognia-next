//! Generic timer-firing primitive shared by the app scheduler's alarm daemon
//! (`crate::scheduler::daemon`) and the workflow cron daemon
//! (`crate::workflow::triggers::cron_daemon`). See `alarm_daemon` for details.

pub mod alarm_daemon;

pub use alarm_daemon::{Alarm, AlarmDaemonCore, DueEmitter};
