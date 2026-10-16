//! The Kubernetes remote provider (ADR-0221, ADR-0183 "Kubernetes").
//!
//! One instance is one Pod in the namespace the operator configured:
//!
//! - **Bundle injection.** Three init containers from the digest-pinned
//!   bundle image (built `FROM scratch`, so they run the bundle's own
//!   `cognia-sandboxd`) stage the core tree and both libc trees into an
//!   `emptyDir` mounted at `/cognia`; the stage markers let all three share
//!   it. The main container — the user's image, digest-pinned — mounts it
//!   read-only. This is ADR-0183's Kubernetes plan without image volumes.
//! - **Start gate.** The main container runs `cognia-sandboxd await-start`,
//!   which waits for a root-owned marker and then becomes the supervisor
//!   (`serve`). The driver clones the workspace first and then calls
//!   [`RemoteProvisioner::release_supervisor`], which creates the marker over
//!   exec (`release-start`).
//! - **Exec.** Pod exec carries only an argv, so every exec runs
//!   `cognia-sandboxd exec-env -- <argv>` and writes the environment and
//!   working directory as the first frame on stdin
//!   ([`cognia_sandboxd::exec_env`]); everything after it is the command's
//!   own stdin. The frame is what makes a Kubernetes exec equivalent to the
//!   Docker exec the shared driver was written against.
//! - **Labels.** Label values are at most 63 characters and the driver's
//!   labels carry 64-hex digests and arbitrary agent ids. The full map is kept
//!   verbatim as JSON in the [`LABELS_ANNOTATION`] annotation; only selectable
//!   labels are real labels: the owner label, a hashed deployment selector,
//!   the persistent-runtime marker and the instance name.
//! - **Egress.** A policy selecting the instance label, owned by the Pod so
//!   it is garbage-collected with it: a deny-all NetworkPolicy for `off`, a
//!   `CiliumNetworkPolicy` with `toFQDNs` for `allowlist` when the operator
//!   says the cluster runs Cilium, and otherwise a NetworkPolicy allowing all
//!   egress except the cloud metadata ranges.
//! - **Lifetime.** `activeDeadlineSeconds` is the request's lifetime, so a
//!   Host that dies cannot leak a running Pod past it.
//! - **Client.** [`KubernetesProvider::new`] is synchronous and does no I/O;
//!   the client is built on first use, and a failed build is retried by the
//!   next call. [`RemoteProvisioner::tiers`] refuses an API server older than
//!   1.30, whose pod exec cannot half-close stdin.
//!
//! The manifest builders, label codec, policy builders and failure
//! classifiers are pure functions, tested without a cluster; the API paths
//! are tested against an in-process API server.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use cognia_environment::spec::{EgressTier, IsolationTier};
use cognia_external_agent::container_backend::{
    validate_deployment_id, ContainerApi, OwnedContainer, OwnedVolume, RegistryAuth, RunnerEvent,
    RunnerExecSpec, RunnerRunError, RunnerSpec, RunningRunner, RuntimeContainerState,
    SandboxDockerApi, VolumeRemoval, DEPLOYMENT_LABEL, OWNER_LABEL, OWNER_VALUE,
    PERSISTENT_RUNTIME_LABEL,
};
use cognia_external_agent::sandbox_routing_backend::SandboxSpawnError;
use cognia_sandboxd::exec_env::{encode_frame, ExecEnvFrame};
use k8s_openapi::api::core::v1::{Pod, Secret};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::node::v1::RuntimeClass;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{ObjectMeta, OwnerReference, Status};
use k8s_openapi::ByteString;
use kube::api::{
    Api, ApiResource, AttachParams, DeleteParams, DynamicObject, ListParams, Patch, PatchParams,
    PostParams,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use super::{EgressPlan, ProvisionRequest, RemoteProvisioner, START_MARKER};

/// [`RemoteProvisioner::kind`] of this provider.
pub const KIND: &str = "kubernetes";

/// The annotation holding the instance's full label map as JSON.
pub const LABELS_ANNOTATION: &str = "cognia.dev/labels";

/// The annotation recording the bundle release the instance was built from,
/// for an operator reading `kubectl describe`.
pub const BUNDLE_RELEASE_ANNOTATION: &str = "cognia.dev/bundle-release";

/// Selectable label carrying the instance name; egress policies select it.
pub const INSTANCE_SELECTOR_LABEL: &str = "cognia.dev/instance";

/// Selectable label carrying [`deployment_selector`] of the deployment.
pub const DEPLOYMENT_SELECTOR_LABEL: &str = "cognia.dev/deployment";

/// The main container's name; every exec targets it.
pub const SANDBOX_CONTAINER: &str = "sandbox";

/// The server-side apply field manager for everything this provider writes.
pub const FIELD_MANAGER: &str = "cognia-sandbox-pool";

const BUNDLE_VOLUME: &str = "cognia-bundle";
const WORKSPACE_VOLUME: &str = "workspace";
const TMP_VOLUME: &str = "tmp";
/// `cognia-sandboxd` inside the bundle image, before staging.
const BUNDLE_SANDBOXD: &str = "/opt/cognia/bin/cognia-sandboxd";
/// `cognia-sandboxd` inside an instance, after staging.
const SANDBOXD: &str = "/cognia/bin/cognia-sandboxd";
const BUNDLE_SOURCE: &str = "/opt/cognia";
const INJECTION_TARGET: &str = "/cognia";
const WORKSPACE_TARGET: &str = "/workspace";
const TMP_TARGET: &str = "/tmp";

/// Exec output events queued before the reader waits for the consumer.
const EXEC_EVENT_QUEUE: usize = 64;
/// Exec stdin chunks queued before a writer waits for the remote side.
const EXEC_STDIN_QUEUE: usize = 16;
/// The duplex buffers between the exec websocket and the pumps.
const EXEC_STREAM_BUFFER: usize = 64 * 1024;
/// Bound on one API request; the kube client's own read timeout is minutes.
const API_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound on `release-start`, which only creates a file.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(60);
/// How often provisioning reads the Pod while waiting for it to run.
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(1);

/// The cloud metadata ranges no sandbox may reach
/// ([`cognia_net::egress::METADATA_CIDRS`]) of one address family. A
/// NetworkPolicy `ipBlock`'s `except` entries must lie inside its own
/// family's `cidr`, so the two families are listed apart.
pub fn metadata_cidrs(ipv6: bool) -> Vec<&'static str> {
    cognia_net::egress::METADATA_CIDRS
        .iter()
        .copied()
        .filter(|cidr| cidr.contains(':') == ipv6)
        .collect()
}

/// The oldest API server whose pod exec can half-close stdin (remotecommand
/// `v5.channel.k8s.io`, Kubernetes 1.30). On an older one, ending an exec's
/// stdin closes the whole stream, so a command that reads stdin to its end
/// would lose its output and exit status.
pub const MIN_SERVER_MINOR: u32 = 30;

const IMAGE_PULL_REASONS: [&str; 4] = [
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "ErrImageNeverPull",
];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/// Where the client configuration comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum KubernetesConnection {
    /// The Host runs as a Pod; the mounted service account is the identity.
    InCluster,
    /// A kubeconfig the Host resolves from its secret store or a file and
    /// passes to [`KubernetesProvider::connect`] as the provider credential.
    /// It is never part of the settings and never logged.
    Kubeconfig,
}

/// The RuntimeClass each isolation tier maps to. `gvisor` and `vm` are
/// attested only when mapped and present in the cluster; `container` runs
/// under the cluster default when unmapped.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeClassMap {
    #[serde(default)]
    pub gvisor: Option<String>,
    #[serde(default)]
    pub vm: Option<String>,
    #[serde(default)]
    pub container: Option<String>,
}

/// What the cluster's network layer enforces.
///
/// - `none`: no policy is written. Nothing restricts egress, so `off` and
///   `allowlist` are both reported unenforced.
/// - `network-policy` (default): the CNI enforces Kubernetes NetworkPolicy.
///   `off` is enforced (deny all). An `allowlist` is **unenforced**: plain
///   NetworkPolicy cannot match hostnames, so the instance gets the `on`
///   policy (everything except the metadata ranges) and the placement is
///   labelled `egress.enforced: false`. This is intentional dormancy, pinned
///   by `allowlist_is_enforced_only_with_cilium` below.
/// - `cilium`: Cilium is the CNI, so an `allowlist` becomes a
///   `CiliumNetworkPolicy` with `toFQDNs` and is enforced.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum KubernetesEgressMode {
    None,
    #[default]
    NetworkPolicy,
    Cilium,
}

fn default_ready_timeout() -> u64 {
    180
}

/// The operator's configuration of one Kubernetes provider.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubernetesSettings {
    /// Where the client config comes from. `inCluster` | `kubeconfig` (the
    /// kubeconfig YAML is supplied separately as the provider credential).
    pub connection: KubernetesConnection,
    /// The kubeconfig context to use; its current context when absent.
    /// Only meaningful with `kubeconfig`.
    #[serde(default)]
    pub context: Option<String>,
    /// The namespace instances, their policies and pull secrets live in.
    pub namespace: String,
    #[serde(default)]
    pub runtime_classes: RuntimeClassMap,
    #[serde(default)]
    pub egress: KubernetesEgressMode,
    /// Added to every instance Pod.
    #[serde(default)]
    pub node_selector: BTreeMap<String, String>,
    /// The Pod's service account. Its token is never mounted; this only
    /// selects what the cluster attaches by account (image pull secrets,
    /// admission policy).
    #[serde(default)]
    pub service_account_name: Option<String>,
    /// How long provisioning waits for an instance to run, image pulls and
    /// scheduling included. 10 to 1800 seconds.
    #[serde(default = "default_ready_timeout")]
    pub pod_ready_timeout_secs: u64,
}

// ---------------------------------------------------------------------------
// Name and label grammar
// ---------------------------------------------------------------------------

/// A DNS-1123 label: 1 to 63 of `[a-z0-9-]`, alphanumeric at both ends.
pub fn is_dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}

/// A DNS-1123 subdomain: dot-separated labels, 253 characters at most.
pub fn is_dns_subdomain(value: &str) -> bool {
    !value.is_empty() && value.len() <= 253 && value.split('.').all(is_dns_label)
}

