//! Which bundled file a spawn runs (ADR-0183).
//!
//! A preset names its agent the way a host with the CLI installed would: a
//! bare command (`claude-agent-acp`) or `npx -y <package>` (codex-acp, Gemini
//! CLI, Qwen Code). Inside a sandbox neither is looked up on `PATH` or
//! downloaded — the image's `PATH` belongs to the project, and a download at
//! start would make the running version depend on when the sandbox started.
//! Both forms map onto a command the probe reported for the image's libc, and
//! anything else is refused.

use cognia_sandboxd::manifest::BundleCommand;

/// A command resolved against the bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledInvocation {
    /// The file name under `<libc>/bin/`.
    pub name: String,
    pub args: Vec<String>,
}

/// `command args` as the bundle runs it, or `None` when the bundle has no
/// such command for this image.
pub fn bundled_invocation(
    command: &str,
    args: &[String],
    available: &[BundleCommand],
) -> Option<BundledInvocation> {
    if command == "npx" {
        return npx_invocation(args, available);
    }
    available
        .iter()
        .find(|candidate| candidate.name == command)
        .map(|found| BundledInvocation {
            name: found.name.clone(),
            args: args.to_vec(),
        })
}

/// `npx [-y|--yes]… <package>[@version] args…`. The requested version is
/// ignored on purpose: the bundle pins one version per release, and running
/// that pin instead of a floating tag is the point of bundling.
fn npx_invocation(args: &[String], available: &[BundleCommand]) -> Option<BundledInvocation> {
    let mut rest = args.iter();
    let spec = loop {
        let arg = rest.next()?;
        match arg.as_str() {
            "-y" | "--yes" => continue,
            // Any other npx option (`--package`, `-c`) changes what runs; a
            // spawn that needs one is not something the bundle can stand in for.
            other if other.starts_with('-') => return None,
            other => break other,
        }
    };
    let package = package_name(spec);
    available
        .iter()
        .find(|candidate| candidate.package.as_deref() == Some(package))
        .map(|found| BundledInvocation {
            name: found.name.clone(),
            args: rest.cloned().collect(),
        })
}

/// `@scope/name@1.2.3` → `@scope/name`; `name@latest` → `name`.
fn package_name(spec: &str) -> &str {
    let search_from = if spec.starts_with('@') {
        spec.find('/').map(|slash| slash + 1).unwrap_or(spec.len())
    } else {
        0
    };
    match spec[search_from..].find('@') {
        Some(at) => &spec[..search_from + at],
        None => spec,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commands() -> Vec<BundleCommand> {
        vec![
            BundleCommand {
                name: "claude-agent-acp".into(),
                package: Some("@agentclientprotocol/claude-agent-acp".into()),
            },
            BundleCommand {
                name: "codex-acp".into(),
                package: Some("@agentclientprotocol/codex-acp".into()),
            },
            BundleCommand {
                name: "opencode".into(),
                package: Some("opencode-ai".into()),
            },
            BundleCommand {
                name: "kiro-cli".into(),
                package: None,
            },
        ]
    }

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn a_bare_command_runs_the_bundled_file_with_its_arguments() {
        assert_eq!(
            bundled_invocation("kiro-cli", &args(&["acp"]), &commands()),
            Some(BundledInvocation {
                name: "kiro-cli".into(),
                args: args(&["acp"]),
            })
        );
        assert_eq!(bundled_invocation("gemini", &[], &commands()), None);
    }

    #[test]
    fn npx_maps_its_package_onto_the_pinned_command() {
        for spelling in [
            args(&["-y", "@agentclientprotocol/codex-acp", "--stdio"]),
            args(&["--yes", "@agentclientprotocol/codex-acp@0.9.0", "--stdio"]),
            args(&["@agentclientprotocol/codex-acp@latest", "--stdio"]),
        ] {
            assert_eq!(
                bundled_invocation("npx", &spelling, &commands()),
                Some(BundledInvocation {
                    name: "codex-acp".into(),
                    args: args(&["--stdio"]),
                }),
                "{spelling:?}"
            );
        }
        assert_eq!(
            bundled_invocation("npx", &args(&["-y", "opencode-ai@1.0", "acp"]), &commands())
                .unwrap()
                .name,
            "opencode"
        );
    }

    #[test]
    fn npx_refuses_what_the_bundle_cannot_stand_in_for() {
        for refused in [
            args(&[]),
            args(&["-y"]),
            args(&["-y", "@zed-industries/codex-acp"]),
            args(&["--package", "@agentclientprotocol/codex-acp", "codex-acp"]),
            args(&["-c", "codex-acp"]),
        ] {
            assert_eq!(
                bundled_invocation("npx", &refused, &commands()),
                None,
                "{refused:?}"
            );
        }
        // A vendor binary has no package, so no npx spelling reaches it.
        assert_eq!(
            bundled_invocation("npx", &args(&["kiro-cli"]), &commands()),
            None
        );
    }

    #[test]
    fn package_names_lose_only_their_version() {
        assert_eq!(package_name("@scope/name@1.2.3"), "@scope/name");
        assert_eq!(package_name("@scope/name"), "@scope/name");
        assert_eq!(package_name("name@latest"), "name");
        assert_eq!(package_name("name"), "name");
        assert_eq!(package_name("@scope"), "@scope");
    }
}
