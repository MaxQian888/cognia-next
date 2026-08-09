//! Client registry for local proxy software discovery.
//!
//! Each entry describes one desktop proxy client we know how to find:
//! which process names it runs under, where its config lives on disk, and
//! which loopback ports / controller endpoints it uses by default. The
//! `detect.rs` pipeline combines three evidence layers per client:
//!
//!   1. process snapshot — is the client running right now?
//!   2. config file      — what ports did the user actually configure?
//!   3. protocol verify  — can it complete a real CONNECT handshake to a
//!      temporary local target? (done by detect.rs)
//!
//! Config parsing is deliberately tolerant: we only ever need a handful of
//! top-level scalar keys, so instead of pulling in a YAML dependency
//! (`serde_yaml` is archived; `gray_matter` is front-matter-only) we scan
//! lines for `key: value` at column 0. All readers swallow errors and fall
//! back to defaults — discovery must never fail the `proxy_detect` command.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::detect::CandidateKind;

/// Stable client identifier. Serialized as kebab-case strings that the TS
/// `ProxyClientId` union in `types/network/proxy.ts` mirrors exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClientId {
    #[serde(rename = "flclash")]
    Flclash,
    #[serde(rename = "clash-verge-rev")]
    ClashVergeRev,
    #[serde(rename = "mihomo")]
    Mihomo,
    #[serde(rename = "v2rayn")]
    V2rayn,
}

/// A Clash-style RESTful controller endpoint (`external-controller`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ControllerEndpoint {
    pub host: String,
    pub port: u16,
}

/// Static facts about one client. `process_names` are stored lowercase and
/// matched against a lowercased process snapshot.
pub struct ClientDef {
    pub id: ClientId,
    pub name: &'static str,
    pub process_names: &'static [&'static str],
    pub default_ports: &'static [(u16, CandidateKind)],
    pub default_controllers: &'static [(&'static str, u16)],
}

/// Ports + controller endpoints extracted from a client's on-disk config.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ClientConfig {
    pub ports: Vec<(u16, CandidateKind)>,
    pub controllers: Vec<ControllerEndpoint>,
}

impl ClientConfig {
    pub fn is_empty(&self) -> bool {
        self.ports.is_empty() && self.controllers.is_empty()
    }
}

/// Registry order is the UI presentation order — keep it deterministic.
///
/// v2rayN is process+defaults only: it is a portable install whose
/// `guiConfigs` directory sits next to an exe we cannot locate, so config
/// reading is out of scope by design. Bare core names (`xray`, `v2ray`,
/// `sing-box`) are deliberately not matched — too ambiguous.
pub const REGISTRY: &[ClientDef] = &[
    ClientDef {
        id: ClientId::Flclash,
        name: "FlClash",
        process_names: &["flclash.exe", "flclash"],
        default_ports: &[(7890, CandidateKind::Http)],
        default_controllers: &[("127.0.0.1", 9090)],
    },
    ClientDef {
        id: ClientId::ClashVergeRev,
        name: "Clash Verge Rev",
        process_names: &[
            "clash-verge.exe",
            "clash-verge",
            "clash verge.exe",
            "clash verge",
            "verge-mihomo.exe",
            "verge-mihomo",
            "verge-mihomo-alpha.exe",
            "verge-mihomo-alpha",
        ],
        default_ports: &[(7897, CandidateKind::Http)],
        default_controllers: &[("127.0.0.1", 9097)],
    },
    ClientDef {
        id: ClientId::Mihomo,
        name: "Mihomo",
        process_names: &["mihomo.exe", "mihomo", "clash.exe", "clash", "clash-meta"],
        default_ports: &[(7890, CandidateKind::Http), (7891, CandidateKind::Socks5)],
        default_controllers: &[("127.0.0.1", 9090)],
    },
    ClientDef {
        id: ClientId::V2rayn,
        name: "v2rayN",
        process_names: &["v2rayn.exe", "v2rayn"],
        default_ports: &[(10808, CandidateKind::Socks5), (10809, CandidateKind::Http)],
        default_controllers: &[],
    },
];

