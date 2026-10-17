//! What the proxy lets through, decided from the request alone (ADR-0224 A8).
//!
//! Pure: every decision here is a function of the method, the path, the query
//! and the body. The two decisions that need the daemon's word (does this
//! container, exec or volume carry our labels?) are returned as an
//! [`Ownership`] requirement for [`crate::proxy`] to look up.
//!
//! The rules mirror what the sandbox pool and the container exec backend
//! actually send (`cognia-external-agent::container_backend::create_body_for`)
//! and refuse everything else:
//!
//! - a container is created only with this deployment's ownership labels;
//! - it mounts only the workspaces volume and this deployment's agent bundle
//!   volumes (plus tmpfs), never a host path;
//! - no privileged mode, no host network, PID, IPC, UTS, user or cgroup
//!   namespace, no devices, no capabilities beyond the five the agent
//!   supervisor needs, no unconfined security profile, no unmasked `/proc`;
//! - every per-container, per-exec and per-volume operation targets something
//!   that carries those labels;
//! - lists only ever see this deployment's containers and volumes.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

/// The label every Cognia container and volume carries, and its value.
pub const OWNER_LABEL: &str = "cognia.owner";
pub const OWNER_VALUE: &str = "cognia-external-agent";
/// The label naming the deployment that created a container or volume.
pub const DEPLOYMENT_LABEL: &str = "cognia.deployment";

/// The capabilities a pool container may add back after dropping all: what
/// `cognia-sandboxd init-agent` needs to switch to the image's declared user
/// and prepare the workspace (`cognia-sandbox-pool` `docker.rs`).
pub const ALLOWED_CAPABILITIES: [&str; 5] = ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER"];

/// Security options that switch a confinement off.
const UNCONFINED_SECURITY_OPTS: [&str; 4] = [
    "seccomp=unconfined",
    "apparmor=unconfined",
    "systempaths=unconfined",
    "label=disable",
];

/// The deployment this proxy serves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyPolicy {
    /// `COGNIA_DEPLOYMENT_ID`: the `cognia.deployment` label value.
    pub deployment_id: String,
    /// `COGNIA_WORKSPACES_VOLUME`: the one named volume a workspace mounts.
    pub workspaces_volume: String,
    /// OCI runtimes a container may ask for (`runc`, and `runsc` for gVisor).
    pub allowed_runtimes: BTreeSet<String>,
}

impl ProxyPolicy {
    pub fn new(deployment_id: impl Into<String>, workspaces_volume: impl Into<String>) -> Self {
        Self {
            deployment_id: deployment_id.into(),
            workspaces_volume: workspaces_volume.into(),
            allowed_runtimes: ["runc", "runsc"].iter().map(|s| s.to_string()).collect(),
        }
    }

    /// The prefix of this deployment's agent bundle volumes
    /// (`cognia-<deployment>-bundle-<digest12>-<stage>`).
    pub fn bundle_volume_prefix(&self) -> String {
        format!("cognia-{}-bundle-", self.deployment_id)
    }

    /// Whether a label set marks a container or volume as this deployment's.
    pub fn owns(&self, labels: Option<&Map<String, Value>>) -> bool {
        let Some(labels) = labels else { return false };
        labels.get(OWNER_LABEL).and_then(Value::as_str) == Some(OWNER_VALUE)
            && labels.get(DEPLOYMENT_LABEL).and_then(Value::as_str)
                == Some(self.deployment_id.as_str())
    }
}

/// An HTTP method the policy distinguishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Get,
    Head,
    Post,
    Delete,
    Other,
}

impl Verb {
    pub fn parse(method: &str) -> Self {
        match method {
            "GET" => Self::Get,
            "HEAD" => Self::Head,
            "POST" => Self::Post,
            "DELETE" => Self::Delete,
            _ => Self::Other,
        }
    }
}

/// What a request is, once the API version prefix is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// `/_ping`, `/version`, `/info`: daemon facts, no resource.
    Daemon,
    /// `GET /containers/json`: answered only for this deployment's containers.
    ContainerList,
    /// `POST /containers/create`: the body is checked.
    ContainerCreate,
    /// An operation on one container.
    Container {
        id: String,
        op: ContainerOp,
    },
    /// `POST /containers/{id}/exec`: the target must be ours, the body unprivileged.
    ExecCreate {
        container: String,
    },
    /// An operation on one exec instance; its container must be ours.
    Exec {
        id: String,
    },
    /// `POST /images/create`: a pull.
    ImagePull,
    SnapshotCommit,
    SnapshotImage {
        id: String,
        remove: bool,
    },
    /// `GET /volumes`: answered only for this deployment's volumes.
    VolumeList,
    /// `POST /volumes/create`: the body is checked.
    VolumeCreate,
    /// `DELETE /volumes/{name}`: the volume must be ours.
    VolumeRemove {
        name: String,
    },
}

