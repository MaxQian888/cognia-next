use crate::{AgentConfig, AgentExecutor};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cognia_deployment::agent_protocol::{
    AgentHeartbeat, AgentHello, AgentToControllerMessage, AgentTransition,
    ControllerToAgentMessage, AGENT_PROTOCOL_VERSION,
};
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ClientConfig, RootCertStore};
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};
use tracing::{info, warn};

pub struct AgentRuntime {
    config: AgentConfig,
    executor: Arc<AgentExecutor>,
    certificate_expires_at: AtomicI64,
}

impl AgentRuntime {
    pub fn new(config: AgentConfig, executor: Arc<AgentExecutor>) -> Self {
        let certificate_expires_at = AtomicI64::new(config.certificate_expires_at);
        Self {
            config,
            executor,
            certificate_expires_at,
        }
    }

    pub async fn run(&self) -> anyhow::Result<()> {
        let mut retry = Duration::from_secs(1);
        loop {
            match self.run_connection().await {
                Ok(()) => retry = Duration::from_secs(1),
                Err(error) => warn!(%error, "deploy agent connection ended"),
            }
            tokio::time::sleep(retry).await;
            retry = (retry * 2).min(Duration::from_secs(30));
        }
    }

    async fn run_connection(&self) -> anyhow::Result<()> {
        let connector = Connector::Rustls(Arc::new(load_tls_config(&self.config.tls)?));
        let (socket, _) = connect_async_tls_with_config(
            self.config.controller_url.as_str(),
            None,
            false,
            Some(connector),
        )
        .await?;
        info!(target_id = %self.config.target_id, "deploy agent connected");
        let (mut writer, mut reader) = socket.split();
        let hello = AgentToControllerMessage::Hello(AgentHello {
            api_version: AGENT_PROTOCOL_VERSION.into(),
            agent_id: self.config.agent_id.clone(),
            target_id: self.config.target_id.clone(),
            topology: self.config.topology(),
            agent_version: env!("CARGO_PKG_VERSION").into(),
            certificate_expires_at: self.certificate_expires_at.load(Ordering::Acquire),
        });
        writer
            .send(Message::Text(serde_json::to_string(&hello)?.into()))
            .await?;

        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    let heartbeat = AgentToControllerMessage::Heartbeat(AgentHeartbeat {
                        operation_id: None,
                        observed_at: now_unix_seconds(),
                    });
                    writer.send(Message::Text(serde_json::to_string(&heartbeat)?.into())).await?;
                }
                message = reader.next() => {
                    let Some(message) = message else { anyhow::bail!("controller closed connection") };
                    let message = message?;
                    if message.is_ping() {
                        writer.send(Message::Pong(message.into_data())).await?;
                        continue;
                    }
                    let Message::Text(text) = message else { continue };
                    let message: ControllerToAgentMessage = serde_json::from_str(&text)?;
                    match message {
                        ControllerToAgentMessage::Operation(operation) => {
                            let operation_id = operation.operation_id.clone();
                            let outcome = self.executor.execute(*operation, now_unix_seconds()).await;
                            let transition = AgentToControllerMessage::Transition(AgentTransition {
                                operation_id,
                                state: outcome.state,
                                result: outcome.result,
                                error_code: outcome.error_code,
                                error_message: outcome.error_message,
                            });
                            writer.send(Message::Text(serde_json::to_string(&transition)?.into())).await?;
                        }
                        ControllerToAgentMessage::Ping { nonce } => {
                            writer.send(Message::Text(serde_json::json!({ "type": "pong", "nonce": nonce }).to_string().into())).await?;
                        }
                        ControllerToAgentMessage::RotateCertificate(request) => {
                            let expires_at = self.rotate_certificate(request.enrollment_nonce).await?;
                            self.certificate_expires_at.store(expires_at, Ordering::Release);
                            anyhow::bail!("certificate rotated; reconnecting with the renewed identity")
                        }
                    }
                }
            }
        }
    }

    async fn rotate_certificate(&self, token: String) -> anyhow::Result<i64> {
        let mut controller_url = self.config.controller_url.clone();
        let enrollment_scheme = match controller_url.scheme() {
            "wss" => "https",
            "ws" => "http",
            scheme => scheme,
        }
        .to_owned();
        controller_url
            .set_scheme(&enrollment_scheme)
            .map_err(|_| anyhow::anyhow!("controller URL has an unsupported scheme"))?;
        let output_directory = self
            .config
            .tls
            .certificate_file
            .parent()
            .ok_or_else(|| anyhow::anyhow!("certificate file has no parent directory"))?
            .to_path_buf();
        let result = crate::enroll::enroll(crate::enroll::EnrollmentOptions {
            controller_url,
            token,
            agent_id: self.config.agent_id.clone(),
            output_directory,
            controller_ca_file: self.config.tls.ca_file.clone(),
        })
        .await?;
        if result.target_id != self.config.target_id {
            anyhow::bail!("renewed certificate was issued for a different target");
        }
        Ok(result.certificate_expires_at)
    }
}

pub fn decode_verifying_key(encoded: &str) -> anyhow::Result<ed25519_dalek::VerifyingKey> {
    let bytes = BASE64.decode(encoded)?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("controller signing key must contain 32 bytes"))?;
    Ok(ed25519_dalek::VerifyingKey::from_bytes(&bytes)?)
}

fn load_tls_config(config: &crate::TlsClientConfig) -> anyhow::Result<ClientConfig> {
    let certs = read_certificates(&config.certificate_file)?;
    let key = read_private_key(&config.private_key_file)?;
    let mut roots = RootCertStore::empty();
    if let Some(ca_file) = &config.ca_file {
        for certificate in read_certificates(ca_file)? {
            roots.add(certificate)?;
        }
    } else {
        let native = rustls_native_certs::load_native_certs();
        for certificate in native.certs {
            roots.add(certificate)?;
        }
    }
    Ok(ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)?)
}

fn read_certificates(path: &std::path::Path) -> anyhow::Result<Vec<CertificateDer<'static>>> {
    let mut reader = BufReader::new(File::open(path)?);
    rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn read_private_key(path: &std::path::Path) -> anyhow::Result<PrivateKeyDer<'static>> {
    let mut reader = BufReader::new(File::open(path)?);
    rustls_pemfile::private_key(&mut reader)?
        .ok_or_else(|| anyhow::anyhow!("TLS private key file contains no supported key"))
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}
