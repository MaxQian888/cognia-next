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
    sync::atomic::{AtomicU64, Ordering},
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
    pub observed_at: i64,
    pub protocol_revision: u32,
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
/// Creates one explicitly quoted 60s resource and measures the control path.
/// The receipt cannot be installed from caller-provided success booleans.
pub async fn run_control_qualification_smoke(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<ControlQualificationReceipt> {
    p.require_admin()?;
    let service = host.open(host.provider())?;
    let config = service.config(p, config_id).await?;
    let digest = config.binding_digest();
    {
        let state = service.state.lock().await;
        if !latest_template(&state, &digest)
            .and_then(|t| t.identity.as_ref())
            .is_some_and(|t| qualified(&state, &digest, t))
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
        &format!("control-smoke:{}", Uuid::new_v4()),
    )
    .await?;
    let desktop = service.create_smoke(p, request).await?;
    let result = async {
        let desktop = smoke::wait_ready(&service, p, desktop.clone(), &smoke::RealWait).await?;
        let authority = NativeSmokeAuthority {
            owner: p.owner_principal_id.clone(),
            host: p.host_id.clone(),
        };
        let lease = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        let mut second = p.clone();
        second.principal_id = format!("smoke-second-{}", Uuid::new_v4());
        second.authority = ManagedDesktopAuthority::Administrator;
        if service
            .control_acquire_inner(
                &second,
                &desktop.id,
                desktop.generation,
                true,
                &authority,
                true,
            )
            .await
            .is_ok()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        let frame = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        let action = || UiAction::Scroll {
            opts: crate::automation::types::ScrollOpts { dx: 0, dy: 0 },
        };
        let point = Some(Point { x: 0, y: 0 });
        if service
            .control_input_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence + 1,
                &frame.frame_id,
                point,
                action(),
                &authority,
                true,
            )
            .await
            .is_ok()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        let mut agent = p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        if service
            .control_input_inner(
                &agent,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                point,
                action(),
                &authority,
                true,
            )
            .await
            .is_ok()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        // Zero scrolling moves the pointer without clicking, typing or
        // changing application content, through the actual shared driver.
        service
            .control_input_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                point,
                action(),
                &authority,
                true,
            )
            .await?;
        if service
            .control_input_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &frame.frame_id,
                point,
                action(),
                &authority,
                true,
            )
            .await
            .is_ok()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        let stale = service
            .control_frame_inner(p, &desktop.id, desktop.generation, &authority, true)
            .await?;
        tokio::time::sleep(Duration::from_millis(FRAME_MS as u64 + 100)).await;
        if service
            .control_input_inner(
                p,
                &desktop.id,
                desktop.generation,
                &lease.token,
                lease.fence,
                &stale.frame_id,
                point,
                action(),
                &authority,
                true,
            )
            .await
            .is_ok()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
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
        let next = service
            .control_acquire_inner(p, &desktop.id, desktop.generation, true, &authority, true)
            .await?;
        if next.fence <= lease.fence || next.token == lease.token {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        service.revoke_control_principal(&p.principal_id).await;
        if service
            .control_release(
                p,
                &desktop.id,
                desktop.generation,
                &next.token,
                next.fence,
                &authority,
            )
            .await
            .is_ok()
        {
            return Err(refused("managed_desktop_control_smoke_failed"));
        }
        let row = service.scoped(p, &desktop.id, desktop.generation).await?;
        Ok(ControlQualificationReceipt {
            binding_digest: digest.clone(),
            template: row.template,
            smoke_desktop_id: desktop.id,
            observed_at: service.now().await,
            protocol_revision: 1,
        })
    }
    .await;
    let deleted = service.delete(p, &desktop.id, desktop.generation).await?;
    if deleted.state != ManagedDesktopState::Destroyed {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    let receipt = result?;
    service
        .transaction(|s, _| {
            s.control_qualifications.insert(digest, receipt.clone());
            Ok(())
        })
        .await?;
    Ok(receipt)
}

/// Only constructed inside the explicitly authorized native smoke process.
struct NativeSmokeAuthority {
    owner: String,
    host: String,
}
#[async_trait]
impl ManagedControlAuthority for NativeSmokeAuthority {
    fn input_admission(&self, p: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
        // The operator process has no remote devices or admin-lease lifecycle.
        // Its explicit paid-smoke permit and fixed local identity scope it.
        let allowed = p.owner_principal_id == self.owner
            && p.host_id == self.host
            && p.require_admin().is_ok();
        Arc::new(move || allowed)
    }
    async fn revalidate(&self, p: &ManagedDesktopPrincipal) -> Result<()> {
        if p.owner_principal_id != self.owner || p.host_id != self.host {
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
                    && r.protocol_revision == 1
                    && state.desktops.get(&r.smoke_desktop_id).is_some_and(|d| {
                        d.smoke
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
    pub async fn capture_handoff_smoke(&self, p: &ManagedDesktopPrincipal,
        desktop: &ManagedDesktop, operation_id: &str) -> Result<Screenshot> {
        p.require_admin()?;
        let expected = format!("handoff:{operation_id}");
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        if !row.smoke || row.source_id.as_deref() != Some(expected.as_str()) {
            return Err(refused("managed_desktop_handoff_desktop_not_authorized"));
        }
        let authority = NativeSmokeAuthority { owner:p.owner_principal_id.clone(), host:p.host_id.clone() };
        Ok(self.control_frame_inner(p, &desktop.id, desktop.generation, &authority, true).await?.screenshot)
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
        self.scoped(p, id, generation).await?;
        let slot = self.control_slot(id, generation).await;
        let mut c = slot.lock().await;
        if let Err(e) = self
            .control_check(p, id, generation, authority, false)
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
    use std::sync::atomic::AtomicBool;
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

    #[tokio::test]
    async fn retained_checkpoint_requires_exact_handoff_source_generation_and_admin() {
        let f = wire_fixture().await;
        let service = &f.domain.service;
        let p = &f.domain.p;
        assert_eq!(service.capture_handoff_smoke(p,&f.row,"acceptance").await.unwrap_err().code,
            "managed_desktop_handoff_desktop_not_authorized");
        service.transaction(|state, _| {
            state.desktops.get_mut(&f.row.id).unwrap().source_id = Some("handoff:acceptance".into());
            Ok(())
        }).await.unwrap();
        let mut stale = f.row.clone();
        stale.generation += 1;
        assert!(service.capture_handoff_smoke(p,&stale,"acceptance").await.is_err());
        let mut human = p.clone();
        human.authority = ManagedDesktopAuthority::Human;
        assert!(service.capture_handoff_smoke(&human,&f.row,"acceptance").await.is_err());
        assert!(service.capture_handoff_smoke(p,&f.row,"different").await.is_err());
        let frame = service.capture_handoff_smoke(p,&f.row,"acceptance").await.unwrap();
        assert!(!frame.bytes.is_empty());
        assert_eq!(f.input_count.load(Ordering::SeqCst),0);
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
