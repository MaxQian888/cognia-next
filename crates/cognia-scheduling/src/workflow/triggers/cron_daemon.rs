//! In-process cron daemon for workflow triggers.
//!
//! Distinct from `crate::scheduler` (OS-level Task Scheduler / launchd / systemd).
//! That one delegates to the operating system; we want a daemon that fires
//! while the Tauri *process* is running, regardless of webview state. Minimizing
//! to the tray must keep workflows ticking — that's the whole reason we run this
//! in Rust instead of the renderer.
//!
//! Design:
//!
//! - One tokio task per process, sleeping until the soonest next-fire across
//!   all registered cron triggers. The generic "sleep until soonest, wake
//!   early on mutation" loop mechanics (shared with
//!   `crate::scheduler::daemon`) live in `crate::timing::alarm_daemon`; this
//!   module keeps the cron-expression parsing and owns the multi-shot
//!   re-arm decision (unlike the plain alarm daemon, a fired cron entry
//!   recomputes its next occurrence and re-arms itself).
//! - Wakes up after each fire OR when the registry is mutated (add / remove /
//!   update). A `Notify` handle (inside the shared core) steers the sleep loop.
//! - On fire, emits a `TriggerEvent` via the supplied emitter (a closure the
//!   caller binds to `AppHandle::emit`). The TS bridge resolves the workflow
//!   id and invokes the orchestrator.

use std::collections::BTreeSet;
use std::str::FromStr;
use std::sync::Arc;

use chrono::{DateTime, Local, Utc};
use chrono_tz::Tz;
use cron::Schedule;

use crate::timing::{Alarm, AlarmDaemonCore, DueEmitter};
use crate::workflow::types::{TriggerBinding, TriggerEvent};

/// One tracked cron entry. `next_fire_at` is computed at insert time and
/// recomputed after every fire — this avoids re-walking the schedule
/// iterator (`Schedule::upcoming`) on the hot path of the loop.
#[derive(Debug, Clone)]
struct CronEntry {
    trigger_id: String,
    workflow_id: String,
    schedule: Schedule,
    timezone: Option<Tz>,
    enabled: bool,
    binding: Option<TriggerBinding>,
    next_fire_at: Option<DateTime<Utc>>,
}

impl CronEntry {
    /// Recompute the next fire after `anchor`. Returns `None` if the schedule
    /// has no future fires (e.g., a one-shot expression that has already run).
    fn recompute(&mut self, anchor: DateTime<Utc>) {
        self.next_fire_at = next_fire_after(&self.schedule, self.timezone, anchor);
    }
}

fn parse_workflow_schedule(expression: &str) -> Result<Schedule, String> {
    let trimmed = expression.trim();
    if trimmed.is_empty() {
        return Err("invalid cron: expression is empty".to_string());
    }
    if trimmed.contains('L') || trimmed.contains('#') {
        return Err(format!(
            "invalid cron '{trimmed}': workflow cron does not support L or # modifiers"
        ));
    }
    let field_count = trimmed.split_whitespace().count();
    let normalized = match field_count {
        5 | 6 => {
            let mut fields: Vec<_> = trimmed.split_whitespace().map(str::to_string).collect();
            let day_of_week_index = fields.len() - 1;
            fields[day_of_week_index] = normalize_day_of_week(&fields[day_of_week_index])?;
            if field_count == 5 {
                fields.insert(0, "0".to_string());
            }
            fields.join(" ")
        }
        _ if trimmed.starts_with('@') => trimmed.to_string(),
        _ => {
            return Err(format!(
                "invalid cron '{trimmed}': expected 5 or 6 fields, got {field_count}"
            ))
        }
    };
    Schedule::from_str(&normalized).map_err(|error| format!("invalid cron '{trimmed}': {error}"))
}

