//! `trigger.file.watch` daemon.
//!
//! A filesystem watcher cannot live in the renderer. The `notify` crate is
//! native, and a webview reload would drop every watch, so a trigger whose
//! whole point is to fire while the app sits in the tray has to run here,
//! beside the cron daemon and the webhook router. `WorkflowState` is
//! host-neutral (`lib.rs` builds one on the desktop, `headless/mod.rs` builds
//! one on the cloud brain, each with its own `TriggerEmitter`), so one
//! implementation serves both.
//!
//! ## Why this is not just a debounced watcher
//!
//! A workflow writes files through many uncoordinated seams: the fs nodes,
//! the terminal nodes, git nodes, an agent turn, a plugin node. A trigger that
//! fires on file changes and then starts a run that writes files is a loop,
//! and no amount of debouncing closes it, because the run outlives any
//! plausible debounce window.
//!
//! So each registration is a state machine rather than a debounce:
//!
//! ```text
//!   Armed ──(change)──▶ Debouncing ──(quiet)──▶ [emit one event] ──▶ Muted
//!     ▲                                                               │
//!     └──────────(ack received AND settle_ms of quiet)────────────────┘
//! ```
//!
//! The TS bridge acks in a `finally` around the dispatch, and `dispatchTrigger`
//! awaits the entire run, so **the mute window strictly contains the run's
//! execution window**. Every file the run writes under the watched root is
//! observed while muted and dropped. This does not depend on the writing node
//! cooperating, on an origin stamp, or on timing luck.
//!
//! Events seen while muted are counted, never queued. The count rides the next
//! payload as `suppressedSince`, so a workflow can see that it missed
//! coalesced churn without being handed a replay of it.
//!
//! Two failure modes get explicit handling rather than hope:
//!
//!  - **A lost ack** (webview crash mid-run, brain WS drop) would otherwise
//!    brick the trigger forever. `mute_timeout_ms` lifts the mute with a
//!    warning, so a lost ack degrades to *late re-arm* and never to a dead
//!    trigger.
//!  - **External churn** that is nobody's loop: a `pnpm build` inside a watched
//!    root. A per-registration token bucket caps fires per minute. Gitignore
//!    filtering alone does not cover this, because not every workspace is a
//!    git repository.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde_json::json;

use crate::workflow::triggers::cron_daemon::TriggerEmitter;
use crate::workflow::types::{RegisterTriggerInput, TriggerBinding, TriggerEvent};

/// Trailing debounce window. Matches `cognia-git`'s watcher, which coalesces
/// the same kind of burst.
const DEFAULT_DEBOUNCE_MS: u64 = 250;
/// Quiet required after an ack before the registration re-arms.
const DEFAULT_SETTLE_MS: u64 = 2_000;
/// How long a mute may survive without an ack before it lifts itself.
const DEFAULT_MUTE_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
/// Fires per minute per registration.
const DEFAULT_MAX_FIRES_PER_MINUTE: u32 = 30;
/// Ceiling on the catch-up walk, so a cold start cannot stall boot.
const CATCH_UP_MAX_ENTRIES: usize = 50_000;
/// How often the mute-hold loop re-checks its two conditions.
const MUTE_POLL_MS: u64 = 200;

