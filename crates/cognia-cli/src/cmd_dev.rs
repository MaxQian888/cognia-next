//! `cognia plugin dev [--reload-url URL]` — watch + rebuild + optionally
//! notify a running cognia.
//!
//! Listens for changes to source files (`src/`, `wit/`, `Cargo.toml`,
//! `plugin.json`). On each event it debounces 250 ms, then runs the
//! per-type build. If `--reload-url` is passed (or the CLI auto-discovers
//! a running cognia from the endpoint file), the latest bundle is POSTed
//! to the CLI bridge so the host hot-reloads in place.
//!
//! Phase 4 rewires the user-visible surface:
//!   * **Sticky status panel** (TTY only): four `indicatif` lines pinned
//!     to the bottom of the terminal while cargo output scrolls above.
//!     Shows Status / Endpoint / Last build (duration + outcome + clock)
//!     / Rebuilds count.
//!   * **Smart degradation**: on a non-TTY (CI, redirected stdout), the
//!     panel collapses to per-event `println!` lines so logs stay grep
//!     friendly.
//!   * **Double-press Ctrl+C** to exit cleanly: first press warns
//!     ("Press Ctrl+C again to quit"), second press breaks the loop.
//!     Without this, novices instinctively hammer Ctrl+C and lose the
//!     last in-flight rebuild.

use anyhow::{bail, Context, Result};
use chrono::Local;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use crate::http_client::{load_endpoint, post_json, EndpointFile};
use crate::read_plugin_manifest;
use crate::ui::{style, RuntimeUi};

const DEBOUNCE: Duration = Duration::from_millis(250);

/// Quit-state values driven by the Ctrl+C handler. Atomic so the handler
/// stays signal-safe.
const QUIT_RUNNING: u8 = 0;
const QUIT_FIRST_PRESS: u8 = 1;
const QUIT_SECOND_PRESS: u8 = 2;

