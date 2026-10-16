//! Authenticated Host routing for ADR-0228. Caller identity is never RPC data.
use std::{path::{Path, PathBuf}, sync::Arc, time::Duration};

use async_trait::async_trait;
use cognia_automation::automation::{
    dispatcher::{run_gated_enf, Enforcement, GateContext},
    permission::Surface,
    session::UiAction,
    types::{AutomationError, Point},
};
use cognia_automation::cua_sandbox::managed::{
    provider::{DesktopSecrets, ProviderSecret},
    *,
};
use cognia_companion::{host_identity, security_store::security_store};
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::Value;

pub(crate) const SECRET_SERVICE: &str = "cognia-managed-desktops";
pub const COMMANDS: &[&str] = &[
    "managed_desktop_results_get_results",
    "managed_desktop_results_get_result",
    "managed_desktop_results_read_evidence",
    "managed_desktop_results_approve",
    "managed_desktop_results_capture",
    "managed_desktop_results_complete",
    "managed_desktop_results_prepare_delete",
    "managed_desktop_results_commit_delete",
    "managed_desktop_results_abort_delete",

    "managed_desktop_handoff_source_host",
    "managed_desktop_handoff_deliveries",
    "managed_desktop_handoff_prepare",
    "managed_desktop_handoff_revoke_source",
    "managed_desktop_list_configs",
    "managed_desktop_list",
    "managed_desktop_quote",
    "managed_desktop_authorize",
    "managed_desktop_prepare_template",
    "managed_desktop_create",
    "managed_desktop_connect",
    "managed_desktop_health",
    "managed_desktop_delete",
    "managed_desktop_control_status",
    "managed_desktop_control_frame",
    "managed_desktop_control_acquire",
    "managed_desktop_control_renew",
    "managed_desktop_control_release",
    "managed_desktop_control_input",
];

pub type HostEventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub type AdminAuthorityCheck = Arc<dyn Fn() -> Result<()> + Send + Sync>;
pub struct ManagedControlRuntime {
    pub enforcement: Enforcement,
    pub events: HostEventSink,
    pub refresh_persisted: bool,
}
static HEADLESS_ENFORCEMENT: Lazy<Enforcement> = Lazy::new(|| Enforcement {
    gate: cognia_automation::automation::permission::PermissionGate::new(Default::default()),
    audit: cognia_automation::automation::audit::AuditRing::new(),
    consent: cognia_automation::automation::consent::ConsentBroker::new(),
    policy: Default::default(),
    consent_event_sink: None,
});

#[derive(Default)]
struct HeadlessPolicySnapshot {
    version: u64,
    fingerprint: Vec<u8>,
    available: bool,
}
static HEADLESS_POLICY_SNAPSHOT: Lazy<RwLock<HeadlessPolicySnapshot>> = Lazy::new(Default::default);
static HEADLESS_POLICY_REFRESH: Lazy<parking_lot::Mutex<()>> = Lazy::new(Default::default);

/// File reads and regex compilation belong on the blocking pool, never the
/// websocket command pump. Refreshes serialize so an older read cannot replace
/// a newer snapshot. Publishing invalidates in-flight actions before replacing
/// either shared enforcement component.
async fn refresh_headless_policy() -> Result<()> {
    tokio::task::spawn_blocking(|| {
        let _refresh = HEADLESS_POLICY_REFRESH.lock();
        let result = (|| {
            let policy = cognia_automation::automation::persist::load_policy_state_strict()
                .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?;
            let settings = cognia_automation::automation::persist::load_settings();
            let raw_policy = policy.get();
            let fingerprint = serde_json::to_vec(&(&settings, &raw_policy))
                .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?;
            {
                let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
                if snapshot.available && snapshot.fingerprint == fingerprint {
                    return Ok(());
                }
                snapshot.version = snapshot.version.saturating_add(1);
                snapshot.available = false;
            }
            // Compiling here remains off the async executor; guards see the
            // unavailable version and fail closed during the publication.
            HEADLESS_ENFORCEMENT
                .policy
                .set(raw_policy)
                .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?;
            HEADLESS_ENFORCEMENT
                .gate
                .update(|current| *current = settings);
            let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
            snapshot.fingerprint = fingerprint;
            snapshot.available = true;
            Ok(())
        })();
        if result.is_err() {
            let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
            snapshot.version = snapshot.version.saturating_add(1);
            snapshot.available = false;
        }
        result
    })
    .await
    .map_err(|_| refused("managed_desktop_control_policy_unavailable"))?
}

/// Admission refreshes persisted policy; queued sends inspect only its current
/// in-memory version. A changed/corrupt snapshot fences the admitted action.
pub async fn headless_control_runtime(events: HostEventSink) -> Result<ManagedControlRuntime> {
    refresh_headless_policy().await?;
    Ok(ManagedControlRuntime {
        enforcement: HEADLESS_ENFORCEMENT.clone(),
        events,
        refresh_persisted: true,
    })
}

struct Installed {
    directory: PathBuf,
    service: Arc<ManagedDesktopService>,
    host_id: String,
    worker: tokio::task::JoinHandle<()>,
}
impl Drop for Installed {
    fn drop(&mut self) {
        self.worker.abort();
    }
}
static INSTALLED: Lazy<RwLock<Option<Installed>>> = Lazy::new(|| RwLock::new(None));