/// The per-container operations the pool uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerOp {
    Inspect,
    Start,
    Stop,
    Kill,
    Wait,
    Attach,
    Resize,
    Remove,
}

/// What the daemon must confirm before a request is forwarded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ownership {
    /// Nothing to look up.
    None,
    /// `GET /containers/{id}/json` must show our labels.
    Container(String),
    /// `GET /exec/{id}/json` names a container that must show our labels.
    Exec(String),
    /// `GET /volumes/{name}` must show our labels.
    Volume(String),
}

impl Route {
    pub fn ownership(&self) -> Ownership {
        match self {
            Route::Container { id, .. } => Ownership::Container(id.clone()),
            Route::ExecCreate { container } => Ownership::Container(container.clone()),
            Route::Exec { id } => Ownership::Exec(id.clone()),
            Route::VolumeRemove { name } => Ownership::Volume(name.clone()),
            _ => Ownership::None,
        }
    }
}

/// `/v1.53/containers/json` → `/containers/json`. A path with no version
/// prefix is the daemon's default version and passes unchanged.
pub fn strip_version(path: &str) -> &str {
    let Some(rest) = path.strip_prefix("/v") else {
        return path;
    };
    let end = rest.find('/').unwrap_or(rest.len());
    let version = &rest[..end];
    let is_version = !version.is_empty()
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
    if is_version {
        &rest[end..]
    } else {
        path
    }
}

/// Classify a request, or say why it is refused.
pub fn classify(verb: Verb, path: &str) -> Result<Route, String> {
    let path = strip_version(path);
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let refuse = || {
        Err(format!(
            "the Cognia Docker proxy does not allow {verb:?} {path}"
        ))
    };
    match (verb, segments.as_slice()) {
        (Verb::Get | Verb::Head, ["_ping"]) => Ok(Route::Daemon),
        (Verb::Get, ["version"] | ["info"]) => Ok(Route::Daemon),
        (Verb::Get, ["containers", "json"]) => Ok(Route::ContainerList),
        (Verb::Post, ["containers", "create"]) => Ok(Route::ContainerCreate),
        (verb, ["containers", id, rest @ ..]) if !id.is_empty() && *id != "create" => {
            let id = id.to_string();
            let op = match (verb, rest) {
                (Verb::Get, ["json"]) => ContainerOp::Inspect,
                (Verb::Post, ["start"]) => ContainerOp::Start,
                (Verb::Post, ["stop"]) => ContainerOp::Stop,
                (Verb::Post, ["kill"]) => ContainerOp::Kill,
                (Verb::Post, ["wait"]) => ContainerOp::Wait,
                (Verb::Post, ["attach"]) => ContainerOp::Attach,
                (Verb::Post, ["resize"]) => ContainerOp::Resize,
                (Verb::Delete, []) => ContainerOp::Remove,
                (Verb::Post, ["exec"]) => return Ok(Route::ExecCreate { container: id }),
                _ => return refuse(),
            };
            Ok(Route::Container { id, op })
        }
        (Verb::Post, ["exec", id, "start" | "resize"]) | (Verb::Get, ["exec", id, "json"])
            if !id.is_empty() =>
        {
            Ok(Route::Exec { id: id.to_string() })
        }
        (Verb::Post, ["images", "create"]) => Ok(Route::ImagePull),
        (Verb::Post, ["commit"]) => Ok(Route::SnapshotCommit),
        // Inspect also takes a snapshot-namespace name: compensation looks an
        // image up by name before its ID is in the ledger. The handler then
        // requires this deployment's namespace and commit provenance.
        (Verb::Get, ["images", id, "json"]) => Ok(Route::SnapshotImage {
            id: decode_image_id(id, true)?,
            remove: false,
        }),
        (Verb::Delete, ["images", id]) => Ok(Route::SnapshotImage {
            id: decode_image_id(id, false)?,
            remove: true,
        }),
        (Verb::Get, ["volumes"]) => Ok(Route::VolumeList),
        (Verb::Post, ["volumes", "create"]) => Ok(Route::VolumeCreate),
        (Verb::Delete, ["volumes", name]) if !name.is_empty() && *name != "create" => {
            Ok(Route::VolumeRemove {
                name: name.to_string(),
            })
        }
        _ => refuse(),
    }
}

