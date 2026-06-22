// Format-aware read/write for agent config files. JSON / JSONC / TOML.
//
// Read returns the canonical JSON tree the frontend adapters consume:
//   - JSON  files: parsed as-is
//   - JSONC files: comments stripped, then parsed as JSON
//   - TOML  files: parsed via `toml_edit`, converted to a serde_json Value
//
// Write goes the other way. For TOML we round-trip through `toml_edit`'s
// `Document` so non-MCP comments and key ordering survive — but only when
// an existing file is present. For a fresh file we emit a minimal TOML.
//
// Atomic write: stage to `<file>.tmp.<ts>`, copy old to `<file>.bak.<ts>`,
// then rename the staged file into place.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value as Json;
use toml_edit::DocumentMut;

use super::paths::AgentFormat;

#[derive(Debug)]
pub struct ReadOutcome {
    pub exists: bool,
    /// Raw file content (whatever the on-disk format is). Empty when !exists.
    pub raw: String,
    /// Parsed canonical JSON tree, or `Null` when the file is missing /
    /// empty / unparseable.
    pub parsed: Json,
    /// `Some(error)` when the file existed but parse failed. The frontend
    /// surfaces this so users can fix the file by hand.
    pub parse_error: Option<String>,
}

pub fn read_file(path: &Path, format: AgentFormat) -> ReadOutcome {
    if !path.exists() {
        return ReadOutcome {
            exists: false,
            raw: String::new(),
            parsed: Json::Null,
            parse_error: None,
        };
    }
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return ReadOutcome {
                exists: true,
                raw: String::new(),
                parsed: Json::Null,
                parse_error: Some(format!("read: {}", e)),
            }
        }
    };
    if raw.trim().is_empty() {
        return ReadOutcome {
            exists: true,
            raw,
            parsed: Json::Null,
            parse_error: None,
        };
    }
    let parse_result = match format {
        AgentFormat::Json => parse_json(&raw),
        AgentFormat::Jsonc => parse_jsonc(&raw),
        AgentFormat::Toml => parse_toml(&raw),
    };
    match parse_result {
        Ok(parsed) => ReadOutcome {
            exists: true,
            raw,
            parsed,
            parse_error: None,
        },
        Err(e) => ReadOutcome {
            exists: true,
            raw,
            parsed: Json::Null,
            parse_error: Some(e),
        },
    }
}

fn parse_json(raw: &str) -> Result<Json, String> {
    serde_json::from_str(raw).map_err(|e| format!("json parse: {}", e))
}

fn parse_jsonc(raw: &str) -> Result<Json, String> {
    let stripped = strip_jsonc(raw);
    serde_json::from_str(&stripped).map_err(|e| format!("jsonc parse: {}", e))
}

fn parse_toml(raw: &str) -> Result<Json, String> {
    let doc: DocumentMut = raw
        .parse::<DocumentMut>()
        .map_err(|e| format!("toml parse: {}", e))?;
    Ok(toml_to_json(&doc.as_item().clone()))
}

/// Strip `//` line comments, `/* ... */` block comments, and trailing commas
/// from JSONC. Hand-rolled (rather than pulling another crate) because the
/// rules are short and well-defined for this use.
fn strip_jsonc(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;

    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            out.push(b);
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        // Line comment
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment
        if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if b == b'"' {
            in_string = true;
            out.push(b);
            i += 1;
            continue;
        }
        out.push(b);
        i += 1;
    }

    // Strip trailing commas before `}` or `]`. Cheap second pass.
    let s = String::from_utf8(out).unwrap_or_default();
    remove_trailing_commas(&s)
}

