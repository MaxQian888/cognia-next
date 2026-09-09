//! One credential policy for every clone this app makes.
//!
//! There were three. `src-tauri/src/github/workspace.rs` kept the token out of
//! argv and out of `.git/config` by passing it as env-based git config.
//! `cognia-git`'s `exec::base_command` deliberately inherits the ambient
//! credential manager and has no token of its own. The E2B backend wrote
//! `https://x-access-token:<token>@github.com/...` straight into the sandbox's
//! remote. The last one is the problem: it is the same issue-body-driven agent
//! in all three cases, and in that one it can `cat .git/config`.
//!
//! # Why env instead of a config file
//!
//! `GIT_CONFIG_COUNT` / `_KEY_n` / `_VALUE_n` is git's env-based config
//! override. It applies to one child process only, so nothing lands in
//! `<workspace>/.git/config` (which an agent working in the clone can read) and
//! nothing lands in argv (which any process listing can read).
//!
//! # Why the env is built rather than applied
//!
//! Callers hold three different command types: `std::process::Command` here,
//! `tokio::process::Command` in `src-tauri` and `cognia-git`, and a remote
//! sandbox facade in the E2B plugin, which has no `Command` at all. Returning
//! the pairs lets all three apply one policy. A function that mutated a
//! `Command` could serve only the first two, which is how the third came to
//! have its own.

use once_cell::sync::Lazy;
use regex::Regex;

/// Matches `https://anything@` so a credential embedded in a URL is stripped
/// even when we were never told what the credential was. Moved here from
/// `cognia-git`'s `exec::redact` so one redactor covers both shapes.
static CRED_URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://)[^/@\s]+@").expect("static regex"));

/// A GitHub token, held only in the forms git and the redactor need.
///
/// Neither form is public. A caller can apply it to a command and can redact
/// text with it, and cannot read it back out to log it or to paste it into a
/// URL, which is exactly the mistake this type exists to make unavailable.
#[derive(Clone)]
pub struct GitCredential {
    token: String,
    basic: String,
}

impl std::fmt::Debug for GitCredential {
    /// A credential that prints itself is a credential in a log file.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GitCredential(<redacted>)")
    }
}

impl GitCredential {
    /// `None` for an empty token, so "no credential" and "a blank credential"
    /// cannot be confused by a caller that got an empty string from config.
    pub fn from_token(token: &str) -> Option<Self> {
        if token.is_empty() {
            return None;
        }
        use base64::Engine as _;
        let basic =
            base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
        Some(Self {
            token: token.to_string(),
            basic,
        })
    }
}

/// Environment for a host-owned git invocation carrying no credential.
///
/// Hooks are pinned to `/dev/null` because these commands run against a
/// worktree an issue-controlled agent may have written to, and a repository can
/// carry executable hooks. System and global config are dropped for the same
/// reason a clone is not given the user's `insteadOf` rules.
pub fn isolation_env() -> Vec<(String, String)> {
    vec![
        ("GIT_CONFIG_COUNT".into(), "3".into()),
        ("GIT_CONFIG_KEY_0".into(), "core.hooksPath".into()),
        ("GIT_CONFIG_VALUE_0".into(), "/dev/null".into()),
        ("GIT_CONFIG_KEY_1".into(), "user.name".into()),
        ("GIT_CONFIG_VALUE_1".into(), "Cognia".into()),
        ("GIT_CONFIG_KEY_2".into(), "user.email".into()),
        ("GIT_CONFIG_VALUE_2".into(), "noreply@cognia.app".into()),
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ]
}

/// [`isolation_env`] plus the credential, scoped to one host.
///
/// `origin` is the host the header is keyed on. Git applies
/// `http.<url>.extraheader` by URL prefix, so keying it on the *actual* host
/// rather than a hard-coded `https://github.com/` is what makes a GitHub
/// Enterprise Server remote work, and is also what stops a github.com token
/// being offered to an unrelated host that a redirect happened to reach.
///
/// `origin` must be a scheme-and-host prefix such as
/// `https://github.example.com/`. A trailing slash is added when missing.
pub fn auth_env(origin: &str, credential: &GitCredential) -> Vec<(String, String)> {
    let mut env = isolation_env();
    let prefix = if origin.ends_with('/') {
        origin.to_string()
    } else {
        format!("{origin}/")
    };
    env.retain(|(key, _)| key != "GIT_CONFIG_COUNT");
    env.push(("GIT_CONFIG_COUNT".into(), "4".into()));
    env.push((
        "GIT_CONFIG_KEY_3".into(),
        format!("http.{prefix}.extraheader"),
    ));
    env.push((
        "GIT_CONFIG_VALUE_3".into(),
        format!("Authorization: Basic {}", credential.basic),
    ));
    env
}