/// The namespace is deterministic across Host and proxy restarts. Only the
/// restricted commit route can create a tag within it through this proxy.
pub fn snapshot_repository(policy: &ProxyPolicy) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "cognia-snapshot-{}",
        &hex::encode(Sha256::digest(policy.deployment_id.as_bytes()))[..24]
    )
}
fn decode_image_id(raw: &str, allow_snapshot_name: bool) -> Result<String, String> {
    let pair = format!("id={raw}");
    let id = url::form_urlencoded::parse(pair.as_bytes())
        .next()
        .map(|(_, id)| id.into_owned())
        .ok_or("invalid image identity")?;
    // Snapshots are addressed by image ID, or (inspect only) by a name in the
    // snapshot namespace; any other name or tag (`alpine`, `repo:tag`) is never
    // a snapshot and stays refused at classification.
    if snapshot_image_id(&id) || (allow_snapshot_name && snapshot_namespace_name(&id)) {
        Ok(id)
    } else {
        Err("invalid snapshot image identity".into())
    }
}
/// `cognia-snapshot-<24 hex>:<uuid>`, whichever deployment it belongs to.
fn snapshot_namespace_name(name: &str) -> bool {
    name.split_once(':').is_some_and(|(repository, tag)| {
        repository.strip_prefix("cognia-snapshot-").is_some_and(|hash| {
            hash.len() == 24 && hash.bytes().all(|b| b.is_ascii_hexdigit())
        }) && uuid::Uuid::parse_str(tag).is_ok()
    })
}
pub fn snapshot_image_id(id: &str) -> bool {
    id.strip_prefix("sha256:")
        .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
}
pub fn snapshot_tag(policy: &ProxyPolicy, tag: &str) -> bool {
    tag.strip_prefix(&format!("{}:", snapshot_repository(policy)))
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}
fn query_map(query: Option<&str>) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut values = std::collections::BTreeMap::new();
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
        if values
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("duplicate snapshot query parameter".into());
        }
    }
    Ok(values)
}
/// Return the exact stopped container to inspect before forwarding commit.
pub fn check_snapshot_commit(
    policy: &ProxyPolicy,
    query: Option<&str>,
    body: &Value,
) -> Result<String, String> {
    let values = query_map(query)?;
    if values
        .keys()
        .any(|k| !["container", "repo", "tag", "pause"].contains(&k.as_str()))
        || values.get("repo") != Some(&snapshot_repository(policy))
        || !values
            .get("tag")
            .is_some_and(|tag| uuid::Uuid::parse_str(tag).is_ok())
        || values.get("pause").map(String::as_str) != Some("false")
    {
        return Err(
            "snapshot commit requires this deployment's UUID namespace and pause=false".into(),
        );
    }
    if !body
        .as_object()
        .is_some_and(|map| map.values().all(Value::is_null))
    {
        return Err("snapshot commit cannot override container configuration".into());
    }
    let container = values
        .get("container")
        .ok_or("snapshot container required")?;
    if container.is_empty()
        || !container
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("invalid snapshot container".into());
    }
    Ok(container.clone())
}
pub fn check_snapshot_remove(query: Option<&str>, id: &str) -> Result<(), String> {
    let values = query_map(query)?;
    if !snapshot_image_id(id)
        || values
            .keys()
            .any(|k| !["force", "noprune"].contains(&k.as_str()))
        || values.get("force").is_some_and(|v| v != "false")
        || values.get("noprune").map(String::as_str) != Some("true")
    {
        return Err("snapshot removal requires immutable ID, force=false and noprune=true".into());
    }
    Ok(())
}

fn object<'a>(value: &'a Value, field: &str) -> Result<Option<&'a Map<String, Value>>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map)),
        Some(_) => Err(format!("{field} must be an object")),
    }
}

/// An array field that must be absent, null or empty.
fn require_empty(map: &Map<String, Value>, field: &str) -> Result<(), String> {
    match map.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(items)) if items.is_empty() => Ok(()),
        Some(Value::Object(items)) if items.is_empty() => Ok(()),
        Some(Value::String(s)) if s.is_empty() => Ok(()),
        Some(_) => Err(format!("HostConfig.{field} is not allowed")),
    }
}

/// A namespace mode that must not join the host's or another container's.
fn require_private_namespace(map: &Map<String, Value>, field: &str) -> Result<(), String> {
    match map.get(field) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(mode)) => {
            let mode = mode.trim().to_ascii_lowercase();
            if mode == "host" || mode.starts_with("container:") {
                Err(format!("HostConfig.{field}={mode} is not allowed"))
            } else {
                Ok(())
            }
        }
        Some(_) => Err(format!("HostConfig.{field} must be a string")),
    }
}

fn labels_are_ours(policy: &ProxyPolicy, body: &Value) -> Result<(), String> {
    let labels = object(body, "Labels")?;
    if policy.owns(labels) {
        Ok(())
    } else {
        Err(format!(
            "a created resource must carry {OWNER_LABEL}={OWNER_VALUE} and {DEPLOYMENT_LABEL}={}",
            policy.deployment_id
        ))
    }
}

