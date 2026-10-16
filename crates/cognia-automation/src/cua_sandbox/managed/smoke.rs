//! Explicit native operator qualification. Never registered as an RPC method.
//! This owns its service instances and never starts a reconciliation worker.
use super::*;
use async_trait::async_trait;
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

pub struct ExplicitPaidSmokeAuthorization(());
impl ExplicitPaidSmokeAuthorization {
    pub fn from_operator_flag(flag: &str) -> Result<Self> {
        if flag == "--authorize-paid-smoke" {
            Ok(Self(()))
        } else {
            Err(refused(
                "managed_desktop_explicit_smoke_authorization_required",
            ))
        }
    }
}

#[async_trait]
pub trait ManagedDesktopSmokeHost: Send + Sync {
    fn provider(&self) -> Arc<dyn ManagedDesktopProvider>;
    /// Each call must open the same private data directory and Host identity.
    /// Do not install the normal application's periodic reconciliation task.
    fn open(&self, provider: Arc<dyn ManagedDesktopProvider>) -> Result<ManagedDesktopService>;
    /// The native operator sees and explicitly accepts the current quote.
    /// For template setup, disclose that provider build charges may be separate.
    async fn approve_quote(
        &self,
        quote: &ManagedDesktopQuote,
        purpose: AuthorizationPurpose,
    ) -> Result<()>;
}