pub(crate) struct HostSecrets;
async fn secret_io<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|_| refused("managed_desktop_secret_unavailable"))?
}
#[async_trait]
impl ManagedDesktopSecrets for HostSecrets {
    async fn provider_key(&self, config: &ManagedDesktopConfig) -> Result<ProviderSecret> {
        let reference = config.secret_ref();
        secret_io(move || {
            let key = cognia_secrets::secret_store::get(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .filter(|key| !key.is_empty())
                .ok_or_else(|| refused("managed_desktop_missing_credentials"))?;
            Ok(ProviderSecret(key))
        })
        .await
    }
    async fn desktop(&self, id: &str) -> Result<DesktopSecrets> {
        let reference = format!("desktop:{id}");
        secret_io(move || {
            let value = cognia_secrets::secret_store::get(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))?
                .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?;
            serde_json::from_str(&value).map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
    async fn put_desktop(&self, id: &str, secret: &DesktopSecrets) -> Result<()> {
        let reference = format!("desktop:{id}");
        let value = serde_json::to_string(secret)
            .map_err(|_| refused("managed_desktop_secret_unavailable"))?;
        secret_io(move || {
            cognia_secrets::secret_store::set(SECRET_SERVICE, &reference, &value)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
    async fn remove_desktop(&self, id: &str) -> Result<()> {
        let reference = format!("desktop:{id}");
        secret_io(move || {
            cognia_secrets::secret_store::delete(SECRET_SERVICE, &reference)
                .map_err(|_| refused("managed_desktop_secret_unavailable"))
        })
        .await
    }
}

/// Installs even without a release: reads and old-resource cleanup must work
/// while new provisioning is disabled. Startup never builds a template.
pub async fn install(directory: &Path, host_id: &str) -> Result<()> {
    let directory = directory.to_owned();
    let installed_directory = directory.clone();
    let identity = host_id.to_owned();
    let service = tokio::task::spawn_blocking(move || {
        let release = match crate::managed_desktop_release::load(&directory) {
            Ok(release) => release,
            Err(error) => {
                log::warn!("managed desktop release: {}", error.code);
                None
            }
        };
        let provider = Arc::new(E2bDesktopProvider::new(Arc::new(
            crate::managed_desktop_release::OciDesktopImageVerifier,
        )));
        ManagedDesktopService::open(
            &directory,
            identity,
            provider,
            Arc::new(HostSecrets),
            release,
        )
        .map(Arc::new)
    })
    .await
    .map_err(|_| refused("managed_desktop_storage_unavailable"))??;
    let weak = Arc::downgrade(&service);
    let evidence_directory = installed_directory.clone();
    let evidence_host = host_id.to_owned();
    let worker = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(service) = weak.upgrade() else { break };
            if let Err(error) = crate::managed_desktop_results::reconcile(&evidence_directory, &service, &evidence_host).await {
                log::warn!("managed desktop evidence reconciliation: {}", error.code);
            }
            if let Err(error) = service.reconcile().await {
                log::warn!("managed desktop reconciliation: {}", error.code);
            }
        }
    });
    *INSTALLED.write() = Some(Installed {
        directory: installed_directory,
        service,
        host_id: host_id.into(),
        worker,
    });
    Ok(())
}

pub fn shutdown() {
    INSTALLED.write().take();
}

/// Created solely by native IPC or the already-authenticated RPC dispatcher.
#[derive(Clone, Copy)]
pub struct Caller<'a> {
    pub device_id: &'a str,
    pub tenant_id: Option<&'a str>,
    pub scope: Option<&'a str>,
    pub local: bool,
}

struct HostAuthority<'a> {
    caller: Caller<'a>,
    host_id: &'a str,
    admin_check: Option<AdminAuthorityCheck>,
    input_policy: Option<&'a InputPolicyGuard>,
    // Native diagnostics observe the real command-pump decision; never override it.
    admission_observer: Option<Arc<dyn Fn(bool) + Send + Sync>>,
}
#[async_trait]
impl ManagedControlAuthority for HostAuthority<'_> {
    fn input_admission(
        &self,
        expected: &ManagedDesktopPrincipal,
    ) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let device_id = self.caller.device_id.to_owned();
        let tenant_id = self.caller.tenant_id.map(str::to_owned);
        let scope = self.caller.scope.map(str::to_owned);
        let local = self.caller.local;
        let host_id = self.host_id.to_owned();
        let expected = expected.clone();
        let admin_check = self.admin_check.clone();
        let input_policy = self.input_policy.cloned();
        let observer = self.admission_observer.clone();
        Arc::new(move || {
            if admin_check.as_ref().is_some_and(|check| check().is_err())
                || input_policy
                    .as_ref()
                    .is_some_and(|policy| policy.check().is_err())
            {
                if let Some(observer) = &observer { observer(false); }
                return false;
            }
            let caller = Caller {
                device_id: &device_id,
                tenant_id: tenant_id.as_deref(),
                scope: scope.as_deref(),
                local,
            };
            let admitted = principal(&caller, &host_id).is_ok_and(|current| {
                current.owner_principal_id == expected.owner_principal_id
                    && current.principal_id == expected.principal_id
                    && current.host_id == expected.host_id
                    && current.authority == expected.authority
                    && current.require_human().is_ok()
            });
            if let Some(observer) = &observer { observer(admitted); }
            admitted
        })
    }
    async fn revalidate(&self, expected: &ManagedDesktopPrincipal) -> Result<()> {
        if let Some(policy) = self.input_policy {
            policy.refresh().await?;
            policy.check()?;
        }
        if let Some(check) = &self.admin_check {
            check()?;
        }
        let current = principal(&self.caller, self.host_id)?;
        if current.owner_principal_id != expected.owner_principal_id
            || current.principal_id != expected.principal_id
            || current.host_id != expected.host_id
            || current.authority != expected.authority
        {
            return Err(refused("managed_desktop_forbidden"));
        }
        Ok(())
    }
}

fn authority(
    local: bool,
    scope: Option<&str>,
    worker: bool,
    owner: bool,
) -> ManagedDesktopAuthority {
    if local {
        return ManagedDesktopAuthority::Administrator;
    }
    if worker || scope == Some("service") {
        return ManagedDesktopAuthority::Agent;
    }
    if scope == Some("owner") || owner {
        return ManagedDesktopAuthority::Administrator;
    }
    // WebRTC carries no scope string, but principal() has already checked
    // its authenticated active paired-device record and worker designation.
    if matches!(scope, None | Some("device" | "oidc")) {
        ManagedDesktopAuthority::Human
    } else {
        ManagedDesktopAuthority::Observer
    }
}

/// The deletion operation holds a live authenticated principal check while its
/// filesystem work is queued. Persisted cleanup later uses its exact receipt.
pub fn task_deletion_admission(caller: Caller<'_>, host: String, owner: Option<String>) -> Arc<dyn Fn() -> bool + Send + Sync> {
    let device_id = caller.device_id.to_owned(); let tenant = caller.tenant_id.map(str::to_owned);
    let scope = caller.scope.map(str::to_owned); let local = caller.local;
    Arc::new(move || principal(&Caller { device_id:&device_id,tenant_id:tenant.as_deref(),scope:scope.as_deref(),local }, &host)
        .is_ok_and(|p| Some(p.owner_principal_id) == owner))
}

