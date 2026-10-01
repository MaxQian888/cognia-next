//! Host-owned task state. Provider files contain environment references, never lease secrets.
use serde::Deserialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

pub const PAYLOAD_ENV: &str = "COGNIA_GATEWAY_TASK_CONFIG";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPayload {
    task_id: String,
    binding: serde_json::Value,
    owner_account_id: Option<String>,
    #[serde(default)]
    origin_device_id: Option<String>,
    runtime: String,
    files: HashMap<String, String>,
}

fn payload(env: &HashMap<String, String>) -> Result<Option<TaskPayload>, String> {
    let Some(raw) = env.get(PAYLOAD_ENV) else {
        return Ok(None);
    };
    let value: TaskPayload =
        serde_json::from_str(raw).map_err(|_| "Invalid gateway task configuration")?;
    if value.task_id.is_empty()
        || value.task_id.len() > 128
        || !value
            .task_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || !["codex", "opencode", "pi", "claude", "qwen", "dsh"].contains(&value.runtime.as_str())
        || value.files.iter().any(|(name, contents)| {
            ![
                "codex/config.toml",
                "pi/models.json",
                "pi/settings.json",
                "qwen/settings.json",
            ]
            .contains(&name.as_str())
                || contents.len() > 262144
        })
    {
        return Err("Invalid gateway task configuration".into());
    }
    Ok(Some(value))
}

pub fn task_home(env: &HashMap<String, String>, home: &Path) -> Result<Option<PathBuf>, String> {
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    Ok(payload(env)?.map(|value| {
        home.join(".local/share/cognia-agent-tasks")
            .join(value.task_id)
    }))
}

#[cfg(unix)]
fn open_dir(path: &Path, create: bool) -> Result<std::os::fd::OwnedFd, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let start = if path.is_absolute() {
        b"/\0".as_slice()
    } else {
        b".\0".as_slice()
    };
    let fd = unsafe {
        libc::open(
            start.as_ptr().cast(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("Cannot open gateway task root".into());
    }
    let mut dir = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    for part in path.components() {
        let std::path::Component::Normal(name) = part else {
            if matches!(part, std::path::Component::ParentDir) {
                return Err("Invalid gateway task path".into());
            }
            continue;
        };
        let name =
            std::ffi::CString::new(name.as_bytes()).map_err(|_| "Invalid gateway task path")?;
        if create {
            let result = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
            if result < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err("Cannot create gateway task directory".into());
            }
        }
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("Gateway task directory is unavailable or contains a symlink".into());
        }
        dir = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    }
    Ok(dir)
}
#[cfg(unix)]
fn private_dir(path: &Path) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let dir = open_dir(path, true)?;
    if unsafe { libc::fchmod(dir.as_raw_fd(), 0o700) } != 0 {
        return Err("Cannot protect gateway task directory".into());
    }
    Ok(())
}
#[cfg(unix)]
fn open_file(path: &Path, write: bool) -> Result<std::fs::File, String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let dir = open_dir(path.parent().ok_or("Invalid gateway task path")?, write)?;
    let name = std::ffi::CString::new(
        path.file_name()
            .ok_or("Invalid gateway task path")?
            .as_bytes(),
    )
    .map_err(|_| "Invalid gateway task path")?;
    let flags = libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if write {
            libc::O_WRONLY | libc::O_CREAT
        } else {
            libc::O_RDONLY
        };
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o600) };
    if fd < 0 {
        return Err("Cannot open gateway task file safely".into());
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    use std::os::unix::fs::MetadataExt;
    let meta = file
        .metadata()
        .map_err(|_| "Cannot inspect gateway task file")?;
    if !meta.is_file() || meta.nlink() != 1 {
        return Err("Gateway task file must be a private regular file".into());
    }
    if write {
        if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
            return Err("Cannot protect gateway task file".into());
        }
        file.set_len(0)
            .map_err(|_| "Cannot truncate gateway task file")?;
    }
    Ok(file)
}
#[cfg(unix)]
fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::io::Write;
    open_file(path, true)?
        .write_all(contents)
        .map_err(|_| "Cannot write gateway task file".into())
}
#[cfg(unix)]
fn remove_private(path: &Path) {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let Some(parent) = path.parent() else {
        return;
    };
    let Ok(dir) = open_dir(parent, false) else {
        return;
    };
    let Some(name) = path.file_name() else {
        return;
    };
    let Ok(name) = std::ffi::CString::new(name.as_bytes()) else {
        return;
    };
    unsafe {
        libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0);
    }
}
#[cfg(not(unix))]
fn private_dir(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task state must not be a symlink".into());
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            private_dir(parent)?;
        }
    }
    fs::create_dir_all(path).map_err(|e| format!("Cannot create gateway task state: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task file must not be a symlink".into());
    }
    private_dir(path.parent().ok_or("Invalid gateway task path")?)?;
    fs::write(path, contents)
        .map_err(|e| format!("Cannot write gateway task configuration: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn remove_private(path: &Path) {
    let _ = fs::remove_file(path);
}

fn read_private(path: &Path) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        use std::io::Read;
        let mut bytes = Vec::new();
        open_file(path, false)?
            .take(262145)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read task binding")?;
        Ok(bytes)
    }
    #[cfg(not(unix))]
    {
        fs::read(path).map_err(|e| e.to_string())
    }
}

