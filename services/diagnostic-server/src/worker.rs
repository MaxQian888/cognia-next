use std::{sync::Arc, time::Duration};

use anyhow::Context;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::{
    db::{AcceptProcessing, DiagnosticRepository, IncidentRecord},
    fingerprint_incident,
    model::ProcessingState,
    privacy::PrivacyGate,
    processing::{
        compatible_build_family, extract_event_frames, ProcessingFailure, StackwalkSymbolicator,
        SymbolArtifact,
    },
    storage::ArtifactStore,
};

#[derive(Clone)]
pub struct DiagnosticProcessor {
    repository: DiagnosticRepository,
    artifacts: ArtifactStore,
    privacy: PrivacyGate,
    symbolicator: Arc<StackwalkSymbolicator>,
    interval: Duration,
    batch_size: usize,
}

impl DiagnosticProcessor {
    pub fn new(
        repository: DiagnosticRepository,
        artifacts: ArtifactStore,
        privacy: PrivacyGate,
        symbolicator: StackwalkSymbolicator,
        interval: Duration,
        batch_size: usize,
    ) -> Self {
        Self {
            repository,
            artifacts,
            privacy,
            symbolicator: Arc::new(symbolicator),
            interval,
            batch_size,
        }
    }

    pub async fn run(self, mut shutdown: watch::Receiver<bool>) {
        loop {
            if *shutdown.borrow() {
                break;
            }
            match self.drain_due().await {
                Ok(processed) if processed > 0 => {
                    tracing::debug!(processed, "processed diagnostic incidents")
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::error!(error = %error, "diagnostic processor iteration failed")
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(self.interval) => {},
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
    }

    pub async fn drain_due(&self) -> anyhow::Result<usize> {
        let tenants = self.repository.tenant_ids().await?;
        let mut processed = 0;
        while processed < self.batch_size {
            let mut claimed_in_round = false;
            for tenant_id in &tenants {
                if processed >= self.batch_size {
                    break;
                }
                let Some(incident) = self.repository.claim_next_processing(*tenant_id).await?
                else {
                    continue;
                };
                claimed_in_round = true;
                processed += 1;
                self.process_claimed(incident).await?;
            }
            if !claimed_in_round {
                break;
            }
        }
        Ok(processed)
    }

    async fn process_claimed(&self, incident: IncidentRecord) -> anyhow::Result<()> {
        match self.assemble_processing_result(&incident).await {
            Ok(accepted) => self.repository.accept_processing(&incident, accepted).await,
            Err(failure) => {
                tracing::warn!(
                    incident_id = %incident.id,
                    failure_code = failure.code(),
                    retryable = failure.retryable(),
                    "diagnostic incident processing failed"
                );
                self.repository.fail_processing(&incident, failure).await
            }
        }
    }

    async fn assemble_processing_result(
        &self,
        incident: &IncidentRecord,
    ) -> Result<AcceptProcessing, ProcessingFailure> {
        let parts = self
            .repository
            .parts(incident.tenant_id, incident.id)
            .await
            .map_err(|_| ProcessingFailure::DatabaseUnavailable)?;
        if parts.is_empty() {
            return Err(ProcessingFailure::InvalidArtifact);
        }

        let mut structured_frames = Vec::new();
        let mut minidump = None;
        for part in &parts {
            let bytes = self
                .artifacts
                .get(incident.tenant_id, &part.object_key)
                .await
                .map_err(|_| ProcessingFailure::StorageUnavailable)?;
            if hex::encode(Sha256::digest(&bytes)) != part.stored_sha256 {
                return Err(ProcessingFailure::InvalidArtifact);
            }
            let scan = self.privacy.scan(&bytes);
            if scan.rejected_credential_kind.is_some() {
                self.artifacts
                    .delete(&part.object_key)
                    .await
                    .map_err(|_| ProcessingFailure::StorageUnavailable)?;
                self.repository
                    .reject_part(
                        incident.tenant_id,
                        incident.id,
                        part.part_number,
                        "credential_detected",
                    )
                    .await
                    .map_err(|_| ProcessingFailure::DatabaseUnavailable)?;
                return Err(ProcessingFailure::CredentialDetected);
            }
            match part.artifact_kind.as_str() {
                "minidump" if minidump.is_none() => minidump = Some(scan.sanitized),
                "manifest" | "events" | "attachment" => {
                    structured_frames.extend(extract_event_frames(&scan.sanitized)?);
                }
                _ => {}
            }
        }
        structured_frames.truncate(64);

        let (raw_stack, symbolized_stack, missing_symbols) = if let Some(minidump) = minidump {
            self.repository
                .set_processing_state(
                    incident.tenant_id,
                    incident.id,
                    ProcessingState::Symbolicating,
                )
                .await
                .map_err(|_| ProcessingFailure::DatabaseUnavailable)?;
            let raw = self
                .symbolicator
                .symbolize(incident.id, &minidump, &[])
                .await?;
            let symbol_records = self
                .repository
                .symbols_for_build(
                    incident.tenant_id,
                    incident.project_id,
                    &incident.build_id,
                    &incident.platform,
                )
                .await
                .map_err(|_| ProcessingFailure::DatabaseUnavailable)?;
            let mut symbols = Vec::new();
            for symbol in symbol_records.into_iter().filter(|symbol| {
                symbol.symbol_type == "breakpad" && !symbol.relative_path.is_empty()
            }) {
                let bytes = self
                    .artifacts
                    .get(incident.tenant_id, &symbol.object_key)
                    .await
                    .map_err(|_| ProcessingFailure::StorageUnavailable)?;
                symbols.push(SymbolArtifact {
                    relative_path: symbol.relative_path,
                    bytes,
                });
            }
            if symbols.is_empty() {
                (raw.frames.clone(), raw.frames, raw.missing_symbols)
            } else {
                let symbolized = self
                    .symbolicator
                    .symbolize(incident.id, &minidump, &symbols)
                    .await?;
                (raw.frames, symbolized.frames, symbolized.missing_symbols)
            }
        } else {
            (structured_frames.clone(), structured_frames, Vec::new())
        };

        self.repository
            .set_processing_state(incident.tenant_id, incident.id, ProcessingState::Grouping)
            .await
            .map_err(|_| ProcessingFailure::DatabaseUnavailable)?;
        let build_family = compatible_build_family(&incident.build_id);
        let fingerprint = fingerprint_incident(
            &incident.platform,
            &incident.exception,
            &build_family,
            &incident.module,
            &symbolized_stack,
        );
        let grouping_basis = grouping_basis(incident, &build_family, &symbolized_stack);
        Ok(AcceptProcessing {
            fingerprint,
            compatible_build_family: build_family,
            grouping_basis,
            raw_stack,
            symbolized_stack,
            missing_symbols,
        })
    }
}

fn grouping_basis(
    incident: &IncidentRecord,
    compatible_build_family: &str,
    symbolized_stack: &[String],
) -> serde_json::Value {
    serde_json::json!({
        "fingerprintVersion": "fingerprint-v1",
        "platform": incident.platform,
        "exception": incident.exception,
        "compatibleBuildFamily": compatible_build_family,
        "module": incident.module,
        "topFrames": symbolized_stack.iter().take(5).collect::<Vec<_>>(),
    })
}

pub fn build_processor(
    repository: DiagnosticRepository,
    artifacts: ArtifactStore,
    privacy: PrivacyGate,
    config: &crate::config::ServerConfig,
) -> anyhow::Result<DiagnosticProcessor> {
    std::fs::create_dir_all(&config.processing_temp_dir)
        .context("create diagnostic processing temp directory")?;
    Ok(DiagnosticProcessor::new(
        repository,
        artifacts,
        privacy,
        StackwalkSymbolicator::new(
            config.minidump_stackwalk_path.clone(),
            config.processing_temp_dir.clone(),
            config.minidump_stackwalk_timeout,
        ),
        config.processing_interval,
        config.processing_batch_size,
    ))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::model::{IncidentState, ProcessingState};

    fn incident() -> IncidentRecord {
        IncidentRecord {
            id: Uuid::nil(),
            tenant_id: Uuid::nil(),
            project_id: Uuid::nil(),
            installation_id: "install".to_owned(),
            artifact_hash: "a".repeat(64),
            build_id: "1.2.3+abc".to_owned(),
            platform: "windows".to_owned(),
            module: "renderer".to_owned(),
            exception: "access_violation".to_owned(),
            client_state: IncidentState::Processing,
            processing_state: ProcessingState::Grouping,
            support_code: "SUPPORT".to_owned(),
            fingerprint: None,
            processing_attempts: 1,
            next_processing_at: Utc::now(),
            failure_code: None,
            grouping_basis: None,
            raw_stack: serde_json::json!([]),
            symbolized_stack: serde_json::json!([]),
            missing_symbols: Vec::new(),
            group_id: None,
            accepted_at: None,
            consent_withdrawn_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn grouping_basis_is_explainable_and_uses_only_top_five_frames() {
        let frames = (0..8)
            .map(|index| format!("frame-{index}"))
            .collect::<Vec<_>>();
        let basis = grouping_basis(&incident(), "1.2.3", &frames);
        assert_eq!(basis["fingerprintVersion"], "fingerprint-v1");
        assert_eq!(basis["compatibleBuildFamily"], "1.2.3");
        assert_eq!(basis["topFrames"].as_array().unwrap().len(), 5);
    }
}