/// Look up a registry entry by id. Every `ClientId` variant has exactly one
/// entry (covered by the `registry_ids_unique_and_complete` test).
pub fn client_def(id: ClientId) -> &'static ClientDef {
    REGISTRY
        .iter()
        .find(|d| d.id == id)
        .expect("every ClientId has a registry entry")
}

/// Position of a client in `REGISTRY` — the primary sort key for candidate
/// ordering in `detect.rs`.
pub fn registry_index(id: ClientId) -> usize {
    REGISTRY
        .iter()
        .position(|d| d.id == id)
        .unwrap_or(usize::MAX)
}

// ---------------------------------------------------------------------------
// Per-client config file locations
// ---------------------------------------------------------------------------

/// FlClash persists its Flutter `shared_preferences.json` (which embeds the
/// `ClashConfig` with `mixedPort`) under the app-support dir
/// `com.follow.clash`: `%APPDATA%` on Windows, `~/Library/Application
/// Support` on macOS, `~/.local/share` on Linux.
fn flclash_config_paths() -> Vec<PathBuf> {
    base_dirs()
        .into_iter()
        .map(|d| d.join("com.follow.clash").join("shared_preferences.json"))
        .collect()
}

/// Clash Verge Rev (Tauri app) keeps `verge.yaml` + `config.yaml` in its
/// app-dir `io.github.clash-verge-rev.clash-verge-rev`.
fn clash_verge_config_dirs() -> Vec<PathBuf> {
    base_dirs()
        .into_iter()
        .map(|d| d.join("io.github.clash-verge-rev.clash-verge-rev"))
        .collect()
}

/// Bare mihomo reads `~/.config/mihomo/config.yaml` by default (same path
/// convention on Windows via `%USERPROFILE%\.config`).
fn mihomo_config_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = dirs::home_dir() {
        out.push(home.join(".config").join("mihomo").join("config.yaml"));
    }
    if let Some(cfg) = dirs::config_dir() {
        out.push(cfg.join("mihomo").join("config.yaml"));
    }
    out.dedup();
    out
}

/// Platform data/config base dirs, deduped (they coincide on Windows where
/// both resolve to roaming `%APPDATA%`).
fn base_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = dirs::data_dir() {
        out.push(d);
    }
    if let Some(d) = dirs::config_dir() {
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Tolerant extractors
// ---------------------------------------------------------------------------

/// Extract a top-level scalar from a YAML document without a YAML parser:
/// matches `key:` at column 0, strips quotes and trailing `# comment`.
/// Good enough for the flat keys we need (`mixed-port`, `verge_mixed_port`,
/// `external-controller`, ...) and resilient to documents we cannot fully
/// parse.
pub fn yaml_top_level_scalar(content: &str, key: &str) -> Option<String> {
    for line in content.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            continue; // nested key — not top-level
        }
        let line = line.trim_end_matches('\r');
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let Some(rest) = rest.strip_prefix(':') else {
            continue; // longer key sharing the prefix, e.g. `port-pool:`
        };
        let mut value = rest.trim();
        if let Some(hash) = comment_start(value) {
            value = value[..hash].trim_end();
        }
        let value = value.trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            return None;
        }
        return Some(value.to_string());
    }
    None
}

/// Index of an inline `#` comment: at value start or preceded by whitespace
/// (so `host#name` style values survive).
fn comment_start(value: &str) -> Option<usize> {
    if value.starts_with('#') {
        return Some(0);
    }
    value
        .match_indices('#')
        .find(|(i, _)| value[..*i].ends_with(char::is_whitespace))
        .map(|(i, _)| i)
}

/// FlClash's `shared_preferences.json` stores the `ClashConfig` either as
/// nested JSON or as a stringified-JSON value (Flutter shared_preferences
/// serializes complex values to strings). Try structured recursion first,
/// then a tolerant text scan over the raw and backslash-unescaped content.
/// Port 0 means "disabled" in FlClash and is never returned.
pub fn extract_flclash_mixed_port(raw: &str) -> Option<u16> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(port) = find_mixed_port(&value) {
            return Some(port);
        }
    }
    scan_mixed_port(raw).or_else(|| scan_mixed_port(&raw.replace("\\\"", "\"")))
}