fn check_mount(policy: &ProxyPolicy, mount: &Value) -> Result<(), String> {
    let kind = mount
        .get("Type")
        .and_then(Value::as_str)
        .unwrap_or("volume");
    match kind {
        "tmpfs" => Ok(()),
        "volume" => {
            let source = mount.get("Source").and_then(Value::as_str).unwrap_or("");
            if source != policy.workspaces_volume
                && !source.starts_with(&policy.bundle_volume_prefix())
            {
                return Err(format!(
                    "a container may mount only the workspaces volume or this deployment's bundle volumes, not {source:?}"
                ));
            }
            // A volume driver's options can name a host path (`o=bind`).
            let driver = mount
                .get("VolumeOptions")
                .and_then(|options| options.get("DriverConfig"));
            if !matches!(driver, None | Some(Value::Null)) {
                return Err("a mount may not carry a volume DriverConfig".to_string());
            }
            Ok(())
        }
        other => Err(format!("a {other} mount is not allowed")),
    }
}

fn capability_name(raw: &str) -> String {
    let upper = raw.trim().to_ascii_uppercase();
    upper
        .strip_prefix("CAP_")
        .map(str::to_string)
        .unwrap_or(upper)
}

/// `POST /containers/create`.
pub fn check_container_create(policy: &ProxyPolicy, body: &Value) -> Result<(), String> {
    if !body.is_object() {
        return Err("the create body must be a JSON object".to_string());
    }
    labels_are_ours(policy, body)?;
    let Some(host) = object(body, "HostConfig")? else {
        return Ok(());
    };
    if host.get("Privileged").and_then(Value::as_bool) == Some(true) {
        return Err("HostConfig.Privileged is not allowed".to_string());
    }
    for field in [
        "Binds",
        "Devices",
        "DeviceRequests",
        "DeviceCgroupRules",
        "VolumesFrom",
        "Links",
        "Sysctls",
        "PortBindings",
        "CgroupParent",
    ] {
        require_empty(host, field)?;
    }
    if host.get("PublishAllPorts").and_then(Value::as_bool) == Some(true) {
        return Err("HostConfig.PublishAllPorts is not allowed".to_string());
    }
    // Present at all (even empty) means "unmask /proc"; only absent is safe.
    for field in ["MaskedPaths", "ReadonlyPaths"] {
        if !matches!(host.get(field), None | Some(Value::Null)) {
            return Err(format!("HostConfig.{field} is not allowed"));
        }
    }
    for field in [
        "PidMode",
        "IpcMode",
        "UTSMode",
        "UsernsMode",
        "CgroupnsMode",
        "NetworkMode",
    ] {
        require_private_namespace(host, field)?;
    }
    match host.get("Runtime") {
        None | Some(Value::Null) => {}
        Some(Value::String(runtime)) if runtime.is_empty() => {}
        Some(Value::String(runtime)) if policy.allowed_runtimes.contains(runtime) => {}
        Some(other) => return Err(format!("HostConfig.Runtime {other} is not allowed")),
    }
    if let Some(caps) = host.get("CapAdd") {
        let caps = match caps {
            Value::Null => Vec::new(),
            Value::Array(items) => items.clone(),
            _ => return Err("HostConfig.CapAdd must be an array".to_string()),
        };
        for cap in caps {
            let name = cap.as_str().map(capability_name).unwrap_or_default();
            if !ALLOWED_CAPABILITIES.contains(&name.as_str()) {
                return Err(format!("adding capability {name:?} is not allowed"));
            }
        }
    }
    if let Some(opts) = host.get("SecurityOpt") {
        let opts = match opts {
            Value::Null => Vec::new(),
            Value::Array(items) => items.clone(),
            _ => return Err("HostConfig.SecurityOpt must be an array".to_string()),
        };
        for opt in opts {
            let normalized = opt
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
                .replacen(':', "=", 1);
            if UNCONFINED_SECURITY_OPTS.contains(&normalized.as_str()) {
                return Err(format!("security option {normalized:?} is not allowed"));
            }
        }
    }
    match host.get("Mounts") {
        None | Some(Value::Null) => {}
        Some(Value::Array(mounts)) => {
            for mount in mounts {
                check_mount(policy, mount)?;
            }
        }
        Some(_) => return Err("HostConfig.Mounts must be an array".to_string()),
    }
    Ok(())
}

/// `POST /containers/{id}/exec`: never privileged.
pub fn check_exec_create(body: &Value) -> Result<(), String> {
    if body.get("Privileged").and_then(Value::as_bool) == Some(true) {
        return Err("a privileged exec is not allowed".to_string());
    }
    Ok(())
}

/// `POST /volumes/create`: a bundle volume of this deployment, local driver,
/// no driver options.
pub fn check_volume_create(policy: &ProxyPolicy, body: &Value) -> Result<(), String> {
    labels_are_ours(policy, body)?;
    let name = body.get("Name").and_then(Value::as_str).unwrap_or("");
    if !name.starts_with(&policy.bundle_volume_prefix()) {
        return Err(format!(
            "only this deployment's bundle volumes may be created, not {name:?}"
        ));
    }
    match body.get("Driver").and_then(Value::as_str) {
        None | Some("") | Some("local") => {}
        Some(other) => return Err(format!("volume driver {other:?} is not allowed")),
    }
    match body.get("DriverOpts") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(opts)) if opts.is_empty() => Ok(()),
        Some(_) => Err("volume DriverOpts are not allowed".to_string()),
    }
}