#[cfg(unix)]
fn lock_task(home: &Path, task: &str) -> Result<std::fs::File, String> {
    use std::os::fd::AsRawFd;
    let home = home
        .canonicalize()
        .map_err(|_| "Gateway task home is unavailable")?;
    let file = open_file(
        &home
            .join(".local/share/cognia-agent-tasks/.locks")
            .join(task),
        true,
    )?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("Stop the gateway task before changing its state".into());
    }
    Ok(file)
}
#[cfg(unix)]
fn remove_tree(path: &Path) -> Result<(), String> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    fn clear(
        dir: &std::os::fd::OwnedFd,
        remaining: &mut usize,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 64 {
            return Err("Gateway task state exceeds directory depth limit".into());
        }
        let duplicate = unsafe { libc::dup(dir.as_raw_fd()) };
        if duplicate < 0 {
            return Err("Cannot enumerate task state".into());
        }
        let stream = unsafe { libc::fdopendir(duplicate) };
        if stream.is_null() {
            unsafe {
                libc::close(duplicate);
            };
            return Err("Cannot enumerate task state".into());
        }
        struct Dir(*mut libc::DIR);
        impl Drop for Dir {
            fn drop(&mut self) {
                unsafe {
                    libc::closedir(self.0);
                }
            }
        }
        let stream = Dir(stream);
        loop {
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                break;
            }
            let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            if *remaining == 0 {
                return Err("Gateway task state exceeds entry limit".into());
            }
            *remaining -= 1;
            let mut meta = std::mem::MaybeUninit::<libc::stat>::uninit();
            if unsafe {
                libc::fstatat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    meta.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err("Cannot inspect task state".into());
            }
            let meta = unsafe { meta.assume_init() };
            let directory = meta.st_mode & libc::S_IFMT == libc::S_IFDIR;
            if directory {
                let child = unsafe {
                    libc::openat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if child < 0 {
                    return Err("Cannot open task directory safely".into());
                }
                clear(
                    &unsafe { std::os::fd::OwnedFd::from_raw_fd(child) },
                    remaining,
                    depth + 1,
                )?;
            }
            if unsafe {
                libc::unlinkat(
                    dir.as_raw_fd(),
                    name.as_ptr(),
                    if directory { libc::AT_REMOVEDIR } else { 0 },
                )
            } != 0
            {
                return Err("Cannot remove gateway task entry".into());
            }
        }
        Ok(())
    }
    let dir = open_dir(path, false)?;
    clear(&dir, &mut 100000, 0)?;
    let parent = open_dir(path.parent().ok_or("Invalid task root")?, false)?;
    let name = std::ffi::CString::new(path.file_name().ok_or("Invalid task root")?.as_bytes())
        .map_err(|_| "Invalid task root")?;
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err("Cannot remove gateway task root".into());
    }
    Ok(())
}

pub struct TaskFiles {
    files: Vec<PathBuf>,
    #[cfg(unix)]
    _lock: Option<std::fs::File>,
}
impl Drop for TaskFiles {
    fn drop(&mut self) {
        for file in &self.files {
            remove_private(file);
        }
    }
}