fn principal(caller: &Caller<'_>, host_id: &str) -> Result<ManagedDesktopPrincipal> {
    let owner_principal_id = if caller.local {
        let binding =
            host_identity::current().map_err(|_| refused("managed_desktop_account_required"))?;
        host_identity::namespace_for_tenant(&binding.remote_tenant_id)
    } else {
        caller
            .tenant_id
            .and_then(host_identity::namespace_for_tenant)
    }
    .ok_or_else(|| refused("managed_desktop_account_required"))?;
    let (worker, owner) = if !caller.local && !matches!(caller.scope, Some("owner" | "service")) {
        let tenant = caller
            .tenant_id
            .ok_or_else(|| refused("managed_desktop_forbidden"))?;
        let store = security_store().ok_or_else(|| refused("managed_desktop_forbidden"))?;
        let devices = store
            .list_devices(tenant)
            .map_err(|_| refused("managed_desktop_forbidden"))?;
        if !devices
            .iter()
            .any(|d| d.device_id == caller.device_id && d.status == "active")
        {
            return Err(refused("managed_desktop_forbidden"));
        }
        let worker = store
            .list_worker_devices(tenant)
            .map_err(|_| refused("managed_desktop_forbidden"))?
            .iter()
            .any(|d| d.device_id == caller.device_id);
        let owner = store
            .is_owner_device(tenant, caller.device_id)
            .map_err(|_| refused("managed_desktop_forbidden"))?;
        (worker, owner)
    } else {
        (false, false)
    };
    Ok(ManagedDesktopPrincipal {
        owner_principal_id,
        principal_id: caller.device_id.into(),
        host_id: host_id.into(),
        authority: authority(caller.local, caller.scope, worker, owner),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuoteArgs {
    provider_config_id: String,
    lifetime_seconds: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorizeArgs {
    provider_config_id: String,
    quote_id: String,
    action: AuthorizationPurpose,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopArgs {
    desktop_id: String,
    generation: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcquireArgs {
    desktop_id: String,
    generation: u64,
    takeover: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LeaseArgs {
    desktop_id: String,
    generation: u64,
    token: String,
    fence: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputArgs {
    desktop_id: String,
    generation: u64,
    token: String,
    fence: u64,
    frame_id: String,
    #[serde(default, deserialize_with = "input_point")]
    point: Option<Point>,
    #[serde(deserialize_with = "input_action")]
    action: UiAction,
}
fn closed_object(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}
fn input_point<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Point>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if !value.is_null() && !closed_object(&value, &["x", "y"]) {
        return Err(serde::de::Error::custom("invalid managed desktop point"));
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}
fn input_action<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<UiAction, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let fields: &[&str] = match value.get("kind").and_then(Value::as_str) {
        Some("click") => &["kind", "button", "count"],
        Some("drag") => &["kind", "to", "opts"],
        Some("scroll") => &["kind", "opts"],
        Some("pressKey") => &["kind", "chord"],
        Some("typeText") => &["kind", "text"],
        _ => {
            return Err(serde::de::Error::custom(
                "unsupported managed desktop action",
            ))
        }
    };
    if !closed_object(&value, fields) {
        return Err(serde::de::Error::custom("invalid managed desktop action"));
    }
    if let Some(to) = value.get("to") {
        if !closed_object(to, &["x", "y"]) {
            return Err(serde::de::Error::custom("invalid drag destination"));
        }
    }
    if let Some(opts) = value.get("opts") {
        let allowed = if value["kind"] == "drag" {
            &["button", "durationMs", "steps"][..]
        } else {
            &["dx", "dy"][..]
        };
        if !closed_object(opts, allowed) {
            return Err(serde::de::Error::custom("invalid action options"));
        }
    }
    let action: UiAction = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
    let valid = match &action {
        UiAction::Click { count, .. } => count.is_none_or(|count| (1..=3).contains(&count)),
        UiAction::TypeText { text } => text.len() <= 4096,
        UiAction::PressKey { chord } => !chord.0.is_empty() && chord.0.len() <= 256,
        UiAction::Drag { opts, .. } => {
            opts.duration_ms.unwrap_or(150) <= 2000 && opts.steps.unwrap_or(12) <= 60
        }
        _ => true,
    };
    if !valid {
        return Err(serde::de::Error::custom("managed desktop input limit"));
    }
    Ok(action)
}
fn decode<T: serde::de::DeserializeOwned>(args: Value) -> Result<T> {
    serde_json::from_value(args).map_err(|_| refused("managed_desktop_invalid_request"))
}
fn encode<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| refused("managed_desktop_invalid_response"))
}

fn input_command(action: &UiAction) -> Result<&'static str> {
    match action {
        UiAction::Click { .. } => Ok("click"),
        UiAction::Drag { .. } => Ok("drag"),
        UiAction::Scroll { .. } => Ok("scroll"),
        UiAction::PressKey { .. } => Ok("keys"),
        UiAction::TypeText { .. } => Ok("type"),
        _ => Err(refused("managed_desktop_control_unsupported_action")),
    }
}

fn require_verified_target_constraints(enforcement: &Enforcement) -> Result<()> {
    let settings = enforcement.gate.settings();
    let whitelist = settings
        .per_surface
        .computer_use
        .whitelist
        .as_ref()
        .unwrap_or(&settings.whitelist);
    // The cloud driver has no authenticated foreground-window metadata.
    // Missing facts must not turn a configured process/window restriction off.
    let policy = enforcement.policy.get();
    if !whitelist.is_empty()
        || !policy.allowed_process_names.is_empty()
        || !policy.allowed_window_title_patterns.is_empty()
        || !policy.allowed_url_patterns.is_empty()
    {
        return Err(refused("managed_desktop_control_target_unverified"));
    }
    Ok(())
}

#[derive(Clone)]
struct InputPolicyGuard {
    enforcement: Enforcement,
    command: &'static str,
    point: Option<Point>,
    destination: Option<Point>,
    required_consent: bool,
    persisted_version: Option<u64>,
}
impl InputPolicyGuard {
    fn new(
        runtime: &ManagedControlRuntime,
        command: &'static str,
        point: Option<Point>,
        action: &UiAction,
    ) -> Self {
        let call = cognia_automation::automation::permission::Call {
            command,
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: Default::default(),
        };
        Self {
            enforcement: runtime.enforcement.clone(),
            command,
            point,
            destination: match action {
                UiAction::Drag { to, .. } => Some(*to),
                _ => None,
            },
            required_consent: matches!(
                runtime.enforcement.gate.evaluate(&call),
                cognia_automation::automation::permission::Decision::RequireConsent { .. }
            ),
            persisted_version: runtime
                .refresh_persisted
                .then(|| HEADLESS_POLICY_SNAPSHOT.read().version),
        }
    }
    async fn refresh(&self) -> Result<()> {
        if self.persisted_version.is_some() {
            refresh_headless_policy().await?;
        }
        Ok(())
    }
    fn check(&self) -> Result<()> {
        // Hold only an in-memory read lock while checking shared enforcement.
        let snapshot = self
            .persisted_version
            .map(|_| HEADLESS_POLICY_SNAPSHOT.read());
        if let Some(snapshot) = snapshot.as_ref() {
            if !snapshot.available || Some(snapshot.version) != self.persisted_version {
                return Err(refused("managed_desktop_control_policy_changed"));
            }
        }
        require_verified_target_constraints(&self.enforcement)?;
        let call = cognia_automation::automation::permission::Call {
            command: self.command,
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: Default::default(),
        };
        match self.enforcement.gate.evaluate(&call) {
            cognia_automation::automation::permission::Decision::Deny(error) => {
                return Err(policy_error(error))
            }
            cognia_automation::automation::permission::Decision::RequireConsent { .. }
                if !self.required_consent =>
            {
                return Err(refused("managed_desktop_control_consent_required"))
            }
            _ => {}
        }
        let facts = cognia_automation::automation::policy::ActionFacts {
            process_name: None,
            window_title: None,
            target_url: None,
            click_x: self.point.map(|p| p.x),
            click_y: self.point.map(|p| p.y),
        };
        if matches!(
            self.enforcement.policy.evaluate(&facts),
            cognia_automation::automation::policy::Decision::Deny { .. }
        ) {
            return Err(refused("managed_desktop_control_policy_denied"));
        }
        if let Some(to) = self.destination {
            let facts = cognia_automation::automation::policy::ActionFacts {
                click_x: Some(to.x),
                click_y: Some(to.y),
                ..facts
            };
            if matches!(
                self.enforcement.policy.evaluate(&facts),
                cognia_automation::automation::policy::Decision::Deny { .. }
            ) {
                return Err(refused("managed_desktop_control_policy_denied"));
            }
        }
        Ok(())
    }
}

fn policy_error(error: AutomationError) -> ManagedDesktopError {
    let code = match error {
        AutomationError::UserDeclined => "managed_desktop_control_consent_denied",
        AutomationError::KillSwitchActive => "managed_desktop_control_kill_switch",
        AutomationError::BackendError { message } if message.starts_with("managed_desktop_") => {
            return refused(&message)
        }
        _ => "managed_desktop_control_policy_denied",
    };
    refused(code)
}

struct PendingTasks(parking_lot::Mutex<Vec<tokio::task::JoinHandle<()>>>);
impl Drop for PendingTasks {
    fn drop(&mut self) {
        for task in self.0.get_mut().drain(..) {
            task.abort();
        }
    }
}
// Pending and approved states are read under separate shared-store locks.
// A request can become approved between those reads; consume once more before
// treating a disappeared pending request as denial/revocation/expiry.
fn resolve_closed_host_consent(
    broker: &cognia_automation::automation::consent::ConsentBroker,
    id: &str, device: &str, operations: &[String],
) {
    let approved = cognia_companion::host_consent::take_approved(device, operations);
    broker.resolve(id, approved, false, None, None);
}

fn install_host_consent_bridge(
    enforcement: &mut Enforcement,
    events: HostEventSink,
    device_id: String,
    tenant_id: Option<String>,
    target_detail: String,
    command: &'static str,
) -> Arc<PendingTasks> {
    // Grants for local desktop automation must not authorize cloud input.
    enforcement.consent = cognia_automation::automation::consent::ConsentBroker::new();
    let broker = enforcement.consent.clone();
    let tasks = Arc::new(PendingTasks(parking_lot::Mutex::new(Vec::new())));
    let weak_tasks = Arc::downgrade(&tasks);
    enforcement.consent_event_sink = Some(Arc::new(move |event| {
        let operations = vec![format!(
            "managed-desktop:{}:{}:{}",
            target_detail, command, event.id
        )];
        let ask = cognia_companion::host_consent::request(
            &device_id,
            tenant_id.as_deref(),
            operations.clone(),
        );
        events(
            cognia_companion::host_consent::CONSENT_CHANNEL,
            serde_json::to_value(&ask).unwrap_or(Value::Null),
        );
        let broker = broker.clone();
        let device_id = device_id.clone();
        let id = event.id.clone();
        let timeout = Duration::from_millis(event.timeout_ms);
        let request_id = ask.id;
        let task = tokio::spawn(async move {
            let started = tokio::time::Instant::now();
            loop {
                if cognia_companion::host_consent::take_approved(&device_id, &operations) {
                    broker.resolve(&id, true, false, None, None);
                    return;
                }
                // Denial, expiry, revocation and a racing approval all remove
                // the pending ask. Recheck approval before resolving it closed.
                if !cognia_companion::host_consent::pending().iter().any(|request| request.id == request_id) {
                    resolve_closed_host_consent(&broker, &id, &device_id, &operations);
                    return;
                }
                if started.elapsed() >= timeout {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        if let Some(tasks) = weak_tasks.upgrade() {
            tasks.0.lock().push(task);
        } else {
            task.abort();
        }
        Ok(())
    }));
    tasks
}

/// A consent request is a separate authority from the broad admin lease.
/// Use the existing automation pipeline, bridging its prompt to Host consent
/// so a headless Host never assumes a Tauri overlay exists.
async fn execute_input(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    authority: &HostAuthority<'_>,
    a: InputArgs,
    runtime: ManagedControlRuntime,
) -> Result<()> {
    execute_input_inner(service, p, authority, a, runtime, None).await
}

async fn execute_input_inner(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    authority: &HostAuthority<'_>,
    a: InputArgs,
    mut runtime: ManagedControlRuntime,
    smoke: Option<&ExplicitPaidSmokeAuthorization>,
) -> Result<()> {
    let command = input_command(&a.action)?;
    require_verified_target_constraints(&runtime.enforcement)?;
    let policy_guard = InputPolicyGuard::new(&runtime, command, a.point, &a.action);
    let guarded_authority = HostAuthority {
        caller: authority.caller,
        host_id: authority.host_id,
        admin_check: authority.admin_check.clone(),
        input_policy: Some(&policy_guard),
        admission_observer: authority.admission_observer.clone(),
    };
    let authority = &guarded_authority;
    let detail = format!("Managed desktop {}: {}", a.desktop_id, command);
    let tasks = install_host_consent_bridge(
        &mut runtime.enforcement,
        runtime.events,
        p.principal_id.clone(),
        authority.caller.tenant_id.map(str::to_owned),
        format!(
            "{}:generation={}:fence={}",
            a.desktop_id, a.generation, a.fence
        ),
        command,
    );
    let context = GateContext {
        surface: Surface::ComputerUse,
        plugin_id: None,
        process_name: None,
        window_title: None,
        target_url: None,
        click_x: a.point.map(|p| p.x),
        click_y: a.point.map(|p| p.y),
        force_tier: None,
        command_detail: Some(detail),
        session_key: Some(format!(
            "managed:{}:{}:{}",
            p.owner_principal_id, a.desktop_id, a.fence
        )),
    };
    let result = run_gated_enf(None, &runtime.enforcement, context, command, || async {
        authority
            .revalidate(p)
            .await
            .map_err(|error| AutomationError::BackendError {
                message: error.code,
            })?;
        // Consent may have waited while the operator disabled automation.
        let call = cognia_automation::automation::permission::Call {
            command,
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: Default::default(),
        };
        if let cognia_automation::automation::permission::Decision::Deny(error) =
            runtime.enforcement.gate.evaluate(&call)
        {
            return Err(error);
        }
        let delivery = if let Some(permit) = smoke {
            service.control_input_smoke(p, &a.desktop_id, a.generation, &a.token,
                a.fence, &a.frame_id, a.point, a.action, authority, permit).await
        } else {
            service.control_input(p, &a.desktop_id, a.generation, &a.token,
                a.fence, &a.frame_id, a.point, a.action, authority).await
        };
        delivery
            .map_err(|error| AutomationError::BackendError {
                message: error.code,
            })
    })
    .await;
    drop(tasks);
    result.map_err(policy_error)
}

pub async fn dispatch(
    name: &str,
    args: Value,
    caller: Caller<'_>,
    runtime: Option<ManagedControlRuntime>,
    admin_check: Option<AdminAuthorityCheck>,
) -> Result<Value> {
    if !COMMANDS.contains(&name) {
        return Err(refused("managed_desktop_unknown_command"));
    }
    let (service, host_id, directory) = INSTALLED
        .read()
        .as_ref()
        .map(|i| (i.service.clone(), i.host_id.clone(), i.directory.clone()))
        .ok_or_else(|| refused("managed_desktop_host_unavailable"))?;
    let principal = match principal(&caller, &host_id) {
        Ok(principal) => principal,
        Err(error) => {
            service.revoke_control_principal(caller.device_id).await;
            return Err(error);
        }
    };
    if matches!(
        name,
        "managed_desktop_authorize"
            | "managed_desktop_prepare_template"
            | "managed_desktop_create"
            | "managed_desktop_delete"
            | "managed_desktop_control_acquire"
            | "managed_desktop_control_renew"
            | "managed_desktop_control_release"
            | "managed_desktop_control_input"
    ) {
        principal.require_human()?;
        if !caller.local && admin_check.is_none() {
            return Err(refused("managed_desktop_control_admin_lease_expired"));
        }
    }
    let authority = HostAuthority {
        caller,
        host_id: &host_id,
        admin_check,
        input_policy: None,
        admission_observer: None,
    };
    if crate::managed_desktop_results::COMMANDS.contains(&name) {
        return crate::managed_desktop_results::dispatch(&directory, &service, &principal, &authority, name, args).await;
    }
    let result = match name {
        "managed_desktop_handoff_source_host" => {
            if args.as_object().is_none_or(|value| !value.is_empty()) { return Err(refused("managed_desktop_invalid_request")); }
            Ok(serde_json::json!({"hostId": host_id}))
        }
        "managed_desktop_handoff_deliveries" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Empty {}
            let _: Empty = decode(args)?;
            let result = crate::managed_desktop_handoff::list(&directory, &principal).await?;
            authority.revalidate(&principal).await?;
            encode(result)
        }
        "managed_desktop_handoff_prepare" => {
            let result = crate::managed_desktop_handoff::prepare(&directory, &service, &principal, decode(args)?).await?;
            authority.revalidate(&principal).await?;
            encode(result)
        }
        "managed_desktop_handoff_revoke_source" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Revoke { conversation_ids: Vec<String> }
            let request: Revoke = decode(args)?;
            authority.revalidate(&principal).await?;
            crate::managed_desktop_handoff::revoke(&directory, &principal, request.conversation_ids).await?;
            Ok(Value::Null)
        }
        "managed_desktop_list_configs" => encode(service.list_configs(&principal).await?),
        "managed_desktop_list" => encode(service.list(&principal).await?),
        "managed_desktop_quote" => {
            let a: QuoteArgs = decode(args)?;
            encode(
                service
                    .quote(&principal, &a.provider_config_id, a.lifetime_seconds)
                    .await?,
            )
        }
        "managed_desktop_authorize" => {
            let a: AuthorizeArgs = decode(args)?;
            // A browser/agent can never qualify a provider or authorize smoke.
            if a.action == AuthorizationPurpose::Smoke {
                return Err(refused("managed_desktop_smoke_operator_only"));
            }
            principal.require_human()?;
            // The authenticated remote dispatcher already validated the
            // ADR-0153 lease. Its issuance owns Host consent; asking again
            // here would consume approval under an unrelated operation key.
            let authorization = service
                .authorize_with_authority(
                    &principal,
                    &a.provider_config_id,
                    &a.quote_id,
                    a.action,
                    None,
                    &authority,
                )
                .await?;
            Ok(serde_json::json!({"id":authorization.id,"expiresAt":authorization.expires_at}))
        }
        "managed_desktop_prepare_template" => {
            let a: CreateManagedDesktop = decode(args)?;
            let id = a.provider_config_id.clone();
            service.prepare_template_with_authority(&principal, a, &authority).await?;
            let summary = service
                .list_configs(&principal)
                .await?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| refused("managed_desktop_config_missing"))?;
            encode(summary)
        }
        "managed_desktop_create" => encode(service.create_with_authority(&principal, decode(args)?, &authority).await?),
        "managed_desktop_connect" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .connect(&principal, &a.desktop_id, a.generation)
                    .await?,
            )
        }
        "managed_desktop_health" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .health(&principal, &a.desktop_id, a.generation)
                    .await?,
            )
        }
        "managed_desktop_delete" => {
            let a: DesktopArgs = decode(args)?;
            principal.require_human()?;
            encode(
                service
                    .delete_with_authority(&principal, &a.desktop_id, a.generation, &authority)
                    .await?,
            )
        }
        "managed_desktop_control_status" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .control_status(&principal, &a.desktop_id, a.generation)
                    .await?,
            )
        }
        "managed_desktop_control_frame" => {
            let a: DesktopArgs = decode(args)?;
            encode(
                service
                    .control_frame(&principal, &a.desktop_id, a.generation, &authority)
                    .await?,
            )
        }
        "managed_desktop_control_acquire" => {
            let a: AcquireArgs = decode(args)?;
            principal.require_human()?;
            encode(
                service
                    .control_acquire(
                        &principal,
                        &a.desktop_id,
                        a.generation,
                        a.takeover,
                        &authority,
                    )
                    .await?,
            )
        }
        "managed_desktop_control_renew" => {
            let a: LeaseArgs = decode(args)?;
            principal.require_human()?;
            encode(
                service
                    .control_renew(
                        &principal,
                        &a.desktop_id,
                        a.generation,
                        &a.token,
                        a.fence,
                        &authority,
                    )
                    .await?,
            )
        }
        "managed_desktop_control_release" => {
            let a: LeaseArgs = decode(args)?;
            principal.require_human()?;
            service
                .control_release(
                    &principal,
                    &a.desktop_id,
                    a.generation,
                    &a.token,
                    a.fence,
                    &authority,
                )
                .await?;
            Ok(Value::Null)
        }
        "managed_desktop_control_input" => {
            let a: InputArgs = decode(args)?;
            principal.require_human()?;
            if !service
                .control_status(&principal, &a.desktop_id, a.generation)
                .await?
                .qualified
            {
                return Err(refused("managed_desktop_control_unqualified"));
            }
            let runtime =
                runtime.ok_or_else(|| refused("managed_desktop_control_policy_unavailable"))?;
            execute_input(&service, &principal, &authority, a, runtime).await?;
            Ok(Value::Null)
        }
        _ => Err(refused("managed_desktop_unknown_command")),
    };
    // A queued read must not return the previous account's projection after
    // revocation; accepted cleanup itself remains independent of this reply.
    authority.revalidate(&principal).await?;
    result
}