/// A label value: empty, or 1 to 63 of `[A-Za-z0-9._-]` alphanumeric at both
/// ends.
pub fn is_label_value(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let bytes = value.as_bytes();
    value.len() <= 63
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// A label key: an optional DNS subdomain prefix and `/`, then a non-empty
/// name with the value grammar.
pub fn is_label_key(key: &str) -> bool {
    let (prefix, name) = match key.split_once('/') {
        Some((prefix, name)) => (Some(prefix), name),
        None => (None, key),
    };
    prefix.is_none_or(is_dns_subdomain) && !name.is_empty() && is_label_value(name)
}

fn sha256_hex(input: &str) -> String {
    hex::encode(Sha256::digest(input.as_bytes()))
}

/// The selectable form of a deployment id: 40 hex characters of its SHA-256,
/// so any id the Host accepts is a valid label value. The readable id stays
/// in the [`LABELS_ANNOTATION`] map.
pub fn deployment_selector(deployment_id: &str) -> String {
    sha256_hex(deployment_id)[..40].to_string()
}

/// `value` when it already is a label value, otherwise `h` and 40 hex
/// characters of its SHA-256.
fn label_value_or_hash(value: &str) -> String {
    if is_label_value(value) {
        value.to_string()
    } else {
        format!("h{}", &sha256_hex(value)[..40])
    }
}

/// The real labels an instance carries: the owner label (exactly the one
/// `is_owned` reads), the deployment selector, the persistent-runtime marker
/// when the driver set one, and the instance name.
pub fn selectable_labels(
    labels: &BTreeMap<String, String>,
    name: &str,
    deployment_selector: &str,
) -> BTreeMap<String, String> {
    let mut selectable = BTreeMap::from([
        (OWNER_LABEL.to_string(), OWNER_VALUE.to_string()),
        (
            DEPLOYMENT_SELECTOR_LABEL.to_string(),
            deployment_selector.to_string(),
        ),
        (INSTANCE_SELECTOR_LABEL.to_string(), name.to_string()),
    ]);
    if let Some(persistent) = labels.get(PERSISTENT_RUNTIME_LABEL) {
        selectable.insert(
            PERSISTENT_RUNTIME_LABEL.to_string(),
            label_value_or_hash(persistent),
        );
    }
    selectable
}

/// The [`LABELS_ANNOTATION`] value: the driver's map, verbatim.
pub fn encode_labels_annotation(labels: &BTreeMap<String, String>) -> String {
    serde_json::to_string(labels).expect("a string map always serializes")
}

/// The driver's label map back from an object's metadata.
///
/// Ownership and deployment are cross-checked against the selectable labels
/// rather than read from the annotation alone: an annotation that claims an
/// owner the object's own owner label does not carry, or a deployment whose
/// hash does not match the selector, loses that claim. An object without the
/// annotation (made by hand, or by an older build) answers its real labels.
pub fn decode_labels(metadata: &ObjectMeta) -> Result<BTreeMap<String, String>, String> {
    let name = metadata.name.as_deref().unwrap_or("<unnamed>");
    let selectable = metadata.labels.clone().unwrap_or_default();
    let mut labels = match metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get(LABELS_ANNOTATION))
    {
        Some(encoded) => {
            serde_json::from_str::<BTreeMap<String, String>>(encoded).map_err(|error| {
                format!("{name} carries an unreadable {LABELS_ANNOTATION} annotation: {error}")
            })?
        }
        None => selectable.clone(),
    };
    if selectable.get(OWNER_LABEL).map(String::as_str) != Some(OWNER_VALUE) {
        labels.remove(OWNER_LABEL);
    }
    if let Some(deployment) = labels.get(DEPLOYMENT_LABEL) {
        let consistent = selectable
            .get(DEPLOYMENT_SELECTOR_LABEL)
            .is_some_and(|selector| *selector == deployment_selector(deployment));
        if !consistent {
            labels.remove(DEPLOYMENT_LABEL);
        }
    }
    Ok(labels)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

impl KubernetesSettings {
    fn runtime_class_names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = [
            self.runtime_classes.container.as_deref(),
            self.runtime_classes.gvisor.as_deref(),
            self.runtime_classes.vm.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect();
        names.sort_unstable();
        names.dedup();
        names
    }
}

fn validate_settings(settings: &KubernetesSettings) -> Result<(), String> {
    if !is_dns_label(&settings.namespace) {
        return Err(format!(
            "namespace {:?} is not a DNS-1123 label (lowercase letters, digits and '-', 63 at most)",
            settings.namespace
        ));
    }
    match (&settings.connection, &settings.context) {
        (KubernetesConnection::InCluster, Some(_)) => {
            return Err("context applies only to a kubeconfig connection".into());
        }
        (KubernetesConnection::Kubeconfig, Some(context)) if context.trim().is_empty() => {
            return Err("context must not be empty; omit it to use the current context".into());
        }
        _ => {}
    }
    for (tier, class) in [
        ("container", &settings.runtime_classes.container),
        ("gvisor", &settings.runtime_classes.gvisor),
        ("vm", &settings.runtime_classes.vm),
    ] {
        if let Some(class) = class {
            if !is_dns_subdomain(class) {
                return Err(format!(
                    "runtime class {class:?} for tier {tier} is not a DNS-1123 subdomain"
                ));
            }
        }
    }
    for (key, value) in &settings.node_selector {
        if !is_label_key(key) {
            return Err(format!(
                "node selector key {key:?} is not a valid label key"
            ));
        }
        if !is_label_value(value) {
            return Err(format!(
                "node selector value {value:?} for {key} is not a valid label value"
            ));
        }
    }
    if let Some(account) = &settings.service_account_name {
        if !is_dns_subdomain(account) {
            return Err(format!(
                "service account name {account:?} is not a DNS-1123 subdomain"
            ));
        }
    }
    if !(10..=1800).contains(&settings.pod_ready_timeout_secs) {
        return Err(format!(
            "podReadyTimeoutSecs must be between 10 and 1800, got {}",
            settings.pod_ready_timeout_secs
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/// The RuntimeClass `tier` runs under. `container` may run under the cluster
/// default; `gvisor` and `vm` must be mapped, because the default runtime
/// does not provide them.
pub fn runtime_class_for(
    tier: IsolationTier,
    settings: &KubernetesSettings,
) -> Result<Option<String>, SandboxSpawnError> {
    let classes = &settings.runtime_classes;
    match tier {
        IsolationTier::Container => Ok(classes.container.clone()),
        IsolationTier::Gvisor | IsolationTier::Vm => {
            let class = match tier {
                IsolationTier::Gvisor => &classes.gvisor,
                _ => &classes.vm,
            };
            class.clone().map(Some).ok_or_else(|| {
                SandboxSpawnError::refused(
                    "isolation_tier_unavailable",
                    format!(
                        "this Kubernetes provider maps no RuntimeClass to the {} tier",
                        tier.as_str()
                    ),
                )
            })
        }
    }
}

/// The deterministic pull secret name for one (registry, username):
/// `cognia-pull-<12 hex>`. Token credentials (no username) share one name
/// per registry, and a newer credential replaces the older one.
pub fn pull_secret_name(auth: &RegistryAuth) -> String {
    let key = format!(
        "{}\n{}",
        auth.server_address.to_ascii_lowercase(),
        auth.username.as_deref().unwrap_or("")
    );
    format!("cognia-pull-{}", &sha256_hex(&key)[..12])
}

/// One `auths` entry of a Docker `config.json`, with Docker's semantics:
/// `username`/`password` plus the `auth` field derived from them,
/// `identitytoken` for an OAuth2 refresh token and `registrytoken` for a
/// bearer token.
///
/// The kubelet's own credential parser reads `auth`, `username` and
/// `password`; the token fields reach a pull only where the node's
/// credential path honours them. A token the node ignores fails the pull,
/// which provisioning reports as `sandbox_image_unavailable` with the
/// kubelet's message rather than running anything unauthenticated.
pub fn docker_config_entry(auth: &RegistryAuth) -> Result<Value, String> {
    let mut entry = serde_json::Map::new();
    match (&auth.username, &auth.password) {
        (Some(username), Some(password)) => {
            entry.insert("username".into(), json!(username));
            entry.insert("password".into(), json!(password));
            entry.insert(
                "auth".into(),
                json!(base64::engine::general_purpose::STANDARD
                    .encode(format!("{username}:{password}"))),
            );
        }
        (Some(username), None) => {
            entry.insert("username".into(), json!(username));
        }
        (None, Some(_)) => {
            return Err(format!(
                "registry credential for {} has a password but no username",
                auth.server_address
            ))
        }
        (None, None) => {}
    }
    if let Some(token) = &auth.identity_token {
        entry.insert("identitytoken".into(), json!(token));
    }
    if let Some(token) = &auth.registry_token {
        entry.insert("registrytoken".into(), json!(token));
    }
    let usable = entry.contains_key("auth")
        || entry.contains_key("identitytoken")
        || entry.contains_key("registrytoken");
    if !usable {
        return Err(format!(
            "registry credential for {} carries no password or token",
            auth.server_address
        ));
    }
    Ok(Value::Object(entry))
}

/// The `kubernetes.io/dockerconfigjson` Secret for one credential.
pub fn pull_secret(
    auth: &RegistryAuth,
    namespace: &str,
    deployment_selector: &str,
) -> Result<Secret, String> {
    if auth.server_address.trim().is_empty() {
        return Err("registry credential has no server address".into());
    }
    let config = json!({ "auths": { auth.server_address.clone(): docker_config_entry(auth)? } });
    let config = serde_json::to_vec(&config).map_err(|error| error.to_string())?;
    Ok(Secret {
        metadata: ObjectMeta {
            name: Some(pull_secret_name(auth)),
            namespace: Some(namespace.to_string()),
            labels: Some(BTreeMap::from([
                (OWNER_LABEL.to_string(), OWNER_VALUE.to_string()),
                (
                    DEPLOYMENT_SELECTOR_LABEL.to_string(),
                    deployment_selector.to_string(),
                ),
            ])),
            ..ObjectMeta::default()
        },
        type_: Some("kubernetes.io/dockerconfigjson".to_string()),
        data: Some(BTreeMap::from([(
            ".dockerconfigjson".to_string(),
            ByteString(config),
        )])),
        ..Secret::default()
    })
}

/// What a Pod manifest needs beyond the request and settings.
#[derive(Clone, Debug)]
pub struct PodContext<'a> {
    pub deployment_selector: &'a str,
    pub runtime_class: Option<&'a str>,
    pub pull_secrets: &'a [String],
}

fn split_env(entry: &str) -> Result<(&str, &str), String> {
    let (name, value) = entry.split_once('=').ok_or_else(|| {
        format!(
            "supervisor environment entry without '=': {}",
            env_name(entry)
        )
    })?;
    if !cognia_sandboxd::exec_env::is_valid_env_name(name) {
        return Err(format!("invalid supervisor environment name {name:?}"));
    }
    Ok((name, value))
}

/// The name part of an env entry, for messages that must not echo values.
fn env_name(entry: &str) -> &str {
    entry.split_once('=').map_or(entry, |(name, _)| name)
}

fn install_command(stage: &[&str]) -> Vec<String> {
    let mut command = vec![BUNDLE_SANDBOXD.to_string(), "install".to_string()];
    command.extend(stage.iter().map(|part| part.to_string()));
    command.extend([
        "--from".to_string(),
        BUNDLE_SOURCE.to_string(),
        "--to".to_string(),
        INJECTION_TARGET.to_string(),
    ]);
    command
}

/// The instance Pod for `request`. Pure: no cluster, no I/O.
pub fn pod_manifest(
    request: &ProvisionRequest,
    settings: &KubernetesSettings,
    context: &PodContext<'_>,
) -> Result<Pod, String> {
    if !is_dns_label(&request.name) {
        return Err(format!(
            "instance name {:?} is not a DNS-1123 label",
            request.name
        ));
    }
    request
        .image
        .validate()
        .map_err(|error| format!("image is not a pinned reference: {error}"))?;
    request
        .bundle
        .validate()
        .map_err(|error| format!("bundle is not a pinned reference: {error}"))?;
    if request.supervisor.is_empty() {
        return Err("the supervisor command is empty".into());
    }
    let size = &request.size;
    if size.gpu.is_some() {
        return Err(format!(
            "size class {} requests a GPU, which no sandbox is admitted with",
            size.id
        ));
    }
    if size.cpu_millis == 0
        || size.memory_mib == 0
        || size.ephemeral_storage_mib == 0
        || size.volume_mib == 0
    {
        return Err(format!("size class {} has a zero resource", size.id));
    }
    let env = request
        .supervisor_env
        .iter()
        .map(|entry| split_env(entry).map(|(name, value)| json!({ "name": name, "value": value })))
        .collect::<Result<Vec<_>, _>>()?;

    let resources = json!({
        "cpu": format!("{}m", size.cpu_millis),
        "memory": format!("{}Mi", size.memory_mib),
        "ephemeral-storage": format!("{}Mi", size.ephemeral_storage_mib),
    });
    let requirements = json!({ "requests": resources.clone(), "limits": resources });
    let bundle_image = request.bundle.canonical();
    // Init containers run only the bundle's own binary, so they get nothing:
    // no capabilities, a read-only root, and the bundle volume to fill.
    let init = |name: &str, stage: &[&str]| {
        json!({
            "name": name,
            "image": bundle_image,
            "imagePullPolicy": "IfNotPresent",
            "command": install_command(stage),
            "resources": requirements.clone(),
            "securityContext": {
                "runAsUser": 0,
                "runAsGroup": 0,
                "runAsNonRoot": false,
                "privileged": false,
                "allowPrivilegeEscalation": false,
                "readOnlyRootFilesystem": true,
                "capabilities": { "drop": ["ALL"] },
            },
            "volumeMounts": [{ "name": BUNDLE_VOLUME, "mountPath": INJECTION_TARGET }],
        })
    };
    let mut command = vec![
        SANDBOXD.to_string(),
        "await-start".to_string(),
        "--marker".to_string(),
        START_MARKER.to_string(),
        "--sticky".to_string(),
        TMP_TARGET.to_string(),
        "--".to_string(),
    ];
    command.extend(request.supervisor.iter().cloned());

    let selectable = selectable_labels(&request.labels, &request.name, context.deployment_selector);
    let mut spec = json!({
        "restartPolicy": "Never",
        "automountServiceAccountToken": false,
        "enableServiceLinks": false,
        "activeDeadlineSeconds": request.lifetime.as_secs().max(1),
        "terminationGracePeriodSeconds": 10,
        "securityContext": { "seccompProfile": { "type": "RuntimeDefault" } },
        "initContainers": [
            init("bundle-core", &["--stage", "core"]),
            init("bundle-glibc", &["--stage", "libc", "--libc", "glibc"]),
            init("bundle-musl", &["--stage", "libc", "--libc", "musl"]),
        ],
        "containers": [{
            "name": SANDBOX_CONTAINER,
            "image": request.image.canonical(),
            "imagePullPolicy": "IfNotPresent",
            "command": command,
            "env": env,
            "workingDir": WORKSPACE_TARGET,
            "stdin": false,
            "tty": false,
            "resources": requirements,
            // Root so `init-agent` can switch to the agent's user; the
            // capabilities are what it uses for that switch and the home
            // handover, as the Docker driver grants them. The root
            // filesystem stays writable: the image is user-authored.
            "securityContext": {
                "runAsUser": 0,
                "runAsGroup": 0,
                "runAsNonRoot": false,
                "privileged": false,
                "allowPrivilegeEscalation": false,
                "readOnlyRootFilesystem": false,
                "capabilities": {
                    "drop": ["ALL"],
                    "add": ["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER"],
                },
            },
            "volumeMounts": [
                { "name": BUNDLE_VOLUME, "mountPath": INJECTION_TARGET, "readOnly": true },
                { "name": WORKSPACE_VOLUME, "mountPath": WORKSPACE_TARGET },
                { "name": TMP_VOLUME, "mountPath": TMP_TARGET },
            ],
        }],
        "volumes": [
            { "name": BUNDLE_VOLUME, "emptyDir": {} },
            { "name": WORKSPACE_VOLUME, "emptyDir": { "sizeLimit": format!("{}Mi", size.volume_mib) } },
            { "name": TMP_VOLUME, "emptyDir": { "medium": "Memory" } },
        ],
    });
    if let Some(class) = context.runtime_class {
        spec["runtimeClassName"] = json!(class);
    }
    if !settings.node_selector.is_empty() {
        spec["nodeSelector"] = json!(settings.node_selector);
    }
    if let Some(account) = &settings.service_account_name {
        spec["serviceAccountName"] = json!(account);
    }
    if !context.pull_secrets.is_empty() {
        spec["imagePullSecrets"] = Value::Array(
            context
                .pull_secrets
                .iter()
                .map(|name| json!({ "name": name }))
                .collect(),
        );
    }
    let manifest = json!({
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": request.name,
            "namespace": settings.namespace,
            "labels": selectable,
            "annotations": {
                LABELS_ANNOTATION: encode_labels_annotation(&request.labels),
                BUNDLE_RELEASE_ANNOTATION: request.bundle_release_tag,
            },
        },
        "spec": spec,
    });
    serde_json::from_value(manifest).map_err(|error| format!("pod manifest is invalid: {error}"))
}

/// The reference that makes a policy part of its instance's Pod.
pub fn owner_reference(pod_name: &str, uid: &str) -> OwnerReference {
    OwnerReference {
        api_version: "v1".to_string(),
        kind: "Pod".to_string(),
        name: pod_name.to_string(),
        uid: uid.to_string(),
        controller: Some(true),
        block_owner_deletion: None,
    }
}

/// The policy one instance gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EgressPolicy {
    /// Nothing is written (`egress: none`).
    None,
    /// NetworkPolicy denying all ingress and egress.
    DenyAll,
    /// NetworkPolicy denying ingress and allowing all egress except the
    /// metadata ranges.
    AllButMetadata,
    /// CiliumNetworkPolicy allowing DNS and the allowlisted hostnames only.
    CiliumAllowlist,
}

/// Which policy `plan` gets under `mode`.
pub fn egress_policy(plan: &EgressPlan, mode: KubernetesEgressMode) -> EgressPolicy {
    match (mode, plan.tier) {
        (KubernetesEgressMode::None, _) => EgressPolicy::None,
        (_, EgressTier::Off) => EgressPolicy::DenyAll,
        (KubernetesEgressMode::Cilium, EgressTier::Allowlist) => EgressPolicy::CiliumAllowlist,
        (_, EgressTier::Allowlist | EgressTier::On) => EgressPolicy::AllButMetadata,
    }
}

/// Whether `mode` enforces `tier`. `on` needs nothing to enforce.
pub fn egress_enforced_by(mode: KubernetesEgressMode, tier: EgressTier) -> bool {
    match tier {
        EgressTier::Off => mode != KubernetesEgressMode::None,
        EgressTier::Allowlist => mode == KubernetesEgressMode::Cilium,
        EgressTier::On => true,
    }
}

fn policy_metadata(
    name: &str,
    namespace: &str,
    deployment_selector: &str,
    owner: &OwnerReference,
) -> Value {
    json!({
        "name": name,
        "namespace": namespace,
        "labels": {
            OWNER_LABEL: OWNER_VALUE,
            DEPLOYMENT_SELECTOR_LABEL: deployment_selector,
            INSTANCE_SELECTOR_LABEL: name,
        },
        "ownerReferences": [owner],
    })
}

/// The NetworkPolicy for [`EgressPolicy::DenyAll`] or
/// [`EgressPolicy::AllButMetadata`], named and selecting `name`.
pub fn network_policy(
    name: &str,
    namespace: &str,
    deployment_selector: &str,
    owner: &OwnerReference,
    policy: EgressPolicy,
) -> Result<NetworkPolicy, String> {
    let mut spec = json!({
        "podSelector": { "matchLabels": { INSTANCE_SELECTOR_LABEL: name } },
        // Ingress is denied for every tier: exec reaches the instance through
        // the kubelet, and port tunnels ride exec.
        "policyTypes": ["Ingress", "Egress"],
    });
    match policy {
        EgressPolicy::DenyAll => {}
        EgressPolicy::AllButMetadata => {
            spec["egress"] = json!([{
                "to": [
                    { "ipBlock": { "cidr": "0.0.0.0/0", "except": metadata_cidrs(false) } },
                    { "ipBlock": { "cidr": "::/0", "except": metadata_cidrs(true) } },
                    // Some CNIs (Cilium among them) do not match cluster
                    // endpoints by ipBlock; without this peer the instance
                    // could not even reach cluster DNS.
                    { "namespaceSelector": {} },
                ],
            }]);
        }
        EgressPolicy::None | EgressPolicy::CiliumAllowlist => {
            return Err(format!("{policy:?} is not a NetworkPolicy"));
        }
    }
    serde_json::from_value(json!({
        "apiVersion": "networking.k8s.io/v1",
        "kind": "NetworkPolicy",
        "metadata": policy_metadata(name, namespace, deployment_selector, owner),
        "spec": spec,
    }))
    .map_err(|error| format!("network policy is invalid: {error}"))
}

/// The `cilium.io/v2` `CiliumNetworkPolicy` resource.
pub fn cilium_resource() -> ApiResource {
    ApiResource {
        group: "cilium.io".to_string(),
        version: "v2".to_string(),
        api_version: "cilium.io/v2".to_string(),
        kind: "CiliumNetworkPolicy".to_string(),
        plural: "ciliumnetworkpolicies".to_string(),
    }
}

/// `example.com` or `*.example.com`, lowercase.
fn allowlist_selector(domain: &str) -> Result<Value, String> {
    let (wildcard, host) = match domain.strip_prefix("*.") {
        Some(host) => (true, host),
        None => (false, domain),
    };
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        });
    if !valid {
        return Err(format!(
            "allowlist entry {domain:?} is not a lowercase hostname or *.hostname"
        ));
    }
    // Cilium's `*` matches within one DNS label, so `*.example.com` admits
    // `a.example.com` but not `a.b.example.com`: never wider than asked.
    Ok(if wildcard {
        json!({ "matchPattern": domain })
    } else {
        json!({ "matchName": domain })
    })
}

/// The CiliumNetworkPolicy for [`EgressPolicy::CiliumAllowlist`]: DNS to
/// kube-dns (so the FQDN rules learn addresses), the allowlisted hostnames
/// on 80/443, an explicit deny of the metadata ranges, and nothing else in
/// either direction.
pub fn cilium_policy(
    name: &str,
    namespace: &str,
    deployment_selector: &str,
    owner: &OwnerReference,
    domains: &[String],
) -> Result<DynamicObject, String> {
    let fqdns = domains
        .iter()
        .map(|domain| allowlist_selector(domain))
        .collect::<Result<Vec<_>, _>>()?;
    let mut egress = vec![json!({
        "toEndpoints": [{
            "matchLabels": {
                "k8s:io.kubernetes.pod.namespace": "kube-system",
                "k8s:k8s-app": "kube-dns",
            },
        }],
        "toPorts": [{
            "ports": [
                { "port": "53", "protocol": "UDP" },
                { "port": "53", "protocol": "TCP" },
            ],
            "rules": { "dns": [{ "matchPattern": "*" }] },
        }],
    })];
    if !fqdns.is_empty() {
        egress.push(json!({
            "toFQDNs": fqdns,
            "toPorts": [{
                "ports": [
                    { "port": "80", "protocol": "TCP" },
                    { "port": "443", "protocol": "TCP" },
                ],
            }],
        }));
    }
    let metadata_cidrs: Vec<&str> = cognia_net::egress::METADATA_CIDRS.to_vec();
    let mut object = DynamicObject::new(name, &cilium_resource()).within(namespace);
    object.metadata =
        serde_json::from_value(policy_metadata(name, namespace, deployment_selector, owner))
            .map_err(|error| format!("cilium policy metadata is invalid: {error}"))?;
    object.data = json!({
        "spec": {
            "endpointSelector": { "matchLabels": { INSTANCE_SELECTOR_LABEL: name } },
            // An empty ingress rule turns on default deny with nothing allowed.
            "ingress": [{}],
            "egress": egress,
            "egressDeny": [{ "toCIDR": metadata_cidrs }],
        },
    });
    Ok(object)
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/// What one read of a starting Pod says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PodProgress {
    /// Still starting; the reason is the most specific one seen.
    Waiting(String),
    /// Running, with the `sandbox` container running.
    Ready,
    /// It will not start.
    Failed(SandboxSpawnError),
}

fn with_detail(base: String, reason: Option<&str>, message: Option<&str>) -> String {
    let mut text = base;
    if let Some(reason) = reason.filter(|reason| !reason.is_empty()) {
        text.push_str(&format!(" ({reason})"));
    }
    if let Some(message) = message.filter(|message| !message.is_empty()) {
        text.push_str(&format!(": {message}"));
    }
    text
}

/// Classify one read of a Pod provisioning is waiting for.
pub fn classify_pod(pod: &Pod) -> PodProgress {
    let name = pod.metadata.name.as_deref().unwrap_or("<unnamed>");
    let Some(status) = pod.status.as_ref() else {
        return PodProgress::Waiting("Pending".into());
    };
    for container in status.init_container_statuses.iter().flatten() {
        let Some(state) = &container.state else {
            continue;
        };
        if let Some(waiting) = &state.waiting {
            let reason = waiting.reason.as_deref().unwrap_or("");
            if IMAGE_PULL_REASONS.contains(&reason) {
                return PodProgress::Failed(SandboxSpawnError::refused(
                    "sandbox_bundle_unavailable",
                    with_detail(
                        format!("the agent bundle image could not be pulled for {name}"),
                        Some(reason),
                        waiting.message.as_deref(),
                    ),
                ));
            }
            if reason == "CreateContainerConfigError" {
                return PodProgress::Failed(SandboxSpawnError::fault(
                    "sandbox_provider_rejected",
                    with_detail(
                        format!(
                            "the cluster refused bundle container {} of {name}",
                            container.name
                        ),
                        Some(reason),
                        waiting.message.as_deref(),
                    ),
                ));
            }
        }
        if let Some(terminated) = &state.terminated {
            if terminated.exit_code != 0 {
                return PodProgress::Failed(SandboxSpawnError::refused(
                    "sandbox_bundle_unsupported",
                    with_detail(
                        format!(
                            "bundle staging step {} of {name} exited {}",
                            container.name, terminated.exit_code
                        ),
                        terminated.reason.as_deref(),
                        terminated.message.as_deref(),
                    ),
                ));
            }
        }
    }
    let sandbox = status
        .container_statuses
        .iter()
        .flatten()
        .find(|container| container.name == SANDBOX_CONTAINER);
    if let Some(state) = sandbox.and_then(|container| container.state.as_ref()) {
        if let Some(waiting) = &state.waiting {
            let reason = waiting.reason.as_deref().unwrap_or("");
            if IMAGE_PULL_REASONS.contains(&reason) {
                return PodProgress::Failed(SandboxSpawnError::refused(
                    "sandbox_image_unavailable",
                    with_detail(
                        format!("the environment image could not be pulled for {name}"),
                        Some(reason),
                        waiting.message.as_deref(),
                    ),
                ));
            }
            match reason {
                "CreateContainerConfigError" => {
                    return PodProgress::Failed(SandboxSpawnError::fault(
                        "sandbox_provider_rejected",
                        with_detail(
                            format!("the cluster refused the sandbox container of {name}"),
                            Some(reason),
                            waiting.message.as_deref(),
                        ),
                    ))
                }
                "CreateContainerError" | "RunContainerError" => {
                    return PodProgress::Failed(SandboxSpawnError::refused(
                        "sandbox_bundle_unsupported",
                        with_detail(
                            format!("the staged supervisor could not start in {name}"),
                            Some(reason),
                            waiting.message.as_deref(),
                        ),
                    ))
                }
                _ => {}
            }
        }
        if let Some(terminated) = &state.terminated {
            return PodProgress::Failed(SandboxSpawnError::refused(
                "sandbox_bundle_unsupported",
                with_detail(
                    format!(
                        "the sandbox container of {name} exited {} before the supervisor was \
                         released (a bundle without `await-start` exits at once)",
                        terminated.exit_code
                    ),
                    terminated.reason.as_deref(),
                    terminated.message.as_deref(),
                ),
            ));
        }
        if state.running.is_some() && status.phase.as_deref() == Some("Running") {
            return PodProgress::Ready;
        }
    }
    match status.phase.as_deref() {
        Some("Failed") | Some("Succeeded") => {
            let reason = status.reason.as_deref();
            let capacity = matches!(
                reason,
                Some("Evicted") | Some("OutOfcpu") | Some("OutOfmemory")
            );
            let text = with_detail(
                format!("pod {name} stopped while starting"),
                reason,
                status.message.as_deref(),
            );
            return PodProgress::Failed(if capacity {
                SandboxSpawnError::fault("sandbox_provider_capacity", text)
            } else {
                SandboxSpawnError::refused("sandbox_bundle_unsupported", text)
            });
        }
        _ => {}
    }
    let unschedulable = status.conditions.iter().flatten().find(|condition| {
        condition.type_ == "PodScheduled"
            && condition.status == "False"
            && condition.reason.as_deref() == Some("Unschedulable")
    });
    if let Some(condition) = unschedulable {
        return PodProgress::Waiting(with_detail(
            "Unschedulable".into(),
            None,
            condition.message.as_deref(),
        ));
    }
    let waiting = status
        .init_container_statuses
        .iter()
        .flatten()
        .chain(sandbox)
        .filter_map(|container| container.state.as_ref()?.waiting.as_ref())
        .find_map(|waiting| waiting.reason.clone());
    PodProgress::Waiting(
        waiting.unwrap_or_else(|| status.phase.clone().unwrap_or_else(|| "Pending".into())),
    )
}

