//! `cognia open` — launch the cognia desktop at a specific surface via
//! `cognia://` deep links. The route grammar mirrors
//! `lib/navigation/cognia-deeplink.ts`: the CLI builds the URL, hands it to
//! the OS protocol handler, and the desktop routes it internally. No
//! credentials or bridge tokens ever travel in these URLs.

use anyhow::{bail, Context, Result};
use url::Url;

use crate::cli::OpenArgs;
use crate::ui::{style, RuntimeUi};

/// Deep-link hosts the desktop app knows how to consume — mirrors
/// `lib/navigation/cognia-deeplink.ts`.
const KNOWN_HOSTS: &[&str] = &[
    "oauth",
    "logto",
    "pair",
    "session",
    "chat",
    "share",
    "workflow-run",
    "im",
    "scheduler",
    "settings",
    "workspace",
];

pub fn run(args: &OpenArgs, ui: &mut RuntimeUi) -> Result<()> {
    let url = build_deeplink(args)?;
    if args.print {
        println!("{url}");
        return Ok(());
    }
    launch(&url)?;
    if !ui.flags.quiet {
        println!(
            "{}opened {}",
            style::success_prefix(),
            style::dim(url.as_str())
        );
    }
    Ok(())
}

/// Build the `cognia://` URL for the chosen surface. At most one selector
/// may be present — the exclusive arg group in [`OpenArgs`] enforces that
/// before we get here. With no selector at all we open the workspace
/// surface (the app root).
fn build_deeplink(args: &OpenArgs) -> Result<Url> {
    if let Some(target) = &args.surface.target {
        // Anything carrying a scheme is a URL, not a path — `open https://x`
        // must not silently become a workspace named "https://x".
        if target.contains("://") {
            return validate_deeplink(target);
        }
        let path = std::path::Path::new(target);
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()?.join(path)
        };
        let mut url = base("workspace")?;
        url.query_pairs_mut()
            .append_pair("path", absolute.to_string_lossy().as_ref());
        return Ok(url);
    }
    if let Some(id) = &args.surface.session {
        let mut url = base("session")?;
        push_segment(&mut url, id)?;
        return Ok(url);
    }
    if let Some(tab) = &args.surface.settings {
        let mut url = base("settings")?;
        if !tab.is_empty() {
            url.query_pairs_mut().append_pair("tab", tab);
        }
        return Ok(url);
    }
    if let Some(run) = &args.surface.workflow_run {
        let mut parts = run.splitn(2, '/');
        let (workflow_id, run_id) = (parts.next().unwrap_or_default(), parts.next());
        let run_id = run_id.filter(|id| !id.is_empty());
        if workflow_id.is_empty() || run_id.is_none() {
            bail!("--workflow-run expects `<workflow-id>/<run-id>` (got `{run}`)");
        }
        let mut url = base("workflow-run")?;
        push_segment(&mut url, workflow_id)?;
        push_segment(&mut url, run_id.unwrap())?;
        return Ok(url);
    }
    if let Some(id) = &args.surface.scheduler_task {
        let mut url = base("scheduler")?;
        push_segment(&mut url, "task")?;
        push_segment(&mut url, id)?;
        return Ok(url);
    }
    if let Some(key) = &args.surface.im {
        let mut url = base("im")?;
        if !key.is_empty() {
            url.query_pairs_mut().append_pair("conversationKey", key);
        }
        return Ok(url);
    }
    if let Some(payload) = &args.surface.pair {
        let mut url = base("pair")?;
        url.query_pairs_mut().append_pair("payload", payload);
        return Ok(url);
    }
    if args.surface.share {
        let mut url = base("share")?;
        if let Some(text) = &args.text {
            url.query_pairs_mut().append_pair("text", text);
        }
        if let Some(shared_url) = &args.url {
            Url::parse(shared_url).with_context(|| {
                format!("--url expects a valid URL (got `{shared_url}`)")
            })?;
            url.query_pairs_mut().append_pair("url", shared_url);
        }
        return Ok(url);
    }
    base("workspace")
}

fn base(host: &str) -> Result<Url> {
    Url::parse(&format!("cognia://{host}")).with_context(|| "failed to build deep link")
}

fn push_segment(url: &mut Url, segment: &str) -> Result<()> {
    if segment.is_empty() {
        bail!("deep-link segment must not be empty");
    }
    let cannot_extend = url.cannot_be_a_base();
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("cannot append a path segment (cannot_be_a_base={cannot_extend})"))?
        .push(segment);
    Ok(())
}

/// Validate a fully-formed `cognia://` URL supplied by the user: right
/// scheme, no credentials, a route the desktop actually understands.
fn validate_deeplink(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).with_context(|| format!("`{raw}` is not a valid URL"))?;
    if url.scheme() != "cognia" {
        bail!(
            "only `cognia://` deep links can be opened (got `{}://`)",
            url.scheme()
        );
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("deep links must not carry credentials");
    }
    let host = url.host_str().unwrap_or_default();
    if !KNOWN_HOSTS.contains(&host) {
        bail!(
            "unknown cognia route `{host}` (expected one of: {})",
            KNOWN_HOSTS.join(", ")
        );
    }
    Ok(url)
}