/// Depth-first search for a non-zero numeric `"mixedPort"`; string values
/// that themselves parse as JSON are recursed into.
fn find_mixed_port(value: &serde_json::Value) -> Option<u16> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(port) = map.get("mixedPort").and_then(nonzero_port) {
                return Some(port);
            }
            map.values().find_map(find_mixed_port)
        }
        serde_json::Value::Array(items) => items.iter().find_map(find_mixed_port),
        serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(s)
            .ok()
            .as_ref()
            .and_then(find_mixed_port),
        _ => None,
    }
}

fn nonzero_port(value: &serde_json::Value) -> Option<u16> {
    let n = value.as_u64()?;
    let port = u16::try_from(n).ok()?;
    (port > 0).then_some(port)
}

/// Text-scan fallback for `"mixedPort": <digits>` when the document (or an
/// embedded fragment) is not valid JSON as a whole.
fn scan_mixed_port(text: &str) -> Option<u16> {
    const NEEDLE: &str = "\"mixedPort\"";
    let mut search = text;
    while let Some(idx) = search.find(NEEDLE) {
        let rest = search[idx + NEEDLE.len()..].trim_start();
        if let Some(rest) = rest.strip_prefix(':') {
            let rest = rest.trim_start();
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if let Ok(port) = digits.parse::<u16>() {
                if port > 0 {
                    return Some(port);
                }
            }
        }
        search = &search[idx + NEEDLE.len()..];
    }
    None
}

/// Parse a Clash `external-controller` value (`host:port`, `:port`, or
/// `0.0.0.0:port`) into a loopback-reachable endpoint.
pub fn parse_controller(value: &str) -> Option<ControllerEndpoint> {
    let v = value.trim().trim_start_matches("http://");
    let (host, port) = v.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    if port == 0 {
        return None;
    }
    let host = host.trim();
    let host = if host.is_empty() || host == "0.0.0.0" || host == "::" || host == "[::]" {
        "127.0.0.1"
    } else {
        host
    };
    Some(ControllerEndpoint {
        host: host.to_string(),
        port,
    })
}

fn parse_port(value: &str) -> Option<u16> {
    let port: u16 = value.trim().parse().ok()?;
    (port > 0).then_some(port)
}

// ---------------------------------------------------------------------------
// Per-client config readers — first existing + parsable location wins; all
// errors degrade to `ClientConfig::default()`.
// ---------------------------------------------------------------------------

fn read_flclash(paths: &[PathBuf]) -> ClientConfig {
    for path in paths {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        if let Some(port) = extract_flclash_mixed_port(&raw) {
            // FlClash's external controller is off by default and its status
            // lives in the same opaque blob; rely on the registry default
            // (9090) probed by detect.rs instead of guessing here.
            return ClientConfig {
                ports: vec![(port, CandidateKind::Http)],
                controllers: Vec::new(),
            };
        }
    }
    ClientConfig::default()
}

fn read_clash_verge(config_dirs: &[PathBuf]) -> ClientConfig {
    for dir in config_dirs {
        let verge = std::fs::read_to_string(dir.join("verge.yaml")).ok();
        let core = std::fs::read_to_string(dir.join("config.yaml")).ok();
        if verge.is_none() && core.is_none() {
            continue;
        }
        let mut cfg = ClientConfig::default();
        // verge.yaml's verge_mixed_port is the user-facing setting; the core
        // config.yaml mixed-port is the value actually pushed to mihomo.
        let mixed = verge
            .as_deref()
            .and_then(|c| yaml_top_level_scalar(c, "verge_mixed_port"))
            .or_else(|| {
                core.as_deref()
                    .and_then(|c| yaml_top_level_scalar(c, "mixed-port"))
            })
            .and_then(|v| parse_port(&v));
        if let Some(port) = mixed {
            cfg.ports.push((port, CandidateKind::Http));
        }
        if let Some(endpoint) = core
            .as_deref()
            .and_then(|c| yaml_top_level_scalar(c, "external-controller"))
            .and_then(|v| parse_controller(&v))
        {
            cfg.controllers.push(endpoint);
        }
        if !cfg.is_empty() {
            return cfg;
        }
    }
    ClientConfig::default()
}