/// What the debounced batch decided, computed under the lock and acted on
/// after it is released.
enum FireDecision {
    /// Already muted: a run is in flight and this batch is its own churn.
    Skip,
    /// The token bucket refused it.
    OverBudget,
    Fire { suppressed: u64 },
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Authored configuration for one watch, normalised from `RegisterTriggerInput`.
#[derive(Debug, Clone)]
pub struct FileWatchConfig {
    pub root: PathBuf,
    pub globs: Vec<String>,
    pub ignore_globs: Vec<String>,
    pub respect_gitignore: bool,
    pub events: Vec<String>,
    pub recursive: bool,
    pub debounce_ms: u64,
    pub settle_ms: u64,
    pub catch_up_on_start: bool,
    pub max_fires_per_minute: u32,
    pub mute_timeout_ms: u64,
}

impl FileWatchConfig {
    /// Read the authored fields off a register call, clamping every window so
    /// a mistyped param cannot produce a watcher that never fires or one that
    /// fires continuously.
    pub fn from_input(input: &RegisterTriggerInput) -> Result<Self, String> {
        let root = input
            .file_watch_root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "trigger.file.watch requires a root".to_string())?;
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return Err(format!(
                "trigger.file.watch root must be absolute, got {}",
                root.display()
            ));
        }
        // Canonicalize, for the same reason `cognia-git`'s watcher keys on a
        // canonical path. `notify` reports the resolved path (on macOS the
        // temp dir and any symlinked project root differ from what the author
        // typed), and `path_matches` strips the ROOT as its prefix. Without
        // this, a symlinked root produces a watcher that matches nothing and
        // fails completely silently.
        let root = std::fs::canonicalize(&root).unwrap_or(root);
        reject_overbroad_root(&root)?;
        Ok(Self {
            root,
            globs: input.file_watch_globs.clone().unwrap_or_default(),
            ignore_globs: input.file_watch_ignore_globs.clone().unwrap_or_default(),
            respect_gitignore: input.file_watch_respect_gitignore.unwrap_or(true),
            events: input.file_watch_events.clone().unwrap_or_default(),
            recursive: input.file_watch_recursive.unwrap_or(true),
            debounce_ms: input
                .file_watch_debounce_ms
                .unwrap_or(DEFAULT_DEBOUNCE_MS)
                .clamp(50, 60_000),
            settle_ms: input
                .file_watch_settle_ms
                .unwrap_or(DEFAULT_SETTLE_MS)
                .min(600_000),
            catch_up_on_start: input.file_watch_catch_up_on_start.unwrap_or(false),
            max_fires_per_minute: input
                .file_watch_max_fires_per_minute
                .unwrap_or(DEFAULT_MAX_FIRES_PER_MINUTE)
                .clamp(1, 600),
            mute_timeout_ms: DEFAULT_MUTE_TIMEOUT_MS,
        })
    }
}

/// Refuse a root broad enough to be an incident rather than a watch.
///
/// A recursive watch on `/` or on the user's home is a `max_user_watches`
/// exhaustion on Linux and an FSEvents firehose on macOS. Neither is a
/// configuration anybody means, and the failure arrives far from the cause,
/// so it is refused at registration where the author can still see why.
fn reject_overbroad_root(root: &Path) -> Result<(), String> {
    if root.parent().is_none() {
        return Err("trigger.file.watch will not watch the filesystem root".into());
    }
    if let Some(home) = dirs_home() {
        if root == home {
            return Err(
                "trigger.file.watch will not watch the whole home directory. Point it at a project."
                    .into(),
            );
        }
    }
    Ok(())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Whether a changed path is one this registration cares about.
pub fn path_matches(
    root: &Path,
    config: &FileWatchConfig,
    gitignore: Option<&ignore::gitignore::Gitignore>,
    path: &Path,
    is_dir: bool,
) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        // Outside the watched root: not ours.
        return false;
    };
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str.is_empty() {
        return false;
    }
    // `.git` internals churn on every command and are never what an author
    // means by "when a file changes".
    if rel_str == ".git" || rel_str.starts_with(".git/") {
        return false;
    }
    if let Some(gi) = gitignore {
        if gi.matched(rel, is_dir).is_ignore() {
            return false;
        }
    }
    for pattern in &config.ignore_globs {
        if glob_matches(pattern, &rel_str) {
            return false;
        }
    }
    if config.globs.is_empty() {
        return true;
    }
    config
        .globs
        .iter()
        .any(|pattern| glob_matches(pattern, &rel_str))
}

/// Minimal glob: `**` spans separators, `*` does not, `?` is one character.
///
/// Deliberately not a dependency. The `ignore` crate's matcher is built for
/// gitignore semantics (negation, directory-only patterns, precedence) which
/// would be surprising in an include filter, and the patterns an author writes
/// here are `src/**/*.ts` shaped.
pub fn glob_matches(pattern: &str, path: &str) -> bool {
    glob_walk(pattern.as_bytes(), path.as_bytes())
}

