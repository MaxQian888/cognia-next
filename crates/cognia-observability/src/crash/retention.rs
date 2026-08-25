//! Crash-report + rotated-log retention.
//!
//! Nothing pruned crash reports or rotated log files before this module, so
//! `crash-reports/` and the `cognia_*.log` rotation set grew without bound.
//! Mature desktop apps cap both by age and count. The two entry points
//! ([`prune_crash_reports`], [`prune_rotated_logs`]) are pure over an injected
//! `now`, so they unit-test against a tempdir without a real clock.
//!
//! `tauri-plugin-log`'s `RotationStrategy::KeepAll` keeps every rotated file
//! (it can't "keep N"), so [`prune_rotated_logs`] supplies the missing cap.

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Crash-report retention thresholds. Defaults: 30 days, 50 reports.
#[derive(Debug, Clone, Copy)]
pub struct RetentionPolicy {
    pub max_age_days: u64,
    pub max_reports: usize,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            max_age_days: 30,
            max_reports: 50,
        }
    }
}

/// How many rotated `cognia_*.log` files to keep (the live `cognia.log` is
/// never touched).
pub const ROTATED_LOG_KEEP: usize = 5;

/// Live log file size cap before `tauri-plugin-log` rotates (bytes).
pub const LOG_MAX_FILE_SIZE: u128 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PruneOutcome {
    pub pruned: usize,
    pub remaining: usize,
}

static LAST_PRUNE: Mutex<Option<PruneOutcome>> = Mutex::new(None);

/// Record the startup crash-report prune outcome so the diagnostics command
/// can surface it. Later calls replace earlier ones, which keeps diagnostics
/// honest if a manual or test prune runs after startup.
pub fn record_last_prune(outcome: PruneOutcome) {
    *LAST_PRUNE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(outcome);
}

static LAST_ROTATED_PRUNE: Mutex<Option<usize>> = Mutex::new(None);

/// Record how many rotated log files the startup sweep deleted.
///
/// [`prune_rotated_logs`] always returned this count and every caller threw
/// it away, so a sweep that deleted nothing and a sweep that deleted twenty
/// files looked identical from outside: bounded storage with no account of
/// what the bound cost. Retention that cannot say what it removed is
/// indistinguishable from logs that were never written.
pub fn record_rotated_prune(pruned: usize) {
    *LAST_ROTATED_PRUNE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(pruned);
}