fn read_mihomo(paths: &[PathBuf]) -> ClientConfig {
    for path in paths {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let mut cfg = ClientConfig::default();
        for (key, kind) in [
            ("mixed-port", CandidateKind::Http),
            ("port", CandidateKind::Http),
            ("socks-port", CandidateKind::Socks5),
        ] {
            if let Some(port) = yaml_top_level_scalar(&raw, key).and_then(|v| parse_port(&v)) {
                if !cfg.ports.iter().any(|(existing, _)| *existing == port) {
                    cfg.ports.push((port, kind));
                }
            }
        }
        if let Some(endpoint) =
            yaml_top_level_scalar(&raw, "external-controller").and_then(|v| parse_controller(&v))
        {
            cfg.controllers.push(endpoint);
        }
        if !cfg.is_empty() {
            return cfg;
        }
    }
    ClientConfig::default()
}

/// Read a client's on-disk config from its platform-default locations.
pub fn read_client_config(id: ClientId) -> ClientConfig {
    match id {
        ClientId::Flclash => read_flclash(&flclash_config_paths()),
        ClientId::ClashVergeRev => read_clash_verge(&clash_verge_config_dirs()),
        ClientId::Mihomo => read_mihomo(&mihomo_config_paths()),
        ClientId::V2rayn => ClientConfig::default(),
    }
}