fn glob_walk(pattern: &[u8], path: &[u8]) -> bool {
    if pattern.is_empty() {
        return path.is_empty();
    }
    if pattern.starts_with(b"**") {
        let rest = &pattern[2..];
        // `**/` also matches zero segments, so `**/a.ts` matches `a.ts`.
        let rest = rest.strip_prefix(b"/").unwrap_or(rest);
        if rest.is_empty() {
            return true;
        }
        let mut idx = 0usize;
        loop {
            if glob_walk(rest, &path[idx..]) {
                return true;
            }
            match path[idx..].iter().position(|b| *b == b'/') {
                Some(pos) => idx += pos + 1,
                None => return false,
            }
            if idx > path.len() {
                return false;
            }
        }
    }
    match pattern[0] {
        b'*' => {
            let rest = &pattern[1..];
            let mut idx = 0usize;
            loop {
                if glob_walk(rest, &path[idx..]) {
                    return true;
                }
                if idx >= path.len() || path[idx] == b'/' {
                    return false;
                }
                idx += 1;
            }
        }
        b'?' => {
            if path.is_empty() || path[0] == b'/' {
                return false;
            }
            glob_walk(&pattern[1..], &path[1..])
        }
        c => {
            if path.is_empty() || path[0] != c {
                return false;
            }
            glob_walk(&pattern[1..], &path[1..])
        }
    }
}

/// Map a `notify` event to the vocabulary an author filters on.
pub fn event_kind_name(kind: &notify::EventKind) -> &'static str {
    use notify::EventKind;
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "removed",
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => "renamed",
        EventKind::Modify(_) => "modified",
        _ => "modified",
    }
}

/// Where a registration is in its cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchPhase {
    Armed,
    Debouncing,
    /// Fired, waiting for both an ack and `settle_ms` of quiet.
    Muted,
}

#[derive(Debug)]
struct Shared {
    phase: WatchPhase,
    /// Set by `ack`. The mute needs this AND quiet before it lifts.
    acked: bool,
    /// Last time any matching event was seen, for the settle check.
    last_event_at: i64,
    /// When the mute began, for the fail-safe timeout.
    muted_at: i64,
    /// Matching events observed while muted. Counted, never queued.
    suppressed: u64,
    /// Epoch-ms of the fires inside the current minute, for the token bucket.
    recent_fires: Vec<i64>,
}

impl Shared {
    fn new() -> Self {
        Self {
            phase: WatchPhase::Armed,
            acked: false,
            last_event_at: 0,
            muted_at: 0,
            suppressed: 0,
            recent_fires: Vec::new(),
        }
    }

    /// Whether a fire is allowed under the token bucket, consuming one if so.
    fn take_token(&mut self, now: i64, max_per_minute: u32) -> bool {
        self.recent_fires.retain(|at| now - *at < 60_000);
        if self.recent_fires.len() as u32 >= max_per_minute {
            return false;
        }
        self.recent_fires.push(now);
        true
    }

    /// Whether the mute may lift: acked and settled, or timed out.
    fn mute_may_lift(&self, now: i64, settle_ms: u64, mute_timeout_ms: u64) -> Option<bool> {
        if self.phase != WatchPhase::Muted {
            return None;
        }
        if now - self.muted_at >= mute_timeout_ms as i64 {
            // Timed out: a lost ack degrades to late re-arm, never to a dead
            // trigger.
            return Some(true);
        }
        if self.acked && now - self.last_event_at >= settle_ms as i64 {
            return Some(true);
        }
        Some(false)
    }
}

struct Registration {
    workflow_id: String,
    trigger_id: String,
    config: FileWatchConfig,
    binding: Option<TriggerBinding>,
    shared: Arc<Mutex<Shared>>,
    /// Dropping the watcher stops it and closes its channel, ending the task.
    _watcher: RecommendedWatcher,
}

/// One daemon per process, hung off `WorkflowState`.
#[derive(Default)]
pub struct FileWatchDaemon {
    registrations: Mutex<HashMap<String, Registration>>,
}

