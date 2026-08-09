//! Generated OpenAPI ↔ runtime command parity gates.
//!
//! The public device specification contains only HTTP commands that target the
//! execution or host-admin planes. The Headless specification contains every
//! command accepted by the shared Rust dispatcher. Both specifications are
//! embedded at compile time so the checks remain hermetic.

#[cfg(test)]
mod tests {
    use crate::companion_api::{
        command_manifest::{descriptor, CommandTarget, CommandTransport},
        rpc::known_commands,
    };
    use std::collections::HashSet;

    const PUBLIC_SPEC: &str = include_str!("../../../docs/api/mobile-companion-api.openapi.yaml");
    const HEADLESS_SPEC: &str = include_str!("../../../docs/api/headless-service-api.openapi.yaml");

    fn extract_rpc_names(spec: &str, prefix: &str) -> HashSet<String> {
        spec.lines()
            .filter_map(|line| {
                let rest = line.trim_start().strip_prefix(prefix)?;
                let stop = rest
                    .find(|character: char| {
                        character == ':' || character == '/' || character.is_whitespace()
                    })
                    .unwrap_or(rest.len());
                let name = &rest[..stop];
                (!name.is_empty() && !name.starts_with('{')).then(|| name.to_string())
            })
            .collect()
    }

    fn expected_public_commands() -> HashSet<String> {
        known_commands()
            .iter()
            .filter(|name| {
                descriptor(name).is_some_and(|command| {
                    matches!(
                        command.target,
                        CommandTarget::Execution | CommandTarget::HostAdmin
                    ) && command.transports.contains(&CommandTransport::Http)
                })
            })
            .map(|name| (*name).to_string())
            .collect()
    }

    fn expected_headless_commands() -> HashSet<String> {
        known_commands()
            .iter()
            .map(|name| (*name).to_string())
            .collect()
    }

    fn assert_same_commands(actual: HashSet<String>, expected: HashSet<String>, surface: &str) {
        let mut missing: Vec<_> = expected.difference(&actual).cloned().collect();
        let mut extra: Vec<_> = actual.difference(&expected).cloned().collect();
        missing.sort();
        extra.sort();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "{surface} OpenAPI command drift\nmissing: {missing:#?}\nextra: {extra:#?}"
        );
    }

    #[test]
    fn extractor_ignores_the_wildcard_dispatch_path() {
        let spec = "paths:\n  /api/_rpc/{name}:\n  /api/_rpc/session_list:\n";
        assert_eq!(
            extract_rpc_names(spec, "/api/_rpc/"),
            HashSet::from(["session_list".to_string()])
        );
    }

    #[test]
    fn public_spec_matches_device_reachable_dispatch_commands() {
        assert_same_commands(
            extract_rpc_names(PUBLIC_SPEC, "/api/_rpc/"),
            expected_public_commands(),
            "public device",
        );
    }

    #[test]
    fn headless_spec_matches_the_shared_dispatcher() {
        assert_same_commands(
            extract_rpc_names(HEADLESS_SPEC, "/internal/_rpc/"),
            expected_headless_commands(),
            "Headless service",
        );
    }
}
