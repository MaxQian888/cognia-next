//! Narrow Node authority for build-pinned, host-owned native bridge bundles.
//! The adjacent manifest is evidence, never the trust anchor: pins are compiled
//! into the host, and the complete dependency closure is checked at each spawn.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

const EMBEDDED_PINS: &str = include_str!("../../../sidecar/native-agents/pins.json");
const SPECS: [(&str, &str, &str); 4] = [
    ("codebuff", "codebuff.cjs", "--cognia-codebuff-bridge"),
    ("crush-http", "crush-http.cjs", "--cognia-crush-bridge"),
    ("hermes-probe", "hermes-probe.cjs", "--hermes-gateway-probe"),
    ("hermes-acp", "hermes-acp.cjs", "--cognia-hermes-acp"),
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pins {
    schema_version: u32,
    bridges: BTreeMap<String, BridgePin>,
    dependency_files: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Deserialize)]
struct BridgePin {
    file: String,
    args: Vec<String>,
    sha256: String,
}
#[derive(Clone, Debug, Serialize)]
pub struct NativeBridgeLaunch {
    pub command: String,
    pub args: Vec<String>,
    pub sha256: String,
}
#[derive(Clone)]
struct RegisteredBridge {
    root: PathBuf,
    node: PathBuf,
    launch: NativeBridgeLaunch,
}
static REGISTRY: OnceLock<Mutex<HashMap<String, RegisteredBridge>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, RegisteredBridge>> {
    REGISTRY.get_or_init(Default::default)
}

fn digest(file: &Path) -> Result<String, String> {
    let bytes = std::fs::read(file).map_err(|error| format!("{}: {error}", file.display()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}
fn inventory(root: &Path, current: &Path, files: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(current).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file = entry.path();
        let stat = std::fs::symlink_metadata(&file).map_err(|error| error.to_string())?;
        if stat.file_type().is_symlink() {
            return Err(format!("native bridge symlink refused: {}", file.display()));
        }
        if stat.is_dir() {
            inventory(root, &file, files)?;
        } else if stat.is_file() {
            files.push(
                file.strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        } else {
            return Err(format!(
                "native bridge non-file refused: {}",
                file.display()
            ));
        }
    }
    Ok(())
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn verify(root: &Path, embedded: &serde_json::Value) -> Result<Pins, String> {
    let stat = std::fs::symlink_metadata(root)
        .map_err(|error| format!("native bridge assets unavailable: {error}"))?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Err("native bridge directory missing or redirected".into());
    }
    let pins: Pins = serde_json::from_value(embedded.clone()).map_err(|error| error.to_string())?;
    if pins.schema_version != 1 || pins.bridges.len() != SPECS.len() {
        return Err("native bridge embedded pins invalid".into());
    }
    let mut expected = pins.dependency_files.clone();
    for (id, file, flag) in SPECS {
        let pin = pins.bridges.get(id).ok_or("native bridge pin missing")?;
        if pin.file != file || pin.args != [flag] {
            return Err(format!("native bridge fixed invocation invalid: {id}"));
        }
        expected.insert(pin.file.clone(), pin.sha256.clone());
    }
    for (file, sha) in &expected {
        if !valid_digest(sha)
            || file.contains('\\')
            || file
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || Path::new(file)
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(format!("native bridge pin path or digest invalid: {file}"));
        }
    }
    let mut actual = Vec::new();
    inventory(root, root, &mut actual)?;
    actual.sort();
    let mut names: Vec<_> = expected
        .keys()
        .cloned()
        .chain(["integrity.json".into(), "pins.json".into()])
        .collect();
    names.sort();
    if actual != names {
        return Err("native bridge file inventory mismatch".into());
    }
    for metadata in ["integrity.json", "pins.json"] {
        let adjacent: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join(metadata)).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        if adjacent != *embedded {
            return Err(format!(
                "native bridge metadata differs from embedded pins: {metadata}"
            ));
        }
    }
    for (file, sha) in expected {
        if digest(&root.join(&file))? != sha {
            return Err(format!("native bridge integrity mismatch: {file}"));
        }
    }
    Ok(pins)
}
fn prepare(
    root: &Path,
    node: &Path,
    id: &str,
    embedded: &serde_json::Value,
) -> Result<RegisteredBridge, String> {
    if !SPECS.iter().any(|(known, _, _)| *known == id) {
        return Err(format!("unsupported bundled native bridge: {id}"));
    }
    let pins = verify(root, embedded)?;
    let node = node
        .canonicalize()
        .map_err(|error| format!("host Node unavailable: {error}"))?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let pin = &pins.bridges[id];
    let mut args = vec![root.join(&pin.file).to_string_lossy().into_owned()];
    args.extend(pin.args.clone());
    let launch = NativeBridgeLaunch {
        command: node.to_string_lossy().into_owned(),
        args,
        sha256: pin.sha256.clone(),
    };
    Ok(RegisteredBridge { root, node, launch })
}