impl FileWatchDaemon {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of live registrations. Used by tests and diagnostics.
    pub fn len(&self) -> usize {
        self.registrations.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Register (or replace) a watch. Replacing drops the old watcher, which
    /// stops it and ends its task, so a re-registered trigger never runs twice.
    pub fn upsert(
        &self,
        input: &RegisterTriggerInput,
        emitter: Arc<dyn TriggerEmitter>,
    ) -> Result<(), String> {
        if !input.enabled {
            self.remove(&input.trigger_id);
            return Ok(());
        }
        let config = FileWatchConfig::from_input(input)?;
        if !config.root.exists() {
            return Err(format!(
                "trigger.file.watch root does not exist: {}",
                config.root.display()
            ));
        }

        let gitignore = if config.respect_gitignore {
            let mut builder = ignore::gitignore::GitignoreBuilder::new(&config.root);
            let _ = builder.add(config.root.join(".gitignore"));
            builder.build().ok()
        } else {
            None
        };

        let shared = Arc::new(Mutex::new(Shared::new()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

        let filter_root = config.root.clone();
        let filter_config = config.clone();
        let filter_shared = shared.clone();
        let mut watcher = notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                let kind = event_kind_name(&event.kind);
                if !filter_config.events.is_empty()
                    && !filter_config.events.iter().any(|e| e == kind)
                {
                    return;
                }
                let matched = event.paths.iter().any(|p| {
                    path_matches(&filter_root, &filter_config, gitignore.as_ref(), p, p.is_dir())
                });
                if !matched {
                    return;
                }
                // Stamped on EVERY matching event, muted or not: the settle
                // check is "quiet since the last change", and a muted run
                // writing files has to keep pushing that horizon out.
                let mut state = filter_shared.lock();
                state.last_event_at = now_ms();
                if state.phase == WatchPhase::Muted {
                    state.suppressed = state.suppressed.saturating_add(1);
                    return;
                }
                state.phase = WatchPhase::Debouncing;
                drop(state);
                let _ = tx.send(kind.to_string());
            },
        )
        .map_err(|e| format!("trigger.file.watch: notify init failed: {e}"))?;

        let mode = if config.recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        watcher
            .watch(&config.root, mode)
            .map_err(|e| format!("trigger.file.watch: watch failed: {e}"))?;

        let task_shared = shared.clone();
        let task_config = config.clone();
        let task_emitter = emitter.clone();
        let workflow_id = input.workflow_id.clone();
        let trigger_id = input.trigger_id.clone();
        let binding = input.binding.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(first_kind) = rx.recv().await {
                let mut last_kind = first_kind;
                // Trailing debounce: keep draining until the burst goes quiet.
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(task_config.debounce_ms)) => break,
                        msg = rx.recv() => match msg {
                            Some(kind) => last_kind = kind,
                            None => return,
                        },
                    }
                }

                let now = now_ms();
                // Every lock in this task is taken inside its own block and
                // released before the next `.await`. `parking_lot` guards are
                // not `Send`, and one alive across an await point makes the
                // whole future unspawnable.
                let decision = {
                    let mut state = task_shared.lock();
                    if state.phase == WatchPhase::Muted {
                        FireDecision::Skip
                    } else if !state.take_token(now, task_config.max_fires_per_minute) {
                        // Over budget. Re-arm rather than mute: nothing fired,
                        // so there is no ack coming.
                        state.phase = WatchPhase::Armed;
                        FireDecision::OverBudget
                    } else {
                        let suppressed = std::mem::take(&mut state.suppressed);
                        state.phase = WatchPhase::Muted;
                        state.acked = false;
                        state.muted_at = now;
                        FireDecision::Fire { suppressed }
                    }
                };
                let suppressed = match decision {
                    FireDecision::Skip => continue,
                    FireDecision::OverBudget => {
                        log::warn!(
                            "trigger.file.watch {trigger_id}: over {} fires/minute, dropping a batch",
                            task_config.max_fires_per_minute
                        );
                        continue
                    }
                    FireDecision::Fire { suppressed } => suppressed,
                };

                task_emitter.emit(TriggerEvent {
                    workflow_id: workflow_id.clone(),
                    kind: "trigger.file.watch".into(),
                    trigger_id: Some(trigger_id.clone()),
                    payload: json!({
                        "root": task_config.root.to_string_lossy(),
                        "eventKind": last_kind,
                        "suppressedSince": suppressed,
                        "catchUp": false,
                    }),
                    origin_at: now,
                    binding: binding.clone(),
                });