#[cfg(feature = "tauri-host")]
#[tauri::command]
pub async fn managed_desktop_local_call(
    app: tauri::AppHandle,
    name: String,
    args: Option<Value>,
) -> Result<Value> {
    use tauri::{Emitter, Manager};
    let automation = app.state::<cognia_automation::automation::commands::AutomationState>();
    let events_app = app.clone();
    let runtime = ManagedControlRuntime {
        enforcement: Enforcement::from_state(&automation),
        events: Arc::new(move |topic, value| {
            let _ = events_app.emit(topic, value);
        }),
        refresh_persisted: false,
    };
    dispatch(
        &name,
        args.unwrap_or_else(|| serde_json::json!({})),
        Caller {
            device_id: "local-desktop",
            tenant_id: None,
            scope: None,
            local: true,
        },
        Some(runtime),
        None,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cognia_companion::security_store::{install_security_store, test_guard, SecurityStore};

    const NOW: i64 = 1_700_000_000;
    struct TestScope {
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    impl TestScope {
        fn new() -> Self {
            let scope = Self {
                _guard: test_guard(),
            };
            shutdown();
            host_identity::unbind_local_account();
            install_security_store(None);
            scope
        }
    }
    impl Drop for TestScope {
        fn drop(&mut self) {
            shutdown();
            host_identity::unbind_local_account();
            install_security_store(None);
        }
    }
    fn register_device(store: &SecurityStore, tenant: &str, device: &str, role: &str) {
        let challenge = store.issue_challenge(tenant, NOW, 600).unwrap();
        store
            .register_oidc_device(
                tenant,
                "test-actor",
                &challenge.id,
                &challenge.nonce,
                device,
                "Test device",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                &format!("thumb-{device}"),
                role,
                NOW,
            )
            .unwrap();
    }

    #[test]
    fn principal_uses_persisted_identity_and_rejects_revoked_or_cross_tenant_devices() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding =
            host_identity::bind_local_account("acct-managed-test", "digest-test").unwrap();
        let tenant = &binding.remote_tenant_id;
        register_device(&store, tenant, "owner-device", "owner");
        register_device(&store, tenant, "member-device", "member");
        for (device, expected) in [
            ("owner-device", ManagedDesktopAuthority::Administrator),
            ("member-device", ManagedDesktopAuthority::Human),
        ] {
            let actual = principal(
                &Caller {
                    device_id: device,
                    tenant_id: Some(tenant),
                    scope: None,
                    local: false,
                },
                "test-host",
            )
            .unwrap();
            assert_eq!(actual.authority, expected);
            assert_eq!(actual.owner_principal_id, "acct-managed-test");
            assert_eq!(actual.principal_id, device);
            assert_eq!(actual.host_id, "test-host");
        }
        let other = store.bind_host_account("acct-other", None, NOW).unwrap();
        let error = principal(
            &Caller {
                device_id: "member-device",
                tenant_id: Some(&other.tenant_id),
                scope: None,
                local: false,
            },
            "test-host",
        )
        .unwrap_err();
        assert_eq!(error.code, "managed_desktop_forbidden");
        store
            .revoke_device(tenant, "owner-device", "member-device", false, NOW + 1)
            .unwrap();
        assert_eq!(
            principal(
                &Caller {
                    device_id: "member-device",
                    tenant_id: Some(tenant),
                    scope: None,
                    local: false
                },
                "test-host"
            )
            .unwrap_err()
            .code,
            "managed_desktop_forbidden"
        );
        let challenge = store.issue_challenge(tenant, NOW, 600).unwrap();
        let enrollment = store
            .create_worker_enrollment(tenant, "owner-device", NOW, 600)
            .unwrap();
        store
            .register_worker_device(
                tenant,
                &enrollment,
                &challenge.id,
                &challenge.nonce,
                "worker-device",
                "Worker",
                "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
                "thumb-worker",
                NOW,
            )
            .unwrap();
        let worker = principal(
            &Caller {
                device_id: "worker-device",
                tenant_id: Some(tenant),
                scope: None,
                local: false,
            },
            "test-host",
        )
        .unwrap();
        assert_eq!(worker.authority, ManagedDesktopAuthority::Agent);
        assert!(worker.require_human().is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dormant_install_and_shutdown_release_the_exclusive_journal() {
        let _scope = TestScope::new();
        let directory = tempfile::tempdir().unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            install(directory.path(), "test-host"),
        )
        .await
        .unwrap()
        .unwrap();
        let weak = {
            let installed = INSTALLED.read();
            let installed = installed.as_ref().unwrap();
            assert_eq!(installed.host_id, "test-host");
            Arc::downgrade(&installed.service)
        };
        assert!(journal::JournalStore::open(directory.path()).is_err());
        shutdown();
        assert!(INSTALLED.read().is_none());
        tokio::time::timeout(Duration::from_secs(5), async {
            while weak.upgrade().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("shutdown must release the service");
        assert!(journal::JournalStore::open(directory.path()).is_ok());
    }
    #[test]
    fn service_and_worker_cannot_inherit_human_spend_authority() {
        assert_eq!(
            authority(false, Some("service"), false, true),
            ManagedDesktopAuthority::Agent
        );
        assert_eq!(
            authority(false, Some("device"), true, true),
            ManagedDesktopAuthority::Agent
        );
        assert_eq!(
            authority(false, None, false, false),
            ManagedDesktopAuthority::Human
        );
        assert_eq!(
            authority(false, Some("unknown"), false, false),
            ManagedDesktopAuthority::Observer
        );
        assert_eq!(
            authority(true, None, false, false),
            ManagedDesktopAuthority::Administrator
        );
    }
    #[tokio::test(flavor = "current_thread")]
    async fn control_authority_rechecks_device_account_and_admin_lease() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("acct-control", "digest-control").unwrap();
        register_device(&store, &binding.remote_tenant_id, "controller", "owner");
        let caller = Caller {
            device_id: "controller",
            tenant_id: Some(&binding.remote_tenant_id),
            scope: None,
            local: false,
        };
        let expected = principal(&caller, "host").unwrap();
        let expired = HostAuthority {
            caller,
            host_id: "host",
            admin_check: Some(Arc::new(|| {
                Err(refused("managed_desktop_control_admin_lease_expired"))
            })),
            input_policy: None,
            admission_observer: None,
        };
        assert!(!(expired.input_admission(&expected))());
        assert_eq!(
            expired.revalidate(&expected).await.unwrap_err().code,
            "managed_desktop_control_admin_lease_expired"
        );
        let authority = HostAuthority {
            caller,
            host_id: "host",
            admin_check: None,
            input_policy: None,
            admission_observer: None,
        };
        authority.revalidate(&expected).await.unwrap();
        let live = authority.input_admission(&expected);
        assert!(live());
        store
            .revoke_device(
                &binding.remote_tenant_id,
                "controller",
                "controller",
                true,
                NOW + 1,
            )
            .unwrap();
        assert!(!live());
        assert_eq!(
            authority.revalidate(&expected).await.unwrap_err().code,
            "managed_desktop_forbidden"
        );
        let caller = Caller {
            device_id: "local-desktop",
            tenant_id: None,
            scope: None,
            local: true,
        };
        let expected = principal(&caller, "host").unwrap();
        host_identity::bind_local_account("acct-rebound", "digest-rebound").unwrap();
        let authority = HostAuthority {
            caller,
            host_id: "host",
            admin_check: None,
            input_policy: None,
            admission_observer: None,
        };
        assert_eq!(
            authority.revalidate(&expected).await.unwrap_err().code,
            "managed_desktop_forbidden"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn actual_dispatch_refuses_service_input_before_control_or_policy() {
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        let binding = host_identity::bind_local_account("acct-control", "digest-control").unwrap();
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), "host").await.unwrap();
        let result = dispatch(
            "managed_desktop_control_input",
            serde_json::json!({
                "desktopId":"desktop", "generation":1, "token":"token", "fence":1,
                "frameId":"frame", "action":{"kind":"typeText", "text":"hello"}
            }),
            Caller {
                device_id: "service",
                tenant_id: Some(&binding.remote_tenant_id),
                scope: Some("service"),
                local: false,
            },
            None,
            None,
        )
        .await;
        assert_eq!(
            result.unwrap_err().code,
            "managed_desktop_human_authorization_required"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lifecycle_dispatch_requires_a_live_admin_check_for_remote_humans() {
        let _scope = TestScope::new();
        let store = SecurityStore::in_memory().unwrap();
        install_security_store(Some(store.clone()));
        let binding = host_identity::bind_local_account("acct-lifecycle", "digest-lifecycle").unwrap();
        register_device(&store, &binding.remote_tenant_id, "controller", "owner");
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), "host").await.unwrap();
        for command in ["managed_desktop_authorize", "managed_desktop_prepare_template", "managed_desktop_create", "managed_desktop_delete"] {
            let result = dispatch(command, serde_json::json!({}), Caller {
                device_id: "controller", tenant_id: Some(&binding.remote_tenant_id), scope: None, local: false,
            }, None, None).await;
            assert_eq!(result.unwrap_err().code, "managed_desktop_control_admin_lease_expired", "{command}");
        }
    }

    #[test]
    fn control_request_identity_and_policy_facts_cannot_be_supplied() {
        let input = serde_json::json!({"desktopId":"desktop", "generation":1, "token":"token", "fence":1, "frameId":"frame", "action":{"kind":"typeText","text":"hello"}});
        assert!(decode::<InputArgs>(input.clone()).is_ok());
        for field in [
            "ownerPrincipalId",
            "principalId",
            "hostId",
            "scope",
            "processName",
            "targetUrl",
            "policy",
            "confirmed",
            "adminLease",
        ] {
            let mut forged = input.clone();
            forged[field] = Value::Bool(true);
            assert!(decode::<InputArgs>(forged).is_err(), "{field}");
        }
        assert!(input_command(&UiAction::SetValue {
            value: "value".into()
        })
        .is_err());
        for action in [
            serde_json::json!({"kind":"click", "count":4}),
            serde_json::json!({"kind":"typeText", "text":"safe", "confirmed":true}),
            serde_json::json!({"kind":"pressKey", "chord":"x".repeat(257)}),
        ] {
            let mut invalid = input.clone();
            invalid["action"] = action;
            assert!(decode::<InputArgs>(invalid).is_err());
        }
        assert_eq!(
            policy_error(AutomationError::BackendError {
                message: "https://private.example/token".into()
            })
            .code,
            "managed_desktop_control_policy_denied"
        );
    }

    #[test]
    fn input_guard_rechecks_live_policy_and_does_not_treat_keys_or_text_as_reads() {
        use cognia_automation::automation::permission::{Call, CallKind, PermissionGate, Tier};
        let gate = PermissionGate::new(Default::default());
        gate.update(|settings| {
            settings.enabled = true;
            settings.per_surface.computer_use.tier = Tier::Whitelist;
        });
        let runtime = ManagedControlRuntime {
            enforcement: Enforcement {
                gate,
                audit: cognia_automation::automation::audit::AuditRing::new(),
                consent: Default::default(),
                policy: Default::default(),
                consent_event_sink: None,
            },
            events: Arc::new(|_, _| {}),
            refresh_persisted: false,
        };
        let action = UiAction::TypeText {
            text: "private content".into(),
        };
        let command = input_command(&action).unwrap();
        assert!(matches!(
            Call {
                command,
                surface: Surface::ComputerUse,
                plugin_id: None,
                target: Default::default()
            }
            .kind(),
            CallKind::Driving
        ));
        assert!(matches!(
            Call {
                command: input_command(&UiAction::PressKey {
                    chord: cognia_automation::automation::types::KeyChord("enter".into())
                })
                .unwrap(),
                surface: Surface::ComputerUse,
                plugin_id: None,
                target: Default::default()
            }
            .kind(),
            CallKind::Driving
        ));
        let guard = InputPolicyGuard::new(&runtime, command, None, &action);
        guard.check().unwrap();
        runtime
            .enforcement
            .policy
            .set(cognia_automation::automation::policy::Policy {
                allowed_url_patterns: vec![".*".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_target_unverified"
        );
        runtime.enforcement.policy.set(Default::default()).unwrap();
        runtime
            .enforcement
            .gate
            .update(|settings| settings.per_surface.computer_use.tier = Tier::PerCall);
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_consent_required"
        );
        runtime
            .enforcement
            .gate
            .update(|settings| settings.enabled = false);
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_policy_denied"
        );
    }

    fn consent_enforcement() -> Enforcement {
        let gate =
            cognia_automation::automation::permission::PermissionGate::new(Default::default());
        gate.update(|settings| {
            settings.enabled = true;
            settings.per_surface.computer_use.tier =
                cognia_automation::automation::permission::Tier::PerCall;
        });
        Enforcement {
            gate,
            audit: cognia_automation::automation::audit::AuditRing::new(),
            consent: Default::default(),
            policy: Default::default(),
            consent_event_sink: None,
        }
    }
    async fn request_bridge(enforcement: &Enforcement, timeout: u64) -> bool {
        let sink = enforcement.consent_event_sink.as_ref().unwrap().clone();
        enforcement
            .consent
            .request_with_emitter(
                cognia_automation::automation::permission::ConsentPrompt {
                    command: "type".into(),
                    surface: Surface::ComputerUse,
                    plugin_id: None,
                    process_name: None,
                    window_title: None,
                    command_detail: Some("Managed desktop desk".into()),
                    session_key: Some("same-session".into()),
                },
                timeout,
                None,
                move |event| sink(event),
            )
            .await
    }
    #[tokio::test(flavor = "current_thread")]
    async fn host_consent_bridge_is_one_shot_and_denial_or_timeout_cannot_deliver_input() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut enforcement = consent_enforcement();
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = requests.clone();
        let device = format!("consent-test-{}", uuid::Uuid::new_v4());
        let tasks = install_host_consent_bridge(
            &mut enforcement,
            Arc::new(move |_, value| {
                assert!(value["operations"][0]
                    .as_str()
                    .unwrap()
                    .contains("desk:generation=2:fence=3:type:"));
                let count = seen.fetch_add(1, Ordering::SeqCst);
                if count < 2 {
                    cognia_companion::host_consent::resolve(
                        value["id"].as_str().unwrap(),
                        count == 0,
                        cognia_companion::host_consent::Approver::Host,
                    )
                    .unwrap();
                }
            }),
            device.clone(),
            Some("tenant".into()),
            "desk:generation=2:fence=3".into(),
            "type",
        );
        let mut delivered = 0;
        for _ in 0..3 {
            if request_bridge(&enforcement, 25).await {
                delivered += 1;
            }
        }
        assert_eq!(
            delivered, 1,
            "approval must not establish a session grant; denial and timeout cannot execute"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        drop(tasks);
        cognia_companion::host_consent::forget_device(&device);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn approval_between_consumption_and_pending_snapshot_is_not_denied() {
        let mut enforcement = consent_enforcement();
        let broker = enforcement.consent.clone();
        let device = format!("race-test-{}", uuid::Uuid::new_v4());
        let requester = device.clone();
        enforcement.consent_event_sink = Some(Arc::new(move |event| {
            let operations = vec![format!("managed-desktop:race:{}", event.id)];
            let ask = cognia_companion::host_consent::request(&requester, None, operations.clone());
            // Deterministically place Host approval between the bridge's first
            // take_approved and its subsequent pending-state snapshot.
            assert!(!cognia_companion::host_consent::take_approved(&requester, &operations));
            cognia_companion::host_consent::resolve(&ask.id, true,
                cognia_companion::host_consent::Approver::Host).unwrap();
            assert!(!cognia_companion::host_consent::pending().iter().any(|request| request.id == ask.id));
            resolve_closed_host_consent(&broker, &event.id, &requester, &operations);
            assert!(!cognia_companion::host_consent::take_approved(&requester, &operations));
            Ok(())
        }));
        assert!(request_bridge(&enforcement, 1_000).await);
        cognia_companion::host_consent::forget_device(&device);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn explicit_host_denial_resolves_before_the_consent_timeout() {
        let mut enforcement = consent_enforcement();
        let device = format!("denied-test-{}", uuid::Uuid::new_v4());
        let tasks = install_host_consent_bridge(
            &mut enforcement,
            Arc::new(|_, value| {
                cognia_companion::host_consent::resolve(
                    value["id"].as_str().unwrap(), false,
                    cognia_companion::host_consent::Approver::Host,
                ).unwrap();
            }), device.clone(), None, "desk:generation=2:fence=3".into(), "type",
        );
        let result = tokio::time::timeout(Duration::from_secs(1), request_bridge(&enforcement, 5_000)).await;
        assert_eq!(result.unwrap(), false);
        drop(tasks);
        cognia_companion::host_consent::forget_device(&device);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelled_consent_wait_cannot_be_replayed_by_a_late_approval() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut enforcement = consent_enforcement();
        let request_id = Arc::new(parking_lot::Mutex::new(None::<String>));
        let observed = request_id.clone();
        let device = format!("cancel-test-{}", uuid::Uuid::new_v4());
        let tasks = install_host_consent_bridge(
            &mut enforcement,
            Arc::new(move |_, value| {
                *observed.lock() = Some(value["id"].as_str().unwrap().into());
            }),
            device.clone(),
            None,
            "desk:generation=2:fence=3".into(),
            "type",
        );
        let delivered = Arc::new(AtomicUsize::new(0));
        let count = delivered.clone();
        let request = tokio::spawn(async move {
            if request_bridge(&enforcement, 1000).await {
                count.fetch_add(1, Ordering::SeqCst);
            }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while request_id.lock().is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        drop(tasks);
        let id = request_id.lock().clone().unwrap();
        cognia_companion::host_consent::resolve(
            &id,
            true,
            cognia_companion::host_consent::Approver::Host,
        )
        .unwrap();
        tokio::task::yield_now().await;
        assert_eq!(delivered.load(Ordering::SeqCst), 0);
        cognia_companion::host_consent::forget_device(&device);
    }
    #[tokio::test(flavor = "current_thread")]
    async fn execute_input_rechecks_account_after_host_approval() {
        let _scope = TestScope::new();
        install_security_store(Some(SecurityStore::in_memory().unwrap()));
        host_identity::bind_local_account("acct-consent", "digest-consent").unwrap();
        let directory = tempfile::tempdir().unwrap();
        install(directory.path(), "host").await.unwrap();
        let service = INSTALLED.read().as_ref().unwrap().service.clone();
        let caller = Caller {
            device_id: "local-desktop",
            tenant_id: None,
            scope: None,
            local: true,
        };
        let p = principal(&caller, "host").unwrap();
        let authority = HostAuthority {
            caller,
            host_id: "host",
            admin_check: None,
            input_policy: None,
            admission_observer: None,
        };
        let result = execute_input(
            &service,
            &p,
            &authority,
            InputArgs {
                desktop_id: "desk".into(),
                generation: 1,
                token: "lease".into(),
                fence: 1,
                frame_id: "frame".into(),
                point: None,
                action: UiAction::TypeText {
                    text: "private".into(),
                },
            },
            ManagedControlRuntime {
                enforcement: consent_enforcement(),
                refresh_persisted: false,
                events: Arc::new(|_, value| {
                    host_identity::unbind_local_account();
                    cognia_companion::host_consent::resolve(
                        value["id"].as_str().unwrap(),
                        true,
                        cognia_companion::host_consent::Approver::Host,
                    )
                    .unwrap();
                }),
            },
        )
        .await;
        assert_eq!(result.unwrap_err().code, "managed_desktop_account_required");
        cognia_companion::host_consent::forget_device("local-desktop");
    }

    #[test]
    fn headless_policy_snapshot_change_fences_an_existing_input_guard() {
        let _scope = TestScope::new();
        let saved = {
            let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
            let saved = (snapshot.version, snapshot.available);
            snapshot.version = 10;
            snapshot.available = true;
            saved
        };
        let runtime = ManagedControlRuntime {
            enforcement: consent_enforcement(),
            events: Arc::new(|_, _| {}),
            refresh_persisted: true,
        };
        let guard = InputPolicyGuard::new(
            &runtime,
            "type",
            None,
            &UiAction::TypeText {
                text: "text".into(),
            },
        );
        guard.check().unwrap();
        HEADLESS_POLICY_SNAPSHOT.write().version = 11;
        assert_eq!(
            guard.check().unwrap_err().code,
            "managed_desktop_control_policy_changed"
        );
        let mut snapshot = HEADLESS_POLICY_SNAPSHOT.write();
        snapshot.version = saved.0;
        snapshot.available = saved.1;
    }
    #[test]
    fn rpc_payloads_cannot_supply_owner_principal_or_confirmation() {
        for key in [
            "ownerPrincipalId",
            "hostId",
            "confirmed",
            "userInitiated",
            "scope",
        ] {
            let mut value =
                serde_json::json!({"providerConfigId":"p","quoteId":"q","action":"create"});
            value[key] = Value::Bool(true);
            assert!(decode::<AuthorizeArgs>(value).is_err());
        }
        assert_eq!(
            COMMANDS
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            COMMANDS.len()
        );
    }
}

// Kept below this module so native smoke reuses private Host authority and consent.
#[path = "managed_desktop_authority_operator.rs"]
pub mod authority_operator;
