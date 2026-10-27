//! Host authority and crash-safe paid-operation state machine (ADR-0233).
#[path = "handoff_service.rs"]
mod handoff_service;
pub use handoff_service::HandoffTransfer;
#[path = "control.rs"]
pub mod control;
#[path = "smoke.rs"]
mod smoke;
#[path = "qualification.rs"]
pub mod qualification;
use super::{
    contracts::*,
    journal::{JournalStore, ManagedDesktopJournal},
    provider::*,
};
pub use smoke::{run_qualification_smoke, ExplicitPaidSmokeAuthorization, ManagedDesktopSmokeHost};
use std::{path::Path, sync::Arc};
use tokio::sync::Mutex;
use uuid::Uuid;

pub struct ManagedDesktopService {
    host_id: String,
    store: Arc<JournalStore>,
    state: Arc<Mutex<ManagedDesktopJournal>>,
    // Serializes mutations including provider exchanges. Reads and quote
    // creation remain independent; no synchronous lock crosses an await.
    operations: Mutex<()>,
    template_operations: Mutex<()>,
    provider: Arc<dyn ManagedDesktopProvider>,
    secrets: Arc<dyn ManagedDesktopSecrets>,
    trusted_release: Option<DesktopRelease>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    control_desktop_epochs:
        Mutex<std::collections::BTreeMap<String, Arc<std::sync::atomic::AtomicU64>>>,
    control_principal_epochs:
        Mutex<std::collections::BTreeMap<String, Arc<std::sync::atomic::AtomicU64>>>,
    controls: Mutex<std::collections::BTreeMap<String, Arc<Mutex<control::ManagedControl>>>>,
}
impl ManagedDesktopService {
    pub fn open(
        data_dir: &Path,
        host_id: String,
        provider: Arc<dyn ManagedDesktopProvider>,
        secrets: Arc<dyn ManagedDesktopSecrets>,
        trusted_release: Option<DesktopRelease>,
    ) -> Result<Self> {
        validate_id(&host_id)?;
        if let Some(release) = &trusted_release {
            release.validate()?;
        }
        let store = Arc::new(JournalStore::open(data_dir)?);
        let state = store.load(&host_id)?;
        store.save(&state)?;
        Ok(Self {
            host_id,
            store,
            state: Arc::new(Mutex::new(state)),
            operations: Mutex::new(()),
            template_operations: Mutex::new(()),
            provider,
            secrets,
            trusted_release,
            clock: Arc::new(|| chrono::Utc::now().timestamp_millis()),
            controls: Mutex::new(Default::default()),
            control_principal_epochs: Mutex::new(Default::default()),
            control_desktop_epochs: Mutex::new(Default::default()),
        })
    }
    async fn transaction<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut ManagedDesktopJournal, i64) -> Result<T>,
    ) -> Result<T> {
        self.transaction_admitted(Arc::new(|| Ok(())), f).await
    }
    async fn transaction_admitted<T: Send + 'static>(
        &self,
        admission: LifecycleAdmission,
        f: impl FnOnce(&mut ManagedDesktopJournal, i64) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self.state.clone().lock_owned().await;
        admission()?;
        let mut next = guard.clone();
        // A wall-clock rollback must not revive an expired lease.
        let now = (self.clock)().max(next.last_observed_at);
        let result = f(&mut next, now)?;
        next.last_observed_at = now;
        next.revision = next.revision.saturating_add(1);
        let store = self.store.clone();
        // The owned guard travels into the blocking job. If the caller is
        // cancelled after dispatch, disk and memory still commit together;
        // another transaction cannot overwrite an unseen durable revision.
        tokio::task::spawn_blocking(move || {
            admission()?;
            store.save(&next)?;
            *guard = next;
            Ok(result)
        })
        .await
        .map_err(|_| retryable("managed_desktop_storage_unavailable"))?
    }

    async fn now(&self) -> i64 {
        (self.clock)().max(self.state.lock().await.last_observed_at)
    }
    fn scope(&self, p: &ManagedDesktopPrincipal) -> Result<()> {
        validate_id(&p.owner_principal_id)?;
        validate_id(&p.principal_id)?;
        if p.host_id != self.host_id {
            return Err(refused("managed_desktop_forbidden"));
        }
        Ok(())
    }
    async fn registry(&self) -> Result<super::journal::ManagedDesktopRegistry> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.registry())
            .await
            .map_err(|_| retryable("managed_desktop_storage_unavailable"))?
    }
    async fn config(&self, p: &ManagedDesktopPrincipal, id: &str) -> Result<ManagedDesktopConfig> {
        self.scope(p)?;
        validate_id(id)?;
        self.registry()
            .await?
            .providers
            .into_iter()
            .find(|c| {
                c.id == id
                    && c.owner_principal_id == p.owner_principal_id
                    && c.host_id == self.host_id
            })
            .ok_or_else(|| refused("managed_desktop_config_not_found"))
    }
    fn release(&self, c: &ManagedDesktopConfig) -> Result<()> {
        if self.trusted_release.as_ref() != Some(&c.release) {
            return Err(refused("managed_desktop_release_unavailable"));
        }
        Ok(())
    }
    fn admission(&self, c: &ManagedDesktopConfig, now: i64) -> Result<()> {
        c.validate(now)?;
        if c.region.is_some() {
            return Err(refused("managed_desktop_region_unsupported"));
        }
        self.release(c)?;
        if !c.enabled {
            return Err(refused("managed_desktop_disabled"));
        }
        Ok(())
    }
    fn lifecycle_admission(
        &self,
        config: &ManagedDesktopConfig,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
        observed_at: i64,
    ) -> LifecycleAdmission {
        let expected = config.clone();
        let store = self.store.clone();
        let clock = self.clock.clone();
        Arc::new(move || {
            if !live() {
                return Err(refused("managed_desktop_forbidden"));
            }
            // Registry edits and credential generations are Host authority,
            // not the snapshot captured before an async secret/build lookup.
            let current = store.registry()?.providers.into_iter().find(|c| {
                c.id == expected.id && c.owner_principal_id == expected.owner_principal_id
                    && c.host_id == expected.host_id
            }).ok_or_else(|| refused("managed_desktop_config_not_found"))?;
            if !current.enabled {
                return Err(refused("managed_desktop_disabled"));
            }
            if current != expected {
                return Err(refused("managed_desktop_quote_expired"));
            }
            current.validate(clock().max(observed_at))
        })
    }
    pub async fn list_configs(
        &self,
        p: &ManagedDesktopPrincipal,
    ) -> Result<Vec<ManagedDesktopConfigSummary>> {
        self.scope(p)?;
        let configs = self.registry().await?.providers;
        let now = self.now().await;
        let state = self.state.lock().await;
        Ok(configs
            .into_iter()
            .filter(|c| c.owner_principal_id == p.owner_principal_id && c.host_id == self.host_id)
            .map(|c| {
                let digest = c.binding_digest();
                let template = latest_template(&state, &digest);
                let qualified = c.egress == DesktopEgress::Off
                    && template
                        .and_then(|t| t.identity.as_ref())
                        .is_some_and(|t| qualified(&state, &digest, t));
                let error = self.admission(&c, now).err();
                let valid = error.is_none();
                ManagedDesktopConfigSummary {
                    id: c.id.clone(),
                    owner_principal_id: c.owner_principal_id.clone(),
                    host_id: c.host_id.clone(),
                    enabled: c.enabled,
                    qualification: if qualified {
                        "qualified"
                    } else {
                        "unqualified"
                    }
                    .into(),
                    reason: error
                        .map(|e| e.code)
                        .or_else(|| {
                            (c.egress != DesktopEgress::Off)
                                .then(|| "managed_desktop_egress_smoke_unsupported".into())
                        })
                        .or_else(|| (!qualified).then(|| "managed_desktop_unqualified".into())),
                    max_concurrent: c.limits.max_concurrent,
                    max_lifetime_seconds: c.limits.max_lifetime_seconds,
                    idle_timeout_seconds: c.limits.idle_timeout_seconds,
                    region: c.region,
                    cpu_count: c.shape.cpu_count,
                    memory_mb: c.shape.memory_mb,
                    template: template.and_then(|t| t.identity.clone()),
                    template_state: template.map(|t| t.state.clone()),
                    can_prepare_template: valid && p.require_human().is_ok(),
                    can_create: valid && qualified && p.require_human().is_ok(),
                    gui_qualified: valid
                        && qualified
                        && state.control_qualifications.get(&digest).is_some_and(|q| {
                            q.binding_digest == digest
                                && q.has_complete_evidence()
                                && template.and_then(|t| t.identity.as_ref()) == Some(&q.template)
                                && state.desktops.get(&q.smoke_desktop_id).is_some_and(|d| {
                                    d.smoke
                                        && d.config.binding_digest() == digest
                                        && d.template == q.template
                                        && d.desktop.generation == q.smoke_desktop_generation
                                        && d.desktop.state == ManagedDesktopState::Destroyed
                                })
                        }),
                    qualification_evidence_version: qualified.then_some(2),
                    workload_isolation_revision: qualified.then_some(1),
                    isolation_tier: IsolationTier::Vm,
                    egress_tier: match &c.egress {
                        DesktopEgress::Off => EgressTier::Off,
                        DesktopEgress::On => EgressTier::On,
                        DesktopEgress::Allowlist(_) => EgressTier::Allowlist,
                    },
                    egress_enforcement: if qualified {
                        "provider-and-guest-kernel"
                    } else {
                        "unverified"
                    }
                    .into(),
                }
            })
            .collect())
    }
    pub async fn list(&self, p: &ManagedDesktopPrincipal) -> Result<Vec<ManagedDesktop>> {
        self.scope(p)?;
        Ok(self
            .state
            .lock()
            .await
            .desktops
            .values()
            .filter(|r| r.config.authorize(p).is_ok())
            .map(|r| r.desktop.clone())
            .collect())
    }
    pub async fn quote(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        lifetime_seconds: u64,
    ) -> Result<ManagedDesktopQuote> {
        let c = self.config(p, config_id).await?;
        let now = self.now().await;
        self.admission(&c, now)?;
        if lifetime_seconds == 0 || lifetime_seconds > c.limits.max_lifetime_seconds {
            return Err(ManagedDesktopError {
                requested: Some(lifetime_seconds),
                allowed: Some(c.limits.max_lifetime_seconds),
                ..refused("managed_desktop_policy_limit")
            });
        }
        c.plan.validate_lifetime(lifetime_seconds, now)?;
        let cost = c
            .price
            .hourly_rate_micros
            .checked_mul(lifetime_seconds)
            .and_then(|n| n.checked_add(3599))
            .map(|n| n / 3600)
            .ok_or_else(|| refused("managed_desktop_price_invalid"))?;
        let quote = ManagedDesktopQuote {
            id: Uuid::new_v4().to_string(),
            provider_config_id: c.id.clone(),
            config_revision: c.revision,
            lifetime_seconds,
            expires_at: now
                .saturating_add(QUOTE_TTL_MS)
                .min(c.plan.expires_at)
                .min(c.price.expires_at),
            currency: c.price.currency.clone(),
            hourly_rate_micros: c.price.hourly_rate_micros,
            maximum_compute_cost_micros: cost,
            price_observed_at: c.price.observed_at,
            region: c.region.clone(),
            cpu_count: c.shape.cpu_count,
            memory_mb: c.shape.memory_mb,
            binding_digest: c.binding_digest(),
            owner_principal_id: c.owner_principal_id.clone(),
        };
        self.transaction(|s, now| {
            s.quotes.retain(|_, q| q.expires_at > now);
            s.quotes.insert(quote.id.clone(), quote.clone());
            Ok(quote)
        })
        .await
    }
    /// Native administrator/operator entry. Authenticated callers must use
    /// the live `*_with_authority` entrypoint; cleanup retries need no caller.
    pub async fn authorize(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        quote_id: &str,
        purpose: AuthorizationPurpose,
        source_id: Option<String>,
    ) -> Result<DesktopAuthorization> {
        p.require_admin()?;
        self.authorize_inner(p, config_id, quote_id, purpose, source_id, Arc::new(|| true)).await
    }
    pub async fn authorize_with_authority(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        quote_id: &str,
        purpose: AuthorizationPurpose,
        source_id: Option<String>,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<DesktopAuthorization> {
        authority.revalidate(p).await?;
        self.authorize_inner(p, config_id, quote_id, purpose, source_id, authority.input_admission(p)).await
    }
    async fn authorize_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        quote_id: &str,
        purpose: AuthorizationPurpose,
        source_id: Option<String>,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<DesktopAuthorization> {
        p.require_human()?;
        if purpose == AuthorizationPurpose::Smoke {
            p.require_admin()?;
        }
        if let Some(id) = &source_id {
            validate_id(id)?;
        }
        let c = self.config(p, config_id).await?;
        self.admission(&c, self.now().await)?;
        let admission = self.lifecycle_admission(&c, live, self.now().await);
        self.transaction_admitted(admission, |s, now| {
            let quote = valid_quote(s, &c, p, quote_id, now)?;
            let auth = DesktopAuthorization {
                id: Uuid::new_v4().to_string(),
                provider_config_id: c.id.clone(),
                owner_principal_id: p.owner_principal_id.clone(),
                principal_id: p.principal_id.clone(),
                binding_digest: c.binding_digest(),
                purpose,
                quote_id: Some(quote_id.into()),
                source_id,
                expires_at: quote.expires_at,
                consumed_by: None,
            };
            s.authorizations
                .retain(|_, a| a.expires_at > now || a.consumed_by.is_some());
            s.authorizations.insert(auth.id.clone(), auth.clone());
            Ok(auth)
        })
        .await
    }
    /// Native administrator/operator entry. Authenticated callers must use
    /// the live `*_with_authority` entrypoint; cleanup retries need no caller.
    pub async fn prepare_template(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
    ) -> Result<TemplateRecord> {
        p.require_admin()?;
        self.prepare_template_inner(p, input, Arc::new(|| true)).await
    }
    pub async fn prepare_template_with_authority(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<TemplateRecord> {
        authority.revalidate(p).await?;
        self.prepare_template_inner(p, input, authority.input_admission(p)).await
    }
    async fn prepare_template_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<TemplateRecord> {
        p.require_human()?;
        let _op = self.template_operations.lock().await;
        let c = self.config(p, &input.provider_config_id).await?;
        self.admission(&c, self.now().await)?;
        let admission = self.lifecycle_admission(&c, live, self.now().await);
        admission()?;
        validate_id(&input.idempotency_key)?;
        let operation = operation_id(p, &input, "template");
        if let Some(existing) = self.state.lock().await.templates.get(&operation).cloned() {
            if existing.authorization_id != input.authorization_id
                || existing.quote_id != input.quote_id
            {
                return Err(refused("managed_desktop_idempotency_conflict"));
            }
            admission()?;
            return Ok(existing);
        }
        if let Some(existing) =
            latest_template(&*self.state.lock().await, &c.binding_digest()).cloned()
        {
            admission()?;
            // A single bound build is reused; an unknown registration cannot
            // be made billable again just by choosing another idempotency key.
            return if matches!(
                existing.state,
                TemplateState::Unknown | TemplateState::Failed
            ) {
                Err(refused(
                    "managed_desktop_template_requires_operator_reconciliation",
                ))
            } else {
                Ok(existing)
            };
        }
        let key = self.secrets.provider_key(&c).await?;
        self.provider.verify_release(&c).await?;
        admission()?;
        let row = self
            .transaction_admitted(admission.clone(), |s, now| {
                consume(
                    s,
                    &c,
                    p,
                    &input,
                    AuthorizationPurpose::PrepareTemplate,
                    &operation,
                    now,
                )?;
                let row = TemplateRecord {
                    id: operation.clone(),
                    authorization_id: input.authorization_id.clone(),
                    quote_id: input.quote_id.clone(),
                    config: c.clone(),
                    binding_digest: c.binding_digest(),
                    state: TemplateState::Registering,
                    identity: None,
                    created_at: now,
                    updated_at: now,
                    error_code: None,
                };
                s.templates.insert(operation.clone(), row.clone());
                Ok(row)
            })
            .await?;
        let result = self
            .provider
            .register_template(&c, &key, &format!("cognia-desktop-{}", Uuid::new_v4()), admission.clone())
            .await;
        let identity = match result {
            Ok(identity) => identity,
            Err(error) => {
                self.transaction(|s, now| {
                    let row = s.templates.get_mut(&operation).unwrap();
                    row.state = if error.retryable {
                        TemplateState::Unknown
                    } else {
                        TemplateState::Failed
                    };
                    row.error_code = Some(error.code.clone());
                    row.updated_at = now;
                    Ok(())
                })
                .await?;
                return Err(error);
            }
        };
        self.transaction(|s, now| {
            let row = s.templates.get_mut(&operation).unwrap();
            row.identity = Some(identity.clone());
            row.state = TemplateState::Registered;
            row.updated_at = now;
            Ok(())
        })
        .await?;
        // Persist the irreversible start intent before sending it. A crash or
        // timeout is resolved with GET status, never a second start request.
        self.transaction_admitted(admission.clone(), |s, now| {
            let row = s.templates.get_mut(&operation).unwrap();
            row.state = TemplateState::Building;
            row.updated_at = now;
            Ok(())
        })
        .await?;
        if let Err(error) = self.provider.start_template(&c, &key, &identity, admission).await {
            self.transaction(|s, now| {
                let row = s.templates.get_mut(&operation).unwrap();
                row.error_code = Some(error.code.clone());
                row.updated_at = now;
                Ok(())
            })
            .await?;
            return Err(error);
        }
        self.refresh_template(&row.id).await
    }
    async fn refresh_template(&self, id: &str) -> Result<TemplateRecord> {
        let row = self
            .state
            .lock()
            .await
            .templates
            .get(id)
            .cloned()
            .ok_or_else(|| refused("managed_desktop_template_missing"))?;
        let Some(identity) = &row.identity else {
            return Ok(row);
        };
        let key = self.secrets.provider_key(&row.config).await?;
        let status = self
            .provider
            .template_status(&row.config, &key, identity)
            .await?;
        self.transaction(|s, now| {
            let row = s.templates.get_mut(id).unwrap();
            row.state = status;
            row.updated_at = now;
            row.error_code = None;
            Ok(row.clone())
        })
        .await
    }
    /// Native administrator/operator entry. Authenticated callers must use
    /// the live `*_with_authority` entrypoint; cleanup retries need no caller.
    pub async fn create(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
    ) -> Result<ManagedDesktop> {
        p.require_admin()?;
        self.create_inner(p, input, false, Arc::new(|| true)).await
    }
    pub async fn create_with_authority(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<ManagedDesktop> {
        authority.revalidate(p).await?;
        self.create_inner(p, input, false, authority.input_admission(p)).await
    }
    /// Restricted native administrator smoke path. No browser endpoint calls
    /// this method; it requires a distinct, one-use Smoke authorization.
    pub async fn create_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
    ) -> Result<ManagedDesktop> {
        p.require_admin()?;
        self.create_inner(p, input, true, Arc::new(|| true)).await
    }
    async fn create_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        input: CreateManagedDesktop,
        smoke: bool,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<ManagedDesktop> {
        p.require_human()?;
        self.scope(p)?;
        let _op = self.operations.lock().await;
        if !live() { return Err(refused("managed_desktop_forbidden")); }
        validate_id(&input.idempotency_key)?;
        let operation = operation_id(p, &input, if smoke { "smoke" } else { "create" });
        if let Some(row) = self
            .state
            .lock()
            .await
            .desktops
            .values()
            .find(|r| r.operation_id == operation)
            .cloned()
        {
            if row.authorization_id != input.authorization_id || row.quote_id != input.quote_id {
                return Err(refused("managed_desktop_idempotency_conflict"));
            }
            if !live() { return Err(refused("managed_desktop_forbidden")); }
            return Ok(row.desktop);
        }
        let c = self.config(p, &input.provider_config_id).await?;
        self.admission(&c, self.now().await)?;
        let admission = self.lifecycle_admission(&c, live, self.now().await);
        let key = self.secrets.provider_key(&c).await?;
        let row = self
            .transaction_admitted(admission.clone(), |s, now| {
                let digest = c.binding_digest();
                let template = latest_template(s, &digest)
                    .filter(|t| t.state == TemplateState::Ready)
                    .and_then(|t| t.identity.clone())
                    .ok_or_else(|| refused("managed_desktop_template_not_ready"))?;
                if !smoke && (c.egress != DesktopEgress::Off || !qualified(s, &digest, &template)) {
                    return Err(refused("managed_desktop_unqualified"));
                }
                let used = s
                    .desktops
                    .values()
                    .filter(|r| {
                        r.config.owner_principal_id == c.owner_principal_id
                            && r.config.host_id == c.host_id
                            && r.desktop.state != ManagedDesktopState::Destroyed
                    })
                    .count();
                // All E2B configurations share the owner/provider/Host cap.
                if used >= c.limits.max_concurrent as usize {
                    return Err(refused("managed_desktop_capacity_limit"));
                }
                let quote = valid_quote(s, &c, p, &input.quote_id, now)?.clone();
                let auth = consume(
                    s,
                    &c,
                    p,
                    &input,
                    if smoke {
                        AuthorizationPurpose::Smoke
                    } else {
                        AuthorizationPurpose::Create
                    },
                    &operation,
                    now,
                )?;
                let row = DesktopRecord {
                    desktop: ManagedDesktop {
                        id: Uuid::new_v4().to_string(),
                        provider_config_id: c.id.clone(),
                        generation: 1,
                        state: ManagedDesktopState::Creating,
                        deadline_at: now.saturating_add(quote.lifetime_seconds as i64 * 1000),
                        idle_timeout_seconds: c.limits.idle_timeout_seconds,
                        created_at: now,
                        updated_at: now,
                        last_error_code: None,
                        cleanup_attempts: 0,
                        qualification: if smoke { "smoke" } else { "qualified" }.into(),
                    },
                    config: c.clone(),
                    template,
                    operation_id: operation.clone(),
                    authorization_id: auth.id,
                    quote_id: input.quote_id.clone(),
                    principal_id: p.principal_id.clone(),
                    source_id: auth.source_id,
                    resource_id: None,
                    last_activity_at: now,
                    next_retry_at: now,
                    delete_requested: false,
                    smoke,
                    bootstrap_started: false,
                    bootstrap_completed: false,
                };
                s.desktops.insert(row.desktop.id.clone(), row.clone());
                Ok(row)
            })
            .await?;
        let secrets = DesktopSecrets {
            guest_token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            traffic_token: None,
            domain: None,
            envd_token: None,
        };
        if let Err(error) = self.secrets.put_desktop(&row.desktop.id, &secrets).await {
            self.creation_not_sent(&row.desktop.id, &error).await?;
            return Err(error);
        }
        let remaining = (row.desktop.deadline_at - self.now().await) / 1000;
        if remaining < 1 {
            let error = refused("managed_desktop_deadline_expired");
            self.creation_not_sent(&row.desktop.id, &error).await?;
            return Err(error);
        }
        if let Err(error) = admission() {
            self.creation_not_sent(&row.desktop.id, &error).await?;
            return Err(error);
        }
        match self
            .provider
            .create(&row, &key, &secrets, remaining as u64, admission)
            .await
        {
            Ok(created) => {
                // ID first, endpoint secrets second: failure retains cleanup
                // authority and quota even if the response is partly lost.
                self.transaction(|s, now| {
                    let row = s.desktops.get_mut(&row.desktop.id).unwrap();
                    row.resource_id = Some(created.resource.resource_id);
                    row.desktop.updated_at = now;
                    Ok(())
                })
                .await?;
                if let Err(error) = self
                    .secrets
                    .put_desktop(&row.desktop.id, &created.secrets)
                    .await
                {
                    self.mark_cleanup(&row.desktop.id, &error).await?;
                    return Err(error);
                }
            }
            Err(error) => {
                // Even a refusal can follow a proxy/provider retry. Only an
                // authoritative absence reconciliation releases reservation.
                self.transaction(|s, now| {
                    let row = s.desktops.get_mut(&row.desktop.id).unwrap();
                    row.desktop.last_error_code = Some(error.code.clone());
                    row.next_retry_at = now + 15_000;
                    Ok(())
                })
                .await?;
                return Err(error);
            }
        }
        self.reconcile_one(&row.desktop.id, true).await
    }
    async fn creation_not_sent(&self, id: &str, error: &ManagedDesktopError) -> Result<()> {
        self.transaction(|s, now| {
            let r = s.desktops.get_mut(id).unwrap();
            r.desktop.state = ManagedDesktopState::Destroyed;
            r.desktop.last_error_code = Some(error.code.clone());
            r.desktop.updated_at = now;
            Ok(())
        })
        .await
    }
    async fn scoped(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<DesktopRecord> {
        self.scope(p)?;
        let row = self
            .state
            .lock()
            .await
            .desktops
            .get(id)
            .cloned()
            .ok_or_else(|| refused("managed_desktop_not_found"))?;
        row.config.authorize(p)?;
        if row.desktop.generation != generation {
            return Err(refused("managed_desktop_stale_generation"));
        }
        Ok(row)
    }
    /// Re-observe the native boundary before handoff/control. This cannot bind
    /// an already-running legacy journal row to a replacement guest generation.
    pub async fn validate_live_boundary(
        &self,
        p: &ManagedDesktopPrincipal,
        desktop: &ManagedDesktop,
    ) -> Result<HostBoundaryBinding> {
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        if row.delete_requested || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await) {
            return Err(refused("managed_desktop_boundary_unavailable"));
        }
        let result = async {
            let current = self.config(p, &row.config.id).await?;
            self.admission(&current, self.now().await)?;
            if current.binding_digest() != row.config.binding_digest() {
                return Err(refused("managed_desktop_boundary_identity_mismatch"));
            }
            let secrets = self.secrets.desktop(&desktop.id).await?;
            self.observe_bound_boundary(&row, &secrets, false).await
        }.await;
        match result {
            Ok(binding) => Ok(binding),
            Err(error) => {
                self.mark_cleanup(&desktop.id, &error).await?;
                self.retry_cleanup(&desktop.id, &error).await?;
                Err(error)
            }
        }
    }

    async fn observe_bound_boundary(
        &self,
        row: &DesktopRecord,
        secrets: &DesktopSecrets,
        allow_initial_binding: bool,
    ) -> Result<HostBoundaryBinding> {
        self.release(&row.config)?;
        let admission = self.lifecycle_admission(&row.config, Arc::new(|| true), self.now().await);
        admission()?;
        let observation = self.provider.observe_boundary(row, secrets).await?;
        observation.validate(1000)
            .map_err(|_| refused("managed_desktop_boundary_invalid"))?;
        if observation.phase != cognia_desktop_guest::observation::ObservationPhase::DesktopLive {
            return Err(refused("managed_desktop_boundary_invalid"));
        }
        let binding = HostBoundaryBinding {
            binding_digest: row.config.binding_digest(),
            owner_principal_id: row.config.owner_principal_id.clone(),
            host_id: row.config.host_id.clone(),
            desktop_id: row.desktop.id.clone(),
            desktop_generation: row.desktop.generation,
            resource_id: row.resource_id.clone()
                .ok_or_else(|| refused("managed_desktop_boundary_identity_mismatch"))?,
            template: row.template.clone(),
            observed_at: self.now().await,
            observation,
        };
        self.transaction_admitted(admission, |state, now| {
            let current = state.desktops.get(&row.desktop.id)
                .ok_or_else(|| refused("managed_desktop_not_found"))?;
            if current.delete_requested || current.expired(now) || !binding.matches_record(current) {
                return Err(refused("managed_desktop_boundary_identity_mismatch"));
            }
            match state.workload_boundaries.get(&row.desktop.id) {
                Some(pinned) if pinned.matches_record(current) && pinned.same_generation(&binding) => {},
                None if allow_initial_binding => {},
                _ => return Err(refused("managed_desktop_boundary_generation_mismatch")),
            }
            state.workload_boundaries.insert(row.desktop.id.clone(), binding.clone());
            Ok(binding.clone())
        }).await
    }

    pub async fn connect(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<ManagedDesktop> {
        let _op = self.operations.lock().await;
        self.scoped(p, id, generation).await?;
        self.reconcile_one(id, true).await
    }
    pub async fn health(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<ManagedDesktopHealth> {
        let desktop = self.connect(p, id, generation).await?;
        Ok(ManagedDesktopHealth {
            reachable: desktop.state == ManagedDesktopState::Running,
            error_code: desktop.last_error_code.clone(),
            state: desktop.state.clone(),
            desktop,
        })
    }
    /// Native administrator/operator entry. Authenticated callers must use
    /// the live `*_with_authority` entrypoint; cleanup retries need no caller.
    pub async fn delete(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
    ) -> Result<ManagedDesktop> {
        p.require_admin()?;
        self.delete_inner(p, id, generation, Arc::new(|| true)).await
    }
    pub async fn delete_with_authority(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        authority: &dyn control::ManagedControlAuthority,
    ) -> Result<ManagedDesktop> {
        authority.revalidate(p).await?;
        self.delete_inner(p, id, generation, authority.input_admission(p)).await
    }
    async fn delete_inner(
        &self,
        p: &ManagedDesktopPrincipal,
        id: &str,
        generation: u64,
        live: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<ManagedDesktop> {
        p.require_human()?;
        let _op = self.operations.lock().await;
        let row = self.scoped(p, id, generation).await?;
        if !live() { return Err(refused("managed_desktop_forbidden")); }
        if row.desktop.state == ManagedDesktopState::Destroyed {
            return Ok(row.desktop);
        }
        let admission: LifecycleAdmission = Arc::new(move || {
            if live() { Ok(()) } else { Err(refused("managed_desktop_forbidden")) }
        });
        admission()?;
        self.revoke_control_desktop(id).await;
        self.transaction_admitted(admission, |s, now| {
            let row = s.desktops.get_mut(id).ok_or_else(|| refused("managed_desktop_not_found"))?;
            row.config.authorize(p)?;
            if row.desktop.generation != generation {
                return Err(refused("managed_desktop_stale_generation"));
            }
            row.delete_requested = true;
            row.desktop.state = ManagedDesktopState::Deleting;
            row.desktop.last_error_code = Some("managed_desktop_delete_requested".into());
            row.desktop.updated_at = now;
            row.next_retry_at = now;
            Ok(())
        }).await?;
        self.reconcile_one(id, true).await
    }
    async fn mark_cleanup(&self, id: &str, error: &ManagedDesktopError) -> Result<()> {
        self.revoke_control_desktop(id).await;
        self.transaction(|s, now| {
            let r = s.desktops.get_mut(id).unwrap();
            r.delete_requested = true;
            r.desktop.state = ManagedDesktopState::Deleting;
            r.desktop.last_error_code = Some(error.code.clone());
            r.desktop.updated_at = now;
            r.next_retry_at = now;
            Ok(())
        })
        .await
    }
    async fn retry_cleanup(&self, id: &str, error: &ManagedDesktopError) -> Result<ManagedDesktop> {
        self.transaction(|s, now| {
            let r = s.desktops.get_mut(id).unwrap();
            r.desktop.state = ManagedDesktopState::DestroyRetrying;
            r.desktop.cleanup_attempts = r.desktop.cleanup_attempts.saturating_add(1);
            r.desktop.last_error_code = Some(error.code.clone());
            r.desktop.updated_at = now;
            let delay = 15_000i64
                .saturating_mul(1i64 << r.desktop.cleanup_attempts.saturating_sub(1).min(6))
                .min(600_000);
            r.next_retry_at = now.saturating_add(delay);
            Ok(r.desktop.clone())
        })
        .await
    }
    async fn absent(&self, id: &str) -> Result<ManagedDesktop> {
        // Secret cleanup failure retains a retryable tombstone and capacity.
        if let Err(error) = self.secrets.remove_desktop(id).await {
            return self.retry_cleanup(id, &error).await;
        }
        self.transaction(|s, now| {
            let r = s.desktops.get_mut(id).unwrap();
            r.desktop.state = ManagedDesktopState::Destroyed;
            r.desktop.updated_at = now;
            r.desktop.last_error_code = None;
            Ok(r.desktop.clone())
        })
        .await
    }
    async fn reconcile_one(&self, id: &str, force: bool) -> Result<ManagedDesktop> {
        let mut row = self
            .state
            .lock()
            .await
            .desktops
            .get(id)
            .cloned()
            .ok_or_else(|| refused("managed_desktop_not_found"))?;
        let now = self.now().await;
        if row.desktop.state == ManagedDesktopState::Destroyed {
            return Ok(row.desktop);
        }
        if row.expired(now) && !row.delete_requested {
            self.mark_cleanup(id, &refused("managed_desktop_deadline_expired"))
                .await?;
            row = self.state.lock().await.desktops[id].clone();
        }
        if !force && row.next_retry_at > now {
            return Ok(row.desktop);
        }
        let key = match self.secrets.provider_key(&row.config).await {
            Ok(key) => key,
            Err(e) => return self.reconcile_error(id, &e, row.delete_requested).await,
        };
        let result = if let Some(resource) = &row.resource_id {
            self.provider
                .inspect(&row.config, &key, resource)
                .await
                .map(|v| v.into_iter().collect::<Vec<_>>())
        } else {
            self.provider.list(&row.config, &key, &row.metadata()).await
        };
        let resources = match result {
            Ok(v) => v,
            Err(e) => return self.reconcile_error(id, &e, row.delete_requested).await,
        };
        if resources.is_empty() {
            // A timed-out create can be invisible briefly. Keep unknown slots
            // until its absolute native TTL has elapsed, even after Delete.
            if row.resource_id.is_some() || now >= row.desktop.deadline_at {
                return self.absent(id).await;
            }
            return self
                .reconcile_error(
                    id,
                    &retryable("managed_desktop_create_outcome_unknown"),
                    row.delete_requested,
                )
                .await;
        }
        if resources.iter().any(|r| !owns(&row, r)) {
            return self
                .reconcile_error(
                    id,
                    &refused("managed_desktop_provider_identity_mismatch"),
                    row.delete_requested,
                )
                .await;
        }
        if resources.len() > 1 {
            self.mark_cleanup(id, &refused("managed_desktop_duplicate_resources"))
                .await?;
            row.delete_requested = true;
        }
        if !row.delete_requested {
            let resource = &resources[0];
            if !resource.running
                || !resource.kill_on_timeout
                || resource.auto_resume
                || !resource.private_ingress
                || !egress_matches(&row.config.egress, resource)
                || resource.template_id.as_deref() != Some(row.template.template_id.as_str())
                || resource
                    .deadline_at
                    .is_none_or(|d| d > row.desktop.deadline_at || d <= now)
            {
                self.mark_cleanup(id, &refused("managed_desktop_provider_policy_mismatch"))
                    .await?;
                row.delete_requested = true;
            }
        }
        if row.delete_requested {
            for resource in resources {
                if let Err(e) = self
                    .provider
                    .delete(&row.config, &key, &resource.resource_id)
                    .await
                {
                    return self.retry_cleanup(id, &e).await;
                }
                match self
                    .provider
                    .inspect(&row.config, &key, &resource.resource_id)
                    .await
                {
                    Ok(None) => {}
                    Ok(Some(_)) => {
                        return self
                            .retry_cleanup(id, &retryable("managed_desktop_delete_pending"))
                            .await
                    }
                    Err(e) => return self.retry_cleanup(id, &e).await,
                }
            }
            return self.absent(id).await;
        }
        if row.resource_id.is_none() {
            row.resource_id = Some(resources[0].resource_id.clone());
            self.transaction(|s, _| {
                s.desktops.get_mut(id).unwrap().resource_id = row.resource_id.clone();
                Ok(())
            })
            .await?;
        }
        let secret = match self.secrets.desktop(id).await {
            Ok(s) => s,
            Err(e) => {
                self.mark_cleanup(id, &e).await?;
                return self.retry_cleanup(id, &e).await;
            }
        };
        // Lost create response means missing edge credentials. Never resume or
        // connect through a provider API that can recreate the guest.
        if secret.traffic_token.is_none() {
            let e = refused("managed_desktop_missing_endpoint_credentials");
            self.mark_cleanup(id, &e).await?;
            return self.retry_cleanup(id, &e).await;
        }
        if row.bootstrap_started && !row.bootstrap_completed {
            let e = refused("managed_desktop_bootstrap_unknown_outcome");
            self.mark_cleanup(id, &e).await?;
            return self.retry_cleanup(id, &e).await;
        }
        if !row.bootstrap_started {
            self.transaction(|s, _| {
                s.desktops.get_mut(id).unwrap().bootstrap_started = true;
                Ok(())
            })
            .await?;
            if let Err(e) = self.provider.bootstrap(&row, &secret).await {
                self.mark_cleanup(id, &e).await?;
                return self.retry_cleanup(id, &e).await;
            }
            self.transaction(|s, _| {
                s.desktops.get_mut(id).unwrap().bootstrap_completed = true;
                Ok(())
            })
            .await?;
        }
        if let Err(e) = self.observe_bound_boundary(&row, &secret, !row.bootstrap_started).await {
            self.mark_cleanup(id, &e).await?;
            return self.retry_cleanup(id, &e).await;
        }
        if let Err(e) = self.provider.health(&row, &secret).await {
            if !e.retryable {
                self.mark_cleanup(id, &e).await?;
                return self.retry_cleanup(id, &e).await;
            }
            return self.reconcile_error(id, &e, false).await;
        }
        self.transaction(|s, now| {
            let r = s.desktops.get_mut(id).unwrap();
            if r.expired(now) {
                r.delete_requested = true;
                r.desktop.state = ManagedDesktopState::Deleting;
                r.desktop.last_error_code = Some("managed_desktop_deadline_expired".into());
                r.desktop.updated_at = now;
                r.next_retry_at = now;
                return Ok(r.desktop.clone());
            }
            r.desktop.state = ManagedDesktopState::Running;
            r.desktop.updated_at = now;
            r.desktop.last_error_code = None;
            r.next_retry_at = now + 15_000;
            Ok(r.desktop.clone())
        })
        .await
    }
    async fn reconcile_error(
        &self,
        id: &str,
        e: &ManagedDesktopError,
        deleting: bool,
    ) -> Result<ManagedDesktop> {
        if deleting {
            return self.retry_cleanup(id, e).await;
        }
        self.transaction(|s, now| {
            let r = s.desktops.get_mut(id).unwrap();
            r.desktop.state = ManagedDesktopState::Creating;
            r.desktop.last_error_code = Some(e.code.clone());
            r.desktop.updated_at = now;
            r.next_retry_at = now + 15_000;
            Ok(r.desktop.clone())
        })
        .await
    }
    /// Native qualification runner only. The Host must collect these facts
    /// from its explicitly authorized real-provider smoke; no RPC accepts a
    /// receipt or arbitrary qualification booleans.
    async fn record_qualification(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        receipt: QualificationReceipt,
    ) -> Result<()> {
        p.require_admin()?;
        let _op = self.operations.lock().await;
        let c = self.config(p, config_id).await?;
        self.admission(&c, self.now().await)?;
        self.transaction(|s, now| {
            let digest = c.binding_digest();
            if c.egress != DesktopEgress::Off {
                return Err(refused("managed_desktop_egress_smoke_unsupported"));
            }
            if receipt.binding_digest != digest
                || receipt.observed_at > now
                || now.saturating_sub(receipt.observed_at) > QUOTE_TTL_MS
                || receipt.smoke_desktop_ids.len() < 2
            {
                return Err(refused("managed_desktop_qualification_invalid"));
            }
            let template = latest_template(s, &digest)
                .filter(|t| t.state == TemplateState::Ready)
                .and_then(|t| t.identity.as_ref())
                .ok_or_else(|| refused("managed_desktop_template_not_ready"))?;
            if *template != receipt.template {
                return Err(refused("managed_desktop_qualification_invalid"));
            }
            let unique = receipt
                .smoke_desktop_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>();
            if unique.len() != receipt.smoke_desktop_ids.len()
                || receipt.smoke_desktop_ids.iter().any(|id| {
                    s.desktops
                        .get(id)
                        .is_none_or(|r| r.config.authorize(p).is_err())
                })
            {
                return Err(refused("managed_desktop_qualification_invalid"));
            }
            if !lifecycle_receipt_valid(s, &receipt, &digest, &receipt.template) {
                return Err(refused("managed_desktop_qualification_invalid"));
            }
            // P3 records what actually ran. Lifecycle-only evidence cannot
            // enable production or masquerade as all-launch-path qualification.
            s.lifecycle_diagnostics.insert(digest, receipt);
            Ok(())
        })
        .await
    }
    /// Called once at startup and by the Host's cancellation-bound timer.
    /// Existing config snapshots keep cleanup valid after disable/rotation.
    pub async fn reconcile(&self) -> Result<()> {
        let (templates, desktops) = {
            let s = self.state.lock().await;
            (
                s.templates
                    .values()
                    .filter(|t| {
                        matches!(t.state, TemplateState::Building | TemplateState::Registered)
                    })
                    .map(|t| t.id.clone())
                    .collect::<Vec<_>>(),
                s.desktops.keys().cloned().collect::<Vec<_>>(),
            )
        };
        let mut first = None;
        // Cleanup has priority; template inspection may wait on the provider.
        let _op = self.operations.lock().await;
        for id in desktops {
            if let Err(e) = self.reconcile_one(&id, false).await {
                first.get_or_insert(e);
            }
        }
        drop(_op);
        // Never wait behind image verification or template setup at startup.
        if let Ok(_template) = self.template_operations.try_lock() {
            for id in templates {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    self.refresh_template(&id),
                )
                .await
                {
                    Ok(Err(e)) => {
                        first.get_or_insert(e);
                    }
                    Err(_) => {
                        first.get_or_insert(retryable("managed_desktop_template_status_timeout"));
                    }
                    Ok(Ok(_)) => {}
                }
            }
        }
        self.transaction(|_, _| Ok(())).await?;
        match first {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}
fn latest_template<'a>(s: &'a ManagedDesktopJournal, digest: &str) -> Option<&'a TemplateRecord> {
    s.templates
        .values()
        .filter(|t| t.binding_digest == digest)
        .max_by_key(|t| t.created_at)
}
fn lifecycle_receipt_valid(
    s: &ManagedDesktopJournal,
    q: &QualificationReceipt,
    digest: &str,
    template: &TemplateIdentity,
) -> bool {
    q.evidence_version == 2
        && q.binding_digest == digest
        && q.template == *template
        && q.native_expiry_killed
        && q.no_auto_resume
        && q.ingress_denied
        && q.guest_auth_denied
        && q.decoded_frame_verified
        && q.protocol_verified
        && q.restart_deadline_verified
        && q.delete_retry_verified
        && q.egress_policy_verified
        && q.smoke_desktop_ids.len() >= 2
        && q.smoke_desktop_ids.iter().collect::<std::collections::BTreeSet<_>>().len()
            == q.smoke_desktop_ids.len()
        && q.smoke_desktop_ids.iter().all(|id| {
            s.desktops.get(id).is_some_and(|r| {
                r.smoke
                    && r.config.binding_digest() == digest
                    && r.template == *template
                    && r.desktop.state == ManagedDesktopState::Destroyed
                    && s.workload_boundaries.get(id).is_some_and(|b| b.matches_record(r))
            })
        })
}
fn lifecycle_diagnostic_valid(s: &ManagedDesktopJournal, digest: &str, template: &TemplateIdentity) -> bool {
    s.lifecycle_diagnostics.get(digest)
        .is_some_and(|q| lifecycle_receipt_valid(s, q, digest, template))
}
fn qualified(s: &ManagedDesktopJournal, digest: &str, template: &TemplateIdentity) -> bool {
    s.qualifications.get(digest).is_some_and(|q| {
        lifecycle_receipt_valid(s, q, digest, template)
            && q.workload_evidence.as_ref().is_some_and(|stored| {
                qualification::derive_evidence(s,digest,template).is_some_and(|derived| {
                    serde_json::to_value(stored).is_ok_and(|value| serde_json::to_value(derived).is_ok_and(|expected|value==expected))
                })
            })
    })
}

fn operation_id(p: &ManagedDesktopPrincipal, input: &CreateManagedDesktop, kind: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            kind,
            &p.host_id,
            &p.owner_principal_id,
            &p.principal_id,
            &input.provider_config_id,
            &input.idempotency_key,
        ))
        .expect("operation JSON"),
    ))
}
fn valid_quote<'a>(
    s: &'a ManagedDesktopJournal,
    c: &ManagedDesktopConfig,
    p: &ManagedDesktopPrincipal,
    id: &str,
    now: i64,
) -> Result<&'a ManagedDesktopQuote> {
    let q = s
        .quotes
        .get(id)
        .ok_or_else(|| refused("managed_desktop_quote_expired"))?;
    if q.expires_at <= now
        || q.owner_principal_id != p.owner_principal_id
        || q.provider_config_id != c.id
        || q.binding_digest != c.binding_digest()
    {
        return Err(refused("managed_desktop_quote_expired"));
    }
    Ok(q)
}
fn consume(
    s: &mut ManagedDesktopJournal,
    c: &ManagedDesktopConfig,
    p: &ManagedDesktopPrincipal,
    input: &CreateManagedDesktop,
    purpose: AuthorizationPurpose,
    operation: &str,
    now: i64,
) -> Result<DesktopAuthorization> {
    valid_quote(s, c, p, &input.quote_id, now)?;
    let a = s
        .authorizations
        .get_mut(&input.authorization_id)
        .ok_or_else(|| refused("managed_desktop_authorization_required"))?;
    if a.owner_principal_id != p.owner_principal_id
        || a.principal_id != p.principal_id
        || a.provider_config_id != c.id
        || a.binding_digest != c.binding_digest()
        || a.purpose != purpose
        || a.quote_id.as_deref() != Some(input.quote_id.as_str())
        || a.expires_at <= now
        || a.consumed_by.is_some()
    {
        return Err(refused("managed_desktop_authorization_invalid"));
    }
    a.consumed_by = Some(operation.into());
    Ok(a.clone())
}
fn egress_matches(egress: &DesktopEgress, resource: &ProviderDesktop) -> bool {
    let has = |cidr: &str| resource.deny_out.iter().any(|v| v == cidr);
    match egress {
        DesktopEgress::Off => resource.allow_out.is_empty() && has("0.0.0.0/0"),
        DesktopEgress::On => {
            resource.allow_out.is_empty() && cognia_e2b::PRIVATE_EGRESS_DENY.iter().all(|v| has(v))
        }
        DesktopEgress::Allowlist(rules) => {
            has("0.0.0.0/0")
                && rules.iter().collect::<std::collections::BTreeSet<_>>()
                    == resource
                        .allow_out
                        .iter()
                        .collect::<std::collections::BTreeSet<_>>()
        }
    }
}
fn owns(row: &DesktopRecord, resource: &ProviderDesktop) -> bool {
    row.metadata()
        .iter()
        .all(|(k, v)| resource.metadata.get(k) == Some(v))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::{
        collections::BTreeMap,
        sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    };
    struct FakeProvider {
        resources: Mutex<BTreeMap<String, ProviderDesktop>>,
        creates: AtomicUsize,
        deletes: AtomicUsize,
        bootstraps: AtomicUsize,
        lose_create: AtomicBool,
        fail_delete: AtomicBool,
        bad_policy: AtomicBool,
        lose_bootstrap: AtomicBool,
        boundary_fault: AtomicUsize,
        auto_expire: AtomicBool,
        lifetime_cap_ms: AtomicI64,
        now: AtomicI64,
        verify_gate: Mutex<Option<Arc<TestGate>>>,
        create_gate: Mutex<Option<Arc<TestGate>>>,
    }
    struct TestGate {
        entered: tokio::sync::Notify,
        resume: tokio::sync::Notify,
    }
    impl TestGate {
        fn new() -> Arc<Self> {
            Arc::new(Self { entered: tokio::sync::Notify::new(), resume: tokio::sync::Notify::new() })
        }
        async fn pause(&self) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
    }
    impl FakeProvider {
        fn new() -> Self {
            Self {
                resources: Mutex::new(BTreeMap::new()),
                creates: AtomicUsize::new(0),
                deletes: AtomicUsize::new(0),
                bootstraps: AtomicUsize::new(0),
                lose_create: AtomicBool::new(false),
                fail_delete: AtomicBool::new(false),
                bad_policy: AtomicBool::new(false),
                lose_bootstrap: AtomicBool::new(false),
                boundary_fault: AtomicUsize::new(0),
                auto_expire: AtomicBool::new(false),
                lifetime_cap_ms: AtomicI64::new(i64::MAX),
                now: AtomicI64::new(1000),
                verify_gate: Mutex::new(None),
                create_gate: Mutex::new(None),
            }
        }
    }
    #[async_trait]
    impl ManagedDesktopProvider for FakeProvider {
        async fn verify_release(&self, _: &ManagedDesktopConfig) -> Result<()> {
            let gate = self.verify_gate.lock().await.take();
            if let Some(gate) = gate { gate.pause().await; }
            Ok(())
        }
        async fn verify_smoke_egress(&self, _: &DesktopRecord, _: &DesktopSecrets) -> Result<cognia_e2b::envd::EgressProbeReport> {
            Ok(cognia_e2b::envd::EgressProbeReport { observations: ["publicIp", "publicDns", "private10", "private172", "private192", "carrierPrivate", "linkLocal", "metadata", "publicIpv6", "metadataIpv6"].into_iter().map(|target| (target.into(), target == "metadata")).collect() })
        }
        async fn observe_boundary(&self, _: &DesktopRecord, _: &DesktopSecrets) -> Result<cognia_desktop_guest::observation::ProcessBoundaryReport> {
            use cognia_desktop_guest::observation::{ProcessBoundaryReport, DescriptorObservation, NAMESPACES};
            let mut report = ProcessBoundaryReport {
                report_version: 1, workload_isolation_revision: 1,
                phase: cognia_desktop_guest::observation::ObservationPhase::DesktopLive,
                boundary_generation: "6a370d8e-2d69-40fb-9586-786b7424365a".into(),
                namespace_init_pid: 20, namespace_init_start_time: 1,
                workload_pid: 21, workload_start_time: 2,
                namespaces: NAMESPACES.into_iter().map(|n| (n.into(), format!("{n}:[2]"))).collect(),
                provider_namespaces: NAMESPACES.into_iter().map(|n| (n.into(), format!("{n}:[1]"))).collect(),
                status: "Uid:1000 1000 1000 1000\nGid:1000 1000 1000 1000\nGroups:\nCapInh:0\nCapPrm:0\nCapEff:0\nCapBnd:0\nCapAmb:0\nNoNewPrivs:1\nSeccomp:2\n".into(),
                network_devices: "header\nheader\n lo: 0\n".into(),
                ipv4_routes: "header\n".into(), ipv6_routes: String::new(),
                descriptors: (0..=2).map(|fd| (fd, DescriptorObservation {target: "/dev/null".into(), flags: 0, socket_scope: None})).collect(),
            };
            match self.boundary_fault.load(Ordering::SeqCst) {
                1 => report.boundary_generation = Uuid::new_v4().to_string(),
                2 => report.status = report.status.replace("CapBnd:0", "CapBnd:1"),
                3 => return Err(refused("managed_desktop_boundary_unavailable")),
                _ => {},
            }
            Ok(report)
        }
        async fn register_template(
            &self,
            c: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &str,
            admission: LifecycleAdmission,
        ) -> Result<TemplateIdentity> {
            admission()?;
            Ok(TemplateIdentity {
                template_id: "template".into(),
                build_id: Uuid::new_v4().to_string(),
                image_digest: c.release.image_digest.clone(),
                recipe_revision: c.release.recipe_revision.clone(),
                protocol: c.release.protocol.clone(),
            })
        }
        async fn start_template(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &TemplateIdentity,
            admission: LifecycleAdmission,
        ) -> Result<()> {
            admission()?;
            Ok(())
        }
        async fn template_status(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            _: &TemplateIdentity,
        ) -> Result<TemplateState> {
            Ok(TemplateState::Ready)
        }
        async fn create(
            &self,
            r: &DesktopRecord,
            _: &ProviderSecret,
            s: &DesktopSecrets,
            _: u64,
            admission: LifecycleAdmission,
        ) -> Result<CreatedDesktop> {
            let gate = self.create_gate.lock().await.take();
            if let Some(gate) = gate { gate.pause().await; }
            admission()?;
            let count = self.creates.fetch_add(1, Ordering::SeqCst);
            let resource = ProviderDesktop {
                resource_id: format!("resource-{count}"),
                running: true,
                metadata: r.metadata(),
                template_id: Some(r.template.template_id.clone()),
                deadline_at: Some((r.desktop.deadline_at - 1000).min(
                    self.now.load(Ordering::SeqCst)
                        .saturating_add(self.lifetime_cap_ms.load(Ordering::SeqCst)),
                )),
                kill_on_timeout: !self.bad_policy.load(Ordering::SeqCst),
                auto_resume: false,
                private_ingress: true,
                allow_out: Vec::new(),
                deny_out: vec!["0.0.0.0/0".into()],
            };
            self.resources
                .lock()
                .await
                .insert(resource.resource_id.clone(), resource.clone());
            if self.lose_create.load(Ordering::SeqCst) {
                return Err(retryable("lost_create"));
            }
            Ok(CreatedDesktop {
                resource,
                secrets: DesktopSecrets {
                    guest_token: s.guest_token.clone(),
                    traffic_token: Some("edge-secret".into()),
                    domain: Some("e2b.app".into()),
                    envd_token: Some("envd-secret".into()),
                },
            })
        }
        async fn inspect(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            id: &str,
        ) -> Result<Option<ProviderDesktop>> {
            let mut resources = self.resources.lock().await;
            if self.auto_expire.load(Ordering::SeqCst)
                && resources.get(id).is_some_and(|r| {
                    r.deadline_at
                        .is_some_and(|d| d <= self.now.load(Ordering::SeqCst))
                })
            {
                resources.remove(id);
            }
            Ok(resources.get(id).cloned())
        }
        async fn list(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            metadata: &BTreeMap<String, String>,
        ) -> Result<Vec<ProviderDesktop>> {
            Ok(self
                .resources
                .lock()
                .await
                .values()
                .filter(|r| metadata.iter().all(|(k, v)| r.metadata.get(k) == Some(v)))
                .cloned()
                .collect())
        }
        async fn delete(
            &self,
            _: &ManagedDesktopConfig,
            _: &ProviderSecret,
            id: &str,
        ) -> Result<()> {
            self.deletes.fetch_add(1, Ordering::SeqCst);
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(retryable("delete_timeout"));
            }
            self.resources.lock().await.remove(id);
            Ok(())
        }
        async fn bootstrap(&self, _: &DesktopRecord, _: &DesktopSecrets) -> Result<()> {
            self.bootstraps.fetch_add(1, Ordering::SeqCst);
            if self.lose_bootstrap.load(Ordering::SeqCst) {
                Err(retryable("lost_bootstrap"))
            } else {
                Ok(())
            }
        }
        async fn health(&self, _: &DesktopRecord, _: &DesktopSecrets) -> Result<()> {
            Ok(())
        }
    }
    pub(crate) struct Fixture {
        directory: tempfile::TempDir,
        provider: Arc<FakeProvider>,
        secrets: Arc<FileManagedDesktopSecrets>,
        clock: Arc<AtomicI64>,
        pub(super) service: ManagedDesktopService,
        pub(super) p: ManagedDesktopPrincipal,
        pub(crate) config: ManagedDesktopConfig,
    }
    impl Fixture {
        pub(crate) fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let provider = Arc::new(FakeProvider::new());
            let secrets =
                Arc::new(FileManagedDesktopSecrets::open(&directory.path().join("vault")).unwrap());
            let clock = Arc::new(AtomicI64::new(1000));
            let release = DesktopRelease {
                image: format!("example.test/desktop@sha256:{}", "a".repeat(64)),
                image_digest: format!("sha256:{}", "a".repeat(64)),
                architecture: "linux/amd64".into(),
                recipe_revision: "3".into(),
                protocol: "computer-server-0.3.46".into(),
                server_version: "0.3.46".into(),
                start_command: "sleep infinity".into(),
                ready_command: "test -x /usr/local/bin/cognia-desktop".into(),
            };
            let config = ManagedDesktopConfig {
                id: "e2b".into(),
                owner_principal_id: "owner".into(),
                host_id: "host".into(),
                revision: 1,
                enabled: true,
                credential_generation: 1,
                region: None,
                shape: DesktopShape {
                    cpu_count: 2,
                    memory_mb: 2048,
                },
                limits: DesktopLimits::default(),
                plan: AccountPlanBinding {
                    max_lifetime_seconds: 3600,
                    observed_at: 0,
                    expires_at: 100_000_000,
                    source: "operator-confirmed".into(),
                    namespace: "team".into(),
                },
                price: DesktopPrice {
                    currency: "USD".into(),
                    hourly_rate_micros: 100_000,
                    observed_at: 0,
                    expires_at: 100_000_000,
                    source: "price-sheet".into(),
                },
                release: release.clone(),
                egress: DesktopEgress::Off,
                isolation_minimum: IsolationTier::Vm,
            };
            let mut service = ManagedDesktopService::open(
                directory.path(),
                "host".into(),
                provider.clone(),
                secrets.clone(),
                Some(release),
            )
            .unwrap();
            let c = clock.clone();
            service.clock = Arc::new(move || c.load(Ordering::SeqCst));
            service
                .store
                .save_registry(&super::super::journal::ManagedDesktopRegistry {
                    version: 1,
                    providers: vec![config.clone()],
                })
                .unwrap();
            secrets
                .set_provider_key(&config, "provider-secret")
                .unwrap();
            let p = ManagedDesktopPrincipal {
                owner_principal_id: "owner".into(),
                principal_id: "human".into(),
                host_id: "host".into(),
                authority: ManagedDesktopAuthority::Administrator,
            };
            Self {
                directory,
                provider,
                secrets,
                clock,
                service,
                p,
                config,
            }
        }
        async fn request(&self, purpose: AuthorizationPurpose, key: &str) -> CreateManagedDesktop {
            let quote = self.service.quote(&self.p, "e2b", 3600).await.unwrap();
            let auth = self
                .service
                .authorize(&self.p, "e2b", &quote.id, purpose, None)
                .await
                .unwrap();
            CreateManagedDesktop {
                provider_config_id: "e2b".into(),
                quote_id: quote.id,
                authorization_id: auth.id,
                idempotency_key: key.into(),
            }
        }
        pub(super) async fn prepare(&self) {
            let request = self
                .request(AuthorizationPurpose::PrepareTemplate, "template")
                .await;
            assert_eq!(
                self.service
                    .prepare_template(&self.p, request)
                    .await
                    .unwrap()
                    .state,
                TemplateState::Ready
            );
        }
        pub(super) async fn smoke(&self, key: &str) -> ManagedDesktop {
            let request = self.request(AuthorizationPurpose::Smoke, key).await;
            self.service.create_smoke(&self.p, request).await.unwrap()
        }
    }
    struct LiveAuthority(Arc<AtomicBool>);
    impl LiveAuthority {
        fn new() -> Self { Self(Arc::new(AtomicBool::new(true))) }
    }
    #[async_trait]
    impl control::ManagedControlAuthority for LiveAuthority {
        async fn revalidate(&self, _: &ManagedDesktopPrincipal) -> Result<()> {
            if self.0.load(Ordering::SeqCst) { Ok(()) } else { Err(refused("managed_desktop_forbidden")) }
        }
        fn input_admission(&self, _: &ManagedDesktopPrincipal) -> Arc<dyn Fn() -> bool + Send + Sync> {
            let valid = self.0.clone();
            Arc::new(move || valid.load(Ordering::SeqCst))
        }
    }
    struct DelayedSecrets {
        inner: Arc<FileManagedDesktopSecrets>,
        gate: Arc<TestGate>,
    }
    #[async_trait]
    impl ManagedDesktopSecrets for DelayedSecrets {
        async fn provider_key(&self, c: &ManagedDesktopConfig) -> Result<ProviderSecret> {
            let key = self.inner.provider_key(c).await?;
            self.gate.pause().await;
            Ok(key)
        }
        async fn desktop(&self, id: &str) -> Result<DesktopSecrets> { self.inner.desktop(id).await }
        async fn put_desktop(&self, id: &str, value: &DesktopSecrets) -> Result<()> { self.inner.put_desktop(id, value).await }
        async fn remove_desktop(&self, id: &str) -> Result<()> { self.inner.remove_desktop(id).await }
    }
    #[tokio::test]
    async fn durable_write_rechecks_admission_inside_blocking_job() {
        let f = Fixture::new();
        let checks = Arc::new(AtomicUsize::new(0));
        let count = checks.clone();
        let admission: LifecycleAdmission = Arc::new(move || {
            if count.fetch_add(1, Ordering::SeqCst) == 0 { Ok(()) }
            else { Err(refused("managed_desktop_forbidden")) }
        });
        let before = f.service.state.lock().await.revision;
        let result = f.service.transaction_admitted(admission, |s, _| {
            s.last_observed_at = 1234;
            Ok(())
        }).await;
        assert_eq!(result.unwrap_err().code, "managed_desktop_forbidden");
        assert_eq!(checks.load(Ordering::SeqCst), 2);
        assert_eq!(f.service.state.lock().await.revision, before);
        assert_eq!(f.service.store.load("host").unwrap().revision, before);
    }
    #[tokio::test]
    async fn revoked_authorization_waiting_for_state_cannot_become_durable() {
        let f = Fixture::new();
        let q = f.service.quote(&f.p, "e2b", 60).await.unwrap();
        let authority = LiveAuthority::new();
        let held = f.service.state.lock().await;
        let pending = f.service.authorize_with_authority(&f.p, "e2b", &q.id, AuthorizationPurpose::Create, None, &authority);
        tokio::pin!(pending);
        tokio::select! {
            biased;
            _ = &mut pending => panic!("authorization cannot pass the held journal lock"),
            _ = tokio::task::yield_now() => {}
        }
        authority.0.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(pending.await.unwrap_err().code, "managed_desktop_forbidden");
        assert!(f.service.state.lock().await.authorizations.is_empty());
    }
    #[tokio::test]
    async fn queued_create_revalidates_before_consuming_authorization() {
        let f = Fixture::new();
        f.prepare().await;
        let input = f.request(AuthorizationPurpose::Smoke, "queued").await;
        let auth_id = input.authorization_id.clone();
        let live = Arc::new(AtomicBool::new(true));
        let check = live.clone();
        let held = f.service.operations.lock().await;
        let pending = f.service.create_inner(&f.p, input, true, Arc::new(move || check.load(Ordering::SeqCst)));
        tokio::pin!(pending);
        tokio::select! {
            biased;
            _ = &mut pending => panic!("create cannot pass the held operation lock"),
            _ = tokio::task::yield_now() => {}
        }
        live.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(pending.await.unwrap_err().code, "managed_desktop_forbidden");
        assert!(f.service.state.lock().await.authorizations[&auth_id].consumed_by.is_none());
        assert_eq!(f.provider.creates.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn revoked_template_preflight_does_not_consume_consent_or_register() {
        let f = Fixture::new();
        let input = f.request(AuthorizationPurpose::PrepareTemplate, "revoked-build").await;
        let auth_id = input.authorization_id.clone();
        let authority = LiveAuthority::new();
        let gate = TestGate::new();
        *f.provider.verify_gate.lock().await = Some(gate.clone());
        let pending = f.service.prepare_template_with_authority(&f.p, input, &authority);
        let revoke = async {
            gate.entered.notified().await;
            authority.0.store(false, Ordering::SeqCst);
            gate.resume.notify_one();
        };
        let (result, ()) = tokio::join!(pending, revoke);
        assert_eq!(result.unwrap_err().code, "managed_desktop_forbidden");
        let state = f.service.state.lock().await;
        assert!(state.templates.is_empty());
        assert!(state.authorizations[&auth_id].consumed_by.is_none());
    }
    #[tokio::test]
    async fn config_disable_or_rotation_during_secret_lookup_refuses_without_reservation() {
        for disable in [true, false] {
            let mut f = Fixture::new();
            f.prepare().await;
            let input = f.request(AuthorizationPurpose::Smoke, "changed-secret").await;
            let auth_id = input.authorization_id.clone();
            let gate = TestGate::new();
            f.service.secrets = Arc::new(DelayedSecrets { inner: f.secrets.clone(), gate: gate.clone() });
            let pending = f.service.create_smoke(&f.p, input);
            let change = async {
                gate.entered.notified().await;
                let mut config = f.config.clone();
                if disable { config.enabled = false; } else { config.credential_generation += 1; }
                f.service.store.save_registry(&super::super::journal::ManagedDesktopRegistry { version: 1, providers: vec![config] }).unwrap();
                gate.resume.notify_one();
            };
            let (result, ()) = tokio::join!(pending, change);
            assert_eq!(result.unwrap_err().code, if disable { "managed_desktop_disabled" } else { "managed_desktop_quote_expired" });
            let state = f.service.state.lock().await;
            assert!(state.desktops.is_empty());
            assert!(state.authorizations[&auth_id].consumed_by.is_none());
            assert_eq!(f.provider.creates.load(Ordering::SeqCst), 0);
        }
    }
    #[tokio::test]
    async fn provider_preflight_rechecks_live_caller_and_config_before_paid_create() {
        for revoke_caller in [true, false] {
            let f = Fixture::new();
            f.prepare().await;
            let input = f.request(AuthorizationPurpose::Smoke, "late-change").await;
            let live = Arc::new(AtomicBool::new(true));
            let check = live.clone();
            let gate = TestGate::new();
            *f.provider.create_gate.lock().await = Some(gate.clone());
            let pending = f.service.create_inner(&f.p, input, true, Arc::new(move || check.load(Ordering::SeqCst)));
            let change = async {
                gate.entered.notified().await;
                if revoke_caller {
                    live.store(false, Ordering::SeqCst);
                } else {
                    let mut config = f.config.clone();
                    config.credential_generation += 1;
                    f.service.store.save_registry(&super::super::journal::ManagedDesktopRegistry { version: 1, providers: vec![config] }).unwrap();
                }
                gate.resume.notify_one();
            };
            let (result, ()) = tokio::join!(pending, change);
            assert_eq!(result.unwrap_err().code, if revoke_caller { "managed_desktop_forbidden" } else { "managed_desktop_quote_expired" });
            assert_eq!(f.provider.creates.load(Ordering::SeqCst), 0);
            // The consumed operation remains journalled until authoritative
            // absence, even though this transport refused before POST.
            assert_eq!(f.service.state.lock().await.desktops.len(), 1);
            f.clock.store(3_601_001, Ordering::SeqCst);
            f.service.reconcile().await.unwrap();
            assert_eq!(f.service.list(&f.p).await.unwrap()[0].state, ManagedDesktopState::Destroyed);
        }
    }
    #[tokio::test]
    async fn queued_delete_refuses_revocation_but_accepted_cleanup_survives_logout() {
        let f = Fixture::new();
        f.prepare().await;
        let desktop = f.smoke("delete-live").await;
        let authority = LiveAuthority::new();
        let held = f.service.operations.lock().await;
        let pending = f.service.delete_with_authority(&f.p, &desktop.id, desktop.generation, &authority);
        tokio::pin!(pending);
        tokio::select! {
            biased;
            _ = &mut pending => panic!("delete cannot pass the held operation lock"),
            _ = tokio::task::yield_now() => {}
        }
        authority.0.store(false, Ordering::SeqCst);
        drop(held);
        assert_eq!(pending.await.unwrap_err().code, "managed_desktop_forbidden");
        assert_eq!(f.provider.deletes.load(Ordering::SeqCst), 0);
        assert!(!f.service.state.lock().await.desktops[&desktop.id].delete_requested);
        authority.0.store(true, Ordering::SeqCst);
        f.provider.fail_delete.store(true, Ordering::SeqCst);
        f.service.delete_with_authority(&f.p, &desktop.id, desktop.generation, &authority).await.unwrap();
        authority.0.store(false, Ordering::SeqCst);
        f.provider.fail_delete.store(false, Ordering::SeqCst);
        f.clock.store(17_000, Ordering::SeqCst);
        f.service.store.save_registry(&super::super::journal::ManagedDesktopRegistry::default()).unwrap();
        f.service.reconcile().await.unwrap();
        assert_eq!(f.service.list(&f.p).await.unwrap()[0].state, ManagedDesktopState::Destroyed);
    }
    #[tokio::test]
    async fn unqualified_production_refuses_before_any_paid_desktop_and_agent_cannot_authorize() {
        let f = Fixture::new();
        f.prepare().await;
        let input = f.request(AuthorizationPurpose::Create, "create").await;
        assert_eq!(
            f.service.create(&f.p, input).await.unwrap_err().code,
            "managed_desktop_unqualified"
        );
        assert_eq!(f.provider.creates.load(Ordering::SeqCst), 0);
        let mut agent = f.p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        let q = f.service.quote(&agent, "e2b", 100).await.unwrap();
        assert!(f
            .service
            .authorize(&agent, "e2b", &q.id, AuthorizationPurpose::Create, None)
            .await
            .is_err());
        let summaries = f.service.list_configs(&f.p).await.unwrap();
        assert!(summaries[0].can_prepare_template);
        assert!(!summaries[0].can_create);
    }
    #[tokio::test]
    async fn one_use_consent_idempotency_cap_and_owner_scope() {
        let f = Fixture::new();
        f.prepare().await;
        let input = f.request(AuthorizationPurpose::Smoke, "first").await;
        let first = f.service.create_smoke(&f.p, input.clone()).await.unwrap();
        assert_eq!(first.state, ManagedDesktopState::Running);
        assert_eq!(
            f.service
                .create_smoke(&f.p, input.clone())
                .await
                .unwrap()
                .id,
            first.id
        );
        let mut replay = input.clone();
        replay.idempotency_key = "different".into();
        assert!(f.service.create_smoke(&f.p, replay).await.is_err());
        f.smoke("second").await;
        let input = f.request(AuthorizationPurpose::Smoke, "third").await;
        assert_eq!(
            f.service.create_smoke(&f.p, input).await.unwrap_err().code,
            "managed_desktop_capacity_limit"
        );
        assert_eq!(f.provider.creates.load(Ordering::SeqCst), 2);
        let mut foreign = f.p.clone();
        foreign.owner_principal_id = "foreign".into();
        assert!(f.service.connect(&foreign, &first.id, 1).await.is_err());
        assert!(f.service.connect(&f.p, &first.id, 2).await.is_err());
        let json = serde_json::to_string(&f.service.list(&f.p).await.unwrap()).unwrap();
        assert!(!json.contains("secret"));
        assert!(!json.contains("resource-"));
    }
    #[tokio::test]
    async fn idle_deadline_health_does_not_extend_and_delete_failure_retains_slot() {
        let f = Fixture::new();
        f.prepare().await;
        let desktop = f.smoke("first").await;
        f.clock.store(500_000, Ordering::SeqCst);
        assert!(
            f.service
                .health(&f.p, &desktop.id, 1)
                .await
                .unwrap()
                .reachable
        );
        f.provider.fail_delete.store(true, Ordering::SeqCst);
        f.clock.store(601_001, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        let row = f.service.list(&f.p).await.unwrap().pop().unwrap();
        assert_eq!(row.state, ManagedDesktopState::DestroyRetrying);
        assert_eq!(row.deadline_at, desktop.deadline_at);
        let attempts = f.provider.deletes.load(Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert_eq!(f.provider.deletes.load(Ordering::SeqCst), attempts);
        f.provider.fail_delete.store(false, Ordering::SeqCst);
        f.clock.store(617_001, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert_eq!(
            f.service.list(&f.p).await.unwrap()[0].state,
            ManagedDesktopState::Destroyed
        );
        assert!(f.secrets.desktop(&desktop.id).await.is_err());
    }
    #[tokio::test]
    async fn lost_create_reconciles_metadata_without_second_paid_create() {
        let f = Fixture::new();
        f.prepare().await;
        f.provider.lose_create.store(true, Ordering::SeqCst);
        let request = f.request(AuthorizationPurpose::Smoke, "lost").await;
        assert!(f.service.create_smoke(&f.p, request.clone()).await.is_err());
        let existing = f.service.create_smoke(&f.p, request).await.unwrap();
        assert_eq!(existing.state, ManagedDesktopState::Creating);
        f.clock.store(17_000, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert_eq!(
            f.service.list(&f.p).await.unwrap()[0].state,
            ManagedDesktopState::DestroyRetrying
        );
        f.clock.store(33_000, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert!(f.provider.resources.lock().await.is_empty());
        assert_eq!(f.provider.creates.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn unsafe_provider_policy_and_lost_bootstrap_are_quarantined() {
        let f = Fixture::new();
        f.prepare().await;
        f.provider.bad_policy.store(true, Ordering::SeqCst);
        let d = f.smoke("bad-policy").await;
        assert_eq!(d.state, ManagedDesktopState::Destroyed);
        assert_eq!(f.provider.bootstraps.load(Ordering::SeqCst), 0);
        f.provider.bad_policy.store(false, Ordering::SeqCst);
        f.provider.lose_bootstrap.store(true, Ordering::SeqCst);
        let d = f.smoke("bootstrap").await;
        assert_eq!(d.state, ManagedDesktopState::DestroyRetrying);
        f.clock.store(17_000, Ordering::SeqCst);
        f.service.reconcile().await.unwrap();
        assert_eq!(f.provider.bootstraps.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn stale_quote_key_rotation_and_restart_keep_original_cleanup_authority() {
        let f = Fixture::new();
        f.prepare().await;
        let request = f.request(AuthorizationPurpose::Smoke, "stale").await;
        let mut changed = f.config.clone();
        changed.credential_generation = 2;
        f.service
            .store
            .save_registry(&super::super::journal::ManagedDesktopRegistry {
                version: 1,
                providers: vec![changed.clone()],
            })
            .unwrap();
        f.secrets.set_provider_key(&changed, "new-key").unwrap();
        assert!(f.service.create_smoke(&f.p, request).await.is_err());
        f.service
            .store
            .save_registry(&super::super::journal::ManagedDesktopRegistry {
                version: 1,
                providers: vec![f.config.clone()],
            })
            .unwrap();
        let d = f.smoke("restart").await;
        let Fixture {
            directory,
            provider,
            secrets,
            clock,
            service,
            p,
            config,
        } = f;
        drop(service);
        let mut service = ManagedDesktopService::open(
            directory.path(),
            "host".into(),
            provider.clone(),
            secrets,
            Some(config.release),
        )
        .unwrap();
        clock.store(601_001, Ordering::SeqCst);
        let c = clock.clone();
        service.clock = Arc::new(move || c.load(Ordering::SeqCst));
        service
            .store
            .save_registry(&super::super::journal::ManagedDesktopRegistry::default())
            .unwrap();
        service.reconcile().await.unwrap();
        assert_eq!(service.list(&p).await.unwrap()[0].id, d.id);
        assert!(provider.resources.lock().await.is_empty());
    }
    struct SmokeHost {
        directory: tempfile::TempDir,
        provider: Arc<FakeProvider>,
        secrets: Arc<FileManagedDesktopSecrets>,
        clock: Arc<AtomicI64>,
        release: DesktopRelease,
        approved: AtomicUsize,
        deny: bool,
    }
    #[async_trait]
    impl ManagedDesktopSmokeHost for SmokeHost {
        fn provider(&self) -> Arc<dyn ManagedDesktopProvider> {
            self.provider.clone()
        }
        fn open(&self, provider: Arc<dyn ManagedDesktopProvider>) -> Result<ManagedDesktopService> {
            let mut service = ManagedDesktopService::open(
                self.directory.path(),
                "host".into(),
                provider,
                self.secrets.clone(),
                Some(self.release.clone()),
            )?;
            let clock = self.clock.clone();
            service.clock = Arc::new(move || clock.load(Ordering::SeqCst));
            Ok(service)
        }
        async fn approve_quote(
            &self,
            quote: &ManagedDesktopQuote,
            _: AuthorizationPurpose,
        ) -> Result<()> {
            assert_eq!(quote.lifetime_seconds, 120);
            assert_eq!(
                quote.maximum_compute_cost_micros,
                (quote.hourly_rate_micros * 120).div_ceil(3600),
            );
            if self.deny {
                return Err(refused("operator_declined"));
            }
            self.approved.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    struct TestWait {
        clock: Arc<AtomicI64>,
        provider: Arc<FakeProvider>,
    }
    #[async_trait]
    impl smoke::SmokeWait for TestWait {
        async fn wait(&self, duration: std::time::Duration) {
            let now = self
                .clock
                .fetch_add(duration.as_millis() as i64, Ordering::SeqCst)
                + duration.as_millis() as i64;
            self.provider.now.store(now, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn live_boundary_changes_and_missing_observation_quarantine_then_destroy() {
        for fault in [1, 2, 3] {
            let f = Fixture::new();
            f.prepare().await;
            let desktop = f.smoke("boundary").await;
            assert_eq!(desktop.state, ManagedDesktopState::Running);
            let original = f.service.validate_live_boundary(&f.p, &desktop).await.unwrap();
            f.provider.boundary_fault.store(fault, Ordering::SeqCst);
            assert!(f.service.validate_live_boundary(&f.p, &desktop).await.is_err());
            let row = f.service.scoped(&f.p, &desktop.id, desktop.generation).await.unwrap();
            assert!(row.delete_requested);
            assert_eq!(row.desktop.state, ManagedDesktopState::DestroyRetrying);
            assert!(f.service.state.lock().await.workload_boundaries[&desktop.id].same_generation(&original));
            let deleted = f.service.connect(&f.p, &desktop.id, desktop.generation).await.unwrap();
            assert_eq!(deleted.state, ManagedDesktopState::Destroyed);
            assert!(f.provider.resources.lock().await.is_empty());
        }
    }

    #[tokio::test]
    async fn reconnect_cannot_rebind_legacy_or_replayed_desktop_identity() {
        for fault in [0, 1, 2, 3, 4] {
            let f = Fixture::new();
            f.prepare().await;
            let desktop = f.smoke("replay").await;
            f.service.transaction(|state, _| {
                if fault == 0 {
                    state.workload_boundaries.remove(&desktop.id);
                } else {
                    let binding = state.workload_boundaries.get_mut(&desktop.id).unwrap();
                    match fault {
                        1 => binding.owner_principal_id = "other".into(),
                        2 => binding.host_id = "other".into(),
                        3 => binding.desktop_generation += 1,
                        _ => binding.template.build_id = Uuid::new_v4().to_string(),
                    }
                }
                Ok(())
            }).await.unwrap();
            let connected = f.service.connect(&f.p, &desktop.id, desktop.generation).await.unwrap();
            assert_eq!(connected.state, ManagedDesktopState::DestroyRetrying);
            assert!(f.service.scoped(&f.p, &desktop.id, desktop.generation).await.unwrap().delete_requested);
        }
    }

    #[tokio::test]
    async fn native_lifecycle_smoke_retains_diagnostics_without_production_qualification() {
        let Fixture {
            directory,
            provider,
            secrets,
            clock,
            service,
            p,
            config,
        } = Fixture::new();
        drop(service);
        provider.auto_expire.store(true, Ordering::SeqCst);
        let waiter = TestWait {
            clock: clock.clone(),
            provider: provider.clone(),
        };
        let host = SmokeHost {
            directory,
            provider: provider.clone(),
            secrets,
            clock,
            release: config.release,
            approved: AtomicUsize::new(0),
            deny: false,
        };
        let receipt = smoke::run_with_wait(&host, &p, "e2b", &waiter)
            .await
            .unwrap();
        assert_eq!(receipt.smoke_desktop_ids.len(), 2);
        assert_eq!(provider.creates.load(Ordering::SeqCst), 2);
        assert!(provider.resources.lock().await.is_empty());
        assert_eq!(host.approved.load(Ordering::SeqCst), 3);
        let service = host.open(provider.clone()).unwrap();
        assert!(!service.list_configs(&p).await.unwrap()[0].can_create);
        let state = service.state.lock().await;
        assert!(state.qualifications.is_empty());
        assert_eq!(state.lifecycle_diagnostics.len(), 1);
        assert_eq!(receipt.evidence_version, 2);
        assert!(receipt.workload_evidence.is_none());
        assert!(!receipt.private_egress_probe_no_response);
        assert!(receipt.provider_root_observation.as_ref().unwrap().observations["metadata"]);
        // Even historically successful v1 booleans never qualify the new profile.
        let mut legacy = serde_json::to_value(&receipt).unwrap();
        legacy.as_object_mut().unwrap().remove("evidenceVersion");
        legacy.as_object_mut().unwrap().remove("workloadEvidence");
        legacy.as_object_mut().unwrap().remove("providerRootObservation");
        let legacy: QualificationReceipt = serde_json::from_value(legacy).unwrap();
        assert_eq!(legacy.evidence_version, 0);
        let mut replay = state.clone();
        let digest = receipt.binding_digest.clone();
        replay.qualifications.insert(digest.clone(), legacy);
        assert!(!qualified(&replay, &digest, &receipt.template));
        replay.qualifications.insert(digest.clone(), receipt.clone());
        assert!(!qualified(&replay, &digest, &receipt.template));
    }
    #[tokio::test]
    async fn native_smoke_rejects_expiry_without_a_successful_delete_retry() {
        let Fixture { directory, provider, secrets, clock, service, p, config } = Fixture::new();
        drop(service);
        provider.auto_expire.store(true, Ordering::SeqCst);
        provider.fail_delete.store(true, Ordering::SeqCst);
        // A shortened provider TTL expires before the third delete retry,
        // reproducing natural expiry while every real delete still fails.
        provider.lifetime_cap_ms.store(60_000, Ordering::SeqCst);
        let waiter = TestWait { clock: clock.clone(), provider: provider.clone() };
        let host = SmokeHost {
            directory,
            provider: provider.clone(),
            secrets,
            clock,
            release: config.release,
            approved: AtomicUsize::new(0),
            deny: false,
        };
        assert_eq!(
            smoke::run_with_wait(&host, &p, "e2b", &waiter).await.unwrap_err().code,
            "managed_desktop_delete_retry_unproven",
        );
        assert_eq!(provider.creates.load(Ordering::SeqCst), 2);
        assert!(provider.deletes.load(Ordering::SeqCst) > 0);
        assert!(provider.resources.lock().await.is_empty());
        let service = host.open(provider).unwrap();
        assert!(service.state.lock().await.qualifications.is_empty());
    }
    #[tokio::test]
    async fn native_smoke_operator_decline_cannot_allocate_or_install_receipt() {
        let Fixture {
            directory,
            provider,
            secrets,
            clock,
            service,
            p,
            config,
        } = Fixture::new();
        drop(service);
        let waiter = TestWait {
            clock: clock.clone(),
            provider: provider.clone(),
        };
        let host = SmokeHost {
            directory,
            provider: provider.clone(),
            secrets,
            clock,
            release: config.release,
            approved: AtomicUsize::new(0),
            deny: true,
        };
        assert_eq!(
            smoke::run_with_wait(&host, &p, "e2b", &waiter)
                .await
                .unwrap_err()
                .code,
            "operator_declined"
        );
        assert_eq!(provider.creates.load(Ordering::SeqCst), 0);
        let service = host.open(provider).unwrap();
        assert!(service.state.lock().await.qualifications.is_empty());
    }
    #[tokio::test]
    async fn simultaneous_authorization_replay_allocates_once() {
        let f = Fixture::new();
        f.prepare().await;
        let a = f.request(AuthorizationPurpose::Smoke, "a").await;
        let mut b = a.clone();
        b.idempotency_key = "b".into();
        let (one, two) = tokio::join!(
            f.service.create_smoke(&f.p, a),
            f.service.create_smoke(&f.p, b)
        );
        assert_ne!(one.is_ok(), two.is_ok());
        assert_eq!(f.provider.creates.load(Ordering::SeqCst), 1);
    }
}
