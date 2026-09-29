//! Install, detect and remove the Chromium the local runtime drives.
//!
//! Chromium is Playwright's Chrome-for-Testing build, downloaded on demand by
//! the staged `playwright-core` CLI into a private directory
//! (`PLAYWRIGHT_BROWSERS_PATH=<app_data>/browser/chromium`), so it never
//! collides with a developer's own Playwright cache and uninstalling is one
//! directory removal.
//!
//! The CLI prints (stdout, not a TTY):
//!
//! ```text
//! Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243) from https://…
//! |■■■■■■■■                                                                        |  10% of 170.2 MiB
//! …
//! Chrome for Testing 153.0.8010.12 (playwright chromium v1243) downloaded to /…/chromium-1243
//! ```
//!
//! It runs as `install --no-shell chromium`: the runtime launches the full
//! Chromium build, never the headless shell.
//!
//! [`ProgressParser`] turns those lines into [`InstallProgress`] updates.
//! Extraction happens after the last `100%` line and before `downloaded to`,
//! which is reported as the `extracting` phase.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Marker Playwright writes once a browser directory is complete.
pub const INSTALLATION_COMPLETE_MARKER: &str = "INSTALLATION_COMPLETE";

/// Browsers the runtime launches. It uses `channel: "chromium"` (the full
/// build, which also runs new-headless and extensions), so the headless shell
/// is never downloaded (`--no-shell`).
const REQUIRED_BROWSERS: &[&str] = &["chromium"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallPhase {
    Downloading,
    Extracting,
    Done,
    Failed,
}

/// The `browser-local://install` payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub phase: InstallPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl InstallProgress {
    pub fn phase(phase: InstallPhase, message: Option<String>) -> Self {
        Self {
            phase,
            received_bytes: None,
            total_bytes: None,
            message,
        }
    }
}

/// Remove ANSI escape sequences (`colors.dim(...)` around the URL).
pub fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(character);
    }
    out
}

/// `"170.2 MiB"` → bytes.
fn parse_mebibytes(text: &str) -> Option<u64> {
    let number = text.trim().strip_suffix("MiB")?.trim();
    let value: f64 = number.parse().ok()?;
    (value.is_finite() && value >= 0.0).then(|| (value * 1024.0 * 1024.0).round() as u64)
}

/// Stateful line parser: it remembers the component being downloaded.
#[derive(Debug, Default)]
pub struct ProgressParser {
    title: Option<String>,
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Parse one CLI output line.
    pub fn parse_line(&mut self, raw: &str) -> Option<InstallProgress> {
        let line = strip_ansi(raw);
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        if let Some(rest) = line.strip_prefix("Downloading ") {
            let title = rest
                .split(" from ")
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
            self.title = Some(title.clone());
            return Some(InstallProgress {
                phase: InstallPhase::Downloading,
                received_bytes: Some(0),
                total_bytes: None,
                message: Some(title),
            });
        }
        if line.starts_with('|') {
            // `|■■■  | 10% of 170.2 MiB`
            let tail = line.rsplit('|').next()?.trim();
            let (percent, total) = tail.split_once("% of ")?;
            let percent: u64 = percent.trim().parse().ok()?;
            let total = parse_mebibytes(total)?;
            let received = total.saturating_mul(percent.min(100)) / 100;
            let phase = if percent >= 100 {
                InstallPhase::Extracting
            } else {
                InstallPhase::Downloading
            };
            return Some(InstallProgress {
                phase,
                received_bytes: Some(received),
                total_bytes: Some(total),
                message: self.title.clone(),
            });
        }
        if let Some((title, _)) = line.split_once(" downloaded to ") {
            self.title = None;
            return Some(InstallProgress {
                phase: InstallPhase::Extracting,
                received_bytes: None,
                total_bytes: None,
                message: Some(title.trim().to_string()),
            });
        }
        None
    }
}

/// One browser entry of `playwright-core/browsers.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PinnedBrowser {
    pub name: String,
    pub revision: String,
    pub browser_version: Option<String>,
}