/// The shell supplies its actual resource directory and immutable Node runtime.
/// Neither path is accepted from an IPC caller.
pub fn resolve_in_sidecar_dir(
    sidecar: &Path,
    node: &Path,
    id: &str,
) -> Result<NativeBridgeLaunch, String> {
    if id == "codebuff" && !crate::sandbox::sandbox_supports_os(std::env::consts::OS) {
        return Err("Codebuff requires Cognia's mandatory macOS/Linux network-off sandbox".into());
    }
    registry().lock().remove(id);
    let embedded = serde_json::from_str(EMBEDDED_PINS)
        .map_err(|error| format!("native bridge embedded pins invalid: {error}"))?;
    let registered = prepare(&sidecar.join("native-agents"), node, id, &embedded)
        .map_err(|error| format!("Bundled {id} bridge unavailable; rebuild/reinstall Cognia's native agent assets: {error}"))?;
    let launch = registered.launch.clone();
    registry().lock().insert(id.to_owned(), registered);
    Ok(launch)
}

/// Clone authority out of the lock before file IO; no lock crosses an await.
pub fn permits_registered_invocation(command: &str, args: &[String]) -> Result<bool, String> {
    let entries: Vec<_> = registry()
        .lock()
        .iter()
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect();
    for (id, entry) in entries {
        if entry.launch.args != args {
            continue;
        }
        if !Path::new(command).is_absolute()
            || Path::new(command).canonicalize().ok().as_ref() != Some(&entry.node)
        {
            return Ok(false);
        }
        let embedded = serde_json::from_str(EMBEDDED_PINS).map_err(|error| error.to_string())?;
        if let Err(error) = verify(&entry.root, &embedded) {
            registry().lock().remove(&id);
            return Err(error);
        }
        return Ok(true);
    }
    Ok(false)
}

fn registered_codebuff(command: &str, args: &[String]) -> bool {
    registered_matches("codebuff", command, args)
}

fn registered_matches(id: &str, command: &str, args: &[String]) -> bool {
    let entry = registry().lock().get(id).cloned();
    entry.is_some_and(|entry| {
        entry.launch.args == args
            && Path::new(command).canonicalize().ok().as_ref() == Some(&entry.node)
    })
}

pub fn registered_host_node(id: &str) -> Result<Option<PathBuf>, String> {
    let entry = registry().lock().get(id).cloned();
    let Some(entry) = entry else {
        return Ok(None);
    };
    if !permits_registered_invocation(&entry.launch.command, &entry.launch.args)? {
        return Ok(None);
    }
    Ok(Some(entry.node))
}

pub fn registered_native_bridge_root(
    command: &str,
    args: &[String],
) -> Result<Option<PathBuf>, String> {
    if !permits_registered_invocation(command, args)? {
        return Ok(None);
    }
    Ok(registry()
        .lock()
        .values()
        .find(|entry| entry.launch.args == args)
        .map(|entry| entry.root.clone()))
}

