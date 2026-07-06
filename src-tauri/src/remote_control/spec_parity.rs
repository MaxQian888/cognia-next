//! OpenAPI ↔ KNOWN_TARGETS parity gate.
//!
//! Failing this test means the generic command surface drifted: either a new
//! target was added to `server::KNOWN_TARGETS` without updating the
//! `RemoteCommandTarget` enum in `docs/api/remote-control.openapi.yaml`, or a
//! spec enum value was added/removed without the matching dispatch arm. The
//! `RemoteCommandTarget` enum is the cross-language source of truth — the TS
//! union (`types/remote-control/index.ts`) is held to the same enum by
//! `types/remote-control/targets-parity.test.ts`, so transitively Rust ↔ TS
//! stay in sync.
//!
//! We scan the YAML by string match (no `openapiv3` crate dep): find the
//! `RemoteCommandTarget:` schema, then collect the `- value` items under its
//! `enum:` block. That keeps the test fast and hermetic.

#[cfg(test)]
mod tests {
    use crate::remote_control::server::known_targets;
    use std::collections::HashSet;

    fn read_spec() -> String {
        // Embed at compile time so the test is hermetic — independent of the
        // `cargo test` working directory.
        include_str!("../../../docs/api/remote-control.openapi.yaml").to_string()
    }

    /// Extract the enum values of the `RemoteCommandTarget` schema. Walks to the
    /// schema declaration, then to its `enum:` key, then collects subsequent
    /// `- <value>` list items until the dashed list ends.
    fn extract_target_enum(spec: &str) -> HashSet<String> {
        let mut names = HashSet::new();
        let mut in_schema = false;
        let mut in_enum = false;
        for line in spec.lines() {
            let trimmed = line.trim();
            if !in_schema {
                if trimmed == "RemoteCommandTarget:" {
                    in_schema = true;
                }
                continue;
            }
            if !in_enum {
                if trimmed == "enum:" {
                    in_enum = true;
                }
                // A blank line or another schema key before `enum:` would mean a
                // malformed schema; keep scanning within the schema until enum.
                continue;
            }
            // Inside the enum list: collect `- value` items, stop at the first
            // non-list line (the next schema / key).
            if let Some(value) = trimmed.strip_prefix("- ") {
                names.insert(value.trim().to_string());
            } else if !trimmed.is_empty() {
                break;
            }
        }
        names
    }

    #[test]
    fn extractor_picks_up_the_target_enum() {
        let spec = read_spec();
        let names = extract_target_enum(&spec);
        assert!(
            names.len() >= 5,
            "expected the RemoteCommandTarget enum to list at least 5 targets, found {}: {names:?}",
            names.len()
        );
    }

    #[test]
    fn every_known_target_appears_in_the_openapi_enum() {
        let spec = read_spec();
        let enum_targets = extract_target_enum(&spec);
        let known: HashSet<&'static str> = known_targets().iter().copied().collect();

        let mut missing: Vec<&str> = Vec::new();
        for target in &known {
            if !enum_targets.contains(*target) {
                missing.push(target);
            }
        }

        assert!(
            missing.is_empty(),
            "OpenAPI parity drift — these KNOWN_TARGETS lack a `RemoteCommandTarget` enum entry \
             in docs/api/remote-control.openapi.yaml:\n  {missing:#?}"
        );
    }

    #[test]
    fn every_openapi_enum_target_has_a_known_target() {
        let spec = read_spec();
        let enum_targets = extract_target_enum(&spec);
        let known: HashSet<&'static str> = known_targets().iter().copied().collect();

        let mut extra: Vec<String> = Vec::new();
        for target in &enum_targets {
            if !known.contains(target.as_str()) {
                extra.push(target.clone());
            }
        }

        assert!(
            extra.is_empty(),
            "OpenAPI parity drift — these `RemoteCommandTarget` enum values lack a `KNOWN_TARGETS` \
             entry in server.rs (the server would 404 them):\n  {extra:#?}"
        );
    }
}