#[cfg(unix)]
impl TaskFiles {
    pub fn assign_owner(
        &self,
        env: &HashMap<String, String>,
        uid: u32,
        gid: u32,
    ) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        let root = Path::new(env.get("HOME").ok_or("Missing task home")?);
        let mut directories = std::collections::HashSet::from([root.to_path_buf()]);
        for value in env.values() {
            let path = Path::new(value);
            if path.starts_with(root) && path.is_dir() {
                directories.insert(path.to_path_buf());
            }
        }
        for path in self
            .files
            .iter()
            .chain(std::iter::once(&root.join("binding.json")))
        {
            let file = open_file(path, false)?;
            if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0 {
                return Err("Cannot assign gateway task file ownership".into());
            }
            for parent in path.ancestors().skip(1).take_while(|p| p.starts_with(root)) {
                directories.insert(parent.to_path_buf());
            }
        }
        for path in directories {
            let dir = open_dir(&path, false)?;
            if unsafe { libc::fchown(dir.as_raw_fd(), uid, gid) } != 0 {
                return Err("Cannot assign gateway task directory ownership".into());
            }
        }
        for parent in root
            .ancestors()
            .skip(1)
            .take_while(|p| p.starts_with("/run/cognia-agent-task-state"))
        {
            let dir = open_dir(parent, false)?;
            if unsafe { libc::fchmod(dir.as_raw_fd(), 0o711) } != 0 {
                return Err("Cannot traverse gateway task state".into());
            }
        }
        Ok(())
    }
}