/// Translate standard cron weekday numbering (0/7=Sunday, 1=Monday) to the
/// Rust cron crate's Quartz numbering (1=Sunday, 2=Monday, ..., 7=Saturday).
/// Numeric lists/ranges/steps are expanded over the seven-day domain so
/// expressions such as `1-5`, `1,3,5`, and `*/2` retain their UI semantics.
fn normalize_day_of_week(field: &str) -> Result<String, String> {
    if field == "*"
        || field
            .chars()
            .any(|character| character.is_ascii_alphabetic())
    {
        return Ok(field.to_string());
    }

    let mut weekdays = BTreeSet::new();
    for segment in field.split(',') {
        let (base, step) = match segment.split_once('/') {
            Some((base, step)) => {
                let step = step
                    .parse::<usize>()
                    .map_err(|_| format!("invalid cron weekday step '{segment}'"))?;
                if step == 0 {
                    return Err(format!("invalid cron weekday step '{segment}'"));
                }
                (base, step)
            }
            None => (segment, 1),
        };
        let values: Vec<u8> = if base == "*" {
            (0..=6).collect()
        } else if let Some((start, end)) = base.split_once('-') {
            let start = parse_standard_weekday(start)?;
            let end = parse_standard_weekday(end)?;
            if start > end {
                return Err(format!("invalid cron weekday range '{base}'"));
            }
            (start..=end).collect()
        } else {
            vec![parse_standard_weekday(base)?]
        };
        for value in values.into_iter().step_by(step) {
            weekdays.insert(if value == 0 || value == 7 {
                1
            } else {
                value + 1
            });
        }
    }
    Ok(weekdays
        .into_iter()
        .map(|weekday| weekday.to_string())
        .collect::<Vec<_>>()
        .join(","))
}

fn parse_standard_weekday(value: &str) -> Result<u8, String> {
    let weekday = value
        .parse::<u8>()
        .map_err(|_| format!("invalid cron weekday '{value}'"))?;
    match weekday {
        0..=7 => Ok(weekday),
        _ => Err(format!("invalid cron weekday '{value}'")),
    }
}

fn next_fire_after(
    schedule: &Schedule,
    timezone: Option<Tz>,
    anchor: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    match timezone {
        Some(timezone) => schedule
            .after(&anchor.with_timezone(&timezone))
            .next()
            .map(|next| next.with_timezone(&Utc)),
        None => schedule
            .after(&anchor.with_timezone(&Local))
            .next()
            .map(|next| next.with_timezone(&Utc)),
    }
}

impl Alarm for CronEntry {
    fn fire_at(&self) -> Option<DateTime<Utc>> {
        if self.enabled {
            self.next_fire_at
        } else {
            None
        }
    }
}

/// Trait the daemon uses to emit fired events. Production binds this to
/// `AppHandle::emit("workflow:trigger", payload)`; tests inject a recording
/// emitter.
pub trait TriggerEmitter: Send + Sync + 'static {
    fn emit(&self, event: TriggerEvent);
}

/// In-test emitter that records every fired event for assertions.
#[cfg(test)]
#[derive(Default, Clone)]
pub struct RecordingEmitter {
    pub fired: Arc<parking_lot::Mutex<Vec<TriggerEvent>>>,
}

#[cfg(test)]
impl TriggerEmitter for RecordingEmitter {
    fn emit(&self, event: TriggerEvent) {
        self.fired.lock().push(event);
    }
}

/// Binds the generic `DueEmitter<CronEntry>` core to `TriggerEmitter`.
/// Always recomputes and returns `Some` to re-arm — a cron trigger is
/// multi-shot; it's only ever dropped by an explicit `remove()`.
struct CronDueAdapter {
    inner: Arc<dyn TriggerEmitter>,
}

impl DueEmitter<CronEntry> for CronDueAdapter {
    fn emit(&self, _id: &str, mut entry: CronEntry, fired_at: DateTime<Utc>) -> Option<CronEntry> {
        let event = TriggerEvent {
            workflow_id: entry.workflow_id.clone(),
            kind: "trigger.cron".into(),
            payload: serde_json::json!({
                "triggerId": entry.trigger_id,
                "firedAt": fired_at.timestamp_millis(),
            }),
            origin_at: fired_at.timestamp_millis(),
            binding: entry.binding.clone(),
        };
        self.inner.emit(event);
        entry.recompute(fired_at);
        Some(entry)
    }
}

/// Public handle to the daemon. Cloning is cheap and shares the same inner
/// state; pass clones into Tauri commands.
#[derive(Clone)]
pub struct CronDaemon {
    core: AlarmDaemonCore<CronEntry, CronDueAdapter>,
}