/// The fault for a Pod that did not run within the timeout, from the last
/// thing it was waiting on.
pub fn ready_timeout_error(name: &str, timeout: Duration, last: &str) -> SandboxSpawnError {
    let text = format!(
        "pod {name} was not running within {}s (last state: {last})",
        timeout.as_secs()
    );
    if last.starts_with("Unschedulable") {
        SandboxSpawnError::fault("sandbox_provider_capacity", text)
    } else {
        SandboxSpawnError::fault("sandbox_provider_unreachable", text)
    }
}

/// Leading digits of a version component (`"30+"` on some managed clusters).
fn leading_number(text: &str) -> Option<u32> {
    let digits: String = text.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// Refuse an API server older than [`MIN_SERVER_MINOR`]. `major`/`minor`
/// come from `/version`; `git_version` (`v1.30.2-gke.1`) is the fallback for
/// distributions that leave the components non-numeric.
pub fn check_server_version(
    major: &str,
    minor: &str,
    git_version: &str,
) -> Result<(), SandboxSpawnError> {
    let parsed = match (leading_number(major), leading_number(minor)) {
        (Some(major), Some(minor)) => Some((major, minor)),
        _ => {
            let mut parts = git_version.trim_start_matches('v').split('.');
            match (
                parts.next().and_then(leading_number),
                parts.next().and_then(leading_number),
            ) {
                (Some(major), Some(minor)) => Some((major, minor)),
                _ => None,
            }
        }
    };
    match parsed {
        Some((major, minor)) if major > 1 || (major == 1 && minor >= MIN_SERVER_MINOR) => Ok(()),
        Some((major, minor)) => Err(SandboxSpawnError::fault(
            "sandbox_provider_rejected",
            format!(
                "the cluster runs Kubernetes {major}.{minor}; remote sandboxes need 1.{MIN_SERVER_MINOR} \
                 or newer (pod exec must be able to close stdin)"
            ),
        )),
        None => Err(SandboxSpawnError::fault(
            "sandbox_provider_rejected",
            format!(
                "the cluster reports an unreadable Kubernetes version ({major}.{minor}, {git_version})"
            ),
        )),
    }
}

/// Classify a failed API call made while provisioning.
pub fn api_error(context: &str, error: &kube::Error) -> SandboxSpawnError {
    match error {
        kube::Error::Api(status) => {
            let text = format!(
                "{context}: {} (HTTP {}{})",
                status.message,
                status.code,
                if status.reason.is_empty() {
                    String::new()
                } else {
                    format!(", {}", status.reason)
                }
            );
            if status.code == 403 && status.message.contains("exceeded quota") {
                SandboxSpawnError::fault("sandbox_provider_capacity", text)
            } else if status.code >= 500 || status.code == 429 || status.code == 0 {
                SandboxSpawnError::fault("sandbox_provider_unreachable", text)
            } else {
                SandboxSpawnError::fault("sandbox_provider_rejected", text)
            }
        }
        other => SandboxSpawnError::fault(
            "sandbox_provider_unreachable",
            format!("{context}: {other}"),
        ),
    }
}

fn is_not_found(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(status) if status.code == 404)
}

fn is_conflict(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(status) if status.code == 409)
}

/// The exit code a pod exec's final status reports: `Success` is 0, a
/// `NonZeroExitCode` failure carries it in its `ExitCode` cause, anything
/// else (a lost stream, a runtime error) is unknown.
pub fn exit_code(status: Option<&Status>) -> Option<i64> {
    let status = status?;
    match status.status.as_deref() {
        Some("Success") => Some(0),
        Some("Failure") if status.reason.as_deref() == Some("NonZeroExitCode") => status
            .details
            .as_ref()?
            .causes
            .as_ref()?
            .iter()
            .find(|cause| cause.reason.as_deref() == Some("ExitCode"))?
            .message
            .as_deref()?
            .trim()
            .parse()
            .ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Exec plumbing
// ---------------------------------------------------------------------------

/// The argv and stdin prefix of one exec: `exec-env` around the command, and
/// the frame carrying its environment and working directory.
pub fn exec_invocation(spec: &RunnerExecSpec) -> Result<(Vec<String>, Vec<u8>), String> {
    if spec.command.is_empty() {
        return Err("exec needs a command".into());
    }
    let frame = encode_frame(&ExecEnvFrame {
        env: spec
            .env
            .iter()
            .cloned()
            .chain(
                spec.workspace_env
                    .iter()
                    .map(|(key, value)| format!("{key}={value}")),
            )
            .collect(),
        cwd: Some(spec.working_dir.clone()).filter(|dir| !dir.is_empty()),
    })
    .map_err(|error| format!("exec environment is invalid: {error}"))?;
    let mut argv = vec![
        SANDBOXD.to_string(),
        "exec-env".to_string(),
        "--".to_string(),
    ];
    argv.extend(spec.command.iter().cloned());
    Ok((argv, frame))
}

async fn pump_output<R: AsyncRead + Unpin>(
    mut reader: R,
    events: mpsc::Sender<RunnerEvent>,
    wrap: fn(Vec<u8>) -> RunnerEvent,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let read = tokio::select! {
            _ = events.closed() => return,
            read = reader.read(&mut buf) => read,
        };
        match read {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if events.send(wrap(buf[..n].to_vec())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Connect the streams of one exec to a [`RunningRunner`]: the frame first
/// and then the caller's stdin (closed when the caller drops its sender),
/// stdout and stderr as events through a bounded queue, and the exit status
/// as the final event once both output streams have ended. `keep_alive`
/// holds whatever owns the connection until then.
pub fn spawn_exec_pumps<W, O, E, S, K>(
    container_id: String,
    frame: Vec<u8>,
    mut stdin_writer: W,
    stdout: O,
    stderr: E,
    status: S,
    keep_alive: K,
) -> RunningRunner
where
    W: AsyncWrite + Unpin + Send + 'static,
    O: AsyncRead + Unpin + Send + 'static,
    E: AsyncRead + Unpin + Send + 'static,
    S: Future<Output = Option<Status>> + Send + 'static,
    K: Send + 'static,
{
    let (event_tx, event_rx) = mpsc::channel::<RunnerEvent>(EXEC_EVENT_QUEUE);
    let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(EXEC_STDIN_QUEUE);
    let input = tokio::spawn(async move {
        if stdin_writer.write_all(&frame).await.is_err() || stdin_writer.flush().await.is_err() {
            return;
        }
        while let Some(bytes) = stdin_rx.recv().await {
            if stdin_writer.write_all(&bytes).await.is_err() {
                return;
            }
            if stdin_writer.flush().await.is_err() {
                return;
            }
        }
        // The caller dropped its sender: end the remote stdin.
        let _ = stdin_writer.shutdown().await;
    });
    tokio::spawn(async move {
        tokio::join!(
            pump_output(stdout, event_tx.clone(), RunnerEvent::Stdout),
            pump_output(stderr, event_tx.clone(), RunnerEvent::Stderr),
        );
        input.abort();
        let code = if event_tx.is_closed() {
            None
        } else {
            exit_code(status.await.as_ref())
        };
        let _ = event_tx.send(RunnerEvent::Exited { code }).await;
        drop(keep_alive);
    });
    RunningRunner {
        container_id,
        events: event_rx.into(),
        stdin: stdin_tx.into(),
    }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/// Deletes a Pod whose provisioning was abandoned (the future dropped)
/// before it was handed to the driver.
struct PodCleanup {
    pods: Option<Api<Pod>>,
    name: String,
}

impl PodCleanup {
    fn disarm(mut self) {
        self.pods = None;
    }
}

impl Drop for PodCleanup {
    fn drop(&mut self) {
        let Some(pods) = self.pods.take() else {
            return;
        };
        let name = std::mem::take(&mut self.name);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    if let Err(error) = delete_pod(&pods, &name, Some(0)).await {
                        log::warn!("kubernetes: cleanup of abandoned instance {name} failed: {error}");
                    }
                });
            }
            Err(_) => log::warn!(
                "kubernetes: instance {name} was abandoned outside a runtime; its lifetime bounds it"
            ),
        }
    }
}

async fn delete_pod(pods: &Api<Pod>, name: &str, grace: Option<i64>) -> Result<(), String> {
    let params = DeleteParams {
        grace_period_seconds: grace.map(|grace| grace.clamp(0, u32::MAX as i64) as u32),
        ..DeleteParams::default()
    };
    match tokio::time::timeout(API_TIMEOUT, pods.delete(name, &params)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) if is_not_found(&error) => Ok(()),
        Ok(Err(error)) => Err(format!("deleting pod {name} failed: {error}")),
        Err(_) => Err(format!("deleting pod {name} timed out")),
    }
}

/// Where the client comes from. Holds the parsed kubeconfig, which carries
/// credentials: never `Debug`-printed or logged.
enum ClientSource {
    InCluster,
    Kubeconfig {
        kubeconfig: Box<kube::config::Kubeconfig>,
        context: Option<String>,
    },
    /// A client handed in whole (tests).
    #[cfg(test)]
    Provided,
}

/// Build the client. No network I/O happens here either: kube connects on
/// the first request. An in-cluster Host reads its service account files.
async fn build_client(source: &ClientSource) -> Result<kube::Client, String> {
    let config = match source {
        ClientSource::InCluster => kube::Config::incluster()
            .map_err(|error| format!("in-cluster configuration is unavailable: {error}"))?,
        ClientSource::Kubeconfig {
            kubeconfig,
            context,
        } => {
            let options = kube::config::KubeConfigOptions {
                context: context.clone(),
                cluster: None,
                user: None,
            };
            kube::Config::from_custom_kubeconfig((**kubeconfig).clone(), &options)
                .await
                .map_err(|error| format!("the kubeconfig cannot be used: {error}"))?
        }
        #[cfg(test)]
        ClientSource::Provided => return Err("the provided client is missing".into()),
    };
    kube::Client::try_from(config)
        .map_err(|error| format!("kubernetes client initialisation failed: {error}"))
}

/// Parse and check a kubeconfig without using it. The parser's message can
/// quote the document, which holds credentials, so only the fact of the
/// failure is reported.
fn parse_kubeconfig(yaml: &str, context: Option<&str>) -> Result<kube::config::Kubeconfig, String> {
    let parsed = kube::config::Kubeconfig::from_yaml(yaml)
        .map_err(|_| "the kubeconfig is not a valid kubeconfig document".to_string())?;
    match context {
        Some(context) => {
            if !parsed.contexts.iter().any(|named| named.name == context) {
                return Err(format!("the kubeconfig has no context named {context:?}"));
            }
        }
        None => {
            if parsed.current_context.as_deref().is_none_or(str::is_empty) {
                return Err(
                    "the kubeconfig names no current context; set `context` in the settings".into(),
                );
            }
        }
    }
    Ok(parsed)
}

/// The typed APIs of one client in the configured namespace.
#[derive(Clone)]
struct Apis {
    client: kube::Client,
    namespace: String,
}

impl Apis {
    fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    fn secrets(&self) -> Api<Secret> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    fn network_policies(&self) -> Api<NetworkPolicy> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    fn cilium_policies(&self) -> Api<DynamicObject> {
        Api::namespaced_with(self.client.clone(), &self.namespace, &cilium_resource())
    }

    fn runtime_classes(&self) -> Api<RuntimeClass> {
        Api::all(self.client.clone())
    }
}

/// A Kubernetes cluster as a remote sandbox provider.
///
/// Constructed synchronously ([`KubernetesProvider::new`]); the client is
/// built on first use and a failed build is retried by the next call rather
/// than remembered, so a Host that boots before its cluster is reachable
/// recovers on its own.
pub struct KubernetesProvider {
    source: ClientSource,
    client: tokio::sync::OnceCell<kube::Client>,
    settings: KubernetesSettings,
    deployment_selector: String,
    poll_interval: Duration,
}

impl std::fmt::Debug for KubernetesProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KubernetesProvider")
            .field("settings", &self.settings)
            .field("deployment_selector", &self.deployment_selector)
            .field("client_ready", &self.client.initialized())
            .finish_non_exhaustive()
    }
}

impl KubernetesProvider {
    /// Validate and store everything the provider needs, synchronously and
    /// without network I/O. `kubeconfig`: the YAML content when `connection`
    /// is `kubeconfig` (resolved by the Host from its secret store / file;
    /// never logged); it is parsed and its context checked here.
    pub fn new(
        settings: KubernetesSettings,
        kubeconfig: Option<String>,
        deployment_id: &str,
    ) -> Result<Arc<Self>, String> {
        Self::validate(&settings)?;
        let deployment_id = validate_deployment_id(deployment_id)?;
        let source = match settings.connection {
            KubernetesConnection::InCluster => {
                if kubeconfig.is_some() {
                    return Err(
                        "a kubeconfig was supplied, but the provider connects in-cluster".into(),
                    );
                }
                ClientSource::InCluster
            }
            KubernetesConnection::Kubeconfig => {
                let yaml = kubeconfig
                    .filter(|yaml| !yaml.trim().is_empty())
                    .ok_or("the provider connects with a kubeconfig, and none was supplied")?;
                ClientSource::Kubeconfig {
                    kubeconfig: Box::new(parse_kubeconfig(&yaml, settings.context.as_deref())?),
                    context: settings.context.clone(),
                }
            }
        };
        Ok(Arc::new(Self {
            source,
            client: tokio::sync::OnceCell::new(),
            deployment_selector: deployment_selector(&deployment_id),
            settings,
            poll_interval: DEFAULT_POLL_INTERVAL,
        }))
    }

    /// [`KubernetesProvider::new`], then build the client now so a bad
    /// configuration is reported here rather than on first use.
    pub async fn connect(
        settings: KubernetesSettings,
        kubeconfig: Option<String>,
        deployment_id: &str,
    ) -> Result<Arc<Self>, String> {
        let provider = Self::new(settings, kubeconfig, deployment_id)?;
        provider.apis().await?;
        Ok(provider)
    }

    /// Pure validation, also used by the settings UI test path.
    pub fn validate(settings: &KubernetesSettings) -> Result<(), String> {
        validate_settings(settings)
    }

    #[cfg(test)]
    fn from_client(
        client: kube::Client,
        settings: KubernetesSettings,
        deployment_id: &str,
        poll_interval: Duration,
    ) -> Self {
        Self {
            source: ClientSource::Provided,
            client: tokio::sync::OnceCell::new_with(Some(client)),
            deployment_selector: deployment_selector(deployment_id),
            settings,
            poll_interval,
        }
    }

    /// The APIs, building the client on first use.
    async fn apis(&self) -> Result<Apis, String> {
        let client = self
            .client
            .get_or_try_init(|| build_client(&self.source))
            .await?
            .clone();
        Ok(Apis {
            client,
            namespace: self.settings.namespace.clone(),
        })
    }

    /// [`Self::apis`] for the provisioning surface: a client that cannot be
    /// built is the provider being unavailable.
    async fn apis_or_fault(&self) -> Result<Apis, SandboxSpawnError> {
        self.apis().await.map_err(|error| {
            SandboxSpawnError::fault(
                "sandbox_provider_unreachable",
                format!("the Kubernetes client is unavailable: {error}"),
            )
        })
    }

    fn owner_selector(&self) -> String {
        format!(
            "{OWNER_LABEL}={OWNER_VALUE},{DEPLOYMENT_SELECTOR_LABEL}={}",
            self.deployment_selector
        )
    }

