//! Native-only handoff diagnostic into a freshly authorized smoke desktop.
//! No production create/control API calls this before P4 qualification.
use super::*;
use crate::cua_sandbox::managed::handoff::{self, HandoffBudget, HandoffLaunch, InstalledHandoff, PreparedHandoff};

pub struct HandoffTransfer<'a> {
    pub prepared: &'a PreparedHandoff,
    pub operation_id: &'a str,
    pub launch: Option<&'a HandoffLaunch>,
    pub budget: &'a HandoffBudget,
    pub source_current: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl ManagedDesktopService {
    pub async fn cleanup_handoff_smoke(&self, p: &ManagedDesktopPrincipal, operation_id: &str) -> Result<()> {
        p.require_admin()?;
        let source = format!("handoff:{operation_id}");
        let rows = self.state.lock().await.desktops.values()
            .filter(|r| r.smoke && r.source_id.as_deref() == Some(source.as_str())
                && r.config.owner_principal_id == p.owner_principal_id && r.config.host_id == p.host_id)
            .map(|r| r.desktop.clone()).collect::<Vec<_>>();
        let mut pending = false;
        for row in rows {
            match self.delete(p, &row.id, row.generation).await {
                Ok(row) if row.state == ManagedDesktopState::Destroyed => {},
                _ => pending = true,
            }
        }
        if pending { Err(retryable("managed_desktop_handoff_cleanup_pending")) } else { Ok(()) }
    }

    pub async fn install_handoff_smoke(
        &self, p: &ManagedDesktopPrincipal, desktop: &ManagedDesktop,
        transfer: HandoffTransfer<'_>,
    ) -> Result<InstalledHandoff> {
        let row = self.handoff_target(p, desktop, transfer.operation_id).await?;
        self.validate_live_boundary(p, desktop).await?;
        let check = transfer.source_current.clone();
        if !tokio::task::spawn_blocking(move || check()).await.unwrap_or(false) { return Err(refused("managed_desktop_handoff_source_unavailable")); }
        let secret = self.secrets.desktop(&desktop.id).await?;
        let bootstrap = super::super::provider::bootstrap_request(&row, &secret)?;
        let bounded = HandoffBudget { deadline_at_ms: transfer.budget.deadline_at_ms.min(row.desktop.deadline_at), cancel: transfer.budget.cancel.clone() };
        self.run_handoff_transfer(p, desktop, HandoffTransfer { budget: &bounded, ..transfer }, bootstrap).await
    }

    async fn handoff_target(&self, p: &ManagedDesktopPrincipal, desktop: &ManagedDesktop, operation_id: &str) -> Result<DesktopRecord> {
        p.require_admin()?;
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        let expected_source = format!("handoff:{operation_id}");
        if !row.smoke || row.source_id.as_deref() != Some(expected_source.as_str())
            || row.desktop.state != ManagedDesktopState::Running || row.expired(self.now().await) {
            return Err(refused("managed_desktop_handoff_desktop_not_authorized"));
        }
        Ok(row)
    }

    async fn run_handoff_transfer(&self, p: &ManagedDesktopPrincipal, desktop: &ManagedDesktop, transfer: HandoffTransfer<'_>, bootstrap: cognia_e2b::envd::DesktopBootstrap) -> Result<InstalledHandoff> {
        let HandoffTransfer { prepared, operation_id, launch, budget: bounded, source_current } = transfer;
        let result = {
        let transfer = handoff::install_on_desktop(&bootstrap, prepared, operation_id, launch, bounded);
        tokio::pin!(transfer);
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        let result = loop {
            tokio::select! {
                result = &mut transfer => break result.map_err(|_| refused("managed_desktop_handoff_transfer_failed")),
                _ = tick.tick() => {
                    let check = source_current.clone();
                    let allowed = tokio::task::spawn_blocking(move || check()).await.unwrap_or(false);
                    let current = self.scoped(p, &desktop.id, desktop.generation).await;
                    if !allowed || current.is_err() || current.as_ref().is_ok_and(|r| r.delete_requested || r.expired((self.clock)())) {
                        break Err(refused("managed_desktop_handoff_source_unavailable"));
                    }
                }
            }
        };
        result
        };
        let result = match result {
            Ok(installed) => {
                let check = source_current.clone();
                if tokio::task::spawn_blocking(move || check()).await.unwrap_or(false)
                    && self.handoff_target(p, desktop, operation_id).await.is_ok() {
                    match self.validate_live_boundary(p, desktop).await {
                        Ok(binding) => handoff::validate_installed_boundary(&installed, &binding.observation)
                            .map(|()| installed).map_err(|_| refused("managed_desktop_boundary_mismatch")),
                        Err(error) => Err(error),
                    }
                }
                else { Err(refused("managed_desktop_handoff_source_unavailable")) }
            }
            Err(error) => Err(error),
        };
        // The install outcome can be unknown after transport cancellation.
        // Fence further control and persist cleanup before returning failure.
        if let Err(error) = &result { self.mark_cleanup(&desktop.id, error).await?; }
        result
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn only_the_exact_smoke_source_and_generation_can_receive_a_transfer() {
        let fixture = super::super::tests::Fixture::new();
        fixture.prepare().await;
        let desktop = fixture.smoke("handoff-test").await;
        assert!(fixture.service.handoff_target(&fixture.p, &desktop, "other").await.is_err());
        fixture.service.transaction(|state, _| {
            state.desktops.get_mut(&desktop.id).unwrap().source_id = Some("handoff:operation".into());
            Ok(())
        }).await.unwrap();
        assert!(fixture.service.handoff_target(&fixture.p, &desktop, "operation").await.is_ok());
        let mut stale = desktop.clone(); stale.generation += 1;
        assert!(fixture.service.handoff_target(&fixture.p, &stale, "operation").await.is_err());
        fixture.service.transaction(|state, _| { state.desktops.get_mut(&desktop.id).unwrap().smoke = false; Ok(()) }).await.unwrap();
        assert!(fixture.service.handoff_target(&fixture.p, &desktop, "operation").await.is_err());
    }
}
