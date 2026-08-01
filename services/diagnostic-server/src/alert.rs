use std::{sync::Arc, time::Duration};

use anyhow::Context;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use lettre::{
    message::header::ContentType, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use reqwest::Url;
use sha2::Sha256;
use tokio::sync::watch;

use crate::{
    config::ServerConfig,
    db::{AlertDeliveryRecord, DiagnosticRepository},
};

const MAX_ALERT_ATTEMPTS: i32 = 10;

impl AlertDeliveryRecord {
    fn webhook_payload(&self) -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "deliveryId": self.id,
            "tenantId": self.tenant_id,
            "projectId": self.project_id,
            "incidentId": self.incident_id,
            "groupId": self.group_id,
            "kind": self.alert_kind,
            "payload": self.payload,
        })
    }

    fn email_body(&self) -> String {
        format!(
            "Diagnostic alert: {}\nProject: {}\nIncident: {}\nGroup: {}\nDetails: {}\n",
            self.alert_kind,
            self.project_id,
            self.incident_id
                .map_or_else(|| "n/a".to_owned(), |id| id.to_string()),
            self.group_id
                .map_or_else(|| "n/a".to_owned(), |id| id.to_string()),
            self.payload
        )
    }
}

#[derive(Clone)]
pub struct AlertDispatcher {
    http: reqwest::Client,
    webhook_url: Option<Url>,
    webhook_secret: Option<Arc<[u8]>>,
    smtp_url: Option<String>,
    smtp_from: Option<String>,
    smtp_to: Option<String>,
}

impl AlertDispatcher {
    pub fn from_config(config: &ServerConfig) -> anyhow::Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(config.alert_timeout)
                .build()
                .context("build alert HTTP client")?,
            webhook_url: config.alert_webhook_url.clone(),
            webhook_secret: config
                .alert_webhook_secret
                .as_deref()
                .map(|value| Arc::<[u8]>::from(value.as_bytes())),
            smtp_url: config.alert_smtp_url.clone(),
            smtp_from: config.alert_smtp_from.clone(),
            smtp_to: config.alert_smtp_to.clone(),
        })
    }

    pub async fn deliver(&self, delivery: &AlertDeliveryRecord) -> Result<(), AlertError> {
        match delivery.transport.as_str() {
            "webhook" => self.deliver_webhook(delivery).await,
            "smtp" => self.deliver_smtp(delivery).await,
            "otel" => {
                tracing::warn!(
                    event_name = "cognia.diagnostics.alert",
                    tenant_id = %delivery.tenant_id,
                    project_id = %delivery.project_id,
                    incident_id = ?delivery.incident_id,
                    group_id = ?delivery.group_id,
                    alert_kind = %delivery.alert_kind,
                    payload = %delivery.payload,
                    "diagnostic alert signal"
                );
                Ok(())
            }
            _ => Err(AlertError::permanent("alert_transport_unknown")),
        }
    }

    async fn deliver_webhook(&self, delivery: &AlertDeliveryRecord) -> Result<(), AlertError> {
        let url = self
            .webhook_url
            .as_ref()
            .ok_or_else(|| AlertError::permanent("webhook_not_configured"))?;
        let body = serde_json::to_vec(&delivery.webhook_payload())
            .map_err(|_| AlertError::permanent("webhook_payload_invalid"))?;
        let mut request = self
            .http
            .post(url.clone())
            .header("content-type", "application/json")
            .header("idempotency-key", delivery.id.to_string());
        if let Some(secret) = &self.webhook_secret {
            let signature = webhook_signature(secret, &body);
            request = request.header("x-cognia-signature", format!("sha256={signature}"));
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(|_| AlertError::retryable("webhook_transport_failed"))?;
        if response.status().is_success() {
            Ok(())
        } else if response.status().is_server_error() || response.status().as_u16() == 429 {
            Err(AlertError::retryable("webhook_retryable_status"))
        } else {
            Err(AlertError::permanent("webhook_rejected"))
        }
    }

    async fn deliver_smtp(&self, delivery: &AlertDeliveryRecord) -> Result<(), AlertError> {
        let smtp_url = self
            .smtp_url
            .as_deref()
            .ok_or_else(|| AlertError::permanent("smtp_not_configured"))?;
        let from = self
            .smtp_from
            .as_deref()
            .ok_or_else(|| AlertError::permanent("smtp_from_missing"))?;
        let to = self
            .smtp_to
            .as_deref()
            .ok_or_else(|| AlertError::permanent("smtp_to_missing"))?;
        let email = Message::builder()
            .from(
                from.parse()
                    .map_err(|_| AlertError::permanent("smtp_from_invalid"))?,
            )
            .to(to
                .parse()
                .map_err(|_| AlertError::permanent("smtp_to_invalid"))?)
            .subject(format!("Cognia diagnostics: {}", delivery.alert_kind))
            .header(ContentType::TEXT_PLAIN)
            .body(delivery.email_body())
            .map_err(|_| AlertError::permanent("smtp_message_invalid"))?;
        let mailer = AsyncSmtpTransport::<Tokio1Executor>::from_url(smtp_url)
            .map_err(|_| AlertError::permanent("smtp_url_invalid"))?
            .build();
        mailer
            .send(email)
            .await
            .map_err(|_| AlertError::retryable("smtp_transport_failed"))?;
        Ok(())
    }
}

