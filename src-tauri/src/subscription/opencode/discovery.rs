// Read-only discovery of the OpenCode CLI's auth.json.
//
// Location: `~/.local/share/opencode/auth.json` on EVERY platform — the
// opencode CLI (Bun) uses the XDG-style path on Windows too (verified
// against a real Windows install 2026-06-07; `%LOCALAPPDATA%\opencode\` is
// NOT used, but we keep it as a fallback probe in case older builds or
// future versions move there).
//
// Override via the `OPENCODE_AUTH_PATH` env var (useful for testing and for
// users who symlink their auth.json into an alt location).
//
// Schema is open-ended on the upstream side — every provider entry is a free
// map under its provider id. We surface only the whitelisted set
// (`anthropic` / `openai` / `opencode` / `opencode-go` / `opencode-zen`) and
// return the verbatim JSON payload so the UI can render either an apiKey
// badge or an OAuth-token badge depending on the shape. Managed-plan entries
// look like `{"type":"api","key":"sk-..."}`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::is_whitelisted_sub_provider;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredOpencodeAuth {
    /// Resolved path that was read (or the path we *would* have read if it
    /// existed — useful for UI hints like "Drop your OpenCode auth.json into
    /// ~/.local/share/opencode/").
    pub auth_json_path: String,
    /// One row per whitelisted sub-provider that was actually present in
    /// auth.json. Empty when no whitelisted entries were found.
    pub entries: Vec<DiscoveredOpencodeEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredOpencodeEntry {
    /// Whitelist value: "anthropic" | "openai" | "opencode" | "opencode-go"
    /// | "opencode-zen".
    pub sub_provider: String,
    /// Variant of the entry: "api-key" when the row carries a literal API key
    /// field (`apiKey`/`api_key`/`key`, or `type: "api"` — the shape the
    /// managed Zen/Go plans use), "oauth" when it carries `type: "oauth"`,
    /// "unknown" otherwise.
    pub kind: String,
    /// Verbatim JSON object for this sub-provider as a string. The renderer
    /// inspects it to decide how to display the row (badges, redaction).
    pub payload_json: String,
}