    /// One API call, bounded by [`API_TIMEOUT`] and classified on failure.
    async fn call<T>(
        &self,
        context: &str,
        call: impl Future<Output = Result<T, kube::Error>>,
    ) -> Result<T, SandboxSpawnError> {
        match tokio::time::timeout(API_TIMEOUT, call).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(api_error(context, &error)),
            Err(_) => Err(SandboxSpawnError::fault(
                "sandbox_provider_unreachable",
                format!(
                    "{context}: the API server did not answer within {}s",
                    API_TIMEOUT.as_secs()
                ),
            )),
        }
    }

    /// The same bound for the container-surface calls, which answer strings.
    async fn call_plain<T>(
        &self,
        context: &str,
        call: impl Future<Output = Result<T, kube::Error>>,
    ) -> Result<T, String> {
        match tokio::time::timeout(API_TIMEOUT, call).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(format!("{context}: {error}")),
            Err(_) => Err(format!(
                "{context}: the API server did not answer within {}s",
                API_TIMEOUT.as_secs()
            )),
        }
    }

    async fn ensure_pull_secrets(
        &self,
        apis: &Apis,
        request: &ProvisionRequest,
    ) -> Result<Vec<String>, SandboxSpawnError> {
        let mut names = Vec::new();
        for (what, auth) in [
            ("image", request.registry_auth.as_ref()),
            ("bundle", request.bundle_registry_auth.as_ref()),
        ] {
            let Some(auth) = auth else {
                continue;
            };
            let secret = pull_secret(auth, &self.settings.namespace, &self.deployment_selector)
                .map_err(|error| {
                    SandboxSpawnError::refused(
                        if what == "image" {
                            "sandbox_image_unavailable"
                        } else {
                            "sandbox_bundle_unavailable"
                        },
                        error,
                    )
                })?;
            let name = secret
                .metadata
                .name
                .clone()
                .expect("pull_secret always names the secret");
            if names.contains(&name) {
                continue;
            }
            self.call(
                &format!("writing pull secret {name}"),
                apis.secrets().patch(
                    &name,
                    &PatchParams::apply(FIELD_MANAGER).force(),
                    &Patch::Apply(&secret),
                ),
            )
            .await?;
            names.push(name);
        }
        Ok(names)
    }

    async fn apply_egress_policy(
        &self,
        apis: &Apis,
        name: &str,
        uid: &str,
        plan: &EgressPlan,
    ) -> Result<(), SandboxSpawnError> {
        let owner = owner_reference(name, uid);
        let namespace = &self.settings.namespace;
        match egress_policy(plan, self.settings.egress) {
            EgressPolicy::None => Ok(()),
            policy @ (EgressPolicy::DenyAll | EgressPolicy::AllButMetadata) => {
                let manifest =
                    network_policy(name, namespace, &self.deployment_selector, &owner, policy)
                        .map_err(|error| {
                            SandboxSpawnError::refused("sandbox_egress_unenforceable", error)
                        })?;
                self.call(
                    &format!("writing network policy {name}"),
                    apis.network_policies().patch(
                        name,
                        &PatchParams::apply(FIELD_MANAGER).force(),
                        &Patch::Apply(&manifest),
                    ),
                )
                .await
                .map(|_| ())
            }
            EgressPolicy::CiliumAllowlist => {
                let manifest = cilium_policy(
                    name,
                    namespace,
                    &self.deployment_selector,
                    &owner,
                    &plan.domains,
                )
                .map_err(|error| {
                    SandboxSpawnError::refused("sandbox_egress_unenforceable", error)
                })?;
                self.call(
                    &format!("writing Cilium network policy {name}"),
                    apis.cilium_policies().patch(
                        name,
                        &PatchParams::apply(FIELD_MANAGER).force(),
                        &Patch::Apply(&manifest),
                    ),
                )
                .await
                .map(|_| ())
            }
        }
    }

    async fn wait_ready(&self, apis: &Apis, name: &str) -> Result<(), SandboxSpawnError> {
        let timeout = Duration::from_secs(self.settings.pod_ready_timeout_secs);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let pod = self
                .call(&format!("reading pod {name}"), apis.pods().get_opt(name))
                .await?;
            let Some(pod) = pod else {
                return Err(SandboxSpawnError::fault(
                    "sandbox_provider_capacity",
                    format!("pod {name} was deleted while starting (evicted or removed)"),
                ));
            };
            let last = match classify_pod(&pod) {
                PodProgress::Ready => return Ok(()),
                PodProgress::Failed(error) => return Err(error),
                PodProgress::Waiting(reason) => reason,
            };
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(ready_timeout_error(name, timeout, &last));
            }
            tokio::time::sleep(self.poll_interval.min(deadline - now)).await;
        }
    }

    async fn delete_policies(&self, apis: &Apis, name: &str) {
        let params = DeleteParams::default();
        let network =
            tokio::time::timeout(API_TIMEOUT, apis.network_policies().delete(name, &params)).await;
        if let Ok(Err(error)) = network {
            if !is_not_found(&error) {
                log::warn!("kubernetes: deleting network policy {name} failed: {error}");
            }
        }
        if self.settings.egress == KubernetesEgressMode::Cilium {
            let cilium =
                tokio::time::timeout(API_TIMEOUT, apis.cilium_policies().delete(name, &params))
                    .await;
            if let Ok(Err(error)) = cilium {
                if !is_not_found(&error) {
                    log::warn!("kubernetes: deleting Cilium policy {name} failed: {error}");
                }
            }
        }
    }

    /// Run one command to completion and collect its exit code and stderr.
    async fn exec_status(
        &self,
        instance: &str,
        command: Vec<String>,
    ) -> Result<(Option<i64>, String), String> {
        let mut running = self
            .exec_runtime(RunnerExecSpec {
                workspace_env: BTreeMap::new(),
                container_id: instance.to_string(),
                command,
                env: Vec::new(),
                working_dir: "/".to_string(),
            })
            .await?;
        drop(running.stdin);
        let mut stderr = Vec::new();
        while let Some(event) = running.events.recv().await {
            match event {
                RunnerEvent::Stdout(_) => {}
                RunnerEvent::Stderr(bytes) => {
                    stderr.extend_from_slice(&bytes);
                    if stderr.len() > 4096 {
                        stderr.drain(..stderr.len() - 4096);
                    }
                }
                RunnerEvent::Exited { code } => {
                    return Ok((code, String::from_utf8_lossy(&stderr).trim().to_string()))
                }
            }
        }
        Err("the exec stream ended without an exit status".into())
    }
}

#[async_trait]
impl RemoteProvisioner for KubernetesProvider {
    fn kind(&self) -> &'static str {
        KIND
    }

    async fn tiers(&self) -> Result<Vec<IsolationTier>, SandboxSpawnError> {
        let apis = self.apis_or_fault().await?;
        let version = self
            .call(
                "reading the API server version",
                apis.client.apiserver_version(),
            )
            .await?;
        check_server_version(&version.major, &version.minor, &version.git_version)?;
        // Reachability and access to the namespace next: an answer about
        // tiers from a cluster this Host cannot use would be a lie.
        self.call(
            &format!("listing pods in {}", self.settings.namespace),
            apis.pods().list(&ListParams::default().limit(1)),
        )
        .await?;
        let classes = apis.runtime_classes();
        let mut tiers = Vec::new();
        for (tier, class) in [
            (
                IsolationTier::Container,
                &self.settings.runtime_classes.container,
            ),
            (IsolationTier::Gvisor, &self.settings.runtime_classes.gvisor),
            (IsolationTier::Vm, &self.settings.runtime_classes.vm),
        ] {
            let present = match class {
                // Only `container` runs without a mapping.
                None => tier == IsolationTier::Container,
                Some(class) => self
                    .call(
                        &format!("reading RuntimeClass {class}"),
                        classes.get_opt(class),
                    )
                    .await?
                    .is_some(),
            };
            if present {
                tiers.push(tier);
            }
        }
        Ok(tiers)
    }

    fn egress_enforced(&self, tier: EgressTier) -> bool {
        egress_enforced_by(self.settings.egress, tier)
    }

    fn may_receive_registry_credentials(&self, _registry: &str) -> bool {
        // The operator's own cluster: its pull secrets already live there.
        true
    }

    async fn provision(&self, request: &ProvisionRequest) -> Result<String, SandboxSpawnError> {
        let runtime_class = runtime_class_for(request.tier, &self.settings)?;
        let apis = self.apis_or_fault().await?;
        let pull_secrets = self.ensure_pull_secrets(&apis, request).await?;
        let pod = pod_manifest(
            request,
            &self.settings,
            &PodContext {
                deployment_selector: &self.deployment_selector,
                runtime_class: runtime_class.as_deref(),
                pull_secrets: &pull_secrets,
            },
        )
        .map_err(|error| SandboxSpawnError::refused("sandbox_runtime_config_invalid", error))?;
        let name = request.name.clone();
        let pods = apis.pods();
        let created = match tokio::time::timeout(
            API_TIMEOUT,
            pods.create(&PostParams::default(), &pod),
        )
        .await
        {
            Ok(Ok(created)) => created,
            // Someone else's instance, or one not yet reaped: never touch it.
            Ok(Err(error)) if is_conflict(&error) => {
                return Err(SandboxSpawnError::fault(
                    "sandbox_provider_rejected",
                    format!(
                        "instance {name} already exists in {}",
                        self.settings.namespace
                    ),
                ))
            }
            Ok(Err(error)) => return Err(api_error(&format!("creating pod {name}"), &error)),
            Err(_) => {
                // The create may still land: make sure it does not outlive us.
                let _ = delete_pod(&pods, &name, Some(0)).await;
                return Err(SandboxSpawnError::fault(
                    "sandbox_provider_unreachable",
                    format!(
                        "creating pod {name}: the API server did not answer within {}s",
                        API_TIMEOUT.as_secs()
                    ),
                ));
            }
        };
        let cleanup = PodCleanup {
            pods: Some(pods.clone()),
            name: name.clone(),
        };
        let prepared = async {
            let uid = created.metadata.uid.clone().ok_or_else(|| {
                SandboxSpawnError::fault(
                    "sandbox_provider_rejected",
                    format!("the API server created pod {name} without a uid"),
                )
            })?;
            self.apply_egress_policy(&apis, &name, &uid, &request.egress)
                .await?;
            self.wait_ready(&apis, &name).await
        }
        .await;
        match prepared {
            Ok(()) => {
                cleanup.disarm();
                Ok(name)
            }
            Err(error) => {
                cleanup.disarm();
                if let Err(cleanup_error) = delete_pod(&pods, &name, Some(0)).await {
                    log::warn!("kubernetes: {cleanup_error}");
                }
                self.delete_policies(&apis, &name).await;
                Err(error)
            }
        }
    }

    async fn release_supervisor(
        &self,
        instance: &str,
        _request: &ProvisionRequest,
    ) -> Result<(), SandboxSpawnError> {
        let command = vec![
            SANDBOXD.to_string(),
            "release-start".to_string(),
            "--marker".to_string(),
            START_MARKER.to_string(),
        ];
        let outcome = tokio::time::timeout(RELEASE_TIMEOUT, self.exec_status(instance, command))
            .await
            .map_err(|_| {
                SandboxSpawnError::fault(
                    "sandbox_provider_unreachable",
                    format!("releasing the supervisor of {instance} timed out"),
                )
            })?
            .map_err(|error| {
                SandboxSpawnError::fault(
                    "sandbox_provider_unreachable",
                    format!("releasing the supervisor of {instance}: {error}"),
                )
            })?;
        match outcome {
            (Some(0), _) => Ok(()),
            (code, stderr) => Err(SandboxSpawnError::refused(
                "sandbox_bundle_unsupported",
                format!(
                    "release-start in {instance} exited {}{}",
                    code.map_or_else(|| "without a status".to_string(), |code| code.to_string()),
                    if stderr.is_empty() {
                        String::new()
                    } else {
                        format!(": {stderr}")
                    }
                ),
            )),
        }
    }
}

#[async_trait]
impl ContainerApi for KubernetesProvider {
    async fn run(&self, _spec: RunnerSpec) -> Result<RunningRunner, RunnerRunError> {
        Err(RunnerRunError::Other(
            "remote providers provision instances; they do not run containers".into(),
        ))
    }

    async fn pull_image(&self, image: &str) -> Result<(), String> {
        Err(format!(
            "a Kubernetes provider does not pull {image} ahead of time; the kubelet pulls \
             while provisioning"
        ))
    }

    async fn kill(&self, container_id: &str) -> Result<(), String> {
        delete_pod(&self.apis().await?.pods(), container_id, Some(0)).await
    }

    async fn remove(&self, container_id: &str) -> Result<(), String> {
        delete_pod(&self.apis().await?.pods(), container_id, Some(0)).await
    }

    async fn labels(&self, container_id: &str) -> Result<Option<BTreeMap<String, String>>, String> {
        let pods = self.apis().await?.pods();
        let pod = self
            .call_plain(
                &format!("reading pod {container_id}"),
                pods.get_opt(container_id),
            )
            .await?;
        pod.map(|pod| decode_labels(&pod.metadata)).transpose()
    }

    async fn list_owned(&self) -> Result<Vec<OwnedContainer>, String> {
        let selector = self.owner_selector();
        let api = self.apis().await?.pods();
        let pods = self
            .call_plain(
                &format!("listing pods in {}", self.settings.namespace),
                api.list(&ListParams::default().labels(&selector)),
            )
            .await?;
        let mut owned = Vec::new();
        for pod in pods.items {
            let Some(id) = pod.metadata.name.clone() else {
                continue;
            };
            match decode_labels(&pod.metadata) {
                Ok(labels) => owned.push(OwnedContainer { id, labels }),
                // One damaged pod must not hide every other one from the
                // reaper; it keeps running until its own deadline.
                Err(error) => log::warn!("kubernetes: skipping {id}: {error}"),
            }
        }
        Ok(owned)
    }
}

#[async_trait]
impl SandboxDockerApi for KubernetesProvider {
    async fn inspect_runtime(&self, id: &str) -> Result<Option<RuntimeContainerState>, String> {
        let pods = self.apis().await?.pods();
        let Some(pod) = self
            .call_plain(&format!("reading pod {id}"), pods.get_opt(id))
            .await?
        else {
            return Ok(None);
        };
        let labels = decode_labels(&pod.metadata)?;
        let running = pod.status.as_ref().is_some_and(|status| {
            status.phase.as_deref() == Some("Running")
                && status.container_statuses.iter().flatten().any(|container| {
                    container.name == SANDBOX_CONTAINER
                        && container
                            .state
                            .as_ref()
                            .is_some_and(|state| state.running.is_some())
                })
        });
        Ok(Some(RuntimeContainerState { running, labels }))
    }

    async fn start_runtime(&self, _id: &str) -> Result<(), String> {
        Err("a Kubernetes pod cannot be restarted; the driver re-provisions".into())
    }

    async fn stop_runtime(&self, id: &str) -> Result<(), String> {
        delete_pod(&self.apis().await?.pods(), id, None).await
    }

    async fn exec_runtime(&self, spec: RunnerExecSpec) -> Result<RunningRunner, String> {
        let (argv, frame) = exec_invocation(&spec)?;
        let pods = self.apis().await?.pods();
        let params = AttachParams::default()
            .container(SANDBOX_CONTAINER)
            .stdin(true)
            .stdout(true)
            .stderr(true)
            .tty(false)
            .max_stdin_buf_size(EXEC_STREAM_BUFFER)
            .max_stdout_buf_size(EXEC_STREAM_BUFFER)
            .max_stderr_buf_size(EXEC_STREAM_BUFFER);
        let mut attached = self
            .call_plain(
                &format!("exec in pod {}", spec.container_id),
                pods.exec(&spec.container_id, argv, &params),
            )
            .await?;
        let stdin = attached
            .stdin()
            .ok_or("pod exec returned no stdin stream")?;
        let stdout = attached
            .stdout()
            .ok_or("pod exec returned no stdout stream")?;
        let stderr = attached
            .stderr()
            .ok_or("pod exec returned no stderr stream")?;
        let status = attached
            .take_status()
            .ok_or("pod exec returned no status channel")?;
        Ok(spawn_exec_pumps(
            spec.container_id,
            frame,
            stdin,
            stdout,
            stderr,
            status,
            attached,
        ))
    }

    async fn runtimes(&self) -> Result<Vec<String>, String> {
        Ok(self
            .settings
            .runtime_class_names()
            .into_iter()
            .map(str::to_string)
            .collect())
    }

    async fn ensure_volume(
        &self,
        name: &str,
        _labels: &BTreeMap<String, String>,
    ) -> Result<(), String> {
        Err(format!(
            "a remote provider has no named volumes (asked for {name}); instances carry their \
             own storage"
        ))
    }

    async fn list_owned_volumes(&self) -> Result<Vec<OwnedVolume>, String> {
        Ok(Vec::new())
    }

    async fn remove_volume(&self, _name: &str) -> Result<VolumeRemoval, String> {
        Ok(VolumeRemoval::Gone)
    }

    async fn pull_image_with_auth(
        &self,
        image: &str,
        _auth: Option<RegistryAuth>,
    ) -> Result<(), String> {
        self.pull_image(image).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, VecDeque};

    use cognia_environment::catalog::SizeClass;
    use cognia_environment::image::PinnedImage;
    use cognia_external_agent::container_backend::{
        is_owned, ownership_labels, AGENT_ID_LABEL, INSTANCE_LABEL,
    };
    use cognia_external_agent::sandbox_routing_backend::SandboxErrorKind;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    use super::*;

    // -- fixtures ------------------------------------------------------------

    const DEPLOYMENT: &str = "deployment-a";
    const NAME: &str = "cognia-deployment-a-0123456789abcdef0123456789abcdef";

    fn digest(c: char) -> String {
        format!("sha256:{}", c.to_string().repeat(64))
    }

    fn settings() -> KubernetesSettings {
        KubernetesSettings {
            connection: KubernetesConnection::InCluster,
            context: None,
            namespace: "sbx".into(),
            runtime_classes: RuntimeClassMap::default(),
            egress: KubernetesEgressMode::NetworkPolicy,
            node_selector: BTreeMap::new(),
            service_account_name: None,
            pod_ready_timeout_secs: 10,
        }
    }

    fn driver_labels() -> BTreeMap<String, String> {
        let mut labels = ownership_labels(
            "agent with spaces/and:colons and a very long identifier that keeps going on",
            "1234-5678901234567890-0",
            DEPLOYMENT,
        );
        labels.insert(PERSISTENT_RUNTIME_LABEL.into(), "1".into());
        labels.insert("cognia.runtime-key".into(), "f".repeat(64));
        labels.insert("cognia.spec-digest".into(), digest('e'));
        labels.insert("cognia.project-id".into(), "Project With Spaces".into());
        labels
    }

    fn size() -> SizeClass {
        SizeClass {
            id: "medium".into(),
            label: "Medium".into(),
            cpu_millis: 2000,
            memory_mib: 4096,
            ephemeral_storage_mib: 10240,
            volume_mib: 20480,
            gpu: None,
        }
    }

    fn request() -> ProvisionRequest {
        ProvisionRequest {
            name: NAME.into(),
            labels: driver_labels(),
            image: PinnedImage {
                registry: "ghcr.io".into(),
                repository: "acme/env".into(),
                digest: digest('a'),
            },
            registry_auth: None,
            bundle: PinnedImage {
                registry: "ghcr.io".into(),
                repository: "cognia/agent-bundle".into(),
                digest: digest('b'),
            },
            bundle_registry_auth: None,
            bundle_release_tag: "2026.10.1".into(),
            tier: IsolationTier::Container,
            size: size(),
            egress: EgressPlan {
                tier: EgressTier::On,
                domains: Vec::new(),
            },
            lifetime: Duration::from_secs(7200),
            supervisor: vec![
                SANDBOXD.into(),
                "serve".into(),
                "--runtime-key".into(),
                "f".repeat(64),
            ],
            supervisor_env: vec![
                "COGNIA_SANDBOXD_RUNTIME_CONFIG_0={\"a\":\"b=c\"}".into(),
                "COGNIA_SANDBOXD_RUNTIME_CONFIG_COUNT=1".into(),
            ],
        }
    }