#[async_trait]
pub(super) trait SmokeWait: Send + Sync {
    async fn wait(&self, duration: Duration);
}
pub(super) struct RealWait;
#[async_trait]
impl SmokeWait for RealWait {
    async fn wait(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Two 60-second desktops at most. All qualifications come from assertions;
/// no operator-supplied receipt or success flags are accepted.
pub async fn run_qualification_smoke(
    host: &dyn ManagedDesktopSmokeHost,
    principal: &ManagedDesktopPrincipal,
    config_id: &str,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<QualificationReceipt> {
    run_with_wait(host, principal, config_id, &RealWait).await
}

pub(super) async fn run_with_wait(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    wait: &dyn SmokeWait,
) -> Result<QualificationReceipt> {
    p.require_admin()?;
    let provider = Arc::new(FailOneDelete {
        inner: host.provider(),
        fail: AtomicBool::new(false),
    });
    let service = host.open(provider.clone())?;
    let config = service.config(p, config_id).await?;
    service.admission(&config, service.now().await)?;
    if config.egress != DesktopEgress::Off {
        return Err(refused("managed_desktop_egress_smoke_unsupported"));
    }
    let source = format!("smoke:{}", Uuid::new_v4());
    let outcome = run_steps(host, p, config_id, &source, service, provider.clone(), wait).await;
    if outcome.is_err() {
        let service = host.open(provider.clone())?;
        // Preserve all pending cleanup in the journal if transport is down.
        let rows = service
            .state
            .lock()
            .await
            .desktops
            .values()
            .filter(|r| r.source_id.as_deref() == Some(&source))
            .map(|r| r.desktop.clone())
            .collect::<Vec<_>>();
        for row in rows {
            let _ = service.delete(p, &row.id, row.generation).await;
        }
    }
    outcome
}

pub(super) async fn authorized_request(
    host: &dyn ManagedDesktopSmokeHost,
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    purpose: AuthorizationPurpose,
    source: &str,
) -> Result<CreateManagedDesktop> {
    let quote = service.quote(p, config_id, 60).await?;
    host.approve_quote(&quote, purpose.clone()).await?;
    let authorization = service
        .authorize(p, config_id, &quote.id, purpose, Some(source.into()))
        .await?;
    Ok(CreateManagedDesktop {
        provider_config_id: config_id.into(),
        quote_id: quote.id,
        authorization_id: authorization.id,
        idempotency_key: Uuid::new_v4().to_string(),
    })
}

async fn run_steps(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    source: &str,
    mut service: ManagedDesktopService,
    provider: Arc<FailOneDelete>,
    wait: &dyn SmokeWait,
) -> Result<QualificationReceipt> {
    // Verify the release before requesting a short-lived paid quote; a large
    // digest verification can legitimately take longer than the quote TTL.
    let config = service.config(p, config_id).await?;
    provider.verify_release(&config).await?;
    let request = authorized_request(
        host,
        &service,
        p,
        config_id,
        AuthorizationPurpose::PrepareTemplate,
        source,
    )
    .await?;
    let mut template = service.prepare_template(p, request).await?;
    for _ in 0..180 {
        if template.state == TemplateState::Ready {
            break;
        }
        if matches!(
            template.state,
            TemplateState::Failed | TemplateState::Unknown
        ) {
            return Err(refused("managed_desktop_template_not_ready"));
        }
        wait.wait(Duration::from_secs(5)).await;
        template = service.refresh_template(&template.id).await?;
    }
    let identity = template
        .identity
        .filter(|_| template.state == TemplateState::Ready)
        .ok_or_else(|| refused("managed_desktop_template_not_ready"))?;
    let request = authorized_request(
        host,
        &service,
        p,
        config_id,
        AuthorizationPurpose::Smoke,
        source,
    )
    .await?;
    let first = service.create_smoke(p, request).await?;
    let first = wait_ready(&service, p, first, wait).await?;
    let first_record = service.scoped(p, &first.id, first.generation).await?;
    let endpoint = service.secrets.desktop(&first.id).await?;
    provider
        .verify_smoke_egress(&first_record, &endpoint)
        .await?;
    let key = service.secrets.provider_key(&first_record.config).await?;
    let resource_id = first_record
        .resource_id
        .clone()
        .ok_or_else(|| refused("managed_desktop_smoke_missing_resource"))?;
    let before = provider
        .inspect(&first_record.config, &key, &resource_id)
        .await?
        .ok_or_else(|| refused("managed_desktop_smoke_missing_resource"))?;
    if !owns(&first_record, &before)
        || !before.running
        || !before.kill_on_timeout
        || before.auto_resume
        || !before.private_ingress
        || !egress_matches(&config.egress, &before)
    {
        return Err(refused("managed_desktop_provider_policy_mismatch"));
    }
    // Service storage is actually closed and reopened, not merely cloned.
    service = reopen(host, service, provider.clone())?;
    let recovered = service.scoped(p, &first.id, first.generation).await?;
    if recovered.desktop.deadline_at != first.deadline_at
        || recovered.last_activity_at != first_record.last_activity_at
    {
        return Err(refused("managed_desktop_restart_deadline_changed"));
    }
    // No service reconcile/connect/delete runs here. Only read-only provider
    // inspection can establish native kill without a Host cleanup worker.
    let mut absent = false;
    for _ in 0..36 {
        match provider
            .inspect(&first_record.config, &key, &resource_id)
            .await?
        {
            None => {
                absent = true;
                break;
            }
            Some(resource)
                if !resource.running || resource.auto_resume || !resource.kill_on_timeout =>
            {
                return Err(refused("managed_desktop_native_expiry_not_kill"))
            }
            Some(resource) if !owns(&first_record, &resource) => {
                return Err(refused("managed_desktop_provider_identity_mismatch"))
            }
            Some(_) => {}
        }
        wait.wait(Duration::from_secs(5)).await;
    }
    if !absent
        || service.now().await
            < before
                .deadline_at
                .ok_or_else(|| refused("managed_desktop_provider_policy_mismatch"))?
    {
        return Err(refused("managed_desktop_native_expiry_unproven"));
    }
    service.reconcile().await?;
    if service.scoped(p, &first.id, 1).await?.desktop.state != ManagedDesktopState::Destroyed {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    // A deliberate one-shot transport fault proves journal/retry behavior;
    // the subsequent deletion is sent to the real provider and GET-verified.
    let request = authorized_request(
        host,
        &service,
        p,
        config_id,
        AuthorizationPurpose::Smoke,
        source,
    )
    .await?;
    let second = service.create_smoke(p, request).await?;
    let second = wait_ready(&service, p, second, wait).await?;
    provider.fail.store(true, Ordering::SeqCst);
    let pending = service.delete(p, &second.id, second.generation).await?;
    if pending.state != ManagedDesktopState::DestroyRetrying || pending.cleanup_attempts != 1 {
        return Err(refused("managed_desktop_delete_retry_unproven"));
    }
    service = reopen(host, service, provider.clone())?;
    let pending = service.scoped(p, &second.id, second.generation).await?;
    if pending.desktop.state != ManagedDesktopState::DestroyRetrying || !pending.delete_requested {
        return Err(refused("managed_desktop_delete_retry_unproven"));
    }
    // Before retry due time, reconciliation must retain the resource/slot.
    service.reconcile().await?;
    if service.scoped(p, &second.id, 1).await?.desktop.state == ManagedDesktopState::Destroyed {
        return Err(refused("managed_desktop_delete_retry_unproven"));
    }
    for _ in 0..24 {
        wait.wait(Duration::from_secs(5)).await;
        service.reconcile().await?;
        if service.scoped(p, &second.id, 1).await?.desktop.state == ManagedDesktopState::Destroyed {
            break;
        }
    }
    if service.scoped(p, &second.id, 1).await?.desktop.state != ManagedDesktopState::Destroyed {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    let receipt = QualificationReceipt {
        binding_digest: config.binding_digest(),
        template: identity,
        observed_at: service.now().await,
        smoke_desktop_ids: vec![first.id, second.id],
        native_expiry_killed: true,
        no_auto_resume: true,
        ingress_denied: true,
        guest_auth_denied: true,
        decoded_frame_verified: true,
        protocol_verified: true,
        restart_deadline_verified: true,
        delete_retry_verified: true,
        private_egress_probe_no_response: true,
        egress_policy_verified: true,
    };
    service
        .record_qualification(p, config_id, receipt.clone())
        .await?;
    Ok(receipt)
}

pub(super) async fn wait_ready(
    service: &ManagedDesktopService,
    p: &ManagedDesktopPrincipal,
    mut desktop: ManagedDesktop,
    wait: &dyn SmokeWait,
) -> Result<ManagedDesktop> {
    for _ in 0..12 {
        if desktop.state == ManagedDesktopState::Running {
            return Ok(desktop);
        }
        if desktop.state != ManagedDesktopState::Creating {
            return Err(refused("managed_desktop_smoke_not_ready"));
        }
        wait.wait(Duration::from_secs(2)).await;
        desktop = service.connect(p, &desktop.id, desktop.generation).await?;
    }
    Err(refused("managed_desktop_smoke_not_ready"))
}

fn reopen(
    host: &dyn ManagedDesktopSmokeHost,
    service: ManagedDesktopService,
    provider: Arc<FailOneDelete>,
) -> Result<ManagedDesktopService> {
    drop(service);
    host.open(provider)
}

struct FailOneDelete {
    inner: Arc<dyn ManagedDesktopProvider>,
    fail: AtomicBool,
}
#[async_trait]
impl ManagedDesktopProvider for FailOneDelete {
    async fn verify_release(&self, c: &ManagedDesktopConfig) -> Result<()> {
        self.inner.verify_release(c).await
    }
    async fn verify_smoke_egress(&self, r: &DesktopRecord, s: &DesktopSecrets) -> Result<()> {
        self.inner.verify_smoke_egress(r, s).await
    }
    async fn register_template(
        &self,
        c: &ManagedDesktopConfig,
        k: &ProviderSecret,
        n: &str,
        admission: LifecycleAdmission,
    ) -> Result<TemplateIdentity> {
        self.inner.register_template(c, k, n, admission).await
    }
    async fn start_template(
        &self,
        c: &ManagedDesktopConfig,
        k: &ProviderSecret,
        i: &TemplateIdentity,
        admission: LifecycleAdmission,
    ) -> Result<()> {
        self.inner.start_template(c, k, i, admission).await
    }
    async fn template_status(
        &self,
        c: &ManagedDesktopConfig,
        k: &ProviderSecret,
        i: &TemplateIdentity,
    ) -> Result<TemplateState> {
        self.inner.template_status(c, k, i).await
    }
    async fn create(
        &self,
        r: &DesktopRecord,
        k: &ProviderSecret,
        s: &DesktopSecrets,
        n: u64,
        admission: LifecycleAdmission,
    ) -> Result<CreatedDesktop> {
        self.inner.create(r, k, s, n, admission).await
    }
    async fn inspect(
        &self,
        c: &ManagedDesktopConfig,
        k: &ProviderSecret,
        id: &str,
    ) -> Result<Option<ProviderDesktop>> {
        self.inner.inspect(c, k, id).await
    }
    async fn list(
        &self,
        c: &ManagedDesktopConfig,
        k: &ProviderSecret,
        m: &BTreeMap<String, String>,
    ) -> Result<Vec<ProviderDesktop>> {
        self.inner.list(c, k, m).await
    }
    async fn delete(&self, c: &ManagedDesktopConfig, k: &ProviderSecret, id: &str) -> Result<()> {
        if self.fail.swap(false, Ordering::SeqCst) {
            Err(retryable("managed_desktop_smoke_injected_delete_timeout"))
        } else {
            self.inner.delete(c, k, id).await
        }
    }
    async fn bootstrap(&self, r: &DesktopRecord, s: &DesktopSecrets) -> Result<()> {
        self.inner.bootstrap(r, s).await
    }
    async fn health(&self, r: &DesktopRecord, s: &DesktopSecrets) -> Result<()> {
        self.inner.health(r, s).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paid_authorization_requires_the_exact_operator_flag() {
        assert!(
            ExplicitPaidSmokeAuthorization::from_operator_flag("--authorize-paid-smoke").is_ok()
        );
        for flag in ["", "true", "--smoke", "--authorize-paid-smoke=false"] {
            assert!(ExplicitPaidSmokeAuthorization::from_operator_flag(flag).is_err());
        }
    }
}
