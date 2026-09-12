//! Host-owned task state. Provider files contain environment references, never lease secrets.
use std::{collections::HashMap, fs, path::{Path, PathBuf}};
use serde::Deserialize;

pub const PAYLOAD_ENV: &str = "COGNIA_GATEWAY_TASK_CONFIG";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPayload {
    task_id: String,
    binding: serde_json::Value,
    owner_account_id: Option<String>,
    runtime: String,
    files: HashMap<String, String>,
}

fn payload(env: &HashMap<String, String>) -> Result<Option<TaskPayload>, String> {
    let Some(raw) = env.get(PAYLOAD_ENV) else { return Ok(None) };
    let value: TaskPayload = serde_json::from_str(raw).map_err(|_| "Invalid gateway task configuration")?;
    if value.task_id.is_empty() || value.task_id.len() > 128 ||
        !value.task_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') ||
        !["codex", "opencode", "pi", "claude", "qwen", "dsh"].contains(&value.runtime.as_str()) ||
        value.files.iter().any(|(name, contents)| !["codex/config.toml", "pi/models.json", "pi/settings.json", "qwen/settings.json"].contains(&name.as_str()) || contents.len() > 262144) {
        return Err("Invalid gateway task configuration".into());
    }
    Ok(Some(value))
}

pub fn task_home(env: &HashMap<String, String>, home: &Path) -> Result<Option<PathBuf>, String> {
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    Ok(payload(env)?.map(|value| home.join(".local/share/cognia-agent-tasks").join(value.task_id)))
}

fn private_dir(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task state must not be a symlink".into());
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() { private_dir(parent)?; }
    }
    fs::create_dir_all(path).map_err(|e| format!("Cannot create gateway task state: {e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task file must not be a symlink".into());
    }
    private_dir(path.parent().ok_or("Invalid gateway task path")?)?;
    fs::write(path, contents).map_err(|e| format!("Cannot write gateway task configuration: {e}"))?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub struct TaskFiles { files: Vec<PathBuf> }
impl Drop for TaskFiles {
    fn drop(&mut self) {
        for file in &self.files { let _ = fs::remove_file(file); }
    }
}

pub fn prepare(env: &mut HashMap<String, String>, home: &Path) -> Result<Option<TaskFiles>, String> {
    let Some(value) = payload(env)? else { return Ok(None) };
    let root = task_home(env, home)?.ok_or("Missing gateway task home")?;
    private_dir(&root)?;
    let binding_path = root.join("binding.json");
    let binding = serde_json::json!({ "binding": value.binding, "runtime": value.runtime, "ownerAccountId": value.owner_account_id });
    if binding_path.exists() {
        let existing: serde_json::Value = serde_json::from_slice(&fs::read(&binding_path).map_err(|e| e.to_string())?).map_err(|_| "Invalid saved gateway task binding")?;
        if existing != binding { return Err("This task is bound to a different model or account; start a new task".into()); }
    } else {
        write_private(&binding_path, &serde_json::to_vec(&binding).map_err(|e| e.to_string())?)?;
    }
    let mut guard = TaskFiles { files: vec![] };
    for (name, contents) in value.files {
        let path = root.join(name);
        write_private(&path, contents.as_bytes())?;
        guard.files.push(path);
    }
    for (key, relative) in [("HOME", ""), ("USERPROFILE", ""), ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"), ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"), ("CODEX_HOME", "codex"), ("PI_CODING_AGENT_DIR", "pi"), ("CLAUDE_CONFIG_DIR", "claude"), ("OPENCODE_CONFIG_DIR", "config/opencode")] {
        let path = if relative.is_empty() { root.clone() } else { root.join(relative) };
        private_dir(&path)?;
        env.insert(key.into(), path.to_string_lossy().into_owned());
    }
    if value.runtime == "qwen" {
        let runtime = root.join("qwen-runtime");
        private_dir(&runtime)?;
        env.insert("QWEN_HOME".into(), root.join("qwen").to_string_lossy().into_owned());
        env.insert("QWEN_RUNTIME_DIR".into(), runtime.to_string_lossy().into_owned());
        for key in ["QWEN_CODE_SYSTEM_SETTINGS_PATH", "QWEN_CODE_SYSTEM_DEFAULTS_PATH"] {
            env.insert(key.into(), root.join("qwen/settings.json").to_string_lossy().into_owned());
        }
    }
    env.remove(PAYLOAD_ENV);
    Ok(Some(guard))
}

/// Runtime essentials only. No auth, provider settings, home, or shell injection.
pub fn runtime_environment() -> HashMap<String, String> {
    ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]
        .into_iter().filter_map(|key| std::env::var(key).ok().map(|value| (key.to_string(), value))).collect()
}

