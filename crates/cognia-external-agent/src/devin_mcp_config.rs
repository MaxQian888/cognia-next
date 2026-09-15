//! Private per-process Devin configuration. Cognia projects each session's
//! servers into a copied XDG tree for deterministic discovery and isolation.
//! Originals and HOME/data roots are never changed; the guard owns all copies.
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

pub const PAYLOAD_ENV: &str = "COGNIA_DEVIN_MCP_SERVERS";
/// Added after SpawnPolicy filtering, never accepted from a serialized caller.
pub(crate) const WRAPPED_ENV: &str = "COGNIA_INTERNAL_DEVIN_SANDBOX";
const INVALID: &str = "Invalid Devin MCP configuration";
const MAX_JSON_BYTES: usize = 1_048_576;

fn base(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    [".exe", ".cmd", ".bat"]
        .into_iter()
        .find_map(|suffix| lower.strip_suffix(suffix).map(str::to_owned))
        .unwrap_or(lower)
}

pub fn validate_target(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
) -> Result<(), String> {
    if env.contains_key(PAYLOAD_ENV)
        && (base(command) != "devin" || args.first().map(String::as_str) != Some("acp"))
    {
        return Err(INVALID.into());
    }
    Ok(())
}

fn parse_jsonc(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.len() > MAX_JSON_BYTES {
        return Err(INVALID.into());
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut string = false;
    while i < bytes.len() {
        let ch = bytes[i];
        if string {
            out.push(ch);
            if ch == b'\\' {
                i += 1;
                if i < bytes.len() {
                    out.push(bytes[i]);
                }
            } else if ch == b'"' {
                string = false;
            }
        } else if ch == b'"' {
            string = true;
            out.push(ch);
        } else if ch == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i + 1 < bytes.len() && bytes[i + 1] != b'\n' {
                i += 1;
            }
            out.push(b' ');
        } else if ch == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err(INVALID.into());
            }
            i += 1;
            out.push(b' ');
        } else {
            out.push(ch);
        }
        i += 1;
    }
    let mut cleaned = Vec::with_capacity(out.len());
    i = 0;
    string = false;
    while i < out.len() {
        let ch = out[i];
        if string {
            cleaned.push(ch);
            if ch == b'\\' {
                i += 1;
                if i < out.len() {
                    cleaned.push(out[i]);
                }
            } else if ch == b'"' {
                string = false;
            }
        } else if ch == b'"' {
            string = true;
            cleaned.push(ch);
        } else {
            if ch != b','
                || !matches!(
                    out[i + 1..].iter().find(|byte| !byte.is_ascii_whitespace()),
                    Some(b'}' | b']')
                )
            {
                cleaned.push(ch);
            }
        }
        i += 1;
    }
    serde_json::from_slice::<Value>(&cleaned)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| INVALID.into())
}

fn read_config(filename: &Path) -> Result<Map<String, Value>, String> {
    if !filename.exists() {
        return Ok(Map::new());
    }
    let metadata = fs::metadata(filename).map_err(|_| INVALID)?;
    if !metadata.is_file() || metadata.len() > MAX_JSON_BYTES as u64 {
        return Err(INVALID.into());
    }
    parse_jsonc(&fs::read_to_string(filename).map_err(|_| INVALID)?)
}

fn servers(config: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    match config.get("mcpServers") {
        None => Ok(Map::new()),
        Some(value) => value.as_object().cloned().ok_or_else(|| INVALID.into()),
    }
}

fn pairs(value: Option<&Value>) -> Result<Map<String, Value>, String> {
    let Some(value) = value else {
        return Ok(Map::new());
    };
    let entries = value.as_array().ok_or(INVALID)?;
    if entries.len() > 256 {
        return Err(INVALID.into());
    }
    let mut result = Map::new();
    for entry in entries {
        let name = entry.get("name").and_then(Value::as_str).ok_or(INVALID)?;
        let text = entry.get("value").and_then(Value::as_str).ok_or(INVALID)?;
        if name.is_empty()
            || name.contains('\0')
            || text.contains('\0')
            || result
                .insert(name.into(), Value::String(text.into()))
                .is_some()
        {
            return Err(INVALID.into());
        }
    }
    Ok(result)
}

