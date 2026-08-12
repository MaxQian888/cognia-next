//! Deterministic, signed managed proxy VSIX generation.
//!
//! Inputs are normalized manifest IR plus validated static assets. The proxy's
//! executable is always the platform-owned bundle extracted from the pinned
//! broker VSIX; plugin-provided extension entrypoints are never accepted.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::File;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{DateTime, ZipArchive, ZipWriter};

use super::broker_protocol::{CODE_API_VERSION, DEFAULT_CATALOG_HASH};

const BROKER_EXTENSION_ID: &str = "cognia.cognia-managed-broker";
const MANAGED_PLATFORM_VERSION: &str = "1.0.0";
const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyAsset {
    pub source_path: String,
    pub package_path: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyBuildRequest {
    pub plugin_id: String,
    pub plugin_version: String,
    pub plugin_root: String,
    pub manifest_hash: String,
    pub catalog_hash: String,
    #[serde(default)]
    pub contributions: Value,
    #[serde(default)]
    pub providers: Vec<Value>,
    #[serde(default)]
    pub executables: Vec<Value>,
    #[serde(default)]
    pub protocols: Value,
    #[serde(default)]
    pub assets: Vec<ProxyAsset>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyArtifact {
    pub plugin_id: String,
    pub plugin_version: String,
    pub manifest_hash: String,
    pub catalog_hash: String,
    #[serde(default)]
    pub platform_version: String,
    pub sha256: String,
    pub signature: String,
    pub public_key: String,
    pub vsix_path: String,
    #[serde(default)]
    pub executables: Vec<ProxyExecutableArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyExecutableArtifact {
    pub id: String,
    pub sha256: String,
    pub path: String,
}

pub(super) fn activation_marker_selects(
    marker_contents: Option<&str>,
    artifact: &ProxyArtifact,
) -> bool {
    marker_contents.map(str::trim) == Some(artifact.sha256.as_str())
}

pub fn build_proxy(
    app: &tauri::AppHandle,
    request: ProxyBuildRequest,
) -> Result<ProxyArtifact, String> {
    let root = super::download::code_server_root(app)
        .map_err(|error| format!("resolve code-server root: {error:#}"))?;
    let broker_vsix = crate::claude::sidecar::sidecar_dir(app)
        .map_err(|error| format!("resolve broker VSIX: {error}"))?
        .join("codeserver-agent-ext")
        .join("cognia-agent-bridge.vsix");
    build_proxy_at_root(&root, &broker_vsix, request)
}

/// Headless equivalent of [`build_proxy`]. The cache, signing identity, and
/// platform proxy template all belong to the remote Cognia host.
pub fn build_proxy_at_root(
    root: &Path,
    broker_vsix: &Path,
    request: ProxyBuildRequest,
) -> Result<ProxyArtifact, String> {
    validate_request(&request)?;
    let executable_artifacts = stage_executable_resources(&root, &request)?;
    let proxy_bundle = load_platform_proxy_bundle(broker_vsix)?;
    let assets = read_assets(&request)?;
    let package = package_json(&request);
    let bytes = build_vsix_bytes(&package, &proxy_bundle, &assets)?;
    let digest = Sha256::digest(&bytes);
    let sha256 = hex::encode(digest);
    let signing_key = load_or_create_signing_key(&root)?;
    let signature = signing_key.sign(&digest);
    let artifact_dir = root
        .join("artifacts")
        .join("proxies")
        .join(proxy_name(&request.plugin_id))
        .join(&request.plugin_version);
    std::fs::create_dir_all(&artifact_dir)
        .map_err(|error| format!("create {}: {error}", artifact_dir.display()))?;
    let vsix_path = artifact_dir.join(format!("{sha256}.vsix"));
    atomic_write(&vsix_path, &bytes)?;
    let artifact = ProxyArtifact {
        plugin_id: request.plugin_id,
        plugin_version: request.plugin_version,
        manifest_hash: request.manifest_hash,
        catalog_hash: request.catalog_hash,
        platform_version: MANAGED_PLATFORM_VERSION.to_string(),
        sha256,
        signature: hex::encode(signature.to_bytes()),
        public_key: hex::encode(signing_key.verifying_key().to_bytes()),
        vsix_path: vsix_path.to_string_lossy().into_owned(),
        executables: executable_artifacts,
    };
    let metadata = serde_json::to_vec_pretty(&artifact)
        .map_err(|error| format!("encode proxy metadata: {error}"))?;
    atomic_write(&vsix_path.with_extension("json"), &metadata)?;
    Ok(artifact)
}

pub fn verify_artifact(app: &tauri::AppHandle, artifact: &ProxyArtifact) -> Result<(), String> {
    let trusted_root = super::download::code_server_root(app)
        .map_err(|error| format!("resolve code-server root: {error:#}"))?;
    verify_artifact_at_root(&trusted_root, artifact)
}

/// Verify an artifact against a host-owned cache root. Headless remote hosts
/// have no `AppHandle`, but use the identical signing anchor and cache layout.
pub fn verify_artifact_at_root(
    trusted_root: &Path,
    artifact: &ProxyArtifact,
) -> Result<(), String> {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    if artifact.catalog_hash != DEFAULT_CATALOG_HASH {
        return Err("IDE_CATALOG_MISMATCH".to_string());
    }
    if artifact.platform_version != MANAGED_PLATFORM_VERSION {
        return Err("IDE_PLATFORM_VERSION_MISMATCH".to_string());
    }
    for executable in &artifact.executables {
        let path = Path::new(&executable.path)
            .canonicalize()
            .map_err(|_| "IDE_EXECUTABLE_ARTIFACT_MISSING".to_string())?;
        let executable_root = trusted_root
            .join("artifacts")
            .join("protocol-executables")
            .canonicalize()
            .map_err(|_| "IDE_EXECUTABLE_ARTIFACT_MISSING".to_string())?;
        if !path.starts_with(&executable_root) {
            return Err("IDE_EXECUTABLE_ARTIFACT_OUTSIDE_CACHE".to_string());
        }
        let bytes =
            std::fs::read(path).map_err(|_| "IDE_EXECUTABLE_ARTIFACT_MISSING".to_string())?;
        if format!("sha256:{}", hex::encode(Sha256::digest(&bytes))) != executable.sha256 {
            return Err("IDE_EXECUTABLE_ARTIFACT_HASH_MISMATCH".to_string());
        }
    }
    let bytes = std::fs::read(&artifact.vsix_path)
        .map_err(|error| format!("read proxy artifact: {error}"))?;
    let digest = Sha256::digest(&bytes);
    if hex::encode(digest) != artifact.sha256 {
        return Err("IDE_PROXY_CONTENT_HASH_MISMATCH".to_string());
    }
    let artifact_public_key: [u8; 32] = hex::decode(&artifact.public_key)
        .map_err(|_| "IDE_PROXY_PUBLIC_KEY_INVALID".to_string())?
        .try_into()
        .map_err(|_| "IDE_PROXY_PUBLIC_KEY_INVALID".to_string())?;
    let trusted_public_key = load_or_create_signing_key(trusted_root)
        .map_err(|error| format!("load managed signing trust anchor: {error}"))?
        .verifying_key()
        .to_bytes();
    if artifact_public_key != trusted_public_key {
        return Err("IDE_PROXY_UNTRUSTED_SIGNER".to_string());
    }
    let signature: [u8; 64] = hex::decode(&artifact.signature)
        .map_err(|_| "IDE_PROXY_SIGNATURE_INVALID".to_string())?
        .try_into()
        .map_err(|_| "IDE_PROXY_SIGNATURE_INVALID".to_string())?;
    VerifyingKey::from_bytes(&artifact_public_key)
        .map_err(|_| "IDE_PROXY_PUBLIC_KEY_INVALID".to_string())?
        .verify(&digest, &Signature::from_bytes(&signature))
        .map_err(|_| "IDE_PROXY_SIGNATURE_INVALID".to_string())?;

    let mut archive = ZipArchive::new(Cursor::new(&bytes))
        .map_err(|_| "IDE_PROXY_PACKAGE_INVALID".to_string())?;
    let mut package_bytes = Vec::new();
    archive
        .by_name("extension/package.json")
        .map_err(|_| "IDE_PROXY_PACKAGE_MANIFEST_MISSING".to_string())?
        .read_to_end(&mut package_bytes)
        .map_err(|_| "IDE_PROXY_PACKAGE_INVALID".to_string())?;
    let package: Value = serde_json::from_slice(&package_bytes)
        .map_err(|_| "IDE_PROXY_PACKAGE_INVALID".to_string())?;
    let managed = package
        .get("cogniaManaged")
        .and_then(Value::as_object)
        .ok_or_else(|| "IDE_PROXY_DESCRIPTOR_INVALID".to_string())?;
    for (field, expected) in [
        ("pluginId", artifact.plugin_id.as_str()),
        ("pluginVersion", artifact.plugin_version.as_str()),
        ("manifestHash", artifact.manifest_hash.as_str()),
        ("catalogHash", artifact.catalog_hash.as_str()),
        ("platformVersion", artifact.platform_version.as_str()),
    ] {
        if managed.get(field).and_then(Value::as_str) != Some(expected) {
            return Err(format!("IDE_PROXY_DESCRIPTOR_MISMATCH: {field}"));
        }
    }
    let expected_executables = managed
        .get("executables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|executable| {
            let source = executable.get("source")?;
            (source.get("kind").and_then(Value::as_str) == Some("plugin-resource")).then(|| {
                (
                    executable
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    source
                        .get("sha256")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
            })
        })
        .collect::<BTreeMap<_, _>>();
    let actual_executables = artifact
        .executables
        .iter()
        .map(|executable| (executable.id.as_str(), executable.sha256.as_str()))
        .collect::<BTreeMap<_, _>>();
    if expected_executables != actual_executables {
        return Err("IDE_EXECUTABLE_ARTIFACT_SET_MISMATCH".to_string());
    }
    Ok(())
}

pub fn list_artifacts(app: &tauri::AppHandle) -> Result<Vec<ProxyArtifact>, String> {
    let root = super::download::code_server_root(app)
        .map_err(|error| format!("resolve code-server root: {error:#}"))?;
    list_artifacts_at_root(&root)
}

/// Discover only artifacts which verify under a headless host's trust anchor.
pub fn list_artifacts_at_root(root: &Path) -> Result<Vec<ProxyArtifact>, String> {
    let root = root.join("artifacts").join("proxies");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut artifacts = Vec::new();
    walk_metadata_at_root(
        root.parent()
            .and_then(Path::parent)
            .ok_or_else(|| "invalid managed proxy artifact root".to_string())?,
        &root,
        &mut artifacts,
    )?;
    artifacts.sort_by(|left, right| {
        (&left.plugin_id, &left.plugin_version).cmp(&(&right.plugin_id, &right.plugin_version))
    });
    Ok(artifacts)
}

fn walk_metadata_at_root(
    trusted_root: &Path,
    path: &Path,
    output: &mut Vec<ProxyArtifact>,
) -> Result<(), String> {
    for entry in
        std::fs::read_dir(path).map_err(|error| format!("read {}: {error}", path.display()))?
    {
        let entry = entry.map_err(|error| format!("read {}: {error}", path.display()))?;
        let path = entry.path();
        if path.is_dir() {
            walk_metadata_at_root(trusted_root, &path, output)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("json") {
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    log::warn!(
                        "managed proxy metadata unreadable; skipping {}: {error}",
                        path.display()
                    );
                    continue;
                }
            };
            let artifact: ProxyArtifact = match serde_json::from_slice(&bytes) {
                Ok(artifact) => artifact,
                Err(error) => {
                    log::warn!(
                        "managed proxy metadata invalid; skipping {}: {error}",
                        path.display()
                    );
                    continue;
                }
            };
            if let Err(error) = verify_artifact_at_root(trusted_root, &artifact) {
                log::warn!(
                    "managed proxy artifact failed verification; skipping {}: {error}",
                    path.display()
                );
                continue;
            }
            output.push(artifact);
        }
    }
    Ok(())
}

fn validate_request(request: &ProxyBuildRequest) -> Result<(), String> {
    if !valid_id(&request.plugin_id) {
        return Err("IDE_PROXY_PLUGIN_ID_INVALID".to_string());
    }
    if !valid_version(&request.plugin_version) {
        return Err("IDE_PROXY_VERSION_INVALID".to_string());
    }
    if request.catalog_hash != DEFAULT_CATALOG_HASH {
        return Err("IDE_CATALOG_MISMATCH".to_string());
    }
    if !is_sha256(&request.manifest_hash) {
        return Err("IDE_MANIFEST_HASH_INVALID".to_string());
    }
    let prefix = format!("cognia.{}.", request.plugin_id);
    validate_contribution_ids(&request.contributions, &prefix)?;
    for provider in &request.providers {
        if !provider
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| id.starts_with(&prefix))
        {
            return Err("IDE_PROXY_ID_OUTSIDE_NAMESPACE".to_string());
        }
    }
    let mut executable_ids = HashSet::new();
    for executable in &request.executables {
        let id = executable
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or_else(|| "IDE_EXECUTABLE_ID_INVALID".to_string())?;
        if !executable_ids.insert(id) {
            return Err("IDE_EXECUTABLE_ID_CONFLICT".to_string());
        }
        let source = executable
            .get("source")
            .and_then(Value::as_object)
            .ok_or_else(|| "IDE_EXECUTABLE_SOURCE_INVALID".to_string())?;
        match source.get("kind").and_then(Value::as_str) {
            Some("plugin-resource") => {
                let path = source
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|path| safe_package_path(path))
                    .ok_or_else(|| "IDE_EXECUTABLE_RESOURCE_INVALID".to_string())?;
                let hash = source
                    .get("sha256")
                    .and_then(Value::as_str)
                    .filter(|hash| is_sha256(hash))
                    .ok_or_else(|| "IDE_EXECUTABLE_RESOURCE_INVALID".to_string())?;
                let _ = (path, hash);
            }
            Some("registered-tool") => {
                if !source
                    .get("tool")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    return Err("IDE_EXECUTABLE_SOURCE_INVALID".to_string());
                }
            }
            Some("user-selected") => {
                if !source
                    .get("setting")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                {
                    return Err("IDE_EXECUTABLE_SOURCE_INVALID".to_string());
                }
            }
            _ => return Err("IDE_EXECUTABLE_SOURCE_INVALID".to_string()),
        }
    }
    for (family, allowed) in [
        ("lsp", &["stdio", "socket"][..]),
        ("dap", &["stdio", "socket"][..]),
        ("mcp", &["stdio", "http", "sse"][..]),
    ] {
        for protocol in request
            .protocols
            .get(family)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let transport = protocol.get("transport").and_then(Value::as_str);
            if !protocol
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with(&prefix))
                || !protocol
                    .get("executable")
                    .and_then(Value::as_str)
                    .is_some_and(|id| executable_ids.contains(id))
                || !protocol
                    .get("transport")
                    .and_then(Value::as_str)
                    .is_some_and(|transport| allowed.contains(&transport))
            {
                return Err(format!("IDE_PROTOCOL_DESCRIPTOR_INVALID: {family}"));
            }
            if transport != Some("stdio") {
                let endpoint = protocol
                    .get("endpoint")
                    .and_then(Value::as_str)
                    .and_then(|endpoint| endpoint.parse::<url::Url>().ok())
                    .filter(|endpoint| {
                        matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
                    })
                    .ok_or_else(|| format!("IDE_PROTOCOL_ENDPOINT_INVALID: {family}"))?;
                let expected_scheme = if transport == Some("socket") {
                    "tcp"
                } else {
                    "http"
                };
                if endpoint.scheme() != expected_scheme
                    || endpoint.port().is_none()
                    || !endpoint.username().is_empty()
                    || endpoint.password().is_some()
                {
                    return Err(format!("IDE_PROTOCOL_ENDPOINT_INVALID: {family}"));
                }
            }
        }
    }
    Ok(())
}

