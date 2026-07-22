//! OpenAPI ↔ KNOWN_COMMANDS parity gate (Wave 3.6).
//!
//! Failing this test means the spec (`docs/api/mobile-companion-api.openapi.yaml`)
//! and the runtime allowlist (`super::rpc::KNOWN_COMMANDS`) have drifted —
//! either a new RPC was added without updating the spec, or a spec entry
//! was removed without removing the dispatch arm. CI catches both
//! directions before either side ships in isolation.
//!
//! We scan the YAML by string match (no `openapiv3` crate dep) for paths
//! shaped `/api/v1/_rpc/<name>:`. That keeps the test fast and avoids
//! pulling in another crate just for one test gate.

#[cfg(test)]
mod tests {
    use crate::companion_api::rpc::known_commands;
    use std::collections::HashSet;

    fn read_spec() -> String {
        // Embed the spec at compile time so the test is hermetic — no
        // dependence on `cargo test`'s working directory.
        include_str!("../../../docs/api/mobile-companion-api.openapi.yaml").to_string()
    }

    fn extract_rpc_names(spec: &str) -> HashSet<String> {
        let mut names = HashSet::new();
        for line in spec.lines() {
            // Looking for path keys like `  /api/v1/_rpc/<name>:`. Matches
            // leading whitespace + `/api/v1/_rpc/` + a snake_case name +
            // optional trailing `:`.
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("/api/v1/_rpc/") {
                let stop = rest.find(|c: char| c == ':' || c == '/' || c.is_whitespace());
                let name = match stop {
                    Some(idx) => &rest[..idx],
                    None => rest,
                };
                // Skip the wire-true wildcard template `/api/v1/_rpc/{name}`:
                // it documents the single dispatch route, not a concrete
                // command, so it has no `KNOWN_COMMANDS` entry by design.
                if !name.is_empty() && !name.starts_with('{') {
                    names.insert(name.to_string());
                }
            }
        }
        names
    }

    #[test]
    fn every_known_command_appears_in_the_openapi_spec() {
        let spec = read_spec();
        let spec_names = extract_rpc_names(&spec);
        let known: HashSet<&'static str> = known_commands().iter().copied().collect();

        // Some Wave 3 / Wave 5 commands intentionally have no spec entry
        // yet — they're dispatcher-internal helpers. List them here when
        // the divergence is decided. Keep this list short or extend the
        // spec instead.
        // The host-neutral browser RPC family (ADR-0085) is served through its
        // typed gateway but intentionally awaits a dedicated public-spec pass.
        // Keep the exemption derived from the gateway's canonical list so a
        // newly routed browser command cannot fail this gate merely because a
        // second hand-maintained subset drifted.
        let mut allowed_missing: HashSet<&'static str> =
            crate::companion_api::browser_gateway::BROWSER_RPC_COMMANDS
                .iter()
                .copied()
                .collect();
        // These are service-token-only brain internals, not paired-device API.
        // They are allowlisted for the shared dispatcher but deliberately
        // absent from the public mobile Companion specification.
        allowed_missing.extend([
            "plugin_launch_js",
            "plugin_invoke_js_callback",
            "plugin_deactivate_js",
            "plugin_stop_js",
            "plugin_js_status",
        ]);

        let mut missing: Vec<&str> = Vec::new();
        for cmd in &known {
            if allowed_missing.contains(cmd) {
                continue;
            }
            if !spec_names.contains(*cmd) {
                missing.push(*cmd);
            }
        }

        if !missing.is_empty() {
            panic!(
                "OpenAPI parity drift — these KNOWN_COMMANDS lack a `/api/v1/_rpc/<name>` path \
                 in the spec:\n  {missing:#?}\nUpdate \
                 docs/api/mobile-companion-api.openapi.yaml or add to allowed_missing."
            );
        }
    }

    #[test]
    fn extract_rpc_names_picks_up_at_least_one_command() {
        // Sanity check the extractor itself — if the spec ever stops
        // exposing /api/v1/_rpc/<name> paths the parity test below
        // becomes vacuously true.
        let spec = read_spec();
        let names = extract_rpc_names(&spec);
        assert!(
            names.len() >= 5,
            "expected at least 5 RPC paths in the spec, found {}",
            names.len()
        );
    }

    /// Wave 3.8 — reverse direction: every spec-listed RPC must have a
    /// matching dispatch arm in `KNOWN_COMMANDS`. Drift in this
    /// direction means the spec promised an endpoint we don't actually
    /// serve, which would surface to mobile clients as a confusing 404.
    #[test]
    fn every_spec_rpc_has_a_known_command() {
        let spec = read_spec();
        let spec_names = extract_rpc_names(&spec);
        let known: HashSet<&'static str> = known_commands().iter().copied().collect();

        // Spec endpoints that exist for documentation but are
        // intentionally not dispatchable (e.g., grouped under a
        // sub-server). Empty for now — fill in when needed.
        let allowed_extra: HashSet<&'static str> = HashSet::new();

        let mut extra: Vec<String> = Vec::new();
        for name in &spec_names {
            if allowed_extra.contains(name.as_str()) {
                continue;
            }
            if !known.contains(name.as_str()) {
                extra.push(name.clone());
            }
        }

        if !extra.is_empty() {
            panic!(
                "OpenAPI parity drift — these spec-listed RPCs lack a \
                 dispatch arm in `KNOWN_COMMANDS`:\n  {extra:#?}\n\
                 Either add the dispatch arm in rpc.rs or drop the \
                 spec entry / add to allowed_extra."
            );
        }
    }
}
