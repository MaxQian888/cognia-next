//! Local content for the desktop browser (ADR-0201): local files served over
//! loopback and local dev-server discovery. Thin Tauri shells over
//! `cognia_local_browser::{local_files, dev_servers}`.
//!
//! `browser_local_file_serve` starts a loopback static server bound to
//! `127.0.0.1:<ephemeral>` for each served root (one listener, one origin per
//! root) under a random 128-bit path prefix, so relative assets load and the
//! embedded trust tier is `localhost` rather than `file://`. A file is served
//! with its directory only when that directory is not home, a direct child of
//! home or a filesystem root; otherwise only the file itself is reachable
//! (`cognia_local_browser::local_files`). `browser_dev_servers_detect` lists the
//! loopback HTTP servers on this machine for the pane's empty state; Cognia's
//! own process and its local-file server are excluded.

use std::path::PathBuf;

use cognia_local_browser::dev_servers::{self, DetectOptions, DevServer};
use cognia_local_browser::local_files::{LocalFiles, ServedPath};
use tauri::State;

/// Managed state: the lazily started loopback file server.
#[derive(Default)]
pub struct LocalContentState {
    files: LocalFiles,
}

impl LocalContentState {
    /// Stop the file server (app exit).
    pub async fn shutdown(&self) {
        self.files.shutdown().await;
    }
}

/// Normalise what the address bar hands over: an absolute path or a
/// `file://` URL (percent-decoded). Anything else is refused.
pub(crate) fn local_path_from_input(input: &str) -> Result<PathBuf, String> {
    let trimmed = input.trim();
    if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("file://") {
        let url = url::Url::parse(trimmed)
            .map_err(|_| "local_file_invalid_path: malformed file URL".to_string())?;
        return url
            .to_file_path()
            .map_err(|_| "local_file_invalid_path: not a local file URL".to_string());
    }
    let path = PathBuf::from(trimmed);
    if trimmed.is_empty() || !path.is_absolute() {
        return Err("local_file_invalid_path: path must be absolute".to_string());
    }
    Ok(path)
}

#[tauri::command]
pub async fn browser_local_file_serve(
    state: State<'_, LocalContentState>,
    path: String,
) -> Result<ServedPath, String> {
    let path = local_path_from_input(&path)?;
    state
        .files
        .serve(&path)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_local_file_stop(
    state: State<'_, LocalContentState>,
    root: String,
) -> Result<(), String> {
    state
        .files
        .stop(&root)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_dev_servers_detect(
    state: State<'_, LocalContentState>,
) -> Result<Vec<DevServer>, String> {
    let options = DetectOptions {
        exclude_pids: vec![std::process::id()],
        exclude_ports: state.files.ports().await,
        max_probes: 0,
    };
    dev_servers::detect(options)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_bar_input_is_normalised() {
        #[cfg(unix)]
        {
            assert_eq!(
                local_path_from_input("/Users/me/site/index.html").unwrap(),
                PathBuf::from("/Users/me/site/index.html")
            );
            assert_eq!(
                local_path_from_input("  file:///Users/me/My%20Site/a.html ").unwrap(),
                PathBuf::from("/Users/me/My Site/a.html")
            );
            assert_eq!(
                local_path_from_input("FILE:///tmp/x").unwrap(),
                PathBuf::from("/tmp/x")
            );
        }
        #[cfg(windows)]
        {
            assert_eq!(
                local_path_from_input("file:///C:/site/a.html").unwrap(),
                PathBuf::from("C:\\site\\a.html")
            );
        }
        assert!(local_path_from_input("").is_err());
        assert!(local_path_from_input("relative/path.html").is_err());
        assert!(local_path_from_input("file://remote-host/share/a.html").is_err());
    }

    #[tokio::test]
    async fn state_serves_and_stops_through_the_crate() {
        let site = tempfile::tempdir().unwrap();
        std::fs::write(site.path().join("index.html"), b"<title>x</title>").unwrap();
        let state = LocalContentState::default();
        let served = state.files.serve(site.path()).await.unwrap();
        assert!(served.url.starts_with("http://127.0.0.1:"));
        assert_eq!(state.files.ports().await.len(), 1);
        state.files.stop(&served.root).await.unwrap();
        assert!(state.files.ports().await.is_empty());
        state.shutdown().await;
    }
}
