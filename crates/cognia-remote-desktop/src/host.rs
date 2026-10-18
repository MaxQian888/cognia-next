//! The Host facade every command surface calls (ADR-0234 Phase 2 item 8).
//! It owns the target store, the credential store, endpoint pinning and the
//! session broker, and it writes the audit trail for every change.

use crate::{
    audit,
    bridge::{Attachment, Bridge, BridgeTarget, ViewerStream, CONNECT_TIMEOUT, HANDSHAKE_TIMEOUT, TICKET_TTL},
    console::{self, ConsoleProfile},
    credentials::{self, CredentialKind, CredentialStore, KeyringCredentials, MAX_CREDENTIAL_BYTES},
    endpoint::{self, Pinned},
    error::{RemoteDesktopError, Result},
    rfb::{self, ProbeResult},
    session::{
        now_ms, Admission, Broker, EndReason, Principal, SessionMode, SessionOpened, SessionRenewed,
        TARGET_KIND,
    },
    launch::{self, Launcher},
    target::{
        validate_draft, Access, Adapter, Binding, BindingDraft, Endpoint, EndpointClass, RemoteTarget, TargetDraft,
        TargetStore, WebConsole,
    },
};
use cognia_problem::paging::{Page, PageRequest};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    path::Path,
    pin::Pin,
    sync::Arc,
};
use tokio::net::TcpStream;

pub const DEFAULT_TARGET_PAGE: u32 = 50;

pub type ResolveFuture = Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send>>;

/// Name resolution, injectable so pinning is testable without DNS.
pub trait Resolve: Send + Sync + 'static {
    fn resolve(&self, host: String, port: u16) -> ResolveFuture;
}

pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve(&self, host: String, port: u16) -> ResolveFuture {
        Box::pin(async move {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map(|addrs| addrs.collect())
        })
    }
}