#[derive(Debug)]
pub struct AlertError {
    code: &'static str,
    retryable: bool,
}

impl AlertError {
    fn retryable(code: &'static str) -> Self {
        Self {
            code,
            retryable: true,
        }
    }

    fn permanent(code: &'static str) -> Self {
        Self {
            code,
            retryable: false,
        }
    }
}

#[derive(Clone)]
pub struct AlertWorker {
    repository: DiagnosticRepository,
    dispatcher: AlertDispatcher,
    interval: Duration,
    batch_size: usize,
}

impl AlertWorker {
    pub fn new(
        repository: DiagnosticRepository,
        dispatcher: AlertDispatcher,
        interval: Duration,
        batch_size: usize,
    ) -> Self {
        Self {
            repository,
            dispatcher,
            interval,
            batch_size,
        }
    }

    pub async fn run(self, mut shutdown: watch::Receiver<bool>) {
        loop {
            if *shutdown.borrow() {
                break;
            }
            if let Err(error) = self.drain_due().await {
                tracing::error!(error = %error, "diagnostic alert iteration failed");
            }
            tokio::select! {
                _ = tokio::time::sleep(self.interval) => {},
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() { break; }
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
                let Some(delivery) = self.repository.claim_next_alert(*tenant_id).await? else {
                    continue;
                };
                claimed = true;
                processed += 1;
                match self.dispatcher.deliver(&delivery).await {
                    Ok(()) => self.repository.complete_alert(&delivery).await?,
                    Err(error) => {
                        self.repository
                            .fail_alert(
                                &delivery,
                                error.code,
                                alert_retry_at(delivery.attempts),
                                error.retryable && delivery.attempts < MAX_ALERT_ATTEMPTS,
                            )
                            .await?;
                    }
                }
            }
            if !claimed {
                break;
            }
        }
        Ok(processed)
    }
}

fn webhook_signature(secret: &[u8], body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts arbitrary key sizes");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

fn alert_retry_at(attempts: i32) -> DateTime<Utc> {
    let exponent = u32::try_from(attempts.saturating_sub(1).clamp(0, 10)).unwrap_or(10);
    Utc::now() + chrono::Duration::seconds(30_i64.saturating_mul(2_i64.pow(exponent)).min(21_600))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webhook_signatures_are_stable_and_sensitive_to_content() {
        assert_eq!(
            webhook_signature(b"secret", b"payload"),
            "b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4"
        );
        assert_ne!(
            webhook_signature(b"secret", b"payload"),
            webhook_signature(b"secret", b"changed")
        );
    }

    #[test]
    fn retry_delay_is_bounded() {
        let now = Utc::now();
        assert!((alert_retry_at(1) - now).num_seconds() >= 29);
        assert!((alert_retry_at(i32::MAX) - now).num_seconds() <= 21_600);
    }
}
