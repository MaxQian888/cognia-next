use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{mpsc, Arc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const DEBOUNCE: Duration = Duration::from_millis(200);
const ECHO_TTL: Duration = Duration::from_secs(1);
const MAX_EVENT_PATH_BYTES: usize = 24 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceEventKind {
    Created,
    Modified,
    Deleted,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEventChange {
    pub path: String,
    pub kind: ResourceEventKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspaceResourceEvent {
    pub task_id: String,
    pub run_id: String,
    pub revision: u64,
    pub changes: Vec<ResourceEventChange>,
    pub overflow: bool,
    pub resync_required: bool,
}

pub trait TaskWorkspaceEventSink: Send + Sync + 'static {
    fn emit(&self, event: TaskWorkspaceResourceEvent);
}

enum WatchMessage {
    Event(Result<Event, String>),
    Stop,
}

struct Registration {
    root: PathBuf,
    sender: mpsc::Sender<WatchMessage>,
    watcher: RecommendedWatcher,
    worker: Option<JoinHandle<()>>,
    echoes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

pub struct WatchManager {
    registrations: Mutex<HashMap<String, Registration>>,
}

impl WatchManager {
    pub fn new() -> Self {
        Self {
            registrations: Mutex::new(HashMap::new()),
        }
    }

    pub fn start(
        &self,
        task_id: &str,
        run_id: &str,
        root: &Path,
        sink: Arc<dyn TaskWorkspaceEventSink>,
    ) -> Result<(), String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("canonicalize watch root {}: {error}", root.display()))?;
        let mut registrations = self.registrations.lock();
        if registrations.contains_key(run_id) {
            return Ok(());
        }
        let (sender, receiver) = mpsc::channel();
        let callback_sender = sender.clone();
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let event = event.map_err(|error| error.to_string());
            let _ = callback_sender.send(WatchMessage::Event(event));
        })
        .map_err(|error| format!("create workspace watcher: {error}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|error| format!("watch {}: {error}", root.display()))?;
        let echoes = Arc::new(Mutex::new(HashMap::new()));
        let worker_echoes = Arc::clone(&echoes);
        let worker_root = root.clone();
        let worker_task_id = task_id.to_string();
        let worker_run_id = run_id.to_string();
        let worker = thread::Builder::new()
            .name(format!("task-workspace-watch-{run_id}"))
            .spawn(move || {
                watch_loop(
                    receiver,
                    &worker_root,
                    &worker_task_id,
                    &worker_run_id,
                    sink,
                    worker_echoes,
                )
            })
            .map_err(|error| format!("start workspace watcher: {error}"))?;
        registrations.insert(
            run_id.to_string(),
            Registration {
                root,
                sender,
                watcher,
                worker: Some(worker),
                echoes,
            },
        );
        Ok(())
    }

    pub fn mark_echo(&self, run_id: &str, rel_path: &str) -> Result<(), String> {
        validate_relative(rel_path)?;
        let registrations = self.registrations.lock();
        let registration = registrations
            .get(run_id)
            .ok_or_else(|| format!("task run is not watched: {run_id}"))?;
        registration
            .echoes
            .lock()
            .insert(registration.root.join(rel_path), Instant::now());
        Ok(())
    }

    pub fn stop(&self, run_id: &str) -> Result<(), String> {
        let mut registration = self
            .registrations
            .lock()
            .remove(run_id)
            .ok_or_else(|| format!("task run is not watched: {run_id}"))?;
        let _ = registration.watcher.unwatch(&registration.root);
        let _ = registration.sender.send(WatchMessage::Stop);
        drop(registration.watcher);
        if let Some(worker) = registration.worker.take() {
            worker
                .join()
                .map_err(|_| format!("workspace watcher thread panicked: {run_id}"))?;
        }
        Ok(())
    }
}

impl Default for WatchManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for WatchManager {
    fn drop(&mut self) {
        let run_ids = self
            .registrations
            .get_mut()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for run_id in run_ids {
            let _ = self.stop(&run_id);
        }
    }
}

fn watch_loop(
    receiver: mpsc::Receiver<WatchMessage>,
    root: &Path,
    task_id: &str,
    run_id: &str,
    sink: Arc<dyn TaskWorkspaceEventSink>,
    echoes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
) {
    let mut revision = 0_u64;
    while let Ok(message) = receiver.recv() {
        let mut messages = vec![message];
        let deadline = Instant::now() + DEBOUNCE;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match receiver.recv_timeout(deadline - now) {
                Ok(message) => messages.push(message),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if messages
            .iter()
            .any(|message| matches!(message, WatchMessage::Stop))
        {
            return;
        }
        let mut changes = BTreeMap::new();
        let mut overflow = false;
        let mut path_bytes = 0_usize;
        let now = Instant::now();
        {
            let mut echoes = echoes.lock();
            echoes.retain(|_, written| now.duration_since(*written) <= ECHO_TTL);
            for message in messages {
                match message {
                    WatchMessage::Event(Ok(event)) => {
                        let kind = map_kind(&event.kind);
                        for path in event.paths {
                            if echoes
                                .get(&path)
                                .is_some_and(|written| now.duration_since(*written) <= ECHO_TTL)
                            {
                                continue;
                            }
                            let Ok(relative) = path.strip_prefix(root) else {
                                continue;
                            };
                            let rel_path = relative.to_string_lossy().replace('\\', "/");
                            if rel_path.is_empty() || ignored(root, relative) {
                                continue;
                            }
                            path_bytes = path_bytes.saturating_add(rel_path.len() + 24);
                            if path_bytes > MAX_EVENT_PATH_BYTES {
                                overflow = true;
                                continue;
                            }
                            changes.insert(rel_path, kind);
                        }
                    }
                    WatchMessage::Event(Err(_)) => overflow = true,
                    WatchMessage::Stop => return,
                }
            }
        }
        if changes.is_empty() && !overflow {
            continue;
        }
        revision = revision.saturating_add(1);
        sink.emit(TaskWorkspaceResourceEvent {
            task_id: task_id.to_string(),
            run_id: run_id.to_string(),
            revision,
            changes: changes
                .into_iter()
                .map(|(path, kind)| ResourceEventChange { path, kind })
                .collect(),
            overflow,
            resync_required: overflow,
        });
    }
}

fn map_kind(kind: &EventKind) -> ResourceEventKind {
    match kind {
        EventKind::Create(_) => ResourceEventKind::Created,
        EventKind::Modify(_) => ResourceEventKind::Modified,
        EventKind::Remove(_) => ResourceEventKind::Deleted,
        _ => ResourceEventKind::Any,
    }
}

fn ignored(root: &Path, relative: &Path) -> bool {
    if relative.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | "node_modules" | ".next" | "dist" | "target")
        )
    }) || relative
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".cognia-upload-") && name.ends_with(".tmp"))
    {
        return true;
    }
    if root.join(".git").exists() {
        return Command::new("git")
            .args(["-C"])
            .arg(root)
            .args(["check-ignore", "-q", "--"])
            .arg(relative)
            .status()
            .is_ok_and(|status| status.success());
    }
    ignore_matchers(root, relative)
        .iter()
        .any(|(base, matcher)| {
            relative
                .strip_prefix(base)
                .is_ok_and(|path| matcher.matched_path_or_any_parents(path, false).is_ignore())
        })
}

