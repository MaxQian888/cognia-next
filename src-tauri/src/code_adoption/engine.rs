//! The stateful attribution engine — a process-global `Lazy` static (mirroring
//! `fleet::runtime`) so it is reachable both from Tauri commands (in-app) and,
//! in a future phase, from the fleet axum hook handler which has no `AppHandle`.
//!
//! State is two maps behind one `parking_lot::Mutex`:
//! - `windows`: canonical-cwd → turn-key. Enforces per-cwd serialization; a
//!   second turn on the same cwd is skipped (concurrent workspace edits cannot
//!   be attributed cleanly, and we never block the agent).
//! - `baselines`: turn-key → the open turn's baseline fingerprint + metadata.
//!
//! The `parking_lot` guard is only ever held across synchronous git2 work (the
//! engine methods run inside `spawn_blocking`), never across an `.await`.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use git2::Repository;
use once_cell::sync::Lazy;
use parking_lot::Mutex;

use super::attribution::reconcile;
use super::fingerprint::{snapshot, Snapshot};
use super::{BeginOutcome, CodeAdoptionTurn, FileAttribution, SkipReason, TurnMeta};

/// Abandon (and release the cwd window of) a turn whose `turn_end` never fired
/// — a renderer crash or lost IPC — after this long.
const ORPHAN_TTL_SECS: u64 = 30 * 60;

struct ActiveTurn {
    cwd: String,
    cwd_key: String,
    baseline: Snapshot,
    started: Instant,
    meta: TurnMeta,
}

#[derive(Default)]
struct EngineState {
    /// canonical cwd → turn-key currently owning the attribution window.
    windows: HashMap<String, String>,
    /// turn-key → the open turn.
    baselines: HashMap<String, ActiveTurn>,
}

#[derive(Default)]
pub struct CodeAdoptionEngine {
    state: Mutex<EngineState>,
}

static ENGINE: Lazy<CodeAdoptionEngine> = Lazy::new(CodeAdoptionEngine::default);

/// The process-global engine. In-app commands and (future) fleet both call this.
pub fn engine() -> &'static CodeAdoptionEngine {
    &ENGINE
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn canonical(cwd: &str) -> String {
    std::fs::canonicalize(cwd)
        .ok()
        .and_then(|p| p.to_str().map(str::to_string))
        .unwrap_or_else(|| cwd.to_string())
}

/// Drop baselines older than `ttl` and release their cwd windows.
fn sweep(st: &mut EngineState, ttl: Duration) {
    let stale: Vec<String> = st
        .baselines
        .iter()
        .filter(|(_, a)| a.started.elapsed() > ttl)
        .map(|(k, _)| k.clone())
        .collect();
    for key in stale {
        if let Some(a) = st.baselines.remove(&key) {
            if st.windows.get(&a.cwd_key) == Some(&key) {
                st.windows.remove(&a.cwd_key);
            }
        }
    }
}

impl CodeAdoptionEngine {
    /// Open an attribution window for a turn. Best-effort: a non-git cwd or a
    /// concurrent same-cwd turn is skipped, never an error the caller must handle.
    pub fn turn_begin(&self, cwd: String, meta: TurnMeta) -> Result<BeginOutcome, String> {
        let cwd_key = canonical(&cwd);
        let turn_key = meta.turn_key();

        let mut st = self.state.lock();
        sweep(&mut st, Duration::from_secs(ORPHAN_TTL_SECS));

        if st.windows.contains_key(&cwd_key) {
            return Ok(BeginOutcome::skipped(SkipReason::Concurrent));
        }
        let repo = match Repository::discover(&cwd) {
            Ok(r) => r,
            Err(_) => return Ok(BeginOutcome::skipped(SkipReason::NotGitRepo)),
        };
        let base = snapshot(&repo)?;

        st.windows.insert(cwd_key.clone(), turn_key.clone());
        st.baselines.insert(
            turn_key,
            ActiveTurn {
                cwd,
                cwd_key,
                baseline: base,
                started: Instant::now(),
                meta,
            },
        );
        Ok(BeginOutcome::Started)
    }

