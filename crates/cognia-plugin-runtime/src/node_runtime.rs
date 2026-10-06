//! Explicit preparation of a plugin's locked, optional Node dependency tree.
//!
//! This executes trusted plugin code under its existing execution grant. It is
//! not a document sandbox and does not expose a general command/argv API.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{watch, Semaphore};

use crate::{contained_path, PluginRuntimeState};

const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SOURCE_FILES: usize = 256;
const PREPARE_TIMEOUT: Duration = Duration::from_secs(900);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const RECEIPT: &str = "cognia-runtime-receipt.json";

type Result<T> = std::result::Result<T, RuntimeError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RuntimeError {
    pub code: String,
    pub message: String,
}

impl RuntimeError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for RuntimeError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    state: String,
    prepared: bool,
    fingerprint: String,
    updated_at: i64,
    package_manager: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RuntimeError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Declaration {
    directory: String,
    entry: String,
}

#[derive(Clone)]
struct Bundle {
    entry: String,
    files: BTreeMap<String, Vec<u8>>,
    fingerprint: String,
    package_manager: String,
}

struct Active {
    status: RuntimeStatus,
    cancel: watch::Sender<bool>,
}

struct ActiveGuard(PathBuf);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE.lock().remove(&self.0);
    }
}

static ACTIVE: LazyLock<Mutex<HashMap<PathBuf, Active>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static INSTALL_SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

fn invalid(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new("INVALID_REQUEST", message)
}