impl CronDaemon {
    pub fn new(emitter: Arc<dyn TriggerEmitter>) -> Self {
        Self {
            core: AlarmDaemonCore::new(Arc::new(CronDueAdapter { inner: emitter })),
        }
    }

    /// Add or replace an entry. Returns `Err` when the cron expression fails
    /// to parse — callers surface the message back to the TS bridge.
    pub fn upsert(
        &self,
        trigger_id: String,
        workflow_id: String,
        cron_expr: &str,
        timezone: Option<&str>,
        enabled: bool,
        binding: Option<TriggerBinding>,
    ) -> Result<(), String> {
        let schedule = parse_workflow_schedule(cron_expr)?;
        let timezone = timezone
            .map(|value| {
                value.parse::<Tz>().map_err(|_| {
                    format!("invalid cron timezone '{value}': expected an IANA timezone")
                })
            })
            .transpose()?;
        let now = Utc::now();
        let mut entry = CronEntry {
            trigger_id: trigger_id.clone(),
            workflow_id,
            schedule,
            timezone,
            enabled,
            binding,
            next_fire_at: None,
        };
        entry.recompute(now);
        self.core.upsert(trigger_id, entry);
        Ok(())
    }

    pub fn remove(&self, trigger_id: &str) {
        self.core.remove(trigger_id);
    }

    #[allow(dead_code)]
    pub fn entry_count(&self) -> usize {
        self.core.entry_count()
    }

    /// Convenience for tests + the diagnostics tab — returns the next-fire
    /// timestamp the loop is currently waiting on.
    #[allow(dead_code)]
    pub fn next_fire_at(&self) -> Option<DateTime<Utc>> {
        self.core.next_fire_at()
    }

    /// Spawn the long-running tokio task that drives firing. Should be called
    /// once during app boot.
    ///
    /// Uses `tauri::async_runtime::spawn` so it is safe to call from the
    /// Tauri `setup` closure (which runs on the main thread without a Tokio
    /// runtime entered). `tokio::spawn` would panic with
    /// "there is no reactor running" in that context.
    pub fn spawn(self) {
        tauri::async_runtime::spawn(async move {
            self.run_loop().await;
        });
    }

    /// The actual loop body. Public for tests so they can call it via
    /// `tokio::time::pause()` and step the clock manually if needed; in
    /// production we always call `spawn`.
    pub async fn run_loop(self) {
        self.core.run_loop().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::time::Duration;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DialectContract {
        anchor_utc: String,
        timezone: String,
        cases: Vec<DialectCase>,
        timezone_cases: Vec<TimezoneCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DialectCase {
        expression: String,
        accepted: bool,
        next_utc: Option<String>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TimezoneCase {
        name: String,
        expression: String,
        timezone: String,
        anchor_utc: String,
        next_utc: Vec<String>,
    }

    fn daemon_with_recorder() -> (CronDaemon, RecordingEmitter) {
        let recorder = RecordingEmitter::default();
        let daemon = CronDaemon::new(Arc::new(recorder.clone()));
        (daemon, recorder)
    }

    #[test]
    fn matches_the_shared_ts_rust_cron_dialect_contract() {
        let contract: DialectContract = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/scheduler/cron-dialect.json"
        ))
        .unwrap();
        let anchor = DateTime::parse_from_rfc3339(&contract.anchor_utc)
            .unwrap()
            .with_timezone(&Utc);

        for test_case in contract.cases {
            let parsed = parse_workflow_schedule(&test_case.expression);
            assert_eq!(
                parsed.is_ok(),
                test_case.accepted,
                "acceptance mismatch for {}",
                test_case.expression
            );
            if let Ok(schedule) = parsed {
                let timezone = contract.timezone.parse().unwrap();
                let next = next_fire_after(&schedule, Some(timezone), anchor).unwrap();
                let expected = DateTime::parse_from_rfc3339(
                    test_case
                        .next_utc
                        .as_deref()
                        .expect("accepted case needs nextUtc"),
                )
                .unwrap()
                .with_timezone(&Utc);
                assert_eq!(
                    next, expected,
                    "next-fire mismatch for {}",
                    test_case.expression
                );
            }
        }
    }

    #[test]
    fn translates_standard_numeric_weekdays_to_quartz_numbering() {
        assert_eq!(normalize_day_of_week("0").unwrap(), "1");
        assert_eq!(normalize_day_of_week("7").unwrap(), "1");
        assert_eq!(normalize_day_of_week("1-5").unwrap(), "2,3,4,5,6");
        assert_eq!(normalize_day_of_week("1-7").unwrap(), "1,2,3,4,5,6,7");
        assert_eq!(normalize_day_of_week("*/2").unwrap(), "1,3,5,7");
        assert!(normalize_day_of_week("6-1").is_err());
    }

    #[test]
    fn keeps_one_local_daily_fire_across_dst_boundaries() {
        let contract: DialectContract = serde_json::from_str(include_str!(
            "../../../../../test-fixtures/scheduler/cron-dialect.json"
        ))
        .unwrap();

        for test_case in contract.timezone_cases {
            let schedule = parse_workflow_schedule(&test_case.expression).unwrap();
            let timezone = test_case.timezone.parse().unwrap();
            let mut anchor = DateTime::parse_from_rfc3339(&test_case.anchor_utc)
                .unwrap()
                .with_timezone(&Utc);
            for expected in test_case.next_utc {
                let next = next_fire_after(&schedule, Some(timezone), anchor).unwrap();
                let expected = DateTime::parse_from_rfc3339(&expected)
                    .unwrap()
                    .with_timezone(&Utc);
                assert_eq!(next, expected, "DST mismatch for {}", test_case.name);
                anchor = next;
            }
        }
    }

    #[test]
    fn upsert_rejects_invalid_cron_expressions() {
        let (daemon, _) = daemon_with_recorder();
        let err = daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "this is not a cron",
                None,
                true,
                None,
            )
            .unwrap_err();
        assert!(err.contains("invalid cron"));
        assert_eq!(daemon.entry_count(), 0);
    }