fn stage_executable_resources(
    cache_root: &Path,
    request: &ProxyBuildRequest,
) -> Result<Vec<ProxyExecutableArtifact>, String> {
    let plugin_root = Path::new(&request.plugin_root)
        .canonicalize()
        .map_err(|error| format!("resolve plugin root: {error}"))?;
    let mut artifacts = Vec::new();
    for executable in &request.executables {
        let id = executable["id"]
            .as_str()
            .ok_or_else(|| "IDE_EXECUTABLE_ID_INVALID".to_string())?;
        let source = executable["source"]
            .as_object()
            .ok_or_else(|| "IDE_EXECUTABLE_SOURCE_INVALID".to_string())?;
        if source.get("kind").and_then(Value::as_str) != Some("plugin-resource") {
            continue;
        }
        let relative = source["path"]
            .as_str()
            .ok_or_else(|| "IDE_EXECUTABLE_RESOURCE_INVALID".to_string())?;
        let expected = source["sha256"]
            .as_str()
            .ok_or_else(|| "IDE_EXECUTABLE_RESOURCE_INVALID".to_string())?;
        let source_path = plugin_root
            .join(relative)
            .canonicalize()
            .map_err(|error| format!("resolve executable resource {relative}: {error}"))?;
        if !source_path.starts_with(&plugin_root) {
            return Err("IDE_EXECUTABLE_RESOURCE_OUTSIDE_PLUGIN".to_string());
        }
        let metadata = std::fs::metadata(&source_path)
            .map_err(|error| format!("stat executable resource: {error}"))?;
        if !metadata.is_file() || metadata.len() > MAX_EXECUTABLE_BYTES {
            return Err("IDE_EXECUTABLE_RESOURCE_INVALID".to_string());
        }
        let bytes = std::fs::read(&source_path)
            .map_err(|error| format!("read executable resource: {error}"))?;
        let actual = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
        if actual != expected {
            return Err("IDE_EXECUTABLE_RESOURCE_HASH_MISMATCH".to_string());
        }
        let digest = actual.trim_start_matches("sha256:");
        let target = cache_root
            .join("artifacts")
            .join("protocol-executables")
            .join(digest)
            .join(id);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create executable cache: {error}"))?;
        }
        atomic_write(&target, &bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("protect executable artifact: {error}"))?;
        }
        artifacts.push(ProxyExecutableArtifact {
            id: id.to_string(),
            sha256: actual,
            path: target.to_string_lossy().into_owned(),
        });
    }
    artifacts.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(artifacts)
}