/// What the wizard probes: an unsaved endpoint, or a saved binding.
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProbeRequest {
    /// Resolution only until `confirm` is true; then the Host connects.
    Draft {
        host: String,
        port: u16,
        adapter: Adapter,
        #[serde(default)]
        confirm: bool,
    },
    Saved { target_id: String, binding_id: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOutcome {
    pub pinned_ip: IpAddr,
    pub class: EndpointClass,
    /// The Host opened a TCP connection to the pinned address.
    pub connected: bool,
    /// VNC servers only: protocol version and security offer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rfb: Option<ProbeResult>,
}

/// What a client opens for a binding the Host does not bridge
/// (`remote_desktop_binding_launch`). The provider authenticates the user;
/// Cognia only says where to go.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Launched {
    WebConsole { url: String, profile: ConsoleProfile },
    ExternalApp { launcher: Launcher, uri: String },
}

pub struct RemoteDesktopHost {
    store: Arc<Mutex<TargetStore>>,
    credentials: Arc<dyn CredentialStore>,
    resolver: Arc<dyn Resolve>,
    broker: Arc<Broker>,
}

fn internal() -> RemoteDesktopError {
    RemoteDesktopError::new("remote_desktop_internal")
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn class_str(class: EndpointClass) -> &'static str {
    match class {
        EndpointClass::Private => "private",
        EndpointClass::Public => "public",
    }
}

/// Fields a live bridge depends on. Renaming or reprioritizing a binding
/// leaves its sessions alone.
fn session_relevant(binding: &Binding) -> (Access, Option<&Endpoint>, Adapter, bool, bool) {
    (
        binding.access,
        binding.endpoint.as_ref(),
        binding.adapter,
        binding.view_only,
        binding.enabled,
    )
}

/// The host and port a draft binding asks the Host to pin: its own for a
/// bridge, its URL's for a web console, none for an external app.
fn endpoint_of(binding: &BindingDraft) -> Result<Option<(String, u16)>> {
    Ok(match binding.access {
        Access::Bridge => Some((
            binding.host.clone().unwrap_or_default(),
            binding.port.unwrap_or_default(),
        )),
        Access::WebConsole => {
            let console = binding
                .console
                .as_ref()
                .ok_or_else(|| RemoteDesktopError::new("remote_desktop_console_url_invalid"))?;
            let link = console::parse(&console.url, console.profile)?;
            Some((link.host, link.port))
        }
        Access::ExternalApp => None,
    })
}

struct Saved {
    target: RemoteTarget,
    confirmed: Vec<(String, EndpointClass)>,
    changed: Vec<String>,
    cleared: Vec<(String, CredentialKind)>,
}

impl RemoteDesktopHost {
    /// The production Host: `<root>/remote-desktop-targets.json`, the Host
    /// secret store and the system resolver.
    pub fn open(root: &Path) -> Result<Self> {
        Ok(Self::with_parts(
            TargetStore::open(root)?,
            Arc::new(KeyringCredentials),
            Arc::new(SystemResolver),
        ))
    }

    pub fn with_parts(
        store: TargetStore,
        credentials: Arc<dyn CredentialStore>,
        resolver: Arc<dyn Resolve>,
    ) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            credentials,
            resolver,
            broker: Arc::new(Broker::default()),
        }
    }

    async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut TargetStore, &dyn CredentialStore) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.store.clone();
        let credentials = self.credentials.clone();
        tokio::task::spawn_blocking(move || work(&mut store.lock(), credentials.as_ref()))
            .await
            .map_err(|_| internal())?
    }

    async fn pin(&self, host: &str, port: u16) -> Result<Pinned> {
        let resolver = self.resolver.clone();
        endpoint::pin_with(host, port, move |host, port| resolver.resolve(host, port)).await
    }

    pub async fn list_targets(&self, page_size: Option<u32>, page_token: Option<&str>) -> Result<Page<RemoteTarget>> {
        let request = PageRequest::from_parts(page_size, page_token)
            .map_err(|_| RemoteDesktopError::new("remote_desktop_page_token_invalid"))?;
        let all = self.blocking(|store, _| Ok(store.list().to_vec())).await?;
        Page::slice_all(all, &request, DEFAULT_TARGET_PAGE)
            .map_err(|_| RemoteDesktopError::new("remote_desktop_page_token_invalid"))
    }

    /// Create or replace a target. Every endpoint is resolved and pinned
    /// first; a binding whose pinned address is new needs `confirm`.
    pub async fn save_target(&self, actor: &Principal, draft: TargetDraft) -> Result<RemoteTarget> {
        validate_draft(&draft)?;
        let mut pins = Vec::with_capacity(draft.bindings.len());
        for binding in &draft.bindings {
            pins.push(match endpoint_of(binding)? {
                Some((host, port)) => Some(self.pin(&host, port).await?),
                None => None,
            });
        }
        let now = now_ms();
        let saved = self
            .blocking(move |store, credentials| save(store, credentials, draft, pins, now))
            .await?;
        let target_id = saved.target.id.clone();
        if !saved.changed.is_empty() {
            self.broker
                .end_bindings(&target_id, Some(&saved.changed), EndReason::BindingChanged);
        }
        audit::record_async(
            "remote_desktop.target.save",
            TARGET_KIND,
            &target_id,
            actor.id(),
            "allow",
            0,
            json!({"count": saved.target.bindings.len()}),
        )
        .await;
        for (binding_id, class) in &saved.confirmed {
            audit::record_async(
                "remote_desktop.endpoint.confirm",
                TARGET_KIND,
                &target_id,
                actor.id(),
                "allow",
                0,
                json!({"binding_id": binding_id, "class": class_str(*class)}),
            )
            .await;
        }
        for (binding_id, kind) in &saved.cleared {
            audit::record_async(
                "remote_desktop.credential.clear",
                TARGET_KIND,
                &target_id,
                actor.id(),
                "allow",
                0,
                json!({"binding_id": binding_id, "credential": kind.as_str()}),
            )
            .await;
        }
        Ok(saved.target)
    }

    /// Repeating a delete is a no-op (ADR-0175 `delete`).
    pub async fn delete_target(&self, actor: &Principal, target_id: &str) -> Result<()> {
        let id = target_id.to_owned();
        let removed = self
            .blocking(move |store, credentials| {
                let Some(target) = store.get(&id).cloned() else {
                    return Ok(None);
                };
                // Secrets go first: a failed clear keeps the target visible
                // so the delete can be retried instead of orphaning them.
                for binding in &target.bindings {
                    for kind in [CredentialKind::Control, CredentialKind::View] {
                        credentials
                            .clear(&credentials::key(&binding.id, kind))
                            .map_err(|_| RemoteDesktopError::new("remote_desktop_credential_unavailable"))?;
                    }
                }
                store.remove(&id)?;
                Ok(Some(target))
            })
            .await?;
        let Some(target) = removed else {
            return Ok(());
        };
        self.broker
            .end_bindings(target_id, None, EndReason::TargetDeleted);
        self.broker.forget_target(target_id);
        audit::record_async(
            "remote_desktop.target.delete",
            TARGET_KIND,
            target_id,
            actor.id(),
            "allow",
            0,
            json!({"count": target.bindings.len()}),
        )
        .await;
        Ok(())
    }

    /// Store (`Some`) or clear (`None`) a binding credential. The value is
    /// write-only: no command ever returns it.
    pub async fn set_credential(
        &self,
        actor: &Principal,
        target_id: &str,
        binding_id: &str,
        kind: CredentialKind,
        value: Option<String>,
    ) -> Result<RemoteTarget> {
        if let Some(value) = &value {
            if value.is_empty() || value.len() > MAX_CREDENTIAL_BYTES || value.contains('\0') {
                return Err(RemoteDesktopError::new("remote_desktop_credential_invalid"));
            }
        }
        let present = value.is_some();
        let (target_id_owned, binding_id_owned) = (target_id.to_owned(), binding_id.to_owned());
        let target = self
            .blocking(move |store, credentials| {
                let binding = store
                    .binding(&target_id_owned, &binding_id_owned)
                    .ok_or_else(|| RemoteDesktopError::new("remote_desktop_binding_not_found"))?;
                if (binding.adapter == Adapter::None || binding.access != Access::Bridge) && present {
                    return Err(RemoteDesktopError::new("remote_desktop_binding_has_no_authentication"));
                }
                if kind == CredentialKind::View && !binding.view_only && present {
                    return Err(RemoteDesktopError::new("remote_desktop_binding_cannot_be_read_only"));
                }
                let key = credentials::key(&binding_id_owned, kind);
                match &value {
                    Some(value) => credentials.set(&key, value),
                    None => credentials.clear(&key),
                }
                .map_err(|_| RemoteDesktopError::new("remote_desktop_credential_unavailable"))?;
                store.set_credential_flag(&target_id_owned, &binding_id_owned, kind == CredentialKind::View, present)?;
                store.get(&target_id_owned).cloned().ok_or_else(internal)
            })
            .await?;
        audit::record_async(
            if present {
                "remote_desktop.credential.set"
            } else {
                "remote_desktop.credential.clear"
            },
            TARGET_KIND,
            target_id,
            actor.id(),
            "allow",
            0,
            json!({"binding_id": binding_id, "credential": kind.as_str()}),
        )
        .await;
        Ok(target)
    }

    pub async fn probe(&self, request: ProbeRequest) -> Result<ProbeOutcome> {
        let (pinned, port, adapter, connect) = match request {
            ProbeRequest::Draft {
                host,
                port,
                adapter,
                confirm,
            } => {
                if port == 0 {
                    return Err(RemoteDesktopError::new("remote_desktop_endpoint_invalid"));
                }
                (self.pin(&host, port).await?, port, adapter, confirm)
            }
            ProbeRequest::Saved {
                target_id,
                binding_id,
            } => {
                let binding = self.binding(&target_id, &binding_id).await?;
                let endpoint = binding
                    .endpoint
                    .as_ref()
                    .ok_or_else(|| RemoteDesktopError::new("remote_desktop_binding_has_no_endpoint"))?;
                self.require_still_pinned(endpoint).await?;
                (
                    Pinned {
                        ip: endpoint.pinned_ip,
                        class: endpoint.class,
                    },
                    endpoint.port,
                    binding.adapter,
                    true,
                )
            }
        };
        let mut outcome = ProbeOutcome {
            pinned_ip: pinned.ip,
            class: pinned.class,
            connected: false,
            rfb: None,
        };
        if !connect {
            return Ok(outcome);
        }
        let mut stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(SocketAddr::new(pinned.ip, port)))
            .await
            .map_err(|_| RemoteDesktopError::new("remote_desktop_connect_timeout"))?
            .map_err(|_| RemoteDesktopError::new("remote_desktop_connect_failed"))?;
        outcome.connected = true;
        if adapter == Adapter::Vnc {
            outcome.rfb = Some(
                tokio::time::timeout(HANDSHAKE_TIMEOUT, rfb::probe(&mut stream))
                    .await
                    .map_err(|_| RemoteDesktopError::new("remote_desktop_handshake_timeout"))??,
            );
        }
        Ok(outcome)
    }

    async fn require_still_pinned(&self, endpoint: &Endpoint) -> Result<()> {
        let resolver = self.resolver.clone();
        if endpoint::still_pinned_with(&endpoint.host, endpoint.port, endpoint.pinned_ip, move |host, port| {
            resolver.resolve(host, port)
        })
        .await?
        {
            Ok(())
        } else {
            Err(RemoteDesktopError::new("remote_desktop_endpoint_changed"))
        }
    }

    /// Where a client goes for a web console or external-app binding. It
    /// needs control (`host.admin` on a paired device): these bindings cannot
    /// be made read-only. A console whose name moved needs saving again.
    pub async fn launch(&self, principal: &Principal, target_id: &str, binding_id: &str) -> Result<Launched> {
        let result = self.launch_inner(principal, target_id, binding_id).await;
        let (decision, access) = match &result {
            Ok(Launched::WebConsole { .. }) => ("allow", Access::WebConsole),
            Ok(Launched::ExternalApp { .. }) => ("allow", Access::ExternalApp),
            Err(_) => ("deny", Access::Bridge),
        };
        let mut fields = json!({"binding_id": binding_id});
        if decision == "allow" {
            fields["access"] = json!(access.as_str());
        } else if let Err(error) = &result {
            fields["code"] = json!(error.code);
        }
        audit::record_async(
            "remote_desktop.binding.launch",
            TARGET_KIND,
            target_id,
            principal.id(),
            decision,
            0,
            fields,
        )
        .await;
        result
    }

    async fn launch_inner(&self, principal: &Principal, target_id: &str, binding_id: &str) -> Result<Launched> {
        if !principal.admitted(SessionMode::Control) {
            return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
        }
        let binding = self.binding(target_id, binding_id).await?;
        if !binding.enabled {
            return Err(RemoteDesktopError::new("remote_desktop_binding_disabled"));
        }
        match (binding.access, &binding.console, &binding.launch, &binding.endpoint) {
            (Access::WebConsole, Some(console), _, Some(endpoint)) => {
                self.require_still_pinned(endpoint).await?;
                Ok(Launched::WebConsole {
                    url: console.url.clone(),
                    profile: console.profile,
                })
            }
            (Access::ExternalApp, _, Some(app), _) => Ok(Launched::ExternalApp {
                launcher: app.launcher,
                uri: launch::uri(app),
            }),
            (Access::Bridge, ..) => Err(RemoteDesktopError::new("remote_desktop_binding_not_launchable")),
            _ => Err(internal()),
        }
    }

    async fn binding(&self, target_id: &str, binding_id: &str) -> Result<Binding> {
        let (target_id, binding_id) = (target_id.to_owned(), binding_id.to_owned());
        self.blocking(move |store, _| {
            store
                .binding(&target_id, &binding_id)
                .cloned()
                .ok_or_else(|| RemoteDesktopError::new("remote_desktop_binding_not_found"))
        })
        .await
    }

    /// Open a viewer session. `view` needs a server-enforced view password;
    /// `control` takes the target's lease, preempting the current controller
    /// only when `takeover` is set.
    ///
    /// The desktop's own user gets a loopback bridge; a paired device gets a
    /// bridge it attaches to through its Companion transport.
    pub async fn open_session(
        &self,
        principal: &Principal,
        target_id: &str,
        binding_id: &str,
        mode: SessionMode,
        takeover: bool,
    ) -> Result<SessionOpened> {
        let result = self.open_inner(principal, target_id, binding_id, mode, takeover).await;
        if let Err(error) = &result {
            audit::record_async(
                "remote_desktop.session.failed",
                TARGET_KIND,
                target_id,
                principal.id(),
                "deny",
                0,
                json!({"binding_id": binding_id, "mode": mode.as_str(), "reason": "failed",
                    "code": error.code}),
            )
            .await;
        }
        result
    }

    async fn open_inner(
        &self,
        principal: &Principal,
        target_id: &str,
        binding_id: &str,
        mode: SessionMode,
        takeover: bool,
    ) -> Result<SessionOpened> {
        if !principal.admitted(mode) {
            return Err(RemoteDesktopError::new("remote_desktop_forbidden"));
        }
        let revision = self.broker.revision();
        let binding = self.binding(target_id, binding_id).await?;
        if !binding.enabled {
            return Err(RemoteDesktopError::new("remote_desktop_binding_disabled"));
        }
        let (Access::Bridge, Some(endpoint)) = (binding.access, binding.endpoint.clone()) else {
            return Err(RemoteDesktopError::new("remote_desktop_binding_not_bridged"));
        };
        let credential = match mode {
            SessionMode::View if binding.view_only && binding.has_view_credential => Some(CredentialKind::View),
            SessionMode::View => {
                return Err(RemoteDesktopError::new("remote_desktop_binding_cannot_be_read_only"))
            }
            // A VNC server offering None needs no password.
            SessionMode::Control if binding.has_control_credential => Some(CredentialKind::Control),
            SessionMode::Control => None,
        }
        .filter(|_| binding.adapter == Adapter::Vnc);
        self.broker.precheck(target_id, mode, takeover)?;
        let password = match credential {
            Some(kind) => {
                let key = credentials::key(binding_id, kind);
                let password = self
                    .blocking(move |_, credentials| {
                        credentials
                            .get(&key)
                            .map_err(|_| RemoteDesktopError::new("remote_desktop_credential_unavailable"))
                    })
                    .await?;
                Some(password.ok_or_else(|| RemoteDesktopError::new("remote_desktop_credential_missing"))?)
            }
            None => None,
        };
        let bridge = Bridge::start(
            BridgeTarget {
                addr: SocketAddr::new(endpoint.pinned_ip, endpoint.port),
                adapter: binding.adapter,
                password,
            },
            if principal.is_local() {
                Attachment::Loopback
            } else {
                Attachment::Remote
            },
            TICKET_TTL,
        )
        .await?;
        self.broker.commit(
            Admission {
                principal: principal.clone(),
                target_id: target_id.to_owned(),
                binding_id: binding_id.to_owned(),
                mode,
                takeover,
                revision,
            },
            bridge,
        )
    }

    pub fn renew_session(&self, principal: &Principal, session_id: &str) -> Result<SessionRenewed> {
        self.broker.renew(principal.id(), session_id)
    }

    pub fn close_session(&self, principal: &Principal, session_id: &str) {
        self.broker.close(principal.id(), session_id);
    }

    /// A paired device's transport delivers the viewer stream for the
    /// session it opened. Refused for anyone else and after the ticket TTL.
    pub fn attach_viewer(&self, principal: &Principal, session_id: &str, stream: ViewerStream) -> Result<()> {
        self.broker.attach(principal, session_id, stream)
    }
}