fn launch(url: &Url) -> Result<()> {
    let status = spawn_opener(url.as_str())?;
    if !status.success() {
        bail!("the OS URL handler exited with {status}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_opener(url: &str) -> Result<std::process::ExitStatus> {
    std::process::Command::new("open")
        .arg(url)
        .status()
        .with_context(|| "could not launch `open` — is this macOS?")
}

#[cfg(target_os = "windows")]
fn spawn_opener(url: &str) -> Result<std::process::ExitStatus> {
    // `rundll32 url.dll,FileProtocolHandler` avoids `cmd /c start` so `&`
    // and `?` in the URL are never reinterpreted by a shell.
    std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .status()
        .with_context(|| "could not launch `rundll32`")
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_opener(url: &str) -> Result<std::process::ExitStatus> {
    match std::process::Command::new("xdg-open").arg(url).status() {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            std::process::Command::new("gio")
                .args(["open", url])
                .status()
                .with_context(|| "could not launch `xdg-open` or `gio open`")
        }
        other => other.with_context(|| "could not launch `xdg-open`"),
    }
}

#[cfg(not(any(unix, target_os = "windows")))]
fn spawn_opener(_url: &str) -> Result<std::process::ExitStatus> {
    bail!("`cognia open` is not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> OpenArgs {
        OpenArgs {
            surface: crate::cli::OpenSurfaceArgs {
                target: None,
                session: None,
                settings: None,
                workflow_run: None,
                scheduler_task: None,
                im: None,
                pair: None,
                share: false,
            },
            text: None,
            url: None,
            print: false,
        }
    }

    /// Build args with only the given surface selector populated.
    fn with(f: impl Fn(&mut crate::cli::OpenSurfaceArgs)) -> OpenArgs {
        let mut a = args();
        f(&mut a.surface);
        a
    }

    #[test]
    fn bare_open_targets_workspace_root() {
        let url = build_deeplink(&args()).unwrap();
        assert_eq!(url.as_str(), "cognia://workspace");
    }

    #[test]
    fn session_flag_builds_session_route() {
        let url = build_deeplink(&with(|s| s.session = Some("abc-123".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://session/abc-123");
    }

    #[test]
    fn settings_flag_appends_tab_query() {
        let url = build_deeplink(&with(|s| s.settings = Some("plugins".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://settings?tab=plugins");

        let bare = build_deeplink(&with(|s| s.settings = Some(String::new())))
        .unwrap();
        assert_eq!(bare.as_str(), "cognia://settings");
    }

    #[test]
    fn workflow_run_requires_workflow_and_run_ids() {
        let url = build_deeplink(&with(|s| s.workflow_run = Some("wf-1/run-9".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://workflow-run/wf-1/run-9");

        for bad in ["wf-1", "/run-9", "wf-1/"] {
            assert!(
                build_deeplink(&with(|s| s.workflow_run = Some(bad.into())))
                .is_err(),
                "expected `{bad}` to be rejected"
            );
        }
    }

    #[test]
    fn scheduler_task_builds_task_route() {
        let url = build_deeplink(&with(|s| s.scheduler_task = Some("task-42".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://scheduler/task/task-42");
    }

    #[test]
    fn im_flag_builds_conversation_key_query() {
        let bare = build_deeplink(&with(|s| s.im = Some(String::new())))
        .unwrap();
        assert_eq!(bare.as_str(), "cognia://im");

        let keyed = build_deeplink(&with(|s| s.im = Some("conv-7".into())))
        .unwrap();
        assert_eq!(keyed.as_str(), "cognia://im?conversationKey=conv-7");
    }

    #[test]
    fn pair_flag_builds_payload_query() {
        let url = build_deeplink(&with(|s| s.pair = Some("p@y load".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://pair?payload=p%40y+load");
    }

    #[test]
    fn share_combines_text_and_url() {
        let mut share_args = with(|s| s.share = true);
        share_args.text = Some("hi there".into());
        share_args.url = Some("https://example.com/a?b=1".into());
        let url = build_deeplink(&share_args).unwrap();
        assert_eq!(
            url.as_str(),
            "cognia://share?text=hi+there&url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1"
        );

        let mut bad_share = with(|s| s.share = true);
        bad_share.url = Some("not a url".into());
        assert!(build_deeplink(&bad_share).is_err());
    }

    #[test]
    fn positional_accepts_full_deeplink_or_path() {
        let url = build_deeplink(&with(|s| s.target = Some("cognia://session/x1".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://session/x1");

        let url = build_deeplink(&with(|s| s.target = Some("/tmp/ws".into())))
        .unwrap();
        assert_eq!(url.as_str(), "cognia://workspace?path=%2Ftmp%2Fws");
    }

    #[test]
    fn validate_rejects_foreign_schemes_credentials_and_unknown_routes() {
        for raw in [
            "https://session/x",
            "cognia://user:pw@session/x",
            "cognia://bogus-route/x",
            "not a url at all",
        ] {
            assert!(
                validate_deeplink(raw).is_err(),
                "expected `{raw}` to be rejected"
            );
        }
        for raw in ["cognia://session/x", "cognia://workspace?path=/a"] {
            assert!(validate_deeplink(raw).is_ok(), "expected `{raw}` to pass");
        }
    }
}