fn validate_contribution_ids(contributions: &Value, prefix: &str) -> Result<(), String> {
    let mut ids = Vec::new();
    let mut add_array = |kind: &'static str, field: &str, id_field: &str| {
        for entry in contributions
            .get(field)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = entry.get(id_field).and_then(Value::as_str) {
                ids.push((kind, id));
            }
        }
    };
    add_array("command", "commands", "command");
    add_array("submenu", "submenus", "id");
    add_array("language", "languages", "id");
    add_array("theme", "themes", "id");
    add_array("iconTheme", "iconThemes", "id");
    add_array("productIconTheme", "productIconThemes", "id");
    add_array("color", "colors", "id");
    add_array("customEditor", "customEditors", "viewType");
    add_array("notebook", "notebooks", "type");
    add_array("notebookRenderer", "notebookRenderer", "id");
    add_array("notebookPreload", "notebookPreload", "type");
    add_array("debugger", "debuggers", "type");
    add_array("taskDefinition", "taskDefinitions", "type");
    add_array("problemMatcher", "problemMatchers", "name");
    add_array("problemPattern", "problemPatterns", "name");
    add_array("authentication", "authentication", "id");
    add_array("terminalQuickFix", "terminalQuickFixes", "id");
    add_array("chatParticipant", "chatParticipants", "id");
    add_array("languageModelToolSet", "languageModelToolSets", "name");
    add_array("speechProvider", "speechProviders", "name");
    add_array("localization", "localizations", "languageId");
    add_array(
        "languageModelChatProvider",
        "languageModelChatProviders",
        "vendor",
    );
    add_array(
        "mcpServerDefinitionProvider",
        "mcpServerDefinitionProviders",
        "id",
    );
    add_array("languageModelTool", "languageModelTools", "name");
    for id in contributions
        .get("icons")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|icons| icons.keys())
    {
        ids.push(("icon", id.as_str()));
    }
    for (kind, field) in [("viewContainer", "viewsContainers"), ("view", "views")] {
        for entry in contributions
            .get(field)
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|groups| groups.values())
            .filter_map(Value::as_array)
            .flatten()
        {
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                ids.push((kind, id));
            }
        }
    }
    for walkthrough in contributions
        .get("walkthroughs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = walkthrough.get("id").and_then(Value::as_str) {
            ids.push(("walkthrough", id));
        }
        for step in walkthrough
            .get("steps")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = step.get("id").and_then(Value::as_str) {
                ids.push(("walkthroughStep", id));
            }
        }
    }
    for profile in contributions
        .pointer("/terminal/profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = profile.get("id").and_then(Value::as_str) {
            ids.push(("terminalProfile", id));
        }
    }

    let mut seen = HashSet::new();
    for (kind, id) in ids {
        if !id.starts_with(prefix) {
            return Err(format!("IDE_PROXY_ID_OUTSIDE_NAMESPACE: {kind}:{id}"));
        }
        if !seen.insert((kind, id)) {
            return Err(format!("IDE_PROXY_ID_DUPLICATE: {kind}:{id}"));
        }
    }
    Ok(())
}