fn remove_trailing_commas(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut in_string = false;
    let mut escape = false;
    let mut last_comma_idx: Option<usize> = None;

    for (i, &b) in bytes.iter().enumerate() {
        if in_string {
            out.push(b);
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        if b == b'"' {
            in_string = true;
            out.push(b);
            last_comma_idx = None;
            continue;
        }
        if b.is_ascii_whitespace() {
            out.push(b);
            continue;
        }
        if b == b',' {
            last_comma_idx = Some(out.len());
            out.push(b);
            continue;
        }
        if (b == b'}' || b == b']') && last_comma_idx.is_some() {
            // Walk back over whitespace already in `out` to find the comma we noted.
            if let Some(idx) = last_comma_idx {
                // Confirm only whitespace between the comma and now.
                let trailing = &out[idx + 1..];
                if trailing.iter().all(|c| c.is_ascii_whitespace()) {
                    out.remove(idx);
                }
            }
        }
        out.push(b);
        last_comma_idx = None;
        let _ = i;
    }

    String::from_utf8(out).unwrap_or_default()
}

fn toml_to_json(item: &toml_edit::Item) -> Json {
    match item {
        toml_edit::Item::None => Json::Null,
        toml_edit::Item::Value(v) => toml_value_to_json(v),
        toml_edit::Item::Table(t) => {
            let mut map = serde_json::Map::new();
            for (k, v) in t.iter() {
                map.insert(k.to_string(), toml_to_json(v));
            }
            Json::Object(map)
        }
        toml_edit::Item::ArrayOfTables(a) => {
            let mut arr = Vec::new();
            for t in a.iter() {
                let mut map = serde_json::Map::new();
                for (k, v) in t.iter() {
                    map.insert(k.to_string(), toml_to_json(v));
                }
                arr.push(Json::Object(map));
            }
            Json::Array(arr)
        }
    }
}

fn toml_value_to_json(v: &toml_edit::Value) -> Json {
    match v {
        toml_edit::Value::String(s) => Json::String(s.value().clone()),
        toml_edit::Value::Integer(n) => Json::Number((*n.value()).into()),
        toml_edit::Value::Float(f) => serde_json::Number::from_f64(*f.value())
            .map(Json::Number)
            .unwrap_or(Json::Null),
        toml_edit::Value::Boolean(b) => Json::Bool(*b.value()),
        toml_edit::Value::Datetime(dt) => Json::String(dt.value().to_string()),
        toml_edit::Value::Array(arr) => Json::Array(arr.iter().map(toml_value_to_json).collect()),
        toml_edit::Value::InlineTable(t) => {
            let mut map = serde_json::Map::new();
            for (k, v) in t.iter() {
                map.insert(k.to_string(), toml_value_to_json(v));
            }
            Json::Object(map)
        }
    }
}

#[derive(Debug)]
pub struct WriteOutcome {
    pub path: PathBuf,
    pub backup_path: Option<PathBuf>,
}

pub fn write_file(
    path: &Path,
    format: AgentFormat,
    value: &Json,
    existing_raw: Option<&str>,
) -> Result<WriteOutcome, String> {
    // Make sure the parent directory exists. We don't auto-create the agent's
    // home dir if it's missing — that means the agent isn't installed.
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            return Err(format!(
                "agent directory missing: {} (agent not installed?)",
                parent.display()
            ));
        }
    }

    let serialized = match format {
        AgentFormat::Json => serialize_json(value),
        AgentFormat::Jsonc => serialize_json(value), // comments don't survive — documented
        AgentFormat::Toml => serialize_toml(value, existing_raw)?,
    };

    // Backup the existing file (if any) and atomically rename our staged file
    // into place. The backup name carries an epoch-second suffix so concurrent
    // syncs don't clobber each other's history.
    let backup_path = if path.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bp = path.with_extension(format!(
            "{}.bak.{}",
            path.extension().and_then(|s| s.to_str()).unwrap_or(""),
            ts
        ));
        fs::copy(path, &bp).map_err(|e| format!("backup: {}", e))?;
        Some(bp)
    } else {
        None
    };

    let tmp_path = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("create tmp: {}", e))?;
        f.write_all(serialized.as_bytes())
            .map_err(|e| format!("write tmp: {}", e))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("rename into place: {}", e)
    })?;

    Ok(WriteOutcome {
        path: path.to_path_buf(),
        backup_path,
    })
}