fn injected(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.len() > MAX_JSON_BYTES {
        return Err(INVALID.into());
    }
    let parsed: Value = serde_json::from_str(raw).map_err(|_| INVALID)?;
    let list = parsed.as_array().ok_or(INVALID)?;
    if list.len() > 64 {
        return Err(INVALID.into());
    }
    let mut result = Map::new();
    for value in list {
        let entry = value.as_object().ok_or(INVALID)?;
        let name = entry.get("name").and_then(Value::as_str).ok_or(INVALID)?;
        if name.is_empty() || name.len() > 256 || name.contains('\0') || result.contains_key(name) {
            return Err(INVALID.into());
        }
        let transport = entry.get("type").and_then(Value::as_str);
        let config = match transport {
            Some("http" | "sse") => {
                if entry
                    .keys()
                    .any(|key| !["name", "type", "url", "headers"].contains(&key.as_str()))
                {
                    return Err(INVALID.into());
                }
                let url = entry.get("url").and_then(Value::as_str).ok_or(INVALID)?;
                let parsed_url = url::Url::parse(url).map_err(|_| INVALID)?;
                if !["http", "https"].contains(&parsed_url.scheme())
                    || parsed_url.host_str().is_none()
                {
                    return Err(INVALID.into());
                }
                serde_json::json!({"url":url,"transport":transport,"headers":pairs(entry.get("headers"))?})
            }
            None | Some("stdio") => {
                if entry.contains_key("type") && transport.is_none() {
                    return Err(INVALID.into());
                }
                if entry
                    .keys()
                    .any(|key| !["name", "type", "command", "args", "env"].contains(&key.as_str()))
                {
                    return Err(INVALID.into());
                }
                let command = entry
                    .get("command")
                    .and_then(Value::as_str)
                    .ok_or(INVALID)?;
                let args = entry.get("args").and_then(Value::as_array).ok_or(INVALID)?;
                if command.trim().is_empty()
                    || command.contains('\0')
                    || args.len() > 512
                    || args
                        .iter()
                        .any(|arg| arg.as_str().is_none_or(|arg| arg.contains('\0')))
                {
                    return Err(INVALID.into());
                }
                serde_json::json!({"command":command,"args":args,"env":pairs(entry.get("env"))?})
            }
            _ => return Err(INVALID.into()),
        };
        result.insert(name.into(), config);
    }
    Ok(result)
}

fn project_collisions(cwd: &Path, names: &Map<String, Value>) -> Result<(), String> {
    for directory in cwd.ancestors() {
        for name in [
            "config.json",
            "config.local.json",
            "mcp_config.json",
            "mcp_config.local.json",
        ] {
            let project = servers(&read_config(&directory.join(".devin").join(name))?)?;
            if project.keys().any(|key| names.contains_key(key)) {
                return Err(
                    "Project Devin MCP configuration shadows a Cognia session server".into(),
                );
            }
        }
    }
    Ok(())
}

fn private_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
            .map_err(|_| "Cannot secure Devin configuration")?;
    }
    Ok(())
}

fn copy_private(
    source: &Path,
    destination: &Path,
    budget: &mut (u64, usize),
    ancestors: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let canonical = source
        .canonicalize()
        .map_err(|_| "Cannot read Devin configuration")?;
    if !ancestors.insert(canonical.clone()) {
        return Err("Devin configuration contains a symlink cycle".into());
    }
    let metadata = fs::metadata(&canonical).map_err(|_| "Cannot read Devin configuration")?;
    budget.1 += 1;
    if metadata.is_file() {
        budget.0 += metadata.len();
    }
    if budget.0 > 64 * MAX_JSON_BYTES as u64 || budget.1 > 10_000 {
        return Err("Devin configuration exceeds the isolated copy limit".into());
    }
    if metadata.is_dir() {
        fs::create_dir(destination).map_err(|_| "Cannot copy Devin configuration")?;
        private_mode(destination, 0o700)?;
        for entry in fs::read_dir(&canonical).map_err(|_| "Cannot read Devin configuration")? {
            let entry = entry.map_err(|_| "Cannot read Devin configuration")?;
            copy_private(
                &entry.path(),
                &destination.join(entry.file_name()),
                budget,
                ancestors,
            )?;
        }
    } else if metadata.is_file() {
        fs::copy(&canonical, destination).map_err(|_| "Cannot copy Devin configuration")?;
        private_mode(destination, 0o600)?;
    } else {
        return Err("Devin configuration contains an unsupported file type".into());
    }
    ancestors.remove(&canonical);
    Ok(())
}