/// Combine the process snapshot with config reads. Configs are read
/// unconditionally for config-capable clients — on Linux the kernel truncates
/// reported process names to ~15 chars, so a missed process match must not
/// hide a configured client. An entry is returned when either signal fired.
pub fn discover(running_lower: &HashSet<String>) -> Vec<(ClientId, ClientConfig, bool)> {
    REGISTRY
        .iter()
        .filter_map(|def| {
            let process_matched = def
                .process_names
                .iter()
                .any(|name| running_lower.contains(*name));
            let cfg = read_client_config(def.id);
            (process_matched || !cfg.is_empty()).then_some((def.id, cfg, process_matched))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- registry invariants -------------------------------------------------

    #[test]
    fn registry_ids_unique_and_complete() {
        let ids: HashSet<_> = REGISTRY.iter().map(|d| format!("{:?}", d.id)).collect();
        assert_eq!(ids.len(), REGISTRY.len());
        // Every variant resolves to a def without panicking.
        for id in [
            ClientId::Flclash,
            ClientId::ClashVergeRev,
            ClientId::Mihomo,
            ClientId::V2rayn,
        ] {
            let def = client_def(id);
            assert_eq!(def.id, id);
            assert!(registry_index(id) < REGISTRY.len());
        }
    }

    #[test]
    fn registry_process_names_are_lowercase() {
        // Matching lowercases the snapshot only — names must already be lower.
        for def in REGISTRY {
            for name in def.process_names {
                assert_eq!(*name, name.to_lowercase(), "in {}", def.name);
            }
        }
    }

    #[test]
    fn registry_default_ports_nonzero() {
        for def in REGISTRY {
            for (port, _) in def.default_ports {
                assert!(*port > 0, "in {}", def.name);
            }
        }
    }

    #[test]
    fn client_id_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ClientId::ClashVergeRev).unwrap(),
            "\"clash-verge-rev\""
        );
        assert_eq!(
            serde_json::to_string(&ClientId::Flclash).unwrap(),
            "\"flclash\""
        );
    }

    // -- yaml_top_level_scalar ----------------------------------------------

    #[test]
    fn yaml_scalar_basic_and_quoted() {
        let doc = "mixed-port: 7897\nexternal-controller: \"127.0.0.1:9097\"\n";
        assert_eq!(
            yaml_top_level_scalar(doc, "mixed-port").as_deref(),
            Some("7897")
        );
        assert_eq!(
            yaml_top_level_scalar(doc, "external-controller").as_deref(),
            Some("127.0.0.1:9097")
        );
    }

    #[test]
    fn yaml_scalar_strips_trailing_comment() {
        let doc = "mixed-port: 7890 # the mixed port\n";
        assert_eq!(
            yaml_top_level_scalar(doc, "mixed-port").as_deref(),
            Some("7890")
        );
    }

    #[test]
    fn yaml_scalar_ignores_indented_keys() {
        let doc = "tun:\n  mixed-port: 9999\n";
        assert_eq!(yaml_top_level_scalar(doc, "mixed-port"), None);
    }

    #[test]
    fn yaml_scalar_rejects_longer_keys_sharing_prefix() {
        let doc = "port-pool: 1234\nsocks-port: 7891\n";
        assert_eq!(yaml_top_level_scalar(doc, "port"), None);
        assert_eq!(
            yaml_top_level_scalar(doc, "socks-port").as_deref(),
            Some("7891")
        );
    }

    #[test]
    fn yaml_scalar_handles_crlf_and_single_quotes() {
        let doc = "verge_mixed_port: '7897'\r\nother: x\r\n";
        assert_eq!(
            yaml_top_level_scalar(doc, "verge_mixed_port").as_deref(),
            Some("7897")
        );
    }

    #[test]
    fn yaml_scalar_none_for_missing_or_empty() {
        assert_eq!(yaml_top_level_scalar("a: 1\n", "missing"), None);
        assert_eq!(yaml_top_level_scalar("key: # only comment\n", "key"), None);
    }

    // -- extract_flclash_mixed_port -------------------------------------------

    #[test]
    fn flclash_port_from_nested_json() {
        let raw = r#"{"flutter.config":{"patchClashConfig":{"mixedPort":17890}}}"#;
        assert_eq!(extract_flclash_mixed_port(raw), Some(17890));
    }

    #[test]
    fn flclash_port_from_stringified_json_value() {
        // shared_preferences stores complex values as JSON-encoded strings.
        let raw = r#"{"flutter.config":"{\"patchClashConfig\":{\"mixedPort\":7895}}"}"#;
        assert_eq!(extract_flclash_mixed_port(raw), Some(7895));
    }

    #[test]
    fn flclash_port_text_fallback_on_malformed_json() {
        let raw = r#"garbage {"mixedPort": 7893 trailing"#;
        assert_eq!(extract_flclash_mixed_port(raw), Some(7893));
    }

    #[test]
    fn flclash_port_text_fallback_on_escaped_fragment() {
        let raw = r#"not-json \"mixedPort\":7894 tail"#;
        assert_eq!(extract_flclash_mixed_port(raw), Some(7894));
    }

    #[test]
    fn flclash_port_skips_zero_and_absent() {
        assert_eq!(extract_flclash_mixed_port(r#"{"mixedPort":0}"#), None);
        assert_eq!(extract_flclash_mixed_port(r#"{"port":7890}"#), None);
        assert_eq!(extract_flclash_mixed_port("not json at all"), None);
    }

    #[test]
    fn flclash_port_in_array_nesting() {
        let raw = r#"{"profiles":[{"clash":{"mixedPort":7899}}]}"#;
        assert_eq!(extract_flclash_mixed_port(raw), Some(7899));
    }

    // -- parse_controller ------------------------------------------------------

    #[test]
    fn controller_parses_host_port() {
        assert_eq!(
            parse_controller("127.0.0.1:9097"),
            Some(ControllerEndpoint {
                host: "127.0.0.1".to_string(),
                port: 9097
            })
        );
    }

    #[test]
    fn controller_defaults_loopback_for_bare_or_wildcard_host() {
        for input in [":9090", "0.0.0.0:9090", "[::]:9090"] {
            let ep = parse_controller(input).unwrap();
            assert_eq!(ep.host, "127.0.0.1", "input {input}");
            assert_eq!(ep.port, 9090);
        }
    }

    #[test]
    fn controller_rejects_garbage_and_zero_port() {
        assert_eq!(parse_controller("no-port-here"), None);
        assert_eq!(parse_controller("127.0.0.1:0"), None);
        assert_eq!(parse_controller("127.0.0.1:notaport"), None);
    }

    // -- readers (tempdir fixtures) -------------------------------------------

    #[test]
    fn read_flclash_returns_port_from_fixture() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared_preferences.json");
        std::fs::write(&path, r#"{"flutter.config":{"mixedPort":17890}}"#).unwrap();
        let cfg = read_flclash(&[path]);
        assert_eq!(cfg.ports, vec![(17890, CandidateKind::Http)]);
        assert!(cfg.controllers.is_empty());
    }

    #[test]
    fn read_flclash_default_when_missing_or_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.json");
        assert!(read_flclash(&[missing]).is_empty());
        let zero = dir.path().join("zero.json");
        std::fs::write(&zero, r#"{"mixedPort":0}"#).unwrap();
        assert!(read_flclash(&[zero]).is_empty());
    }

    #[test]
    fn read_clash_verge_combines_verge_and_core_yaml() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("verge.yaml"), "verge_mixed_port: 7897\n").unwrap();
        std::fs::write(
            dir.path().join("config.yaml"),
            "mixed-port: 7897\nexternal-controller: 127.0.0.1:9097\n",
        )
        .unwrap();
        let cfg = read_clash_verge(&[dir.path().to_path_buf()]);
        assert_eq!(cfg.ports, vec![(7897, CandidateKind::Http)]);
        assert_eq!(
            cfg.controllers,
            vec![ControllerEndpoint {
                host: "127.0.0.1".to_string(),
                port: 9097
            }]
        );
    }

    #[test]
    fn read_clash_verge_falls_back_to_core_mixed_port() {
        let dir = tempfile::tempdir().unwrap();
        // No verge.yaml — mixed-port comes from config.yaml.
        std::fs::write(dir.path().join("config.yaml"), "mixed-port: 17897\n").unwrap();
        let cfg = read_clash_verge(&[dir.path().to_path_buf()]);
        assert_eq!(cfg.ports, vec![(17897, CandidateKind::Http)]);
    }

    #[test]
    fn read_clash_verge_default_when_dir_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("not-there");
        assert!(read_clash_verge(&[missing]).is_empty());
    }

    #[test]
    fn read_mihomo_extracts_all_port_kinds_and_controller() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(
            &path,
            "mixed-port: 7890\nport: 7892\nsocks-port: 7891\nexternal-controller: :9090\n",
        )
        .unwrap();
        let cfg = read_mihomo(&[path]);
        assert_eq!(
            cfg.ports,
            vec![
                (7890, CandidateKind::Http),
                (7892, CandidateKind::Http),
                (7891, CandidateKind::Socks5),
            ]
        );
        assert_eq!(cfg.controllers[0].port, 9090);
    }

    #[test]
    fn read_mihomo_dedups_equal_ports() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        std::fs::write(&path, "mixed-port: 7890\nport: 7890\n").unwrap();
        let cfg = read_mihomo(&[path]);
        assert_eq!(cfg.ports.len(), 1);
    }

    #[test]
    fn read_mihomo_default_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_mihomo(&[dir.path().join("config.yaml")]).is_empty());
    }

    // -- discover ----------------------------------------------------------------

    #[test]
    fn discover_includes_process_matched_client() {
        let running: HashSet<String> = ["flclash.exe".to_string()].into_iter().collect();
        let result = discover(&running);
        let flclash = result
            .iter()
            .find(|(id, _, _)| *id == ClientId::Flclash)
            .expect("flclash entry present");
        assert!(flclash.2, "process_matched flag set");
    }

    #[test]
    fn discover_entries_are_registry_subset_in_order() {
        let result = discover(&HashSet::new());
        let mut last_idx = 0usize;
        for (id, cfg, matched) in &result {
            let idx = registry_index(*id);
            assert!(idx >= last_idx, "registry order preserved");
            last_idx = idx;
            // Without a process match the entry must carry config evidence.
            assert!(*matched || !cfg.is_empty());
        }
    }

    #[test]
    fn discover_matches_case_insensitively_via_lowered_snapshot() {
        // The caller lowercases the snapshot; "FlClash.exe" arrives lowered.
        let running: HashSet<String> = ["FlClash.exe".to_lowercase()].into_iter().collect();
        let result = discover(&running);
        assert!(result
            .iter()
            .any(|(id, _, m)| *id == ClientId::Flclash && *m));
    }

    #[test]
    fn client_config_is_empty_helper() {
        assert!(ClientConfig::default().is_empty());
        let cfg = ClientConfig {
            ports: vec![(1, CandidateKind::Http)],
            controllers: Vec::new(),
        };
        assert!(!cfg.is_empty());
    }
}