fn owned_hermes_state_root(key: Option<&str>, data_dir: Option<&Path>) -> Result<PathBuf, String> {
    let key = key
        .filter(|key| crate::state_isolation::state_key_valid(key))
        .ok_or("Hermes probe requires an owned Hermes state key")?;
    let data_dir = data_dir
        .filter(|dir| dir.is_absolute())
        .ok_or("Hermes probe requires a host data directory")?;
    let mut current = data_dir.canonicalize().map_err(|error| error.to_string())?;
    for segment in ["cognia", "external-agents", key] {
        current.push(segment);
        let stat = std::fs::symlink_metadata(&current)
            .map_err(|error| format!("Hermes probe state unavailable: {error}"))?;
        if !stat.is_dir() || stat.file_type().is_symlink() {
            return Err("Hermes probe state directory missing or redirected".into());
        }
    }
    let stat =
        std::fs::symlink_metadata(current.join("hermes")).map_err(|error| error.to_string())?;
    if !stat.is_dir() || stat.file_type().is_symlink() {
        return Err("Hermes probe home missing or redirected".into());
    }
    Ok(current)
}

pub fn hermes_probe_state_root(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    data_dir: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let helper = registered_matches("hermes-probe", command, args)
        || registered_matches("hermes-acp", command, args);
    if !helper || !permits_registered_invocation(command, args)? {
        return Ok(None);
    }
    owned_hermes_state_root(
        env.get(crate::state_isolation::AGENT_STATE_KEY_ENV)
            .map(String::as_str),
        data_dir,
    )
    .map(Some)
}

pub fn validate_network_requirement(
    config: &crate::process::ExternalAgentSpawnConfig,
) -> Result<(), String> {
    if registered_codebuff(&config.command, &config.args) {
        require_network_off(config.sandbox_policy.network, std::env::consts::OS)?;
    }
    Ok(())
}
fn require_network_off(
    network: crate::process::SandboxNetworkMode,
    os: &str,
) -> Result<(), String> {
    if !crate::sandbox::sandbox_supports_os(os)
        || network != crate::process::SandboxNetworkMode::Off
    {
        return Err("Codebuff requires Cognia's mandatory macOS/Linux sandbox with sandboxPolicy.network:'off'".into());
    }
    Ok(())
}

/// LocalProcessBackend can be reached without the desktop wrapper. Apply the
/// same mandatory wrapper there rather than interpreting an off policy as proof.
pub fn harden_process_launch(
    config: crate::process::ExternalAgentSpawnConfig,
) -> Result<crate::process::ExternalAgentSpawnConfig, String> {
    let helper = registered_matches("hermes-probe", &config.command, &config.args)
        || registered_matches("hermes-acp", &config.command, &config.args);
    if !registered_codebuff(&config.command, &config.args) && !helper {
        return Ok(config);
    }
    validate_network_requirement(&config)?;
    crate::sandbox::wrap_with_sandbox(config, &crate::sandbox::DesktopSandboxHost)
        .map_err(|error| error.to_string())
}

fn verify_final_entry(
    entry: &RegisteredBridge,
    id: &str,
    command: &str,
    args: &[String],
    embedded: &serde_json::Value,
    launcher: Option<&Path>,
) -> Result<bool, String> {
    let direct = args == entry.launch.args;
    let target = args
        .iter()
        .position(|arg| arg == "--")
        .map(|at| &args[at + 1..]);
    let mut expected_target = vec![entry.launch.command.clone()];
    expected_target.extend(entry.launch.args.clone());
    let wrapped = target.is_some_and(|target| target == expected_target);
    if !direct && !wrapped {
        return Ok(false);
    }
    if direct
        && (id == "codebuff"
            || Path::new(command).canonicalize().ok().as_ref() != Some(&entry.node))
    {
        return Err("registered Codebuff bridge requires the mandatory sandbox launcher".into());
    }
    if wrapped && id == "codebuff" {
        let expected_launcher = launcher.and_then(|path| path.canonicalize().ok());
        if expected_launcher.is_none()
            || Path::new(command).canonicalize().ok() != expected_launcher
            || args
                .iter()
                .take_while(|arg| *arg != "--")
                .any(|arg| arg == "--network" || arg == "--network-allow")
        {
            return Err("Codebuff sandbox launcher or network-off boundary changed".into());
        }
    }
    verify(&entry.root, embedded)?;
    Ok(true)
}