/// How many rotated logs the last sweep deleted, if one has run this session.
pub fn last_rotated_prune() -> Option<usize> {
    *LAST_ROTATED_PRUNE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The startup prune outcome, if a prune has run this session.
pub fn last_prune() -> Option<PruneOutcome> {
    *LAST_PRUNE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Parse the embedded timestamp from a `crash-<YYYY-MM-DD_HH-MM-SS>-<kind>`
/// stem. Returns `None` for anything that doesn't match (caller keeps such
/// stems out of the age sweep but still counts them for the count cap).
fn stem_timestamp(stem: &str) -> Option<DateTime<Utc>> {
    let rest = stem.strip_prefix("crash-")?;
    // The timestamp is the fixed-width leading 19 chars: `2026-05-25_00-00-00`.
    if rest.len() < 19 {
        return None;
    }
    let ts = &rest[..19];
    NaiveDateTime::parse_from_str(ts, "%Y-%m-%d_%H-%M-%S")
        .ok()
        .map(|naive| DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

/// Group crash-report files (`.txt`/`.json`/`.dmp`) under `dir` by stem.
fn group_report_files(dir: &Path) -> BTreeMap<String, Vec<PathBuf>> {
    let mut by_stem: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return by_stem;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(ext, "txt" | "json" | "dmp") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
            continue;
        };
        by_stem.entry(stem).or_default().push(path);
    }
    by_stem
}

fn delete_files(files: &[PathBuf]) {
    for path in files {
        let _ = std::fs::remove_file(path);
    }
}

/// Prune crash reports older than `policy.max_age_days`, then drop the oldest
/// beyond `policy.max_reports`. Each report's `.txt`/`.json`/`.dmp` files are
/// removed as a unit. Returns the prune outcome (also recorded for the
/// diagnostics command).
pub fn prune_crash_reports(
    dir: &Path,
    policy: &RetentionPolicy,
    now: DateTime<Utc>,
) -> PruneOutcome {
    let mut groups = group_report_files(dir);
    let cutoff = now - Duration::days(policy.max_age_days as i64);
    let mut pruned = 0usize;

    // 1) Age sweep — only stems with a parseable, older-than-cutoff timestamp.
    let aged: Vec<String> = groups
        .keys()
        .filter_map(|stem| match stem_timestamp(stem) {
            Some(ts) if ts < cutoff => Some(stem.clone()),
            _ => None,
        })
        .collect();
    for stem in aged {
        if let Some(files) = groups.remove(&stem) {
            delete_files(&files);
            pruned += 1;
        }
    }

    // 2) Count cap — newest first (stems sort by timestamp), keep max_reports.
    if groups.len() > policy.max_reports {
        let mut stems: Vec<String> = groups.keys().cloned().collect();
        stems.sort_by(|a, b| b.cmp(a)); // newest (largest stem) first
        for stem in stems.into_iter().skip(policy.max_reports) {
            if let Some(files) = groups.remove(&stem) {
                delete_files(&files);
                pruned += 1;
            }
        }
    }

    let outcome = PruneOutcome {
        pruned,
        remaining: groups.len(),
    };
    record_last_prune(outcome);
    outcome
}

/// Delete rotated `cognia_*.log` files beyond the newest `keep`. The live
/// `cognia.log` (no underscore suffix) is never removed. Returns the count
/// deleted.
pub fn prune_rotated_logs(log_dir: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(log_dir) else {
        return 0;
    };
    let mut rotated: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                return false;
            };
            // Rotated files look like `cognia_<timestamp>.log`; the live file
            // is exactly `cognia.log`.
            name.starts_with("cognia_") && name.ends_with(".log")
        })
        .collect();

    if rotated.len() <= keep {
        return 0;
    }

    // Newest first by filename (embedded timestamps sort lexicographically).
    rotated.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    let mut deleted = 0usize;
    for path in rotated.into_iter().skip(keep) {
        if std::fs::remove_file(&path).is_ok() {
            deleted += 1;
        }
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, bytes: &str) {
        fs::write(path, bytes).unwrap();
    }

    fn report(dir: &Path, stem: &str, exts: &[&str]) {
        for ext in exts {
            write(&dir.join(format!("{stem}.{ext}")), "x");
        }
    }

    #[test]
    fn stem_timestamp_parses_and_rejects() {
        assert!(stem_timestamp("crash-2026-05-25_00-00-00-panic").is_some());
        assert!(stem_timestamp("crash-2026-05-25_12-30-45-native").is_some());
        assert!(stem_timestamp("not-a-crash").is_none());
        assert!(stem_timestamp("crash-short").is_none());
    }

    #[test]
    fn prunes_reports_older_than_max_age() {
        let dir = tempfile::tempdir().unwrap();
        let now = stem_timestamp("crash-2026-06-11_00-00-00-panic").unwrap();
        // 40 days old → pruned; 5 days old → kept.
        report(
            dir.path(),
            "crash-2026-05-02_00-00-00-panic",
            &["txt", "json"],
        );
        report(
            dir.path(),
            "crash-2026-06-06_00-00-00-panic",
            &["txt", "json"],
        );

        let outcome = prune_crash_reports(dir.path(), &RetentionPolicy::default(), now);

        assert_eq!(outcome.pruned, 1);
        assert_eq!(outcome.remaining, 1);
        assert!(!dir
            .path()
            .join("crash-2026-05-02_00-00-00-panic.txt")
            .exists());
        assert!(dir
            .path()
            .join("crash-2026-06-06_00-00-00-panic.txt")
            .exists());
    }

    #[test]
    fn deletes_all_three_extensions_for_a_pruned_stem() {
        let dir = tempfile::tempdir().unwrap();
        let now = stem_timestamp("crash-2026-06-11_00-00-00-panic").unwrap();
        report(
            dir.path(),
            "crash-2026-01-01_00-00-00-native",
            &["txt", "json", "dmp"],
        );

        prune_crash_reports(dir.path(), &RetentionPolicy::default(), now);

        for ext in ["txt", "json", "dmp"] {
            assert!(!dir
                .path()
                .join(format!("crash-2026-01-01_00-00-00-native.{ext}"))
                .exists());
        }
    }

    #[test]
    fn enforces_max_report_count_keeping_newest() {
        let dir = tempfile::tempdir().unwrap();
        let now = stem_timestamp("crash-2026-06-11_00-00-00-panic").unwrap();
        let policy = RetentionPolicy {
            max_age_days: 3650, // disable age sweep
            max_reports: 2,
        };
        // Three recent reports; only the 2 newest survive.
        report(dir.path(), "crash-2026-06-08_00-00-00-panic", &["txt"]);
        report(dir.path(), "crash-2026-06-09_00-00-00-panic", &["txt"]);
        report(dir.path(), "crash-2026-06-10_00-00-00-panic", &["txt"]);

        let outcome = prune_crash_reports(dir.path(), &policy, now);

        assert_eq!(outcome.remaining, 2);
        assert_eq!(outcome.pruned, 1);
        assert!(!dir
            .path()
            .join("crash-2026-06-08_00-00-00-panic.txt")
            .exists());
        assert!(dir
            .path()
            .join("crash-2026-06-10_00-00-00-panic.txt")
            .exists());
    }

    #[test]
    fn missing_dir_yields_zero_outcome() {
        let outcome = prune_crash_reports(
            Path::new("/nonexistent/cognia/crash-reports"),
            &RetentionPolicy::default(),
            Utc::now(),
        );
        assert_eq!(
            outcome,
            PruneOutcome {
                pruned: 0,
                remaining: 0
            }
        );
    }

    #[test]
    fn prunes_rotated_logs_keeping_newest() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("cognia.log"), "live");
        for day in ["01", "02", "03", "04", "05", "06", "07"] {
            write(
                &dir.path()
                    .join(format!("cognia_2026-06-{day}_00-00-00.log")),
                "old",
            );
        }

        let deleted = prune_rotated_logs(dir.path(), ROTATED_LOG_KEEP);

        assert_eq!(deleted, 2); // 7 rotated - keep 5
        assert!(dir.path().join("cognia.log").exists()); // live file untouched
        assert!(dir.path().join("cognia_2026-06-07_00-00-00.log").exists());
        assert!(!dir.path().join("cognia_2026-06-01_00-00-00.log").exists());
    }

    #[test]
    fn rotated_log_prune_noop_when_under_cap() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir.path().join("cognia.log"), "live");
        write(&dir.path().join("cognia_2026-06-01_00-00-00.log"), "old");
        assert_eq!(prune_rotated_logs(dir.path(), ROTATED_LOG_KEEP), 0);
    }

    #[test]
    fn record_last_prune_replaces_previous_outcome() {
        record_last_prune(PruneOutcome {
            pruned: 0,
            remaining: 2,
        });
        record_last_prune(PruneOutcome {
            pruned: 1,
            remaining: 1,
        });

        assert_eq!(
            last_prune(),
            Some(PruneOutcome {
                pruned: 1,
                remaining: 1,
            })
        );
    }

    #[test]
    fn last_prune_records_outcome() {
        // Exercises the recorder via a real prune. Ordering vs other tests is
        // irrelevant — we only assert a value is present and well-formed.
        let dir = tempfile::tempdir().unwrap();
        report(dir.path(), "crash-2026-06-10_00-00-00-panic", &["txt"]);
        prune_crash_reports(dir.path(), &RetentionPolicy::default(), Utc::now());
        let recorded = last_prune().expect("a prune was recorded");
        assert!(recorded.remaining <= 1);
    }

    #[test]
    fn a_rotated_sweep_is_recorded_rather_than_discarded() {
        // Before this the count came back from `prune_rotated_logs` and every
        // caller dropped it, so nothing could say what retention had cost.
        record_rotated_prune(7);
        assert_eq!(last_rotated_prune(), Some(7));
        record_rotated_prune(0);
        assert_eq!(
            last_rotated_prune(),
            Some(0),
            "a sweep that deleted nothing must be distinguishable from no sweep at all"
        );
    }
}