pub fn delete_task(task_id: &str, home: &Path) -> Result<(), String> {
    if task_id.is_empty() || task_id.len() > 128 || !task_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("Invalid gateway task id".into());
    }
    let parent = home.join(".local/share/cognia-agent-tasks");
    if !parent.exists() { return Ok(()) }
    if fs::symlink_metadata(&parent).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task state must not be a symlink".into());
    }
    let root = parent.join(task_id);
    if !root.exists() { return Ok(()) }
    if fs::symlink_metadata(&root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task state must not be a symlink".into());
    }
    fs::remove_dir_all(root).map_err(|e| format!("Cannot remove gateway task state: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(task: &str) -> HashMap<String, String> {
        HashMap::from([(PAYLOAD_ENV.into(), serde_json::json!({"taskId":task,"binding":{"providerId":"gateway","modelId":"model"},"runtime":"pi","files":{"pi/models.json":"{}"}}).to_string())])
    }
    #[test]
    fn isolates_configuration_preserves_history_and_refuses_rebinding() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = env("one");
        let root = task_home(&input, dir.path()).unwrap().unwrap();
        let guard = prepare(&mut input, dir.path()).unwrap();
        assert_eq!(input["HOME"], root.to_string_lossy());
        assert!(!input.contains_key(PAYLOAD_ENV));
        fs::write(root.join("pi/session.jsonl"), "conversation").unwrap();
        drop(guard);
        assert!(!root.join("pi/models.json").exists());
        assert!(root.join("pi/session.jsonl").exists());
        let mut changed = env("one");
        changed.get_mut(PAYLOAD_ENV).unwrap().push(' ');
        assert!(prepare(&mut changed, dir.path()).is_ok());
        let mut changed = env("one");
        changed.insert(PAYLOAD_ENV.into(), changed[PAYLOAD_ENV].replace("\"model\"", "\"other\""));
        assert!(prepare(&mut changed, dir.path()).is_err());
    }
    #[test]
    fn rejects_path_traversal_and_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare(&mut env("../escape"), dir.path()).is_err());
        let mut input = env("ok");
        input.insert(PAYLOAD_ENV.into(), input[PAYLOAD_ENV].replace("pi/models.json", "../secret"));
        assert!(prepare(&mut input, dir.path()).is_err());
    }

    #[test]
    fn pins_qwen_system_settings_and_retains_session_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = env("qwen-one");
        input.insert(PAYLOAD_ENV.into(), input[PAYLOAD_ENV].replace("\"pi\"", "\"qwen\"").replace("pi/models.json", "qwen/settings.json"));
        let original = input.clone();
        let guard = prepare(&mut input, dir.path()).unwrap();
        let settings = PathBuf::from(&input["QWEN_CODE_SYSTEM_SETTINGS_PATH"]);
        assert_eq!(settings, PathBuf::from(&input["QWEN_HOME"]).join("settings.json"));
        assert_eq!(input["QWEN_CODE_SYSTEM_DEFAULTS_PATH"], input["QWEN_CODE_SYSTEM_SETTINGS_PATH"]);
        let history = PathBuf::from(&input["QWEN_RUNTIME_DIR"]).join("session.jsonl");
        fs::write(&history, "history").unwrap();
        drop(guard);
        assert!(!settings.exists());
        let mut resumed = original;
        let guard = prepare(&mut resumed, dir.path()).unwrap();
        assert_eq!(fs::read_to_string(&history).unwrap(), "history");
        drop(guard);
    }

    #[test]
    fn dsh_gateway_preserves_certified_state_and_keeps_lease_out_of_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = env("dsh-one");
        input.insert(PAYLOAD_ENV.into(), serde_json::json!({"taskId":"dsh-one","binding":{"providerId":"gateway","modelId":"model"},"runtime":"dsh","files":{}}).to_string());
        input.insert("DSH_HOME".into(), "/managed/dsh/dsh-home".into());
        input.insert("COGNIA_DSH_SESSION_ROOT".into(), "/managed/dsh/sessions".into());
        input.insert("COGNIA_DSH_GATEWAY_TOKEN".into(), "temporary-lease".into());
        input.insert("COGNIA_DSH_GATEWAY_CONFIG".into(), "{\"providers\":{}}".into());
        let root = task_home(&input, dir.path()).unwrap().unwrap();
        let guard = prepare(&mut input, dir.path()).unwrap();
        assert_eq!(input["DSH_HOME"], "/managed/dsh/dsh-home");
        assert_eq!(input["COGNIA_DSH_SESSION_ROOT"], "/managed/dsh/sessions");
        assert_eq!(input["COGNIA_DSH_GATEWAY_TOKEN"], "temporary-lease");
        assert!(!input.contains_key(PAYLOAD_ENV));
        assert!(!fs::read_to_string(root.join("binding.json")).unwrap().contains("temporary-lease"));
        drop(guard);
        delete_task("dsh-one", dir.path()).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn freezes_local_owner_and_deletes_only_the_selected_task() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = env("one");
        let raw = input.get_mut(PAYLOAD_ENV).unwrap();
        *raw = raw.replacen('{', "{\"ownerAccountId\":\"owner-one\",", 1);
        let guard = prepare(&mut input, dir.path()).unwrap();
        drop(guard);
        let mut other = env("one");
        let raw = other.get_mut(PAYLOAD_ENV).unwrap();
        *raw = raw.replacen('{', "{\"ownerAccountId\":\"owner-two\",", 1);
        assert!(prepare(&mut other, dir.path()).is_err());
        let mut sibling = env("two");
        let sibling_guard = prepare(&mut sibling, dir.path()).unwrap();
        delete_task("one", dir.path()).unwrap();
        assert!(!task_home(&env("one"), dir.path()).unwrap().unwrap().exists());
        assert!(task_home(&env("two"), dir.path()).unwrap().unwrap().exists());
        drop(sibling_guard);
    }
}