fn serialize_json(value: &Json) -> String {
    // 2-space indent matches what Claude Code / Cursor / VS Code write.
    let mut s = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string());
    // serde_json uses 2-space by default for to_string_pretty — confirmed.
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// TOML serialize. When an existing TOML file is provided, we round-trip
/// through `toml_edit::DocumentMut` so non-managed sections (and their
/// comments / spacing) survive. We rebuild the `[mcp_servers.*]` section
/// from scratch off our `value`.
fn serialize_toml(value: &Json, existing_raw: Option<&str>) -> Result<String, String> {
    let mut doc: DocumentMut = match existing_raw {
        Some(r) if !r.trim().is_empty() => r
            .parse::<DocumentMut>()
            .map_err(|e| format!("re-parse existing toml: {}", e))?,
        _ => DocumentMut::new(),
    };

    // Drop both the canonical and typo'd MCP keys; we rebuild from `value`.
    doc.remove("mcp_servers");
    remove_legacy_dotted_mcp_servers(&mut doc);

    // Pull mcp_servers out of the JSON tree we got from the adapter.
    if let Json::Object(root) = value {
        if let Some(Json::Object(map)) = root.get("mcp_servers") {
            let mut table = toml_edit::Table::new();
            for (name, entry) in map.iter() {
                let mut t = toml_edit::Table::new();
                if let Json::Object(fields) = entry {
                    for (k, v) in fields.iter() {
                        if let Some(item) = json_to_toml(v) {
                            t.insert(k, item);
                        }
                    }
                }
                table.insert(name, toml_edit::Item::Table(t));
            }
            doc.insert("mcp_servers", toml_edit::Item::Table(table));
        }

        // Other top-level keys (model, custom_section, etc.) are already in the
        // existing document; if the JSON tree contains *new* top-level fields the
        // adapter added, copy those across too.
        for (k, v) in root.iter() {
            if k == "mcp_servers" || k == "mcp.servers" {
                continue;
            }
            if doc.contains_key(k) {
                continue; // existing value preserved verbatim by toml_edit
            }
            if let Some(item) = json_to_toml(v) {
                doc.insert(k, item);
            }
        }
    }

    Ok(doc.to_string())
}

fn remove_legacy_dotted_mcp_servers(doc: &mut DocumentMut) {
    let remove_mcp = match doc.get_mut("mcp").and_then(|item| item.as_table_mut()) {
        Some(table) => {
            table.remove("servers");
            table.is_empty()
        }
        None => false,
    };

    if remove_mcp {
        doc.remove("mcp");
    }
}

fn json_to_toml(v: &Json) -> Option<toml_edit::Item> {
    use toml_edit::Item;
    match v {
        Json::Null => None,
        Json::Bool(b) => Some(Item::Value(toml_edit::Value::from(*b))),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(Item::Value(toml_edit::Value::from(i)))
            } else {
                n.as_f64().map(|f| Item::Value(toml_edit::Value::from(f)))
            }
        }
        Json::String(s) => Some(Item::Value(toml_edit::Value::from(s.as_str()))),
        Json::Array(arr) => {
            let mut a = toml_edit::Array::new();
            for item in arr {
                if let Some(toml_edit::Item::Value(val)) = json_to_toml(item) {
                    a.push(val);
                }
            }
            Some(Item::Value(toml_edit::Value::Array(a)))
        }
        Json::Object(map) => {
            // Inline table — short and matches what Codex's auto-gen writes for env.
            let mut t = toml_edit::InlineTable::new();
            for (k, val) in map.iter() {
                if let Some(toml_edit::Item::Value(v)) = json_to_toml(val) {
                    t.insert(k, v);
                }
            }
            Some(Item::Value(toml_edit::Value::InlineTable(t)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serialize_toml_removes_legacy_dotted_mcp_servers_table() {
        let existing = r#"
model = "gpt-5"

[mcp.servers.old]
command = "old"
"#;
        let value = json!({
            "mcp_servers": {
                "new": {
                    "command": "new"
                }
            }
        });

        let serialized = serialize_toml(&value, Some(existing)).unwrap();

        assert!(!serialized.contains("[mcp.servers."));
        assert!(serialized.contains("[mcp_servers.new]"));
        assert!(serialized.contains(r#"command = "new""#));
    }

    #[test]
    fn serialize_toml_preserves_unrelated_mcp_table_fields() {
        let existing = r#"
[mcp]
enabled = true

[mcp.servers.old]
command = "old"
"#;
        let value = json!({
            "mcp_servers": {
                "new": {
                    "command": "new"
                }
            }
        });

        let serialized = serialize_toml(&value, Some(existing)).unwrap();

        assert!(serialized.contains("[mcp]"));
        assert!(serialized.contains("enabled = true"));
        assert!(!serialized.contains("[mcp.servers."));
        assert!(serialized.contains("[mcp_servers.new]"));
    }
}
