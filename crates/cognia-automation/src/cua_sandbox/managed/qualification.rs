//! Native P4 composition. Every fact is collected by a fixed runner and bound
//! to the same Host journal; no RPC accepts a qualification receipt.
use super::*;
use crate::cua_sandbox::managed::handoff::{self, InstalledHandoff, PreparedHandoff};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn invalid() -> ManagedDesktopError {
    refused("managed_desktop_qualification_invalid")
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn destroyed_binding(
    s: &ManagedDesktopJournal,
    binding: &HostBoundaryBinding,
    digest: &str,
    template: &TemplateIdentity,
) -> bool {
    s.desktops.get(&binding.desktop_id).is_some_and(|row| {
        row.smoke
            && row.desktop.state == ManagedDesktopState::Destroyed
            && row.config.binding_digest() == digest
            && row.template == *template
            && binding.matches_record(row)
            && s.workload_boundaries
                .get(&binding.desktop_id)
                .is_some_and(|pinned| pinned.same_generation(binding))
    })
}
fn handoff_valid(
    s: &ManagedDesktopJournal,
    record: &NativeHandoffDiagnostic,
    digest: &str,
    template: &TemplateIdentity,
) -> bool {
    record.evidence_version == 1
        && matches!(record.mode.as_str(), "commit" | "bundle")
        && uuid::Uuid::parse_str(&record.operation_id)
            .is_ok_and(|id| id.to_string() == record.operation_id)
        && digest_valid(&record.receipt_sha256)
        && digest_valid(&record.source_tree_sha256)
        && destroyed_binding(s, &record.boundary, digest, template)
        && s.desktops
            .get(&record.boundary.desktop_id)
            .is_some_and(|row| {
                row.source_id.as_deref()
                    == Some(format!("handoff:{}", record.operation_id).as_str())
            })
}
/// Re-derive the complete workload projection from native records every time
/// qualification is queried. Hash-looking strings alone are never authority.
pub(super) fn derive_evidence(
    s: &ManagedDesktopJournal,
    digest: &str,
    template: &TemplateIdentity,
) -> Option<WorkloadQualificationEvidence> {
    let control = s.control_qualifications.get(digest)?;
    if !control.has_complete_evidence()
        || control.binding_digest != digest
        || control.template != *template
        || !s
            .desktops
            .get(&control.smoke_desktop_id)
            .is_some_and(|row| {
                row.smoke
                    && row.desktop.state == ManagedDesktopState::Destroyed
                    && row.desktop.generation == control.smoke_desktop_generation
                    && row.config.binding_digest() == digest
                    && row.template == *template
            })
    {
        return None;
    }
    let workload = s.workload_diagnostics.get(digest)?;
    if workload.report.validate().is_err()
        || !workload
            .boundary
            .observation
            .same_boundary(&workload.report.desktop)
        || !destroyed_binding(s, &workload.boundary, digest, template)
    {
        return None;
    }
    let authority = s.authority_diagnostics.get(digest)?;
    if !authority.evidence.has_complete_evidence()
        || authority.evidence.smoke_desktop_id != authority.boundary.desktop_id
        || authority.evidence.smoke_desktop_generation != authority.boundary.desktop_generation
        || !destroyed_binding(s, &authority.boundary, digest, template)
    {
        return None;
    }
    let commit = s
        .handoff_diagnostics
        .values()
        .filter(|r| r.mode == "commit" && handoff_valid(s, r, digest, template))
        .max_by_key(|r| r.recorded_at)?;
    let bundle = s
        .handoff_diagnostics
        .values()
        .filter(|r| r.mode == "bundle" && handoff_valid(s, r, digest, template))
        .max_by_key(|r| r.recorded_at)?;
    if commit.operation_id == bundle.operation_id
        || commit.receipt_sha256 == bundle.receipt_sha256
        || commit.source_tree_sha256 != bundle.source_tree_sha256
    {
        return None;
    }
    let boundaries = vec![
        commit.boundary.clone(),
        bundle.boundary.clone(),
        workload.boundary.clone(),
        authority.boundary.clone(),
    ];
    if boundaries
        .iter()
        .map(|b| &b.desktop_id)
        .collect::<BTreeSet<_>>()
        .len()
        != 4
        || boundaries
            .iter()
            .any(|b| b.desktop_id == control.smoke_desktop_id)
    {
        return None;
    }
    Some(WorkloadQualificationEvidence {
        workload_isolation_revision: 1,
        enforcement: "provider-and-guest-kernel".into(),
        boundaries,
        launch_paths_verified: vec!["desktop".into(), "importer".into(), "acceptance".into()],
        workload_egress_verified: true,
        escape_resistance_verified: true,
        native_handoff_receipt_sha256: vec![
            commit.receipt_sha256.clone(),
            bundle.receipt_sha256.clone(),
        ],
    })
}

impl ManagedDesktopService {
    /// A newly authorized diagnostic supersedes prior evidence even if it
    /// subsequently fails. Keep independent categories and cleanup history.
    pub async fn invalidate_native_qualification(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        kind: NativeQualificationKind,
    ) -> Result<()> {
        p.require_admin()?;
        let digest = self.config(p, config_id).await?.binding_digest();
        self.transaction(move |s, _| {
            s.qualifications.remove(&digest);
            match kind {
                NativeQualificationKind::Lifecycle => { s.lifecycle_diagnostics.remove(&digest); }
                NativeQualificationKind::Control => { s.control_qualifications.remove(&digest); }
                NativeQualificationKind::Authority => { s.authority_diagnostics.remove(&digest); }
                NativeQualificationKind::Workload => { s.workload_diagnostics.remove(&digest); }
                NativeQualificationKind::Commit | NativeQualificationKind::Bundle => {
                    let mode = if matches!(kind, NativeQualificationKind::Commit) { "commit" } else { "bundle" };
                    s.handoff_diagnostics.retain(|_, record| {
                        record.mode != mode || record.boundary.binding_digest != digest
                    });
                }
            }
            Ok(())
        }).await
    }

    /// Called after native install, journal reopen and private checkpoint. This
    /// method accepts no file/path or success flags and revalidates live identity.
    pub async fn record_native_handoff_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        desktop: &ManagedDesktop,
        prepared: &PreparedHandoff,
        installed: &InstalledHandoff,
    ) -> Result<()> {
        p.require_admin()?;
        let mode = prepared.mode();
        prepared.validate_installed(installed, &installed.operation_id).map_err(|_| invalid())?;
        let row = self.scoped(p, &desktop.id, desktop.generation).await?;
        if !row.smoke
            || row.source_id.as_deref()
                != Some(format!("handoff:{}", installed.operation_id).as_str())
            || row.desktop.state != ManagedDesktopState::Running
            || row.expired(self.now().await)
            || installed.receipt_version != 3
            || !installed.launched
        {
            return Err(invalid());
        }
        let boundary = self.validate_live_boundary(p, desktop).await?;
        handoff::validate_installed_boundary(installed, &boundary.observation)
            .map_err(|_| invalid())?;
        let record = NativeHandoffDiagnostic {
            evidence_version: 1,
            mode: mode.into(),
            operation_id: installed.operation_id.clone(),
            boundary,
            receipt_sha256: hex::encode(Sha256::digest(
                serde_json::to_vec(installed).map_err(|_| invalid())?,
            )),
            source_tree_sha256: installed.source_tree_sha256.clone(),
            recorded_at: self.now().await,
        };
        self.transaction(move |s, _| {
            s.handoff_diagnostics
                .insert(record.operation_id.clone(), record);
            Ok(())
        })
        .await
    }
    /// The actual Host-authority runner returns this evidence only after real
    /// native assertions and deletion. It is not an IPC or RPC operation.
    pub async fn record_authority_qualification_smoke(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        evidence: HostAuthoritySmokeEvidence,
        _permit: ExplicitPaidSmokeAuthorization,
    ) -> Result<()> {
        p.require_admin()?;
        let config = self.config(p, config_id).await?;
        self.admission(&config, self.now().await)?;
        let digest = config.binding_digest();
        self.transaction(move |s, now| {
            let boundary = s
                .workload_boundaries
                .get(&evidence.smoke_desktop_id)
                .cloned()
                .ok_or_else(invalid)?;
            if !evidence.has_complete_evidence()
                || evidence.smoke_desktop_generation != boundary.desktop_generation
                || evidence.observed_at > now
                || now.saturating_sub(evidence.observed_at) > QUOTE_TTL_MS
                || !destroyed_binding(s, &boundary, &digest, &boundary.template)
            {
                return Err(invalid());
            }
            s.authority_diagnostics.insert(
                digest,
                NativeAuthorityDiagnostic {
                    boundary,
                    evidence,
                    recorded_at: now,
                },
            );
            Ok(())
        })
        .await
    }
    /// Recompose from this Host's persisted native evidence. No caller can
    /// supply booleans, receipt paths or a prior image's diagnostics.
    pub async fn complete_native_qualification(
        &self,
        p: &ManagedDesktopPrincipal,
        config_id: &str,
        _permit: ExplicitPaidSmokeAuthorization,
    ) -> Result<QualificationReceipt> {
        p.require_admin()?;
        let config = self.config(p, config_id).await?;
        self.admission(&config, self.now().await)?;
        let digest = config.binding_digest();
        self.transaction(move |s, now| {
            let template = latest_template(s, &digest)
                .filter(|t| t.state == TemplateState::Ready)
                .and_then(|t| t.identity.clone())
                .ok_or_else(invalid)?;
            let mut receipt = s
                .lifecycle_diagnostics
                .get(&digest)
                .cloned()
                .ok_or_else(invalid)?;
            if !lifecycle_receipt_valid(s, &receipt, &digest, &template) {
                return Err(invalid());
            }
            receipt.workload_evidence =
                Some(derive_evidence(s, &digest, &template).ok_or_else(invalid)?);
            receipt.observed_at = now;
            s.qualifications.insert(digest, receipt.clone());
            Ok(receipt)
        })
        .await
    }
}