fn read_bounded(root: &Path, name: &str) -> Result<Vec<u8>> {
    use std::io::Read;
    let relative = contained_path::validate_plugin_relative_path(name).map_err(invalid)?;
    let mut directory = Dir::open_ambient_dir(root, ambient_authority())?;
    if let Some(parent) = relative.parent() {
        for segment in parent.components() {
            directory = directory.open_dir_nofollow(segment.as_os_str())?;
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = directory.open_with(
        relative
            .file_name()
            .ok_or_else(|| invalid("missing file name"))?,
        &options,
    )?;
    if !file.metadata()?.is_file() {
        return Err(invalid("runtime source must be a regular file"));
    }
    let mut bytes = Vec::new();
    file.take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err(invalid("runtime source exceeds 32 MiB"));
    }
    Ok(bytes)
}

fn snapshot(state: &PluginRuntimeState, plugin_id: &str) -> Result<Bundle> {
    crate::validate_plugin_id_path_component(plugin_id).map_err(|e| invalid(e.to_string()))?;
    let root = state.plugin_dir(plugin_id);
    let manifest = ["plugin.json", "manifest.json"]
        .into_iter()
        .find(|name| root.join(name).is_file())
        .ok_or_else(|| invalid("installed plugin manifest is missing"))?;
    let bytes = read_bounded(&root, manifest)?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    let declaration: Declaration =
        serde_json::from_value(manifest.get("nodeRuntime").cloned().ok_or_else(|| {
            RuntimeError::new("NOT_SUPPORTED", "plugin declares no optional Node runtime")
        })?)
        .map_err(|e| invalid(e.to_string()))?;
    contained_path::validate_plugin_relative_path(&declaration.directory).map_err(invalid)?;
    let directory = contained_path::resolve_existing_plugin_dir(&root, &declaration.directory)
        .map_err(invalid)?;
    let entry =
        contained_path::validate_plugin_relative_path(&declaration.entry).map_err(invalid)?;
    if !matches!(
        entry.extension().and_then(|s| s.to_str()),
        Some("mjs" | "cjs" | "js")
    ) {
        return Err(invalid(
            "runtime entry must be JavaScript relative to its runtime directory",
        ));
    }
    let mut files = BTreeMap::new();
    collect_files(&directory, &directory, &mut files, &mut 0)?;
    let entry = entry.to_string_lossy().replace('\\', "/");
    for required in [
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        &entry,
    ] {
        if !files.contains_key(required) {
            return Err(invalid(format!("runtime bundle is missing {required}")));
        }
    }
    let package: Value =
        serde_json::from_slice(&files["package.json"]).map_err(|e| invalid(e.to_string()))?;
    let package_manager = package
        .get("packageManager")
        .and_then(Value::as_str)
        .filter(|value| {
            value.strip_prefix("pnpm@").is_some_and(|version| {
                let core = version.split('+').next().unwrap_or("");
                core.split('.').count() == 3
                    && core
                        .split('.')
                        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
            })
        })
        .ok_or_else(|| invalid("runtime packageManager must pin an exact pnpm version"))?
        .to_string();
    let mut digest = Sha256::new();
    digest.update(format!(
        "node-runtime-v1:{}:{}:{entry}\0",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    for (name, bytes) in &files {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(Bundle {
        entry,
        files,
        fingerprint: hex::encode(digest.finalize()),
        package_manager,
    })
}

fn collect_files(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    total: &mut usize,
) -> Result<()> {
    for item in std::fs::read_dir(current)? {
        let path = item?.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(invalid("runtime bundles must not contain symlinks"));
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid("runtime path escaped bundle"))?;
        if relative.components().any(|c| {
            matches!(
                c.as_os_str().to_str(),
                Some("node_modules" | ".git" | "cognia-runtime-receipt.json")
            )
        }) {
            return Err(invalid(
                "runtime bundle contains a generated or reserved path",
            ));
        }
        if metadata.is_dir() {
            collect_files(root, &path, files, total)?;
            continue;
        }
        if !metadata.is_file()
            || files.len() >= MAX_SOURCE_FILES
            || metadata.len() > MAX_SOURCE_BYTES as u64
        {
            return Err(invalid(
                "runtime bundle exceeds file limits or contains a special file",
            ));
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        let bytes = read_bounded(root, &name)?;
        *total = total
            .checked_add(bytes.len())
            .ok_or_else(|| invalid("runtime bundle is too large"))?;
        if *total > MAX_SOURCE_BYTES {
            return Err(invalid("runtime bundle exceeds 32 MiB"));
        }
        files.insert(name, bytes);
    }
    Ok(())
}

fn cache_root(state: &PluginRuntimeState, plugin_id: &str) -> Result<PathBuf> {
    let account = state
        .active_account_id()
        .map_err(|e| RuntimeError::new("UNAVAILABLE", e.to_string()))?;
    std::fs::create_dir_all(&state.plugin_install_dir)?;
    let mut dir = Dir::open_ambient_dir(&state.plugin_install_dir, ambient_authority())?;
    // Open every level without following symlinks. Runtime data is outside the
    // plugin's filesystem API root and partitioned by authenticated account.
    for segment in [".host-state", plugin_id, "node-runtime", &account] {
        match dir.create_dir(segment) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        dir = dir.open_dir_nofollow(segment)?;
    }
    Ok(state
        .plugin_host_state_dir(plugin_id)
        .join("node-runtime")
        .join(account)
        .canonicalize()?)
}

fn status(root: &Path, bundle: &Bundle) -> RuntimeStatus {
    if let Some(active) = ACTIVE.lock().get(root) {
        return active.status.clone();
    }
    let cache = root.join(&bundle.fingerprint);
    let prepared = validate_cache(&cache, bundle).is_ok();
    if let Some(mut previous) = read_bounded(root, "last-status.json")
        .ok()
        .and_then(|bytes| serde_json::from_slice::<RuntimeStatus>(&bytes).ok())
        .filter(|previous| {
            previous.fingerprint == bundle.fingerprint
                && previous.package_manager == bundle.package_manager
        })
    {
        if prepared && previous.state == "prepared" {
            return previous;
        }
        if !prepared && previous.state == "failed" {
            previous.prepared = false;
            return previous;
        }
        if previous.state == "preparing" {
            previous.state = "failed".into();
            previous.prepared = prepared;
            previous.error = Some(RuntimeError::new(
                "INTERRUPTED",
                "runtime preparation was interrupted; retry explicitly",
            ));
            return previous;
        }
    }
    RuntimeStatus {
        state: if prepared { "prepared" } else { "missing" }.into(),
        prepared,
        fingerprint: bundle.fingerprint.clone(),
        updated_at: chrono::Utc::now().timestamp_millis(),
        package_manager: bundle.package_manager.clone(),
        error: None,
        probe: None,
    }
}

fn persist_status(root: &Path, status: &RuntimeStatus) -> Result<()> {
    let temporary = format!(".status-{}.json", uuid::Uuid::new_v4());
    let bytes = serde_json::to_vec(status).map_err(|e| invalid(e.to_string()))?;
    contained_path::write_plugin_file(root, &temporary, &bytes).map_err(invalid)?;
    std::fs::rename(root.join(&temporary), root.join("last-status.json"))?;
    Ok(())
}

fn validate_cache(cache: &Path, bundle: &Bundle) -> Result<()> {
    contained_path::resolve_existing_plugin_dir(cache, ".").map_err(invalid)?;
    let receipt = contained_path::read_existing_plugin_file(cache, RECEIPT).map_err(invalid)?;
    let receipt: Value = serde_json::from_slice(&receipt).map_err(|e| invalid(e.to_string()))?;
    if receipt.get("fingerprint").and_then(Value::as_str) != Some(&bundle.fingerprint) {
        return Err(invalid("runtime receipt does not match bundle"));
    }
    contained_path::resolve_existing_plugin_dir(cache, "node_modules").map_err(invalid)?;
    verify_sources(cache, bundle)
}

fn verify_sources(cache: &Path, bundle: &Bundle) -> Result<()> {
    for (name, expected) in &bundle.files {
        if read_bounded(cache, name)? != *expected {
            return Err(invalid(
                "runtime source or installation policy changed during preparation",
            ));
        }
    }
    Ok(())
}

fn resolve_program(name: &str) -> Result<PathBuf> {
    let direct = Path::new(name);
    if direct.is_absolute() {
        return direct.canonicalize().map_err(Into::into);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os("PNPM_HOME") {
        dirs.push(home.into());
    }
    for dir in dirs {
        for suffix in if cfg!(windows) {
            vec!["", ".exe", ".cmd"]
        } else {
            vec![""]
        } {
            let candidate = dir.join(format!("{name}{suffix}"));
            if candidate.is_file() {
                return candidate.canonicalize().map_err(Into::into);
            }
        }
    }
    Err(RuntimeError::new(
        "UNAVAILABLE",
        format!("{name} is not installed on the host PATH"),
    ))
}

fn node_program() -> Result<PathBuf> {
    let selected = cognia_core::node_runtime::node_executable()
        .map_err(|e| RuntimeError::new("UNAVAILABLE", e.to_string()))?;
    let path = resolve_program(&selected.to_string_lossy())?;
    cognia_core::node_runtime::validate_system_node(path.clone())
        .map_err(|e| RuntimeError::new("UNAVAILABLE", e.to_string()))?;
    Ok(path)
}

/// Resolve an already installed exact pnpm toolchain before the PATH launcher.
/// pnpm's normal launcher may select/download packageManager automatically;
/// discovery here only reads its existing managed-tool directories.
fn pnpm_program(package_manager: &str) -> Result<PathBuf> {
    let version = package_manager
        .strip_prefix("pnpm@")
        .unwrap_or("")
        .split('+')
        .next()
        .unwrap_or("");
    let mut homes = Vec::new();
    if let Some(path) = std::env::var_os("PNPM_HOME") {
        homes.push(PathBuf::from(path));
    }
    if let Some(home) = dirs::home_dir() {
        homes.extend([home.join("Library/pnpm"), home.join(".local/share/pnpm")]);
        for cache in [
            home.join(".cache/node/corepack"),
            home.join("Library/Caches/node/corepack"),
        ] {
            for entry in ["bin/pnpm.mjs", "bin/pnpm.cjs", "dist/pnpm.cjs"] {
                let candidate = cache.join("v1/pnpm").join(version).join(entry);
                if candidate.is_file() {
                    return candidate.canonicalize().map_err(Into::into);
                }
            }
        }
    }
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        homes.push(PathBuf::from(path).join("pnpm"));
    }
    for home in homes {
        for entry in [
            "node_modules/pnpm/bin/pnpm.mjs",
            "node_modules/pnpm/bin/pnpm.cjs",
            "node_modules/.bin/pnpm.exe",
        ] {
            let candidate = home.join(".tools/pnpm").join(version).join(entry);
            if candidate.is_file() {
                return candidate.canonicalize().map_err(Into::into);
            }
        }
    }
    resolve_program("pnpm")
}

fn selected_node_path(
    node: &Path,
    inherited: Option<std::ffi::OsString>,
) -> Result<std::ffi::OsString> {
    let mut paths = vec![node
        .parent()
        .ok_or_else(|| invalid("Node executable has no parent"))?
        .to_path_buf()];
    if let Some(path) = inherited {
        paths.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(paths).map_err(|e| invalid(e.to_string()))
}

fn authorize(state: &PluginRuntimeState, plugin: &str, operation: &str) -> Result<()> {
    let permissions: &[&str] = match operation {
        "status" => &["filesystem:read"],
        "prepare" => &[
            "shell:execute",
            "filesystem:read",
            "filesystem:write",
            "network:fetch",
        ],
        _ => &["shell:execute", "filesystem:read", "filesystem:write"],
    };
    for permission in permissions {
        if !state.has_permission(plugin, permission) {
            return Err(RuntimeError::new(
                "PERMISSION_DENIED",
                format!("nodeRuntime:{operation} requires {permission}"),
            ));
        }
    }
    Ok(())
}

/// Every call is plugin/account scoped; callers cannot choose commands or paths.
pub(crate) async fn handle(
    state: &PluginRuntimeState,
    plugin: &str,
    operation: &str,
    payload: &Value,
) -> Result<Value> {
    if !matches!(
        operation,
        "status" | "prepare" | "cancel" | "probe" | "remove"
    ) {
        return Err(RuntimeError::new(
            "NOT_SUPPORTED",
            "unknown Node runtime operation",
        ));
    }
    if !payload.as_object().is_some_and(|o| o.is_empty()) {
        return Err(invalid(
            "Node runtime operations accept an empty object only",
        ));
    }
    authorize(state, plugin, operation)?;
    let bundle = snapshot(state, plugin)?;
    let root = cache_root(state, plugin)?;
    match operation {
        "prepare" => {
            if ACTIVE.lock().contains_key(&root) {
                return Ok(json!(status(&root, &bundle)));
            }
            if validate_cache(&root.join(&bundle.fingerprint), &bundle).is_ok() {
                return Ok(json!(status(&root, &bundle)));
            }
            if !state.shell_command_allowed(plugin, "pnpm") {
                return Err(RuntimeError::new(
                    "PERMISSION_DENIED",
                    "runtime preparation requires pnpm in shellCommands",
                ));
            }
            let node = node_program()?;
            let pnpm = pnpm_program(&bundle.package_manager)?;
            let permit = INSTALL_SLOTS.clone().try_acquire_owned().map_err(|_| {
                RuntimeError::new("BUSY", "two runtime installations are already active")
            })?;
            let (cancel, receiver) = watch::channel(false);
            let mut preparing = status(&root, &bundle);
            preparing.state = "preparing".into();
            preparing.error = None;
            preparing.probe = None;
            {
                let mut active = ACTIVE.lock();
                if active.contains_key(&root) {
                    return Err(RuntimeError::new(
                        "BUSY",
                        "runtime operation is already active",
                    ));
                }
                active.insert(
                    root.clone(),
                    Active {
                        status: preparing.clone(),
                        cancel,
                    },
                );
            }
            if let Err(error) = persist_status(&root, &preparing) {
                ACTIVE.lock().remove(&root);
                return Err(error);
            }
            let owner = state.clone();
            let plugin = plugin.to_string();
            let answer = preparing.clone();
            tokio::spawn(async move {
                let _active_guard = ActiveGuard(root.clone());
                let _permit = permit;
                let result = prepare(&owner, &plugin, &root, &bundle, &node, &pnpm, receiver).await;
                let mut final_status = preparing;
                final_status.updated_at = chrono::Utc::now().timestamp_millis();
                match result {
                    Ok(()) => {
                        final_status.state = "prepared".into();
                        final_status.prepared = true;
                    }
                    Err(error) => {
                        final_status.state = "failed".into();
                        final_status.error = Some(error);
                    }
                }
                if let Err(error) = persist_status(&root, &final_status) {
                    log::warn!("cannot persist Node runtime status: {}", error.message);
                }
            });
            return Ok(json!(answer));
        }
        "cancel" => {
            if let Some(active) = ACTIVE.lock().get(&root) {
                let _ = active.cancel.send(true);
            }
        }
        "remove" => {
            let initial = status(&root, &bundle);
            {
                let mut active = ACTIVE.lock();
                if active.contains_key(&root) {
                    return Err(RuntimeError::new(
                        "BUSY",
                        "cancel the active runtime operation before removing it",
                    ));
                }
                let (cancel, _) = watch::channel(false);
                active.insert(
                    root.clone(),
                    Active {
                        status: initial,
                        cancel,
                    },
                );
            }
            let _active_guard = ActiveGuard(root.clone());
            for item in std::fs::read_dir(&root)? {
                let path = item?.path();
                if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
                    return Err(invalid("runtime cache contains a symlink"));
                }
                if path.is_dir() {
                    std::fs::remove_dir_all(path)?;
                } else {
                    std::fs::remove_file(path)?;
                }
            }
            drop(_active_guard);
        }
        "probe" => {
            if !state.shell_command_allowed(plugin, "node") {
                return Err(RuntimeError::new(
                    "PERMISSION_DENIED",
                    "runtime probe requires node in shellCommands",
                ));
            }
            let cache = root.join(&bundle.fingerprint);
            validate_cache(&cache, &bundle)?;
            let (cancel, receiver) = watch::channel(false);
            let initial = status(&root, &bundle);
            {
                let mut active = ACTIVE.lock();
                if active.contains_key(&root) {
                    return Err(RuntimeError::new(
                        "BUSY",
                        "runtime operation is already active",
                    ));
                }
                active.insert(
                    root.clone(),
                    Active {
                        status: initial.clone(),
                        cancel,
                    },
                );
            }
            let _active_guard = ActiveGuard(root.clone());
            let result = async {
                let output = run_process(
                    state,
                    plugin,
                    "probe",
                    &node_program()?,
                    &[cache.join(&bundle.entry).to_string_lossy().into_owned()],
                    &cache,
                    Some("{\"schemaVersion\":1,\"operation\":\"probe\"}\n"),
                    PROBE_TIMEOUT,
                    receiver,
                )
                .await?;
                let envelope: Value = serde_json::from_str(&output).map_err(|_| {
                    RuntimeError::new("INVALID_OUTPUT", "runtime probe returned invalid JSON")
                })?;
                if envelope.get("ok") != Some(&Value::Bool(true)) {
                    return Err(RuntimeError::new(
                        envelope
                            .get("error")
                            .and_then(|e| e.get("code"))
                            .and_then(Value::as_str)
                            .filter(|code| code.len() <= 64)
                            .unwrap_or("PROBE_FAILED"),
                        envelope
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("runtime probe failed"),
                    ));
                }
                Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
            }
            .await;
            let mut answer = initial;
            answer.error = None;
            answer.probe = None;
            answer.updated_at = chrono::Utc::now().timestamp_millis();
            match result {
                Ok(probe) => answer.probe = Some(probe),
                Err(error) => answer.error = Some(error),
            }
            persist_status(&root, &answer)?;
            return Ok(json!(answer));
        }
        _ => {}
    }
    Ok(json!(status(&root, &bundle)))
}

async fn prepare(
    state: &PluginRuntimeState,
    plugin: &str,
    root: &Path,
    bundle: &Bundle,
    node: &Path,
    pnpm: &Path,
    cancel: watch::Receiver<bool>,
) -> Result<()> {
    // A process crash can leave a staging directory before its TempDir guard
    // runs. No active preparation shares this account/plugin reservation.
    for item in std::fs::read_dir(root)? {
        let path = item?.path();
        if path
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with(".prepare-"))
        {
            if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
                return Err(invalid("runtime staging directory must not be a symlink"));
            }
            std::fs::remove_dir_all(path)?;
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".prepare-")
        .tempdir_in(root)?;
    for (name, bytes) in &bundle.files {
        contained_path::write_plugin_file(stage.path(), name, bytes).map_err(invalid)?;
    }
    let (program, prefix) = if matches!(
        pnpm.extension().and_then(|s| s.to_str()),
        Some("js" | "cjs" | "mjs")
    ) {
        (node, vec![pnpm.to_string_lossy().into_owned()])
    } else {
        (pnpm, vec![])
    };
    let mut version_args = prefix.clone();
    version_args.push("--version".into());
    let version = run_process(
        state,
        plugin,
        "prepare",
        program,
        &version_args,
        stage.path(),
        None,
        PROBE_TIMEOUT,
        cancel.clone(),
    )
    .await?;
    let expected = bundle
        .package_manager
        .strip_prefix("pnpm@")
        .unwrap_or("")
        .split('+')
        .next()
        .unwrap_or("");
    if version.trim() != expected {
        return Err(RuntimeError::new(
            "PACKAGE_MANAGER_MISMATCH",
            format!(
                "runtime requires pnpm {expected}, host has {}",
                version.trim()
            ),
        ));
    }
    let mut args = prefix;
    args.extend(
        [
            "install",
            "--frozen-lockfile",
            "--reporter=append-only",
            "--fetch-timeout=900000",
            "--fetch-retries=0",
            "--store-dir",
            ".pnpm-store",
        ]
        .map(String::from),
    );
    let install_output = run_process(
        state,
        plugin,
        "prepare",
        program,
        &args,
        stage.path(),
        None,
        PREPARE_TIMEOUT,
        cancel.clone(),
    )
    .await?;
    // Keep bounded diagnostics for optional dependencies, whose acquisition
    // failures pnpm can report while still returning a successful exit status.
    contained_path::write_plugin_file(root, "last-install.log", install_output.as_bytes())
        .map_err(invalid)?;
    if *cancel.borrow() {
        return Err(RuntimeError::new(
            "CANCELLED",
            "runtime preparation cancelled before publication",
        ));
    }
    authorize(state, plugin, "prepare")?;
    if state.active_account_id().ok().as_deref() != root.file_name().and_then(|s| s.to_str()) {
        return Err(RuntimeError::new(
            "CANCELLED",
            "runtime owner changed before publication",
        ));
    }
    verify_sources(stage.path(), bundle)?;
    contained_path::resolve_existing_plugin_dir(stage.path(), "node_modules").map_err(invalid)?;
    contained_path::write_plugin_file(
        stage.path(),
        RECEIPT,
        &serde_json::to_vec(
            &json!({"fingerprint":bundle.fingerprint,"packageManager":bundle.package_manager}),
        )
        .map_err(|e| invalid(e.to_string()))?,
    )
    .map_err(invalid)?;
    let target = root.join(&bundle.fingerprint);
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    std::fs::rename(stage.path(), &target)?;
    // Keep only this immutable generation. Preparation never modifies the
    // plugin bundle or another plugin's dependency tree.
    for item in std::fs::read_dir(root)? {
        let path = item?.path();
        if path != target
            && path.is_dir()
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            std::fs::remove_dir_all(path)?;
        }
    }
    Ok(())
}

async fn run_process(
    state: &PluginRuntimeState,
    plugin: &str,
    operation: &str,
    program: &Path,
    args: &[String],
    cwd: &Path,
    input: Option<&str>,
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
) -> Result<String> {
    authorize(state, plugin, operation)?;
    // Both installation stages and committed generations are direct children
    // of the authenticated account directory selected before task dispatch.
    let account = cwd
        .parent()
        .and_then(Path::file_name)
        .and_then(|s| s.to_str())
        .ok_or_else(|| invalid("runtime cache has no account owner"))?;
    if state.active_account_id().ok().as_deref() != Some(account) {
        return Err(RuntimeError::new(
            "CANCELLED",
            "runtime owner changed before launch",
        ));
    }
    if *cancel.borrow() {
        return Err(RuntimeError::new(
            "CANCELLED",
            "runtime operation cancelled before launch",
        ));
    }
    if !state.plugins.read().get(plugin).is_some_and(|p| {
        !matches!(
            p.snapshot.status.as_str(),
            "disabled" | "unloaded" | "suspended"
        )
    }) {
        return Err(RuntimeError::new(
            "CANCELLED",
            "runtime plugin is not active",
        ));
    }
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .kill_on_drop(true)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Keep host package-manager policy/config discovery, but never copy API
    // keys or arbitrary injection flags from the app's environment.
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SystemRoot",
        "APPDATA",
        "LOCALAPPDATA",
        "PNPM_HOME",
        "XDG_CONFIG_HOME",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for (key, value) in cognia_net::proxy_config::child_network_env() {
        command.env(key, value);
    }
    // A pnpm executable/shim may itself spawn `node`. Desktop selection must
    // remain authoritative even when the GUI's inherited PATH has no Node.
    if let Some(Ok(node)) = cognia_core::node_runtime::configured_node_executable() {
        command.env("PATH", selected_node_path(&node, std::env::var_os("PATH"))?);
    }
    command.env("CI", "true");
    // Prevent Corepack/pnpm from downloading another package manager. A
    // missing/mismatched host manager is a capability error, never an install.
    command
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("COREPACK_ENABLE_AUTO_PIN", "0")
        .env("npm_config_manage_package_manager_versions", "false");
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| RuntimeError::new("SPAWN_FAILED", e.to_string()))?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(input.as_bytes()).await?;
        }
    }
    let pid = child.id();
    let mut stdout = tokio::spawn(cognia_exec_sandbox::output::read_capped(
        child
            .stdout
            .take()
            .ok_or_else(|| invalid("missing stdout"))?,
    ));
    let mut stderr = tokio::spawn(cognia_exec_sandbox::output::read_capped(
        child
            .stderr
            .take()
            .ok_or_else(|| invalid("missing stderr"))?,
    ));
    let started = tokio::time::Instant::now();
    let result = loop {
        if *cancel.borrow() {
            break Err(RuntimeError::new(
                "CANCELLED",
                "runtime operation cancelled",
            ));
        }
        if state.active_account_id().ok().as_deref() != Some(account)
            || authorize(state, plugin, operation).is_err()
            || !state.shell_command_allowed(
                plugin,
                if operation == "prepare" {
                    "pnpm"
                } else {
                    "node"
                },
            )
            || !state.plugins.read().get(plugin).is_some_and(|p| {
                !matches!(
                    p.snapshot.status.as_str(),
                    "disabled" | "unloaded" | "suspended"
                )
            })
        {
            break Err(RuntimeError::new(
                "CANCELLED",
                "runtime owner or permission changed",
            ));
        }
        tokio::select! {
            status = child.wait() => break status.map_err(RuntimeError::from),
            _ = cancel.changed() => {},
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
        }
        if started.elapsed() >= timeout {
            break Err(RuntimeError::new(
                "TIMEOUT",
                "runtime operation exceeded its time limit",
            ));
        }
    };
    if result.is_err() {
        terminate_tree(&mut child, pid).await;
    }
    let captured = tokio::time::timeout(Duration::from_secs(3), async {
        let out = (&mut stdout).await.map_err(|e| invalid(e.to_string()))?;
        let err = (&mut stderr).await.map_err(|e| invalid(e.to_string()))?;
        Ok::<_, RuntimeError>((out, err))
    })
    .await;
    let captured = match captured {
        Ok(value) => value?,
        Err(_) => {
            terminate_tree(&mut child, pid).await;
            stdout.abort();
            stderr.abort();
            return Err(RuntimeError::new(
                "OUTPUT_TIMEOUT",
                "runtime output stream did not close",
            ));
        }
    };
    let exit = result?;
    if !exit.success() && operation != "probe" {
        return Err(RuntimeError::new(
            "PROCESS_FAILED",
            format!(
                "runtime process exited {:?}: {} {}",
                exit.code(),
                captured.0 .0.chars().take(4096).collect::<String>(),
                captured.1 .0.chars().take(4096).collect::<String>()
            ),
        ));
    }
    if operation == "probe" && captured.0 .1 {
        return Err(RuntimeError::new(
            "OUTPUT_LIMIT",
            "runtime stdout exceeded the output limit",
        ));
    }
    Ok(captured.0 .0)
}