/// Strip credentials from text before it reaches a log, an audit row, or a
/// renderer error toast.
///
/// Two shapes, because there are two ways one gets in: the literal token (and
/// its base64 basic form) when we know it, and a `https://user@host` URL that
/// git echoed back at us when we do not. The URL form is always stripped, so
/// text from a command that carried no credential of ours is still cleaned.
pub fn redact(text: &str, credential: Option<&GitCredential>) -> String {
    let stripped = CRED_URL.replace_all(text, "$1<redacted>@").into_owned();
    match credential {
        None => stripped,
        Some(credential) => stripped
            .replace(&credential.token, "<redacted>")
            .replace(&credential.basic, "<redacted>"),
    }
}

/// The `https://<host>/` prefix an [`auth_env`] header should be keyed on,
/// derived from a remote URL. `None` when the URL is not one we would clone.
pub fn origin_of(remote_url: &str) -> Option<String> {
    let rest = remote_url.trim().strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    // A host carrying a credential is not a host. Refuse rather than key the
    // header on `user:pass@github.com`, which git would never match anyway.
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("https://{host}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_token_is_not_a_credential() {
        assert!(GitCredential::from_token("").is_none());
        assert!(GitCredential::from_token("ghp_x").is_some());
    }

    #[test]
    fn the_credential_never_prints_itself() {
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let shown = format!("{credential:?}");
        assert!(!shown.contains("ghp_secret"), "{shown}");
    }

    #[test]
    fn auth_env_carries_the_credential_out_of_band() {
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let env = auth_env("https://github.com", &credential);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();

        assert_eq!(map.get("GIT_CONFIG_COUNT").map(String::as_str), Some("4"));
        assert_eq!(
            map.get("GIT_CONFIG_KEY_3").map(String::as_str),
            Some("http.https://github.com/.extraheader")
        );
        // The header carries the base64 basic form, never the raw token.
        let value = map.get("GIT_CONFIG_VALUE_3").expect("header value");
        assert!(value.starts_with("Authorization: Basic "));
        assert!(!value.contains("ghp_secret"), "{value}");
        // Isolation survives the credential being added.
        assert_eq!(
            map.get("GIT_CONFIG_VALUE_0").map(String::as_str),
            Some("/dev/null")
        );
        assert_eq!(
            map.get("GIT_CONFIG_GLOBAL").map(String::as_str),
            Some("/dev/null")
        );
    }

    #[test]
    fn the_header_is_keyed_on_the_host_it_was_asked_for() {
        // A github.com-shaped key would simply not match a GHES remote, which
        // is what made Enterprise Server unreachable rather than merely
        // unsupported.
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let map: std::collections::HashMap<_, _> =
            auth_env("https://github.example.com/", &credential)
                .into_iter()
                .collect();
        assert_eq!(
            map.get("GIT_CONFIG_KEY_3").map(String::as_str),
            Some("http.https://github.example.com/.extraheader")
        );
    }

    #[test]
    fn redaction_removes_both_the_raw_and_the_basic_form() {
        let credential = GitCredential::from_token("ghp_secret").unwrap();
        let basic = auth_env("https://github.com", &credential)
            .into_iter()
            .find(|(key, _)| key == "GIT_CONFIG_VALUE_3")
            .map(|(_, value)| value)
            .unwrap()
            .replace("Authorization: Basic ", "");
        let text = format!("fatal: ghp_secret rejected, header was {basic}");

        let out = redact(&text, Some(&credential));
        assert!(!out.contains("ghp_secret"), "{out}");
        assert!(!out.contains(&basic), "{out}");
    }

    #[test]
    fn redaction_strips_a_credentialed_url_it_was_never_told_about() {
        // The case `cognia-git`'s regex covered and the token-literal redactor
        // did not: git echoing back a URL whose credential came from the
        // ambient credential manager.
        let text =
            "fatal: unable to access 'https://x-access-token:ghp_abc123@github.com/o/r.git/'";
        let out = redact(text, None);
        assert!(!out.contains("ghp_abc123"), "{out}");
        assert!(
            out.contains("https://<redacted>@github.com/o/r.git"),
            "{out}"
        );
    }

    #[test]
    fn redaction_leaves_plain_urls_untouched() {
        let text = "remote: https://github.com/o/r.git";
        assert_eq!(redact(text, None), text);
    }

    #[test]
    fn an_origin_is_a_scheme_and_host_and_nothing_else() {
        assert_eq!(
            origin_of("https://github.com/owner/repo.git").as_deref(),
            Some("https://github.com/")
        );
        assert_eq!(
            origin_of("https://github.example.com/o/r").as_deref(),
            Some("https://github.example.com/")
        );
        assert_eq!(origin_of("git@github.com:o/r.git"), None);
        assert_eq!(origin_of("http://github.com/o/r"), None);
        assert_eq!(origin_of("https://user:pw@github.com/o/r"), None);
    }
}