/// A new paid desktop is explicitly quoted because the destructive probe kills
/// its supervisor. Existing application desktops are never diagnostic targets.
pub async fn run_workload_qualification_smoke(
    host: &dyn ManagedDesktopSmokeHost,
    p: &ManagedDesktopPrincipal,
    config_id: &str,
    _permit: ExplicitPaidSmokeAuthorization,
) -> Result<NativeWorkloadDiagnostic> {
    p.require_admin()?;
    let service = host.open(host.provider())?;
    let config = service.config(p, config_id).await?;
    let digest = config.binding_digest();
    {
        let state = service.state.lock().await;
        let identity = latest_template(&state, &digest)
            .and_then(|t| t.identity.as_ref())
            .ok_or_else(invalid)?;
        if !lifecycle_diagnostic_valid(&state, &digest, identity) {
            return Err(invalid());
        }
    }
    let source = format!("workload-smoke:{}", Uuid::new_v4());
    let quote = service.quote(p, config_id, 240).await?;
    host.approve_quote(&quote, AuthorizationPurpose::Smoke)
        .await?;
    let auth = service
        .authorize(
            p,
            config_id,
            &quote.id,
            AuthorizationPurpose::Smoke,
            Some(source.clone()),
        )
        .await?;
    let request = CreateManagedDesktop {
        provider_config_id: config_id.into(),
        quote_id: quote.id,
        authorization_id: auth.id,
        idempotency_key: Uuid::new_v4().to_string(),
    };
    service.invalidate_native_qualification(p, config_id, NativeQualificationKind::Workload).await?;
    let outcome = async {
        let desktop = service.create_smoke(p, request).await?;
        let desktop = smoke::wait_ready(&service, p, desktop, &smoke::RealWait).await?;
        let boundary = service.validate_live_boundary(p, &desktop).await?;
        let row = service.scoped(p, &desktop.id, desktop.generation).await?;
        let secrets = service.secrets.desktop(&desktop.id).await?;
        let report = service.provider.qualify_workload(&row, &secrets).await?;
        report.validate().map_err(refused)?;
        if !boundary.observation.same_boundary(&report.desktop) {
            return Err(invalid());
        }
        Ok(NativeWorkloadDiagnostic {
            boundary,
            report,
            recorded_at: service.now().await,
        })
    }
    .await;
    let rows = service
        .state
        .lock()
        .await
        .desktops
        .values()
        .filter(|r| r.source_id.as_deref() == Some(source.as_str()))
        .map(|r| r.desktop.clone())
        .collect::<Vec<_>>();
    let mut cleaned = true;
    for row in rows {
        if !service
            .delete(p, &row.id, row.generation)
            .await
            .is_ok_and(|r| r.state == ManagedDesktopState::Destroyed)
        {
            cleaned = false;
        }
    }
    if !cleaned {
        return Err(refused("managed_desktop_smoke_cleanup_pending"));
    }
    let record: NativeWorkloadDiagnostic = outcome?;
    let saved = record.clone();
    service
        .transaction(move |s, _| {
            if !destroyed_binding(s, &saved.boundary, &digest, &saved.boundary.template) {
                return Err(invalid());
            }
            s.workload_diagnostics.insert(digest, saved);
            Ok(())
        })
        .await?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn authorized_retry_durably_removes_old_category_and_composed_receipt() {
        let f = super::super::tests::Fixture::new();
        f.prepare().await;
        let digest = f.config.binding_digest();
        let key = digest.clone();
        f.service.transaction(move |s, _| {
            let template = latest_template(s, &key).unwrap().identity.clone().unwrap();
            let receipt = QualificationReceipt {
                evidence_version: 2, workload_evidence: None, provider_root_observation: None,
                binding_digest: key.clone(), template: template.clone(), observed_at: 1,
                smoke_desktop_ids: vec![], native_expiry_killed: true, no_auto_resume: true,
                ingress_denied: true, guest_auth_denied: true, decoded_frame_verified: true,
                protocol_verified: true, restart_deadline_verified: true,
                delete_retry_verified: true, private_egress_probe_no_response: false,
                egress_policy_verified: true,
            };
            s.lifecycle_diagnostics.insert(key.clone(), receipt.clone());
            s.qualifications.insert(key.clone(), receipt);
            s.control_qualifications.insert(key.clone(), control::ControlQualificationReceipt {
                binding_digest: key, template, smoke_desktop_id: "old".into(),
                smoke_desktop_generation: 1, observed_at: 1, protocol_revision: 1,
                evidence_version: 2, assertions: Default::default(),
            });
            Ok(())
        }).await.unwrap();
        let mut agent = f.p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert!(f.service.invalidate_native_qualification(&agent, "e2b", NativeQualificationKind::Control).await.is_err());
        assert!(f.service.state.lock().await.qualifications.contains_key(&digest));
        f.service.invalidate_native_qualification(&f.p, "e2b", NativeQualificationKind::Control).await.unwrap();
        let state = f.service.state.lock().await;
        assert!(!state.qualifications.contains_key(&digest));
        assert!(!state.control_qualifications.contains_key(&digest));
        assert!(state.lifecycle_diagnostics.contains_key(&digest));
        assert!(derive_evidence(&state, &digest, &state.lifecycle_diagnostics[&digest].template).is_none());
        drop(state);
        f.service.invalidate_native_qualification(&f.p, "e2b", NativeQualificationKind::Lifecycle).await.unwrap();
        assert!(!f.service.state.lock().await.lifecycle_diagnostics.contains_key(&digest));
    }

    #[test]
    fn missing_native_records_cannot_qualify_from_hashes_or_labels() {
        let state = ManagedDesktopJournal::default();
        let template = TemplateIdentity {
            template_id: "t".into(),
            build_id: "b".into(),
            image_digest: "sha256:x".into(),
            recipe_revision: "7".into(),
            protocol: "p".into(),
        };
        assert!(derive_evidence(&state, "binding", &template).is_none());
        for value in ["", "A", &"A".repeat(64), &"g".repeat(64)] {
            assert!(!digest_valid(value));
        }
        assert!(digest_valid(&"a".repeat(64)));
    }
    #[tokio::test]
    async fn completion_requires_collected_native_evidence_and_admin() {
        let f = super::super::tests::Fixture::new();
        let permit = || {
            ExplicitPaidSmokeAuthorization::from_operator_flag("--authorize-paid-smoke").unwrap()
        };
        assert!(f
            .service
            .complete_native_qualification(&f.p, "e2b", permit())
            .await
            .is_err());
        let mut agent = f.p.clone();
        agent.authority = ManagedDesktopAuthority::Agent;
        assert_eq!(
            f.service
                .complete_native_qualification(&agent, "e2b", permit())
                .await
                .unwrap_err()
                .code,
            "managed_desktop_admin_required"
        );
    }
}