/// The TempDir guard must live until the child has exited, including kill paths.
pub struct DevinConfig {
    root: tempfile::TempDir,
}
impl DevinConfig {
    pub fn path(&self) -> &Path {
        self.root.path()
    }
}

pub fn prepare(
    config: &mut crate::process::ExternalAgentSpawnConfig,
    home: &Path,
    temp: &Path,
    original_xdg: Option<&Path>,
) -> Result<Option<DevinConfig>, String> {
    let Some(raw) = config.env.get(PAYLOAD_ENV) else {
        return Ok(None);
    };
    // Desktop has already wrapped the validated target. Headless local-process
    // runs inside its host container and retains the bare validated command.
    // Only the launcher receives sandbox flags; Devin's own argv never does.
    let separator = if config.env.get(WRAPPED_ENV).map(String::as_str) == Some("1") {
        let separator = config
            .args
            .iter()
            .position(|arg| arg == "--")
            .ok_or(INVALID)?;
        let command = config.args.get(separator + 1).ok_or(INVALID)?;
        validate_target(command, &config.args[separator + 2..], &config.env)?;
        Some(separator)
    } else {
        validate_target(&config.command, &config.args, &config.env)?;
        None
    };
    let injected = injected(raw)?;
    let cwd = config.cwd.as_deref().ok_or(INVALID)?;
    let bot_isolation = config.env.get("COGNIA_BOT_ISOLATION").map(String::as_str) == Some("1");
    if bot_isolation {
        let state = config.env.get("COGNIA_BOT_STATE_DIR").filter(|value| Path::new(value).is_absolute()).ok_or("Bot isolation requires an owned state directory")?;
        let credential = home.join(".local/share/devin/credentials.toml");
        let destination = Path::new(state).join("data/devin/credentials.toml");
        if credential.exists() && !destination.exists() {
            if !fs::symlink_metadata(&credential).map_err(|_| "Cannot inspect Devin credential")?.is_file() { return Err("Devin credential must be a regular file".into()); }
            fs::create_dir_all(destination.parent().unwrap()).map_err(|_| "Cannot prepare Bot model credential")?;
            copy_private(&credential, &destination, &mut (0, 0), &mut HashSet::new())?;
        }
    }
    project_collisions(Path::new(cwd), &injected)?;
    let original = original_xdg
        .filter(|value| !value.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".config"));
    if !original.is_absolute() {
        return Err("Devin XDG_CONFIG_HOME must be absolute".into());
    }
    let guard = DevinConfig {
        root: tempfile::Builder::new()
            .prefix("cognia-devin-config-")
            .tempdir_in(temp)
            .map_err(|_| "Cannot create isolated Devin configuration")?,
    };
    private_mode(guard.path(), 0o700)?;
    if original.exists() {
        for entry in fs::read_dir(&original).map_err(|_| "Cannot read Devin configuration")? {
            let entry = entry.map_err(|_| "Cannot read Devin configuration")?;
            let destination = guard.path().join(entry.file_name());
            if entry.file_name() == "devin" && bot_isolation {
                let current = read_config(&entry.path().join("config.json"))?;
                let mut selected = Map::new();
                if let Some(version) = current.get("version").filter(|value| value.is_number()) { selected.insert("version".into(), version.clone()); }
                if let Some(org) = current.get("devin").and_then(|value| value.get("org_id")).filter(|value| value.is_string()) {
                    selected.insert("devin".into(), serde_json::json!({"org_id": org}));
                }
                selected.insert("shell".into(), serde_json::json!({"setup_complete": true}));
                fs::create_dir_all(&destination).map_err(|_| "Cannot create isolated Devin configuration")?;
                fs::write(destination.join("config.json"), serde_json::to_vec(&selected).map_err(|_| INVALID)?).map_err(|_| "Cannot write isolated Devin configuration")?;
            } else if entry.file_name() == "devin" {
                copy_private(
                    &entry.path(),
                    &destination,
                    &mut (0, 0),
                    &mut HashSet::new(),
                )?;
            } else if !bot_isolation {
                #[cfg(unix)]
                std::os::unix::fs::symlink(entry.path(), destination)
                    .map_err(|_| "Cannot preserve XDG configuration")?;
                #[cfg(not(unix))]
                return Err("Isolated Devin configuration requires Unix".into());
            }
        }
    }
    let directory = guard.path().join("devin");
    fs::create_dir_all(&directory).map_err(|_| "Cannot create Devin configuration")?;
    private_mode(&directory, 0o700)?;
    let filename = directory.join("mcp_config.json");
    let mut dedicated = read_config(&filename)?;
    let config_filename = directory.join("config.json");
    let mut primary = read_config(&config_filename)?;
    let mut merged = if bot_isolation {
        primary.remove("mcpServers");
        fs::write(&config_filename, serde_json::to_vec(&primary).map_err(|_| INVALID)?).map_err(|_| "Cannot write isolated Devin configuration")?;
        dedicated.remove("mcpServers");
        Map::new()
    } else {
        let mut inherited = servers(&primary)?;
        inherited.extend(servers(&dedicated)?);
        inherited
    };
    merged.extend(injected);
    for value in merged.values_mut() {
        let server = value.as_object_mut().ok_or(INVALID)?;
        if server.get("command").is_some_and(Value::is_string) {
            let mut env = match server.get("env") {
                None => Map::new(),
                Some(value) => value.as_object().cloned().ok_or(INVALID)?,
            };
            if env.values().any(|value| !value.is_string()) {
                return Err(INVALID.into());
            }
            env.entry("XDG_CONFIG_HOME")
                .or_insert_with(|| Value::String(original.to_string_lossy().into_owned()));
            server.insert("env".into(), Value::Object(env));
        }
    }
    dedicated.insert("mcpServers".into(), Value::Object(merged));
    fs::write(
        &filename,
        serde_json::to_vec(&dedicated).map_err(|_| INVALID)?,
    )
    .map_err(|_| "Cannot write Devin configuration")?;
    private_mode(&filename, 0o600)?;
    if let Some(separator) = separator {
        let mut scopes = vec![
            "--writable".into(),
            guard.path().to_string_lossy().into_owned(),
        ];
        if original.exists() && !bot_isolation {
            scopes.extend(["--readable".into(), original.to_string_lossy().into_owned()]);
        }
        config.args.splice(separator..separator, scopes);
    }
    config.env.remove(PAYLOAD_ENV);
    config.env.remove(WRAPPED_ENV);
    config.env.insert(
        "XDG_CONFIG_HOME".into(),
        guard.path().to_string_lossy().into_owned(),
    );
    Ok(Some(guard))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(home: &Path, raw: Value) -> crate::process::ExternalAgentSpawnConfig {
        crate::process::ExternalAgentSpawnConfig {
            id: "devin".into(),
            command: "/bin/cognia-external-agent-launcher".into(),
            args: vec!["--".into(), "devin".into(), "acp".into()],
            cwd: Some(home.to_string_lossy().into_owned()),
            env: HashMap::from([
                (PAYLOAD_ENV.into(), raw.to_string()),
                (WRAPPED_ENV.into(), "1".into()),
            ]),
            framing: Default::default(),
        }
    }
    fn payload(token: &str) -> Value {
        serde_json::json!([{"name":"cognia-tools","command":"node","args":["bridge"],"env":[{"name":"TOKEN","value":token}]}])
    }
    fn write(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fn read(root: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(root.join("devin/mcp_config.json")).unwrap())
            .unwrap()
    }

    #[test]
    fn headless_local_process_keeps_native_arguments_and_consumes_payload() {
        let home = tempfile::tempdir().unwrap();
        let mut input = config(home.path(), payload("headless"));
        input.command = "devin".into();
        input.env.remove(WRAPPED_ENV);
        input.args = vec!["acp".into(), "--model".into(), "swe2".into()];
        let original_args = input.args.clone();
        let guard = prepare(&mut input, home.path(), home.path(), None)
            .unwrap()
            .unwrap();
        assert_eq!(input.args, original_args);
        assert_eq!(input.env["XDG_CONFIG_HOME"], guard.path().to_string_lossy());
        assert!(!input.env.contains_key(PAYLOAD_ENV));
        assert_eq!(
            read(guard.path())["mcpServers"]["cognia-tools"]["env"]["TOKEN"],
            "headless"
        );
    }

    #[test]
    fn bot_configuration_copies_only_model_credentials_and_drops_inherited_mcp() {
        let home = tempfile::tempdir().unwrap();
        write(home.path(), ".local/share/devin/credentials.toml", "token = 'model-only'");
        write(home.path(), ".config/devin/config.json", r#"{"mcpServers":{"github":{"command":"gh","env":{"GH_TOKEN":"secret"}}}}"#);
        write(home.path(), ".config/gh/hosts.yml", "secret");
        let state = home.path().join("bot-state");
        let mut input = config(home.path(), payload("safe-host-tool"));
        input.env.insert("COGNIA_BOT_ISOLATION".into(), "1".into());
        input.env.insert("COGNIA_BOT_STATE_DIR".into(), state.to_string_lossy().into_owned());
        let guard = prepare(&mut input, home.path(), home.path(), None).unwrap().unwrap();
        assert!(read(guard.path())["mcpServers"].get("github").is_none());
        assert!(!guard.path().join("gh").exists());
        assert_eq!(fs::read_to_string(state.join("data/devin/credentials.toml")).unwrap(), "token = 'model-only'");
        assert!(!input.args.windows(2).any(|pair| pair == ["--readable", &home.path().join(".config").to_string_lossy()]));
    }

    #[test]
    fn host_attestation_accepts_renamed_launcher_without_trusting_its_basename() {
        let home = tempfile::tempdir().unwrap();
        let mut input = config(home.path(), payload("wrapped"));
        input.command = "/opt/custom-launcher".into();
        let guard = prepare(&mut input, home.path(), home.path(), None)
            .unwrap()
            .unwrap();
        assert!(input
            .args
            .contains(&guard.path().to_string_lossy().into_owned()));
        assert!(!input.env.contains_key(WRAPPED_ENV));
        let mut untrusted = config(home.path(), payload("untrusted"));
        untrusted.env.remove(WRAPPED_ENV);
        assert!(prepare(&mut untrusted, home.path(), home.path(), None).is_err());
    }

    #[test]
    fn preserves_user_configuration_and_isolates_concurrent_tokens() {
        let home = tempfile::tempdir().unwrap();
        let original = "{// comment\n\"permissions\":{\"deny\":[\"shell(*)\"]},\"mcpServers\":{\"legacy\":{\"command\":\"old\"}},}";
        write(home.path(), ".config/devin/config.json", original);
        write(
            home.path(),
            ".config/devin/mcp_config.json",
            r#"{"mcpServers":{"custom":{"command":"custom","env":{"XDG_CONFIG_HOME":"/explicit"}}}}"#,
        );
        write(home.path(), ".config/devin/rules/a.md", "rules");
        write(home.path(), ".config/other/settings", "other");
        let mut first = config(home.path(), payload("one"));
        let a = prepare(&mut first, home.path(), home.path(), None)
            .unwrap()
            .unwrap();
        let mut second = config(home.path(), payload("two"));
        let b = prepare(&mut second, home.path(), home.path(), None)
            .unwrap()
            .unwrap();
        assert_ne!(a.path(), b.path());
        assert_eq!(
            read(a.path())["mcpServers"]["cognia-tools"]["env"]["TOKEN"],
            "one"
        );
        assert_eq!(
            read(b.path())["mcpServers"]["cognia-tools"]["env"]["TOKEN"],
            "two"
        );
        assert_eq!(
            read(a.path())["mcpServers"]["custom"]["env"]["XDG_CONFIG_HOME"],
            "/explicit"
        );
        assert_eq!(
            read(a.path())["mcpServers"]["legacy"]["env"]["XDG_CONFIG_HOME"],
            home.path().join(".config").to_string_lossy().as_ref()
        );
        assert_eq!(
            fs::read_to_string(a.path().join("devin/config.json")).unwrap(),
            original
        );
        assert_eq!(
            fs::read_to_string(a.path().join("devin/rules/a.md")).unwrap(),
            "rules"
        );
        assert_eq!(
            fs::read_to_string(a.path().join("other/settings")).unwrap(),
            "other"
        );
        assert!(!first.env.contains_key(PAYLOAD_ENV));
        assert!(!first.env.contains_key("HOME"));
        let owned = a.path().to_path_buf();
        assert!(first.args.contains(&owned.to_string_lossy().into_owned()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(a.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(a.path().join("devin/mcp_config.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(a);
        assert!(!owned.exists());
        assert!(b.path().exists());
        assert_eq!(
            fs::read_to_string(home.path().join(".config/devin/config.json")).unwrap(),
            original
        );
    }

    #[test]
    fn maps_remote_servers_and_empty_payload_with_original_xdg() {
        let home = tempfile::tempdir().unwrap();
        let xdg = home.path().join("custom");
        fs::create_dir(&xdg).unwrap();
        let mut input = config(
            home.path(),
            serde_json::json!([
                {"name":"http","type":"http","url":"https://example.com/mcp","headers":[{"name":"Authorization","value":"secret"}]},
                {"name":"sse","type":"sse","url":"http://localhost/sse","headers":[]}
            ]),
        );
        let guard = prepare(&mut input, home.path(), home.path(), Some(&xdg))
            .unwrap()
            .unwrap();
        assert_eq!(
            read(guard.path())["mcpServers"]["http"]["transport"],
            "http"
        );
        assert_eq!(read(guard.path())["mcpServers"]["sse"]["transport"], "sse");
        let mut empty = config(home.path(), serde_json::json!([]));
        let guard = prepare(&mut empty, home.path(), home.path(), None)
            .unwrap()
            .unwrap();
        assert_eq!(read(guard.path())["mcpServers"], serde_json::json!({}));
    }

    #[test]
    fn rejects_malformed_unsupported_shadowed_or_non_devin_payloads_without_echoing_tokens() {
        let home = tempfile::tempdir().unwrap();
        for raw in [
            "secret malformed".to_owned(),
            "{}".into(),
            r#"[{"name":"secret","type":"channel"}]"#.into(),
            " ".repeat(MAX_JSON_BYTES + 1),
        ] {
            let mut input = config(home.path(), Value::Null);
            input.env.insert(PAYLOAD_ENV.into(), raw);
            assert!(prepare(&mut input, home.path(), home.path(), None)
                .err()
                .unwrap()
                .contains(INVALID));
        }
        let mut wrong = config(home.path(), payload("one"));
        wrong.args[1] = "codex".into();
        assert!(prepare(&mut wrong, home.path(), home.path(), None).is_err());
        write(
            home.path(),
            ".devin/mcp_config.local.json",
            "{/*comment*/\"mcpServers\":{\"cognia-tools\":{\"command\":\"other\",},},}",
        );
        let mut input = config(home.path(), payload("one"));
        assert!(prepare(&mut input, home.path(), home.path(), None)
            .err()
            .unwrap()
            .contains("shadows"));
        assert!(!fs::read_dir(home.path()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cognia-devin-config-")));
    }

    #[test]
    fn jsonc_keeps_string_contents_and_copy_failure_removes_partial_overlay() {
        assert_eq!(
            parse_jsonc(r#"{"text":"a,} // literal",}"#).unwrap()["text"],
            "a,} // literal"
        );
        let home = tempfile::tempdir().unwrap();
        write(home.path(), ".config/devin/config.json", "{broken secret");
        let mut input = config(home.path(), payload("one"));
        assert!(prepare(&mut input, home.path(), home.path(), None).is_err());
        assert!(!fs::read_dir(home.path()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("cognia-devin-config-")));
        #[cfg(unix)]
        {
            write(home.path(), ".config/devin/config.json", "{}");
            std::os::unix::fs::symlink(
                home.path().join(".config/devin"),
                home.path().join(".config/devin/loop"),
            )
            .unwrap();
            assert!(prepare(&mut input, home.path(), home.path(), None)
                .err()
                .unwrap()
                .contains("cycle"));
        }
    }
}