/// Add this deployment's labels to a list query's `filters`, so a list only
/// ever shows our containers or volumes. Docker ANDs label filters, so a
/// caller's own filters (`id=…`, other labels) still apply.
pub fn scoped_list_query(policy: &ProxyPolicy, query: Option<&str>) -> Result<String, String> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut filters: Map<String, Value> = Map::new();
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
        if key == "filters" {
            let parsed: Value =
                serde_json::from_str(&value).map_err(|e| format!("filters is not JSON: {e}"))?;
            let Value::Object(map) = parsed else {
                return Err("filters must be a JSON object".to_string());
            };
            filters = map;
        } else {
            pairs.push((key.into_owned(), value.into_owned()));
        }
    }
    let ours = [
        format!("{OWNER_LABEL}={OWNER_VALUE}"),
        format!("{DEPLOYMENT_LABEL}={}", policy.deployment_id),
    ];
    let labels = filters
        .entry("label")
        .or_insert_with(|| Value::Array(Vec::new()));
    match labels {
        Value::Array(items) => {
            for label in ours {
                if !items
                    .iter()
                    .any(|item| item.as_str() == Some(label.as_str()))
                {
                    items.push(Value::String(label));
                }
            }
        }
        // The legacy `{"label": {"k=v": true}}` form.
        Value::Object(items) => {
            for label in ours {
                items.insert(label, Value::Bool(true));
            }
        }
        _ => return Err("filters.label must be an array or an object".to_string()),
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in &pairs {
        serializer.append_pair(key, value);
    }
    serializer.append_pair("filters", &Value::Object(filters).to_string());
    Ok(serializer.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy() -> ProxyPolicy {
        ProxyPolicy::new("dep1", "dep1_workspaces")
    }

    fn ours() -> Value {
        json!({ "cognia.owner": "cognia-external-agent", "cognia.deployment": "dep1" })
    }

    /// The body the sandbox pool sends for an agent container
    /// (`create_body_for` over the pool's agent spec).
    fn pool_agent_body() -> Value {
        json!({
            "Image": "ghcr.io/acme/app@sha256:abc",
            "Entrypoint": ["/opt/cognia/bin/cognia-sandboxd", "init-agent"],
            "Cmd": ["agent"],
            "Env": ["A=1"],
            "User": "0",
            "WorkingDir": "/workspace",
            "Labels": ours(),
            "AttachStdin": true,
            "OpenStdin": true,
            "HostConfig": {
                "Mounts": [
                    { "Type": "volume", "Source": "dep1_workspaces", "Target": "/workspace",
                      "VolumeOptions": { "Subpath": "tasks/t1" } },
                    { "Type": "volume", "Source": "cognia-dep1-bundle-0123456789ab-core",
                      "Target": "/opt/cognia", "ReadOnly": true }
                ],
                "SecurityOpt": ["no-new-privileges:true", "seccomp={\"defaultAction\":\"SCMP_ACT_ERRNO\"}"],
                "Memory": 2147483648_i64,
                "NanoCpus": 2000000000_i64,
                "PidsLimit": 512,
                "NetworkMode": "none",
                "Runtime": "runsc",
                "CapDrop": ["ALL"],
                "CapAdd": ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER"],
                "ReadonlyRootfs": false,
                "Tmpfs": { "/tmp": "" }
            }
        })
    }

    fn with_host(field: &str, value: Value) -> Value {
        let mut body = pool_agent_body();
        body["HostConfig"][field] = value;
        body
    }

    #[test]
    fn snapshots_require_exclusive_deployment_namespace_and_nonforced_ids() {
        let policy = policy();
        let id = uuid::Uuid::new_v4().to_string();
        let repository = snapshot_repository(&policy);
        let query = format!("container=runtime-1&repo={repository}&tag={id}&pause=false");
        assert_eq!(
            check_snapshot_commit(&policy, Some(&query), &json!({})),
            Ok("runtime-1".into())
        );
        assert!(snapshot_tag(&policy, &format!("{repository}:{id}")));
        assert!(!snapshot_tag(
            &ProxyPolicy::new("other", "volume"),
            &format!("{repository}:{id}")
        ));
        assert!(check_snapshot_commit(
            &policy,
            Some(&query.replace("pause=false", "pause=true")),
            &json!({})
        )
        .is_err());
        assert!(check_snapshot_commit(
            &policy,
            Some(&format!("{query}&container=other")),
            &json!({})
        )
        .is_err());
        assert!(
            check_snapshot_commit(&policy, Some(&query), &json!({"Env":["SECRET=value"]})).is_err()
        );
        let image = format!("sha256:{}", "a".repeat(64));
        assert!(check_snapshot_remove(Some("force=false&noprune=true"), &image).is_ok());
        assert!(check_snapshot_remove(Some("force=true&noprune=true"), &image).is_err());
        assert!(check_snapshot_remove(Some("force=false&noprune=false"), &image).is_err());
        assert!(check_snapshot_remove(
            Some("force=false&noprune=true"),
            &format!("{repository}:{id}")
        )
        .is_err());
        assert!(matches!(
            classify(Verb::Post, "/v1.53/commit"),
            Ok(Route::SnapshotCommit)
        ));
        assert!(matches!(
            classify(Verb::Get, &format!("/v1.53/images/{image}/json")),
            Ok(Route::SnapshotImage { remove: false, .. })
        ));
        assert!(classify(Verb::Delete, "/images/..%2fother").is_err());
        // Compensation inspects a not-yet-recorded image by its snapshot name;
        // deletion stays immutable-ID only, and other names stay refused.
        let name = format!("{repository}%3A{id}");
        assert!(matches!(
            classify(Verb::Get, &format!("/images/{name}/json")),
            Ok(Route::SnapshotImage { remove: false, .. })
        ));
        assert!(classify(Verb::Delete, &format!("/images/{name}")).is_err());
        assert!(classify(Verb::Get, "/images/alpine/json").is_err());
        assert!(classify(Verb::Get, "/images/cognia-snapshot-x%3Anot-a-uuid/json").is_err());
    }

    #[test]
    fn strips_the_api_version_prefix_only() {
        assert_eq!(strip_version("/v1.53/containers/json"), "/containers/json");
        assert_eq!(strip_version("/v1/info"), "/info");
        assert_eq!(strip_version("/containers/json"), "/containers/json");
        assert_eq!(strip_version("/volumes/vx"), "/volumes/vx");
        assert_eq!(strip_version("/vfoo/info"), "/vfoo/info");
    }

    #[test]
    fn classifies_what_the_pool_uses_and_refuses_the_rest() {
        let allowed = [
            (Verb::Head, "/_ping", Route::Daemon),
            (Verb::Get, "/v1.53/_ping", Route::Daemon),
            (Verb::Get, "/version", Route::Daemon),
            (Verb::Get, "/v1.53/info", Route::Daemon),
            (Verb::Get, "/v1.53/containers/json", Route::ContainerList),
            (
                Verb::Post,
                "/v1.53/containers/create",
                Route::ContainerCreate,
            ),
            (
                Verb::Get,
                "/containers/c1/json",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Inspect,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/start",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Start,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/stop",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Stop,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/kill",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Kill,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/wait",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Wait,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/attach",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Attach,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/resize",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Resize,
                },
            ),
            (
                Verb::Delete,
                "/containers/c1",
                Route::Container {
                    id: "c1".into(),
                    op: ContainerOp::Remove,
                },
            ),
            (
                Verb::Post,
                "/containers/c1/exec",
                Route::ExecCreate {
                    container: "c1".into(),
                },
            ),
            (
                Verb::Post,
                "/exec/e1/start",
                Route::Exec { id: "e1".into() },
            ),
            (
                Verb::Post,
                "/exec/e1/resize",
                Route::Exec { id: "e1".into() },
            ),
            (Verb::Get, "/exec/e1/json", Route::Exec { id: "e1".into() }),
            (Verb::Post, "/images/create", Route::ImagePull),
            (Verb::Get, "/volumes", Route::VolumeList),
            (Verb::Post, "/volumes/create", Route::VolumeCreate),
            (
                Verb::Delete,
                "/volumes/vol1",
                Route::VolumeRemove {
                    name: "vol1".into(),
                },
            ),
        ];
        for (verb, path, route) in allowed {
            assert_eq!(classify(verb, path), Ok(route), "{verb:?} {path}");
        }
        let refused = [
            (Verb::Post, "/build"),
            (Verb::Post, "/containers/c1/update"),
            (Verb::Other, "/containers/c1/archive"),
            (Verb::Get, "/containers/c1/archive"),
            (Verb::Get, "/containers/c1/export"),
            (Verb::Post, "/containers/c1/rename"),
            (Verb::Post, "/containers/prune"),
            (Verb::Post, "/volumes/prune"),
            (Verb::Get, "/volumes/vol1"),
            (Verb::Delete, "/images/alpine"),
            (Verb::Post, "/images/load"),
            (Verb::Get, "/networks"),
            (Verb::Post, "/networks/create"),
            (Verb::Get, "/events"),
            (Verb::Post, "/swarm/init"),
            (Verb::Get, "/secrets"),
            (Verb::Post, "/plugins/pull"),
            (Verb::Post, "/session"),
            (Verb::Get, "/"),
        ];
        for (verb, path) in refused {
            assert!(
                classify(verb, path).is_err(),
                "{verb:?} {path} must be refused"
            );
        }
    }

    #[test]
    fn per_resource_routes_name_what_the_daemon_must_confirm() {
        assert_eq!(
            classify(Verb::Post, "/containers/c1/start")
                .unwrap()
                .ownership(),
            Ownership::Container("c1".into())
        );
        assert_eq!(
            classify(Verb::Post, "/containers/c1/exec")
                .unwrap()
                .ownership(),
            Ownership::Container("c1".into())
        );
        assert_eq!(
            classify(Verb::Post, "/exec/e1/start").unwrap().ownership(),
            Ownership::Exec("e1".into())
        );
        assert_eq!(
            classify(Verb::Delete, "/volumes/v1").unwrap().ownership(),
            Ownership::Volume("v1".into())
        );
        assert_eq!(
            classify(Verb::Post, "/containers/create")
                .unwrap()
                .ownership(),
            Ownership::None
        );
    }

    #[test]
    fn admits_the_pool_agent_body() {
        assert_eq!(
            check_container_create(&policy(), &pool_agent_body()),
            Ok(())
        );
        // The staging container: no workspace, a writable bundle volume.
        let mut staging = pool_agent_body();
        staging["HostConfig"]["Mounts"] = json!([
            { "Type": "volume", "Source": "cognia-dep1-bundle-0123456789ab-glibc",
              "Target": "/opt/cognia", "ReadOnly": false }
        ]);
        staging["HostConfig"]["Runtime"] = Value::Null;
        assert_eq!(check_container_create(&policy(), &staging), Ok(()));
        // A legacy runner on the default bridge with no runtime and no caps.
        let mut runner = pool_agent_body();
        runner["HostConfig"]["NetworkMode"] = json!("bridge");
        runner["HostConfig"]
            .as_object_mut()
            .unwrap()
            .remove("CapAdd");
        runner["HostConfig"]
            .as_object_mut()
            .unwrap()
            .remove("Runtime");
        assert_eq!(check_container_create(&policy(), &runner), Ok(()));
    }

    #[test]
    fn refuses_a_container_that_is_not_ours() {
        let mut body = pool_agent_body();
        body["Labels"] =
            json!({ "cognia.owner": "cognia-external-agent", "cognia.deployment": "dep2" });
        assert!(check_container_create(&policy(), &body).is_err());
        body["Labels"] = json!({});
        assert!(check_container_create(&policy(), &body).is_err());
        body.as_object_mut().unwrap().remove("Labels");
        assert!(check_container_create(&policy(), &body).is_err());
        assert!(check_container_create(&policy(), &json!([])).is_err());
    }

    #[test]
    fn refuses_every_escape_from_the_container() {
        let cases = [
            ("Privileged", json!(true)),
            ("Binds", json!(["/:/host"])),
            ("Devices", json!([{ "PathOnHost": "/dev/kvm" }])),
            ("DeviceRequests", json!([{ "Count": -1 }])),
            ("VolumesFrom", json!(["other"])),
            ("Links", json!(["db:db"])),
            ("Sysctls", json!({ "net.ipv4.ip_forward": "1" })),
            (
                "PortBindings",
                json!({ "22/tcp": [{ "HostPort": "2222" }] }),
            ),
            ("PublishAllPorts", json!(true)),
            ("CgroupParent", json!("/system.slice")),
            ("MaskedPaths", json!([])),
            ("ReadonlyPaths", json!([])),
            ("NetworkMode", json!("host")),
            ("NetworkMode", json!("container:abc")),
            ("PidMode", json!("host")),
            ("PidMode", json!("container:abc")),
            ("IpcMode", json!("host")),
            ("UTSMode", json!("host")),
            ("UsernsMode", json!("host")),
            ("CgroupnsMode", json!("host")),
            ("CapAdd", json!(["SYS_ADMIN"])),
            ("CapAdd", json!(["CAP_NET_ADMIN"])),
            ("CapAdd", json!(["ALL"])),
            ("Runtime", json!("nvidia")),
            ("SecurityOpt", json!(["seccomp=unconfined"])),
            ("SecurityOpt", json!(["apparmor:unconfined"])),
            ("SecurityOpt", json!(["label=disable"])),
            ("SecurityOpt", json!(["systempaths=unconfined"])),
        ];
        for (field, value) in cases {
            let body = with_host(field, value.clone());
            assert!(
                check_container_create(&policy(), &body).is_err(),
                "HostConfig.{field}={value} must be refused"
            );
        }
        // The prefixed spelling of an allowed capability is still allowed.
        assert_eq!(
            check_container_create(&policy(), &with_host("CapAdd", json!(["CAP_CHOWN"]))),
            Ok(())
        );
    }

    #[test]
    fn mounts_only_the_workspaces_and_bundle_volumes() {
        let refused = [
            json!([{ "Type": "bind", "Source": "/", "Target": "/host" }]),
            json!([{ "Type": "bind", "Source": "/var/run/docker.sock", "Target": "/var/run/docker.sock" }]),
            json!([{ "Type": "volume", "Source": "other_data", "Target": "/data" }]),
            json!([{ "Type": "volume", "Source": "cognia-dep2-bundle-0123-core", "Target": "/opt" }]),
            json!([{ "Source": "", "Target": "/x" }]),
            json!([{ "Type": "npipe", "Source": "x", "Target": "/x" }]),
            json!([{ "Type": "volume", "Source": "dep1_workspaces", "Target": "/w",
                     "VolumeOptions": { "DriverConfig": { "Name": "local",
                       "Options": { "type": "none", "o": "bind", "device": "/" } } } }]),
        ];
        for mounts in refused {
            let body = with_host("Mounts", mounts.clone());
            assert!(
                check_container_create(&policy(), &body).is_err(),
                "{mounts}"
            );
        }
        let tmpfs = with_host("Mounts", json!([{ "Type": "tmpfs", "Target": "/scratch" }]));
        assert_eq!(check_container_create(&policy(), &tmpfs), Ok(()));
    }

    #[test]
    fn an_exec_is_never_privileged() {
        assert_eq!(
            check_exec_create(&json!({ "Cmd": ["sh"], "User": "0" })),
            Ok(())
        );
        assert_eq!(check_exec_create(&json!({ "Privileged": false })), Ok(()));
        assert!(check_exec_create(&json!({ "Privileged": true })).is_err());
    }

    #[test]
    fn creates_only_this_deployments_bundle_volumes() {
        let ok = json!({ "Name": "cognia-dep1-bundle-0123456789ab-core", "Labels": ours() });
        assert_eq!(check_volume_create(&policy(), &ok), Ok(()));
        let mut local = ok.clone();
        local["Driver"] = json!("local");
        local["DriverOpts"] = json!({});
        assert_eq!(check_volume_create(&policy(), &local), Ok(()));
        let refused = [
            json!({ "Name": "anything", "Labels": ours() }),
            json!({ "Name": "cognia-dep1-bundle-x-core" }),
            json!({ "Name": "cognia-dep1-bundle-x-core", "Labels": ours(), "Driver": "nfs" }),
            json!({ "Name": "cognia-dep1-bundle-x-core", "Labels": ours(),
                    "DriverOpts": { "type": "none", "o": "bind", "device": "/etc" } }),
        ];
        for body in refused {
            assert!(check_volume_create(&policy(), &body).is_err(), "{body}");
        }
    }

    #[test]
    fn owns_only_both_labels_of_this_deployment() {
        let p = policy();
        assert!(p.owns(ours().as_object()));
        assert!(!p.owns(json!({ "cognia.owner": "cognia-external-agent" }).as_object()));
        assert!(!p.owns(json!({ "cognia.owner": "x", "cognia.deployment": "dep1" }).as_object()));
        assert!(!p.owns(None));
    }

    fn filters_of(query: &str) -> Value {
        let (_, value) = url::form_urlencoded::parse(query.as_bytes())
            .find(|(k, _)| k == "filters")
            .expect("filters present");
        serde_json::from_str(&value).unwrap()
    }

    #[test]
    fn scopes_every_list_to_this_deployment() {
        let scoped = scoped_list_query(&policy(), None).unwrap();
        assert_eq!(
            filters_of(&scoped),
            json!({ "label": ["cognia.owner=cognia-external-agent", "cognia.deployment=dep1"] })
        );
        // The caller's own filters still apply, and other params pass through.
        let query = format!(
            "all=true&filters={}",
            url::form_urlencoded::byte_serialize(br#"{"id":["c1"]}"#).collect::<String>()
        );
        let scoped = scoped_list_query(&policy(), Some(&query)).unwrap();
        assert!(scoped.starts_with("all=true&"), "{scoped}");
        assert_eq!(
            filters_of(&scoped),
            json!({ "id": ["c1"],
                    "label": ["cognia.owner=cognia-external-agent", "cognia.deployment=dep1"] })
        );
        // The legacy map form.
        let legacy = format!(
            "filters={}",
            url::form_urlencoded::byte_serialize(br#"{"label":{"x=y":true}}"#).collect::<String>()
        );
        assert_eq!(
            filters_of(&scoped_list_query(&policy(), Some(&legacy)).unwrap()),
            json!({ "label": { "x=y": true,
                               "cognia.owner=cognia-external-agent": true,
                               "cognia.deployment=dep1": true } })
        );
        assert!(scoped_list_query(&policy(), Some("filters=nope")).is_err());
    }
}