/// Recheck the fixed target even after the trusted sandbox wrapper rewrote the
/// executable/argv. Called immediately before the actual process spawn.
pub fn validate_final_process_launch(command: &str, args: &[String]) -> Result<(), String> {
    let entries: Vec<_> = registry()
        .lock()
        .iter()
        .map(|(id, entry)| (id.clone(), entry.clone()))
        .collect();
    if entries.is_empty() {
        return Ok(());
    }
    let embedded = serde_json::from_str(EMBEDDED_PINS).map_err(|error| error.to_string())?;
    let launcher = crate::sandbox::find_sandbox_launcher(&crate::sandbox::DesktopSandboxHost);
    for (id, entry) in entries {
        if let Err(error) =
            verify_final_entry(&entry, &id, command, args, &embedded, launcher.as_deref())
        {
            registry().lock().remove(&id);
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let mut bridges = serde_json::Map::new();
        for (id, file, flag) in SPECS {
            std::fs::write(dir.path().join(file), format!("// {id}")).unwrap();
            bridges.insert(id.into(), serde_json::json!({"file":file,"args":[flag],"sha256":digest(&dir.path().join(file)).unwrap()}));
        }
        std::fs::create_dir_all(dir.path().join("node_modules/sdk")).unwrap();
        std::fs::write(dir.path().join("node_modules/sdk/asset.wasm"), b"asset").unwrap();
        let value = serde_json::json!({"schemaVersion":1,"bridges":bridges,"dependencyFiles":{"node_modules/sdk/asset.wasm":digest(&dir.path().join("node_modules/sdk/asset.wasm")).unwrap()}});
        for file in ["integrity.json", "pins.json"] {
            std::fs::write(dir.path().join(file), value.to_string()).unwrap();
        }
        (dir, value)
    }
    #[test]
    fn fixed_entry_and_dependency_closure_are_verified() {
        let (dir, pins) = fixture();
        let node = std::env::current_exe().unwrap();
        let result = prepare(dir.path(), &node, "hermes-probe", &pins).unwrap();
        assert_eq!(
            result.launch.args,
            [
                dir.path()
                    .canonicalize()
                    .unwrap()
                    .join("hermes-probe.cjs")
                    .to_string_lossy(),
                "--hermes-gateway-probe".into()
            ]
        );
        assert!(prepare(dir.path(), &node, "unknown", &pins).is_err());
        std::fs::write(dir.path().join("node_modules/sdk/asset.wasm"), b"tampered").unwrap();
        assert!(
            verify(dir.path(), &pins)
                .unwrap_err()
                .contains("integrity mismatch")
        );
    }
    #[test]
    fn adjacent_manifest_cannot_repin_a_tampered_bundle() {
        let (dir, pins) = fixture();
        std::fs::write(dir.path().join("codebuff.cjs"), b"tampered").unwrap();
        let mut changed = pins.clone();
        changed["bridges"]["codebuff"]["sha256"] =
            digest(&dir.path().join("codebuff.cjs")).unwrap().into();
        std::fs::write(dir.path().join("integrity.json"), changed.to_string()).unwrap();
        assert!(
            verify(dir.path(), &pins)
                .unwrap_err()
                .contains("embedded pins")
        );
    }
    #[test]
    fn missing_extra_and_escaping_assets_are_refused() {
        let (dir, pins) = fixture();
        std::fs::write(dir.path().join("extra.js"), b"extra").unwrap();
        assert!(verify(dir.path(), &pins).unwrap_err().contains("inventory"));
        std::fs::remove_file(dir.path().join("extra.js")).unwrap();
        std::fs::remove_file(dir.path().join("crush-http.cjs")).unwrap();
        assert!(verify(dir.path(), &pins).unwrap_err().contains("inventory"));
        let mut changed = pins;
        changed["dependencyFiles"]["../escape.js"] = "a".repeat(64).into();
        assert!(
            verify(dir.path(), &changed)
                .unwrap_err()
                .contains("pin path")
        );
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_files_and_directories_are_refused() {
        let (dir, pins) = fixture();
        let elsewhere = tempfile::NamedTempFile::new().unwrap();
        std::fs::remove_file(dir.path().join("codebuff.cjs")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("codebuff.cjs")).unwrap();
        assert!(verify(dir.path(), &pins).unwrap_err().contains("symlink"));
        let link = dir.path().join("redirect");
        std::os::unix::fs::symlink(dir.path(), &link).unwrap();
        assert!(verify(&link, &pins).unwrap_err().contains("redirected"));
    }

    #[test]
    fn final_spawn_rechecks_closure_and_codebuff_requires_exact_network_off_wrapper() {
        let (dir, pins) = fixture();
        let node = std::env::current_exe().unwrap();
        let entry = prepare(dir.path(), &node, "codebuff", &pins).unwrap();
        assert!(
            verify_final_entry(
                &entry,
                "codebuff",
                &entry.launch.command,
                &entry.launch.args,
                &pins,
                Some(&node)
            )
            .unwrap_err()
            .contains("mandatory")
        );
        let mut args = vec![
            "--cwd".to_owned(),
            dir.path().to_string_lossy().into_owned(),
            "--".into(),
            entry.launch.command.clone(),
        ];
        args.extend(entry.launch.args.clone());
        assert!(
            verify_final_entry(
                &entry,
                "codebuff",
                &entry.launch.command,
                &args,
                &pins,
                Some(&node)
            )
            .unwrap()
        );
        let mut widened = args.clone();
        widened.insert(0, "--network".into());
        assert!(
            verify_final_entry(
                &entry,
                "codebuff",
                &entry.launch.command,
                &widened,
                &pins,
                Some(&node)
            )
            .unwrap_err()
            .contains("network-off")
        );
        assert!(
            verify_final_entry(
                &entry,
                "codebuff",
                &entry.launch.command,
                &args,
                &pins,
                None
            )
            .is_err()
        );
        std::fs::write(
            dir.path().join("codebuff.cjs"),
            b"changed after launch preparation",
        )
        .unwrap();
        assert!(
            verify_final_entry(
                &entry,
                "codebuff",
                &entry.launch.command,
                &args,
                &pins,
                Some(&node)
            )
            .unwrap_err()
            .contains("integrity mismatch")
        );
    }

    #[test]
    fn codebuff_network_requirement_rejects_unsupported_or_widened_policy() {
        use crate::process::SandboxNetworkMode;
        for os in ["macos", "linux"] {
            assert!(require_network_off(SandboxNetworkMode::Off, os).is_ok());
            for network in [SandboxNetworkMode::Full, SandboxNetworkMode::Allowlist] {
                assert!(require_network_off(network, os).is_err());
            }
        }
        assert!(require_network_off(SandboxNetworkMode::Off, "windows").is_err());
    }

    #[test]
    fn hermes_probe_state_key_derives_exact_host_owned_read_root() {
        let dir = tempfile::tempdir().unwrap();
        let key = "saved-hermes-config".to_string();
        let owned = dir.path().join("cognia/external-agents").join(&key);
        std::fs::create_dir_all(owned.join("hermes")).unwrap();
        assert_eq!(
            owned_hermes_state_root(Some(&key), Some(dir.path())).unwrap(),
            owned.canonicalize().unwrap()
        );
        for key in ["../escape", "config/child", " "] {
            assert!(owned_hermes_state_root(Some(key), Some(dir.path())).is_err());
        }
        assert!(owned_hermes_state_root(Some(&key), None).is_err());
        #[cfg(unix)]
        {
            std::fs::remove_dir(owned.join("hermes")).unwrap();
            std::os::unix::fs::symlink(dir.path(), owned.join("hermes")).unwrap();
            assert!(
                owned_hermes_state_root(Some(&key), Some(dir.path()))
                    .unwrap_err()
                    .contains("redirected")
            );
        }
    }
}