/// The browsers the staged `playwright-core` pins.
pub fn read_pinned_browsers(runtime_dir: &Path) -> Vec<PinnedBrowser> {
    let path = runtime_dir
        .join("node_modules")
        .join("playwright-core")
        .join("browsers.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    value
        .get("browsers")
        .and_then(Value::as_array)
        .map(|browsers| {
            browsers
                .iter()
                .filter_map(|browser| {
                    Some(PinnedBrowser {
                        name: browser.get("name")?.as_str()?.to_string(),
                        revision: browser.get("revision")?.as_str()?.to_string(),
                        browser_version: browser
                            .get("browserVersion")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Playwright's directory name for a browser (`chromium-headless-shell` →
/// `chromium_headless_shell-<rev>`).
pub fn browser_directory_name(name: &str, revision: &str) -> String {
    format!("{}-{revision}", name.replace('-', "_"))
}

fn is_complete(dir: &Path) -> bool {
    dir.join(INSTALLATION_COMPLETE_MARKER).is_file()
}

/// An installed Chromium.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstalledChromium {
    pub revision: String,
    pub version: String,
    pub directory: PathBuf,
}

/// The Chromium version the staged runtime expects (for the Web Store
/// `prodversion` parameter), if the runtime is staged.
pub fn expected_chromium_version(runtime_dir: &Path) -> Option<String> {
    read_pinned_browsers(runtime_dir)
        .into_iter()
        .find(|browser| browser.name == "chromium")
        .and_then(|browser| browser.browser_version)
}

/// What is installed under `browsers_path`.
///
/// When the staged runtime pins revisions, Chromium counts as installed only
/// if every pinned required browser is complete: a leftover older revision is
/// not something the runtime can launch. Without pins (the runtime is not
/// staged), any complete `chromium-<rev>` directory is reported.
pub fn installed(browsers_path: &Path, runtime_dir: &Path) -> Option<InstalledChromium> {
    let pinned = read_pinned_browsers(runtime_dir);
    let chromium = pinned.iter().find(|browser| browser.name == "chromium");
    if let Some(chromium) = chromium {
        let all_complete = pinned
            .iter()
            .filter(|browser| REQUIRED_BROWSERS.contains(&browser.name.as_str()))
            .all(|browser| {
                is_complete(
                    &browsers_path.join(browser_directory_name(&browser.name, &browser.revision)),
                )
            });
        if !all_complete {
            return None;
        }
        return Some(InstalledChromium {
            revision: chromium.revision.clone(),
            version: chromium
                .browser_version
                .clone()
                .unwrap_or_else(|| format!("r{}", chromium.revision)),
            directory: browsers_path
                .join(browser_directory_name("chromium", &chromium.revision)),
        });
    }
    scan_installed(browsers_path)
}

/// The newest complete `chromium-<rev>` directory.
fn scan_installed(browsers_path: &Path) -> Option<InstalledChromium> {
    let entries = std::fs::read_dir(browsers_path).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let revision = name.strip_prefix("chromium-")?.to_string();
            let number: u64 = revision.parse().ok()?;
            is_complete(&entry.path()).then(|| (number, revision, entry.path()))
        })
        .max_by_key(|(number, _, _)| *number)
        .map(|(_, revision, directory)| InstalledChromium {
            version: format!("r{revision}"),
            revision,
            directory,
        })
}

/// The staged CLI entry.
pub fn cli_path(runtime_dir: &Path) -> PathBuf {
    runtime_dir
        .join("node_modules")
        .join("playwright-core")
        .join("cli.js")
}

#[derive(Debug, thiserror::Error)]
pub enum InstallError {
    #[error("runtime_not_staged: the browser runtime is missing {0}")]
    RuntimeNotStaged(String),
    #[error("install_spawn_failed: {0}")]
    Spawn(String),
    #[error("install_failed: {0}")]
    Failed(String),
    #[error("uninstall_failed: {0}")]
    Uninstall(String),
}

impl InstallError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::RuntimeNotStaged(_) => "runtime_not_staged",
            Self::Spawn(_) => "install_spawn_failed",
            Self::Failed(_) => "install_failed",
            Self::Uninstall(_) => "uninstall_failed",
        }
    }
}

/// Keep the last few lines of output for a failure message.
fn push_tail(tail: &mut std::collections::VecDeque<String>, line: String) {
    const MAX: usize = 12;
    if tail.len() == MAX {
        tail.pop_front();
    }
    tail.push_back(line);
}

/// Run `node cli.js install chromium` and report progress. Returns what is
/// installed afterwards. The child is killed if the future is dropped.
pub async fn install<F>(
    node: &Path,
    runtime_dir: &Path,
    browsers_path: &Path,
    mut on_progress: F,
) -> Result<InstalledChromium, InstallError>
where
    F: FnMut(InstallProgress) + Send,
{
    let cli = cli_path(runtime_dir);
    if !cli.is_file() {
        return Err(InstallError::RuntimeNotStaged(cli.display().to_string()));
    }
    tokio::fs::create_dir_all(browsers_path)
        .await
        .map_err(|error| {
            InstallError::Failed(format!(
                "cannot create {}: {error}",
                browsers_path.display()
            ))
        })?;

    let mut command = tokio::process::Command::new(node);
    command
        .arg(&cli)
        .arg("install")
        .arg("--no-shell")
        .arg("chromium")
        .current_dir(runtime_dir)
        .env("PLAYWRIGHT_BROWSERS_PATH", browsers_path)
        // The npm log level silences `logPolitely`; make sure it does not.
        .env_remove("npm_config_loglevel")
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    crate::supervisor::hide_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| InstallError::Spawn(error.to_string()))?;

    on_progress(InstallProgress {
        phase: InstallPhase::Downloading,
        received_bytes: Some(0),
        total_bytes: None,
        message: None,
    });

    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let mut stdout = BufReader::new(stdout).lines();
    let mut stderr = BufReader::new(stderr).lines();
    let mut parser = ProgressParser::new();
    let mut tail = std::collections::VecDeque::new();
    let (mut stdout_open, mut stderr_open) = (true, true);
    while stdout_open || stderr_open {
        tokio::select! {
            line = stdout.next_line(), if stdout_open => match line {
                Ok(Some(line)) => {
                    if let Some(progress) = parser.parse_line(&line) {
                        on_progress(progress);
                    }
                    push_tail(&mut tail, strip_ansi(&line));
                }
                _ => stdout_open = false,
            },
            line = stderr.next_line(), if stderr_open => match line {
                Ok(Some(line)) => push_tail(&mut tail, strip_ansi(&line)),
                _ => stderr_open = false,
            },
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|error| InstallError::Failed(error.to_string()))?;
    let installed = installed(browsers_path, runtime_dir);
    match (status.success(), installed) {
        (true, Some(installed)) => {
            on_progress(InstallProgress::phase(
                InstallPhase::Done,
                Some(installed.version.clone()),
            ));
            Ok(installed)
        }
        (success, _) => {
            let detail = tail
                .iter()
                .filter(|line| !line.trim().is_empty() && !line.starts_with('|'))
                .cloned()
                .collect::<Vec<_>>()
                .join("\n");
            let message = if success {
                format!("the installer finished but Chromium is incomplete\n{detail}")
            } else {
                format!("the installer exited with {status}\n{detail}")
            };
            on_progress(InstallProgress::phase(
                InstallPhase::Failed,
                Some(message.clone()),
            ));
            Err(InstallError::Failed(message))
        }
    }
}

/// Remove every downloaded browser. The directory is Cognia-private, so the
/// whole tree goes; a missing directory is already uninstalled. Blocking:
/// async callers run it on a blocking thread (or use [`uninstall_async`]).
pub fn uninstall(browsers_path: &Path) -> Result<(), InstallError> {
    match std::fs::remove_dir_all(browsers_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(InstallError::Uninstall(format!(
            "{}: {error}",
            browsers_path.display()
        ))),
    }
}

/// [`uninstall`] on a blocking thread, for async callers.
pub async fn uninstall_async(browsers_path: PathBuf) -> Result<(), InstallError> {
    tokio::task::spawn_blocking(move || uninstall(&browsers_path))
        .await
        .map_err(|error| InstallError::Uninstall(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    const BROWSERS_JSON: &str = r#"{
      "browsers": [
        {"name": "chromium", "revision": "1243", "installByDefault": true, "browserVersion": "153.0.8010.12"},
        {"name": "chromium-headless-shell", "revision": "1243", "installByDefault": true, "browserVersion": "153.0.8010.12"},
        {"name": "firefox", "revision": "1543", "installByDefault": true, "browserVersion": "155.0"},
        {"name": "ffmpeg", "revision": "1011", "installByDefault": true}
      ]
    }"#;

    fn staged_runtime() -> tempfile::TempDir {
        let runtime = tempfile::tempdir().unwrap();
        let core = runtime.path().join("node_modules").join("playwright-core");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(core.join("browsers.json"), BROWSERS_JSON).unwrap();
        runtime
    }

    fn complete(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(INSTALLATION_COMPLETE_MARKER), "").unwrap();
    }

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(
            strip_ansi("Downloading X\u{1b}[2m from https://a\u{1b}[22m"),
            "Downloading X from https://a"
        );
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn parses_the_cli_progress_stream() {
        let mut parser = ProgressParser::new();
        let start = parser
            .parse_line(
                "Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243)\u{1b}[2m from https://cdn.playwright.dev/x.zip\u{1b}[22m",
            )
            .unwrap();
        assert_eq!(start.phase, InstallPhase::Downloading);
        assert_eq!(start.received_bytes, Some(0));
        assert_eq!(
            start.message.as_deref(),
            Some("Chrome for Testing 153.0.8010.12 (playwright chromium v1243)")
        );

        let bar = format!("|{}{}|  10% of 100 MiB", "■".repeat(8), " ".repeat(72));
        let tick = parser.parse_line(&bar).unwrap();
        assert_eq!(tick.phase, InstallPhase::Downloading);
        assert_eq!(tick.total_bytes, Some(100 * 1024 * 1024));
        assert_eq!(tick.received_bytes, Some(10 * 1024 * 1024));
        assert_eq!(tick.message, start.message);

        let full = parser
            .parse_line(&format!("|{}| 100% of 170.2 MiB", "■".repeat(80)))
            .unwrap();
        assert_eq!(full.phase, InstallPhase::Extracting);
        assert_eq!(full.received_bytes, full.total_bytes);
        assert_eq!(full.total_bytes, Some((170.2f64 * 1024.0 * 1024.0).round() as u64));

        let done = parser
            .parse_line("Chrome for Testing 153.0.8010.12 (playwright chromium v1243) downloaded to /x/chromium-1243")
            .unwrap();
        assert_eq!(done.phase, InstallPhase::Extracting);
        assert_eq!(
            done.message.as_deref(),
            Some("Chrome for Testing 153.0.8010.12 (playwright chromium v1243)")
        );

        assert!(parser.parse_line("").is_none());
        assert!(parser.parse_line("some unrelated warning").is_none());
        assert!(parser.parse_line("|garbage|").is_none());
    }

    #[test]
    fn progress_serializes_as_the_install_event() {
        let value = serde_json::to_value(InstallProgress {
            phase: InstallPhase::Downloading,
            received_bytes: Some(5),
            total_bytes: Some(10),
            message: None,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"phase": "downloading", "receivedBytes": 5, "totalBytes": 10})
        );
        let done =
            serde_json::to_value(InstallProgress::phase(InstallPhase::Done, Some("153".into())))
                .unwrap();
        assert_eq!(done, serde_json::json!({"phase": "done", "message": "153"}));
    }

    #[test]
    fn reads_pins_and_directory_names() {
        let runtime = staged_runtime();
        let pinned = read_pinned_browsers(runtime.path());
        assert_eq!(pinned.len(), 4);
        assert_eq!(
            expected_chromium_version(runtime.path()).as_deref(),
            Some("153.0.8010.12")
        );
        assert_eq!(
            browser_directory_name("chromium-headless-shell", "1243"),
            "chromium_headless_shell-1243"
        );
        assert!(read_pinned_browsers(Path::new("/nonexistent")).is_empty());
    }

    #[test]
    fn installed_requires_the_pinned_full_chromium_build() {
        let runtime = staged_runtime();
        let browsers = tempfile::tempdir().unwrap();
        assert_eq!(installed(browsers.path(), runtime.path()), None);

        complete(&browsers.path().join("chromium_headless_shell-1243"));
        assert_eq!(
            installed(browsers.path(), runtime.path()),
            None,
            "the headless shell alone is not launchable"
        );

        let incomplete = browsers.path().join("chromium-1243");
        std::fs::create_dir_all(&incomplete).unwrap();
        assert_eq!(installed(browsers.path(), runtime.path()), None, "no marker yet");

        complete(&incomplete);
        let found = installed(browsers.path(), runtime.path()).unwrap();
        assert_eq!(found.revision, "1243");
        assert_eq!(found.version, "153.0.8010.12");
        assert_eq!(found.directory, browsers.path().join("chromium-1243"));
    }

    #[test]
    fn an_old_revision_is_not_launchable() {
        let runtime = staged_runtime();
        let browsers = tempfile::tempdir().unwrap();
        complete(&browsers.path().join("chromium-1200"));
        assert_eq!(installed(browsers.path(), runtime.path()), None);
    }

    #[test]
    fn without_pins_the_newest_complete_build_is_reported() {
        let browsers = tempfile::tempdir().unwrap();
        complete(&browsers.path().join("chromium-1100"));
        complete(&browsers.path().join("chromium-1243"));
        std::fs::create_dir_all(browsers.path().join("chromium-1300")).unwrap();
        let found = installed(browsers.path(), Path::new("/nonexistent")).unwrap();
        assert_eq!(found.revision, "1243");
        assert_eq!(found.version, "r1243");
    }

    #[test]
    fn uninstall_removes_the_private_directory() {
        let root = tempfile::tempdir().unwrap();
        let browsers = root.path().join("chromium");
        complete(&browsers.join("chromium-1243"));
        uninstall(&browsers).unwrap();
        assert!(!browsers.exists());
        uninstall(&browsers).unwrap();
    }

    #[tokio::test]
    async fn uninstall_async_runs_off_the_executor() {
        let root = tempfile::tempdir().unwrap();
        let browsers = root.path().join("chromium");
        complete(&browsers.join("chromium-1243"));
        uninstall_async(browsers.clone()).await.unwrap();
        assert!(!browsers.exists());
        uninstall_async(browsers).await.unwrap();
    }

    #[tokio::test]
    async fn install_refuses_an_unstaged_runtime() {
        let runtime = tempfile::tempdir().unwrap();
        let browsers = tempfile::tempdir().unwrap();
        let error = install(Path::new("node"), runtime.path(), browsers.path(), |_| {})
            .await
            .unwrap_err();
        assert_eq!(error.code(), "runtime_not_staged");
    }

    /// Drive `install` with `/bin/sh` standing in for Node: the "CLI" prints
    /// Playwright's lines and writes the marker files.
    #[cfg(unix)]
    #[tokio::test]
    async fn install_reports_progress_from_the_cli() {
        let runtime = staged_runtime();
        let browsers = tempfile::tempdir().unwrap();
        let script = r#"
[ "$2" = "--no-shell" ] && [ "$3" = "chromium" ] || { echo "unexpected args: $*"; exit 9; }
echo "Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243) from https://x"
echo "|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■                                        |  50% of 10 MiB"
echo "|■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■| 100% of 10 MiB"
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH/chromium-1243" "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1243"
touch "$PLAYWRIGHT_BROWSERS_PATH/chromium-1243/INSTALLATION_COMPLETE" "$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1243/INSTALLATION_COMPLETE"
echo "Chrome for Testing 153.0.8010.12 (playwright chromium v1243) downloaded to $PLAYWRIGHT_BROWSERS_PATH/chromium-1243"
"#;
        std::fs::write(cli_path(runtime.path()), script).unwrap();
        let mut events = Vec::new();
        let result = install(Path::new("/bin/sh"), runtime.path(), browsers.path(), |event| {
            events.push(event)
        })
        .await
        .unwrap();
        assert_eq!(result.version, "153.0.8010.12");
        let phases: Vec<_> = events.iter().map(|event| event.phase).collect();
        assert_eq!(
            phases,
            vec![
                InstallPhase::Downloading,
                InstallPhase::Downloading,
                InstallPhase::Downloading,
                InstallPhase::Extracting,
                InstallPhase::Extracting,
                InstallPhase::Done,
            ]
        );
        assert_eq!(events[2].received_bytes, Some(5 * 1024 * 1024));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn install_failure_carries_the_output_tail() {
        let runtime = staged_runtime();
        let browsers = tempfile::tempdir().unwrap();
        std::fs::write(
            cli_path(runtime.path()),
            "echo 'Error: getaddrinfo ENOTFOUND cdn.playwright.dev' >&2\nexit 1\n",
        )
        .unwrap();
        let mut last = None;
        let error = install(Path::new("/bin/sh"), runtime.path(), browsers.path(), |event| {
            last = Some(event)
        })
        .await
        .unwrap_err();
        assert_eq!(error.code(), "install_failed");
        assert!(error.to_string().contains("ENOTFOUND"));
        assert_eq!(last.unwrap().phase, InstallPhase::Failed);
    }
}