fn read_assets(request: &ProxyBuildRequest) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let root = Path::new(&request.plugin_root)
        .canonicalize()
        .map_err(|error| format!("resolve plugin root: {error}"))?;
    let mut assets = BTreeMap::new();
    let mut total_bytes = 0_u64;
    let mut visited_directories = HashSet::new();
    for asset in &request.assets {
        if !safe_package_path(&asset.package_path)
            || asset.sha256.as_deref().is_some_and(|hash| !is_sha256(hash))
        {
            return Err("IDE_PROXY_ASSET_INVALID".to_string());
        }
        let path = Path::new(&asset.source_path)
            .canonicalize()
            .map_err(|error| format!("resolve proxy asset: {error}"))?;
        if !path.starts_with(&root) {
            return Err("IDE_PROXY_ASSET_OUTSIDE_PLUGIN".to_string());
        }
        read_asset_path(
            &root,
            &path,
            &asset.package_path,
            asset.sha256.as_deref(),
            &mut assets,
            &mut total_bytes,
            &mut visited_directories,
        )?;
    }
    Ok(assets)
}

fn read_asset_path(
    root: &Path,
    path: &Path,
    package_path: &str,
    expected_sha256: Option<&str>,
    assets: &mut BTreeMap<String, Vec<u8>>,
    total_bytes: &mut u64,
    visited_directories: &mut HashSet<std::path::PathBuf>,
) -> Result<(), String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("resolve proxy asset: {error}"))?;
    if !canonical.starts_with(root) || !safe_package_path(package_path) {
        return Err("IDE_PROXY_ASSET_OUTSIDE_PLUGIN".to_string());
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| format!("stat proxy asset {}: {error}", canonical.display()))?;
    if metadata.is_dir() {
        if expected_sha256.is_some() || !visited_directories.insert(canonical.clone()) {
            return Err("IDE_PROXY_ASSET_INVALID".to_string());
        }
        for entry in std::fs::read_dir(&canonical)
            .map_err(|error| format!("read proxy asset {}: {error}", canonical.display()))?
        {
            let entry = entry
                .map_err(|error| format!("read proxy asset {}: {error}", canonical.display()))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "IDE_PROXY_ASSET_INVALID".to_string())?;
            read_asset_path(
                root,
                &entry.path(),
                &format!("{package_path}/{name}"),
                None,
                assets,
                total_bytes,
                visited_directories,
            )?;
        }
        return Ok(());
    }
    if !metadata.is_file() || metadata.len() > MAX_ASSET_BYTES {
        return Err("IDE_PROXY_ASSET_INVALID".to_string());
    }
    *total_bytes = total_bytes
        .checked_add(metadata.len())
        .filter(|size| *size <= MAX_TOTAL_ASSET_BYTES)
        .ok_or_else(|| "IDE_PROXY_ASSET_TOTAL_LIMIT_EXCEEDED".to_string())?;
    let bytes = std::fs::read(&canonical)
        .map_err(|error| format!("read proxy asset {}: {error}", canonical.display()))?;
    if let Some(expected) = expected_sha256 {
        if format!("sha256:{}", hex::encode(Sha256::digest(&bytes))) != expected {
            return Err("IDE_PROXY_ASSET_HASH_MISMATCH".to_string());
        }
    }
    if assets.insert(package_path.to_string(), bytes).is_some() {
        return Err("IDE_PROXY_ASSET_PATH_CONFLICT".to_string());
    }
    Ok(())
}