fn save(
    store: &mut TargetStore,
    credentials: &dyn CredentialStore,
    draft: TargetDraft,
    pins: Vec<Option<Pinned>>,
    now: i64,
) -> Result<Saved> {
    let existing = match &draft.id {
        Some(id) => Some(
            store
                .get(id)
                .cloned()
                .ok_or_else(|| RemoteDesktopError::new("remote_desktop_target_not_found"))?,
        ),
        None => None,
    };
    let previous_bindings = existing.as_ref().map_or(&[][..], |target| &target.bindings[..]);
    let mut bindings = Vec::with_capacity(draft.bindings.len());
    let mut confirmed = Vec::new();
    let mut changed = Vec::new();
    let mut clear = Vec::new();
    for (draft_binding, pin) in draft.bindings.iter().zip(pins) {
        // Ids are minted by the Host, so a credential key is never reused
        // across targets.
        let previous = match &draft_binding.id {
            Some(id) => Some(
                previous_bindings
                    .iter()
                    .find(|binding| &binding.id == id)
                    .ok_or_else(|| RemoteDesktopError::new("remote_desktop_binding_not_found"))?,
            ),
            None => None,
        };
        let id = draft_binding.id.clone().unwrap_or_else(new_id);
        let (endpoint, console, app) = match (draft_binding.access, pin) {
            (Access::ExternalApp, _) => {
                let app = draft_binding
                    .launch
                    .as_ref()
                    .ok_or_else(|| RemoteDesktopError::new("remote_desktop_launch_peer_invalid"))?;
                (None, None, Some(launch::normalize(app)?))
            }
            (access, Some(pin)) => {
                let (host, port, console) = match access {
                    Access::WebConsole => {
                        let draft_console = draft_binding
                            .console
                            .as_ref()
                            .ok_or_else(|| RemoteDesktopError::new("remote_desktop_console_url_invalid"))?;
                        let link = console::parse(&draft_console.url, draft_console.profile)?;
                        console::require_transport(&link, pin.class)?;
                        let console = WebConsole {
                            url: link.url,
                            profile: draft_console.profile,
                        };
                        (link.host, link.port, Some(console))
                    }
                    _ => (
                        draft_binding
                            .host
                            .as_deref()
                            .unwrap_or_default()
                            .trim()
                            .trim_start_matches('[')
                            .trim_end_matches(']')
                            .to_owned(),
                        draft_binding.port.unwrap_or_default(),
                        None,
                    ),
                };
                let kept = previous
                    .and_then(|previous| previous.endpoint.as_ref())
                    .filter(|previous| previous.host == host && previous.port == port && previous.pinned_ip == pin.ip);
                let confirmed_at = match kept {
                    Some(previous) => previous.confirmed_at,
                    None if draft_binding.confirm => {
                        confirmed.push((id.clone(), pin.class));
                        now
                    }
                    None => {
                        return Err(RemoteDesktopError::with_detail(
                            "remote_desktop_endpoint_unconfirmed",
                            class_str(pin.class),
                        ))
                    }
                };
                let endpoint = Endpoint {
                    host,
                    port,
                    pinned_ip: pin.ip,
                    class: pin.class,
                    confirmed_at,
                };
                (Some(endpoint), console, None)
            }
            (_, None) => return Err(internal()),
        };
        // Only a bridge with a VNC handshake uses credentials; anything else
        // drops what the binding held before.
        let authenticates = draft_binding.access == Access::Bridge && draft_binding.adapter != Adapter::None;
        let mut has_control = previous.is_some_and(|binding| binding.has_control_credential);
        let mut has_view = previous.is_some_and(|binding| binding.has_view_credential);
        if !authenticates && has_control {
            clear.push((id.clone(), CredentialKind::Control));
            has_control = false;
        }
        if (!draft_binding.view_only || !authenticates) && has_view {
            clear.push((id.clone(), CredentialKind::View));
            has_view = false;
        }
        let binding = Binding {
            id: id.clone(),
            provider_id: draft_binding.provider_id.clone(),
            access: draft_binding.access,
            adapter: draft_binding.adapter,
            priority: draft_binding.priority,
            enabled: draft_binding.enabled,
            endpoint,
            console,
            launch: app,
            view_only: draft_binding.view_only,
            config: draft_binding.config.clone(),
            has_control_credential: has_control,
            has_view_credential: has_view,
        };
        if previous.is_some_and(|previous| session_relevant(previous) != session_relevant(&binding)) {
            changed.push(id);
        }
        bindings.push(binding);
    }
    for previous in previous_bindings {
        if !bindings.iter().any(|binding| binding.id == previous.id) {
            changed.push(previous.id.clone());
            for kind in [CredentialKind::Control, CredentialKind::View] {
                clear.push((previous.id.clone(), kind));
            }
        }
    }
    // Clear before persisting: a failed clear aborts the save, so no secret
    // outlives the binding that referenced it.
    for (binding_id, kind) in &clear {
        credentials
            .clear(&credentials::key(binding_id, *kind))
            .map_err(|_| RemoteDesktopError::new("remote_desktop_credential_unavailable"))?;
    }
    let target = RemoteTarget {
        id: draft.id.clone().unwrap_or_else(new_id),
        name: draft.name.trim().to_owned(),
        bindings,
        created_at: existing.as_ref().map_or(now, |target| target.created_at),
        updated_at: now,
    };
    store.put(target.clone())?;
    Ok(Saved {
        target,
        confirmed,
        changed,
        cleared: clear,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{credentials::MemoryCredentials, target::BindingDraft};
    use std::sync::atomic::Ordering;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn me() -> Principal {
        Principal::local()
    }

    /// Maps every name to a fixed answer; `moved` swaps it.
    struct FixedResolver(Mutex<Vec<IpAddr>>);

    impl Resolve for FixedResolver {
        fn resolve(&self, _host: String, port: u16) -> ResolveFuture {
            let answer = self.0.lock().iter().map(|ip| SocketAddr::new(*ip, port)).collect();
            Box::pin(std::future::ready(Ok(answer)))
        }
    }

    struct Fixture {
        host: RemoteDesktopHost,
        credentials: Arc<MemoryCredentials>,
        resolver: Arc<FixedResolver>,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let resolver = Arc::new(FixedResolver(Mutex::new(vec!["192.168.1.20".parse().unwrap()])));
        let host = RemoteDesktopHost::with_parts(
            TargetStore::open(dir.path()).unwrap(),
            credentials.clone(),
            resolver.clone(),
        );
        Fixture {
            host,
            credentials,
            resolver,
            _dir: dir,
        }
    }

    fn binding_draft(host: &str, port: u16, adapter: Adapter, view_only: bool) -> BindingDraft {
        BindingDraft {
            id: None,
            provider_id: "cognia-remote-desktop-vnc.vnc".into(),
            access: Access::Bridge,
            adapter,
            priority: 0,
            enabled: true,
            host: Some(host.into()),
            port: Some(port),
            console: None,
            launch: None,
            view_only,
            config: serde_json::Value::Null,
            confirm: true,
        }
    }

    fn draft(bindings: Vec<BindingDraft>) -> TargetDraft {
        TargetDraft {
            id: None,
            name: " Studio NAS ".into(),
            bindings,
        }
    }

    fn edit(target: &RemoteTarget) -> TargetDraft {
        TargetDraft {
            id: Some(target.id.clone()),
            name: target.name.clone(),
            bindings: target
                .bindings
                .iter()
                .map(|binding| BindingDraft {
                    id: Some(binding.id.clone()),
                    provider_id: binding.provider_id.clone(),
                    access: binding.access,
                    adapter: binding.adapter,
                    priority: binding.priority,
                    enabled: binding.enabled,
                    host: (binding.access == Access::Bridge)
                        .then(|| binding.endpoint.as_ref().unwrap().host.clone()),
                    port: (binding.access == Access::Bridge).then(|| binding.endpoint.as_ref().unwrap().port),
                    console: binding.console.clone(),
                    launch: binding.launch.clone(),
                    view_only: binding.view_only,
                    config: binding.config.clone(),
                    confirm: false,
                })
                .collect(),
        }
    }

    /// A VNC server on loopback that offers VncAuth and records which
    /// password reached it. Loopback is never a valid endpoint, so tests
    /// rewrite the pinned address after saving.
    async fn vnc_server() -> (u16, tokio::task::JoinHandle<[u8; 16]>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.write_all(b"RFB 003.008\n").await.unwrap();
            let mut banner = [0; 12];
            socket.read_exact(&mut banner).await.unwrap();
            socket.write_all(&[1, rfb::SECURITY_VNC_AUTH]).await.unwrap();
            let mut chosen = [0; 1];
            socket.read_exact(&mut chosen).await.unwrap();
            socket.write_all(&[7; 16]).await.unwrap();
            let mut response = [0; 16];
            socket.read_exact(&mut response).await.unwrap();
            socket.write_all(&[0, 0, 0, 0]).await.unwrap();
            let mut rest = Vec::new();
            let _ = socket.read_to_end(&mut rest).await;
            response
        });
        (port, task)
    }

    fn point_at_loopback(fixture: &Fixture, target_id: &str) {
        let mut store = fixture.host.store.lock();
        let mut target = store.get(target_id).unwrap().clone();
        for binding in &mut target.bindings {
            binding.endpoint.as_mut().unwrap().pinned_ip = "127.0.0.1".parse().unwrap();
        }
        store.put(target).unwrap();
    }

    #[tokio::test]
    async fn saving_pins_confirms_and_mints_ids() {
        let fixture = fixture();
        let mut unconfirmed = binding_draft("nas.local", 5900, Adapter::Vnc, false);
        unconfirmed.confirm = false;
        let error = fixture.host.save_target(&me(), draft(vec![unconfirmed])).await.unwrap_err();
        assert_eq!(error.code, "remote_desktop_endpoint_unconfirmed");
        assert_eq!(error.detail.as_deref(), Some("private"));
        let target = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("nas.local", 5900, Adapter::Vnc, false)]))
            .await
            .unwrap();
        assert_eq!(target.name, "Studio NAS");
        let binding = &target.bindings[0];
        let endpoint = binding.endpoint.as_ref().unwrap();
        assert_eq!(endpoint.pinned_ip, "192.168.1.20".parse::<IpAddr>().unwrap());
        assert_eq!(endpoint.class, EndpointClass::Private);
        assert!(endpoint.confirmed_at > 0);
        assert_eq!(binding.id.len(), 32);
        // An unchanged endpoint keeps its confirmation without re-confirming.
        let again = fixture.host.save_target(&me(), edit(&target)).await.unwrap();
        assert_eq!(
            again.bindings[0].endpoint.as_ref().unwrap().confirmed_at,
            endpoint.confirmed_at
        );
        assert_eq!(again.created_at, target.created_at);
        // The name moving to a new address needs a fresh confirmation.
        *fixture.resolver.0.lock() = vec!["203.0.113.50".parse().unwrap(), "8.8.8.8".parse().unwrap()];
        let error = fixture.host.save_target(&me(), edit(&target)).await.unwrap_err();
        assert_eq!(error.code, "remote_desktop_endpoint_forbidden");
        *fixture.resolver.0.lock() = vec!["8.8.8.8".parse().unwrap()];
        let error = fixture.host.save_target(&me(), edit(&target)).await.unwrap_err();
        assert_eq!(error.detail.as_deref(), Some("public"));
        // Ids the Host did not mint are refused.
        let mut forged = edit(&target);
        forged.bindings[0].id = Some("someone-elses".into());
        forged.bindings[0].confirm = true;
        assert_eq!(
            fixture.host.save_target(&me(), forged).await.unwrap_err().code,
            "remote_desktop_binding_not_found"
        );
        let mut unknown = edit(&target);
        unknown.id = Some("nope".into());
        assert_eq!(
            fixture.host.save_target(&me(), unknown).await.unwrap_err().code,
            "remote_desktop_target_not_found"
        );
        let page = fixture.host.list_targets(None, None).await.unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.next_page_token.is_none());
        assert_eq!(
            fixture.host.list_targets(None, Some("garbage")).await.unwrap_err().code,
            "remote_desktop_page_token_invalid"
        );
    }

    #[tokio::test]
    async fn credentials_are_write_only_and_follow_their_binding() {
        let fixture = fixture();
        let target = fixture
            .host
            .save_target(&me(), draft(vec![
                binding_draft("192.168.1.20", 5900, Adapter::Vnc, true),
                binding_draft("192.168.1.21", 5901, Adapter::None, false),
            ]))
            .await
            .unwrap();
        let (vnc, raw) = (&target.bindings[0], &target.bindings[1]);
        let updated = fixture
            .host
            .set_credential(&me(), &target.id, &vnc.id, CredentialKind::Control, Some("secret".into()))
            .await
            .unwrap();
        assert!(updated.bindings[0].has_control_credential);
        assert!(!serde_json::to_string(&updated).unwrap().contains("secret"));
        fixture
            .host
            .set_credential(&me(), &target.id, &vnc.id, CredentialKind::View, Some("look".into()))
            .await
            .unwrap();
        assert_eq!(
            fixture
                .host
                .set_credential(&me(), &target.id, &raw.id, CredentialKind::Control, Some("x".into()))
                .await
                .unwrap_err()
                .code,
            "remote_desktop_binding_has_no_authentication"
        );
        for bad in ["", "a\0b"] {
            assert_eq!(
                fixture
                    .host
                    .set_credential(&me(), &target.id, &vnc.id, CredentialKind::Control, Some(bad.into()))
                    .await
                    .unwrap_err()
                    .code,
                "remote_desktop_credential_invalid"
            );
        }
        // Turning view-only off drops the view password; removing the
        // binding drops everything it held.
        let mut next = edit(&fixture.host.list_targets(None, None).await.unwrap().items[0]);
        next.bindings[0].view_only = false;
        next.bindings.pop();
        let saved = fixture.host.save_target(&me(), next).await.unwrap();
        assert!(!saved.bindings[0].has_view_credential);
        assert!(saved.bindings[0].has_control_credential);
        {
            let entries = fixture.credentials.entries.lock();
            assert!(entries.contains_key(&credentials::key(&vnc.id, CredentialKind::Control)));
            assert!(!entries.contains_key(&credentials::key(&vnc.id, CredentialKind::View)));
        }
        // A failing secret store aborts the delete and keeps the target.
        fixture.credentials.fail.store(true, Ordering::SeqCst);
        assert_eq!(
            fixture.host.delete_target(&me(), &target.id).await.unwrap_err().code,
            "remote_desktop_credential_unavailable"
        );
        fixture.credentials.fail.store(false, Ordering::SeqCst);
        fixture.host.delete_target(&me(), &target.id).await.unwrap();
        assert!(fixture.credentials.entries.lock().is_empty());
        fixture.host.delete_target(&me(), &target.id).await.unwrap();
        assert!(fixture.host.list_targets(None, None).await.unwrap().items.is_empty());
    }

    #[tokio::test]
    async fn view_needs_a_server_enforced_password_and_control_bridges_the_stored_one() {
        let fixture = fixture();
        let (port, server) = vnc_server().await;
        let target = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("192.168.1.20", port, Adapter::Vnc, false)]))
            .await
            .unwrap();
        let binding_id = target.bindings[0].id.clone();
        assert_eq!(
            fixture
                .host
                .open_session(&me(), &target.id, &binding_id, SessionMode::View, false)
                .await
                .unwrap_err()
                .code,
            "remote_desktop_binding_cannot_be_read_only"
        );
        fixture
            .host
            .set_credential(&me(), &target.id, &binding_id, CredentialKind::Control, Some("password".into()))
            .await
            .unwrap();
        point_at_loopback(&fixture, &target.id);
        let opened = fixture
            .host
            .open_session(&me(), &target.id, &binding_id, SessionMode::Control, false)
            .await
            .unwrap();
        assert!(opened.lease.is_some());
        let json = serde_json::to_string(&opened).unwrap();
        assert!(!json.contains("password"));
        let (mut viewer, _) = tokio_tungstenite::connect_async(opened.url.as_deref().unwrap()).await.unwrap();
        use futures_util::StreamExt;
        let mut received = Vec::new();
        while received.len() < 12 {
            if let Some(Ok(tokio_tungstenite::tungstenite::Message::Binary(bytes))) = viewer.next().await {
                received.extend_from_slice(&bytes);
            }
        }
        assert_eq!(&received[..12], b"RFB 003.008\n");
        fixture.host.renew_session(&me(), &opened.session_id).unwrap();
        fixture.host.close_session(&me(), &opened.session_id);
        let _ = viewer.close(None).await;
        assert_eq!(server.await.unwrap(), rfb::vnc_auth_response("password", &[7; 16]));
    }

    #[tokio::test]
    async fn opens_refuse_disabled_bindings_missing_secrets_and_changed_endpoints() {
        let fixture = fixture();
        let target = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("192.168.1.20", 5900, Adapter::Vnc, true)]))
            .await
            .unwrap();
        let binding_id = target.bindings[0].id.clone();
        // The flag says present but the secret store lost it.
        fixture
            .host
            .set_credential(&me(), &target.id, &binding_id, CredentialKind::View, Some("look".into()))
            .await
            .unwrap();
        fixture.credentials.entries.lock().clear();
        assert_eq!(
            fixture
                .host
                .open_session(&me(), &target.id, &binding_id, SessionMode::View, false)
                .await
                .unwrap_err()
                .code,
            "remote_desktop_credential_missing"
        );
        let mut disabled = edit(&target);
        disabled.bindings[0].enabled = false;
        fixture.host.save_target(&me(), disabled).await.unwrap();
        assert_eq!(
            fixture
                .host
                .open_session(&me(), &target.id, &binding_id, SessionMode::Control, true)
                .await
                .unwrap_err()
                .code,
            "remote_desktop_binding_disabled"
        );
        assert_eq!(
            fixture
                .host
                .open_session(&me(), &target.id, "missing", SessionMode::Control, true)
                .await
                .unwrap_err()
                .code,
            "remote_desktop_binding_not_found"
        );
        let named = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("nas.local", 5900, Adapter::Vnc, false)]))
            .await
            .unwrap();
        *fixture.resolver.0.lock() = vec!["192.168.1.7".parse().unwrap()];
        assert_eq!(
            fixture
                .host
                .probe(ProbeRequest::Saved {
                    target_id: named.id.clone(),
                    binding_id: named.bindings[0].id.clone(),
                })
                .await
                .unwrap_err()
                .code,
            "remote_desktop_endpoint_changed"
        );
    }

    #[tokio::test]
    async fn a_draft_probe_resolves_first_and_connects_only_once_confirmed() {
        let fixture = fixture();
        let outcome = fixture
            .host
            .probe(ProbeRequest::Draft {
                host: "nas.local".into(),
                port: 5900,
                adapter: Adapter::Vnc,
                confirm: false,
            })
            .await
            .unwrap();
        assert_eq!(outcome.class, EndpointClass::Private);
        assert!(!outcome.connected && outcome.rfb.is_none());
        assert_eq!(
            fixture
                .host
                .probe(ProbeRequest::Draft {
                    host: "127.0.0.1".into(),
                    port: 5900,
                    adapter: Adapter::Vnc,
                    confirm: true,
                })
                .await
                .unwrap_err()
                .code,
            "remote_desktop_endpoint_forbidden"
        );
        let parsed: ProbeRequest = serde_json::from_value(json!({
            "kind":"saved", "targetId":"t", "bindingId":"b"
        }))
        .unwrap();
        assert!(matches!(parsed, ProbeRequest::Saved { .. }));
        assert!(serde_json::from_value::<ProbeRequest>(json!({
            "kind":"draft", "host":"h", "port":1, "adapter":"vnc", "password":"x"
        }))
        .is_err());
    }

    #[tokio::test]
    async fn editing_a_binding_ends_its_sessions() {
        let fixture = fixture();
        let target = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("192.168.1.20", 5900, Adapter::None, false)]))
            .await
            .unwrap();
        let binding_id = target.bindings[0].id.clone();
        let opened = fixture
            .host
            .open_session(&me(), &target.id, &binding_id, SessionMode::Control, false)
            .await
            .unwrap();
        // Renaming keeps the session.
        let mut renamed = edit(&target);
        renamed.name = "Renamed".into();
        let renamed = fixture.host.save_target(&me(), renamed).await.unwrap();
        fixture.host.renew_session(&me(), &opened.session_id).unwrap();
        let mut moved = edit(&renamed);
        moved.bindings[0].port = Some(5901);
        moved.bindings[0].confirm = true;
        fixture.host.save_target(&me(), moved).await.unwrap();
        assert_eq!(
            fixture.host.renew_session(&me(), &opened.session_id).unwrap_err().code,
            "remote_desktop_session_not_found"
        );
    }

    #[tokio::test]
    async fn a_paired_device_attaches_its_own_stream_and_never_gets_a_loopback_url() {
        let fixture = fixture();
        let (port, server) = vnc_server().await;
        let target = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("192.168.1.20", port, Adapter::Vnc, false)]))
            .await
            .unwrap();
        let binding_id = target.bindings[0].id.clone();
        fixture
            .host
            .set_credential(&me(), &target.id, &binding_id, CredentialKind::Control, Some("password".into()))
            .await
            .unwrap();
        point_at_loopback(&fixture, &target.id);
        let view_only = Principal::device("phone", Arc::new(|mode| mode == SessionMode::View));
        assert_eq!(
            fixture
                .host
                .open_session(&view_only, &target.id, &binding_id, SessionMode::Control, false)
                .await
                .unwrap_err()
                .code,
            "remote_desktop_forbidden"
        );
        let phone = Principal::device("phone", Arc::new(|_| true));
        let opened = fixture
            .host
            .open_session(&phone, &target.id, &binding_id, SessionMode::Control, false)
            .await
            .unwrap();
        assert!(opened.url.is_none());
        assert_eq!(serde_json::to_value(&opened).unwrap()["transport"], "companion");
        let (mut viewer, host_end) = tokio::io::duplex(64 * 1024);
        assert_eq!(
            fixture
                .host
                .attach_viewer(&me(), &opened.session_id, Box::new(tokio::io::duplex(8).1))
                .unwrap_err()
                .code,
            "remote_desktop_session_not_found"
        );
        fixture.host.attach_viewer(&phone, &opened.session_id, Box::new(host_end)).unwrap();
        let mut banner = [0; 12];
        viewer.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"RFB 003.008\n");
        fixture.host.renew_session(&phone, &opened.session_id).unwrap();
        assert!(fixture.host.renew_session(&me(), &opened.session_id).is_err());
        fixture.host.close_session(&phone, &opened.session_id);
        drop(viewer);
        assert_eq!(server.await.unwrap(), rfb::vnc_auth_response("password", &[7; 16]));
    }

    fn console_draft(url: &str, profile: ConsoleProfile) -> BindingDraft {
        BindingDraft {
            access: Access::WebConsole,
            adapter: Adapter::None,
            host: None,
            port: None,
            console: Some(WebConsole {
                url: url.into(),
                profile,
            }),
            provider_id: "cognia-remote-desktop-web-console.guacamole".into(),
            ..binding_draft("unused", 1, Adapter::None, false)
        }
    }

    fn app_draft(peer_id: &str) -> BindingDraft {
        BindingDraft {
            access: Access::ExternalApp,
            adapter: Adapter::None,
            host: None,
            port: None,
            launch: Some(crate::launch::AppLaunch {
                launcher: Launcher::Rustdesk,
                peer_id: peer_id.into(),
                server: Some("rd.example.com:21116".into()),
                key: Some("Ab+/=".into()),
            }),
            provider_id: "cognia-remote-desktop-rustdesk.rustdesk".into(),
            confirm: false,
            ..binding_draft("unused", 1, Adapter::None, false)
        }
    }

    #[tokio::test]
    async fn consoles_pin_their_link_host_and_apps_need_no_endpoint() {
        let fixture = fixture();
        let target = fixture
            .host
            .save_target(
                &me(),
                draft(vec![
                    console_draft("http://gw.lan:8080/guacamole/#/client/abc", ConsoleProfile::Guacamole),
                    app_draft("123 456 789"),
                ]),
            )
            .await
            .unwrap();
        let console = &target.bindings[0];
        let endpoint = console.endpoint.as_ref().unwrap();
        assert_eq!((endpoint.host.as_str(), endpoint.port), ("gw.lan", 8080));
        assert_eq!(endpoint.class, EndpointClass::Private);
        let app = &target.bindings[1];
        assert!(app.endpoint.is_none());
        assert_eq!(app.launch.as_ref().unwrap().peer_id, "123456789");
        // Plain http over the internet would send the console sign-in in clear.
        *fixture.resolver.0.lock() = vec!["8.8.8.8".parse().unwrap()];
        let mut public = draft(vec![console_draft("http://gw.example.com/#/client/abc", ConsoleProfile::Guacamole)]);
        public.bindings[0].confirm = true;
        assert_eq!(
            fixture.host.save_target(&me(), public).await.unwrap_err().code,
            "remote_desktop_console_url_insecure"
        );
        let mut unconfirmed = draft(vec![console_draft("https://gw.example.com/#/client/abc", ConsoleProfile::Guacamole)]);
        unconfirmed.bindings[0].confirm = false;
        assert_eq!(
            fixture.host.save_target(&me(), unconfirmed).await.unwrap_err().code,
            "remote_desktop_endpoint_unconfirmed"
        );
    }

    #[tokio::test]
    async fn launching_needs_control_and_names_only_where_to_go() {
        let fixture = fixture();
        let target = fixture
            .host
            .save_target(
                &me(),
                draft(vec![
                    console_draft("https://mesh.lan/?gotonode=node%2F%2Fabc", ConsoleProfile::Meshcentral),
                    app_draft("123456789"),
                    binding_draft("192.168.1.20", 5900, Adapter::Vnc, false),
                ]),
            )
            .await
            .unwrap();
        let ids: Vec<String> = target.bindings.iter().map(|b| b.id.clone()).collect();
        assert_eq!(
            fixture.host.launch(&me(), &target.id, &ids[0]).await.unwrap(),
            Launched::WebConsole {
                url: "https://mesh.lan/?gotonode=node%2F%2Fabc&viewmode=11".into(),
                profile: ConsoleProfile::Meshcentral,
            }
        );
        let app = fixture.host.launch(&me(), &target.id, &ids[1]).await.unwrap();
        assert_eq!(
            serde_json::to_value(&app).unwrap(),
            json!({"kind": "external-app", "launcher": "rustdesk",
                "uri": "rustdesk://connection/new/123456789@rd.example.com:21116?key=Ab%2B%2F%3D"})
        );
        assert_eq!(
            fixture.host.launch(&me(), &target.id, &ids[2]).await.unwrap_err().code,
            "remote_desktop_binding_not_launchable"
        );
        let observer = Principal::device("phone", Arc::new(|mode| mode == SessionMode::View));
        assert_eq!(
            fixture.host.launch(&observer, &target.id, &ids[1]).await.unwrap_err().code,
            "remote_desktop_forbidden"
        );
        // Neither kind has a session to open.
        for id in &ids[..2] {
            assert_eq!(
                fixture
                    .host
                    .open_session(&me(), &target.id, id, SessionMode::Control, false)
                    .await
                    .unwrap_err()
                    .code,
                "remote_desktop_binding_not_bridged"
            );
        }
        // A console whose name moved needs saving again.
        *fixture.resolver.0.lock() = vec!["192.168.1.99".parse().unwrap()];
        assert_eq!(
            fixture.host.launch(&me(), &target.id, &ids[0]).await.unwrap_err().code,
            "remote_desktop_endpoint_changed"
        );
        *fixture.resolver.0.lock() = vec!["192.168.1.20".parse().unwrap()];
        let mut disabled = edit(&target);
        disabled.bindings[1].enabled = false;
        fixture.host.save_target(&me(), disabled).await.unwrap();
        assert_eq!(
            fixture.host.launch(&me(), &target.id, &ids[1]).await.unwrap_err().code,
            "remote_desktop_binding_disabled"
        );
    }

    #[tokio::test]
    async fn turning_a_bridge_into_a_console_clears_its_secrets_and_sessions() {
        let fixture = fixture();
        let target = fixture
            .host
            .save_target(&me(), draft(vec![binding_draft("192.168.1.20", 5900, Adapter::Vnc, true)]))
            .await
            .unwrap();
        let id = target.bindings[0].id.clone();
        for kind in [CredentialKind::Control, CredentialKind::View] {
            fixture
                .host
                .set_credential(&me(), &target.id, &id, kind, Some("secret".into()))
                .await
                .unwrap();
        }
        let mut console = edit(&fixture.host.list_targets(None, None).await.unwrap().items[0]);
        console.bindings[0] = BindingDraft {
            id: Some(id.clone()),
            view_only: false,
            confirm: true,
            ..console_draft("https://gw.lan/#/client/abc", ConsoleProfile::Guacamole)
        };
        let saved = fixture.host.save_target(&me(), console).await.unwrap();
        let binding = &saved.bindings[0];
        assert_eq!(binding.access, Access::WebConsole);
        assert!(!binding.has_control_credential && !binding.has_view_credential);
        assert!(fixture.credentials.entries.lock().is_empty());
        assert_eq!(
            fixture
                .host
                .set_credential(&me(), &saved.id, &id, CredentialKind::Control, Some("x".into()))
                .await
                .unwrap_err()
                .code,
            "remote_desktop_binding_has_no_authentication"
        );
        let app = fixture
            .host
            .save_target(&me(), draft(vec![app_draft("123456789")]))
            .await
            .unwrap();
        assert_eq!(
            fixture
                .host
                .probe(ProbeRequest::Saved {
                    target_id: app.id.clone(),
                    binding_id: app.bindings[0].id.clone(),
                })
                .await
                .unwrap_err()
                .code,
            "remote_desktop_binding_has_no_endpoint"
        );
    }
}