    /// Close the window for `turn_key` and reconcile into a metrics record.
    /// Returns `None` when the turn was never opened (skipped / orphaned).
    pub fn turn_end(&self, turn_key: &str) -> Result<Option<CodeAdoptionTurn>, String> {
        let active = {
            let mut st = self.state.lock();
            sweep(&mut st, Duration::from_secs(ORPHAN_TTL_SECS));
            match st.baselines.remove(turn_key) {
                Some(a) => {
                    if st.windows.get(&a.cwd_key) == Some(&turn_key.to_string()) {
                        st.windows.remove(&a.cwd_key);
                    }
                    a
                }
                None => return Ok(None),
            }
        };
        // Reconcile OUTSIDE the lock — state is already released, so a slow git
        // walk here cannot serialize other turns.
        let repo =
            Repository::discover(&active.cwd).map_err(|e| format!("discover failed: {e}"))?;
        let current = snapshot(&repo)?;
        let (files, truncated) = reconcile(&active.cwd, &active.baseline, &current);
        Ok(Some(build_turn(&active, files, truncated)))
    }
}

fn build_turn(
    active: &ActiveTurn,
    files: Vec<FileAttribution>,
    truncated: bool,
) -> CodeAdoptionTurn {
    let total_added = files.iter().map(|f| f.added).sum();
    let total_removed = files.iter().map(|f| f.removed).sum();
    CodeAdoptionTurn {
        id: active.meta.turn_key(),
        run_id: active.meta.run_id,
        session_id: active.meta.session_id.clone(),
        workspace_root: active.cwd_key.clone(),
        agent_kind: active.meta.agent_kind.clone(),
        model: active.meta.model.clone(),
        ts: now_ms(),
        total_files: files.len() as u32,
        total_added,
        total_removed,
        files,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use tempfile::TempDir;

    fn meta(session: &str, run: u32) -> TurnMeta {
        TurnMeta {
            session_id: session.to_string(),
            run_id: run,
            model: Some("claude-opus-4-8".to_string()),
            agent_kind: "in-app".to_string(),
        }
    }

    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "T").unwrap();
            cfg.set_str("user.email", "t@e.com").unwrap();
        }
        fs::write(tmp.path().join("seed.ts"), "seed\n").unwrap();
        let sig = Signature::now("T", "t@e.com").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        tmp
    }

    #[test]
    fn non_git_cwd_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let e = CodeAdoptionEngine::default();
        let out = e
            .turn_begin(tmp.path().to_str().unwrap().to_string(), meta("s1", 1))
            .unwrap();
        assert_eq!(out, BeginOutcome::skipped(SkipReason::NotGitRepo));
    }

    #[test]
    fn concurrent_same_cwd_turn_is_skipped() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap().to_string();
        let e = CodeAdoptionEngine::default();
        assert_eq!(
            e.turn_begin(cwd.clone(), meta("s1", 1)).unwrap(),
            BeginOutcome::Started
        );
        assert_eq!(
            e.turn_begin(cwd, meta("s2", 1)).unwrap(),
            BeginOutcome::skipped(SkipReason::Concurrent)
        );
    }

    #[test]
    fn begin_then_end_returns_attributed_turn() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap().to_string();
        let e = CodeAdoptionEngine::default();
        e.turn_begin(cwd.clone(), meta("s1", 7)).unwrap();
        fs::write(tmp.path().join("written.ts"), "a\nb\n").unwrap();

        let turn = e.turn_end("s1:7").unwrap().expect("turn present");
        assert_eq!(turn.id, "s1:7");
        assert_eq!(turn.run_id, 7);
        assert_eq!(turn.agent_kind, "in-app");
        assert!(turn
            .files
            .iter()
            .any(|f| f.path == "written.ts" && f.is_new));
        assert!(turn.total_added >= 2);
    }

    #[test]
    fn end_releases_the_cwd_window() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap().to_string();
        let e = CodeAdoptionEngine::default();
        e.turn_begin(cwd.clone(), meta("s1", 1)).unwrap();
        e.turn_end("s1:1").unwrap();
        // window freed → a new turn on the same cwd may start.
        assert_eq!(
            e.turn_begin(cwd, meta("s1", 2)).unwrap(),
            BeginOutcome::Started
        );
    }

    #[test]
    fn end_unknown_turn_is_none() {
        let e = CodeAdoptionEngine::default();
        assert!(e.turn_end("nope:0").unwrap().is_none());
    }

    #[test]
    fn orphan_sweep_releases_stale_window() {
        let tmp = init_repo();
        let cwd = tmp.path().to_str().unwrap().to_string();
        let e = CodeAdoptionEngine::default();
        e.turn_begin(cwd, meta("s1", 1)).unwrap();
        {
            let mut st = e.state.lock();
            for a in st.baselines.values_mut() {
                a.started = a
                    .started
                    .checked_sub(Duration::from_secs(ORPHAN_TTL_SECS + 1))
                    .unwrap();
            }
            sweep(&mut st, Duration::from_secs(ORPHAN_TTL_SECS));
            assert!(st.windows.is_empty());
            assert!(st.baselines.is_empty());
        }
    }
}