                // Hold the mute until the run acks AND the tree goes quiet, or
                // until the fail-safe lifts it.
                loop {
                    tokio::time::sleep(Duration::from_millis(MUTE_POLL_MS)).await;
                    let lifted = {
                        let mut state = task_shared.lock();
                        match state.mute_may_lift(
                            now_ms(),
                            task_config.settle_ms,
                            task_config.mute_timeout_ms,
                        ) {
                            // Not muted any more: somebody else re-armed it.
                            None => Some(false),
                            Some(true) => {
                                let timed_out = !state.acked;
                                state.phase = WatchPhase::Armed;
                                state.acked = false;
                                Some(timed_out)
                            }
                            Some(false) => None,
                        }
                    };
                    match lifted {
                        None => continue,
                        Some(timed_out) => {
                            if timed_out {
                                log::warn!(
                                    "trigger.file.watch {trigger_id}: mute timed out without an ack, re-arming"
                                );
                            }
                            break
                        }
                    }
                }
            }
        });

        self.registrations.lock().insert(
            input.trigger_id.clone(),
            Registration {
                workflow_id: input.workflow_id.clone(),
                trigger_id: input.trigger_id.clone(),
                config,
                binding: input.binding.clone(),
                shared,
                _watcher: watcher,
            },
        );
        Ok(())
    }

    /// The run that this trigger started has finished. Half of what the mute
    /// needs; `settle_ms` of quiet is the other half.
    pub fn ack(&self, workflow_id: &str, trigger_id: &str) {
        let registrations = self.registrations.lock();
        let Some(registration) = registrations.get(trigger_id) else {
            return;
        };
        if registration.workflow_id != workflow_id {
            return;
        }
        registration.shared.lock().acked = true;
    }

    /// Stop and forget a watch. Idempotent.
    pub fn remove(&self, trigger_id: &str) -> bool {
        self.registrations.lock().remove(trigger_id).is_some()
    }

    /// Drop every registration owned by a workflow (its definition changed).
    pub fn remove_workflow(&self, workflow_id: &str) {
        self.registrations
            .lock()
            .retain(|_, registration| registration.workflow_id != workflow_id);
    }

    /// Test-only: read a registration's phase.
    #[cfg(test)]
    pub fn phase(&self, trigger_id: &str) -> Option<WatchPhase> {
        self.registrations
            .lock()
            .get(trigger_id)
            .map(|r| r.shared.lock().phase)
    }

    /// Test-only: read a registration's suppressed count.
    #[cfg(test)]
    pub fn suppressed(&self, trigger_id: &str) -> Option<u64> {
        self.registrations
            .lock()
            .get(trigger_id)
            .map(|r| r.shared.lock().suppressed)
    }

    /// Emit one catch-up event when the tree changed while the process was
    /// down. Never a per-file storm: one event carrying a count.
    ///
    /// The cursor is invalidated by a changed root, because comparing one
    /// tree's mtimes against another tree's cursor is meaningless.
    pub fn catch_up(
        &self,
        trigger_id: &str,
        cursor: Option<(String, i64)>,
        emitter: Arc<dyn TriggerEmitter>,
    ) -> Option<i64> {
        let registrations = self.registrations.lock();
        let registration = registrations.get(trigger_id)?;
        if !registration.config.catch_up_on_start {
            return None;
        }
        let root_str = registration.config.root.to_string_lossy().into_owned();
        let since = match cursor {
            Some((cursor_root, at)) if cursor_root == root_str => at,
            // No cursor, or one for a different root: nothing to compare to.
            _ => return Some(now_ms()),
        };

        let changed = count_changed_since(&registration.config, since);
        if changed > 0 {
            emitter.emit(TriggerEvent {
                workflow_id: registration.workflow_id.clone(),
                kind: "trigger.file.watch".into(),
                trigger_id: Some(registration.trigger_id.clone()),
                payload: json!({
                    "root": root_str,
                    "eventKind": "modified",
                    "suppressedSince": 0,
                    "catchUp": true,
                    "changedCount": changed,
                    "since": since,
                }),
                origin_at: now_ms(),
                binding: registration.binding.clone(),
            });
        }
        Some(now_ms())
    }
}