fn ignore_matchers(root: &Path, relative: &Path) -> Vec<(PathBuf, Gitignore)> {
    let mut out = Vec::new();
    add_ignore_matcher(&mut out, root, Path::new(""));
    let mut base = PathBuf::new();
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    for component in parent.components() {
        base.push(component.as_os_str());
        add_ignore_matcher(&mut out, &root.join(&base), &base);
    }
    out
}

fn add_ignore_matcher(out: &mut Vec<(PathBuf, Gitignore)>, directory: &Path, base: &Path) {
    let ignore_path = directory.join(".gitignore");
    if !ignore_path.is_file() {
        return;
    }
    let mut builder = GitignoreBuilder::new(directory);
    if builder.add(ignore_path).is_none() {
        if let Ok(matcher) = builder.build() {
            out.push((base.to_path_buf(), matcher));
        }
    }
}

fn validate_relative(rel_path: &str) -> Result<(), String> {
    let path = Path::new(rel_path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("path escapes workspace: {rel_path}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::{fs, sync::mpsc, time::Duration};
    use tempfile::TempDir;

    struct ChannelSink(Mutex<mpsc::Sender<TaskWorkspaceResourceEvent>>);

    impl TaskWorkspaceEventSink for ChannelSink {
        fn emit(&self, event: TaskWorkspaceResourceEvent) {
            let _ = self.0.lock().send(event);
        }
    }

    #[test]
    fn batches_changes_and_filters_ignored_paths() {
        let root = TempDir::new().unwrap();
        fs::write(root.path().join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(root.path().join("ignored")).unwrap();
        let (tx, rx) = mpsc::channel();
        let manager = WatchManager::new();
        manager
            .start(
                "task-1",
                "run-1",
                root.path(),
                Arc::new(ChannelSink(Mutex::new(tx))),
            )
            .unwrap();

        fs::write(root.path().join("visible.txt"), "one").unwrap();
        fs::write(root.path().join("visible.txt"), "two").unwrap();
        fs::write(root.path().join("ignored/hidden.txt"), "hidden").unwrap();

        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event.task_id, "task-1");
        assert_eq!(event.run_id, "run-1");
        assert_eq!(event.revision, 1);
        assert_eq!(event.changes.len(), 1, "{event:?}");
        assert_eq!(event.changes[0].path, "visible.txt");
        assert!(!event.overflow);
        manager.stop("run-1").unwrap();
    }

    #[test]
    fn suppresses_recent_service_write_echo() {
        let root = TempDir::new().unwrap();
        let (tx, rx) = mpsc::channel();
        let manager = WatchManager::new();
        manager
            .start(
                "task-1",
                "run-1",
                root.path(),
                Arc::new(ChannelSink(Mutex::new(tx))),
            )
            .unwrap();
        manager.mark_echo("run-1", "echo.txt").unwrap();
        fs::write(root.path().join("echo.txt"), "echo").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
        manager.stop("run-1").unwrap();
    }
}