pub fn prepare(
    env: &mut HashMap<String, String>,
    home: &Path,
) -> Result<Option<TaskFiles>, String> {
    prepare_inner(env, home, home == Path::new("/run/cognia-agent-task-state"))
}
fn prepare_inner(
    env: &mut HashMap<String, String>,
    home: &Path,
    protected: bool,
) -> Result<Option<TaskFiles>, String> {
    let Some(value) = payload(env)? else {
        return Ok(None);
    };
    #[cfg(unix)]
    let lock = lock_task(home, &value.task_id)?;
    let root = task_home(env, home)?.ok_or("Missing gateway task home")?;
    private_dir(&root)?;
    let binding_path = if protected {
        root.parent()
            .ok_or("Missing task parent")?
            .join(".bindings")
            .join(format!("{}.json", value.task_id))
    } else {
        root.join("binding.json")
    };
    if protected
        && !binding_path.exists()
        && fs::read_dir(&root)
            .map_err(|_| "Cannot inspect gateway task state")?
            .next()
            .is_some()
    {
        return Err("Retained task has no trusted Host binding".into());
    }
    let mut binding = serde_json::json!({ "binding": value.binding, "runtime": value.runtime, "ownerAccountId": value.owner_account_id });
    if let Some(device) = value.origin_device_id {
        binding["originDeviceId"] = serde_json::Value::String(device);
    }
    if binding_path.exists() {
        let existing: serde_json::Value = serde_json::from_slice(&read_private(&binding_path)?)
            .map_err(|_| "Invalid saved gateway task binding")?;
        if existing != binding {
            return Err(
                "This task is bound to a different model or account; start a new task".into(),
            );
        }
    } else {
        write_private(
            &binding_path,
            &serde_json::to_vec(&binding).map_err(|e| e.to_string())?,
        )?;
    }
    if protected {
        write_private(
            &root.join("binding.json"),
            &serde_json::to_vec(&binding).map_err(|_| "Cannot encode task binding")?,
        )?;
    }
    let mut guard = TaskFiles {
        files: vec![],
        #[cfg(unix)]
        _lock: Some(lock),
    };
    for (name, contents) in value.files {
        let path = root.join(name);
        guard.files.push(path.clone());
        write_private(&path, contents.as_bytes())?;
    }
    for (key, relative) in [
        ("HOME", ""),
        ("USERPROFILE", ""),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_STATE_HOME", "state"),
        ("CODEX_HOME", "codex"),
        ("PI_CODING_AGENT_DIR", "pi"),
        ("CLAUDE_CONFIG_DIR", "claude"),
        ("OPENCODE_CONFIG_DIR", "config/opencode"),
    ] {
        let path = if relative.is_empty() {
            root.clone()
        } else {
            root.join(relative)
        };
        private_dir(&path)?;
        env.insert(key.into(), path.to_string_lossy().into_owned());
    }
    if value.runtime == "qwen" {
        let runtime = root.join("qwen-runtime");
        private_dir(&runtime)?;
        env.insert(
            "QWEN_HOME".into(),
            root.join("qwen").to_string_lossy().into_owned(),
        );
        env.insert(
            "QWEN_RUNTIME_DIR".into(),
            runtime.to_string_lossy().into_owned(),
        );
        for key in [
            "QWEN_CODE_SYSTEM_SETTINGS_PATH",
            "QWEN_CODE_SYSTEM_DEFAULTS_PATH",
        ] {
            env.insert(
                key.into(),
                root.join("qwen/settings.json")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    env.remove(PAYLOAD_ENV);
    Ok(Some(guard))
}

/// Runtime essentials only. No auth, provider settings, home, or shell injection.
pub fn runtime_environment() -> HashMap<String, String> {
    [
        "PATH",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "COLORTERM",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SYSTEMROOT",
        "WINDIR",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
    ]
    .into_iter()
    .filter_map(|key| {
        std::env::var(key)
            .ok()
            .map(|value| (key.to_string(), value))
    })
    .collect()
}

pub fn delete_task(task_id: &str, home: &Path) -> Result<(), String> {
    delete_task_for_device(task_id, home, None)
}

pub fn delete_task_for_device(
    task_id: &str,
    home: &Path,
    device: Option<&str>,
) -> Result<(), String> {
    if task_id.is_empty()
        || task_id.len() > 128
        || !task_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid gateway task id".into());
    }
    let home = home.canonicalize().unwrap_or_else(|_| home.to_path_buf());
    let parent = home.join(".local/share/cognia-agent-tasks");
    if !parent.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&parent).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task state must not be a symlink".into());
    }
    let root = parent.join(task_id);
    if !root.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Gateway task state must not be a symlink".into());
    }
    #[cfg(unix)]
    let _lock = lock_task(&home, task_id)?;
    if let Some(device) = device {
        let binding: serde_json::Value = serde_json::from_slice(&read_private(&if home
            == Path::new("/run/cognia-agent-task-state")
        {
            parent.join(".bindings").join(format!("{task_id}.json"))
        } else {
            root.join("binding.json")
        })?)
        .map_err(|_| "Invalid saved gateway task binding")?;
        if binding
            .get("originDeviceId")
            .and_then(|value| value.as_str())
            != Some(device)
        {
            return Err("Gateway task belongs to another paired device".into());
        }
    }
    #[cfg(unix)]
    {
        remove_tree(&root)?;
        if home == Path::new("/run/cognia-agent-task-state") {
            remove_private(&parent.join(".bindings").join(format!("{task_id}.json")));
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::remove_dir_all(root).map_err(|e| format!("Cannot remove gateway task state: {e}"))
    }
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
        changed.insert(
            PAYLOAD_ENV.into(),
            changed[PAYLOAD_ENV].replace("\"model\"", "\"other\""),
        );
        assert!(prepare(&mut changed, dir.path()).is_err());
    }
    #[test]
    fn rejects_path_traversal_and_unknown_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare(&mut env("../escape"), dir.path()).is_err());
        let mut input = env("ok");
        input.insert(
            PAYLOAD_ENV.into(),
            input[PAYLOAD_ENV].replace("pi/models.json", "../secret"),
        );
        assert!(prepare(&mut input, dir.path()).is_err());
    }

    #[test]
    fn pins_qwen_system_settings_and_retains_session_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut input = env("qwen-one");
        input.insert(
            PAYLOAD_ENV.into(),
            input[PAYLOAD_ENV]
                .replace("\"pi\"", "\"qwen\"")
                .replace("pi/models.json", "qwen/settings.json"),
        );
        let original = input.clone();
        let guard = prepare(&mut input, dir.path()).unwrap();
        let settings = PathBuf::from(&input["QWEN_CODE_SYSTEM_SETTINGS_PATH"]);
        assert_eq!(
            settings,
            PathBuf::from(&input["QWEN_HOME"]).join("settings.json")
        );
        assert_eq!(
            input["QWEN_CODE_SYSTEM_DEFAULTS_PATH"],
            input["QWEN_CODE_SYSTEM_SETTINGS_PATH"]
        );
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
        input.insert(
            "COGNIA_DSH_SESSION_ROOT".into(),
            "/managed/dsh/sessions".into(),
        );
        input.insert("COGNIA_DSH_GATEWAY_TOKEN".into(), "temporary-lease".into());
        input.insert(
            "COGNIA_DSH_GATEWAY_CONFIG".into(),
            "{\"providers\":{}}".into(),
        );
        let root = task_home(&input, dir.path()).unwrap().unwrap();
        let guard = prepare(&mut input, dir.path()).unwrap();
        assert_eq!(input["DSH_HOME"], "/managed/dsh/dsh-home");
        assert_eq!(input["COGNIA_DSH_SESSION_ROOT"], "/managed/dsh/sessions");
        assert_eq!(input["COGNIA_DSH_GATEWAY_TOKEN"], "temporary-lease");
        assert!(!input.contains_key(PAYLOAD_ENV));
        assert!(!fs::read_to_string(root.join("binding.json"))
            .unwrap()
            .contains("temporary-lease"));
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
        assert!(!task_home(&env("one"), dir.path())
            .unwrap()
            .unwrap()
            .exists());
        assert!(task_home(&env("two"), dir.path())
            .unwrap()
            .unwrap()
            .exists());
        drop(sibling_guard);
    }
    #[test]
    fn remote_task_history_is_bound_to_device_and_desktop_account() {
        let dir = tempfile::tempdir().unwrap();
        let remote_env = |device: &str, owner: &str| {
            let mut input = env("remote-one");
            let mut payload: serde_json::Value = serde_json::from_str(&input[PAYLOAD_ENV]).unwrap();
            payload["originDeviceId"] = serde_json::json!(device);
            payload["ownerAccountId"] = serde_json::json!(owner);
            input.insert(PAYLOAD_ENV.into(), payload.to_string());
            input
        };
        drop(prepare(&mut remote_env("device-a", "desktop-a"), dir.path()).unwrap());
        assert!(prepare(&mut remote_env("device-b", "desktop-a"), dir.path()).is_err());
        assert!(prepare(&mut remote_env("device-a", "desktop-b"), dir.path()).is_err());
        assert!(delete_task_for_device("remote-one", dir.path(), Some("device-b")).is_err());
        delete_task_for_device("remote-one", dir.path(), Some("device-a")).unwrap();
    }
}

