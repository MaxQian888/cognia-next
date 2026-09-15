//! The environment an agent starts with inside a user image (ADR-0183).
//!
//! The container's environment is the image's `ENV` merged with what the
//! driver set. Which is which cannot be told apart from inside, so the driver
//! lists the names it set in [`PROVIDED_ENV_VAR`]. The rules then mirror
//! `buildChildEnv` in `cli/src/x/agent-launcher.ts`:
//!
//! 1. start from the container environment;
//! 2. drop everything addressed to the supervisor (`COGNIA_SANDBOXD_*`);
//! 3. drop ambient provider credentials the driver did not provide — an image
//!    that bakes in `OPENAI_API_KEY` must not route the agent around the
//!    gateway;
//! 4. add what the injected tree needs: `PATH` entries, a CA bundle for an
//!    image without one, and `HOME`/`USER`/`LOGNAME` for the target user.
//!
//! The image's `PATH` stays first. Project work run through the agent's shell
//! should use the project's own `node`, `python` and `git`; the agent's own
//! entry point and its shims are addressed by absolute path under `/cognia`,
//! so they never depend on lookup order.

use std::collections::{BTreeMap, BTreeSet};

use crate::layout::{InjectedLayout, Libc, PROVIDED_ENV_VAR, SANDBOXD_ENV_PREFIX};
use crate::passwd::ResolvedUser;

/// Kept identical to `AMBIENT_CREDENTIAL_ENV` in `cli/src/x/agent-launcher.ts`
/// (a test here reads that file).
pub const AMBIENT_CREDENTIAL_ENV: [&str; 13] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
    "COGNIA_GATEWAY_KEY",
];

/// Docker's default `PATH` for a container whose image sets none.
pub const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

pub struct ChildEnvInput<'a> {
    /// The supervisor's own environment.
    pub parent: &'a BTreeMap<String, String>,
    pub layout: &'a InjectedLayout,
    /// The probed libc; `None` leaves the libc tree off `PATH`.
    pub libc: Option<Libc>,
    /// The user the agent runs as; `None` keeps the supervisor's identity.
    pub user: Option<&'a ResolvedUser>,
    /// The CA store the probe found in the image, if any.
    pub image_ca_bundle: Option<&'a str>,
}

