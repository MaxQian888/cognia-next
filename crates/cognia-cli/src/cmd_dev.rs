//! `cognia plugin dev [--reload-url URL]` — watch + rebuild + optionally
//! notify a running cognia.
//!
//! Listens for changes to source files (`src/`, `wit/`, `Cargo.toml`,
//! `plugin.json`). On each event it debounces 250 ms, then runs the
//! per-type build. If `--reload-url` is passed (or the CLI auto-discovers
//! a running cognia from the endpoint file), the latest bundle is POSTed
//! to the CLI bridge so the host hot-reloads in place.

use anyhow::{bail, Context, Result};
use notify::{EventKind, RecursiveMode, Watcher};
use serde_json::json;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::http_client::{load_endpoint, post_json, EndpointFile};
use crate::read_plugin_manifest;

const DEBOUNCE: Duration = Duration::from_millis(250);

pub fn run(path: PathBuf, reload_url: Option<String>) -> Result<()> {
    let crate_root = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    if !crate_root.join("plugin.json").exists() {
        bail!("plugin.json not found under {}", crate_root.display());
    }

    // Resolve a reload endpoint once at startup. Three possibilities:
    //   1. --reload-url passed in: use it verbatim. Token taken from the
    //      endpoint file if present, otherwise the request will 401 — but
    //      we attempt anyway so the user gets a clear error message.
    //   2. No --reload-url: try the endpoint file (auto-discovery).
    //   3. Neither: dev still works locally, just no reload pings.
    let reload_endpoint = resolve_reload_endpoint(reload_url.as_deref());
    match (&reload_endpoint, reload_url.as_deref()) {
        (Some(ep), _) => println!("Reload endpoint: {}", ep.base_url),
        (None, Some(url)) => println!("Reload endpoint: {url} (no dev token; will retry)"),
        (None, None) => println!("No reload endpoint — rebuild only"),
    }
    println!("Watching {} for changes…", crate_root.display());

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
                    if let Err(e) = rebuild_and_reload(&crate_root, reload_endpoint.as_ref()) {
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

fn rebuild_and_reload(
    crate_root: &std::path::Path,
    reload_endpoint: Option<&EndpointFile>,
) -> Result<()> {
    println!("→ rebuild");
    crate::cmd_build::run(crate_root.to_path_buf(), None, false)?;

    let Some(endpoint) = reload_endpoint else {
        return Ok(());
    };

    // Locate the freshly built bundle. `cmd_build` writes to
    // `target/cognia/<id>-<version>.zip` by default — re-derive that path
    // from the manifest so we can hand it to the bridge.
    let (manifest, _) = read_plugin_manifest(crate_root)?;
    let id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let version = manifest.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let bundle = crate_root
        .join("target")
        .join("cognia")
        .join(format!("{id}-{version}.zip"));
    if !bundle.exists() {
        eprintln!(
            "→ skipping reload ping: bundle not found at {}",
            bundle.display()
        );
        return Ok(());
    }
    println!("→ notify {} (bundle: {})", endpoint.base_url, bundle.display());
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
        // Endpoint file with a token but a different baseUrl.
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
}