    fn manifest_json(
        request: &ProvisionRequest,
        settings: &KubernetesSettings,
        class: Option<&str>,
        secrets: &[String],
    ) -> Value {
        let pod = pod_manifest(
            request,
            settings,
            &PodContext {
                deployment_selector: &deployment_selector(DEPLOYMENT),
                runtime_class: class,
                pull_secrets: secrets,
            },
        )
        .expect("manifest");
        serde_json::to_value(pod).unwrap()
    }

    fn pod_from(value: Value) -> Pod {
        serde_json::from_value(value).expect("pod fixture")
    }

    fn container_status(name: &str, state: Value) -> Value {
        json!({
            "name": name,
            "ready": false,
            "restartCount": 0,
            "image": "image",
            "imageID": "",
            "state": state,
        })
    }

    fn staged_inits() -> Value {
        json!(["bundle-core", "bundle-glibc", "bundle-musl"]
            .iter()
            .map(|name| container_status(
                name,
                json!({ "terminated": { "exitCode": 0, "reason": "Completed" } })
            ))
            .collect::<Vec<_>>())
    }

    fn running_status() -> Value {
        json!({
            "phase": "Running",
            "initContainerStatuses": staged_inits(),
            "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "running": {} }))],
        })
    }

    fn status_pod(status: Value) -> Pod {
        pod_from(json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": NAME },
            "status": status,
        }))
    }

    fn api_status(code: u16, reason: &str, message: &str) -> kube::Error {
        kube::Error::Api(
            kube::core::Status::failure(message, reason)
                .with_code(code)
                .boxed(),
        )
    }

    // -- settings ------------------------------------------------------------

    #[test]
    fn settings_use_camel_case_and_documented_defaults() {
        let parsed: KubernetesSettings = serde_json::from_value(json!({
            "connection": "kubeconfig",
            "context": "prod",
            "namespace": "sbx",
        }))
        .unwrap();
        assert_eq!(parsed.connection, KubernetesConnection::Kubeconfig);
        assert_eq!(parsed.egress, KubernetesEgressMode::NetworkPolicy);
        assert_eq!(parsed.pod_ready_timeout_secs, 180);
        assert_eq!(parsed.runtime_classes, RuntimeClassMap::default());
        assert!(parsed.node_selector.is_empty());

        let full: KubernetesSettings = serde_json::from_value(json!({
            "connection": "inCluster",
            "namespace": "sbx",
            "runtimeClasses": { "gvisor": "gvisor", "vm": "kata", "container": "runc" },
            "egress": "cilium",
            "nodeSelector": { "cognia.dev/pool": "sandboxes" },
            "serviceAccountName": "sandbox",
            "podReadyTimeoutSecs": 600,
        }))
        .unwrap();
        assert_eq!(full.egress, KubernetesEgressMode::Cilium);
        assert_eq!(full.runtime_classes.vm.as_deref(), Some("kata"));
        let round_trip: KubernetesSettings =
            serde_json::from_value(serde_json::to_value(&full).unwrap()).unwrap();
        assert_eq!(round_trip, full);
        assert_eq!(
            serde_json::to_value(KubernetesEgressMode::NetworkPolicy).unwrap(),
            json!("network-policy")
        );
        assert_eq!(
            serde_json::to_value(KubernetesEgressMode::None).unwrap(),
            json!("none")
        );
    }

    #[test]
    fn settings_refuse_unknown_fields() {
        for value in [
            json!({ "connection": "inCluster", "namespace": "sbx", "kubeconfig": "x" }),
            json!({ "connection": "inCluster", "namespace": "sbx", "runtimeClasses": { "kata": "x" } }),
            json!({ "connection": "elsewhere", "namespace": "sbx" }),
            json!({ "connection": "inCluster", "namespace": "sbx", "egress": "calico" }),
        ] {
            assert!(
                serde_json::from_value::<KubernetesSettings>(value.clone()).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn validation_accepts_a_complete_configuration() {
        let mut full = settings();
        full.runtime_classes = RuntimeClassMap {
            gvisor: Some("gvisor".into()),
            vm: Some("kata-qemu".into()),
            container: Some("runc".into()),
        };
        full.node_selector = BTreeMap::from([
            ("cognia.dev/pool".into(), "sandboxes".into()),
            ("kubernetes.io/arch".into(), "amd64".into()),
            ("empty".into(), String::new()),
        ]);
        full.service_account_name = Some("sandbox-runner".into());
        assert_eq!(KubernetesProvider::validate(&full), Ok(()));
        for bound in [10, 1800] {
            let mut edge = settings();
            edge.pod_ready_timeout_secs = bound;
            assert_eq!(KubernetesProvider::validate(&edge), Ok(()));
        }
    }

    #[test]
    fn validation_names_each_bad_field() {
        type Case = (fn(&mut KubernetesSettings), &'static str);
        let cases: Vec<Case> = vec![
            (|s| s.namespace = "Sandboxes".into(), "namespace"),
            (|s| s.namespace = String::new(), "namespace"),
            (|s| s.namespace = "x".repeat(64), "namespace"),
            (|s| s.context = Some("prod".into()), "context"),
            (
                |s| {
                    s.connection = KubernetesConnection::Kubeconfig;
                    s.context = Some("  ".into());
                },
                "context",
            ),
            (
                |s| s.runtime_classes.gvisor = Some("Not_Valid".into()),
                "gvisor",
            ),
            (|s| s.runtime_classes.vm = Some("-kata".into()), "vm"),
            (
                |s| {
                    s.node_selector.insert("bad key!".into(), "v".into());
                },
                "node selector key",
            ),
            (
                |s| {
                    s.node_selector.insert("k".into(), "x".repeat(64));
                },
                "node selector value",
            ),
            (
                |s| s.service_account_name = Some("Bad Account".into()),
                "service account",
            ),
            (|s| s.pod_ready_timeout_secs = 9, "podReadyTimeoutSecs"),
            (|s| s.pod_ready_timeout_secs = 1801, "podReadyTimeoutSecs"),
        ];
        for (mutate, field) in cases {
            let mut bad = settings();
            mutate(&mut bad);
            let error = KubernetesProvider::validate(&bad).unwrap_err();
            assert!(error.contains(field), "{field}: {error}");
        }
    }

    #[test]
    fn label_grammar_matches_kubernetes() {
        assert!(is_dns_label("cognia-1"));
        assert!(!is_dns_label("cognia_1"));
        assert!(!is_dns_label("-a"));
        assert!(is_dns_subdomain("node.k8s.io"));
        assert!(!is_dns_subdomain("node..k8s.io"));
        assert!(is_label_value(""));
        assert!(is_label_value("A.b_c-1"));
        assert!(!is_label_value("_a"));
        assert!(!is_label_value(&"a".repeat(64)));
        assert!(is_label_key("cognia.dev/instance"));
        assert!(is_label_key("app"));
        assert!(!is_label_key("cognia.dev/"));
        assert!(!is_label_key("Bad_Prefix/app"));
        assert!(!is_label_key("a/b/c"));
    }

    // -- labels --------------------------------------------------------------

    #[test]
    fn deployment_selectors_are_stable_label_values() {
        let selector = deployment_selector(DEPLOYMENT);
        assert_eq!(selector.len(), 40);
        assert!(is_label_value(&selector));
        assert_eq!(selector, deployment_selector(DEPLOYMENT));
        assert_ne!(selector, deployment_selector("deployment-b"));
        assert!(is_label_value(&deployment_selector(".odd-but-accepted-")));
    }

    #[test]
    fn only_selectable_labels_become_real_labels() {
        let labels = driver_labels();
        let selectable = selectable_labels(&labels, NAME, &deployment_selector(DEPLOYMENT));
        assert_eq!(
            selectable.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                DEPLOYMENT_SELECTOR_LABEL,
                INSTANCE_SELECTOR_LABEL,
                OWNER_LABEL,
                PERSISTENT_RUNTIME_LABEL,
            ]
        );
        assert_eq!(selectable[OWNER_LABEL], OWNER_VALUE);
        assert_eq!(selectable[PERSISTENT_RUNTIME_LABEL], "1");
        for (key, value) in &selectable {
            assert!(is_label_key(key), "{key}");
            assert!(is_label_value(value), "{key}={value}");
        }
        // A persistent marker that is not a label value is hashed, not dropped.
        let mut odd = labels.clone();
        odd.insert(PERSISTENT_RUNTIME_LABEL.into(), "x".repeat(70));
        let hashed = selectable_labels(&odd, NAME, "s")[PERSISTENT_RUNTIME_LABEL].clone();
        assert!(hashed.starts_with('h') && hashed.len() == 41, "{hashed}");
        // Ephemeral instances carry no persistent marker.
        let mut ephemeral = labels;
        ephemeral.remove(PERSISTENT_RUNTIME_LABEL);
        assert!(!selectable_labels(&ephemeral, NAME, "s").contains_key(PERSISTENT_RUNTIME_LABEL));
    }

    fn metadata_for(labels: &BTreeMap<String, String>) -> ObjectMeta {
        ObjectMeta {
            name: Some(NAME.into()),
            labels: Some(selectable_labels(
                labels,
                NAME,
                &deployment_selector(DEPLOYMENT),
            )),
            annotations: Some(BTreeMap::from([(
                LABELS_ANNOTATION.to_string(),
                encode_labels_annotation(labels),
            )])),
            ..ObjectMeta::default()
        }
    }

    #[test]
    fn the_annotation_returns_the_driver_labels_verbatim() {
        let labels = driver_labels();
        let decoded = decode_labels(&metadata_for(&labels)).unwrap();
        assert_eq!(decoded, labels);
        assert!(is_owned(&decoded));
        assert_eq!(decoded[AGENT_ID_LABEL], labels[AGENT_ID_LABEL]);
        assert_eq!(decoded["cognia.runtime-key"].len(), 64);
        assert_eq!(decoded[INSTANCE_LABEL], "1234-5678901234567890-0");
    }

    #[test]
    fn ownership_needs_the_real_owner_label() {
        let labels = driver_labels();
        let mut metadata = metadata_for(&labels);
        metadata.labels.as_mut().unwrap().remove(OWNER_LABEL);
        let decoded = decode_labels(&metadata).unwrap();
        assert!(!is_owned(&decoded));
        assert_eq!(decoded[AGENT_ID_LABEL], labels[AGENT_ID_LABEL]);
    }

    #[test]
    fn a_deployment_claim_must_match_its_selector() {
        let labels = driver_labels();
        let mut metadata = metadata_for(&labels);
        metadata.labels.as_mut().unwrap().insert(
            DEPLOYMENT_SELECTOR_LABEL.into(),
            deployment_selector("other"),
        );
        let decoded = decode_labels(&metadata).unwrap();
        assert!(!decoded.contains_key(DEPLOYMENT_LABEL));
        assert!(is_owned(&decoded));
    }

    #[test]
    fn missing_or_broken_annotations_are_handled() {
        let mut metadata = metadata_for(&driver_labels());
        metadata.annotations = None;
        let fallback = decode_labels(&metadata).unwrap();
        assert_eq!(fallback, metadata.labels.clone().unwrap());

        metadata.annotations = Some(BTreeMap::from([(
            LABELS_ANNOTATION.to_string(),
            "{not json".to_string(),
        )]));
        let error = decode_labels(&metadata).unwrap_err();
        assert!(error.contains(LABELS_ANNOTATION), "{error}");
    }

    // -- manifests -----------------------------------------------------------

    #[test]
    fn the_pod_stages_the_bundle_with_three_locked_down_init_containers() {
        let manifest = manifest_json(&request(), &settings(), None, &[]);
        let inits = manifest["spec"]["initContainers"].as_array().unwrap();
        assert_eq!(inits.len(), 3);
        let expected = [
            ("bundle-core", vec!["--stage", "core"]),
            ("bundle-glibc", vec!["--stage", "libc", "--libc", "glibc"]),
            ("bundle-musl", vec!["--stage", "libc", "--libc", "musl"]),
        ];
        for (init, (name, stage)) in inits.iter().zip(expected) {
            assert_eq!(init["name"], name);
            assert_eq!(
                init["image"],
                format!("ghcr.io/cognia/agent-bundle@{}", digest('b'))
            );
            let mut command = vec![BUNDLE_SANDBOXD, "install"];
            command.extend(stage);
            command.extend(["--from", "/opt/cognia", "--to", "/cognia"]);
            assert_eq!(init["command"], json!(command));
            let security = &init["securityContext"];
            assert_eq!(security["runAsUser"], 0);
            assert_eq!(security["readOnlyRootFilesystem"], true);
            assert_eq!(security["allowPrivilegeEscalation"], false);
            assert_eq!(security["capabilities"]["drop"], json!(["ALL"]));
            assert!(security["capabilities"].get("add").is_none());
            assert_eq!(
                init["volumeMounts"],
                json!([{ "name": BUNDLE_VOLUME, "mountPath": "/cognia" }])
            );
        }
    }

    #[test]
    fn the_main_container_waits_for_the_start_gate() {
        let req = request();
        let manifest = manifest_json(&req, &settings(), None, &[]);
        let spec = &manifest["spec"];
        let main = &spec["containers"][0];
        assert_eq!(spec["containers"].as_array().unwrap().len(), 1);
        assert_eq!(main["name"], SANDBOX_CONTAINER);
        assert_eq!(main["image"], format!("ghcr.io/acme/env@{}", digest('a')));
        let mut command = vec![
            json!(SANDBOXD),
            json!("await-start"),
            json!("--marker"),
            json!(START_MARKER),
            json!("--sticky"),
            json!("/tmp"),
            json!("--"),
        ];
        command.extend(req.supervisor.iter().map(|part| json!(part)));
        assert_eq!(main["command"], Value::Array(command));
        assert_eq!(main["workingDir"], "/workspace");
        assert_eq!(main["stdin"], false);
        assert_eq!(
            main["env"],
            json!([
                { "name": "COGNIA_SANDBOXD_RUNTIME_CONFIG_0", "value": "{\"a\":\"b=c\"}" },
                { "name": "COGNIA_SANDBOXD_RUNTIME_CONFIG_COUNT", "value": "1" },
            ])
        );
        let quantities =
            json!({ "cpu": "2000m", "memory": "4096Mi", "ephemeral-storage": "10240Mi" });
        assert_eq!(main["resources"]["requests"], quantities);
        assert_eq!(main["resources"]["limits"], quantities);
        let security = &main["securityContext"];
        assert_eq!(security["runAsUser"], 0);
        assert_eq!(security["allowPrivilegeEscalation"], false);
        assert_eq!(security["readOnlyRootFilesystem"], false);
        assert_eq!(security["capabilities"]["drop"], json!(["ALL"]));
        assert_eq!(
            security["capabilities"]["add"],
            json!(["SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER"])
        );
        assert_eq!(
            main["volumeMounts"],
            json!([
                { "name": BUNDLE_VOLUME, "mountPath": "/cognia", "readOnly": true },
                { "name": WORKSPACE_VOLUME, "mountPath": "/workspace" },
                { "name": TMP_VOLUME, "mountPath": "/tmp" },
            ])
        );
        assert_eq!(
            spec["volumes"],
            json!([
                { "name": BUNDLE_VOLUME, "emptyDir": {} },
                { "name": WORKSPACE_VOLUME, "emptyDir": { "sizeLimit": "20480Mi" } },
                { "name": TMP_VOLUME, "emptyDir": { "medium": "Memory" } },
            ])
        );
    }

    #[test]
    fn the_pod_is_bounded_and_carries_no_cluster_identity() {
        let manifest = manifest_json(&request(), &settings(), None, &[]);
        let spec = &manifest["spec"];
        assert_eq!(spec["restartPolicy"], "Never");
        assert_eq!(spec["automountServiceAccountToken"], false);
        assert_eq!(spec["enableServiceLinks"], false);
        assert_eq!(spec["activeDeadlineSeconds"], 7200);
        assert_eq!(spec["terminationGracePeriodSeconds"], 10);
        assert_eq!(
            spec["securityContext"]["seccompProfile"]["type"],
            "RuntimeDefault"
        );
        for absent in [
            "runtimeClassName",
            "nodeSelector",
            "serviceAccountName",
            "imagePullSecrets",
        ] {
            assert!(spec.get(absent).is_none(), "{absent}");
        }
        let metadata = &manifest["metadata"];
        assert_eq!(metadata["name"], NAME);
        assert_eq!(metadata["namespace"], "sbx");
        assert_eq!(metadata["labels"][INSTANCE_SELECTOR_LABEL], NAME);
        assert_eq!(
            metadata["annotations"][BUNDLE_RELEASE_ANNOTATION],
            "2026.10.1"
        );
        let annotated: BTreeMap<String, String> =
            serde_json::from_str(metadata["annotations"][LABELS_ANNOTATION].as_str().unwrap())
                .unwrap();
        assert_eq!(annotated, driver_labels());
    }

    #[test]
    fn optional_pod_fields_follow_settings_and_context() {
        let mut configured = settings();
        configured.node_selector = BTreeMap::from([("cognia.dev/pool".into(), "sandboxes".into())]);
        configured.service_account_name = Some("sandbox".into());
        let secrets = vec!["cognia-pull-aaa".to_string(), "cognia-pull-bbb".to_string()];
        let manifest = manifest_json(&request(), &configured, Some("gvisor"), &secrets);
        let spec = &manifest["spec"];
        assert_eq!(spec["runtimeClassName"], "gvisor");
        assert_eq!(
            spec["nodeSelector"],
            json!({ "cognia.dev/pool": "sandboxes" })
        );
        assert_eq!(spec["serviceAccountName"], "sandbox");
        assert_eq!(
            spec["imagePullSecrets"],
            json!([{ "name": "cognia-pull-aaa" }, { "name": "cognia-pull-bbb" }])
        );
        // The account is selected, but its token is still never mounted.
        assert_eq!(spec["automountServiceAccountToken"], false);
    }

    #[test]
    fn invalid_requests_are_refused_before_any_manifest() {
        let context = PodContext {
            deployment_selector: "s",
            runtime_class: None,
            pull_secrets: &[],
        };
        type Case = (fn(&mut ProvisionRequest), &'static str);
        let cases: Vec<Case> = vec![
            (|r| r.name = "Not_A_Label".into(), "instance name"),
            (|r| r.image.digest = "sha256:short".into(), "image"),
            (|r| r.bundle.registry = String::new(), "bundle"),
            (|r| r.supervisor.clear(), "supervisor"),
            (
                |r| {
                    r.size.gpu = Some(cognia_environment::catalog::GpuRequest {
                        count: 1,
                        resource_name: "nvidia.com/gpu".into(),
                    })
                },
                "GPU",
            ),
            (|r| r.size.memory_mib = 0, "zero resource"),
            (|r| r.supervisor_env.push("NO_EQUALS".into()), "without '='"),
            (
                |r| r.supervisor_env.push("1BAD=secret-value".into()),
                "invalid supervisor",
            ),
        ];
        for (mutate, expected) in cases {
            let mut bad = request();
            mutate(&mut bad);
            let error = pod_manifest(&bad, &settings(), &context).unwrap_err();
            assert!(error.contains(expected), "{expected}: {error}");
            assert!(
                !error.contains("secret-value"),
                "values never echo: {error}"
            );
        }
    }

    #[test]
    fn runtime_classes_map_tiers() {
        let mut mapped = settings();
        assert_eq!(
            runtime_class_for(IsolationTier::Container, &mapped).unwrap(),
            None
        );
        let error = runtime_class_for(IsolationTier::Gvisor, &mapped).unwrap_err();
        assert_eq!(error.code, "isolation_tier_unavailable");
        assert_eq!(error.kind, SandboxErrorKind::Refused);
        assert!(runtime_class_for(IsolationTier::Vm, &mapped).is_err());
        mapped.runtime_classes = RuntimeClassMap {
            gvisor: Some("gvisor".into()),
            vm: Some("kata".into()),
            container: Some("runc".into()),
        };
        assert_eq!(
            runtime_class_for(IsolationTier::Container, &mapped)
                .unwrap()
                .as_deref(),
            Some("runc")
        );
        assert_eq!(
            runtime_class_for(IsolationTier::Gvisor, &mapped)
                .unwrap()
                .as_deref(),
            Some("gvisor")
        );
        assert_eq!(
            runtime_class_for(IsolationTier::Vm, &mapped)
                .unwrap()
                .as_deref(),
            Some("kata")
        );
    }

    // -- pull secrets ----------------------------------------------------------

    fn basic(server: &str, username: &str) -> RegistryAuth {
        RegistryAuth {
            server_address: server.into(),
            username: Some(username.into()),
            password: Some("p@ss:word".into()),
            ..RegistryAuth::default()
        }
    }

    fn secret_config(secret: &Secret) -> Value {
        let data = secret.data.as_ref().unwrap();
        serde_json::from_slice(&data[".dockerconfigjson"].0).unwrap()
    }

    #[test]
    fn pull_secret_names_are_deterministic_per_registry_and_user() {
        let name = pull_secret_name(&basic("ghcr.io", "alice"));
        assert!(name.starts_with("cognia-pull-") && name.len() == "cognia-pull-".len() + 12);
        assert!(is_dns_label(&name));
        assert_eq!(name, pull_secret_name(&basic("GHCR.io", "alice")));
        assert_ne!(name, pull_secret_name(&basic("ghcr.io", "bob")));
        assert_ne!(name, pull_secret_name(&basic("quay.io", "alice")));
        let mut rotated = basic("ghcr.io", "alice");
        rotated.password = Some("new".into());
        assert_eq!(
            name,
            pull_secret_name(&rotated),
            "a rotated password upserts in place"
        );
    }

    #[test]
    fn basic_credentials_become_a_docker_config() {
        let auth = basic("https://index.docker.io/v1/", "alice");
        let secret = pull_secret(&auth, "sbx", "selector").unwrap();
        assert_eq!(
            secret.type_.as_deref(),
            Some("kubernetes.io/dockerconfigjson")
        );
        assert_eq!(secret.metadata.namespace.as_deref(), Some("sbx"));
        let labels = secret.metadata.labels.as_ref().unwrap();
        assert_eq!(labels[OWNER_LABEL], OWNER_VALUE);
        assert_eq!(labels[DEPLOYMENT_SELECTOR_LABEL], "selector");
        let entry = &secret_config(&secret)["auths"]["https://index.docker.io/v1/"];
        assert_eq!(entry["username"], "alice");
        assert_eq!(entry["password"], "p@ss:word");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(entry["auth"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded, b"alice:p@ss:word");
    }

    #[test]
    fn token_credentials_follow_docker_semantics() {
        let identity = RegistryAuth {
            server_address: "registry.example.com".into(),
            identity_token: Some("refresh".into()),
            ..RegistryAuth::default()
        };
        let entry = docker_config_entry(&identity).unwrap();
        assert_eq!(entry, json!({ "identitytoken": "refresh" }));
        let bearer = RegistryAuth {
            server_address: "registry.example.com".into(),
            registry_token: Some("bearer".into()),
            ..RegistryAuth::default()
        };
        assert_eq!(
            docker_config_entry(&bearer).unwrap(),
            json!({ "registrytoken": "bearer" })
        );
        let named = RegistryAuth {
            server_address: "registry.example.com".into(),
            username: Some("svc".into()),
            identity_token: Some("refresh".into()),
            ..RegistryAuth::default()
        };
        assert_eq!(
            docker_config_entry(&named).unwrap(),
            json!({ "username": "svc", "identitytoken": "refresh" })
        );
        assert_eq!(pull_secret_name(&identity), pull_secret_name(&bearer));
    }

    #[test]
    fn credentials_without_a_secret_are_refused() {
        let empty = RegistryAuth {
            server_address: "ghcr.io".into(),
            ..RegistryAuth::default()
        };
        assert!(docker_config_entry(&empty)
            .unwrap_err()
            .contains("no password or token"));
        let user_only = RegistryAuth {
            username: Some("alice".into()),
            ..empty.clone()
        };
        assert!(docker_config_entry(&user_only).is_err());
        let password_only = RegistryAuth {
            password: Some("hunter2".into()),
            ..empty.clone()
        };
        let error = docker_config_entry(&password_only).unwrap_err();
        assert!(!error.contains("hunter2"), "{error}");
        let nowhere = RegistryAuth {
            server_address: " ".into(),
            ..basic("x", "y")
        };
        assert!(pull_secret(&nowhere, "sbx", "s").is_err());
    }

    // -- egress --------------------------------------------------------------

    fn plan(tier: EgressTier, domains: &[&str]) -> EgressPlan {
        EgressPlan {
            tier,
            domains: domains.iter().map(|domain| domain.to_string()).collect(),
        }
    }

    #[test]
    fn egress_policies_follow_the_tier_and_mode() {
        use EgressTier::*;
        use KubernetesEgressMode as Mode;
        let cases = [
            (Mode::None, Off, EgressPolicy::None),
            (Mode::None, Allowlist, EgressPolicy::None),
            (Mode::None, On, EgressPolicy::None),
            (Mode::NetworkPolicy, Off, EgressPolicy::DenyAll),
            (Mode::NetworkPolicy, Allowlist, EgressPolicy::AllButMetadata),
            (Mode::NetworkPolicy, On, EgressPolicy::AllButMetadata),
            (Mode::Cilium, Off, EgressPolicy::DenyAll),
            (Mode::Cilium, Allowlist, EgressPolicy::CiliumAllowlist),
            (Mode::Cilium, On, EgressPolicy::AllButMetadata),
        ];
        for (mode, tier, expected) in cases {
            assert_eq!(
                egress_policy(&plan(tier, &[]), mode),
                expected,
                "{mode:?} {tier:?}"
            );
        }
    }

    /// Kubernetes `allowlist` egress without Cilium is intentionally
    /// unenforced (ADR-0221): documented on [`KubernetesEgressMode`],
    /// labelled `egress.enforced: false` by the driver, pinned here.
    #[test]
    fn allowlist_is_enforced_only_with_cilium() {
        use EgressTier::*;
        use KubernetesEgressMode as Mode;
        assert!(!egress_enforced_by(Mode::None, Off));
        assert!(egress_enforced_by(Mode::NetworkPolicy, Off));
        assert!(egress_enforced_by(Mode::Cilium, Off));
        assert!(!egress_enforced_by(Mode::None, Allowlist));
        assert!(!egress_enforced_by(Mode::NetworkPolicy, Allowlist));
        assert!(egress_enforced_by(Mode::Cilium, Allowlist));
        for mode in [Mode::None, Mode::NetworkPolicy, Mode::Cilium] {
            assert!(egress_enforced_by(mode, On));
        }
    }

    #[test]
    fn deny_all_selects_the_instance_and_is_owned_by_its_pod() {
        let owner = owner_reference(NAME, "uid-1");
        let policy = network_policy(NAME, "sbx", "sel", &owner, EgressPolicy::DenyAll).unwrap();
        let value = serde_json::to_value(&policy).unwrap();
        assert_eq!(value["apiVersion"], "networking.k8s.io/v1");
        assert_eq!(value["kind"], "NetworkPolicy");
        assert_eq!(value["metadata"]["name"], NAME);
        assert_eq!(value["metadata"]["labels"][OWNER_LABEL], OWNER_VALUE);
        assert_eq!(
            value["metadata"]["labels"][DEPLOYMENT_SELECTOR_LABEL],
            "sel"
        );
        assert_eq!(
            value["metadata"]["ownerReferences"],
            json!([{ "apiVersion": "v1", "kind": "Pod", "name": NAME, "uid": "uid-1", "controller": true }])
        );
        assert_eq!(
            value["spec"]["podSelector"],
            json!({ "matchLabels": { INSTANCE_SELECTOR_LABEL: NAME } })
        );
        assert_eq!(value["spec"]["policyTypes"], json!(["Ingress", "Egress"]));
        assert!(value["spec"].get("egress").is_none());
        assert!(value["spec"].get("ingress").is_none());
    }

    #[test]
    fn open_egress_still_excludes_every_metadata_range() {
        let owner = owner_reference(NAME, "uid-1");
        let policy =
            network_policy(NAME, "sbx", "sel", &owner, EgressPolicy::AllButMetadata).unwrap();
        let value = serde_json::to_value(&policy).unwrap();
        let peers = &value["spec"]["egress"][0]["to"];
        assert_eq!(
            peers[0]["ipBlock"],
            json!({ "cidr": "0.0.0.0/0", "except": metadata_cidrs(false) })
        );
        assert_eq!(
            peers[1]["ipBlock"],
            json!({ "cidr": "::/0", "except": ["fd00:ec2::254/128"] })
        );
        assert_eq!(peers[2], json!({ "namespaceSelector": {} }));
        assert!(
            value["spec"].get("ingress").is_none(),
            "ingress stays denied"
        );
        assert!(network_policy(NAME, "sbx", "sel", &owner, EgressPolicy::CiliumAllowlist).is_err());
        assert!(network_policy(NAME, "sbx", "sel", &owner, EgressPolicy::None).is_err());
    }

    #[test]
    fn the_metadata_ranges_are_cognia_nets_split_by_family() {
        let v4 = metadata_cidrs(false);
        let v6 = metadata_cidrs(true);
        assert!(v4.iter().all(|cidr| !cidr.contains(':')));
        assert!(v6.iter().all(|cidr| cidr.contains(':')));
        let split: BTreeSet<&str> = v4.iter().chain(v6.iter()).copied().collect();
        let all: BTreeSet<&str> = cognia_net::egress::METADATA_CIDRS.iter().copied().collect();
        assert_eq!(split, all);
        assert!(v4.contains(&"169.254.0.0/16"));
        assert!(v6.contains(&"fd00:ec2::254/128"));
    }

    #[test]
    fn the_cilium_allowlist_permits_dns_and_named_hosts_only() {
        let owner = owner_reference(NAME, "uid-1");
        let domains = vec!["github.com".to_string(), "*.npmjs.org".to_string()];
        let object = cilium_policy(NAME, "sbx", "sel", &owner, &domains).unwrap();
        let value = serde_json::to_value(&object).unwrap();
        assert_eq!(value["apiVersion"], "cilium.io/v2");
        assert_eq!(value["kind"], "CiliumNetworkPolicy");
        assert_eq!(value["metadata"]["namespace"], "sbx");
        assert_eq!(value["metadata"]["ownerReferences"][0]["uid"], "uid-1");
        let spec = &value["spec"];
        assert_eq!(
            spec["endpointSelector"],
            json!({ "matchLabels": { INSTANCE_SELECTOR_LABEL: NAME } })
        );
        assert_eq!(spec["ingress"], json!([{}]));
        let dns = &spec["egress"][0];
        assert_eq!(
            dns["toEndpoints"][0]["matchLabels"],
            json!({ "k8s:io.kubernetes.pod.namespace": "kube-system", "k8s:k8s-app": "kube-dns" })
        );
        assert_eq!(
            dns["toPorts"][0]["ports"],
            json!([{ "port": "53", "protocol": "UDP" }, { "port": "53", "protocol": "TCP" }])
        );
        assert_eq!(
            dns["toPorts"][0]["rules"]["dns"],
            json!([{ "matchPattern": "*" }])
        );
        let hosts = &spec["egress"][1];
        assert_eq!(
            hosts["toFQDNs"],
            json!([{ "matchName": "github.com" }, { "matchPattern": "*.npmjs.org" }])
        );
        assert_eq!(
            hosts["toPorts"][0]["ports"],
            json!([{ "port": "80", "protocol": "TCP" }, { "port": "443", "protocol": "TCP" }])
        );
        assert_eq!(spec["egress"].as_array().unwrap().len(), 2);
        assert_eq!(
            spec["egressDeny"],
            json!([{ "toCIDR": cognia_net::egress::METADATA_CIDRS }])
        );
    }

    #[test]
    fn an_empty_allowlist_permits_dns_only_and_bad_entries_are_refused() {
        let owner = owner_reference(NAME, "uid-1");
        let object = cilium_policy(NAME, "sbx", "sel", &owner, &[]).unwrap();
        let value = serde_json::to_value(&object).unwrap();
        assert_eq!(value["spec"]["egress"].as_array().unwrap().len(), 1);
        for bad in [
            "",
            "*",
            "*.",
            "Example.com",
            "a..b",
            "-a.com",
            "a.com:443",
            "**.a.com",
            "http://a.com",
        ] {
            let error = cilium_policy(NAME, "sbx", "sel", &owner, &[bad.to_string()]).unwrap_err();
            assert!(error.contains("allowlist entry"), "{bad}: {error}");
        }
    }

    // -- classification ------------------------------------------------------

    fn failed(progress: PodProgress) -> SandboxSpawnError {
        match progress {
            PodProgress::Failed(error) => error,
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn a_running_sandbox_container_is_ready() {
        assert_eq!(
            classify_pod(&status_pod(running_status())),
            PodProgress::Ready
        );
        // Running phase with the container not yet running is still waiting.
        let starting = status_pod(json!({
            "phase": "Running",
            "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "waiting": { "reason": "ContainerCreating" } }))],
        }));
        assert_eq!(
            classify_pod(&starting),
            PodProgress::Waiting("ContainerCreating".into())
        );
        assert_eq!(
            classify_pod(&pod_from(json!({ "metadata": { "name": NAME } }))),
            PodProgress::Waiting("Pending".into())
        );
    }

    #[test]
    fn image_pull_failures_name_the_image_that_failed() {
        for reason in IMAGE_PULL_REASONS {
            let main = status_pod(json!({
                "phase": "Pending",
                "initContainerStatuses": staged_inits(),
                "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "waiting": { "reason": reason, "message": "manifest unknown" } }))],
            }));
            let error = failed(classify_pod(&main));
            assert_eq!(error.code, "sandbox_image_unavailable", "{reason}");
            assert_eq!(error.kind, SandboxErrorKind::Refused);
            assert!(
                error.message.contains("manifest unknown"),
                "{}",
                error.message
            );

            let init = status_pod(json!({
                "phase": "Pending",
                "initContainerStatuses": [container_status("bundle-core", json!({ "waiting": { "reason": reason } }))],
            }));
            let error = failed(classify_pod(&init));
            assert_eq!(error.code, "sandbox_bundle_unavailable", "{reason}");
            assert_eq!(error.kind, SandboxErrorKind::Refused);
        }
    }

    #[test]
    fn staging_and_start_failures_are_bundle_problems() {
        let init_failed = status_pod(json!({
            "phase": "Failed",
            "initContainerStatuses": [container_status("bundle-glibc", json!({ "terminated": { "exitCode": 1, "reason": "Error", "message": "no glibc tree" } }))],
        }));
        let error = failed(classify_pod(&init_failed));
        assert_eq!(error.code, "sandbox_bundle_unsupported");
        assert!(
            error.message.contains("bundle-glibc") && error.message.contains("no glibc tree"),
            "{}",
            error.message
        );

        let exited = status_pod(json!({
            "phase": "Failed",
            "initContainerStatuses": staged_inits(),
            "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "terminated": { "exitCode": 2, "reason": "Error" } }))],
        }));
        let error = failed(classify_pod(&exited));
        assert_eq!(error.code, "sandbox_bundle_unsupported");
        assert!(error.message.contains("await-start"), "{}", error.message);

        for reason in ["CreateContainerError", "RunContainerError"] {
            let broken = status_pod(json!({
                "phase": "Pending",
                "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "waiting": { "reason": reason } }))],
            }));
            assert_eq!(
                failed(classify_pod(&broken)).code,
                "sandbox_bundle_unsupported"
            );
        }
        let policy = status_pod(json!({
            "phase": "Pending",
            "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "waiting": { "reason": "CreateContainerConfigError", "message": "secret missing" } }))],
        }));
        let error = failed(classify_pod(&policy));
        assert_eq!(error.code, "sandbox_provider_rejected");
        assert_eq!(error.kind, SandboxErrorKind::Fault);
    }

    #[test]
    fn evictions_are_capacity_and_unschedulable_pods_wait() {
        let evicted = status_pod(
            json!({ "phase": "Failed", "reason": "Evicted", "message": "low on memory" }),
        );
        let error = failed(classify_pod(&evicted));
        assert_eq!(error.code, "sandbox_provider_capacity");
        assert_eq!(error.kind, SandboxErrorKind::Fault);

        let unschedulable = status_pod(json!({
            "phase": "Pending",
            "conditions": [{ "type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": "0/3 nodes: insufficient cpu" }],
        }));
        let PodProgress::Waiting(reason) = classify_pod(&unschedulable) else {
            panic!("unschedulable pods wait for the autoscaler");
        };
        assert!(
            reason.starts_with("Unschedulable") && reason.contains("insufficient cpu"),
            "{reason}"
        );
        let error = ready_timeout_error(NAME, Duration::from_secs(10), &reason);
        assert_eq!(error.code, "sandbox_provider_capacity");
        assert!(error.message.contains("10s"), "{}", error.message);
        let error = ready_timeout_error(NAME, Duration::from_secs(10), "ContainerCreating");
        assert_eq!(error.code, "sandbox_provider_unreachable");
        assert_eq!(error.kind, SandboxErrorKind::Fault);
    }

    #[test]
    fn api_errors_are_classified_by_status() {
        let quota = api_error(
            "creating pod",
            &api_status(
                403,
                "Forbidden",
                "pods \"x\" is forbidden: exceeded quota: compute",
            ),
        );
        assert_eq!(
            (quota.kind, quota.code.as_str()),
            (SandboxErrorKind::Fault, "sandbox_provider_capacity")
        );
        let forbidden = api_error(
            "creating pod",
            &api_status(403, "Forbidden", "cannot create pods"),
        );
        assert_eq!(forbidden.code, "sandbox_provider_rejected");
        let invalid = api_error("creating pod", &api_status(422, "Invalid", "bad spec"));
        assert_eq!(invalid.code, "sandbox_provider_rejected");
        for code in [500, 503, 429] {
            let error = api_error("creating pod", &api_status(code, "InternalError", "x"));
            assert_eq!(error.code, "sandbox_provider_unreachable", "{code}");
        }
        let transport = api_error(
            "creating pod",
            &kube::Error::LinesCodecMaxLineLengthExceeded,
        );
        assert_eq!(transport.code, "sandbox_provider_unreachable");
        assert!(
            quota.message.starts_with("creating pod: "),
            "{}",
            quota.message
        );
    }

    #[test]
    fn old_api_servers_are_refused() {
        assert_eq!(check_server_version("1", "30", "v1.30.0"), Ok(()));
        assert_eq!(check_server_version("1", "33+", "v1.33.1-gke.2"), Ok(()));
        assert_eq!(check_server_version("2", "0", "v2.0.0"), Ok(()));
        assert_eq!(check_server_version("", "", "v1.31.4-eks-1"), Ok(()));
        let old = check_server_version("1", "29", "v1.29.9").unwrap_err();
        assert_eq!(
            (old.kind, old.code.as_str()),
            (SandboxErrorKind::Fault, "sandbox_provider_rejected")
        );
        assert!(
            old.message.contains("1.29") && old.message.contains("1.30"),
            "{}",
            old.message
        );
        let unreadable = check_server_version("one", "x", "unknown").unwrap_err();
        assert_eq!(unreadable.code, "sandbox_provider_rejected");
    }

    #[test]
    fn exec_statuses_map_to_exit_codes() {
        let success = Status {
            status: Some("Success".into()),
            ..Status::default()
        };
        assert_eq!(exit_code(Some(&success)), Some(0));
        let nonzero = |message: &str| Status {
            status: Some("Failure".into()),
            reason: Some("NonZeroExitCode".into()),
            details: Some(StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some("ExitCode".into()),
                    message: Some(message.into()),
                    field: None,
                }]),
                ..StatusDetails::default()
            }),
            ..Status::default()
        };
        assert_eq!(exit_code(Some(&nonzero("3"))), Some(3));
        assert_eq!(exit_code(Some(&nonzero("127"))), Some(127));
        assert_eq!(exit_code(Some(&nonzero("nope"))), None);
        let other = Status {
            status: Some("Failure".into()),
            reason: Some("InternalError".into()),
            ..Status::default()
        };
        assert_eq!(exit_code(Some(&other)), None);
        assert_eq!(exit_code(None), None);
    }

    // -- exec plumbing -------------------------------------------------------

    #[test]
    fn exec_frame_applies_trusted_workspace_ports_last() {
        let spec = RunnerExecSpec {
            container_id: NAME.into(),
            command: vec!["env".into()],
            env: vec!["PORT=9999".into()],
            workspace_env: BTreeMap::from([
                ("COGNIA_PORT".into(), "41000".into()),
                ("COGNIA_PORT_COUNT".into(), "10".into()),
                ("PORT".into(), "41000".into()),
            ]),
            working_dir: "/workspace".into(),
        };
        let (_, frame) = exec_invocation(&spec).unwrap();
        let decoded = cognia_sandboxd::exec_env::read_frame(&mut frame.as_slice()).unwrap();
        let env: BTreeMap<_, _> = decoded
            .env
            .iter()
            .map(|entry| entry.split_once('=').unwrap())
            .collect();
        assert_eq!(env["PORT"], "41000");
        assert_eq!(env["COGNIA_PORT"], "41000");
        assert_eq!(env["COGNIA_PORT_COUNT"], "10");
    }

    #[tokio::test]
    async fn real_provider_frontend_leases_reach_kubernetes_exec_unchanged() {
        for kind in ["project-root", "desktop-session"] {
            let (cwd, expected) = crate::docker::tests::real_workspace_env_fixture(kind);
            let workspace_env = cognia_core::workspace_env::resolve_workspace_env_async(
                cognia_core::workspace_env::WorkspaceEnvQuery {
                    cwd: cwd.path().to_path_buf(),
                    workspace_id: None,
                    namespace: cognia_core::workspace_env::HOST_LOOPBACK_NAMESPACE.into(),
                },
            )
            .await
            .unwrap()
            .unwrap();
            let spec = RunnerExecSpec {
                container_id: NAME.into(),
                command: vec!["env".into()],
                env: vec!["PORT=9999".into()],
                workspace_env,
                working_dir: "/workspace".into(),
            };
            let (_, frame) = exec_invocation(&spec).unwrap();
            let decoded = cognia_sandboxd::exec_env::read_frame(&mut frame.as_slice()).unwrap();
            let env: BTreeMap<_, _> = decoded
                .env
                .iter()
                .map(|entry| entry.split_once('=').unwrap())
                .collect();
            for (key, value) in &expected {
                assert_eq!(env[key.as_str()], value);
            }
        }
    }

    #[test]
    fn every_exec_goes_through_exec_env_with_a_frame() {
        let spec = RunnerExecSpec {
            workspace_env: BTreeMap::new(),
            container_id: NAME.into(),
            command: vec!["git".into(), "status".into()],
            env: vec!["GIT_TERMINAL_PROMPT=0".into()],
            working_dir: "/workspace/repo".into(),
        };
        let (argv, frame) = exec_invocation(&spec).unwrap();
        assert_eq!(argv, vec![SANDBOXD, "exec-env", "--", "git", "status"]);
        let decoded = cognia_sandboxd::exec_env::read_frame(&mut frame.as_slice()).unwrap();
        assert_eq!(decoded.env, vec!["GIT_TERMINAL_PROMPT=0".to_string()]);
        assert_eq!(decoded.cwd.as_deref(), Some("/workspace/repo"));

        let rootless = RunnerExecSpec {
            working_dir: String::new(),
            env: Vec::new(),
            ..spec.clone()
        };
        let (_, frame) = exec_invocation(&rootless).unwrap();
        assert_eq!(&frame[4..], b"{}");
        let empty = RunnerExecSpec {
            command: Vec::new(),
            ..spec.clone()
        };
        assert!(exec_invocation(&empty).is_err());
        let bad = RunnerExecSpec {
            env: vec!["BAD NAME=x".into()],
            ..spec
        };
        assert!(exec_invocation(&bad)
            .unwrap_err()
            .contains("exec environment"));
    }

    struct Pipes {
        remote_stdin: tokio::io::DuplexStream,
        stdout: tokio::io::DuplexStream,
        stderr: tokio::io::DuplexStream,
        status: tokio::sync::oneshot::Sender<Status>,
        alive: tokio::sync::oneshot::Receiver<()>,
        runner: RunningRunner,
    }

    fn pipes(frame: &[u8]) -> Pipes {
        let (stdin_local, remote_stdin) = tokio::io::duplex(1024);
        let (stdout, stdout_local) = tokio::io::duplex(1024);
        let (stderr, stderr_local) = tokio::io::duplex(1024);
        let (status, status_rx) = tokio::sync::oneshot::channel::<Status>();
        let (alive_tx, alive) = tokio::sync::oneshot::channel::<()>();
        let runner = spawn_exec_pumps(
            NAME.into(),
            frame.to_vec(),
            stdin_local,
            stdout_local,
            stderr_local,
            async move { status_rx.await.ok() },
            alive_tx,
        );
        Pipes {
            remote_stdin,
            stdout,
            stderr,
            status,
            alive,
            runner,
        }
    }

    #[tokio::test]
    async fn the_frame_precedes_stdin_and_dropping_the_sender_ends_it() {
        let mut p = pipes(b"FRAME");
        p.runner.stdin.send(b"hello ".to_vec()).await.unwrap();
        p.runner.stdin.send(b"world".to_vec()).await.unwrap();
        drop(p.runner.stdin);
        let mut received = Vec::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            p.remote_stdin.read_to_end(&mut received),
        )
        .await
        .expect("stdin reaches EOF once the sender is dropped")
        .unwrap();
        assert_eq!(received, b"FRAMEhello world");
    }

    #[tokio::test]
    async fn output_streams_then_the_exit_status_arrive_in_order() {
        let mut p = pipes(b"");
        p.stdout.write_all(b"out").await.unwrap();
        p.stderr.write_all(b"err").await.unwrap();
        drop(p.stdout);
        drop(p.stderr);
        p.status
            .send(Status {
                status: Some("Failure".into()),
                reason: Some("NonZeroExitCode".into()),
                details: Some(StatusDetails {
                    causes: Some(vec![StatusCause {
                        reason: Some("ExitCode".into()),
                        message: Some("4".into()),
                        field: None,
                    }]),
                    ..StatusDetails::default()
                }),
                ..Status::default()
            })
            .unwrap();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = loop {
            match p.runner.events.recv().await.expect("an exit event") {
                RunnerEvent::Stdout(bytes) => stdout.extend(bytes),
                RunnerEvent::Stderr(bytes) => stderr.extend(bytes),
                RunnerEvent::Exited { code } => break code,
            }
        };
        assert_eq!(
            (stdout.as_slice(), stderr.as_slice(), code),
            (&b"out"[..], &b"err"[..], Some(4))
        );
        assert!(
            p.runner.events.recv().await.is_none(),
            "Exited is the last event"
        );
        // The connection owner is released once the exec is over.
        assert!(p.alive.await.is_err());
    }

    #[tokio::test]
    async fn a_lost_status_is_an_unknown_exit() {
        let mut p = pipes(b"");
        drop(p.stdout);
        drop(p.stderr);
        drop(p.status);
        assert!(matches!(
            p.runner.events.recv().await,
            Some(RunnerEvent::Exited { code: None })
        ));
    }

    #[tokio::test]
    async fn a_slow_consumer_backpressures_the_remote_output() {
        let mut p = pipes(b"");
        let mut stdout = p.stdout;
        let chunk = vec![7u8; 64 * 1024];
        let writer = tokio::spawn(async move {
            for _ in 0..64 {
                stdout.write_all(&chunk).await.unwrap();
            }
            stdout
        });
        // 4 MiB cannot all be buffered behind a 64-event queue.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!writer.is_finished(), "the writer must be held back");
        let mut total = 0usize;
        let drain = async {
            while total < 64 * 64 * 1024 {
                match p.runner.events.recv().await {
                    Some(RunnerEvent::Stdout(bytes)) => total += bytes.len(),
                    other => panic!("unexpected {other:?}"),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(10), drain)
            .await
            .expect("draining releases the writer");
        let stdout = writer.await.unwrap();
        drop(stdout);
        drop(p.stderr);
        drop(p.status);
        assert!(matches!(
            p.runner.events.recv().await,
            Some(RunnerEvent::Exited { .. })
        ));
    }

    #[tokio::test]
    async fn dropping_the_events_ends_the_exec() {
        let p = pipes(b"");
        drop(p.runner.events);
        tokio::time::timeout(Duration::from_secs(5), p.alive)
            .await
            .expect("the connection owner is released when nobody listens")
            .unwrap_err();
        drop(p.stdout);
    }

    // -- construction --------------------------------------------------------

    const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: lab
  cluster:
    server: https://192.0.2.1:6443
    insecure-skip-tls-verify: true
contexts:
- name: lab
  context:
    cluster: lab
    user: lab
    namespace: default
current-context: lab
users:
- name: lab
  user:
    token: super-secret-token
"#;

    fn kubeconfig_settings(context: Option<&str>) -> KubernetesSettings {
        KubernetesSettings {
            connection: KubernetesConnection::Kubeconfig,
            context: context.map(str::to_string),
            ..settings()
        }
    }

    #[test]
    fn new_validates_without_touching_the_network() {
        // 192.0.2.1 is TEST-NET-1: any connection attempt would hang or
        // fail. `new` is synchronous, so it cannot have tried.
        let provider = KubernetesProvider::new(
            kubeconfig_settings(None),
            Some(KUBECONFIG.into()),
            DEPLOYMENT,
        )
        .unwrap();
        assert!(!provider.client.initialized());
        assert_eq!(RemoteProvisioner::kind(&*provider), "kubernetes");
        assert!(provider.egress_enforced(EgressTier::Off));
        assert!(!provider.egress_enforced(EgressTier::Allowlist));
        assert!(provider.may_receive_registry_credentials("ghcr.io"));
        let debug = format!("{provider:?}");
        assert!(!debug.contains("super-secret-token"), "{debug}");

        let named = KubernetesProvider::new(
            kubeconfig_settings(Some("lab")),
            Some(KUBECONFIG.into()),
            DEPLOYMENT,
        );
        assert!(named.is_ok());
        let in_cluster = KubernetesProvider::new(settings(), None, DEPLOYMENT).unwrap();
        assert!(!in_cluster.client.initialized());
    }

    #[test]
    fn new_refuses_inconsistent_credentials() {
        let error =
            KubernetesProvider::new(settings(), Some(KUBECONFIG.into()), DEPLOYMENT).unwrap_err();
        assert!(error.contains("in-cluster"), "{error}");
        for missing in [None, Some("   ".to_string())] {
            let error = KubernetesProvider::new(kubeconfig_settings(None), missing, DEPLOYMENT)
                .unwrap_err();
            assert!(error.contains("none was supplied"), "{error}");
        }
        let error = KubernetesProvider::new(
            kubeconfig_settings(None),
            Some("users: [token: super-secret-token".into()),
            DEPLOYMENT,
        )
        .unwrap_err();
        assert!(!error.contains("super-secret-token"), "{error}");
        let error = KubernetesProvider::new(
            kubeconfig_settings(Some("prod")),
            Some(KUBECONFIG.into()),
            DEPLOYMENT,
        )
        .unwrap_err();
        assert!(error.contains("no context named \"prod\""), "{error}");
        let no_current = KUBECONFIG.replace("current-context: lab", "");
        let error =
            KubernetesProvider::new(kubeconfig_settings(None), Some(no_current), DEPLOYMENT)
                .unwrap_err();
        assert!(error.contains("current context"), "{error}");
        let error = KubernetesProvider::new(settings(), None, "bad deployment id").unwrap_err();
        assert!(error.contains("deployment id"), "{error}");
        let mut bad = settings();
        bad.namespace = "Bad".into();
        assert!(KubernetesProvider::new(bad, None, DEPLOYMENT).is_err());
    }

    #[tokio::test]
    async fn a_client_that_cannot_be_built_is_a_fault_and_is_retried() {
        // Outside a cluster the in-cluster configuration is absent.
        if std::env::var_os("KUBERNETES_SERVICE_HOST").is_some() {
            return;
        }
        let provider = KubernetesProvider::new(settings(), None, DEPLOYMENT).unwrap();
        for _ in 0..2 {
            let error = provider.tiers().await.unwrap_err();
            assert_eq!(error.kind, SandboxErrorKind::Fault);
            assert_eq!(error.code, "sandbox_provider_unreachable");
            assert!(error.message.contains("in-cluster"), "{}", error.message);
            assert!(
                !provider.client.initialized(),
                "a failed build is not remembered"
            );
        }
        let error = provider.labels(NAME).await.unwrap_err();
        assert!(error.contains("in-cluster"), "{error}");
    }

    #[tokio::test]
    async fn a_kubeconfig_client_is_built_on_first_use() {
        let provider = KubernetesProvider::new(
            kubeconfig_settings(None),
            Some(KUBECONFIG.into()),
            DEPLOYMENT,
        )
        .unwrap();
        provider
            .apis()
            .await
            .expect("building a client does no I/O");
        assert!(provider.client.initialized());
    }

    // -- API paths against an in-process API server ---------------------------

    mod mock {
        use std::collections::{BTreeMap, BTreeSet, VecDeque};
        use std::sync::Arc;

        use axum::body::Bytes;
        use axum::extract::State;
        use axum::http::{Method, StatusCode, Uri};
        use axum::response::{IntoResponse, Response};
        use parking_lot::Mutex;
        use serde_json::{json, Value};

        #[derive(Default)]
        pub struct Cluster {
            pub pods: BTreeMap<String, Value>,
            /// Statuses served on successive reads of a pod; the last sticks.
            pub statuses: VecDeque<Value>,
            pub create_error: Option<(u16, &'static str, String)>,
            pub fail_everything: Option<u16>,
            pub secrets: BTreeMap<String, Value>,
            pub policies: BTreeMap<String, Value>,
            pub cilium: BTreeMap<String, Value>,
            pub runtime_classes: BTreeSet<String>,
            /// `/version`'s minor component; 32 when unset.
            pub server_minor: Option<&'static str>,
            pub log: Vec<String>,
            pub next_uid: u64,
        }

        pub type Shared = Arc<Mutex<Cluster>>;

        fn status(code: u16, reason: &str, message: &str) -> Response {
            (
                StatusCode::from_u16(code).unwrap(),
                [("content-type", "application/json")],
                json!({
                    "kind": "Status",
                    "apiVersion": "v1",
                    "metadata": {},
                    "status": "Failure",
                    "message": message,
                    "reason": reason,
                    "code": code,
                })
                .to_string(),
            )
                .into_response()
        }

        fn ok(code: StatusCode, value: &Value) -> Response {
            (
                code,
                [("content-type", "application/json")],
                value.to_string(),
            )
                .into_response()
        }

        fn matches(selector: &str, object: &Value) -> bool {
            selector
                .split(',')
                .filter(|term| !term.is_empty())
                .all(|term| {
                    let (key, value) = term.split_once('=').unwrap_or((term, ""));
                    object["metadata"]["labels"][key] == json!(value)
                })
        }

        fn apply(
            store: &mut BTreeMap<String, Value>,
            next_uid: &mut u64,
            name: &str,
            body: &Bytes,
        ) -> Response {
            let mut object: Value = serde_json::from_slice(body).expect("apply body is JSON");
            *next_uid += 1;
            object["metadata"]["uid"] = json!(format!("uid-{next_uid}"));
            store.insert(name.to_string(), object.clone());
            ok(StatusCode::OK, &object)
        }

        fn remove(store: &mut BTreeMap<String, Value>, name: &str) -> Response {
            match store.remove(name) {
                Some(object) => ok(StatusCode::OK, &object),
                None => status(404, "NotFound", &format!("{name} not found")),
            }
        }

        async fn handle(
            State(cluster): State<Shared>,
            method: Method,
            uri: Uri,
            body: Bytes,
        ) -> Response {
            let mut guard = cluster.lock();
            let c = &mut *guard;
            c.log.push(format!(
                "{method} {}",
                uri.path_and_query().map(|p| p.as_str()).unwrap_or("")
            ));
            if let Some(code) = c.fail_everything {
                return status(code, "InternalError", "the API server is down");
            }
            let query: BTreeMap<String, String> =
                url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
                    .into_owned()
                    .collect();
            let segments: Vec<&str> = uri.path().trim_start_matches('/').split('/').collect();
            match (method, segments.as_slice()) {
                (Method::POST, ["api", "v1", "namespaces", _, "pods"]) => {
                    if let Some((code, reason, message)) = c.create_error.clone() {
                        return status(code, reason, &message);
                    }
                    let mut pod: Value = serde_json::from_slice(&body).unwrap();
                    let name = pod["metadata"]["name"].as_str().unwrap().to_string();
                    if c.pods.contains_key(&name) {
                        return status(
                            409,
                            "AlreadyExists",
                            &format!("pods \"{name}\" already exists"),
                        );
                    }
                    c.next_uid += 1;
                    pod["metadata"]["uid"] = json!(format!("uid-{}", c.next_uid));
                    pod["status"] = c
                        .statuses
                        .front()
                        .cloned()
                        .unwrap_or(json!({ "phase": "Pending" }));
                    c.pods.insert(name, pod.clone());
                    ok(StatusCode::CREATED, &pod)
                }
                (Method::GET, ["api", "v1", "namespaces", _, "pods"]) => {
                    let selector = query.get("labelSelector").cloned().unwrap_or_default();
                    let items: Vec<Value> = c
                        .pods
                        .values()
                        .filter(|pod| matches(&selector, pod))
                        .cloned()
                        .collect();
                    ok(
                        StatusCode::OK,
                        &json!({ "apiVersion": "v1", "kind": "PodList", "metadata": {}, "items": items }),
                    )
                }
                (Method::GET, ["api", "v1", "namespaces", _, "pods", name]) => {
                    let next = if c.statuses.len() > 1 {
                        c.statuses.pop_front()
                    } else {
                        c.statuses.front().cloned()
                    };
                    match c.pods.get_mut(*name) {
                        Some(pod) => {
                            if let Some(next) = next {
                                pod["status"] = next;
                            }
                            ok(StatusCode::OK, pod)
                        }
                        None => status(404, "NotFound", &format!("pods \"{name}\" not found")),
                    }
                }
                (Method::DELETE, ["api", "v1", "namespaces", _, "pods", name]) => {
                    remove(&mut c.pods, name)
                }
                (Method::PATCH, ["api", "v1", "namespaces", _, "secrets", name]) => {
                    apply(&mut c.secrets, &mut c.next_uid, name, &body)
                }
                (
                    Method::PATCH,
                    ["apis", "networking.k8s.io", "v1", "namespaces", _, "networkpolicies", name],
                ) => apply(&mut c.policies, &mut c.next_uid, name, &body),
                (
                    Method::DELETE,
                    ["apis", "networking.k8s.io", "v1", "namespaces", _, "networkpolicies", name],
                ) => remove(&mut c.policies, name),
                (
                    Method::PATCH,
                    ["apis", "cilium.io", "v2", "namespaces", _, "ciliumnetworkpolicies", name],
                ) => apply(&mut c.cilium, &mut c.next_uid, name, &body),
                (
                    Method::DELETE,
                    ["apis", "cilium.io", "v2", "namespaces", _, "ciliumnetworkpolicies", name],
                ) => remove(&mut c.cilium, name),
                (Method::GET, ["apis", "node.k8s.io", "v1", "runtimeclasses", name]) => {
                    if c.runtime_classes.contains(*name) {
                        ok(
                            StatusCode::OK,
                            &json!({ "apiVersion": "node.k8s.io/v1", "kind": "RuntimeClass", "metadata": { "name": name }, "handler": "runsc" }),
                        )
                    } else {
                        status(
                            404,
                            "NotFound",
                            &format!("runtimeclasses \"{name}\" not found"),
                        )
                    }
                }
                (Method::GET, ["version"]) => {
                    let minor = c.server_minor.unwrap_or("32");
                    ok(
                        StatusCode::OK,
                        &json!({
                            "major": "1",
                            "minor": minor,
                            "gitVersion": format!("v1.{}.0", minor.trim_end_matches('+')),
                            "gitCommit": "0",
                            "gitTreeState": "clean",
                            "buildDate": "2026-01-01T00:00:00Z",
                            "goVersion": "go1.25",
                            "compiler": "gc",
                            "platform": "linux/amd64",
                        }),
                    )
                }
                _ => status(404, "NotFound", "no such route"),
            }
        }

        pub fn client(cluster: Shared) -> kube::Client {
            let router = axum::Router::new().fallback(handle).with_state(cluster);
            kube::Client::new(router, "sbx")
        }
    }

    fn cluster() -> mock::Shared {
        Arc::new(parking_lot::Mutex::new(mock::Cluster::default()))
    }

    fn provider_with(cluster: &mock::Shared, settings: KubernetesSettings) -> KubernetesProvider {
        KubernetesProvider::from_client(
            mock::client(cluster.clone()),
            settings,
            DEPLOYMENT,
            Duration::from_millis(1),
        )
    }

    fn provider(cluster: &mock::Shared) -> KubernetesProvider {
        provider_with(cluster, settings())
    }

    fn requests(cluster: &mock::Shared, prefix: &str) -> Vec<String> {
        cluster
            .lock()
            .log
            .iter()
            .filter(|line| line.starts_with(prefix))
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn provisioning_creates_the_pod_and_its_policy_then_waits_for_it() {
        let cluster = cluster();
        cluster.lock().statuses = VecDeque::from([
            json!({ "phase": "Pending" }),
            json!({ "phase": "Pending", "initContainerStatuses": staged_inits() }),
            running_status(),
        ]);
        let provider = provider(&cluster);
        let mut req = request();
        req.registry_auth = Some(basic("ghcr.io", "alice"));
        req.bundle_registry_auth = Some(basic("ghcr.io", "alice"));
        assert_eq!(provider.provision(&req).await.unwrap(), NAME);

        let state = cluster.lock();
        let pod = &state.pods[NAME];
        let secret = pull_secret_name(&basic("ghcr.io", "alice"));
        // One secret serves both pulls from the same registry and user.
        assert_eq!(
            state.secrets.keys().cloned().collect::<Vec<_>>(),
            vec![secret.clone()]
        );
        assert_eq!(pod["spec"]["imagePullSecrets"], json!([{ "name": secret }]));
        let policy = &state.policies[NAME];
        assert_eq!(
            policy["metadata"]["ownerReferences"][0]["uid"],
            pod["metadata"]["uid"]
        );
        assert!(
            policy["spec"]["egress"].is_array(),
            "egress on gets the all-but-metadata policy"
        );
        assert!(state.cilium.is_empty());
        drop(state);
        assert!(requests(&cluster, "PATCH /api/v1/namespaces/sbx/secrets/")
            .iter()
            .all(|line| line.contains("fieldManager=cognia-sandbox-pool")));
        assert!(
            requests(&cluster, "DELETE").is_empty(),
            "nothing is cleaned up on success"
        );
    }

    #[tokio::test]
    async fn an_egress_off_instance_gets_deny_all_and_cilium_gets_fqdns() {
        let cluster = cluster();
        cluster.lock().statuses = VecDeque::from([running_status()]);
        let mut req = request();
        req.egress = plan(EgressTier::Off, &[]);
        provider(&cluster).provision(&req).await.unwrap();
        assert!(cluster.lock().policies[NAME]["spec"]
            .get("egress")
            .is_none());

        let cluster = cluster_running();
        let mut cilium = settings();
        cilium.egress = KubernetesEgressMode::Cilium;
        let mut req = request();
        req.egress = plan(EgressTier::Allowlist, &["github.com"]);
        provider_with(&cluster, cilium)
            .provision(&req)
            .await
            .unwrap();
        {
            let state = cluster.lock();
            assert!(state.policies.is_empty());
            assert_eq!(
                state.cilium[NAME]["spec"]["egress"][1]["toFQDNs"],
                json!([{ "matchName": "github.com" }])
            );
        }

        let none = cluster_running();
        let mut unenforced = settings();
        unenforced.egress = KubernetesEgressMode::None;
        let mut req = request();
        req.egress = plan(EgressTier::Off, &[]);
        provider_with(&none, unenforced)
            .provision(&req)
            .await
            .unwrap();
        assert!(none.lock().policies.is_empty() && none.lock().cilium.is_empty());
    }

    fn cluster_running() -> mock::Shared {
        let cluster = cluster();
        cluster.lock().statuses = VecDeque::from([running_status()]);
        cluster
    }

    async fn provision_failure(statuses: Vec<Value>) -> (SandboxSpawnError, mock::Shared) {
        let cluster = cluster();
        cluster.lock().statuses = VecDeque::from(statuses);
        let error = provider(&cluster).provision(&request()).await.unwrap_err();
        (error, cluster)
    }

    #[tokio::test]
    async fn an_unpullable_image_is_refused_and_the_pod_deleted() {
        let (error, cluster) = provision_failure(vec![
            json!({ "phase": "Pending" }),
            json!({
                "phase": "Pending",
                "initContainerStatuses": staged_inits(),
                "containerStatuses": [container_status(SANDBOX_CONTAINER, json!({ "waiting": { "reason": "ImagePullBackOff" } }))],
            }),
        ])
        .await;
        assert_eq!(
            (error.kind, error.code.as_str()),
            (SandboxErrorKind::Refused, "sandbox_image_unavailable")
        );
        let state = cluster.lock();
        assert!(state.pods.is_empty(), "the failed pod is deleted");
        assert!(state.policies.is_empty(), "its policy goes with it");
        drop(state);
        assert!(requests(&cluster, "DELETE /api/v1/namespaces/sbx/pods/").len() == 1);
    }

    #[tokio::test]
    async fn a_failed_staging_step_is_refused_and_cleaned_up() {
        let (error, cluster) = provision_failure(vec![json!({
            "phase": "Failed",
            "initContainerStatuses": [container_status("bundle-core", json!({ "terminated": { "exitCode": 1 } }))],
        })])
        .await;
        assert_eq!(error.code, "sandbox_bundle_unsupported");
        assert!(cluster.lock().pods.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn an_unschedulable_pod_times_out_as_capacity() {
        let (error, cluster) = provision_failure(vec![json!({
            "phase": "Pending",
            "conditions": [{ "type": "PodScheduled", "status": "False", "reason": "Unschedulable", "message": "insufficient memory" }],
        })])
        .await;
        assert_eq!(
            (error.kind, error.code.as_str()),
            (SandboxErrorKind::Fault, "sandbox_provider_capacity")
        );
        assert!(
            error.message.contains("insufficient memory"),
            "{}",
            error.message
        );
        assert!(cluster.lock().pods.is_empty());
    }

    #[tokio::test]
    async fn create_failures_are_classified_and_leave_nothing_behind() {
        let quota = cluster();
        quota.lock().create_error = Some((
            403,
            "Forbidden",
            "pods is forbidden: exceeded quota: sandboxes".into(),
        ));
        let error = provider(&quota).provision(&request()).await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_capacity");
        assert!(requests(&quota, "DELETE").is_empty());

        let down = cluster();
        down.lock().create_error = Some((503, "ServiceUnavailable", "etcd is unavailable".into()));
        let error = provider(&down).provision(&request()).await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unreachable");

        let all_down = cluster();
        all_down.lock().fail_everything = Some(500);
        let mut req = request();
        req.registry_auth = Some(basic("ghcr.io", "alice"));
        let error = provider(&all_down).provision(&req).await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_unreachable");
        assert!(error.message.contains("pull secret"), "{}", error.message);
    }

    #[tokio::test]
    async fn an_existing_instance_of_the_same_name_is_never_touched() {
        let cluster = cluster_running();
        let p = provider(&cluster);
        p.provision(&request()).await.unwrap();
        let error = p.provision(&request()).await.unwrap_err();
        assert_eq!(
            (error.kind, error.code.as_str()),
            (SandboxErrorKind::Fault, "sandbox_provider_rejected")
        );
        assert!(
            error.message.contains("already exists"),
            "{}",
            error.message
        );
        assert!(
            cluster.lock().pods.contains_key(NAME),
            "the existing pod survives"
        );
        assert!(
            cluster.lock().policies.contains_key(NAME),
            "and keeps its policy"
        );
    }

    #[tokio::test]
    async fn an_unmapped_tier_is_refused_before_any_request() {
        let cluster = cluster();
        let mut req = request();
        req.tier = IsolationTier::Vm;
        let error = provider(&cluster).provision(&req).await.unwrap_err();
        assert_eq!(error.code, "isolation_tier_unavailable");
        assert!(cluster.lock().log.is_empty());
    }

    #[tokio::test]
    async fn labels_and_inspection_decode_the_annotation() {
        let cluster = cluster_running();
        let p = provider(&cluster);
        p.provision(&request()).await.unwrap();

        let labels = p.labels(NAME).await.unwrap().unwrap();
        assert_eq!(labels, driver_labels());
        assert!(is_owned(&labels));
        assert_eq!(p.labels("cognia-missing").await.unwrap(), None);

        let state = p.inspect_runtime(NAME).await.unwrap().unwrap();
        assert!(state.running);
        assert_eq!(state.labels, driver_labels());
        assert_eq!(p.inspect_runtime("cognia-missing").await.unwrap(), None);
        cluster.lock().statuses = VecDeque::from([json!({ "phase": "Succeeded" })]);
        assert!(!p.inspect_runtime(NAME).await.unwrap().unwrap().running);
    }

    #[tokio::test]
    async fn list_owned_selects_this_deployment_only() {
        let cluster = cluster_running();
        provider(&cluster).provision(&request()).await.unwrap();
        // Another deployment's instance in the same namespace.
        let other = KubernetesProvider::from_client(
            mock::client(cluster.clone()),
            settings(),
            "deployment-b",
            Duration::from_millis(1),
        );
        let mut foreign = request();
        foreign.name = "cognia-deployment-b-0123".into();
        foreign
            .labels
            .insert(DEPLOYMENT_LABEL.into(), "deployment-b".into());
        other.provision(&foreign).await.unwrap();

        let owned = provider(&cluster).list_owned().await.unwrap();
        assert_eq!(owned.len(), 1);
        assert_eq!(owned[0].id, NAME);
        assert_eq!(owned[0].deployment(), Some(DEPLOYMENT));
        assert_eq!(owned[0].labels, driver_labels());
        let listed = requests(&cluster, "GET /api/v1/namespaces/sbx/pods?");
        let selector = format!(
            "{OWNER_LABEL}={OWNER_VALUE},{DEPLOYMENT_SELECTOR_LABEL}={}",
            deployment_selector(DEPLOYMENT)
        );
        let encoded: String = url::form_urlencoded::byte_serialize(selector.as_bytes()).collect();
        assert!(
            listed.iter().any(|line| line.contains(&encoded)),
            "{listed:?}"
        );
    }

    #[tokio::test]
    async fn a_damaged_pod_does_not_hide_the_others() {
        let cluster = cluster_running();
        let p = provider(&cluster);
        p.provision(&request()).await.unwrap();
        let mut second = request();
        second.name = "cognia-deployment-a-second".into();
        p.provision(&second).await.unwrap();
        cluster
            .lock()
            .pods
            .get_mut("cognia-deployment-a-second")
            .unwrap()["metadata"]["annotations"][LABELS_ANNOTATION] = json!("{broken");
        let owned = p.list_owned().await.unwrap();
        assert_eq!(
            owned.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            vec![NAME]
        );
        assert!(p.labels("cognia-deployment-a-second").await.is_err());
    }

    #[tokio::test]
    async fn deletion_is_idempotent() {
        let cluster = cluster_running();
        let p = provider(&cluster);
        p.provision(&request()).await.unwrap();
        p.kill(NAME).await.unwrap();
        assert!(cluster.lock().pods.is_empty());
        p.kill(NAME).await.unwrap();
        p.remove(NAME).await.unwrap();
        p.stop_runtime(NAME).await.unwrap();
        cluster.lock().fail_everything = Some(500);
        assert!(p.remove(NAME).await.is_err());
    }

    #[tokio::test]
    async fn tiers_attest_only_runtime_classes_that_exist() {
        let cluster = cluster();
        cluster.lock().runtime_classes = BTreeSet::from(["gvisor".to_string()]);
        let mut mapped = settings();
        mapped.runtime_classes = RuntimeClassMap {
            gvisor: Some("gvisor".into()),
            vm: Some("kata".into()),
            container: None,
        };
        let p = provider_with(&cluster, mapped.clone());
        assert_eq!(
            p.tiers().await.unwrap(),
            vec![IsolationTier::Container, IsolationTier::Gvisor]
        );
        assert_eq!(
            p.runtimes().await.unwrap(),
            vec!["gvisor".to_string(), "kata".to_string()]
        );

        mapped.runtime_classes.container = Some("missing".into());
        let p = provider_with(&cluster, mapped);
        assert_eq!(p.tiers().await.unwrap(), vec![IsolationTier::Gvisor]);

        cluster.lock().server_minor = Some("29");
        let error = p.tiers().await.unwrap_err();
        assert_eq!(error.code, "sandbox_provider_rejected");
        cluster.lock().server_minor = Some("31+");
        assert!(p.tiers().await.is_ok());

        cluster.lock().fail_everything = Some(503);
        let error = p.tiers().await.unwrap_err();
        assert_eq!(
            (error.kind, error.code.as_str()),
            (SandboxErrorKind::Fault, "sandbox_provider_unreachable")
        );
    }

    #[tokio::test]
    async fn the_container_surface_refuses_what_a_cluster_does_not_have() {
        let p = provider(&cluster());
        assert!(p
            .start_runtime(NAME)
            .await
            .unwrap_err()
            .contains("re-provisions"));
        assert!(p.ensure_volume("v", &BTreeMap::new()).await.is_err());
        assert_eq!(p.list_owned_volumes().await.unwrap(), Vec::new());
        assert_eq!(p.remove_volume("v").await.unwrap(), VolumeRemoval::Gone);
        assert!(p.pull_image("ghcr.io/acme/env@sha256:x").await.is_err());
        assert!(p
            .pull_image_with_auth("ghcr.io/acme/env@sha256:x", None)
            .await
            .is_err());
        let spec = RunnerSpec {
            workspace_env: BTreeMap::new(),
            name: "x".into(),
            image: "x".into(),
            cmd: Vec::new(),
            env: Vec::new(),
            working_dir: "/".into(),
            mount: None,
            seccomp_json: None,
            memory_bytes: 0,
            nano_cpus: 0,
            pids_limit: 0,
            network_mode: String::new(),
            labels: BTreeMap::new(),
            entrypoint: None,
            user: None,
            extra_mounts: Vec::new(),
            runtime: None,
            cap_drop: Vec::new(),
            cap_add: Vec::new(),
            read_only_rootfs: false,
            tmpfs: Vec::new(),
            writable_dirs: Vec::new(),
        };
        match ContainerApi::run(&p, spec).await {
            Err(RunnerRunError::Other(message)) => {
                assert!(message.contains("provision"), "{message}")
            }
            _ => panic!("run must be refused"),
        }
    }
}