fn package_json(request: &ProxyBuildRequest) -> Value {
    let mut package = json!({
        "name": proxy_name(&request.plugin_id),
        "displayName": format!("{} (Cognia Managed Proxy)", request.plugin_id),
        "description": format!("Platform-generated proxy for Cognia plugin {}.", request.plugin_id),
        "version": request.plugin_version,
        "publisher": "cognia-managed",
        "private": true,
        "engines": { "vscode": CODE_API_VERSION },
        "main": "./dist/proxy.js",
        "extensionKind": ["workspace"],
        "extensionDependencies": [BROKER_EXTENSION_ID],
        "capabilities": {
            "untrustedWorkspaces": { "supported": "limited" },
            "virtualWorkspaces": { "supported": "limited" }
        },
        "contributes": request.contributions,
        "cogniaManaged": {
            "pluginId": request.plugin_id,
            "pluginVersion": request.plugin_version,
            "manifestHash": request.manifest_hash,
            "catalogHash": request.catalog_hash,
            "platformVersion": MANAGED_PLATFORM_VERSION,
            "providers": request.providers,
            "executables": request.executables,
            "protocols": request.protocols,
        }
    });
    let activation_events = derive_activation_events(request);
    if !activation_events.is_empty() {
        package["activationEvents"] = json!(activation_events);
    }
    package
}

