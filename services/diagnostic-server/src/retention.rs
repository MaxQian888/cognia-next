use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::Value;
use tokio::sync::watch;

use crate::{
    db::{DiagnosticRepository, RetentionJobRecord},
    storage::ArtifactStore,
};

const MAX_RETENTION_DAYS: u64 = 3_650;
const MAX_ATTEMPTS: i32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetentionPolicy {
    pub minidump_days: u64,
    pub attachment_days: u64,
    pub metadata_days: u64,
    pub symbol_days: u64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            minidump_days: 14,
            attachment_days: 30,
            metadata_days: 90,
            symbol_days: 180,
        }
    }
}

impl RetentionPolicy {
    pub fn from_overrides(value: &Value) -> Self {
        let defaults = Self::default();
        Self {
            minidump_days: override_days(value, "minidumpDays", defaults.minidump_days),
            attachment_days: override_days(value, "attachmentDays", defaults.attachment_days),
            metadata_days: override_days(value, "metadataDays", defaults.metadata_days),
            symbol_days: override_days(value, "symbolDays", defaults.symbol_days),
        }
    }

    pub fn artifact_days(self, artifact_kind: &str) -> u64 {
        if artifact_kind == "minidump" {
            self.minidump_days
        } else {
            self.attachment_days
        }
    }
}

fn override_days(value: &Value, key: &str, fallback: u64) -> u64 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|days| *days <= MAX_RETENTION_DAYS)
        .unwrap_or(fallback)
}

#[derive(Clone)]
pub struct RetentionWorker {
    repository: DiagnosticRepository,
    artifacts: ArtifactStore,
    interval: Duration,
    batch_size: usize,
}

impl RetentionWorker {
    pub fn new(
        repository: DiagnosticRepository,
        artifacts: ArtifactStore,
        interval: Duration,
        batch_size: usize,
    ) -> Self {
        Self {
            repository,
            artifacts,
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
                    tracing::debug!(processed, "completed diagnostic retention jobs")
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::error!(error = %error, "diagnostic retention iteration failed")
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
            let mut claimed = false;
            for tenant_id in &tenants {
                if processed >= self.batch_size {
                    break;
                }
                let Some(job) = self.repository.claim_next_retention(*tenant_id).await? else {
                    continue;
                };
                claimed = true;
                processed += 1;
                self.process_job(job).await;
            }
            if !claimed {
                break;
            }
        }
        Ok(processed)
    }

    async fn process_job(&self, job: RetentionJobRecord) {
        let result = match job.resource_kind.as_str() {
            "incident_metadata" => self.repository.complete_retention_metadata(&job).await,
            "incident_artifact" | "symbol" => self.delete_artifact(&job).await,
            _ => Err(anyhow::anyhow!("unsupported retention resource kind")),
        };
        if let Err(error) = result {
            let retry_at = retention_retry_at(job.attempts);
            let code = if job.attempts >= MAX_ATTEMPTS {
                "retention_attempts_exhausted"
            } else {
                "retention_delete_failed"
            };
            tracing::warn!(
                job_id = %job.id,
                tenant_id = %job.tenant_id,
                error = %error,
                failure_code = code,
                "diagnostic retention job failed"
            );
            if let Err(mark_error) = self
                .repository
                .fail_retention(&job, code, retry_at, job.attempts < MAX_ATTEMPTS)
                .await
            {
                tracing::error!(job_id = %job.id, error = %mark_error, "failed to persist retention failure");
            }
        }
    }

    async fn delete_artifact(&self, job: &RetentionJobRecord) -> anyhow::Result<()> {
        let object_key = job
            .object_key
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("artifact retention job is missing an object key"))?;
        self.artifacts.delete(object_key).await?;
        self.repository.complete_retention_artifact(job).await
    }
}

fn retention_retry_at(attempts: i32) -> DateTime<Utc> {
    let exponent = u32::try_from(attempts.saturating_sub(1).clamp(0, 10)).unwrap_or(10);
    let seconds = 30_i64.saturating_mul(2_i64.pow(exponent)).min(21_600);
    Utc::now() + chrono::Duration::seconds(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_defaults_match_the_public_contract() {
        assert_eq!(
            RetentionPolicy::default(),
            RetentionPolicy {
                minidump_days: 14,
                attachment_days: 30,
                metadata_days: 90,
                symbol_days: 180,
            }
        );
    }

    #[test]
    fn valid_overrides_are_scoped_and_invalid_values_fall_back() {
        let policy = RetentionPolicy::from_overrides(&serde_json::json!({
            "minidumpDays": 7,
            "attachmentDays": -1,
            "metadataDays": 3651,
            "symbolDays": "forever"
        }));
        assert_eq!(policy.minidump_days, 7);
        assert_eq!(policy.attachment_days, 30);
        assert_eq!(policy.metadata_days, 90);
        assert_eq!(policy.symbol_days, 180);
        assert_eq!(policy.artifact_days("minidump"), 7);
        assert_eq!(policy.artifact_days("events"), 30);
    }

    #[test]
    fn retry_delay_is_bounded() {
        let now = Utc::now();
        let first = retention_retry_at(1) - now;
        let exhausted = retention_retry_at(i32::MAX) - now;
        assert!(first.num_seconds() >= 29 && first.num_seconds() <= 30);
        assert!(exhausted.num_seconds() >= 21_599 && exhausted.num_seconds() <= 21_600);
    }
}