async fn terminate_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        #[cfg(unix)]
        let mut killer = {
            let mut command = Command::new("/bin/kill");
            command.args(["-KILL", "--", &format!("-{pid}")]);
            command
        };
        #[cfg(windows)]
        let mut killer = {
            let mut command = Command::new("taskkill");
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x0800_0000);
            command
        };
        #[cfg(any(unix, windows))]
        if let Ok(mut process) = killer
            .kill_on_drop(true)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            let _ = tokio::time::timeout(Duration::from_secs(1), process.wait()).await;
        }
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PluginRuntimeState) {
        let dir = tempfile::tempdir().unwrap();
        let state = PluginRuntimeState::new(dir.path().join("plugins"));
        state.activate_account("test").unwrap();
        let root = state.plugin_dir("demo");
        std::fs::create_dir_all(root.join("runtime")).unwrap();
        std::fs::write(
            root.join("plugin.json"),
            r#"{"nodeRuntime":{"directory":"runtime","entry":"probe.mjs"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("runtime/package.json"),
            r#"{"packageManager":"pnpm@11.18.0"}"#,
        )
        .unwrap();
        for name in ["pnpm-lock.yaml", "pnpm-workspace.yaml", "probe.mjs"] {
            std::fs::write(root.join("runtime").join(name), "fixture").unwrap();
        }
        (dir, state)
    }

    fn grant_runtime(state: &PluginRuntimeState) {
        state.permissions.write().insert(
            "demo".into(),
            [
                "filesystem:read",
                "filesystem:write",
                "shell:execute",
                "network:fetch",
            ]
            .into_iter()
            .map(|permission| crate::PermissionGrant {
                plugin_id: "demo".into(),
                permission: permission.into(),
                granted_by: "test".into(),
                granted_at: chrono::Utc::now().to_rfc3339(),
                expires_at: None,
            })
            .collect(),
        );
        state.set_shell_allowlist("demo", vec!["pnpm".into(), "node".into()]);
        state.plugins.write().insert(
            "demo".into(),
            crate::PluginRecord {
                snapshot: crate::PluginRuntimeSnapshot {
                    plugin_id: "demo".into(),
                    version: "1".into(),
                    status: "enabled".into(),
                    last_error: None,
                    loaded_at: None,
                    install_path: state.plugin_dir("demo").to_string_lossy().into_owned(),
                },
                runtime_state: Value::Null,
            },
        );
    }

    #[test]
    fn failures_and_interrupted_preparations_survive_status_polling() {
        let (_dir, state) = fixture();
        let bundle = snapshot(&state, "demo").unwrap();
        let root = cache_root(&state, "demo").unwrap();
        let mut value = status(&root, &bundle);
        value.state = "failed".into();
        value.error = Some(RuntimeError::new("CANCELLED", "cancelled"));
        persist_status(&root, &value).unwrap();
        assert_eq!(status(&root, &bundle).error.unwrap().code, "CANCELLED");
        value.state = "preparing".into();
        persist_status(&root, &value).unwrap();
        assert_eq!(status(&root, &bundle).error.unwrap().code, "INTERRUPTED");
        let mut changed = bundle.clone();
        changed.fingerprint = "different".into();
        assert_eq!(status(&root, &changed).state, "missing");
    }

    #[tokio::test]
    async fn preparation_requires_network_and_execution_grants() {
        let (_dir, state) = fixture();
        grant_runtime(&state);
        for permission in ["network:fetch", "filesystem:write", "shell:execute"] {
            grant_runtime(&state);
            state
                .permissions
                .write()
                .get_mut("demo")
                .unwrap()
                .retain(|g| g.permission != permission);
            assert_eq!(
                handle(&state, "demo", "prepare", &json!({}))
                    .await
                    .unwrap_err()
                    .code,
                "PERMISSION_DENIED"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_cancel_and_disable_stop_real_child_processes() {
        let (_dir, state) = fixture();
        grant_runtime(&state);
        let root = cache_root(&state, "demo").unwrap();
        let stage = tempfile::tempdir_in(&root).unwrap();
        let (sender, receiver) = watch::channel(false);
        let started = std::time::Instant::now();
        let result = run_process(
            &state,
            "demo",
            "probe",
            Path::new("/bin/sh"),
            &["-c".into(), "sleep 30".into()],
            stage.path(),
            None,
            Duration::from_millis(50),
            receiver,
        )
        .await;
        assert_eq!(result.unwrap_err().code, "TIMEOUT");
        assert!(started.elapsed() < Duration::from_secs(5));
        let receiver = sender.subscribe();
        sender.send(true).unwrap();
        assert_eq!(
            run_process(
                &state,
                "demo",
                "probe",
                Path::new("/bin/sh"),
                &["-c".into(), "exit 99".into()],
                stage.path(),
                None,
                PROBE_TIMEOUT,
                receiver
            )
            .await
            .unwrap_err()
            .code,
            "CANCELLED"
        );
        let (_sender, receiver) = watch::channel(false);
        let arguments = ["-c".into(), "sleep 30".into()];
        let running = run_process(
            &state,
            "demo",
            "probe",
            Path::new("/bin/sh"),
            &arguments,
            stage.path(),
            None,
            PROBE_TIMEOUT,
            receiver,
        );
        let disable = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            state
                .plugins
                .write()
                .get_mut("demo")
                .unwrap()
                .snapshot
                .status = "disabled".into();
        };
        let (result, ()) = tokio::join!(running, disable);
        assert_eq!(result.unwrap_err().code, "CANCELLED");
    }

    #[test]
    fn selected_node_directory_precedes_inherited_package_manager_shims() {
        let node = Path::new("/verified/node/bin/node");
        let path = selected_node_path(
            node,
            Some(std::env::join_paths([Path::new("/old/bin"), Path::new("/usr/bin")]).unwrap()),
        )
        .unwrap();
        let paths: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(paths[0], PathBuf::from("/verified/node/bin"));
        assert_eq!(paths[1], PathBuf::from("/old/bin"));
    }

    #[tokio::test]
    async fn preserves_structured_nonzero_probe_errors_and_persists_them() {
        let (_dir, state) = fixture();
        grant_runtime(&state);
        std::fs::write(state.plugin_dir("demo").join("runtime/probe.mjs"),
            "process.stdout.write(JSON.stringify({ok:false,error:{code:'unsupported-runtime',message:'Fixture runtime unavailable'}}));process.exitCode=1;").unwrap();
        let bundle = snapshot(&state, "demo").unwrap();
        let root = cache_root(&state, "demo").unwrap();
        let cache = root.join(&bundle.fingerprint);
        std::fs::create_dir_all(cache.join("node_modules")).unwrap();
        for (name, bytes) in &bundle.files {
            contained_path::write_plugin_file(&cache, name, bytes).unwrap();
        }
        contained_path::write_plugin_file(
            &cache,
            RECEIPT,
            &serde_json::to_vec(&json!({"fingerprint":bundle.fingerprint})).unwrap(),
        )
        .unwrap();
        let result = handle(&state, "demo", "probe", &json!({})).await.unwrap();
        assert_eq!(result["error"]["code"], "unsupported-runtime");
        assert_eq!(result["prepared"], true);
        let polled = handle(&state, "demo", "status", &json!({})).await.unwrap();
        assert_eq!(polled["error"]["message"], "Fixture runtime unavailable");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stages_atomically_preserves_policy_and_rejects_install_failure() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, state) = fixture();
        grant_runtime(&state);
        let bundle = snapshot(&state, "demo").unwrap();
        let root = cache_root(&state, "demo").unwrap();
        let pnpm = dir.path().join("pnpm-fixture");
        std::fs::write(
            &pnpm,
            r#"#!/bin/sh
if [ "$1" = --version ]; then
  echo 11.18.0
else
  [ "$*" = 'install --frozen-lockfile --reporter=append-only --fetch-timeout=900000 --fetch-retries=0 --store-dir .pnpm-store' ] || exit 2
  mkdir node_modules
  echo fixture-install-complete
fi
"#,
        )
        .unwrap();
        std::fs::set_permissions(&pnpm, std::fs::Permissions::from_mode(0o700)).unwrap();
        let (_sender, receiver) = watch::channel(false);
        prepare(
            &state,
            "demo",
            &root,
            &bundle,
            Path::new("/bin/false"),
            &pnpm,
            receiver,
        )
        .await
        .unwrap();
        assert!(validate_cache(&root.join(&bundle.fingerprint), &bundle).is_ok());
        assert_eq!(
            std::fs::read_to_string(root.join("last-install.log")).unwrap(),
            "fixture-install-complete\n"
        );
        let removed = handle(&state, "demo", "remove", &json!({})).await.unwrap();
        assert_eq!(removed["state"], "missing");
        std::fs::write(&pnpm,"#!/bin/sh\nif [ \"$1\" = --version ]; then echo 11.18.0; else echo denied-policy >&2; exit 1; fi\n").unwrap();
        let (_sender, receiver) = watch::channel(false);
        assert_eq!(
            prepare(
                &state,
                "demo",
                &root,
                &bundle,
                Path::new("/bin/false"),
                &pnpm,
                receiver
            )
            .await
            .unwrap_err()
            .code,
            "PROCESS_FAILED"
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    }

    /// Explicit network smoke: resolves only the checked-in official lockfile.
    /// This loads module metadata; it never creates a converter or opens Office files.
    #[tokio::test]
    #[ignore = "downloads the optional plugin runtime; run explicitly"]
    async fn real_office_runtime_lifecycle() {
        let (dir, state) = fixture();
        grant_runtime(&state);
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/cognia-office/runtime");
        for name in [
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "probe.mjs",
        ] {
            std::fs::copy(
                source.join(name),
                state.plugin_dir("demo").join("runtime").join(name),
            )
            .unwrap();
        }
        cognia_net::proxy_config::apply_from_environment().unwrap();
        assert_eq!(
            handle(&state, "demo", "status", &json!({})).await.unwrap()["state"],
            "missing"
        );
        let begin = handle(&state, "demo", "prepare", &json!({})).await.unwrap();
        assert_eq!(begin["state"], "preparing");
        let started = tokio::time::Instant::now();
        loop {
            let status = handle(&state, "demo", "status", &json!({})).await.unwrap();
            if status["state"] != "preparing" {
                assert_eq!(status["state"], "prepared", "{status}");
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(960));
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let probed = handle(&state, "demo", "probe", &json!({})).await.unwrap();
        if probed.get("error").is_some() {
            let path = dir.keep();
            panic!(
                "{probed}; diagnostic fixture retained at {}",
                path.display()
            );
        }
        assert_eq!(probed["probe"]["apiVersion"], "0.1.5");
        assert_eq!(probed["probe"]["documentsSupported"], false);
        assert_eq!(
            handle(&state, "demo", "status", &json!({})).await.unwrap()["probe"]["apiVersion"],
            "0.1.5"
        );
        assert_eq!(
            handle(&state, "demo", "remove", &json!({})).await.unwrap()["state"],
            "missing"
        );
        eprintln!(
            "real runtime prepare/status/probe/remove passed; API 0.1.5; no documents executed"
        );
    }

    #[test]
    fn hashes_every_source_and_policy_file() {
        let (_dir, state) = fixture();
        let first = snapshot(&state, "demo").unwrap();
        std::fs::write(
            state.plugin_dir("demo").join("runtime/pnpm-workspace.yaml"),
            "changed-policy",
        )
        .unwrap();
        assert_ne!(
            first.fingerprint,
            snapshot(&state, "demo").unwrap().fingerprint
        );
    }

    #[test]
    fn rejects_missing_policy_and_escaping_entry() {
        let (_dir, state) = fixture();
        std::fs::write(
            state.plugin_dir("demo").join("plugin.json"),
            r#"{"nodeRuntime":{"directory":"runtime","entry":"../probe.mjs"}}"#,
        )
        .unwrap();
        assert!(snapshot(&state, "demo").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_bundle_and_cache_symlinks() {
        let (_dir, state) = fixture();
        std::os::unix::fs::symlink(
            "/etc/passwd",
            state.plugin_dir("demo").join("runtime/escape"),
        )
        .unwrap();
        assert!(snapshot(&state, "demo").is_err());
        std::fs::create_dir_all(&state.plugin_state_dir).unwrap();
        std::os::unix::fs::symlink("/tmp", state.plugin_state_dir.join("demo")).unwrap();
        assert!(cache_root(&state, "demo").is_err());
    }

    #[test]
    fn cache_requires_receipt_and_unchanged_sources() {
        let (_dir, state) = fixture();
        let bundle = snapshot(&state, "demo").unwrap();
        let root = cache_root(&state, "demo").unwrap();
        let cache = root.join(&bundle.fingerprint);
        std::fs::create_dir_all(cache.join("node_modules")).unwrap();
        for (name, bytes) in &bundle.files {
            contained_path::write_plugin_file(&cache, name, bytes).unwrap();
        }
        assert!(validate_cache(&cache, &bundle).is_err());
        contained_path::write_plugin_file(
            &cache,
            RECEIPT,
            &serde_json::to_vec(&json!({"fingerprint":bundle.fingerprint})).unwrap(),
        )
        .unwrap();
        assert!(validate_cache(&cache, &bundle).is_ok());
        std::fs::write(cache.join("probe.mjs"), "changed").unwrap();
        assert!(validate_cache(&cache, &bundle).is_err());
    }

    #[tokio::test]
    async fn permission_denied_precedes_any_dependency_install() {
        let (_dir, state) = fixture();
        let error = handle(&state, "demo", "prepare", &json!({}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "PERMISSION_DENIED");
        assert!(!state.plugin_host_state_dir("demo").exists());
        assert!(handle(&state, "demo", "status", &json!({"command":"npm"}))
            .await
            .is_err());
    }

    #[test]
    fn caches_are_account_and_plugin_scoped() {
        let (_dir, state) = fixture();
        let one = cache_root(&state, "demo").unwrap();
        state.activate_account("another").unwrap();
        assert_ne!(one, cache_root(&state, "demo").unwrap());
        assert_ne!(one, cache_root(&state, "other").unwrap());
    }
}