fn derive_activation_events(request: &ProxyBuildRequest) -> Vec<String> {
    let mut events = BTreeSet::new();
    let contributions = &request.contributions;
    for command in contributions
        .get("commands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = command.get("command").and_then(Value::as_str) {
            events.insert(format!("onCommand:{id}"));
        }
    }
    for language in contributions
        .get("languages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(id) = language.get("id").and_then(Value::as_str) {
            events.insert(format!("onLanguage:{id}"));
        }
    }
    for provider in &request.providers {
        let kind = provider
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let metadata = provider.get("metadata").unwrap_or(&Value::Null);
        let event = match kind {
            "command" => provider
                .get("id")
                .and_then(Value::as_str)
                .map(|id| format!("onCommand:{id}")),
            "file-system" => metadata
                .get("scheme")
                .and_then(Value::as_str)
                .map(|id| format!("onFileSystem:{id}")),
            "debug-configuration" | "debug-adapter" | "debug-tracker" => metadata
                .get("debugType")
                .and_then(Value::as_str)
                .map(|id| format!("onDebug:{id}")),
            "task" => metadata
                .get("type")
                .and_then(Value::as_str)
                .map(|id| format!("onTaskType:{id}")),
            "terminal-profile" => provider
                .get("id")
                .and_then(Value::as_str)
                .map(|id| format!("onTerminalProfile:{id}")),
            "notebook-serializer" | "notebook-controller" | "notebook-cell-status-bar" => metadata
                .get("notebookType")
                .and_then(Value::as_str)
                .map(|id| format!("onNotebook:{id}")),
            "uri-handler" => Some("onUri".to_string()),
            _ => selector_language(provider)
                .map(|language| format!("onLanguage:{language}"))
                .or_else(|| Some("onStartupFinished".to_string())),
        };
        if let Some(event) = event {
            events.insert(event);
        }
    }
    for server in request
        .protocols
        .get("lsp")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let languages = server.get("languages").and_then(Value::as_array);
        if let Some(languages) = languages.filter(|languages| !languages.is_empty()) {
            for language in languages.iter().filter_map(Value::as_str) {
                events.insert(format!("onLanguage:{language}"));
            }
        } else {
            events.insert("onStartupFinished".to_string());
        }
    }
    if ["dap", "mcp"].iter().any(|family| {
        request
            .protocols
            .get(*family)
            .and_then(Value::as_array)
            .is_some_and(|servers| !servers.is_empty())
    }) {
        events.insert("onStartupFinished".to_string());
    }
    events.into_iter().collect()
}

fn selector_language(provider: &Value) -> Option<&str> {
    match provider.get("selector")? {
        Value::String(language) => Some(language),
        Value::Object(selector) => selector.get("language").and_then(Value::as_str),
        Value::Array(selectors) => selectors.iter().find_map(|selector| match selector {
            Value::String(language) => Some(language.as_str()),
            Value::Object(selector) => selector.get("language").and_then(Value::as_str),
            _ => None,
        }),
        _ => None,
    }
}

fn build_vsix_bytes(
    package: &Value,
    proxy_bundle: &[u8],
    assets: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let mut files = BTreeMap::new();
    files.insert(
        "[Content_Types].xml".to_string(),
        br#"<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>"#.to_vec(),
    );
    files.insert(
        "extension/package.json".to_string(),
        format!("{}\n", canonical_json(package)).into_bytes(),
    );
    files.insert("extension/dist/proxy.js".to_string(), proxy_bundle.to_vec());
    files.insert(
        "extension.vsixmanifest".to_string(),
        vsix_manifest(package).into_bytes(),
    );
    for (path, bytes) in assets {
        files.insert(format!("extension/{path}"), bytes.clone());
    }
    let cursor = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(cursor);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644);
    for (path, bytes) in files {
        zip.start_file(path, options)
            .map_err(|error| format!("start proxy zip entry: {error}"))?;
        zip.write_all(&bytes)
            .map_err(|error| format!("write proxy zip entry: {error}"))?;
    }
    zip.finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| format!("finish proxy VSIX: {error}"))
}

fn load_platform_proxy_bundle(vsix: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(vsix).map_err(|error| format!("open {}: {error}", vsix.display()))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("read broker VSIX: {error}"))?;
    let mut entry = archive
        .by_name("extension/dist/proxy.js")
        .map_err(|error| format!("platform proxy bundle missing: {error}"))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read platform proxy bundle: {error}"))?;
    Ok(bytes)
}

fn load_or_create_signing_key(root: &Path) -> Result<SigningKey, String> {
    let path = root.join("managed-signing.key");
    if let Ok(bytes) = std::fs::read(&path) {
        let secret: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "IDE_SIGNING_KEY_INVALID".to_string())?;
        return Ok(SigningKey::from_bytes(&secret));
    }
    std::fs::create_dir_all(root)
        .map_err(|error| format!("create signing key directory: {error}"))?;
    let mut secret = [0_u8; 32];
    rand::fill(&mut secret);
    atomic_write(&path, &secret)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect signing key: {error}"))?;
    }
    Ok(SigningKey::from_bytes(&secret))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "IDE_ARTIFACT_PATH_INVALID".to_string())?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("stage {}: {error}", path.display()))?;
    staged
        .write_all(bytes)
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    staged
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("replace {}: {}", path.display(), error.error))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let sorted: BTreeMap<_, _> = values.iter().collect();
            format!(
                "{{{}}}",
                sorted
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => serde_json::to_string(value).unwrap(),
    }
}

fn vsix_manifest(package: &Value) -> String {
    let name = xml(package["name"].as_str().unwrap_or_default());
    let version = xml(package["version"].as_str().unwrap_or_default());
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="{name}" Version="{version}" Publisher="cognia-managed"/><DisplayName>{name}</DisplayName><Description xml:space="preserve">Cognia managed proxy</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{CODE_API_VERSION}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="{BROKER_EXTENSION_ID}"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies><Dependency Id="{BROKER_EXTENSION_ID}" DisplayName="Cognia Managed IDE Broker" Version="1.0.0" Publisher="cognia"/></Dependencies><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>"#
    )
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn valid_version(value: &str) -> bool {
    let mut parts = value
        .splitn(2, ['-', '+'])
        .next()
        .unwrap_or_default()
        .split('.');
    (0..3).all(|_| parts.next().is_some_and(|part| part.parse::<u64>().is_ok()))
        && parts.next().is_none()
}