/// Only called after the Host has checked all gateway endpoints against its
/// authenticated listener. Replace the full authority including its boundary.
pub fn rewrite_endpoint(
    env: &mut HashMap<String, String>,
    argv: &mut [String],
    old: u16,
    new: u16,
) -> Result<(), String> {
    if old == 0 || new == 0 {
        return Err("Invalid gateway listener".into());
    }
    let from = format!("http://127.0.0.1:{old}");
    let to = format!("http://127.0.0.1:{new}");
    fn replace(value: &str, from: &str, to: &str) -> String {
        let mut result = String::new();
        let mut remaining = value;
        while let Some(index) = remaining.find(from) {
            result.push_str(&remaining[..index]);
            let tail = &remaining[index + from.len()..];
            if tail.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                result.push_str(from);
            } else {
                result.push_str(to);
            }
            remaining = tail;
        }
        result.push_str(remaining);
        result
    }
    for value in env.values_mut() {
        *value = replace(value, &from, &to);
    }
    for value in argv {
        *value = replace(value, &from, &to);
    }
    Ok(())
}

#[cfg(unix)]
pub mod sandbox {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    pub const NONCE_ENV: &str = "COGNIA_GATEWAY_BRIDGE_NONCE";
    pub const PORT_ENV: &str = "COGNIA_GATEWAY_HOST_PORT";
    const ROOT: &str = "/run/cognia-gateway-bridges";
    fn bridge_path(nonce: &str) -> Result<PathBuf, String> {
        if nonce.len() != 32 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid gateway bridge identity".into());
        }
        Ok(Path::new(ROOT).join(nonce))
    }
    fn secure_root() -> Result<(), String> {
        let root = Path::new(ROOT);
        if !root.exists() {
            private_dir(root)?;
        }
        let meta = fs::symlink_metadata(root).map_err(|_| "Missing gateway rendezvous")?;
        if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o077 != 0 {
            return Err("Untrusted gateway rendezvous".into());
        }
        Ok(())
    }
    pub struct ReadyFile(PathBuf);
    impl ReadyFile {
        pub fn persist(mut self) {
            self.0 = PathBuf::new();
        }
    }
    impl Drop for ReadyFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    pub fn publish(nonce: &str, port: u16) -> Result<ReadyFile, String> {
        let path = bridge_path(nonce)?;
        secure_root()?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .map_err(|_| "Cannot publish gateway readiness")?;
        let guard = ReadyFile(path);
        file.write_all(&port.to_be_bytes())
            .map_err(|_| "Cannot publish gateway readiness")?;
        Ok(guard)
    }
    pub fn initialize(
        env: &mut HashMap<String, String>,
        argv: &mut [String],
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<Option<TaskFiles>, String> {
        let Some(nonce) = env.remove(NONCE_ENV) else {
            if env.contains_key(PAYLOAD_ENV) {
                return Err("Gateway task has no Host bridge authority".into());
            }
            return Ok(None);
        };
        let path = bridge_path(&nonce)?;
        let old: Option<u16> = env
            .remove(PORT_ENV)
            .map(|v| v.parse().map_err(|_| "Invalid Host gateway port"))
            .transpose()?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let port = loop {
            if cancelled() {
                return Err("Gateway startup cancelled".into());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Host gateway bridge startup timed out".into());
            }
            if let Ok(mut file) = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)
            {
                secure_root()?;
                let meta = file
                    .metadata()
                    .map_err(|_| "Cannot inspect gateway readiness")?;
                if !meta.is_file() || meta.uid() != 0 || meta.mode() & 0o077 != 0 || meta.len() > 2
                {
                    return Err("Untrusted gateway readiness".into());
                }
                let mut bytes = [0; 2];
                if file.read_exact(&mut bytes).is_ok() {
                    break u16::from_be_bytes(bytes);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let _ = fs::remove_file(&path);
        let Some(old) = old else {
            if env.contains_key(PAYLOAD_ENV) {
                return Err("Gateway task has no Host listener".into());
            }
            return Ok(None);
        };
        rewrite_endpoint(env, argv, old, port)?;
        let managed: HashMap<String, String> = serde_json::from_str(
            &env.remove("COGNIA_GATEWAY_RUNTIME_ENV")
                .ok_or("Missing managed gateway environment")?,
        )
        .map_err(|_| "Invalid managed gateway environment")?;
        if managed.keys().any(|key| {
            ![
                "OPENAI_BASE_URL",
                "OPENAI_API_KEY",
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_AUTH_TOKEN",
            ]
            .contains(&key.as_str())
        }) {
            return Err("Invalid managed gateway environment key".into());
        }
        env.extend(managed);
        // Root owns the parent: another sandbox uid cannot redirect creation.
        let root = Path::new("/run/cognia-agent-task-state");
        let directory = open_dir(root, true)?;
        use std::os::fd::AsRawFd;
        if unsafe { libc::fchmod(directory.as_raw_fd(), 0o711) } != 0 {
            return Err("Cannot prepare gateway task state root".into());
        }
        prepare(env, root)
    }
}

#[cfg(test)]
mod sandbox_tests {
    use super::*;
    #[test]
    fn sandbox_binding_is_authoritative_outside_user_owned_history() {
        let temp = tempfile::tempdir().unwrap();
        let original=HashMap::from([(PAYLOAD_ENV.into(),serde_json::json!({"taskId":"task","runtime":"claude","binding":{"modelId":"original"},"originDeviceId":"device-a","files":{}}).to_string())]);
        let mut first = original.clone();
        drop(prepare_inner(&mut first, temp.path(), true).unwrap());
        let root = Path::new(&first["HOME"]);
        fs::write(root.join("binding.json"), b"{}").unwrap();
        drop(prepare_inner(&mut original.clone(), temp.path(), true).unwrap());
        let mut changed = original.clone();
        changed.get_mut(PAYLOAD_ENV).unwrap().push(' ');
        changed.insert(
            PAYLOAD_ENV.into(),
            changed[PAYLOAD_ENV].replace("original", "other"),
        );
        assert!(prepare_inner(&mut changed, temp.path(), true).is_err());
        fs::remove_file(root.parent().unwrap().join(".bindings/task.json")).unwrap();
        assert!(prepare_inner(&mut original.clone(), temp.path(), true).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn fifo_state_is_rejected_without_blocking_and_active_task_cannot_be_deleted() {
        use std::os::unix::ffi::OsStrExt;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("fifo");
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(open_file(&path, false).is_err());
        assert!(open_file(&path, true).is_err());
        let mut env=HashMap::from([(PAYLOAD_ENV.into(),serde_json::json!({"taskId":"task","runtime":"claude","binding":{},"originDeviceId":"device-a","files":{}}).to_string())]);
        let guard = prepare(&mut env, temp.path()).unwrap().unwrap();
        assert!(delete_task_for_device("task", temp.path(), Some("device-a")).is_err());
        drop(guard);
        assert!(delete_task_for_device("task", temp.path(), Some("device-b")).is_err());
        delete_task_for_device("task", temp.path(), Some("device-a")).unwrap();
        assert!(!Path::new(&env["HOME"]).exists());
    }
    #[cfg(unix)]
    #[test]
    fn resumed_task_never_follows_replaced_parent_or_hardlinks() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("config.toml"), b"untouched").unwrap();
        let root = temp.path().canonicalize().unwrap().join("task");
        private_dir(&root).unwrap();
        symlink(&outside, root.join("codex")).unwrap();
        assert!(write_private(&root.join("codex/config.toml"), b"overwrite").is_err());
        let guard = TaskFiles {
            files: vec![root.join("codex/config.toml")],
            _lock: None,
        };
        drop(guard);
        assert_eq!(fs::read(outside.join("config.toml")).unwrap(), b"untouched");
        fs::hard_link(outside.join("config.toml"), root.join("hardlink")).unwrap();
        assert!(write_private(&root.join("hardlink"), b"overwrite").is_err());
        assert_eq!(fs::read(outside.join("config.toml")).unwrap(), b"untouched");
    }
    #[cfg(unix)]
    #[test]
    fn materialized_owner_assignment_refuses_replaced_config_directory() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let mut env=HashMap::from([(PAYLOAD_ENV.into(),serde_json::json!({"taskId":"task","runtime":"codex","binding":{},"files":{"codex/config.toml":"model = \"custom\""}}).to_string())]);
        let guard = prepare(&mut env, temp.path()).unwrap().unwrap();
        let root = Path::new(&env["HOME"]);
        fs::rename(root.join("codex"), root.join("original")).unwrap();
        symlink(root.join("original"), root.join("codex")).unwrap();
        assert!(guard
            .assign_owner(&env, unsafe { libc::geteuid() }, unsafe { libc::getegid() })
            .is_err());
    }
    #[test]
    fn sandbox_endpoint_rewrite_preserves_other_config_and_arguments() {
        let mut env = HashMap::from([
            ("OPENAI_BASE_URL".into(), "http://127.0.0.1:1234/v1".into()),
            ("ANTHROPIC_BASE_URL".into(), "http://127.0.0.1:1234".into()),
            (PAYLOAD_ENV.into(), serde_json::json!({"taskId":"task", "runtime":"codex", "binding":{}, "files":{"codex/config.toml":"base_url = \"http://127.0.0.1:1234/v1\"\nmodel = \"custom\""}}).to_string()),
        ]);
        let mut argv = vec![
            "agent".into(),
            "--openai-base-url".into(),
            "http://127.0.0.1:1234/v1".into(),
            "custom".into(),
        ];
        rewrite_endpoint(&mut env, &mut argv, 1234, 4321).unwrap();
        assert_eq!(env["OPENAI_BASE_URL"], "http://127.0.0.1:4321/v1");
        assert_eq!(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:4321");
        assert!(env[PAYLOAD_ENV].contains("custom"));
        assert!(!env[PAYLOAD_ENV].contains(":1234"));
        assert_eq!(argv[2], "http://127.0.0.1:4321/v1");
        assert_eq!(argv[3], "custom");
    }
}
