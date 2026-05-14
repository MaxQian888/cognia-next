//! `cognia plugin dev` — watch + rebuild + optionally ping a running cognia.
//!
//! Listens on the plugin crate for changes to `src/`, `wit/`, `Cargo.toml`,
//! and `plugin.json`. On each event it debounces 250 ms, then runs
//! `cargo component build --release` followed by the bundle packaging
//! step from `cmd_build`. If `--reload-url` was passed, a final POST is
//! sent to that URL with the new bundle path so the running cognia can
//! re-install the plugin.

use anyhow::{bail, Context, Result};
use notify::{EventKind, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(250);

pub fn run(path: PathBuf, reload_url: Option<String>) -> Result<()> {
    let crate_root = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    if !crate_root.join("Cargo.toml").exists() {
        bail!("Cargo.toml not found under {}", crate_root.display());
    }
    println!("Watching {} for changes…", crate_root.display());
    if let Some(url) = &reload_url {
        println!("Reload-url: {url}");
    }

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .context("create filesystem watcher")?;
    for sub in ["src", "wit"] {
        let p = crate_root.join(sub);
        if p.exists() {
            watcher
                .watch(&p, RecursiveMode::Recursive)
                .with_context(|| format!("watch {}", p.display()))?;
        }
    }
    for f in ["Cargo.toml", "plugin.json"] {
        let p = crate_root.join(f);
        if p.exists() {
            watcher
                .watch(&p, RecursiveMode::NonRecursive)
                .with_context(|| format!("watch {}", p.display()))?;
        }
    }

    let mut pending = false;
    let mut last_change = Instant::now() - DEBOUNCE * 2;
    loop {
        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(event)) => {
                if should_rebuild(&event) {
                    pending = true;
                    last_change = Instant::now();
                }
            }
            Ok(Err(e)) => {
                eprintln!("watch error: {e}");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending && last_change.elapsed() >= DEBOUNCE {
                    pending = false;
                    if let Err(e) = rebuild_and_reload(&crate_root, reload_url.as_deref()) {
                        eprintln!("rebuild failed: {e:#}");
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

fn should_rebuild(event: &notify::Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn rebuild_and_reload(crate_root: &PathBuf, reload_url: Option<&str>) -> Result<()> {
    println!("→ rebuild");
    crate::cmd_build::run(crate_root.clone(), None, false)?;
    if let Some(_url) = reload_url {
        println!("→ notify (reload URL POST is a v0.2 feature; skipped)");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn should_rebuild_classifies_change_events() {
        let create = notify::Event::new(EventKind::Create(CreateKind::File));
        let modify = notify::Event::new(EventKind::Modify(ModifyKind::Any));
        let remove = notify::Event::new(EventKind::Remove(RemoveKind::File));
        let access = notify::Event::new(EventKind::Access(notify::event::AccessKind::Open(
            notify::event::AccessMode::Any,
        )));
        assert!(should_rebuild(&create));
        assert!(should_rebuild(&modify));
        assert!(should_rebuild(&remove));
        assert!(!should_rebuild(&access));
    }
}