/// Resolve the OpenCode auth.json path. Honors `OPENCODE_AUTH_PATH` first.
///
/// OpenCode uses `~/.local/share/opencode/auth.json` on EVERY platform —
/// Linux, macOS AND Windows (Bun's XDG-style data dir; verified against a
/// real Windows install). On Windows we additionally fall back to
/// `%LOCALAPPDATA%\opencode\auth.json` when the XDG path has no file, so a
/// hypothetical future relocation keeps working; when neither exists we
/// return the XDG path for the "we looked here" UI hint.
pub fn opencode_auth_file_path() -> Option<PathBuf> {
    if let Ok(s) = std::env::var("OPENCODE_AUTH_PATH") {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    let xdg = dirs::home_dir().map(|h| {
        h.join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json")
    });
    #[cfg(target_os = "windows")]
    {
        match xdg {
            Some(p) if p.is_file() => Some(p),
            xdg => {
                let local = dirs::data_local_dir().map(|d| d.join("opencode").join("auth.json"));
                match local {
                    Some(l) if l.is_file() => Some(l),
                    _ => xdg,
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        xdg
    }
}

/// Read auth.json and surface the whitelisted entries. Returns
/// `DiscoveredOpencodeAuth { entries: [] }` (rather than `None`) when the file
/// exists but has nothing whitelisted, so the UI can still show "we looked
/// here" guidance. Returns `Ok(None)` only when the path itself is
/// unresolvable (e.g. no home dir on a headless box).
pub fn discover_opencode_auth() -> Result<Option<DiscoveredOpencodeAuth>, String> {
    let path = match opencode_auth_file_path() {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_str = path.to_string_lossy().into_owned();

    if !path.is_file() {
        return Ok(Some(DiscoveredOpencodeAuth {
            auth_json_path: path_str,
            entries: Vec::new(),
        }));
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(Some(DiscoveredOpencodeAuth {
            auth_json_path: path_str,
            entries: Vec::new(),
        }));
    }

    // OpenCode auth.json is a flat object: { "<provider>": { ... }, ... }.
    let root: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {}", path.display(), e))?;
    let map = match root {
        serde_json::Value::Object(map) => map,
        other => {
            return Err(format!(
                "expected auth.json root to be an object, got {}",
                kind_name(&other)
            ));
        }
    };

    let mut entries = Vec::new();
    for (sub_provider, payload) in map {
        if !is_whitelisted_sub_provider(&sub_provider) {
            continue;
        }
        let payload_json = serde_json::to_string(&payload).unwrap_or_default();
        let kind = classify_entry(&payload);
        entries.push(DiscoveredOpencodeEntry {
            sub_provider,
            kind,
            payload_json,
        });
    }
    // Stable ordering: anthropic, openai, opencode-zen. Sort by the canonical
    // whitelist position so the UI is deterministic across runs.
    entries.sort_by_key(|e| whitelist_rank(&e.sub_provider));

    Ok(Some(DiscoveredOpencodeAuth {
        auth_json_path: path_str,
        entries,
    }))
}

fn classify_entry(payload: &serde_json::Value) -> String {
    let obj = match payload.as_object() {
        Some(o) => o,
        None => return "unknown".into(),
    };
    if let Some(serde_json::Value::String(t)) = obj.get("type") {
        if t == "oauth" {
            return "oauth".into();
        }
        // Managed Zen/Go plan entries: {"type":"api","key":"sk-..."}.
        if t == "api" {
            return "api-key".into();
        }
    }
    if obj.contains_key("apiKey") || obj.contains_key("api_key") || obj.contains_key("key") {
        return "api-key".into();
    }
    if obj.contains_key("access") || obj.contains_key("accessToken") {
        return "oauth".into();
    }
    "unknown".into()
}

fn whitelist_rank(name: &str) -> u8 {
    match name {
        "anthropic" => 0,
        "openai" => 1,
        "opencode" => 2,
        "opencode-go" => 3,
        "opencode-zen" => 4,
        _ => u8::MAX,
    }
}

fn kind_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Set `OPENCODE_AUTH_PATH` to a temp file, run the closure, restore env.
    fn with_auth_file<F: FnOnce(&std::path::Path)>(contents: &str, f: F) {
        let tmp = tempfile::tempdir().unwrap();
        let auth = tmp.path().join("auth.json");
        fs::write(&auth, contents).unwrap();
        let prev = std::env::var("OPENCODE_AUTH_PATH").ok();
        std::env::set_var("OPENCODE_AUTH_PATH", &auth);
        f(&auth);
        match prev {
            Some(v) => std::env::set_var("OPENCODE_AUTH_PATH", v),
            None => std::env::remove_var("OPENCODE_AUTH_PATH"),
        }
    }

    #[test]
    fn whitelist_filter_drops_non_whitelisted() {
        with_auth_file(
            r#"{
                "anthropic":  {"apiKey": "sk-ant-1"},
                "openai":     {"apiKey": "sk-1"},
                "opencode":   {"type": "api", "key": "sk-zen-1"},
                "opencode-go": {"type": "api", "key": "sk-go-1"},
                "opencode-zen": {"type": "oauth", "access": "ozk", "refresh": "rt"},
                "github-copilot": {"type": "oauth", "access": "gho", "refresh": "gho"},
                "google":     {"apiKey": "g-1"},
                "groq":       {"apiKey": "g-2"}
            }"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                let names: Vec<_> = got.entries.iter().map(|e| e.sub_provider.as_str()).collect();
                assert_eq!(
                    names,
                    vec!["anthropic", "openai", "opencode", "opencode-go", "opencode-zen"]
                );
            },
        );
    }

    #[test]
    fn classify_managed_plan_type_api_as_api_key() {
        // Real shape written by the opencode CLI for the Go plan
        // (verified against a live install 2026-06-07).
        with_auth_file(
            r#"{"opencode-go": {"type": "api", "key": "sk-go-secret"}}"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                assert_eq!(got.entries.len(), 1);
                assert_eq!(got.entries[0].sub_provider, "opencode-go");
                assert_eq!(got.entries[0].kind, "api-key");
                assert!(got.entries[0].payload_json.contains("sk-go-secret"));
            },
        );
    }

    #[test]
    fn classify_bare_key_field_as_api_key() {
        with_auth_file(r#"{"opencode": {"key": "sk-zen-x"}}"#, |_| {
            let got = discover_opencode_auth().unwrap().unwrap();
            assert_eq!(got.entries[0].kind, "api-key");
        });
    }

    #[test]
    fn classify_api_key() {
        with_auth_file(
            r#"{"anthropic": {"apiKey": "sk-ant-test"}}"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                assert_eq!(got.entries.len(), 1);
                assert_eq!(got.entries[0].kind, "api-key");
                assert!(got.entries[0].payload_json.contains("sk-ant-test"));
            },
        );
    }

    #[test]
    fn classify_oauth_via_type_field() {
        with_auth_file(
            r#"{"opencode-zen": {"type": "oauth", "access": "ozk", "refresh": "rt"}}"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                assert_eq!(got.entries[0].kind, "oauth");
            },
        );
    }

    #[test]
    fn classify_oauth_via_access_field() {
        with_auth_file(
            r#"{"openai": {"access": "tok", "refresh": "rt"}}"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                assert_eq!(got.entries[0].kind, "oauth");
            },
        );
    }

    #[test]
    fn classify_unknown_when_no_recognised_field() {
        with_auth_file(
            r#"{"anthropic": {"unrelated": "value"}}"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                assert_eq!(got.entries[0].kind, "unknown");
            },
        );
    }

    #[test]
    fn empty_file_returns_empty_entries() {
        with_auth_file("", |path| {
            let got = discover_opencode_auth().unwrap().unwrap();
            assert!(got.entries.is_empty());
            assert_eq!(got.auth_json_path, path.to_string_lossy());
        });
    }

    #[test]
    fn missing_file_returns_empty_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nonexistent.json");
        let prev = std::env::var("OPENCODE_AUTH_PATH").ok();
        std::env::set_var("OPENCODE_AUTH_PATH", &path);
        let got = discover_opencode_auth().unwrap().unwrap();
        assert!(got.entries.is_empty());
        match prev {
            Some(v) => std::env::set_var("OPENCODE_AUTH_PATH", v),
            None => std::env::remove_var("OPENCODE_AUTH_PATH"),
        }
    }

    #[test]
    fn malformed_json_surfaces_parse_error() {
        with_auth_file("{not json", |_| {
            assert!(discover_opencode_auth().is_err());
        });
    }

    #[test]
    fn non_object_root_surfaces_error() {
        with_auth_file(r#"["unexpected", "array"]"#, |_| {
            assert!(discover_opencode_auth().is_err());
        });
    }

    #[test]
    fn entries_are_deterministically_ordered() {
        // Even when auth.json lists them in shuffled order, we always emit
        // anthropic → openai → opencode → opencode-go → opencode-zen.
        with_auth_file(
            r#"{
                "opencode-zen": {"type": "oauth", "access": "x"},
                "opencode-go":  {"type": "api", "key": "x"},
                "openai":       {"apiKey": "x"},
                "opencode":     {"type": "api", "key": "x"},
                "anthropic":    {"apiKey": "x"}
            }"#,
            |_| {
                let got = discover_opencode_auth().unwrap().unwrap();
                let order: Vec<_> = got.entries.iter().map(|e| e.sub_provider.as_str()).collect();
                assert_eq!(
                    order,
                    vec!["anthropic", "openai", "opencode", "opencode-go", "opencode-zen"]
                );
            },
        );
    }
}