/// Walk the root once and count entries modified after `since`.
///
/// Bounded by `CATCH_UP_MAX_ENTRIES` so a cold start on a huge tree cannot
/// stall boot. Applies the same include, ignore and gitignore filters the live
/// watcher does, so a catch-up cannot report churn the watcher would have
/// dropped.
fn count_changed_since(config: &FileWatchConfig, since: i64) -> u64 {
    let gitignore = if config.respect_gitignore {
        let mut builder = ignore::gitignore::GitignoreBuilder::new(&config.root);
        let _ = builder.add(config.root.join(".gitignore"));
        builder.build().ok()
    } else {
        None
    };

    let mut walker = ignore::WalkBuilder::new(&config.root);
    walker
        .git_ignore(config.respect_gitignore)
        .git_global(false)
        .git_exclude(config.respect_gitignore)
        .hidden(false)
        .max_depth(if config.recursive { None } else { Some(1) });

    let mut changed = 0u64;
    let mut seen = 0usize;
    for entry in walker.build().flatten() {
        seen += 1;
        if seen > CATCH_UP_MAX_ENTRIES {
            break;
        }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            continue;
        }
        if !path_matches(&config.root, config, gitignore.as_ref(), path, false) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let mtime = modified
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if mtime > since {
            changed += 1;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::triggers::cron_daemon::RecordingEmitter;

    fn config(root: PathBuf) -> FileWatchConfig {
        FileWatchConfig {
            root,
            globs: Vec::new(),
            ignore_globs: Vec::new(),
            respect_gitignore: true,
            events: Vec::new(),
            recursive: true,
            debounce_ms: 20,
            settle_ms: 20,
            catch_up_on_start: false,
            max_fires_per_minute: 30,
            mute_timeout_ms: 60_000,
        }
    }

    fn input(root: &Path) -> RegisterTriggerInput {
        RegisterTriggerInput {
            trigger_id: "t1".into(),
            workflow_id: "wf1".into(),
            kind: "trigger.file.watch".into(),
            enabled: true,
            file_watch_root: Some(root.to_string_lossy().into_owned()),
            file_watch_debounce_ms: Some(50),
            file_watch_settle_ms: Some(50),
            ..Default::default()
        }
    }

    #[test]
    fn glob_star_does_not_span_separators_but_doublestar_does() {
        assert!(glob_matches("*.ts", "a.ts"));
        assert!(!glob_matches("*.ts", "src/a.ts"));
        assert!(glob_matches("src/**/*.ts", "src/deep/nested/a.ts"));
        // `**/` also matches zero segments, so a pattern anchored with it
        // still finds a file at the root.
        assert!(glob_matches("**/a.ts", "a.ts"));
        assert!(glob_matches("**", "anything/at/all"));
        assert!(!glob_matches("src/*.ts", "src/deep/a.ts"));
        assert!(glob_matches("a?c.ts", "abc.ts"));
        assert!(!glob_matches("a?c.ts", "a/c.ts"));
    }

    #[test]
    fn git_internals_never_match() {
        let root = PathBuf::from("/repo");
        let cfg = config(root.clone());
        // `.git` churns on every command and is never what an author means.
        assert!(!path_matches(&root, &cfg, None, Path::new("/repo/.git/index"), false));
        assert!(!path_matches(&root, &cfg, None, Path::new("/repo/.git"), true));
        assert!(path_matches(&root, &cfg, None, Path::new("/repo/src/a.ts"), false));
    }

    #[test]
    fn a_path_outside_the_root_is_not_ours() {
        let root = PathBuf::from("/repo");
        let cfg = config(root.clone());
        assert!(!path_matches(&root, &cfg, None, Path::new("/elsewhere/a.ts"), false));
        // The root itself is not a change under the root.
        assert!(!path_matches(&root, &cfg, None, Path::new("/repo"), true));
    }

    #[test]
    fn include_and_ignore_globs_compose() {
        let root = PathBuf::from("/repo");
        let mut cfg = config(root.clone());
        cfg.globs = vec!["src/**/*.ts".into()];
        cfg.ignore_globs = vec!["src/**/*.test.ts".into()];
        assert!(path_matches(&root, &cfg, None, Path::new("/repo/src/a.ts"), false));
        assert!(!path_matches(&root, &cfg, None, Path::new("/repo/src/a.test.ts"), false));
        assert!(!path_matches(&root, &cfg, None, Path::new("/repo/docs/a.md"), false));
    }

    #[test]
    fn an_overbroad_root_is_refused_at_registration() {
        // The failure would otherwise arrive far from its cause: a
        // max_user_watches exhaustion on Linux, an FSEvents firehose on macOS.
        assert!(reject_overbroad_root(Path::new("/")).is_err());
        if let Some(home) = dirs_home() {
            assert!(reject_overbroad_root(&home).is_err());
            assert!(reject_overbroad_root(&home.join("project")).is_ok());
        }
    }

    #[test]
    fn a_symlinked_root_is_canonicalized_so_events_still_match() {
        // `notify` reports the RESOLVED path, and `path_matches` strips the
        // root as a prefix. A root left uncanonicalized therefore matches
        // nothing and fails completely silently, which is how this shipped
        // broken in `cognia-git` once already. On macOS the temp dir is itself
        // a symlink, so this is not a hypothetical.
        let real = std::env::temp_dir().join(format!("cognia-fw-real-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&real).expect("temp dir");
        let link = std::env::temp_dir().join(format!("cognia-fw-link-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        #[cfg(not(unix))]
        let link = real.clone();

        let mut i = input(&link);
        i.file_watch_root = Some(link.to_string_lossy().into_owned());
        let cfg = FileWatchConfig::from_input(&i).expect("config");

        let canonical_real = std::fs::canonicalize(&real).unwrap_or(real.clone());
        assert!(path_matches(
            &cfg.root,
            &cfg,
            None,
            &canonical_real.join("a.txt"),
            false
        ));

        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&real);
    }

    #[test]
    fn a_relative_root_is_refused() {
        let mut i = input(Path::new("/tmp"));
        i.file_watch_root = Some("relative/path".into());
        assert!(FileWatchConfig::from_input(&i).is_err());
    }

    #[test]
    fn windows_are_clamped_rather_than_trusted() {
        let mut i = input(Path::new("/tmp"));
        i.file_watch_debounce_ms = Some(0);
        i.file_watch_max_fires_per_minute = Some(0);
        let cfg = FileWatchConfig::from_input(&i).expect("config");
        assert_eq!(cfg.debounce_ms, 50);
        assert_eq!(cfg.max_fires_per_minute, 1);
    }

    #[test]
    fn event_kinds_map_to_the_authored_vocabulary() {
        use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
        use notify::EventKind;
        assert_eq!(event_kind_name(&EventKind::Create(CreateKind::File)), "created");
        assert_eq!(event_kind_name(&EventKind::Remove(RemoveKind::File)), "removed");
        assert_eq!(
            event_kind_name(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            "renamed"
        );
        assert_eq!(event_kind_name(&EventKind::Modify(ModifyKind::Any)), "modified");
    }

    #[test]
    fn the_token_bucket_caps_fires_per_minute_and_refills() {
        let mut shared = Shared::new();
        let start = 1_000_000i64;
        assert!(shared.take_token(start, 2));
        assert!(shared.take_token(start + 10, 2));
        assert!(!shared.take_token(start + 20, 2));
        // A minute later the window has rolled.
        assert!(shared.take_token(start + 60_001, 2));
    }

    #[test]
    fn a_mute_needs_both_an_ack_and_quiet() {
        let mut shared = Shared::new();
        shared.phase = WatchPhase::Muted;
        shared.muted_at = 1_000;
        shared.last_event_at = 1_000;

        // Quiet but not acked: the run is still going.
        assert_eq!(shared.mute_may_lift(5_000, 1_000, 60_000), Some(false));
        shared.acked = true;
        // Acked but the tree is still settling: its writes are still landing.
        shared.last_event_at = 4_900;
        assert_eq!(shared.mute_may_lift(5_000, 1_000, 60_000), Some(false));
        // Acked and quiet.
        assert_eq!(shared.mute_may_lift(6_000, 1_000, 60_000), Some(true));
    }

    #[test]
    fn a_lost_ack_re_arms_late_rather_than_bricking_the_trigger() {
        let mut shared = Shared::new();
        shared.phase = WatchPhase::Muted;
        shared.muted_at = 1_000;
        shared.last_event_at = 1_000;
        assert_eq!(shared.mute_may_lift(60_999, 1_000, 60_000), Some(false));
        assert_eq!(shared.mute_may_lift(61_001, 1_000, 60_000), Some(true));
    }

    #[test]
    fn a_registration_that_is_not_muted_has_nothing_to_lift() {
        let shared = Shared::new();
        assert_eq!(shared.mute_may_lift(1_000, 1_000, 60_000), None);
    }

    #[tokio::test]
    async fn a_write_fires_once_and_then_the_watch_goes_quiet() {
        let dir = std::env::temp_dir().join(format!("cognia-fw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let recorder = RecordingEmitter::default();
        let daemon = FileWatchDaemon::new();
        daemon
            .upsert(&input(&dir), Arc::new(recorder.clone()))
            .expect("register");

        std::fs::write(dir.join("a.txt"), "one").expect("write");
        wait_for(|| recorder.fired.lock().len() == 1).await;
        assert_eq!(recorder.fired.lock().len(), 1);
        assert_eq!(daemon.phase("t1"), Some(WatchPhase::Muted));

        // Everything a run writes lands inside the mute window. The assertion
        // is ZERO, not "fewer": that difference is what makes the self-feed
        // guarantee structural rather than statistical.
        for i in 0..5 {
            std::fs::write(dir.join(format!("run-{i}.txt")), "written by the run")
                .expect("write");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(recorder.fired.lock().len(), 1);
        assert!(daemon.suppressed("t1").unwrap_or(0) > 0);

        // Acking alone is not enough while writes are still landing, but once
        // the tree settles the watch re-arms and the next write fires again.
        daemon.ack("wf1", "t1");
        wait_for(|| daemon.phase("t1") == Some(WatchPhase::Armed)).await;
        std::fs::write(dir.join("b.txt"), "two").expect("write");
        wait_for(|| recorder.fired.lock().len() == 2).await;
        assert_eq!(recorder.fired.lock().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_ack_from_another_workflow_is_ignored() {
        let dir = std::env::temp_dir().join(format!("cognia-fw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let recorder = RecordingEmitter::default();
        let daemon = FileWatchDaemon::new();
        daemon
            .upsert(&input(&dir), Arc::new(recorder.clone()))
            .expect("register");
        std::fs::write(dir.join("a.txt"), "one").expect("write");
        wait_for(|| daemon.phase("t1") == Some(WatchPhase::Muted)).await;

        daemon.ack("someone-else", "t1");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(daemon.phase("t1"), Some(WatchPhase::Muted));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_disabled_registration_removes_rather_than_watches() {
        let dir = std::env::temp_dir().join(format!("cognia-fw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let daemon = FileWatchDaemon::new();
        let recorder = RecordingEmitter::default();
        daemon
            .upsert(&input(&dir), Arc::new(recorder.clone()))
            .expect("register");
        assert_eq!(daemon.len(), 1);

        let mut disabled = input(&dir);
        disabled.enabled = false;
        daemon.upsert(&disabled, Arc::new(recorder)).expect("disable");
        assert_eq!(daemon.len(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_workflow_drops_only_its_own_watches() {
        let dir = std::env::temp_dir().join(format!("cognia-fw-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let daemon = FileWatchDaemon::new();
        let recorder = RecordingEmitter::default();
        daemon
            .upsert(&input(&dir), Arc::new(recorder.clone()))
            .expect("a");
        let mut other = input(&dir);
        other.trigger_id = "t2".into();
        other.workflow_id = "wf2".into();
        daemon.upsert(&other, Arc::new(recorder)).expect("b");
        assert_eq!(daemon.len(), 2);

        daemon.remove_workflow("wf1");
        assert_eq!(daemon.len(), 1);
        assert!(daemon.phase("t2").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_root_is_refused_rather_than_silently_watching_nothing() {
        let daemon = FileWatchDaemon::new();
        let missing = std::env::temp_dir().join("cognia-fw-does-not-exist-ever");
        let _ = std::fs::remove_dir_all(&missing);
        let err = daemon
            .upsert(&input(&missing), Arc::new(RecordingEmitter::default()))
            .expect_err("missing root");
        assert!(err.contains("does not exist"));
    }

    /// Poll until `check` holds or the budget runs out. Filesystem events are
    /// inherently timing-dependent, so a fixed sleep would be flaky in both
    /// directions.
    async fn wait_for(check: impl Fn() -> bool) {
        for _ in 0..80 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