    #[test]
    fn upsert_accepts_valid_cron_and_replaces_on_repeat() {
        let (daemon, _) = daemon_with_recorder();
        // The workflow boundary accepts both classic 5-field and seconds-aware 6-field forms.
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "0 9 * * 1-5",
                None,
                true,
                None,
            )
            .unwrap();
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "0 0 10 * * 1-5",
                None,
                true,
                None,
            )
            .unwrap();
        assert_eq!(daemon.entry_count(), 1);
    }

    #[test]
    fn remove_drops_an_entry() {
        let (daemon, _) = daemon_with_recorder();
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "0 9 * * 1-5",
                None,
                true,
                None,
            )
            .unwrap();
        daemon.remove("trg_1");
        assert_eq!(daemon.entry_count(), 0);
    }

    #[test]
    fn next_fire_at_returns_a_future_time_for_an_enabled_entry() {
        let (daemon, _) = daemon_with_recorder();
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                // Every second — guaranteed to have a future fire.
                "* * * * * *",
                None,
                true,
                None,
            )
            .unwrap();
        let next = daemon.next_fire_at().expect("expected a future fire");
        assert!(next > Utc::now() - chrono::Duration::seconds(1));
    }

    #[test]
    fn disabled_entries_are_skipped_in_next_fire_computation() {
        let (daemon, _) = daemon_with_recorder();
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "* * * * * *",
                None,
                false, // disabled
                None,
            )
            .unwrap();
        assert!(daemon.next_fire_at().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_loop_fires_a_due_trigger_at_least_once() {
        let (daemon, recorder) = daemon_with_recorder();
        // Every-second cron — the loop should fire it inside 1.5s.
        daemon
            .upsert(
                "trg_1".into(),
                "wf_1".into(),
                "* * * * * *",
                None,
                true,
                None,
            )
            .unwrap();
        // `timeout` drops the run_loop future when it elapses, so there is NO
        // detached task left running to block multi-thread runtime shutdown
        // (a `tokio::spawn`'d infinite loop hangs runtime drop even after
        // `abort()`) — matches the alarm-daemon tests' pattern.
        let _ = tokio::time::timeout(Duration::from_millis(1200), daemon.clone().run_loop()).await;
        let count = recorder.fired.lock().len();
        assert!(count >= 1, "expected at least one fire, got {count}");
        let event = recorder.fired.lock()[0].clone();
        assert_eq!(event.workflow_id, "wf_1");
        assert_eq!(event.kind, "trigger.cron");
    }
}