/// The names in [`PROVIDED_ENV_VAR`], trimmed, empty entries ignored.
pub fn provided_names(parent: &BTreeMap<String, String>) -> BTreeSet<String> {
    parent
        .get(PROVIDED_ENV_VAR)
        .map(|list| {
            list.split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn build_child_env(input: &ChildEnvInput<'_>) -> BTreeMap<String, String> {
    let provided = provided_names(input.parent);
    let mut env: BTreeMap<String, String> = input
        .parent
        .iter()
        .filter(|(name, _)| !name.starts_with(SANDBOXD_ENV_PREFIX))
        .filter(|(name, _)| {
            !AMBIENT_CREDENTIAL_ENV.contains(&name.as_str()) || provided.contains(name.as_str())
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();

    let mut path: Vec<String> = env
        .get("PATH")
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .unwrap_or(DEFAULT_PATH)
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect();
    for dir in input.layout.path_dirs(input.libc) {
        let dir = dir.to_string_lossy().into_owned();
        if !path.contains(&dir) {
            path.push(dir);
        }
    }
    env.insert("PATH".into(), path.join(":"));

    // TLS for tools that do not carry their own roots (the static git build
    // in particular). An explicit setting, provided or from the image, wins.
    let ca = input
        .image_ca_bundle
        .map(str::to_string)
        .unwrap_or_else(|| input.layout.ca_bundle().to_string_lossy().into_owned());
    for name in ["SSL_CERT_FILE", "GIT_SSL_CAINFO"] {
        env.entry(name.into()).or_insert_with(|| ca.clone());
    }

    if let Some(user) = input.user {
        // Docker set HOME for the image's user, usually root; the agent is
        // someone else now, unless the driver chose a home on purpose.
        if !provided.contains("HOME") {
            env.insert(
                "HOME".into(),
                user.home.clone().unwrap_or_else(|| "/tmp".into()),
            );
        }
        for name in ["USER", "LOGNAME"] {
            if provided.contains(name) {
                continue;
            }
            match &user.name {
                Some(user_name) => {
                    env.insert(name.into(), user_name.clone());
                }
                None => {
                    env.remove(name);
                }
            }
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parent(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    fn node_user() -> ResolvedUser {
        ResolvedUser {
            name: Some("node".into()),
            uid: 1000,
            gid: 1000,
            groups: vec![1000],
            home: Some("/home/node".into()),
        }
    }

    #[test]
    fn strips_supervisor_variables_and_ambient_credentials_not_provided() {
        let parent = parent(&[
            ("PATH", "/usr/local/bin:/usr/bin:/bin"),
            ("OPENAI_API_KEY", "baked-into-image"),
            ("ANTHROPIC_BASE_URL", "http://gateway:27895"),
            ("ANTHROPIC_AUTH_TOKEN", "ticket"),
            (
                "COGNIA_SANDBOXD_PROVIDED_ENV",
                "ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN,,",
            ),
            ("COGNIA_SANDBOXD_CLAIM_SECRET", "s3cret"),
            ("LANG", "C.UTF-8"),
        ]);
        let layout = InjectedLayout::default();
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: Some(Libc::Glibc),
            user: None,
            image_ca_bundle: Some("/etc/ssl/certs/ca-certificates.crt"),
        });

        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(env.keys().all(|name| !name.starts_with("COGNIA_SANDBOXD_")));
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://gateway:27895");
        assert_eq!(env["ANTHROPIC_AUTH_TOKEN"], "ticket");
        assert_eq!(env["LANG"], "C.UTF-8");
        assert_eq!(
            env["PATH"],
            "/usr/local/bin:/usr/bin:/bin:/cognia/bin:/cognia/glibc/bin:/cognia/common/bin"
        );
        assert_eq!(env["SSL_CERT_FILE"], "/etc/ssl/certs/ca-certificates.crt");
        assert_eq!(env["GIT_SSL_CAINFO"], "/etc/ssl/certs/ca-certificates.crt");
        assert!(!env.contains_key("HOME"));
    }

    #[test]
    fn defaults_path_and_ca_and_keeps_explicit_settings() {
        let parent = parent(&[
            ("SSL_CERT_FILE", "/custom.pem"),
            ("PATH", "/cognia/bin:/bin"),
        ]);
        let layout = InjectedLayout::default();
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: None,
            user: None,
            image_ca_bundle: None,
        });
        assert_eq!(env["PATH"], "/cognia/bin:/bin:/cognia/common/bin");
        assert_eq!(env["SSL_CERT_FILE"], "/custom.pem");
        assert_eq!(env["GIT_SSL_CAINFO"], "/cognia/certs/ca-bundle.pem");

        let empty = BTreeMap::new();
        let env = build_child_env(&ChildEnvInput {
            parent: &empty,
            layout: &layout,
            libc: Some(Libc::Musl),
            user: None,
            image_ca_bundle: None,
        });
        assert!(env["PATH"].starts_with(DEFAULT_PATH));
        assert!(env["PATH"].ends_with("/cognia/musl/bin:/cognia/common/bin"));
    }

    #[test]
    fn switches_identity_variables_to_the_target_user() {
        let parent = parent(&[("HOME", "/root"), ("USER", "root"), ("LOGNAME", "root")]);
        let layout = InjectedLayout::default();
        let user = node_user();
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: None,
            user: Some(&user),
            image_ca_bundle: None,
        });
        assert_eq!(env["HOME"], "/home/node");
        assert_eq!(env["USER"], "node");
        assert_eq!(env["LOGNAME"], "node");

        let nameless = ResolvedUser {
            name: None,
            uid: 10001,
            gid: 10001,
            groups: vec![10001],
            home: None,
        };
        let env = build_child_env(&ChildEnvInput {
            parent: &parent,
            layout: &layout,
            libc: None,
            user: Some(&nameless),
            image_ca_bundle: None,
        });
        assert_eq!(env["HOME"], "/tmp");
        assert!(!env.contains_key("USER"));

        let chosen = self::parent(&[
            ("HOME", "/workspace/.agent-home"),
            ("COGNIA_SANDBOXD_PROVIDED_ENV", "HOME"),
        ]);
        let env = build_child_env(&ChildEnvInput {
            parent: &chosen,
            layout: &layout,
            libc: None,
            user: Some(&user),
            image_ca_bundle: None,
        });
        assert_eq!(env["HOME"], "/workspace/.agent-home");
    }

    #[test]
    fn the_credential_list_matches_the_cli_launcher() {
        let launcher = include_str!("../../../cli/src/x/agent-launcher.ts");
        let start = launcher
            .find("export const AMBIENT_CREDENTIAL_ENV")
            .expect("launcher still exports the list");
        let block = &launcher[start..];
        // Skip the `readonly string[]` annotation: the list starts after `= [`.
        let block = &block[block.find("= [").expect("list literal") + 3..];
        let block = &block[..block.find(']').expect("list is closed")];
        let names: Vec<&str> = block.split('"').skip(1).step_by(2).collect();
        assert_eq!(names, AMBIENT_CREDENTIAL_ENV);
    }
}