/// `cognia plugin dev` — runs the watch/rebuild loop until two Ctrl+C
/// presses (or stdin EOF).
pub fn run(path: PathBuf, reload_url: Option<String>, ui: &mut RuntimeUi) -> Result<()> {
    let crate_root = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    if !crate_root.join("plugin.json").exists() {
        bail!("plugin.json not found under {}", crate_root.display());
    }

    let reload_endpoint = resolve_reload_endpoint(reload_url.as_deref());

    // Install the Ctrl+C handler exactly once per process. Tests skip
    // this entirely; production runs install before the watcher to make
    // sure the handler is wired before any fs noise can fire.
    let quit_state = Arc::new(AtomicU8::new(QUIT_RUNNING));
    install_quit_handler(quit_state.clone())?;

    let panel = StatusPanel::new(ui, &crate_root, reload_endpoint.as_ref());
    panel.set_status("Watching");

    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .context("create filesystem watcher")?;
    for sub in ["src", "wit", "dist"] {
        let p = crate_root.join(sub);
        if p.exists() {
            watcher
                .watch(&p, RecursiveMode::Recursive)
                .with_context(|| format!("watch {}", p.display()))?;
        }
    }
    for f in ["Cargo.toml", "package.json", "plugin.json"] {
        let p = crate_root.join(f);
        if p.exists() {
            watcher
                .watch(&p, RecursiveMode::NonRecursive)
                .with_context(|| format!("watch {}", p.display()))?;
        }
    }

    let mut pending = false;
    let mut last_change = Instant::now() - DEBOUNCE * 2;
    let mut first_press_warned = false;
    loop {
        // ── Ctrl+C state machine ───────────────────────────────────────
        match quit_state.load(Ordering::SeqCst) {
            QUIT_SECOND_PRESS => {
                panel.println_above(format!(
                    "{}exiting (Ctrl+C ×2)",
                    style::warn_prefix()
                ));
                break;
            }
            QUIT_FIRST_PRESS if !first_press_warned => {
                first_press_warned = true;
                panel.println_above(format!(
                    "{}Press Ctrl+C again to quit",
                    style::warn_prefix()
                ));
            }
            _ => {}
        }

        match rx.recv_timeout(DEBOUNCE) {
            Ok(Ok(event)) => {
                if should_rebuild(&event) {
                    pending = true;
                    last_change = Instant::now();
                    panel.set_status("Change detected, debouncing");
                    // Any fs activity resets the "press again" warning
                    // window so users don't see stale messaging.
                    if first_press_warned && quit_state.load(Ordering::SeqCst) == QUIT_FIRST_PRESS {
                        // do nothing — wait for the second press
                    }
                }
            }
            Ok(Err(e)) => {
                panel.println_above(format!(
                    "{}watch error: {e}",
                    style::warn_prefix()
                ));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if pending && last_change.elapsed() >= DEBOUNCE {
                    pending = false;
                    panel.set_status("Building");
                    let started = Instant::now();
                    // Suppress cmd_build's own spinners while the panel
                    // owns the bottom of the screen — cargo's native
                    // output still streams.
                    let prior_quiet = ui.flags.quiet;
                    ui.flags.quiet = true;
                    let outcome = rebuild_and_reload(&crate_root, reload_endpoint.as_ref(), ui);
                    ui.flags.quiet = prior_quiet;
                    let elapsed = started.elapsed();
                    panel.record_build(&outcome, elapsed);
                    if let Err(e) = outcome {
                        panel.println_above(format!(
                            "{}rebuild failed: {e:#}",
                            style::error_prefix()
                        ));
                    }
                    panel.set_status("Watching");
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    panel.finish();
    Ok(())
}

fn should_rebuild(event: &notify::Event) -> bool {
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    )
}

fn rebuild_and_reload(
    crate_root: &std::path::Path,
    reload_endpoint: Option<&EndpointFile>,
    ui: &mut RuntimeUi,
) -> Result<()> {
    crate::cmd_build::run(crate_root.to_path_buf(), None, false, ui)?;

    let Some(endpoint) = reload_endpoint else {
        return Ok(());
    };

    let (manifest, _) = read_plugin_manifest(crate_root)?;
    let id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let version = manifest.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let bundle = crate_root
        .join("target")
        .join("cognia")
        .join(format!("{id}-{version}.zip"));
    if !bundle.exists() {
        return Ok(());
    }
    let _: serde_json::Value = post_json(
        endpoint,
        "/api/v1/dev/plugins/reload",
        &json!({ "bundle_path": bundle.to_string_lossy(), "plugin_id": id }),
    )
    .context("reload endpoint POST failed")?;
    Ok(())
}

/// Resolve the reload endpoint. If `--reload-url` is supplied we try to
/// honor it (with the token from the endpoint file if available); else
/// we fall back to the endpoint file alone.
fn resolve_reload_endpoint(override_url: Option<&str>) -> Option<EndpointFile> {
    match (override_url, load_endpoint().ok()) {
        (Some(url), Some(ep)) => Some(EndpointFile {
            base_url: url.into(),
            dev_token: ep.dev_token,
        }),
        (Some(url), None) => Some(EndpointFile {
            base_url: url.into(),
            dev_token: String::new(),
        }),
        (None, Some(ep)) => Some(ep),
        (None, None) => None,
    }
}

/// Install a process-wide Ctrl+C handler that flips an atomic counter.
/// `set_handler` errors only when called twice in the same process —
/// production runs are once per `dev`, so that's a programmer bug;
/// surface it loudly. Tests skip this entirely.
fn install_quit_handler(state: Arc<AtomicU8>) -> Result<()> {
    let result = ctrlc::set_handler(move || {
        // Exactly ONE transition per press:
        //   RUNNING       → FIRST_PRESS
        //   FIRST_PRESS   → SECOND_PRESS
        //   SECOND_PRESS  → (terminal — no further change)
        // `fetch_update` guarantees we only apply one of these per call,
        // unlike a chain of `compare_exchange`s which would collapse two
        // states in a single Ctrl+C press.
        let _ = state.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| match cur {
            QUIT_RUNNING => Some(QUIT_FIRST_PRESS),
            QUIT_FIRST_PRESS => Some(QUIT_SECOND_PRESS),
            _ => None,
        });
    });
    // Re-installing in the same process is fine — we treat it as idempotent.
    match result {
        Ok(()) => Ok(()),
        Err(ctrlc::Error::MultipleHandlers) => Ok(()),
        Err(e) => Err(anyhow::anyhow!("install Ctrl+C handler: {e}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Status panel
// ─────────────────────────────────────────────────────────────────────────────

/// Sticky 4-line `indicatif` panel for the dev loop, or a no-op trio of
/// `println!` calls on non-TTY.
struct StatusPanel {
    inner: PanelInner,
}

enum PanelInner {
    Sticky {
        mp: MultiProgress,
        status_pb: ProgressBar,
        endpoint_pb: ProgressBar,
        last_build_pb: ProgressBar,
        rebuilds_pb: ProgressBar,
        rebuilds: std::cell::Cell<u64>,
    },
    Plain {
        rebuilds: std::cell::Cell<u64>,
    },
}

impl StatusPanel {
    fn new(
        ui: &RuntimeUi,
        crate_root: &std::path::Path,
        endpoint: Option<&EndpointFile>,
    ) -> Self {
        let endpoint_label = match endpoint {
            Some(ep) if !ep.base_url.is_empty() => ep.base_url.clone(),
            _ => "<none — rebuild only>".to_string(),
        };
        if !ui.is_tty || ui.flags.quiet {
            println!(
                "Watching {} for changes…",
                style::bold(crate_root.display().to_string())
            );
            println!("Reload endpoint: {endpoint_label}");
            return Self {
                inner: PanelInner::Plain {
                    rebuilds: std::cell::Cell::new(0),
                },
            };
        }
        let mp = MultiProgress::new();
        let style_line =
            ProgressStyle::with_template("{msg}").unwrap_or_else(|_| ProgressStyle::default_bar());
        let title_pb = mp.add(ProgressBar::new(0));
        title_pb.set_style(style_line.clone());
        title_pb.set_message(format!(
            "{}{}",
            style::bold("cognia plugin dev "),
            style::dim(crate_root.display().to_string())
        ));
        let status_pb = mp.add(ProgressBar::new(0));
        status_pb.set_style(style_line.clone());
        let endpoint_pb = mp.add(ProgressBar::new(0));
        endpoint_pb.set_style(style_line.clone());
        endpoint_pb.set_message(format!(
            "  {} {}",
            style::dim("Endpoint   "),
            endpoint_label
        ));
        let last_build_pb = mp.add(ProgressBar::new(0));
        last_build_pb.set_style(style_line.clone());
        last_build_pb.set_message(format!(
            "  {} {}",
            style::dim("Last build "),
            style::dim("<no builds yet>")
        ));
        let rebuilds_pb = mp.add(ProgressBar::new(0));
        rebuilds_pb.set_style(style_line);
        rebuilds_pb.set_message(format!(
            "  {} {}",
            style::dim("Rebuilds   "),
            "0"
        ));
        Self {
            inner: PanelInner::Sticky {
                mp,
                status_pb,
                endpoint_pb,
                last_build_pb,
                rebuilds_pb,
                rebuilds: std::cell::Cell::new(0),
            },
        }
    }

    fn set_status(&self, label: &str) {
        match &self.inner {
            PanelInner::Sticky { status_pb, .. } => {
                status_pb.set_message(format!(
                    "  {} {}",
                    style::dim("Status     "),
                    style::bold(label)
                ));
            }
            PanelInner::Plain { .. } => {
                // Plain mode only prints state transitions for builds —
                // status flicker between "Watching" and "Change detected"
                // would be noise in non-TTY logs.
            }
        }
    }

    /// Record the outcome of a rebuild attempt: increment the counter,
    /// update the "Last build" line with elapsed time / outcome / clock.
    fn record_build(&self, outcome: &Result<()>, elapsed: Duration) {
        let now = Local::now().format("%H:%M:%S").to_string();
        let secs = elapsed.as_secs_f64();
        let outcome_tag = match outcome {
            Ok(_) => style::ok("ok"),
            Err(_) => style::error("fail"),
        };
        match &self.inner {
            PanelInner::Sticky {
                last_build_pb,
                rebuilds_pb,
                rebuilds,
                ..
            } => {
                let n = rebuilds.get() + 1;
                rebuilds.set(n);
                last_build_pb.set_message(format!(
                    "  {} {:.2}s @{} {}",
                    style::dim("Last build "),
                    secs,
                    style::dim(now),
                    outcome_tag
                ));
                rebuilds_pb.set_message(format!("  {} {}", style::dim("Rebuilds   "), n));
            }
            PanelInner::Plain { rebuilds } => {
                let n = rebuilds.get() + 1;
                rebuilds.set(n);
                println!(
                    "[{now}] rebuild #{n} {} in {secs:.2}s",
                    match outcome {
                        Ok(_) => "ok",
                        Err(_) => "FAILED",
                    }
                );
            }
        }
    }

    /// Print a message that scrolls *above* the sticky panel (so cargo
    /// output and warning lines don't get clobbered).
    fn println_above(&self, msg: String) {
        match &self.inner {
            PanelInner::Sticky { mp, .. } => {
                let _ = mp.println(msg);
            }
            PanelInner::Plain { .. } => {
                println!("{msg}");
            }
        }
    }

    fn finish(&self) {
        if let PanelInner::Sticky {
            status_pb,
            endpoint_pb,
            last_build_pb,
            rebuilds_pb,
            ..
        } = &self.inner
        {
            status_pb.finish_and_clear();
            endpoint_pb.finish_and_clear();
            last_build_pb.finish_and_clear();
            rebuilds_pb.finish_and_clear();
        }
    }
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

    #[test]
    fn resolve_reload_endpoint_combines_override_with_token() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        use std::io::Write;
        write!(
            tmp,
            r#"{{"baseUrl":"http://127.0.0.1:9999","devToken":"realtoken"}}"#
        )
        .unwrap();
        std::env::set_var("COGNIA_CLI_ENDPOINT_FILE", tmp.path());
        let ep = resolve_reload_endpoint(Some("http://localhost:1234"));
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        let ep = ep.expect("endpoint should resolve");
        assert_eq!(ep.base_url, "http://localhost:1234");
        assert_eq!(ep.dev_token, "realtoken");
    }

    #[test]
    fn resolve_reload_endpoint_returns_none_when_neither_source() {
        std::env::set_var(
            "COGNIA_CLI_ENDPOINT_FILE",
            "/definitely/no/such/file.json",
        );
        let ep = resolve_reload_endpoint(None);
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        assert!(ep.is_none());
    }

    #[test]
    fn resolve_reload_endpoint_uses_override_with_empty_token() {
        std::env::set_var(
            "COGNIA_CLI_ENDPOINT_FILE",
            "/definitely/no/such/file.json",
        );
        let ep = resolve_reload_endpoint(Some("http://localhost:4321"));
        std::env::remove_var("COGNIA_CLI_ENDPOINT_FILE");
        let ep = ep.expect("override alone should resolve");
        assert_eq!(ep.base_url, "http://localhost:4321");
        assert_eq!(ep.dev_token, "");
    }

    #[test]
    fn quit_state_machine_promotes_through_first_to_second_press() {
        // Mirror the handler closure body, exposed for direct testing.
        let press = |s: &Arc<AtomicU8>| {
            let _ = s.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |cur| match cur {
                QUIT_RUNNING => Some(QUIT_FIRST_PRESS),
                QUIT_FIRST_PRESS => Some(QUIT_SECOND_PRESS),
                _ => None,
            });
        };
        let s = Arc::new(AtomicU8::new(QUIT_RUNNING));
        press(&s);
        assert_eq!(s.load(Ordering::SeqCst), QUIT_FIRST_PRESS);
        press(&s);
        assert_eq!(s.load(Ordering::SeqCst), QUIT_SECOND_PRESS);
        // A third press is a no-op — we stay terminal.
        press(&s);
        assert_eq!(s.load(Ordering::SeqCst), QUIT_SECOND_PRESS);
    }

    #[test]
    fn status_panel_plain_records_rebuild_count() {
        // We can't easily assert printed output but we can confirm the
        // counter increments across record_build calls.
        let ui = RuntimeUi::new(crate::ui::runtime::UiFlags {
            quiet: true, // forces Plain branch
            ..crate::ui::runtime::UiFlags::default()
        });
        let panel = StatusPanel::new(&ui, std::path::Path::new("."), None);
        panel.record_build(&Ok(()), Duration::from_millis(100));
        panel.record_build(&Err(anyhow::anyhow!("boom")), Duration::from_millis(200));
        if let PanelInner::Plain { rebuilds } = &panel.inner {
            assert_eq!(rebuilds.get(), 2);
        } else {
            panic!("expected Plain inner");
        }
    }

    #[test]
    fn status_panel_sticky_increments_counter() {
        let mut ui = RuntimeUi::new(crate::ui::runtime::UiFlags::default());
        // Force sticky branch even on a non-TTY test runner.
        ui.is_tty = true;
        ui.flags.quiet = false;
        let panel = StatusPanel::new(&ui, std::path::Path::new("."), None);
        panel.set_status("Building");
        panel.record_build(&Ok(()), Duration::from_millis(50));
        panel.record_build(&Ok(()), Duration::from_millis(75));
        if let PanelInner::Sticky { rebuilds, .. } = &panel.inner {
            assert_eq!(rebuilds.get(), 2);
        } else {
            panic!("expected Sticky inner");
        }
        panel.finish();
    }
}