fn is_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn safe_package_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains('\\')
        && value
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "..")
}

pub(crate) fn proxy_name(plugin_id: &str) -> String {
    format!(
        "proxy-{}",
        plugin_id
            .to_ascii_lowercase()
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || character == '-' {
                    character
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .trim_matches('-')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_vsix_bytes_are_content_addressable() {
        let package = json!({
            "name": "proxy-acme",
            "version": "1.0.0",
            "contributes": { "commands": [] }
        });
        let assets = BTreeMap::from([("media/icon.svg".to_string(), b"<svg/>".to_vec())]);
        let first = build_vsix_bytes(&package, b"proxy", &assets).unwrap();
        let second = build_vsix_bytes(&package, b"proxy", &assets).unwrap();
        assert_eq!(first, second);
        assert_eq!(Sha256::digest(&first), Sha256::digest(&second));
    }

    #[test]
    fn provider_and_protocol_activation_events_are_precise_and_deterministic() {
        let request = ProxyBuildRequest {
            plugin_id: "acme".to_string(),
            plugin_version: "1.0.0".to_string(),
            plugin_root: "/tmp".to_string(),
            manifest_hash: format!("sha256:{}", "a".repeat(64)),
            catalog_hash: DEFAULT_CATALOG_HASH.to_string(),
            contributions: json!({
                "commands": [{ "command": "cognia.acme.run" }]
            }),
            providers: vec![
                json!({
                    "id": "cognia.acme.fs",
                    "kind": "file-system",
                    "metadata": { "scheme": "cognia-acme" }
                }),
                json!({
                    "id": "cognia.acme.hover",
                    "kind": "hover",
                    "selector": { "language": "cognia.acme.lang" }
                }),
            ],
            executables: Vec::new(),
            protocols: json!({
                "lsp": [{
                    "id": "cognia.acme.lsp",
                    "languages": ["cognia.acme.lang"]
                }],
                "dap": [{
                    "id": "cognia.acme.debug"
                }]
            }),
            assets: Vec::new(),
        };

        assert_eq!(
            derive_activation_events(&request),
            vec![
                "onCommand:cognia.acme.run",
                "onFileSystem:cognia-acme",
                "onLanguage:cognia.acme.lang",
                "onStartupFinished",
            ]
        );
        assert_eq!(
            package_json(&request)["activationEvents"],
            json!([
                "onCommand:cognia.acme.run",
                "onFileSystem:cognia-acme",
                "onLanguage:cognia.acme.lang",
                "onStartupFinished",
            ])
        );
    }

    #[test]
    fn request_rejects_namespace_and_catalog_forgery() {
        let mut request = ProxyBuildRequest {
            plugin_id: "acme".to_string(),
            plugin_version: "1.0.0".to_string(),
            plugin_root: "/tmp".to_string(),
            manifest_hash: format!("sha256:{}", "a".repeat(64)),
            catalog_hash: DEFAULT_CATALOG_HASH.to_string(),
            contributions: json!({
                "commands": [{ "command": "other.command" }]
            }),
            providers: Vec::new(),
            executables: Vec::new(),
            protocols: json!({}),
            assets: Vec::new(),
        };
        assert!(validate_request(&request)
            .unwrap_err()
            .starts_with("IDE_PROXY_ID_OUTSIDE_NAMESPACE"));
        request.contributions = json!({});
        request.catalog_hash = "sha256:forged".to_string();
        assert_eq!(
            validate_request(&request).unwrap_err(),
            "IDE_CATALOG_MISMATCH"
        );
    }

    #[test]
    fn asset_paths_cannot_escape_the_generated_extension() {
        assert!(safe_package_path("media/icon.svg"));
        assert!(!safe_package_path("../icon.svg"));
        assert!(!safe_package_path("/absolute/icon.svg"));
        assert!(!safe_package_path("media\\icon.svg"));
    }

    #[test]
    fn declared_asset_directories_are_expanded_without_following_escapes() {
        let root = tempfile::tempdir().unwrap();
        let plugin_root = root.path().join("plugin");
        std::fs::create_dir_all(plugin_root.join("notebooks/media/nested")).unwrap();
        std::fs::write(plugin_root.join("notebooks/media/icon.svg"), b"<svg/>").unwrap();
        std::fs::write(
            plugin_root.join("notebooks/media/nested/style.css"),
            b"body{}",
        )
        .unwrap();
        let request = ProxyBuildRequest {
            plugin_id: "acme".to_string(),
            plugin_version: "1.0.0".to_string(),
            plugin_root: plugin_root.to_string_lossy().into_owned(),
            manifest_hash: format!("sha256:{}", "a".repeat(64)),
            catalog_hash: DEFAULT_CATALOG_HASH.to_string(),
            contributions: json!({}),
            providers: Vec::new(),
            executables: Vec::new(),
            protocols: json!({}),
            assets: vec![ProxyAsset {
                source_path: plugin_root
                    .join("notebooks/media")
                    .to_string_lossy()
                    .into_owned(),
                package_path: "notebooks/media".to_string(),
                sha256: None,
            }],
        };
        let assets = read_assets(&request).unwrap();
        assert_eq!(
            assets.keys().cloned().collect::<Vec<_>>(),
            vec![
                "notebooks/media/icon.svg".to_string(),
                "notebooks/media/nested/style.css".to_string(),
            ]
        );
    }

    #[test]
    fn executable_resources_are_hash_verified_and_content_addressed() {
        let root = tempfile::tempdir().unwrap();
        let plugin_root = root.path().join("plugin");
        std::fs::create_dir_all(plugin_root.join("bin")).unwrap();
        let bytes = b"#!/bin/sh\nexit 0\n";
        std::fs::write(plugin_root.join("bin/server"), bytes).unwrap();
        let hash = format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
        let request = ProxyBuildRequest {
            plugin_id: "acme".to_string(),
            plugin_version: "1.0.0".to_string(),
            plugin_root: plugin_root.to_string_lossy().into_owned(),
            manifest_hash: format!("sha256:{}", "a".repeat(64)),
            catalog_hash: DEFAULT_CATALOG_HASH.to_string(),
            contributions: json!({}),
            providers: Vec::new(),
            executables: vec![json!({
                "id": "server",
                "source": {
                    "kind": "plugin-resource",
                    "path": "bin/server",
                    "sha256": hash,
                }
            })],
            protocols: json!({
                "lsp": [{
                    "id": "cognia.acme.language",
                    "executable": "server",
                    "transport": "stdio"
                }]
            }),
            assets: Vec::new(),
        };

        validate_request(&request).unwrap();
        let artifacts = stage_executable_resources(root.path(), &request).unwrap();
        assert_eq!(artifacts.len(), 1);
        assert_eq!(std::fs::read(&artifacts[0].path).unwrap(), bytes);

        let mut forged = request;
        forged.executables[0]["source"]["sha256"] =
            Value::String(format!("sha256:{}", "0".repeat(64)));
        assert_eq!(
            stage_executable_resources(root.path(), &forged).unwrap_err(),
            "IDE_EXECUTABLE_RESOURCE_HASH_MISMATCH"
        );
    }

    #[test]
    fn protocol_endpoints_are_explicit_loopback_urls_without_credentials() {
        let base = ProxyBuildRequest {
            plugin_id: "acme".to_string(),
            plugin_version: "1.0.0".to_string(),
            plugin_root: "/plugin".to_string(),
            manifest_hash: format!("sha256:{}", "a".repeat(64)),
            catalog_hash: DEFAULT_CATALOG_HASH.to_string(),
            contributions: json!({}),
            providers: Vec::new(),
            executables: vec![json!({
                "id": "server",
                "source": { "kind": "registered-tool", "tool": "language-server" }
            })],
            protocols: json!({
                "lsp": [{
                    "id": "cognia.acme.language",
                    "executable": "server",
                    "transport": "socket",
                    "endpoint": "tcp://127.0.0.1:5007"
                }]
            }),
            assets: Vec::new(),
        };
        validate_request(&base).unwrap();

        for endpoint in [
            "tcp://example.com:5007",
            "tcp://user:secret@127.0.0.1:5007",
            "http://127.0.0.1:5007",
            "tcp://127.0.0.1",
        ] {
            let mut request = base.clone();
            request.protocols["lsp"][0]["endpoint"] = Value::String(endpoint.to_string());
            assert!(validate_request(&request)
                .unwrap_err()
                .starts_with("IDE_PROTOCOL_ENDPOINT_INVALID"));
        }
    }

    #[test]
    fn every_global_contribution_id_is_namespaced_and_unique() {
        let valid = json!({
            "languages": [{ "id": "cognia.acme.lang" }],
            "viewsContainers": {
                "activitybar": [{ "id": "cognia.acme.container" }]
            },
            "views": {
                "cognia.acme.container": [{ "id": "cognia.acme.results" }]
            },
            "languageModelTools": [{ "name": "cognia.acme.inspect" }]
        });
        validate_contribution_ids(&valid, "cognia.acme.").unwrap();
        let invalid = json!({
            "customEditors": [{ "viewType": "native.editor" }]
        });
        assert!(validate_contribution_ids(&invalid, "cognia.acme.")
            .unwrap_err()
            .starts_with("IDE_PROXY_ID_OUTSIDE_NAMESPACE"));
        let duplicate = json!({
            "commands": [
                { "command": "cognia.acme.run" },
                { "command": "cognia.acme.run" }
            ]
        });
        assert!(validate_contribution_ids(&duplicate, "cognia.acme.")
            .unwrap_err()
            .starts_with("IDE_PROXY_ID_DUPLICATE"));
    }
}
#[test]
fn only_the_committed_activation_marker_selects_a_staged_artifact() {
    let artifact = ProxyArtifact {
        plugin_id: "acme".into(),
        plugin_version: "2.0.0".into(),
        manifest_hash: "sha256:manifest".into(),
        catalog_hash: DEFAULT_CATALOG_HASH.into(),
        platform_version: MANAGED_PLATFORM_VERSION.into(),
        sha256: "new-sha".into(),
        signature: String::new(),
        public_key: String::new(),
        vsix_path: String::new(),
        executables: Vec::new(),
    };
    assert!(!activation_marker_selects(None, &artifact));
    assert!(!activation_marker_selects(Some("old-sha"), &artifact));
    assert!(activation_marker_selects(Some("new-sha\n"), &artifact));
}
