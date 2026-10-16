//! Host-owned manual control. Live frames and leases are never persisted.
//! Reuses the computer-server driver and uncertainty quarantine. Agent input
//! remains dormant until acceptance-bound delegation ships in P3.
use super::*;
use crate::automation::{
    session::UiAction,
    types::{Point, Screenshot},
};
use crate::cua_sandbox::{
    desktop_session::{self, RemoteDesktop},
    remote_client::CuaRemoteClient,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, Instant},
};

const LEASE_MS: i64 = 15_000;
const FRAME_MS: i64 = 5_000;

/// Implemented by the authenticated Host, checking its live device/owner
/// authority store. A captured request context alone is not a revocation check.
#[async_trait]
pub trait ManagedControlAuthority: Send + Sync {
    async fn revalidate(&self, principal: &ManagedDesktopPrincipal) -> Result<()>;
    /// An owned live check used by the shared command pump immediately before
    /// each send, including the second command of a compound operation.
    fn input_admission(
        &self,
        principal: &ManagedDesktopPrincipal,
    ) -> Arc<dyn Fn() -> bool + Send + Sync>;
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedControlLease {
    pub token: String,
    pub fence: u64,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedControlFrame {
    pub frame_id: String,
    pub fence: u64,
    pub expires_at: i64,
    pub screenshot: Screenshot,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedControlStatus {
    pub qualified: bool,
    pub state: String,
    pub controller_kind: Option<String>,
    pub controller_is_self: bool,
    pub lease_expires_at: Option<i64>,
    pub fence: u64,
    pub can_acquire: bool,
    pub agent_control_dormant: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlQualificationReceipt {
    pub binding_digest: String,
    pub template: TemplateIdentity,
    pub smoke_desktop_id: String,
    #[serde(default)]
    pub smoke_desktop_generation: u64,
    pub observed_at: i64,
    pub protocol_revision: u32,
    /// Absent legacy receipts remain readable but cannot qualify control.
    #[serde(default)]
    pub evidence_version: u32,
    #[serde(default)]
    pub assertions: ControlQualificationAssertions,
}

/// Native diagnostics exercise the production driver and fencing with two
/// synthetic administrator identities. They do not grant agent delegation or
/// prove external device authentication, consent or administrator lease wiring.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlQualificationAssertions {
    pub authenticated_websocket_and_decoded_frame: bool,
    pub explicit_takeover_required: bool,
    pub exclusive_controller: bool,
    pub human_release_transfer: bool,
    pub old_token_and_frame_rejected: bool,
    pub single_use_frame: bool,
    pub expired_frame_rejected: bool,
    pub expired_lease_rejected: bool,
    pub principal_revocation_rejected: bool,
    pub live_authority_revocation_rejected: bool,
    pub compound_send_revocation: bool,
    pub service_reopen_invalidates_tokens: bool,
    pub quarantine_survives_reopen: bool,
    pub agent_delegation_refused: bool,
}
impl ControlQualificationReceipt {
    pub fn has_complete_evidence(&self) -> bool {
        let a = &self.assertions;
        self.evidence_version == 2
            && self.protocol_revision == 1
            && self.smoke_desktop_generation > 0
            && a.authenticated_websocket_and_decoded_frame
            && a.explicit_takeover_required
            && a.exclusive_controller
            && a.human_release_transfer
            && a.old_token_and_frame_rejected
            && a.single_use_frame
            && a.expired_frame_rejected
            && a.expired_lease_rejected
            && a.principal_revocation_rejected
            && a.live_authority_revocation_rejected
            && a.compound_send_revocation
            && a.service_reopen_invalidates_tokens
            && a.quarantine_survives_reopen
            && a.agent_delegation_refused
    }
}
struct Lease {
    dto: ManagedControlLease,
    principal: String,
    deadline: Instant,
    epoch: u64,
}
struct Frame {
    id: String,
    fence: u64,
    deadline: Instant,
    width: u32,
    height: u32,
}
pub(super) struct ManagedControl {
    desktop: RemoteDesktop,
    client: Option<Arc<CuaRemoteClient>>,
    lease: Option<Lease>,
    frames: BTreeMap<String, Vec<Frame>>,
    fence: u64,
    generation: u64,
    revoked: Arc<AtomicU64>,
}
impl ManagedControl {
    fn new(generation: u64) -> Self {
        Self {
            desktop: Default::default(),
            client: None,
            lease: None,
            frames: Default::default(),
            fence: 0,
            generation,
            revoked: Arc::new(AtomicU64::new(0)),
        }
    }
    fn invalidate(&mut self) {
        self.fence = self.fence.saturating_add(1);
        self.lease = None;
        self.frames.clear();
        self.desktop.invalidate();
    }
    fn expire(&mut self) {
        if self.lease.as_ref().is_some_and(|l| {
            Instant::now() >= l.deadline || self.revoked.load(Ordering::SeqCst) != l.epoch
        }) {
            self.invalidate();
        }
    }
    fn require_lease(
        &mut self,
        p: &ManagedDesktopPrincipal,
        token: &str,
        fence: u64,
    ) -> Result<()> {
        p.require_human()?;
        self.expire();
        self.desktop.require_quiescent().map_err(control_error)?;
        if !self.lease.as_ref().is_some_and(|l| {
            l.principal == p.principal_id
                && l.dto.token == token
                && l.dto.fence == fence
                && self.fence == fence
        }) {
            return Err(refused("managed_desktop_control_lease_expired"));
        }
        Ok(())
    }
    fn issue(
        &mut self,
        p: &ManagedDesktopPrincipal,
        now: i64,
        desktop_deadline: i64,
    ) -> ManagedControlLease {
        self.invalidate();
        let ttl = LEASE_MS.min(desktop_deadline.saturating_sub(now)).max(0);
        let dto = ManagedControlLease {
            token: Uuid::new_v4().to_string(),
            fence: self.fence,
            expires_at: now + ttl,
        };
        self.lease = Some(Lease {
            dto: dto.clone(),
            principal: p.principal_id.clone(),
            epoch: self.revoked.load(Ordering::SeqCst),
            deadline: Instant::now() + Duration::from_millis(ttl as u64),
        });
        dto
    }
}
fn control_error(_: crate::automation::types::AutomationError) -> ManagedDesktopError {
    refused("managed_desktop_control_unavailable")
}

/// Native operator entry, deliberately absent from all RPC/agent registries.
/// Creates one explicitly quoted 120s resource and measures the control path.
/// The receipt cannot be installed from caller-provided success booleans.
pub async fn run_control_qualification_smoke(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<ControlQualificationReceipt> {
    p.require_admin()?;
    let source = format!("control-smoke:{}", Uuid::new_v4());
    let result = control_smoke_steps(host, p, config_id, &source).await;
    // Always reopen and inspect the source binding, including uncertain create
    // failures before a desktop ID was returned. Delete persists retry state.
    let service = host.open(host.provider())?;
    let rows = service
        .state
        .lock()
        .await
        .desktops
        .values()
        .filter(|row| row.source_id.as_deref() == Some(source.as_str()))
        .map(|row| row.desktop.clone())
        .collect::<Vec<_>>();
    let mut cleanup_pending = false;
    for row in rows {
        match service.delete(p, &row.id, row.generation).await {
            Ok(row) if row.state == ManagedDesktopState::Destroyed => {}
            _ => cleanup_pending = true,
        }
    }
    if cleanup_pending {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    let receipt = result?;
    if !receipt.has_complete_evidence() {
        return Err(refused("managed_desktop_control_smoke_failed"));
    }
    service
        .transaction(|s, _| {
            s.control_qualifications
                .insert(receipt.binding_digest.clone(), receipt.clone());
            Ok(())
        })
        .await?;
    Ok(receipt)
}

fn require_smoke_error<T>(result: Result<T>, code: &str) -> Result<()> {
    match result {
        Err(error) if error.code == code => Ok(()),
        other => {
            let actual = other
                .as_ref()
                .err()
                .map(|e| smoke_error_label(&e.code))
                .unwrap_or("unexpected_success");
            eprintln!(
                "Native control smoke expected={} actual={actual}",
                smoke_error_label(code)
            );
            Err(refused("managed_desktop_control_smoke_failed"))
        }
    }
}

async fn smoke_input(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    frame: &ManagedControlFrame,
    authority: &NativeSmokeAuthority,
) -> Result<()> {
    // Actual two-command driver operation, with no click or content mutation.
    service
        .control_input_inner(
            p,
            &desktop.id,
            desktop.generation,
            &lease.token,
            lease.fence,
            &frame.frame_id,
            Some(Point { x: 0, y: 0 }),
            UiAction::Scroll {
                opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 },
            },
            authority,
            true,
        )
        .await
}

// Positive probes must not borrow frame lifetime from unrelated negative
// checks. Renewal precedes capture, so its provider reads consume no frame TTL.
async fn fresh_smoke_input(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    desktop: &ManagedDesktop,
    lease: &ManagedControlLease,
    authority: &NativeSmokeAuthority,
) -> Result<(ManagedControlLease, ManagedControlFrame)> {
    let lease = service
        .control_renew_inner(
            p,
            &desktop.id,
            desktop.generation,
            &lease.token,
            lease.fence,
            authority,
            true,
        )
        .await?;
    let frame = service
        .control_frame_inner(p, &desktop.id, desktop.generation, authority, true)
        .await?;
    smoke_input(service, p, desktop, &lease, &frame, authority).await?;
    Ok((lease, frame))
}

fn smoke_error_label(code: &str) -> &str {
    if code.starts_with("managed_desktop_")
        && code.len() <= 128
        && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        code
    } else {
        "unexpected_error_code"
    }
}

async fn control_smoke_steps(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    source: &str,
) -> Result<ControlQualificationReceipt> {
    let started = Instant::now();
    let mut stage = "admission";
    let outcome: Result<ControlQualificationReceipt> = async {
        let service = host.open(host.provider())?;
        let config = service.config(p, config_id).await?;
        let digest = config.binding_digest();
        {
            let state = service.state.lock().await;
            if !latest_template(&state, &digest)
                .and_then(|t| t.identity.as_ref())
                .is_some_and(|t| lifecycle_diagnostic_valid(&state, &digest, t))
            {
                return Err(refused("managed_desktop_unqualified"));
            }
        }
        let request = smoke::authorized_request(
            host,
            &service,
            p,
            config_id,
            AuthorizationPurpose::Smoke,
            source,
        )
        .await?;
        stage = "create_and_readiness";
        let desktop = service.create_smoke(p, request).await?;
        let desktop = smoke::wait_ready(&service, p, desktop, &smoke::RealWait).await?;
        let authority = NativeSmokeAuthority::new(p);
        let mut assertions = ControlQualificationAssertions::default();
        stage = "explicit_takeover";
        require_smoke_error(
            service
                .control_acquire_inner(p, &desktop.id, desktop.generation, false, &authority, true)
                .await,
            "managed_desktop_control_takeover_required",
        )?;
        assertions.explicit_takeover_required = true;
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        stage = "exclusive_controller";
        let mut second = p.clone();
        second.principal_id = format!("smoke-second-{}", Uuid::new_v4());
        require_smoke_error(
            service
                .control_acquire_inner(
                    &second,
                    &desktop.id,
                    desktop.generation,
                    true,
                    &authority,
                    true,
                )
                .await,
            "managed_desktop_control_busy",
        )?;
        assertions.exclusive_controller = true;
        stage = "authenticated_frame";
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        if frame.screenshot.width == 0
            || frame.screenshot.height == 0
            || frame.screenshot.bytes.is_empty()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        // connect_managed independently challenges both missing ingress and guest
        // authentication before opening the authenticated WebSocket.
        assertions.authenticated_websocket_and_decoded_frame = true;
        stage = "wrong_fence_and_agent_denials";
        let mut wrong_fence = lease.clone();
        wrong_fence.fence = wrong_fence.fence.saturating_add(1);
        require_smoke_error(
            smoke_input(&service, p, &desktop, &wrong_fence, &frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        require_smoke_error(
            smoke_input(&service, &agent, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_human_authorization_required",
        )?;
        assertions.agent_delegation_refused = true;
        stage = "first_positive_fresh_input";
        let (lease, frame) = fresh_smoke_input(&service, p, &desktop, &lease, &authority).await?;
        stage = "single_use_frame";
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_control_stale_frame",
        )?;
        assertions.single_use_frame = true;
        stage = "frame_expiry";
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &authority,
                true,
            )
            .await?;
        let stale = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        tokio::time::sleep(Duration::from_millis(FRAME_MS as u64 + 100)).await;
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &stale, &authority).await,
            "managed_desktop_control_stale_frame",
        )?;
        assertions.expired_frame_rejected = true;
        stage = "human_release_transfer";
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &authority,
                true,
            )
            .await?;
        let transfer_frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        service
            .control_release(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &authority,
            )
            .await?;
        let second_lease = service
            .control_acquire_inner(
                &second,
                &desktop.id,
                desktop.generation,
                true,
                &authority,
                true,
            )
            .await?;
        if second_lease.fence <= lease.fence || second_lease.token == lease.token {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        stage = "transferred_frame_still_fresh";
        if service.now().await >= transfer_frame.expires_at {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        stage = "old_token_and_frame_denials";
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &transfer_frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        require_smoke_error(
            smoke_input(
                &service,
                &second,
                &desktop,
                &second_lease,
                &transfer_frame,
                &authority,
            )
            .await,
            "managed_desktop_control_stale_frame",
        )?;
        assertions.old_token_and_frame_rejected = true;
        stage = "transferred_positive_fresh_input";
        let (second_lease, _) =
            fresh_smoke_input(&service, &second, &desktop, &second_lease, &authority).await?;
        assertions.human_release_transfer = true;
        stage = "principal_revocation";
        // A fresh frame distinguishes epoch revocation from frame expiry.
        let second_frame = service
            .control_frame_inner(&second, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let sent = authority.admitted.load(Ordering::SeqCst);
        service.revoke_control_principal(&second.principal_id).await;
        require_smoke_error(
            smoke_input(
                &service,
                &second,
                &desktop,
                &second_lease,
                &second_frame,
                &authority,
            )
            .await,
            "managed_desktop_control_lease_expired",
        )?;
        authority.require_no_sends_since(sent)?;
        assertions.principal_revocation_rejected = true;
        stage = "live_authority_revocation";
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        authority.active.store(false, Ordering::SeqCst);
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_forbidden",
        )?;
        authority.require_no_sends_since(sent)?;
        assertions.live_authority_revocation_rejected = true;
        stage = "lease_expiry";
        authority.active.store(true, Ordering::SeqCst);
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        // Real monotonic expiry, not a modified test clock or fabricated deadline.
        tokio::time::sleep(Duration::from_millis(LEASE_MS as u64 + 100)).await;
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        authority.require_no_sends_since(sent)?;
        assertions.expired_lease_rejected = true;
        stage = "service_reopen_old_token";
        let old_lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        let old_frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        // Closing the service drops its actual WebSocket senders and journal lock.
        // This is a service reopen, not an operating-system/process restart claim.
        drop(service);
        let service = host.open(host.provider())?;
        require_smoke_error(
            smoke_input(&service, p, &desktop, &old_lease, &old_frame, &authority).await,
            "managed_desktop_control_lease_expired",
        )?;
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        if lease.token == old_lease.token {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        stage = "reopened_positive_fresh_input";
        let (lease, _) = fresh_smoke_input(&service, p, &desktop, &lease, &authority).await?;
        assertions.service_reopen_invalidates_tokens = true;
        stage = "compound_send_revocation";
        let lease = service
            .control_renew_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &authority,
                true,
            )
            .await?;
        // Revoke after the first admitted command. The driver must acknowledge the
        // pointer move, then reject the second send without emitting a scroll.
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let sent = authority.admitted.load(Ordering::SeqCst);
        authority.revoke_at.store(sent + 1, Ordering::SeqCst);
        require_smoke_error(
            smoke_input(&service, p, &desktop, &lease, &frame, &authority).await,
            "managed_desktop_control_quarantined",
        )?;
        if authority.admitted.load(Ordering::SeqCst) != sent + 1
            || authority.denied.load(Ordering::SeqCst) != 1
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        assertions.compound_send_revocation = true;
        stage = "quarantine_survives_reopen";
        authority.active.store(true, Ordering::SeqCst);
        drop(service);
        let service = host.open(host.provider())?;
        require_smoke_error(
            service
                .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
                .await,
            "managed_desktop_control_quarantined",
        )?;
        assertions.quarantine_survives_reopen = true;
        let row = service.scoped(p, &desktop.id, desktop.generation).await?;
        Ok(ControlQualificationReceipt {
            binding_digest: digest,
            template: row.template,
            smoke_desktop_id: desktop.id,
            smoke_desktop_generation: desktop.generation,
            observed_at: service.now().await,
            protocol_revision: 1,
            evidence_version: 2,
            assertions,
        })
    }
    .await;
    if let Err(error) = &outcome {
        eprintln!(
            "Native control smoke failed: stage={stage} code={} elapsed_ms={}",
            smoke_error_label(&error.code),
            started.elapsed().as_millis()
        );
    }
    outcome
}

/// Only constructed inside the explicitly authorized native smoke process.
struct NativeSmokeAuthority {
    owner: String,
    host: String,
    active: Arc<AtomicBool>,
    admitted: Arc<AtomicU64>,
    denied: Arc<AtomicU64>,
    revoke_at: Arc<AtomicU64>,
}
impl NativeSmokeAuthority {
    fn new(p: &ManagedDesktopPrincipal) -> Self {
        Self {
            owner: p.owner_principal_id.clone(),
            host: p.host_id.clone(),
            active: Arc::new(AtomicBool::new(true)),
            admitted: Arc::new(AtomicU64::new(0)),
            denied: Arc::new(AtomicU64::new(0)),
            revoke_at: Arc::new(AtomicU64::new(u64::MAX)),
        }
    }
    fn require_no_sends_since(&self, expected: u64) -> Result<()> {
        if self.admitted.load(Ordering::SeqCst) == expected {
            Ok(())
        } else {
            Err(refused("managed_desktop_control_smoke_failed"))
        }
    }
}
#[async_trait]
impl ManagedControlAuthority for NativeSmokeAuthority {
    fn input_admission(&self, p: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
        let scoped = p.owner_principal_id == self.owner
            && p.host_id == self.host
            && p.require_admin().is_ok();
        let (active, admitted, denied, revoke_at) = (
            self.active.clone(),
            self.admitted.clone(),
            self.denied.clone(),
            self.revoke_at.clone(),
        );
        Arc::new(move || {
            if !scoped || !active.load(Ordering::SeqCst) {
                denied.fetch_add(1, Ordering::SeqCst);
                return false;
            }
            let sequence = admitted.fetch_add(1, Ordering::SeqCst) + 1;
            if sequence == revoke_at.load(Ordering::SeqCst) {
                active.store(false, Ordering::SeqCst);
            }
            true
        })
    }
    async fn revalidate(&self, p: &ManagedDesktopPrincipal) -> Result<()> {
        if p.owner_principal_id != self.owner
            || p.host_id != self.host
            || p.require_admin().is_err()
            || !self.active.load(Ordering::SeqCst)
        {
            return Err(refused("managed_desktop_forbidden"));
        }
        Ok(())
    }
}

impl ManagedDesktopService {
    /// Fast fencing does not wait for a screenshot/input mutex. An in-flight
    /// operation remains quarantined until its acknowledgement is observed.
    pub async fn revoke_control_principal(&self, principal_id: &str) {
        if let Some(epoch) = self.control_principal_epochs.lock().await.get(principal_id) {
            epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
    pub(super) async fn revoke_control_desktop(&self, id: &str) {
        if let Some(epoch) = self.control_desktop_epochs.lock().await.get(id) {
            epoch.fetch_add(1, Ordering::SeqCst);
        }
    }
    async fn control_slot(&self, id: &str, generation: u64) -> Arc<Mutex<ManagedControl>> {
        self.controls
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| Arc::new(Mutex::new(ManagedControl::new(generation))))
            .clone()
    }
    pub(super) async fn control_qualified(&self, row: &DesktopRecord) -> bool {
        let state = self.state.lock().await;
        let digest = row.config.binding_digest();
        qualified(&state, &digest, &row.template)
            && state.control_qualifications.get(&digest).is_some_and(|r| {
                r.binding_digest == digest
                    && r.template == row.template
                    && r.has_complete_evidence()
                    && state.desktops.get(&r.smoke_desktop_id).is_some_and(|d| {
                        d.smoke
                            && d.desktop.generation == r.smoke_desktop_generation
                            && d.config.binding_digest() == digest
                            && d.template == row.template
                            && d.desktop.state == ManagedDesktopState::Destroyed
                    })
            })
    }
    async fn control_check(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<DesktopRecord> {
        authority.revalidate(p).await?;
        let row = self.scoped(p, id, generation).await?;
        let current = self.config(p, &row.config.id).await?;
        self.admission(&current, self.now().await)?;
        if current.binding_digest() != row.config.binding_digest()
            || row.delete_requested
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await)
        {
            return Err(refused("managed_desktop_control_unavailable"));
        }
        if !(smoke && row.smoke && p.authority == ManagedDesktopAuthority::Administrator)
            && !self.control_qualified(&row).await
        {
            return Err(refused("managed_desktop_control_unqualified"));
        }
        if self.state.lock().await.control_quarantines.contains(id) {
            return Err(refused("managed_desktop_control_quarantined"));
        }
        // Boundary identity is a live admission check, including reused clients.
        self.validate_live_boundary(p, &row.desktop).await?;
        // Recheck authentication after asynchronous configuration/storage work.
        authority.revalidate(p).await?;
        Ok(row)
    }
    async fn control_client(
        &self,
        row: &DesktopRecord,
        control: &mut ManagedControl,
    ) -> Result<Arc<CuaRemoteClient>> {
        if control.generation != row.desktop.generation {
            control.invalidate();
            return Err(refused("managed_desktop_stale_generation"));
        }
        if let Some(client) = &control.client {
            if !client.is_closed() {
                return Ok(client.clone());
            }
            control.invalidate();
            control.client = None;
            return Err(refused("managed_desktop_control_disconnected"));
        }
        let secrets = self.secrets.desktop(&row.desktop.id).await?;
        let mut url = desktop_endpoint(
            row.resource_id
                .as_deref()
                .ok_or_else(|| refused("managed_desktop_not_connected"))?,
            secrets.domain.as_deref(),
        )?;
        url.set_scheme("wss")
            .map_err(|_| refused("managed_desktop_endpoint_invalid"))?;
        url.set_path("/ws");
        let client = CuaRemoteClient::connect_managed(
            url.to_string(),
            &secrets.guest_token,
            secrets
                .traffic_token
                .as_deref()
                .ok_or_else(|| refused("managed_desktop_missing_endpoint_credentials"))?,
        )
        .await
        .map_err(control_error)?;
        control.client = Some(client.clone());
        Ok(client)
    }
    pub async fn control_status(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<ManagedControlStatus> {
        let row = self.scoped(p, id, generation).await?;
        let qualified = self.control_qualified(&row).await
            && self.config(p, &row.config.id).await.is_ok_and(|current| {
                current.binding_digest() == row.config.binding_digest()
                    && self.admission(&current, (self.clock)()).is_ok()
            });
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        c.expire();
        let unavailable = row.delete_requested
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await);
        let quarantined = self.state.lock().await.control_quarantines.contains(id)
            || c.desktop.require_quiescent().is_err();
        if unavailable || !qualified || quarantined {
            c.invalidate();
        }
        let state = if unavailable {
            "unavailable"
        } else if !qualified {
            "dormant"
        } else if quarantined {
            "quarantined"
        } else if c.lease.is_some() {
            "controlled"
        } else {
            "observer"
        };
        Ok(ManagedControlStatus {
            qualified,
            state: state.into(),
            controller_kind: c.lease.as_ref().map(|_| "human".into()),
            controller_is_self: c
                .lease
                .as_ref()
                .is_some_and(|l| l.principal == p.principal_id),
            lease_expires_at: c.lease.as_ref().map(|l| l.dto.expires_at),
            fence: c.fence,
            can_acquire: state == "observer" && p.require_human().is_ok(),
            agent_control_dormant: true,
        })
    }
    /// Explicit native handoff diagnostic only. The same source/generation and
    /// smoke authority fences used by transfer apply to retained checkpoints.
    pub async fn capture_handoff_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        desktop: &ManagedDesktop,
        operation_id: &str,
    ) -> Result<Screenshot> {
        p.require_admin()?;
        let expected = format!("handoff:{operation_id}");
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        if !row.smoke || row.source_id.as_deref() != Some(expected.as_str()) {
            return Err(refused("managed_desktop_handoff_desktop_not_authorized"));
        }
        let authority = NativeSmokeAuthority::new(p);
        Ok(self
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?
            .screenshot)
    }

    /// Explicit native diagnostic seam. The native-only paid-smoke permit
    /// and persisted smoke row prevent RPC callers from bypassing qualification.
    pub async fn control_frame_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<ManagedControlFrame> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_frame_inner(p, id, generation, authority, true)
            .await
    }
    pub async fn control_acquire_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        takeover: bool,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<ManagedControlLease> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_acquire_inner(p, id, generation, takeover, authority, true)
            .await
    }
    pub async fn control_renew_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<ManagedControlLease> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_renew_inner(p, id, generation, token, fence, authority, true)
            .await
    }
    pub async fn control_input_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        frame_id: &str,
        point: Option<Point>,
        action: UiAction,
        authority: &dyn ManagedControlAuthority,
        _permit: &ExplicitPaidSmokeAuthorization,
    ) -> Result<()> {
        self.require_control_smoke(p, id, generation).await?;
        self.control_input_inner(
            p, id, generation, token, fence, frame_id, point, action, authority, true,
        )
        .await
    }
    async fn require_control_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<()> {
        p.require_admin()?;
        if !self.scoped(p, id, generation).await?.smoke {
            return Err(refused("managed_desktop_control_smoke_required"));
        }
        Ok(())
    }

    pub async fn control_frame(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedControlFrame> {
        self.control_frame_inner(p, id, generation, authority, false)
            .await
    }
    async fn control_frame_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<ManagedControlFrame> {
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        let row = self
            .control_check(p, id, generation, authority, smoke)
            .await?;
        c.expire();
        let client = self.control_client(&row, &mut c).await?;
        let screenshot = desktop_session::capture(&client)
            .await
            .map_err(control_error)?;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.expire();
        let now = self.now().await;
        let ttl = FRAME_MS
            .min(row.desktop.deadline_at.saturating_sub(now))
            .max(0);
        let frame_id = Uuid::new_v4().to_string();
        // A newer poll may arrive at the Host before its pixels reach the
        // viewer. Retain prior unexpired proofs so the visible frame remains
        // usable throughout its five-second validity window.
        c.frames.retain(|_, frames| {
            frames.retain(|f| Instant::now() < f.deadline);
            !frames.is_empty()
        });
        if c.frames.len() >= 32 && !c.frames.contains_key(&p.principal_id) {
            return Err(refused("managed_desktop_control_observer_limit"));
        }
        let fence = c.fence;
        let frames = c.frames.entry(p.principal_id.clone()).or_default();
        // At 1 Hz polling a five-second window needs at most six proofs.
        // Refuse excess polling instead of evicting a still-visible proof.
        if frames.len() >= 8 {
            return Err(refused("managed_desktop_control_frame_limit"));
        }
        frames.push(Frame {
            id: frame_id.clone(),
            fence,
            deadline: Instant::now() + Duration::from_millis(ttl as u64),
            width: screenshot.width,
            height: screenshot.height,
        });
        Ok(ManagedControlFrame {
            frame_id,
            fence,
            expires_at: now + ttl,
            screenshot,
        })
    }
    pub async fn control_acquire(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        takeover: bool,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedControlLease> {
        self.control_acquire_inner(p, id, generation, takeover, authority, false)
            .await
    }
    async fn control_acquire_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        takeover: bool,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<ManagedControlLease> {
        p.require_human()?;
        if !takeover {
            return Err(refused("managed_desktop_control_takeover_required"));
        }
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        let row = self
            .control_check(p, id, generation, authority, smoke)
            .await?;
        c.expire();
        if c.lease.is_some() {
            return Err(refused("managed_desktop_control_busy"));
        }
        c.desktop.require_quiescent().map_err(control_error)?;
        let client = self.control_client(&row, &mut c).await?;
        let held = c.desktop.held_mouse_buttons.clone();
        if !held.is_empty() {
            self.transaction(|s, _| {
                s.control_quarantines.insert(id.into());
                Ok(())
            })
            .await?;
            c.desktop
                .run_mutation(async {
                    for button in held {
                        client
                            .call_simple(
                                "mouse_up",
                                serde_json::json!({"button":desktop_session::button_name(button)}),
                            )
                            .await?;
                    }
                    Ok(())
                })
                .await
                .map_err(control_error)?;
            c.desktop.held_mouse_buttons.clear();
            self.transaction(|s, _| {
                s.control_quarantines.remove(id);
                Ok(())
            })
            .await?;
        }
        desktop_session::capture(&client)
            .await
            .map_err(control_error)?;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.revoked = self
            .control_principal_epochs
            .lock()
            .await
            .entry(p.principal_id.clone())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        Ok(c.issue(p, self.now().await, row.desktop.deadline_at))
    }
    pub async fn control_renew(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<ManagedControlLease> {
        self.control_renew_inner(p, id, generation, token, fence, authority, false)
            .await
    }
    async fn control_renew_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<ManagedControlLease> {
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.require_lease(p, token, fence)?;
        let row = self.scoped(p, id, generation).await?;
        let now = self.now().await;
        let ttl = LEASE_MS
            .min(row.desktop.deadline_at.saturating_sub(now))
            .max(0);
        let lease = c.lease.as_mut().expect("validated lease");
        lease.deadline = Instant::now() + Duration::from_millis(ttl as u64);
        lease.dto.expires_at = now + ttl;
        Ok(lease.dto.clone())
    }
    pub async fn control_release(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()> {
        p.require_human()?;
        authority.revalidate(p).await?;
        self.scoped(p, id, generation).await?;
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        c.require_lease(p, token, fence)?;
        c.invalidate();
        Ok(())
    }
    pub async fn control_input(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        frame_id: &str,
        point: Option<Point>,
        action: UiAction,
        authority: &dyn ManagedControlAuthority,
    ) -> Result<()> {
        self.control_input_inner(
            p, id, generation, token, fence, frame_id, point, action, authority, false,
        )
        .await
    }
    async fn control_input_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        token: &str,
        fence: u64,
        frame_id: &str,
        point: Option<Point>,
        action: UiAction,
        authority: &dyn ManagedControlAuthority,
        smoke: bool,
    ) -> Result<()> {
        p.require_human()?;
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.require_lease(p, token, fence)?;
        let f = c
            .frames
            .get(&p.principal_id)
            .and_then(|frames| {
                frames
                    .iter()
                    .find(|f| f.id == frame_id && f.fence == fence && Instant::now() < f.deadline)
            })
            .ok_or_else(|| refused("managed_desktop_control_stale_frame"))?;
        if let Some(point) = point {
            desktop_session::validate_point(point, f.width, f.height).map_err(control_error)?;
        }
        if let UiAction::Drag { to, opts } = &action {
            desktop_session::validate_point(*to, f.width, f.height).map_err(control_error)?;
            if opts.duration_ms.unwrap_or(150) > 2_000 || opts.steps.unwrap_or(12) > 60 {
                return Err(refused("managed_desktop_control_input_limit"));
            }
        }
        if matches!(&action, UiAction::PressKey { chord } if chord.0.len() > 256) {
            return Err(refused("managed_desktop_control_input_limit"));
        }
        if matches!(&action, UiAction::TypeText { text } if text.len() > 4096) {
            return Err(refused("managed_desktop_control_input_limit"));
        }
        desktop_session::validate_action(point, &action).map_err(control_error)?;
        let client = c
            .client
            .clone()
            .ok_or_else(|| refused("managed_desktop_control_disconnected"))?;
        let deadline = c.lease.as_ref().unwrap().deadline.min(f.deadline);
        let observed_size = (f.width, f.height);
        let current = desktop_session::capture(&client)
            .await
            .map_err(control_error)?;
        if (current.width, current.height) != observed_size || Instant::now() >= deadline {
            c.frames.clear();
            return Err(refused("managed_desktop_control_stale_frame"));
        }
        if let Err(error) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(error);
        }
        c.require_lease(p, token, fence)?;
        c.frames.clear(); // A coordinate frame is single-use even on uncertainty.
        self.transaction(|s, _| {
            s.control_quarantines.insert(id.into());
            Ok(())
        })
        .await?;
        // The durable pending flag intentionally makes cancellation/restart
        // quarantine the desktop; only successful acknowledgement clears it.
        authority.revalidate(p).await?;
        c.require_lease(p, token, fence)?;
        let row = self.scoped(p, id, generation).await?;
        if row.delete_requested || row.expired(self.now().await) {
            c.invalidate();
            return Err(refused("managed_desktop_control_unavailable"));
        }
        if Instant::now() >= deadline {
            c.invalidate();
            return Err(refused("managed_desktop_control_stale_frame"));
        }
        let principal_epoch = c.revoked.clone();
        let expected_principal_epoch = c.lease.as_ref().expect("validated lease").epoch;
        let desktop_epoch = self
            .control_desktop_epochs
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone();
        let expected_desktop_epoch = desktop_epoch.load(Ordering::SeqCst);
        // Re-read deletion after installing the shared epoch: a delete cannot
        // race the first insertion and evade the pump's final send check.
        let row = self.scoped(p, id, generation).await?;
        if row.delete_requested || row.expired(self.now().await) {
            c.invalidate();
            return Err(refused("managed_desktop_control_unavailable"));
        }
        let live_authority = authority.input_admission(p);
        let client = client.fenced(Arc::new(move || {
            live_authority()
                && Instant::now() < deadline
                && principal_epoch.load(Ordering::SeqCst) == expected_principal_epoch
                && desktop_epoch.load(Ordering::SeqCst) == expected_desktop_epoch
        }));
        let outcome = tokio::time::timeout_at(
            tokio::time::Instant::from_std(deadline),
            c.desktop
                .run_mutation(desktop_session::deliver(&client, point, &action)),
        )
        .await;
        if !matches!(outcome, Ok(Ok(()))) {
            c.invalidate();
            return Err(refused("managed_desktop_control_quarantined"));
        }
        self.transaction(|s, now| {
            s.control_quarantines.remove(id);
            let row = s
                .desktops
                .get_mut(id)
                .ok_or_else(|| refused("managed_desktop_not_found"))?;
            if row.desktop.generation == generation && !row.delete_requested && !row.expired(now) {
                row.last_activity_at = now;
            }
            Ok(())
        })
        .await?;
        if let Err(e) = self
            .control_check(p, id, generation, authority, smoke)
            .await
        {
            c.invalidate();
            return Err(e);
        }
        c.require_lease(p, token, fence)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Authority(Arc<AtomicBool>);
    #[async_trait]
    impl ManagedControlAuthority for Authority {
        fn input_admission(
            &self,
            _: &ManagedDesktopPrincipal,
        ) -> Arc<dyn Fn() -> bool + Send + Sync> {
            let active = self.0.clone();
            Arc::new(move || active.load(Ordering::SeqCst))
        }
        async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
            if self.0.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(refused("managed_desktop_forbidden"))
            }
        }
    }
    struct WireFixture {
        domain: super::super::tests::Fixture,
        row: ManagedDesktop,
        server: tokio::task::JoinHandle<()>,
        pause_frame: Arc<AtomicBool>,
        frame_started: Arc<tokio::sync::Notify>,
        frame_continue: Arc<tokio::sync::Notify>,
        input_count: Arc<AtomicU64>,
        pause_input: Arc<AtomicBool>,
    }
    impl Drop for WireFixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }
    async fn wire_fixture() -> WireFixture {
        use base64::Engine as _;
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let domain = super::super::tests::Fixture::new();
        domain.prepare().await;
        let row = domain.smoke("control").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let pause_frame = Arc::new(AtomicBool::new(false));
        let frame_started = Arc::new(tokio::sync::Notify::new());
        let frame_continue = Arc::new(tokio::sync::Notify::new());
        let input_count = Arc::new(AtomicU64::new(0));
        let pause_input = Arc::new(AtomicBool::new(false));
        let block_input = pause_input.clone();
        let (pause, started, resume, inputs) = (
            pause_frame.clone(),
            frame_started.clone(),
            frame_continue.clone(),
            input_count.clone(),
        );
        let server = tokio::spawn(async move {
            let mut ws = crate::cua_sandbox::remote_client::accept_test_client(&listener).await;
            let image = xcap::image::RgbaImage::new(20, 20);
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, xcap::image::ImageFormat::Png)
                .unwrap();
            let image_data = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let command: serde_json::Value = serde_json::from_str(&text).unwrap();
                let response = if command["command"] == "screenshot" {
                    if pause.load(Ordering::SeqCst) {
                        started.notify_one();
                        resume.notified().await;
                    }
                    serde_json::json!({"status":"success","image_data":image_data})
                } else {
                    inputs.fetch_add(1, Ordering::SeqCst);
                    if block_input.load(Ordering::SeqCst) {
                        started.notify_one();
                        resume.notified().await;
                    }
                    serde_json::json!({"status":"success"})
                };
                if ws
                    .send(Message::Text(response.to_string().into()))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let client = CuaRemoteClient::connect(
            "127.0.0.1",
            port,
            crate::cua_sandbox::remote_client::TEST_AUTH_TOKEN,
        )
        .await
        .unwrap();
        domain
            .service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .client = Some(client);
        WireFixture {
            domain,
            row,
            server,
            pause_frame,
            frame_started,
            frame_continue,
            input_count,
            pause_input,
        }
    }

    #[test]
    fn legacy_partial_and_unknown_control_evidence_cannot_qualify() {
        let mut receipt = ControlQualificationReceipt {
            binding_digest: "binding".into(),
            template: TemplateIdentity {
                template_id: "template".into(),
                build_id: "build".into(),
                image_digest: "digest".into(),
                recipe_revision: "6".into(),
                protocol: "computer-server".into(),
            },
            smoke_desktop_id: "desktop".into(),
            smoke_desktop_generation: 1,
            observed_at: 1,
            protocol_revision: 1,
            evidence_version: 2,
            assertions: ControlQualificationAssertions::default(),
        };
        assert!(!receipt.has_complete_evidence());
        let mut checks = serde_json::to_value(&receipt.assertions).unwrap();
        for value in checks.as_object_mut().unwrap().values_mut() {
            *value = serde_json::json!(true);
        }
        receipt.assertions = serde_json::from_value(checks).unwrap();
        assert!(receipt.has_complete_evidence());
        let complete = serde_json::to_value(&receipt).unwrap();
        for field in complete["assertions"].as_object().unwrap().keys() {
            let mut partial = complete.clone();
            partial["assertions"][field] = serde_json::json!(false);
            assert!(
                !serde_json::from_value::<ControlQualificationReceipt>(partial)
                    .unwrap()
                    .has_complete_evidence()
            );
        }
        let mut legacy = complete.clone();
        legacy.as_object_mut().unwrap().remove("assertions");
        legacy.as_object_mut().unwrap().remove("evidenceVersion");
        assert!(
            !serde_json::from_value::<ControlQualificationReceipt>(legacy)
                .unwrap()
                .has_complete_evidence()
        );
        receipt.evidence_version = 3;
        assert!(!receipt.has_complete_evidence());
        receipt.evidence_version = 2;
        receipt.protocol_revision = 2;
        assert!(!receipt.has_complete_evidence());
    }

    #[test]
    fn control_smoke_never_counts_unrelated_failures_as_a_pass() {
        assert!(require_smoke_error::<()>(
            Err(refused("managed_desktop_control_stale_frame")),
            "managed_desktop_control_lease_expired"
        )
        .is_err());
        assert!(require_smoke_error(Ok(()), "managed_desktop_control_lease_expired").is_err());
    }

    #[tokio::test]
    async fn diagnostic_control_seams_require_native_permit_admin_and_smoke_row() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        assert!(ExplicitPaidSmokeAuthorization::from_operator_flag("confirmed").is_err());
        let permit =
            ExplicitPaidSmokeAuthorization::from_operator_flag("--authorize-paid-smoke").unwrap();
        let mut human = p.clone();
        human.authority = ManagedDesktopAuthority::Human;
        assert_eq!(
            service
                .control_frame_smoke(&human, &row.id, row.generation, &authority, &permit)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_admin_required"
        );
        service
            .transaction(|s, _| {
                s.desktops.get_mut(&row.id).unwrap().smoke = false;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(
            service
                .control_acquire_smoke(p, &row.id, row.generation, true, &authority, &permit)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_smoke_required"
        );
        assert_eq!(
            service
                .control_input_smoke(
                    p,
                    &row.id,
                    row.generation,
                    "token",
                    1,
                    "frame",
                    Some(Point { x: 0, y: 0 }),
                    UiAction::Scroll {
                        opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 }
                    },
                    &authority,
                    &permit
                )
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_smoke_required"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn positive_smoke_recaptures_after_negative_checks_expire_the_prior_frame() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let previous = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        // Model time consumed by remote negative checks without sleeping the
        // test or changing the production five-second frame deadline.
        service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .frames
            .get_mut(&p.principal_id)
            .unwrap()[0]
            .deadline = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            smoke_input(service, p, row, &lease, &previous, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_stale_frame"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        let (renewed, fresh) = fresh_smoke_input(service, p, row, &lease, &authority)
            .await
            .unwrap();
        assert_ne!(fresh.frame_id, previous.frame_id);
        assert_eq!(renewed.token, lease.token);
        assert_eq!(renewed.fence, lease.fence);
        assert_eq!(f.input_count.load(Ordering::SeqCst), 2);
        assert_eq!(FRAME_MS, 5_000);
    }

    #[test]
    fn smoke_stage_error_labels_cannot_include_secrets_or_unbounded_provider_text() {
        assert_eq!(
            smoke_error_label("managed_desktop_control_stale_frame"),
            "managed_desktop_control_stale_frame"
        );
        for value in [
            "secret",
            "https://provider.invalid/?token=secret",
            "managed_desktop_error\nsecret",
        ] {
            assert_eq!(smoke_error_label(value), "unexpected_error_code");
        }
        assert_eq!(
            smoke_error_label(&format!("managed_desktop_{}", "x".repeat(128))),
            "unexpected_error_code"
        );
    }

    #[tokio::test]
    async fn native_smoke_authority_revokes_between_actual_compound_sends() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        authority.revoke_at.store(1, Ordering::SeqCst);
        assert_eq!(
            smoke_input(service, p, row, &lease, &frame, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_quarantined"
        );
        assert_eq!(authority.admitted.load(Ordering::SeqCst), 1);
        assert_eq!(authority.denied.load(Ordering::SeqCst), 1);
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
        assert!(service
            .store
            .load("host")
            .unwrap()
            .control_quarantines
            .contains(&row.id));
        assert!(!authority.active.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn released_human_lease_transfers_and_rejects_old_tokens_and_frames() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = NativeSmokeAuthority::new(p);
        let first = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let old = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        service
            .control_release(
                p,
                &row.id,
                row.generation,
                &first.token,
                first.fence,
                &authority,
            )
            .await
            .unwrap();
        let mut other = p.clone();
        other.principal_id = "second".into();
        let next = service
            .control_acquire_inner(&other, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        assert!(next.fence > first.fence);
        assert_ne!(next.token, first.token);
        assert_eq!(
            smoke_input(service, p, row, &first, &old, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_lease_expired"
        );
        assert_eq!(
            smoke_input(service, &other, row, &next, &old, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_stale_frame"
        );
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        let frame = service
            .control_frame_inner(&other, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        smoke_input(service, &other, row, &next, &frame, &authority)
            .await
            .unwrap();
        assert_eq!(f.input_count.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn native_smoke_authority_revalidates_current_scope_and_state() {
        let mut p = principal("owner-device");
        p.authority = ManagedDesktopAuthority::Administrator;
        let authority = NativeSmokeAuthority::new(&p);
        let admission = authority.input_admission(&p);
        assert!(admission());
        authority.active.store(false, Ordering::SeqCst);
        assert!(!admission());
        assert!(authority.revalidate(&p).await.is_err());
        authority.active.store(true, Ordering::SeqCst);
        p.host_id = "other".into();
        assert!(!authority.input_admission(&p)());
        assert!(authority.revalidate(&p).await.is_err());
    }

    #[tokio::test]
    async fn retained_checkpoint_requires_exact_handoff_source_generation_and_admin() {
        let f = wire_fixture().await;
        let service = &f.domain.service;
        let p = &f.domain.p;
        assert_eq!(
            service
                .capture_handoff_smoke(p, &f.row, "acceptance")
                .await
                .unwrap_err()
                .code,
            "managed_desktop_handoff_desktop_not_authorized"
        );
        service
            .transaction(|state, _| {
                state.desktops.get_mut(&f.row.id).unwrap().source_id =
                    Some("handoff:acceptance".into());
                Ok(())
            })
            .await
            .unwrap();
        let mut stale = f.row.clone();
        stale.generation += 1;
        assert!(service
            .capture_handoff_smoke(p, &stale, "acceptance")
            .await
            .is_err());
        let mut human = p.clone();
        human.authority = ManagedDesktopAuthority::Human;
        assert!(service
            .capture_handoff_smoke(&human, &f.row, "acceptance")
            .await
            .is_err());
        assert!(service
            .capture_handoff_smoke(p, &f.row, "different")
            .await
            .is_err());
        let frame = service
            .capture_handoff_smoke(p, &f.row, "acceptance")
            .await
            .unwrap();
        assert!(!frame.bytes.is_empty());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unqualified_gui_and_agent_bypass_are_refused_before_remote_input() {
        let f = wire_fixture().await;
        let p = &f.domain.p;
        let service = &f.domain.service;
        let row = &f.row;
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        assert!(
            !service
                .control_status(p, &row.id, row.generation)
                .await
                .unwrap()
                .qualified
        );
        assert_eq!(
            service
                .control_acquire(p, &row.id, row.generation, true, &authority)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_unqualified"
        );
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(service
            .control_acquire_inner(&agent, &row.id, row.generation, true, &authority, true)
            .await
            .is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert!(!service.list_configs(p).await.unwrap()[0].gui_qualified);
    }

    #[tokio::test]
    async fn human_input_requires_fresh_single_use_frame_and_excludes_second_controller() {
        let f = wire_fixture().await;
        let p = &f.domain.p;
        let service = &f.domain.service;
        let row = &f.row;
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let mut other = p.clone();
        other.principal_id = "second-human".into();
        assert_eq!(
            service
                .control_acquire_inner(&other, &row.id, row.generation, true, &authority, true)
                .await
                .unwrap_err()
                .code,
            "managed_desktop_control_busy"
        );
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        let click = || UiAction::Click {
            button: None,
            count: None,
        };
        // The second capture has reached the Host while the first frame is
        // still displayed. Both proofs must survive until mutation/expiry.
        let later_frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        assert!(service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                Some(Point { x: 20, y: 1 }),
                click(),
                &authority,
                true
            )
            .await
            .is_err());
        service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                Some(Point { x: 1, y: 1 }),
                click(),
                &authority,
                true,
            )
            .await
            .unwrap();
        assert!(service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                Some(Point { x: 1, y: 1 }),
                click(),
                &authority,
                true
            )
            .await
            .is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
        assert!(service
            .control_input_inner(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &later_frame.frame_id,
                Some(Point { x: 1, y: 1 }),
                click(),
                &authority,
                true
            )
            .await
            .is_err());
        service
            .control_release(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &authority,
            )
            .await
            .unwrap();
        assert!(service
            .control_release(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &authority
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn capture_await_revalidates_auth_and_delete_without_delivering_input() {
        let f = wire_fixture().await;
        let p = &f.domain.p;
        let service = &f.domain.service;
        let row = &f.row;
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_frame.store(true, Ordering::SeqCst);
        let action = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            &lease.token,
            lease.fence,
            &frame.frame_id,
            Some(Point { x: 1, y: 1 }),
            UiAction::Click {
                button: None,
                count: None,
            },
            &authority,
            true,
        );
        let revoke = async {
            f.frame_started.notified().await;
            authority.0.store(false, Ordering::SeqCst);
            service.revoke_control_principal(&p.principal_id).await;
            service
                .mark_cleanup(&row.id, &refused("test_delete"))
                .await
                .unwrap();
            f.frame_continue.notify_one();
        };
        let (result, _) = tokio::join!(action, revoke);
        assert!(result.is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
        assert!(service
            .control_slot(&row.id, row.generation)
            .await
            .lock()
            .await
            .lease
            .is_none());
    }

    #[tokio::test]
    async fn uncertain_input_quarantine_is_durable_and_status_poll_does_not_extend_idle() {
        let f = wire_fixture().await;
        let service = &f.domain.service;
        let row = &f.row;
        let p = &f.domain.p;
        let original = service
            .scoped(p, &row.id, row.generation)
            .await
            .unwrap()
            .last_activity_at;
        service
            .transaction(|s, _| {
                s.control_quarantines.insert(row.id.clone());
                Ok(())
            })
            .await
            .unwrap();
        assert!(service
            .store
            .load("host")
            .unwrap()
            .control_quarantines
            .contains(&row.id));
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        assert!(service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .is_err());
        service
            .control_status(p, &row.id, row.generation)
            .await
            .unwrap();
        assert_eq!(
            service
                .scoped(p, &row.id, row.generation)
                .await
                .unwrap()
                .last_activity_at,
            original
        );
    }
    fn principal(id: &str) -> ManagedDesktopPrincipal {
        ManagedDesktopPrincipal {
            owner_principal_id: "owner".into(),
            principal_id: id.into(),
            host_id: "host".into(),
            authority: ManagedDesktopAuthority::Human,
        }
    }
    #[tokio::test]
    async fn input_size_and_click_limits_apply_without_rpc_schema_validation() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        for action in [
            UiAction::Click {
                button: None,
                count: Some(0),
            },
            UiAction::Click {
                button: None,
                count: Some(4),
            },
            UiAction::PressKey {
                chord: crate::automation::types::KeyChord("a".repeat(257)),
            },
            UiAction::TypeText {
                text: "a".repeat(4097),
            },
            UiAction::Drag {
                to: Point { x: 2, y: 2 },
                opts: crate::automation::types::DragOpts {
                    duration_ms: Some(2001),
                    ..Default::default()
                },
            },
        ] {
            assert!(service
                .control_input_inner(
                    p,
                    &row.id,
                    row.generation,
                    &lease.token,
                    lease.fence,
                    &frame.frame_id,
                    Some(Point { x: 1, y: 1 }),
                    action,
                    &authority,
                    true
                )
                .await
                .is_err());
        }
        assert_eq!(f.input_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn live_authority_revocation_preempts_compound_input_without_explicit_epoch_call() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_input.store(true, Ordering::SeqCst);
        let action = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            &lease.token,
            lease.fence,
            &frame.frame_id,
            Some(Point { x: 1, y: 1 }),
            UiAction::Click {
                button: Some(crate::automation::types::MouseButton::Middle),
                count: Some(2),
            },
            &authority,
            true,
        );
        let revoke = async {
            f.frame_started.notified().await;
            authority.0.store(false, Ordering::SeqCst);
            f.pause_input.store(false, Ordering::SeqCst);
            f.frame_continue.notify_one();
        };
        let (result, _) = tokio::join!(action, revoke);
        assert!(result.is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn cancellation_after_send_keeps_quarantine_across_late_acknowledgement() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_input.store(true, Ordering::SeqCst);
        {
            let action = service.control_input_inner(
                p,
                &row.id,
                row.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                Some(Point { x: 1, y: 1 }),
                UiAction::Click {
                    button: None,
                    count: None,
                },
                &authority,
                true,
            );
            tokio::pin!(action);
            tokio::select! {
                _ = &mut action => panic!("input completed before cancellation"),
                _ = f.frame_started.notified() => {},
            }
        }
        f.frame_continue.notify_one();
        assert!(service
            .store
            .load("host")
            .unwrap()
            .control_quarantines
            .contains(&row.id));
        assert!(service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .is_err());
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn destroy_preempts_remaining_commands_of_a_compound_input() {
        let f = wire_fixture().await;
        let (service, p, row) = (&f.domain.service, &f.domain.p, &f.row);
        let authority = Authority(Arc::new(AtomicBool::new(true)));
        let lease = service
            .control_acquire_inner(p, &row.id, row.generation, true, &authority, true)
            .await
            .unwrap();
        let frame = service
            .control_frame_inner(p, &row.id, row.generation, &authority, true)
            .await
            .unwrap();
        f.pause_input.store(true, Ordering::SeqCst);
        let action = service.control_input_inner(
            p,
            &row.id,
            row.generation,
            &lease.token,
            lease.fence,
            &frame.frame_id,
            Some(Point { x: 1, y: 1 }),
            UiAction::Click {
                button: Some(crate::automation::types::MouseButton::Middle),
                count: Some(2),
            },
            &authority,
            true,
        );
        let destroy = async {
            f.frame_started.notified().await;
            service
                .mark_cleanup(&row.id, &refused("test_delete"))
                .await
                .unwrap();
            f.pause_input.store(false, Ordering::SeqCst);
            f.frame_continue.notify_one();
        };
        let (result, _) = tokio::join!(action, destroy);
        assert!(result.is_err());
        // Only pointer movement was sent; no subsequent mouse-down or up.
        assert_eq!(f.input_count.load(Ordering::SeqCst), 1);
        assert!(service
            .state
            .lock()
            .await
            .control_quarantines
            .contains(&row.id));
    }
    #[test]
    fn lease_is_principal_and_fence_bound_and_expiry_never_resumes_agent() {
        let mut c = ManagedControl::new(1);
        let p = principal("first");
        let first = c.issue(&p, 1_000, 60_000);
        assert_eq!(first.expires_at, 16_000);
        assert!(c
            .require_lease(&principal("second"), &first.token, first.fence)
            .is_err());
        assert!(c.require_lease(&p, &first.token, first.fence + 1).is_err());
        c.lease.as_mut().unwrap().deadline = Instant::now();
        assert!(c.require_lease(&p, &first.token, first.fence).is_err());
        let next = c.issue(&p, 2_000, 60_000);
        assert!(next.fence > first.fence);
        assert!(c.require_lease(&p, &first.token, first.fence).is_err());
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(c.require_lease(&agent, &next.token, next.fence).is_err());
    }
    #[test]
    fn lease_is_capped_at_resource_deadline_and_invalidation_drops_frames() {
        let mut c = ManagedControl::new(1);
        let p = principal("human");
        let lease = c.issue(&p, 1_000, 2_000);
        assert_eq!(lease.expires_at, 2_000);
        c.frames.insert(
            p.principal_id.clone(),
            vec![Frame {
                id: "frame".into(),
                fence: lease.fence,
                deadline: Instant::now() + Duration::from_secs(5),
                width: 100,
                height: 80,
            }],
        );
        c.invalidate();
        assert!(c.frames.is_empty());
        assert!(c.lease.is_none());
    }
}
