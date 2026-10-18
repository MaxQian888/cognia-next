//! Independent Sign in with ChatGPT credentials. This module never reads,
//! imports, selects, exports, or modifies a legacy subscription account.
pub mod app_server_policy;
mod oidc;
pub mod responses;
mod store;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use oidc::{
    bounded_json, validate_endpoint, Discovery, Endpoints, TokenResponse, RESOURCE, SCOPES,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use store::{Envelope, Registration, Store};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
    time::Instant,
};
use url::Url;

const LOCK_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiwcStatus {
    Connected,
    SignedOut,
    ReauthRequired,
    PlanDisabled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiwcConnection {
    pub id: String,
    pub email: Option<String>,
    pub label: String,
    pub issuer: String,
    pub subject: String,
    pub issued_client_id: String,
    pub status: SiwcStatus,
    pub scopes: Vec<String>,
    pub expires_at_ms: Option<i64>,
    pub plan_permission: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SiwcLoginPhase {
    Pending,
    Complete,
    Cancelled,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiwcLoginStatus {
    pub status: SiwcLoginPhase,
    pub connection: Option<SiwcConnection>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_connection_id: Option<String>,
}

/// Native-only. The URL may contain an ID-token hint; never serialize or log it.
pub struct SiwcLoginAttempt {
    pub attempt_id: String,
    pub authorization_url: String,
}

/// Native-only access lease. Deliberately implements neither Serialize nor Debug.
pub struct SiwcAccessLease {
    pub access_token: String,
    pub expires_at_ms: i64,
    pub credential_revision: u64,
    pub host_id: String,
    pub registration_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SiwcRevocation {
    Confirmed,
    Unconfirmed,
}
#[derive(Clone, Debug, Serialize)]
pub struct SiwcSignOutResult {
    pub revocation: SiwcRevocation,
}

struct Attempt {
    registration_id: Option<String>,
    lifecycle: Mutex<()>,
    cancelled: AtomicBool,
    wake: Notify,
    status: Mutex<SiwcLoginStatus>,
    retry_connection_id: Mutex<Option<String>>,
}

struct LoginProof {
    callback: String,
    state: String,
    nonce: String,
    verifier: String,
}

enum RotationFailure {
    Terminal,
    Retryable(&'static str, i64),
    Ambiguous,
}

struct Inner {
    store: Store,
    http: reqwest::Client,
    endpoints: Endpoints,
    attempts: Mutex<HashMap<String, Arc<Attempt>>>,
    begin_gate: tokio::sync::Mutex<()>,
    closed: Mutex<bool>,
}

#[derive(Clone)]
pub struct SiwcManager {
    inner: Arc<Inner>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn random_secret() -> String {
    URL_SAFE_NO_PAD.encode(cognia_secrets::secret_store::generate_master_key())
}
fn status(
    phase: SiwcLoginPhase,
    connection: Option<SiwcConnection>,
    error: Option<String>,
) -> SiwcLoginStatus {
    SiwcLoginStatus {
        status: phase,
        connection,
        error,
        retry_connection_id: None,
    }
}

impl SiwcManager {
    /// Construction and a missing-store list do not initialize secrets or disk.
    /// The caller must establish the unlocked local profile before every use.
    pub fn new(profile_root: PathBuf, profile_id: String) -> Result<Self, String> {
        Self::with_endpoints(profile_root, profile_id, Endpoints::default())
    }

    fn with_endpoints(
        root: PathBuf,
        profile: String,
        endpoints: Endpoints,
    ) -> Result<Self, String> {
        cognia_net::proxy_config::ensure_crypto_provider();
        let builder = reqwest::Client::builder()
            .user_agent("Cognia-SIWC/1")
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20));
        #[cfg(not(test))]
        let http = cognia_net::proxy_config::managed_client(builder, &endpoints.issuer)
            .map_err(|_| "siwc_network_unavailable")?;
        #[cfg(test)]
        let http = builder
            .no_proxy()
            .build()
            .map_err(|_| "siwc_network_unavailable")?;
        Ok(Self {
            inner: Arc::new(Inner {
                store: Store::new(&root, &profile)?,
                http,
                endpoints,
                attempts: Mutex::new(HashMap::new()),
                begin_gate: tokio::sync::Mutex::new(()),
                closed: Mutex::new(false),
            }),
        })
    }

    pub async fn list(&self) -> Result<Vec<SiwcConnection>, String> {
        Ok(self
            .inner
            .store
            .snapshot()
            .await?
            .map(|e| {
                e.registrations
                    .values()
                    .map(Registration::summary)
                    .collect()
            })
            .unwrap_or_default())
    }

    pub async fn begin_login(
        &self,
        registration_id: Option<String>,
    ) -> Result<SiwcLoginAttempt, String> {
        let _begin = self.inner.begin_gate.lock().await;
        if *self.inner.closed.lock() {
            return Err("siwc_profile_closed".into());
        }
        // Avoid unbounded native listeners/tasks and prohibit two pending flows
        // for one selected registration inside this process.
        {
            let mut attempts = self.inner.attempts.lock();
            if attempts
                .values()
                .filter(|a| a.status.lock().status == SiwcLoginPhase::Pending)
                .count()
                >= 8
            {
                return Err("siwc_too_many_attempts".into());
            }
            if attempts.len() >= 64 {
                let finished = attempts
                    .iter()
                    .find(|(_, a)| a.status.lock().status != SiwcLoginPhase::Pending)
                    .map(|(id, _)| id.clone());
                if let Some(id) = finished {
                    attempts.remove(&id);
                }
            }
            if registration_id.is_some()
                && attempts.values().any(|a| {
                    a.registration_id == registration_id
                        && a.status.lock().status == SiwcLoginPhase::Pending
                })
            {
                return Err("siwc_busy".into());
            }
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "siwc_callback_unavailable")?;
        let callback = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener
                .local_addr()
                .map_err(|_| "siwc_callback_unavailable")?
                .port()
        );
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        let inner = self.inner.clone();
        let selected_id = registration_id.clone();
        let (_, (host, selected)) = self
            .inner
            .store
            .run_locked(file, move |store| {
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                let registration_id = selected_id;
                let mut envelope = store.load()?.unwrap_or_else(|| Envelope {
                    version: 1,
                    host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
                    ..Default::default()
                });
                let selected = match registration_id.as_ref() {
                    Some(id) => Some(
                        envelope
                            .registrations
                            .get(id)
                            .or_else(|| envelope.pending_clients.get(id))
                            .cloned()
                            .ok_or("siwc_connection_missing")?,
                    ),
                    None => None,
                };
                if envelope.host_id.is_empty() {
                    envelope.host_id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
                }
                store.save(&envelope)?;
                Ok((envelope.host_id, selected))
            })
            .await?;
        let state = random_secret();
        let nonce = random_secret();
        let verifier = random_secret();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut authorize =
            Url::parse(&self.inner.endpoints.authorize).map_err(|_| "siwc_invalid_endpoint")?;
        {
            let mut query = authorize.query_pairs_mut();
            query
                .append_pair(
                    "client_id",
                    selected
                        .as_ref()
                        .map(|r| r.issued_client_id.as_str())
                        .unwrap_or("dynamic_agent_client"),
                )
                .append_pair("ext_agent_host_id", &host)
                .append_pair("response_type", "code")
                .append_pair("redirect_uri", &callback)
                .append_pair("scope", SCOPES)
                .append_pair("resource", RESOURCE)
                .append_pair("state", &state)
                .append_pair("nonce", &nonce)
                .append_pair("code_challenge_method", "S256")
                .append_pair("code_challenge", &challenge);
            if let Some(registration) = &selected {
                if !registration.subject.is_empty()
                    && registration.session.is_some()
                    && !registration.summary().plan_permission
                {
                    query.append_pair("prompt", "consent");
                }
                if let Some(hint) = registration
                    .session
                    .as_ref()
                    .and_then(|s| s.id_token.as_ref())
                {
                    query.append_pair("id_token_hint", hint);
                }
                if let Some(email) = &registration.email {
                    query.append_pair("login_hint", email);
                }
            } else {
                query.append_pair("agent_name_hint", "cognia");
            }
        }
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let attempt = Arc::new(Attempt {
            registration_id,
            lifecycle: Mutex::new(()),
            cancelled: AtomicBool::new(false),
            wake: Notify::new(),
            status: Mutex::new(status(SiwcLoginPhase::Pending, None, None)),
            retry_connection_id: Mutex::new(
                selected
                    .as_ref()
                    .filter(|r| r.subject.is_empty())
                    .map(|r| r.id.clone()),
            ),
        });
        {
            let closed = self.inner.closed.lock();
            if *closed {
                return Err("siwc_profile_closed".into());
            }
            self.inner
                .attempts
                .lock()
                .insert(attempt_id.clone(), attempt.clone());
        }
        let manager = self.clone();
        let proof = LoginProof {
            callback,
            state,
            nonce,
            verifier,
        };
        tokio::spawn(async move {
            let result = manager.listen(listener, &proof, selected, &attempt).await;
            let mut current = attempt.status.lock();
            if attempt.cancelled.load(Ordering::Acquire) {
                *current = status(SiwcLoginPhase::Cancelled, None, None);
            } else {
                *current = match result {
                    Ok(connection) => status(SiwcLoginPhase::Complete, Some(connection), None),
                    Err(error) => status(SiwcLoginPhase::Error, None, Some(error)),
                };
                if current.status == SiwcLoginPhase::Error {
                    current.retry_connection_id = attempt.retry_connection_id.lock().clone();
                }
            }
        });
        Ok(SiwcLoginAttempt {
            attempt_id,
            authorization_url: authorize.into(),
        })
    }

    pub fn poll_login(&self, attempt_id: &str) -> Result<SiwcLoginStatus, String> {
        self.inner
            .attempts
            .lock()
            .get(attempt_id)
            .map(|a| a.status.lock().clone())
            .ok_or_else(|| "siwc_attempt_missing".into())
    }

    pub fn cancel_login(&self, attempt_id: &str) -> Result<(), String> {
        let attempts = self.inner.attempts.lock();
        let attempt = attempts.get(attempt_id).ok_or("siwc_attempt_missing")?;
        let _lifecycle = attempt.lifecycle.lock();
        attempt.cancelled.store(true, Ordering::Release);
        attempt.wake.notify_one();
        *attempt.status.lock() = status(SiwcLoginPhase::Cancelled, None, None);
        Ok(())
    }

    pub fn cancel_all(&self) {
        *self.inner.closed.lock() = true;
        for attempt in self.inner.attempts.lock().values() {
            let _lifecycle = attempt.lifecycle.lock();
            attempt.cancelled.store(true, Ordering::Release);
            attempt.wake.notify_one();
            *attempt.status.lock() = status(SiwcLoginPhase::Cancelled, None, None);
        }
    }

    fn cancel_registration(&self, id: &str) {
        for attempt in self
            .inner
            .attempts
            .lock()
            .values()
            .filter(|a| a.registration_id.as_deref() == Some(id))
        {
            let _lifecycle = attempt.lifecycle.lock();
            attempt.cancelled.store(true, Ordering::Release);
            attempt.wake.notify_one();
            *attempt.status.lock() = status(SiwcLoginPhase::Cancelled, None, None);
        }
    }

    async fn discovery(&self) -> Result<Discovery, String> {
        let discovery: Discovery = bounded_json(
            self.inner
                .http
                .get(&self.inner.endpoints.discovery)
                .send()
                .await
                .map_err(|_| "siwc_network_error")?,
        )
        .await?;
        if discovery.issuer != self.inner.endpoints.issuer {
            return Err("siwc_invalid_discovery".into());
        }
        validate_endpoint(&discovery.jwks_uri, &self.inner.endpoints)?;
        if let Some(endpoint) = &discovery.revocation_endpoint {
            validate_endpoint(endpoint, &self.inner.endpoints)?;
        }
        Ok(discovery)
    }

    async fn verify(
        &self,
        token: &str,
        client_id: &str,
        nonce: Option<&str>,
    ) -> Result<oidc::Identity, String> {
        let discovery = self.discovery().await?;
        for retry in 0..2 {
            let jwks = bounded_json(
                self.inner
                    .http
                    .get(&discovery.jwks_uri)
                    .header(reqwest::header::CACHE_CONTROL, "no-cache")
                    .send()
                    .await
                    .map_err(|_| "siwc_network_error")?,
            )
            .await?;
            match oidc::verify_identity(
                token,
                &jwks,
                &self.inner.endpoints.issuer,
                client_id,
                nonce,
            ) {
                Err(error) if error == "siwc_unknown_signing_key" && retry == 0 => continue,
                result => return result,
            }
        }
        Err("siwc_invalid_identity".into())
    }

    async fn listen(
        &self,
        listener: TcpListener,
        proof: &LoginProof,
        selected: Option<Registration>,
        attempt: &Arc<Attempt>,
    ) -> Result<SiwcConnection, String> {
        let deadline = Instant::now() + LOGIN_TIMEOUT;
        loop {
            let (mut socket, peer) = tokio::select! {
                value = listener.accept() => value.map_err(|_| "siwc_callback_unavailable")?,
                _ = attempt.wake.notified() => return Err("siwc_cancelled".into()),
                _ = tokio::time::sleep_until(deadline) => return Err("siwc_login_expired".into()),
            };
            if !peer.ip().is_loopback() {
                continue;
            }
            let read = async {
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 1024];
                loop {
                    let count = socket
                        .read(&mut buffer)
                        .await
                        .map_err(|_| "siwc_invalid_callback")?;
                    if count == 0 {
                        return Err("siwc_invalid_callback");
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if bytes.len() > 8192 {
                        return Err("siwc_invalid_callback");
                    }
                    if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                String::from_utf8(bytes).map_err(|_| "siwc_invalid_callback")
            };
            let request = tokio::select! {
                value = tokio::time::timeout(Duration::from_secs(2), read) => value.ok().and_then(Result::ok),
                _ = attempt.wake.notified() => return Err("siwc_cancelled".into()),
            };
            let params = request.as_deref().and_then(|request| {
                callback_parameters(request, &proof.callback, &proof.state).ok()
            });
            let message = if params.is_some() {
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 41\r\nConnection: close\r\n\r\nYou may close this tab and return to Cognia"
            } else {
                "HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            let _ =
                tokio::time::timeout(Duration::from_secs(1), socket.write_all(message.as_bytes()))
                    .await;
            let Some(params) = params else {
                continue;
            };
            if params.contains_key("error") {
                return Err("siwc_authorization_denied".into());
            }
            let client = match &selected {
                Some(old) => {
                    if params
                        .get("client_id")
                        .is_some_and(|id| id != &old.issued_client_id)
                    {
                        return Err("siwc_identity_mismatch".into());
                    }
                    old.issued_client_id.clone()
                }
                None => params
                    .get("client_id")
                    .filter(|id| !id.is_empty() && id.as_str() != "dynamic_agent_client")
                    .cloned()
                    .ok_or("siwc_registration_incomplete")?,
            };
            let code = params
                .get("code")
                .filter(|s| !s.is_empty())
                .ok_or("siwc_invalid_callback")?;
            let selected = match selected {
                Some(selected) => selected,
                None => self.retain_issued_client(&client, attempt).await?,
            };
            let exchange = self.exchange_and_commit(code, &client, proof, Some(&selected), attempt);
            return tokio::select! {
                result = exchange => result,
                _ = attempt.wake.notified() => Err("siwc_cancelled".into()),
                _ = tokio::time::sleep_until(deadline) => Err("siwc_login_expired".into()),
            };
        }
    }

    async fn retain_issued_client(
        &self,
        client: &str,
        attempt: &Arc<Attempt>,
    ) -> Result<Registration, String> {
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        let inner = self.inner.clone();
        let attempt = attempt.clone();
        let client = client.to_owned();
        let (_, draft) = self
            .inner
            .store
            .run_locked(file, move |store| {
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                let mut envelope = store.load()?.ok_or("siwc_store_missing")?;
                let _lifecycle = attempt.lifecycle.lock();
                if attempt.cancelled.load(Ordering::Acquire) {
                    return Err("siwc_cancelled".into());
                }
                if envelope
                    .registrations
                    .values()
                    .any(|r| r.issuer == inner.endpoints.issuer && r.issued_client_id == client)
                {
                    return Err("siwc_registration_exists".into());
                }
                let draft =
                    if let Some(existing) = envelope.pending_clients.values().find(|r| {
                        r.issuer == inner.endpoints.issuer && r.issued_client_id == client
                    }) {
                        existing.clone()
                    } else {
                        if envelope.pending_clients.len() >= 64 {
                            return Err("siwc_too_many_incomplete_registrations".into());
                        }
                        let id = uuid::Uuid::new_v4().to_string();
                        Registration {
                            label: format!("ChatGPT {}", &id[..8]),
                            id,
                            issuer: inner.endpoints.issuer.clone(),
                            subject: String::new(),
                            issued_client_id: client,
                            email: None,
                            revision: 0,
                            session: None,
                            reauth_required: true,
                            extensions: BTreeMap::new(),
                        }
                    };
                envelope
                    .pending_clients
                    .insert(draft.id.clone(), draft.clone());
                store.save(&envelope)?;
                *attempt.retry_connection_id.lock() = Some(draft.id.clone());
                Ok(draft)
            })
            .await?;
        Ok(draft)
    }

    async fn exchange_and_commit(
        &self,
        code: &str,
        client: &str,
        proof: &LoginProof,
        selected: Option<&Registration>,
        attempt: &Arc<Attempt>,
    ) -> Result<SiwcConnection, String> {
        // Authorization codes are single-use: ambiguous transport completion
        // aborts the attempt instead of replaying a possibly consumed grant.
        let response: TokenResponse = bounded_json(
            self.inner
                .http
                .post(&self.inner.endpoints.token)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", client),
                    ("code", code),
                    ("code_verifier", proof.verifier.as_str()),
                    ("redirect_uri", proof.callback.as_str()),
                    ("resource", RESOURCE),
                ])
                .send()
                .await
                .map_err(|_| "siwc_exchange_ambiguous")?,
        )
        .await?;
        let identity = self
            .verify(
                response
                    .id_token
                    .as_deref()
                    .ok_or("siwc_identity_missing")?,
                client,
                Some(&proof.nonce),
            )
            .await?;
        if let Some(old) = selected {
            if (!old.subject.is_empty() && old.subject != identity.sub)
                || old.issuer != self.inner.endpoints.issuer
                || old.issued_client_id != client
            {
                return Err("siwc_identity_mismatch".into());
            }
        }
        let session = response.session(now_ms(), None)?;
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        let inner = self.inner.clone();
        let attempt = attempt.clone();
        let client = client.to_owned();
        let selected = selected.cloned();
        let (_, summary) = self
            .inner
            .store
            .run_locked(file, move |store| {
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                let mut envelope = store.load()?.ok_or("siwc_store_missing")?;
                // Cancellation and the final durable commit share one synchronous
                // critical section. A cancel returning first fences every late save.
                let _lifecycle = attempt.lifecycle.lock();
                if attempt.cancelled.load(Ordering::Acquire) {
                    return Err("siwc_cancelled".into());
                }
                let id = if let Some(old) = selected.as_ref() {
                    let current = envelope
                        .registrations
                        .get(&old.id)
                        .or_else(|| envelope.pending_clients.get(&old.id))
                        .ok_or("siwc_connection_missing")?;
                    if current.revision != old.revision {
                        return Err("siwc_stale_attempt".into());
                    }
                    old.id.clone()
                } else {
                    if envelope.registrations.values().any(|r| {
                        r.issuer == inner.endpoints.issuer
                            && r.subject == identity.sub
                            && r.issued_client_id == client
                    }) {
                        return Err("siwc_registration_exists".into());
                    }
                    uuid::Uuid::new_v4().to_string()
                };
                if envelope.tombstones.contains_key(&id) {
                    return Err("siwc_connection_missing".into());
                }
                let registration = Registration {
                    id: id.clone(),
                    issuer: inner.endpoints.issuer.clone(),
                    subject: identity.sub,
                    issued_client_id: client,
                    email: identity.email,
                    label: selected
                        .as_ref()
                        .map(|r| r.label.clone())
                        .unwrap_or_else(|| format!("ChatGPT {}", &id[..8])),
                    revision: selected.as_ref().map(|r| r.revision + 1).unwrap_or(1),
                    session: Some(session),
                    reauth_required: false,
                    extensions: selected
                        .as_ref()
                        .map(|r| r.extensions.clone())
                        .unwrap_or_default(),
                };
                let summary = registration.summary();
                envelope.pending_clients.remove(&id);
                envelope.registrations.insert(id, registration);
                store.save(&envelope)?;
                Ok(summary)
            })
            .await?;
        Ok(summary)
    }

    /// Resolves only an explicitly chosen SIWC registration. There is no
    /// legacy/API-key/default-account fallback. Refresh ownership spans durable
    /// intent, network exchange and replacement under the same OS file lock.
    pub async fn acquire_access(
        &self,
        id: &str,
        force_refresh: bool,
    ) -> Result<SiwcAccessLease, String> {
        if *self.inner.closed.lock() {
            return Err("siwc_profile_closed".into());
        }
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        if *self.inner.closed.lock() {
            return Err("siwc_profile_closed".into());
        }
        let (file, envelope) = self
            .inner
            .store
            .run_locked(file, |store| store.load())
            .await?;
        let mut envelope = envelope.ok_or("siwc_connection_missing")?;
        let registration = envelope
            .registrations
            .get(id)
            .cloned()
            .ok_or("siwc_connection_missing")?;
        let session = registration.session.as_ref().ok_or("siwc_signed_out")?;
        if session.refresh_pending || registration.reauth_required {
            return Err("siwc_reauth_required".into());
        }
        if !registration.summary().plan_permission {
            return Err("siwc_plan_disabled".into());
        }
        if !force_refresh && session.expires_at_ms > now_ms() + 60000 {
            return Ok(lease(&envelope.host_id, &registration));
        }
        // Upstream has not specified this field's type/unit. Never guess a
        // schedule, retry in a loop, or rotate before a possible lower bound.
        if session.earliest_refresh_at.is_some() {
            if !force_refresh && session.expires_at_ms > now_ms() {
                return Ok(lease(&envelope.host_id, &registration));
            }
            return Err("siwc_refresh_timing_unverified".into());
        }
        if session
            .refresh_retry_after_ms
            .is_some_and(|deadline| deadline > now_ms())
        {
            if !force_refresh && session.expires_at_ms > now_ms() {
                return Ok(lease(&envelope.host_id, &registration));
            }
            return Err("siwc_refresh_backoff".into());
        }
        let refresh = session
            .refresh_token
            .as_deref()
            .ok_or("siwc_reauth_required")?;
        let inner = self.inner.clone();
        let id_owned = id.to_owned();
        let (file, mut envelope) = self
            .inner
            .store
            .run_locked(file, move |store| {
                let id = id_owned;
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                envelope
                    .registrations
                    .get_mut(&id)
                    .and_then(|r| r.session.as_mut())
                    .ok_or("siwc_connection_missing")?
                    .refresh_pending = true;
                store.save(&envelope)?;
                Ok(envelope)
            })
            .await?;
        let refreshed = self.rotate(refresh, &registration, session).await;
        match refreshed {
            Ok(session) => {
                let current = envelope
                    .registrations
                    .get_mut(id)
                    .ok_or("siwc_connection_missing")?;
                current.session = Some(session);
                current.revision += 1;
                current.reauth_required = false;
                // A write failure leaves durable refresh_pending=true. A
                // successor blocks old-token replay after ambiguous rotation.
                let (_file, envelope) = self.inner.store.persist_locked(file, envelope).await?;
                Ok(lease(
                    &envelope.host_id,
                    envelope
                        .registrations
                        .get(id)
                        .ok_or("siwc_connection_missing")?,
                ))
            }
            Err(RotationFailure::Terminal) => {
                let current = envelope
                    .registrations
                    .get_mut(id)
                    .ok_or("siwc_connection_missing")?;
                current.session = None;
                current.reauth_required = true;
                current.revision += 1;
                let (_file, _envelope) = self.inner.store.persist_locked(file, envelope).await?;
                Err("siwc_reauth_required".into())
            }
            Err(RotationFailure::Retryable(reason, retry_after_ms)) => {
                let current = envelope
                    .registrations
                    .get_mut(id)
                    .and_then(|r| r.session.as_mut())
                    .ok_or("siwc_connection_missing")?;
                current.refresh_pending = false;
                current.refresh_retry_after_ms =
                    Some(now_ms().saturating_add(retry_after_ms.max(60000)));
                let (_file, envelope) = self.inner.store.persist_locked(file, envelope).await?;
                if !force_refresh && session.expires_at_ms > now_ms() {
                    return Ok(lease(&envelope.host_id, &registration));
                }
                Err(reason.into())
            }
            Err(RotationFailure::Ambiguous) => {
                // Preserve the protected evidence but leave durable intent in
                // place: a successor must not replay a possibly spent token.
                Err("siwc_reauth_required".into())
            }
        }
    }

    async fn rotate(
        &self,
        refresh: &str,
        registration: &Registration,
        old: &store::Session,
    ) -> Result<store::Session, RotationFailure> {
        let response = self
            .inner
            .http
            .post(&self.inner.endpoints.token)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", registration.issued_client_id.as_str()),
                ("refresh_token", refresh),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|_| RotationFailure::Ambiguous)?;
        if !response.status().is_success() {
            let status = response.status();
            let retry_after_ms = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value
                        .parse::<u64>()
                        .ok()
                        .map(|seconds| {
                            i64::try_from(seconds)
                                .unwrap_or(i64::MAX)
                                .saturating_mul(1000)
                        })
                        .or_else(|| {
                            chrono::DateTime::parse_from_rfc2822(value)
                                .ok()
                                .map(|date| date.timestamp_millis().saturating_sub(now_ms()))
                        })
                })
                .unwrap_or(60000);
            let value: serde_json::Value =
                oidc::bounded_document(response).await.unwrap_or_default();
            let code = value.get("error").and_then(|v| {
                v.as_str()
                    .or_else(|| v.get("code").and_then(serde_json::Value::as_str))
            });
            if matches!(
                code,
                Some(
                    "invalid_grant"
                        | "invalid_refresh_token"
                        | "token_expired"
                        | "refresh_token_expired"
                        | "refresh_token_invalidated"
                        | "refresh_token_reused"
                )
            ) {
                return Err(RotationFailure::Terminal);
            }
            return Err(RotationFailure::Retryable(
                if code == Some("invalid_client") {
                    "siwc_invalid_client"
                } else if status.is_server_error() || status.as_u16() == 429 {
                    "siwc_refresh_unavailable"
                } else {
                    "siwc_refresh_rejected"
                },
                retry_after_ms,
            ));
        }
        let response: TokenResponse = oidc::bounded_document(response)
            .await
            .map_err(|_| RotationFailure::Ambiguous)?;
        if response.refresh_token.as_deref().is_none_or(str::is_empty) {
            return Err(RotationFailure::Ambiguous);
        }
        if let Some(token) = response.id_token.as_deref() {
            let identity = self
                .verify(token, &registration.issued_client_id, None)
                .await
                .map_err(|_| RotationFailure::Ambiguous)?;
            if identity.sub != registration.subject {
                return Err(RotationFailure::Ambiguous);
            }
        }
        response
            .session(now_ms(), Some(old))
            .map_err(|_| RotationFailure::Ambiguous)
    }

    pub async fn sign_out(&self, id: &str) -> Result<SiwcSignOutResult, String> {
        if *self.inner.closed.lock() {
            return Err("siwc_profile_closed".into());
        }
        self.cancel_registration(id);
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        let inner = self.inner.clone();
        let id = id.to_owned();
        let (_file, (refresh, client_id)) = self
            .inner
            .store
            .run_locked(file, move |store| {
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                let mut envelope = store.load()?.ok_or("siwc_connection_missing")?;
                let registration = envelope
                    .registrations
                    .get_mut(&id)
                    .ok_or("siwc_connection_missing")?;
                let client_id = registration.issued_client_id.clone();
                let refresh = registration.session.take().and_then(|s| s.refresh_token);
                registration.reauth_required = false;
                registration.revision += 1;
                store.save(&envelope)?;
                Ok((refresh, client_id))
            })
            .await?;
        let confirmed = match refresh {
            Some(token) => self.revoke(&token, &client_id).await,
            None => false,
        };
        Ok(SiwcSignOutResult {
            revocation: if confirmed {
                SiwcRevocation::Confirmed
            } else {
                SiwcRevocation::Unconfirmed
            },
        })
    }

    async fn revoke(&self, refresh: &str, client_id: &str) -> bool {
        let Ok(discovery) = self.discovery().await else {
            return false;
        };
        let Some(endpoint) = discovery.revocation_endpoint else {
            return false;
        };
        // Revocation is idempotent, unlike a rotating refresh grant.
        for delay in [0, 1, 2] {
            if delay > 0 {
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
            match self
                .inner
                .http
                .post(&endpoint)
                .form(&[
                    ("token", refresh),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", client_id),
                ])
                .send()
                .await
            {
                Ok(response) if response.status() == reqwest::StatusCode::OK => return true,
                Ok(response) if !response.status().is_server_error() => return false,
                _ => {}
            }
        }
        false
    }

    pub async fn delete(&self, id: &str) -> Result<SiwcSignOutResult, String> {
        if *self.inner.closed.lock() {
            return Err("siwc_profile_closed".into());
        }
        self.cancel_registration(id);
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        let inner = self.inner.clone();
        let id = id.to_owned();
        let (_file, registration) = self
            .inner
            .store
            .run_locked(file, move |store| {
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                let mut envelope = store.load()?.ok_or("siwc_connection_missing")?;
                let registration = envelope
                    .registrations
                    .remove(&id)
                    .or_else(|| envelope.pending_clients.remove(&id))
                    .ok_or("siwc_connection_missing")?;
                envelope.tombstones.insert(id, registration.revision + 1);
                store.save(&envelope)?;
                Ok(registration)
            })
            .await?;
        let confirmed = match registration.session.and_then(|s| s.refresh_token) {
            Some(token) => self.revoke(&token, &registration.issued_client_id).await,
            None => false,
        };
        Ok(SiwcSignOutResult {
            revocation: if confirmed {
                SiwcRevocation::Confirmed
            } else {
                SiwcRevocation::Unconfirmed
            },
        })
    }

    /// Check before forwarding any existing native lease to a new request.
    pub async fn validate_lease(&self, lease: &SiwcAccessLease) -> Result<(), String> {
        let file = self.inner.store.lock(LOCK_TIMEOUT).await?;
        let inner = self.inner.clone();
        let registration_id = lease.registration_id.clone();
        let host_id = lease.host_id.clone();
        let revision = lease.credential_revision;
        let expires_at_ms = lease.expires_at_ms;
        self.inner
            .store
            .run_locked(file, move |store| {
                let closed = inner.closed.lock();
                if *closed {
                    return Err("siwc_profile_closed".into());
                }
                let envelope = store.load()?.ok_or("siwc_connection_missing")?;
                let registration = envelope
                    .registrations
                    .get(&registration_id)
                    .ok_or("siwc_connection_missing")?;
                if envelope.host_id != host_id
                    || registration.revision != revision
                    || registration
                        .session
                        .as_ref()
                        .is_none_or(|s| s.refresh_pending)
                    || registration.reauth_required
                    || !registration.summary().plan_permission
                    || expires_at_ms <= now_ms()
                {
                    return Err("siwc_stale_lease".into());
                }
                Ok(())
            })
            .await
            .map(|_| ())
    }
}

fn lease(host: &str, registration: &Registration) -> SiwcAccessLease {
    // Callers verify an extant session before this private helper.
    let session = registration.session.as_ref();
    SiwcAccessLease {
        access_token: session.map(|s| s.access_token.clone()).unwrap_or_default(),
        expires_at_ms: session.map(|s| s.expires_at_ms).unwrap_or(0),
        credential_revision: registration.revision,
        host_id: host.into(),
        registration_id: registration.id.clone(),
    }
}

fn callback_parameters(
    request: &str,
    callback: &str,
    state: &str,
) -> Result<BTreeMap<String, String>, String> {
    let line = request.lines().next().ok_or("siwc_invalid_callback")?;
    let mut pieces = line.split_whitespace();
    if pieces.next() != Some("GET") {
        return Err("siwc_invalid_callback".into());
    }
    let path = pieces.next().ok_or("siwc_invalid_callback")?;
    if pieces.next() != Some("HTTP/1.1")
        || pieces.next().is_some()
        || !path.starts_with("/auth/callback?")
    {
        return Err("siwc_invalid_callback".into());
    }
    let expected = Url::parse(callback).map_err(|_| "siwc_invalid_callback")?;
    let host = format!(
        "127.0.0.1:{}",
        expected.port().ok_or("siwc_invalid_callback")?
    );
    let hosts: Vec<_> = request
        .lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .collect();
    if hosts.len() != 1 || hosts[0].1.trim() != host {
        return Err("siwc_invalid_callback".into());
    }
    let parsed =
        Url::parse(&format!("http://{host}{path}")).map_err(|_| "siwc_invalid_callback")?;
    let mut params = BTreeMap::new();
    for (key, value) in parsed.query_pairs() {
        if params
            .insert(key.into_owned(), value.into_owned())
            .is_some()
        {
            return Err("siwc_invalid_callback".into());
        }
    }
    let supplied = params.get("state").ok_or("siwc_invalid_callback")?;
    if supplied.len() != state.len()
        || supplied
            .as_bytes()
            .iter()
            .zip(state.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            != 0
    {
        return Err("siwc_invalid_callback".into());
    }
    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicUsize;

    // Synthetic ES256 fixture generated for this suite; never an account key.
    const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgep34NgNpLdbw9spB\n3/OCZ6vSZtqoCSfVzRnc1+3hpEGhRANCAAQbi06gKw3Ha7erwjgMQrccs/02i8mC\nlDrWnV1oUF/DLRaZ6RJ7d69udLuc3hbEZOQOiVDA/DwaNjqbco0XDNxr\n-----END PRIVATE KEY-----\n";

    fn jwks() -> Value {
        json!({"keys":[{"kty":"EC","crv":"P-256","x":"G4tOoCsNx2u3q8I4DEK3HLP9NovJgpQ61p1daFBfwy0","y":"FpnpEnt3r250u5zeFsRk5A6JUMD8PBo2OptyjRcM3Gs","kid":"fixture","alg":"ES256","use":"sig"}]})
    }
    fn mint(issuer: &str, nonce: &str, subject: &str, audience: &str) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("fixture".into());
        encode(&header,&json!({"iss":issuer,"sub":subject,"aud":audience,"nonce":nonce,"exp":now_ms()/1000+3600,"email":"fixture@example.invalid"}),&EncodingKey::from_ec_pem(TEST_KEY.as_bytes()).unwrap()).unwrap()
    }

    #[derive(Default)]
    struct FixtureState {
        nonce: Mutex<String>,
        bad_nonce: AtomicBool,
        plan_disabled: AtomicBool,
        missing_refresh: AtomicBool,
        refresh_status: AtomicUsize,
        refresh_calls: AtomicUsize,
        exchange_calls: AtomicUsize,
        requests: Mutex<Vec<BTreeMap<String, String>>>,
        delay: AtomicBool,
        exchange_started: Notify,
        release: Notify,
        response_mode: Mutex<String>,
        response_started: Notify,
        response_release: Notify,
        response_requests: Mutex<Vec<(String, Value)>>,
    }
    struct Fixture {
        issuer: String,
        state: Arc<FixtureState>,
        handle: tokio::task::JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }
    impl Fixture {
        async fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let issuer = format!("http://{}", listener.local_addr().unwrap());
            let state = Arc::new(FixtureState::default());
            let task_state = state.clone();
            let task_issuer = issuer.clone();
            let handle = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let state = task_state.clone();
                    let issuer = task_issuer.clone();
                    tokio::spawn(async move {
                        let mut request = Vec::new();
                        let mut buffer = [0u8; 4096];
                        let body_start = loop {
                            let count = socket.read(&mut buffer).await.unwrap();
                            if count == 0 {
                                return;
                            }
                            request.extend_from_slice(&buffer[..count]);
                            if let Some(pos) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                                break pos + 4;
                            }
                        };
                        let headers = String::from_utf8_lossy(&request[..body_start]).to_string();
                        let length = headers
                            .lines()
                            .filter_map(|l| l.split_once(':'))
                            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        while request.len() < body_start + length {
                            let count = socket.read(&mut buffer).await.unwrap();
                            if count == 0 {
                                return;
                            }
                            request.extend_from_slice(&buffer[..count]);
                        }
                        let path = headers
                            .lines()
                            .next()
                            .unwrap()
                            .split_whitespace()
                            .nth(1)
                            .unwrap();
                        if path == "/responses" || path == "/models" {
                            let body: Value = serde_json::from_slice(&request[body_start..])
                                .unwrap_or(Value::Null);
                            state.response_requests.lock().push((headers.clone(), body));
                            state.response_started.notify_one();
                            let mode = state.response_mode.lock().clone();
                            if mode == "slow_headers" {
                                state.response_release.notified().await;
                            }
                            let body = if path == "/models" {
                                json!({"models":[{"slug":"fixture-model","display_name":"Fixture","visibility":"list"}]}).to_string()
                            } else if mode == "failed" {
                                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n".into()
                            } else if mode == "missing" {
                                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".into()
                            } else {
                                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"fixture answer\"}\n\ndata: {\"type\":\"response.completed\"}\n\n".into()
                            };
                            let content_type = if path == "/models" {
                                "application/json"
                            } else {
                                "text/event-stream"
                            };
                            let head=format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
                            if socket.write_all(head.as_bytes()).await.is_err() {
                                return;
                            }
                            if mode == "slow_body" {
                                state.response_release.notified().await;
                            }
                            let _ = socket.write_all(body.as_bytes()).await;
                            return;
                        }
                        let mut status = 200;
                        let value = if path == "/.well-known/openid-configuration" {
                            json!({"issuer":issuer,"jwks_uri":format!("{issuer}/jwks"),"revocation_endpoint":format!("{issuer}/revoke")})
                        } else if path == "/jwks" {
                            jwks()
                        } else if path == "/revoke" {
                            Value::Null
                        } else if path == "/token" {
                            let fields: BTreeMap<String, String> =
                                url::form_urlencoded::parse(&request[body_start..])
                                    .into_owned()
                                    .collect();
                            let refresh = fields.get("grant_type").map(String::as_str)
                                == Some("refresh_token");
                            if refresh {
                                state.refresh_calls.fetch_add(1, Ordering::SeqCst);
                            } else {
                                state.exchange_calls.fetch_add(1, Ordering::SeqCst);
                            }
                            state.requests.lock().push(fields);
                            state.exchange_started.notify_one();
                            if state.delay.load(Ordering::Acquire) {
                                state.release.notified().await;
                            }
                            let nonce = if state.bad_nonce.load(Ordering::Acquire) {
                                "wrong".into()
                            } else {
                                state.nonce.lock().clone()
                            };
                            let mut value = json!({"access_token":format!("fixture-access-{}",state.refresh_calls.load(Ordering::SeqCst)),"refresh_token":"fixture-refresh-replacement","token_type":"Bearer","expires_in":3600,"scope":if state.plan_disabled.load(Ordering::Acquire){"openid profile email"}else{SCOPES}});
                            if refresh && state.missing_refresh.load(Ordering::Acquire) {
                                value["refresh_token"] = Value::Null;
                            }
                            if refresh && state.refresh_status.load(Ordering::Acquire) > 0 {
                                status = state.refresh_status.load(Ordering::Acquire);
                                value = json!({"error":if status==400{"invalid_grant"}else{"temporary_unavailable"}});
                            }
                            if !refresh {
                                value["id_token"] = Value::String(mint(
                                    &issuer,
                                    &nonce,
                                    "fixture-sub",
                                    "fixture-client",
                                ));
                            }
                            value
                        } else {
                            json!({"unknown":true})
                        };
                        let body = if path == "/revoke" {
                            String::new()
                        } else {
                            value.to_string()
                        };
                        let retry_header = if status == 503 {
                            "Retry-After: 120\r\n"
                        } else {
                            ""
                        };
                        let response=format!("HTTP/1.1 {status} Fixture\r\n{retry_header}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = socket.write_all(response.as_bytes()).await;
                    });
                }
            });
            Self {
                issuer,
                state,
                handle,
            }
        }
        fn manager(&self, dir: &std::path::Path) -> SiwcManager {
            SiwcManager::with_endpoints(
                dir.to_path_buf(),
                "fixture-profile".into(),
                Endpoints {
                    issuer: self.issuer.clone(),
                    authorize: format!("{}/authorize", self.issuer),
                    token: format!("{}/token", self.issuer),
                    discovery: format!("{}/.well-known/openid-configuration", self.issuer),
                },
            )
            .unwrap()
        }
        async fn callback(&self, attempt: &SiwcLoginAttempt, extra: &str) -> reqwest::StatusCode {
            let url = Url::parse(&attempt.authorization_url).unwrap();
            let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
            *self.state.nonce.lock() = params["nonce"].clone();
            reqwest::Client::new()
                .get(format!(
                    "{}?state={}&code=fixture-code{extra}",
                    params["redirect_uri"], params["state"]
                ))
                .send()
                .await
                .unwrap()
                .status()
        }
        async fn login(&self, manager: &SiwcManager) -> SiwcConnection {
            let attempt = manager.begin_login(None).await.unwrap();
            let params: BTreeMap<_, _> = Url::parse(&attempt.authorization_url)
                .unwrap()
                .query_pairs()
                .into_owned()
                .collect();
            assert_eq!(params["agent_name_hint"], "cognia");
            let host = params["ext_agent_host_id"]
                .strip_prefix("urn:uuid:")
                .unwrap();
            assert_eq!(uuid::Uuid::parse_str(host).unwrap().get_version_num(), 4);
            assert_eq!(
                self.callback(&attempt, "&client_id=fixture-client").await,
                reqwest::StatusCode::OK
            );
            wait_terminal(manager, &attempt.attempt_id)
                .await
                .connection
                .unwrap()
        }
    }
    async fn wait_terminal(manager: &SiwcManager, id: &str) -> SiwcLoginStatus {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let result = manager.poll_login(id).unwrap();
                if result.status != SiwcLoginPhase::Pending {
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn list_and_construction_are_read_only() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        assert!(manager.list().await.unwrap().is_empty());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn full_registration_reauthorization_and_local_signout_are_separate_from_legacy() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        cognia_secrets::secret_store::set("fixture-legacy", "codex", "unchanged-legacy").unwrap();
        let connection = fixture.login(&manager).await;
        assert_eq!(connection.status, SiwcStatus::Connected);
        assert!(connection.plan_permission);
        let summary = serde_json::to_string(&connection).unwrap();
        assert!(!summary.contains("fixture-access"));
        assert!(!summary.contains("fixture-refresh"));
        let lease = manager.acquire_access(&connection.id, false).await.unwrap();
        let attempt = manager
            .begin_login(Some(connection.id.clone()))
            .await
            .unwrap();
        let params: BTreeMap<_, _> = Url::parse(&attempt.authorization_url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(params["client_id"], "fixture-client");
        assert!(!params.contains_key("agent_name_hint"));
        assert!(params.contains_key("id_token_hint"));
        fixture.callback(&attempt, "").await;
        let result = wait_terminal(&manager, &attempt.attempt_id).await;
        assert_eq!(result.status, SiwcLoginPhase::Complete);
        assert!(manager.validate_lease(&lease).await.is_err());
        let signed_out = manager.sign_out(&connection.id).await.unwrap();
        assert!(matches!(signed_out.revocation, SiwcRevocation::Confirmed));
        assert_eq!(
            manager.list().await.unwrap()[0].status,
            SiwcStatus::SignedOut
        );
        assert_eq!(
            cognia_secrets::secret_store::get("fixture-legacy", "codex")
                .unwrap()
                .as_deref(),
            Some("unchanged-legacy")
        );
        let after = manager.begin_login(Some(connection.id)).await.unwrap();
        let after_params: BTreeMap<_, _> = Url::parse(&after.authorization_url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert!(!after_params.contains_key("id_token_hint"));
        assert_eq!(after_params["ext_agent_host_id"], lease.host_id);
        manager.cancel_login(&after.attempt_id).unwrap();
        for fields in fixture.state.requests.lock().iter() {
            assert_eq!(fields["resource"], RESOURCE);
            assert!(!fields.contains_key("client_secret"));
        }
    }

    #[test]
    fn verifies_signatures_audience_issuer_nonce_and_expiry() {
        let issuer = "https://auth.openai.com";
        let keys = serde_json::from_value(jwks()).unwrap();
        let token = mint(issuer, "nonce", "subject", "client");
        assert!(oidc::verify_identity(&token, &keys, issuer, "client", Some("nonce")).is_ok());
        for (iss, aud, nonce) in [
            ("https://attacker.invalid", "client", "nonce"),
            (issuer, "another", "nonce"),
            (issuer, "client", "other"),
        ] {
            assert!(oidc::verify_identity(&token, &keys, iss, aud, Some(nonce)).is_err());
        }
        let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(b"{\"sub\":\"attacker\"}");
        assert!(
            oidc::verify_identity(&parts.join("."), &keys, issuer, "client", Some("nonce"))
                .is_err()
        );
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("fixture".into());
        let expired = encode(
            &header,
            &json!({"iss":issuer,"aud":"client","sub":"s","exp":1,"nonce":"nonce"}),
            &EncodingKey::from_ec_pem(TEST_KEY.as_bytes()).unwrap(),
        )
        .unwrap();
        assert!(oidc::verify_identity(&expired, &keys, issuer, "client", Some("nonce")).is_err());
    }

    #[tokio::test]
    async fn invalid_nonce_does_not_create_connection() {
        let fixture = Fixture::start().await;
        fixture.state.bad_nonce.store(true, Ordering::Release);
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let attempt = manager.begin_login(None).await.unwrap();
        fixture
            .callback(&attempt, "&client_id=fixture-client")
            .await;
        assert_eq!(
            wait_terminal(&manager, &attempt.attempt_id)
                .await
                .error
                .as_deref(),
            Some("siwc_invalid_identity")
        );
        assert!(manager.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn issued_client_survives_failed_exchange_without_claiming_verified_identity() {
        let fixture = Fixture::start().await;
        fixture.state.bad_nonce.store(true, Ordering::Release);
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let attempt = manager.begin_login(None).await.unwrap();
        fixture
            .callback(&attempt, "&client_id=fixture-client")
            .await;
        let failed = wait_terminal(&manager, &attempt.attempt_id).await;
        let draft_id = failed.retry_connection_id.unwrap();
        assert!(manager.list().await.unwrap().is_empty());
        fixture.state.bad_nonce.store(false, Ordering::Release);
        // The issued mapping is durable across independent manager instances.
        let restarted = fixture.manager(dir.path());
        let retry = restarted.begin_login(Some(draft_id.clone())).await.unwrap();
        let params: BTreeMap<_, _> = Url::parse(&retry.authorization_url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect();
        assert_eq!(params["client_id"], "fixture-client");
        assert!(!params.contains_key("agent_name_hint"));
        fixture.callback(&retry, "").await;
        let complete = wait_terminal(&restarted, &retry.attempt_id).await;
        assert_eq!(complete.connection.unwrap().id, draft_id);
        assert!(restarted
            .inner
            .store
            .load()
            .unwrap()
            .unwrap()
            .pending_clients
            .is_empty());
    }

    #[tokio::test]
    async fn identity_permission_is_not_plan_permission() {
        let fixture = Fixture::start().await;
        fixture.state.plan_disabled.store(true, Ordering::Release);
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        assert_eq!(connection.status, SiwcStatus::PlanDisabled);
        assert_eq!(
            manager
                .acquire_access(&connection.id, false)
                .await
                .err()
                .as_deref(),
            Some("siwc_plan_disabled")
        );
    }

    #[test]
    fn callback_rejects_duplicate_state_foreign_host_and_wrong_path() {
        let callback = "http://127.0.0.1:1455/auth/callback";
        assert!(callback_parameters(
            "GET /auth/callback?state=ok&code=c HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n",
            callback,
            "ok"
        )
        .is_ok());
        for path in [
            "/auth/callback?state=ok&state=ok",
            "/callback?state=ok",
            "/auth/callback?state=wrong",
        ] {
            assert!(callback_parameters(
                &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n"),
                callback,
                "ok"
            )
            .is_err());
        }
        assert!(callback_parameters(
            "GET /auth/callback?state=ok HTTP/1.1\r\nHost: evil.invalid\r\n\r\n",
            callback,
            "ok"
        )
        .is_err());
    }

    #[tokio::test]
    async fn cancellation_during_exchange_discards_late_credentials() {
        let fixture = Fixture::start().await;
        fixture.state.delay.store(true, Ordering::Release);
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let attempt = manager.begin_login(None).await.unwrap();
        fixture
            .callback(&attempt, "&client_id=fixture-client")
            .await;
        fixture.state.exchange_started.notified().await;
        manager.cancel_login(&attempt.attempt_id).unwrap();
        fixture.state.release.notify_one();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(
            manager.poll_login(&attempt.attempt_id).unwrap().status,
            SiwcLoginPhase::Cancelled
        );
        assert!(manager.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn deletion_during_reauthorization_cannot_resurrect_registration() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        fixture.state.delay.store(true, Ordering::Release);
        let attempt = manager
            .begin_login(Some(connection.id.clone()))
            .await
            .unwrap();
        fixture.callback(&attempt, "").await;
        fixture.state.exchange_started.notified().await;
        manager.delete(&connection.id).await.unwrap();
        fixture.state.release.notify_one();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(manager.list().await.unwrap().is_empty());
        assert!(manager.acquire_access(&connection.id, false).await.is_err());
    }

    #[tokio::test]
    async fn simultaneous_managers_refresh_once_and_reloads_winning_revision() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let first = fixture.manager(dir.path());
        let connection = fixture.login(&first).await;
        {
            let _lock = first.inner.store.lock(LOCK_TIMEOUT).await.unwrap();
            let mut envelope = first.inner.store.load().unwrap().unwrap();
            envelope
                .registrations
                .get_mut(&connection.id)
                .unwrap()
                .session
                .as_mut()
                .unwrap()
                .expires_at_ms = now_ms() + 1;
            first.inner.store.save(&envelope).unwrap();
        }
        let second = fixture.manager(dir.path());
        let (a, b) = tokio::join!(
            first.acquire_access(&connection.id, false),
            second.acquire_access(&connection.id, false)
        );
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(a.credential_revision, b.credential_revision);
        assert_eq!(a.access_token, b.access_token);
        assert_eq!(fixture.state.refresh_calls.load(Ordering::SeqCst), 1);
        let requests = fixture.state.requests.lock();
        let refresh = requests
            .iter()
            .find(|v| v["grant_type"] == "refresh_token")
            .unwrap();
        assert!(!refresh.contains_key("scope"));
        assert_eq!(refresh["client_id"], "fixture-client");
    }

    #[tokio::test]
    async fn crashed_rotation_and_unknown_timing_never_replay_old_refresh_token() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        {
            let _lock = manager.inner.store.lock(LOCK_TIMEOUT).await.unwrap();
            let mut e = manager.inner.store.load().unwrap().unwrap();
            e.registrations
                .get_mut(&connection.id)
                .unwrap()
                .session
                .as_mut()
                .unwrap()
                .refresh_pending = true;
            manager.inner.store.save(&e).unwrap();
        }
        let successor = fixture.manager(dir.path());
        assert_eq!(
            successor
                .acquire_access(&connection.id, true)
                .await
                .err()
                .as_deref(),
            Some("siwc_reauth_required")
        );
        assert_eq!(
            successor.list().await.unwrap()[0].status,
            SiwcStatus::ReauthRequired
        );
        {
            let _lock = manager.inner.store.lock(LOCK_TIMEOUT).await.unwrap();
            let mut e = manager.inner.store.load().unwrap().unwrap();
            let s = e
                .registrations
                .get_mut(&connection.id)
                .unwrap()
                .session
                .as_mut()
                .unwrap();
            s.refresh_pending = false;
            s.earliest_refresh_at = Some(json!(1790000000));
            manager.inner.store.save(&e).unwrap();
        }
        assert_eq!(
            successor
                .acquire_access(&connection.id, true)
                .await
                .err()
                .as_deref(),
            Some("siwc_refresh_timing_unverified")
        );
        assert_eq!(fixture.state.refresh_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn concurrent_begin_for_one_registration_is_rejected() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        let (a, b) = tokio::join!(
            manager.begin_login(Some(connection.id.clone())),
            manager.begin_login(Some(connection.id))
        );
        assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|ok| **ok).count(), 1);
        manager.cancel_all();
    }

    #[tokio::test]
    async fn ambiguous_rotation_does_not_retry_consumed_token() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        fixture.state.missing_refresh.store(true, Ordering::Release);
        assert_eq!(
            manager
                .acquire_access(&connection.id, true)
                .await
                .err()
                .as_deref(),
            Some("siwc_reauth_required")
        );
        assert_eq!(
            manager
                .acquire_access(&connection.id, true)
                .await
                .err()
                .as_deref(),
            Some("siwc_reauth_required")
        );
        assert_eq!(fixture.state.refresh_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            manager.list().await.unwrap()[0].status,
            SiwcStatus::ReauthRequired
        );
    }

    #[tokio::test]
    async fn cancelling_all_attempts_keeps_terminal_status_and_prevents_late_save() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let attempt = manager.begin_login(None).await.unwrap();
        manager.cancel_all();
        assert_eq!(
            manager.poll_login(&attempt.attempt_id).unwrap().status,
            SiwcLoginPhase::Cancelled
        );
        assert!(manager.list().await.unwrap().is_empty());
        assert_eq!(
            manager.begin_login(None).await.err().as_deref(),
            Some("siwc_profile_closed")
        );
        assert_eq!(
            manager.poll_login(&attempt.attempt_id).unwrap().status,
            SiwcLoginPhase::Cancelled
        );
    }

    #[tokio::test]
    async fn transient_refresh_preserves_credentials_and_backs_off() {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        let before = manager.acquire_access(&connection.id, false).await.unwrap();
        fixture.state.refresh_status.store(503, Ordering::Release);
        assert_eq!(
            manager
                .acquire_access(&connection.id, true)
                .await
                .err()
                .as_deref(),
            Some("siwc_refresh_unavailable")
        );
        let after = manager.acquire_access(&connection.id, false).await.unwrap();
        assert_eq!(before.access_token, after.access_token);
        assert_eq!(
            manager
                .acquire_access(&connection.id, true)
                .await
                .err()
                .as_deref(),
            Some("siwc_refresh_backoff")
        );
        assert_eq!(fixture.state.refresh_calls.load(Ordering::SeqCst), 1);
        let envelope = manager.inner.store.load().unwrap().unwrap();
        assert!(
            envelope.registrations[&connection.id]
                .session
                .as_ref()
                .unwrap()
                .refresh_retry_after_ms
                .unwrap()
                >= now_ms() + 119000
        );
    }

    async fn responses_fixture() -> (
        Fixture,
        tempfile::TempDir,
        SiwcManager,
        SiwcConnection,
        Arc<responses::Responses>,
    ) {
        let fixture = Fixture::start().await;
        let dir = tempfile::tempdir().unwrap();
        let manager = fixture.manager(dir.path());
        let connection = fixture.login(&manager).await;
        let hub = responses::Responses::with_test_base_url(
            manager.clone(),
            Arc::new(|| Ok(())),
            fixture.issuer.clone(),
        );
        (fixture, dir, manager, connection, hub)
    }
    fn response_body() -> &'static str {
        r#"{"model":"fixture-model","stream":true,"store":false,"input":[{"role":"user","content":"safe fixture"}]}"#
    }

    #[tokio::test]
    async fn native_responses_stream_requires_terminal_completion_and_keeps_credentials_native() {
        let (fixture, _dir, _manager, connection, hub) = responses_fixture().await;
        let id = uuid::Uuid::new_v4().to_string();
        hub.open(&connection.id, &id, response_body())
            .await
            .unwrap();
        let first = hub.read(&id).await.unwrap();
        assert!(!first.done);
        assert!(hub.read(&id).await.unwrap().done);
        let requests = fixture.state.response_requests.lock();
        assert_eq!(requests.len(), 1);
        assert!(requests[0]
            .0
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-access-0"));
        assert!(!requests[0].0.contains("fixture-refresh"));
        assert_eq!(requests[0].1["store"], false);
        assert_eq!(requests[0].1["stream"], true);
    }

    #[tokio::test]
    async fn native_stream_errors_preserve_usage_and_missing_terminal_distinctions() {
        for (mode, code) in [
            ("failed", "subscription_sharing_usage_limit_exceeded"),
            ("missing", "siwc_response_missing_terminal"),
        ] {
            let (fixture, _dir, _manager, connection, hub) = responses_fixture().await;
            *fixture.state.response_mode.lock() = mode.into();
            let id = uuid::Uuid::new_v4().to_string();
            hub.open(&connection.id, &id, response_body())
                .await
                .unwrap();
            hub.read(&id).await.unwrap();
            assert_eq!(hub.read(&id).await.err().as_deref(), Some(code));
        }
    }

    #[tokio::test]
    async fn cancel_before_admission_prevents_any_upstream_post() {
        let (fixture, _dir, _manager, connection, hub) = responses_fixture().await;
        let id = uuid::Uuid::new_v4().to_string();
        hub.cancel(&id);
        assert_eq!(
            hub.open(&connection.id, &id, response_body())
                .await
                .err()
                .as_deref(),
            Some("siwc_cancelled")
        );
        assert!(fixture.state.response_requests.lock().is_empty());
    }

    #[tokio::test]
    async fn cancel_before_headers_and_dropped_open_future_retire_admission() {
        for abort in [false, true] {
            let (fixture, _dir, _manager, connection, hub) = responses_fixture().await;
            *fixture.state.response_mode.lock() = "slow_headers".into();
            let id = uuid::Uuid::new_v4().to_string();
            let child_hub = hub.clone();
            let child_id = id.clone();
            let connection_id = connection.id.clone();
            let task = tokio::spawn(async move {
                child_hub
                    .open(&connection_id, &child_id, response_body())
                    .await
            });
            fixture.state.response_started.notified().await;
            if abort {
                task.abort();
                assert!(task.await.err().unwrap().is_cancelled());
            } else {
                hub.cancel(&id);
                assert_eq!(task.await.unwrap().err().as_deref(), Some("siwc_cancelled"));
            }
            assert_eq!(
                hub.open(&connection.id, &id, response_body())
                    .await
                    .err()
                    .as_deref(),
                Some("siwc_cancelled")
            );
            fixture.state.response_release.notify_one();
            assert_eq!(fixture.state.response_requests.lock().len(), 1);
        }
    }

    #[tokio::test]
    async fn model_fetch_is_cancelled_with_connection_and_closed_generation_stays_closed() {
        let (fixture, _dir, _manager, connection, hub) = responses_fixture().await;
        *fixture.state.response_mode.lock() = "slow_headers".into();
        let other = hub.clone();
        let id = connection.id.clone();
        let task = tokio::spawn(async move { other.models(&id).await });
        fixture.state.response_started.notified().await;
        hub.cancel_connection(&connection.id);
        assert_eq!(task.await.unwrap().err().as_deref(), Some("siwc_cancelled"));
        fixture.state.response_release.notify_one();
        hub.allow_connection(&connection.id);
        hub.cancel_all();
        hub.allow_connection(&connection.id);
        assert!(hub
            .open(
                &connection.id,
                &uuid::Uuid::new_v4().to_string(),
                response_body()
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cross_process_signout_while_reading_fences_received_chunk() {
        let (fixture, dir, _manager, connection, hub) = responses_fixture().await;
        *fixture.state.response_mode.lock() = "slow_body".into();
        let id = uuid::Uuid::new_v4().to_string();
        hub.open(&connection.id, &id, response_body())
            .await
            .unwrap();
        let other = hub.clone();
        let child_id = id.clone();
        let task = tokio::spawn(async move { other.read(&child_id).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        fixture
            .manager(dir.path())
            .sign_out(&connection.id)
            .await
            .unwrap();
        fixture.state.response_release.notify_one();
        assert_eq!(
            task.await.unwrap().err().as_deref(),
            Some("siwc_stale_lease")
        );
    }

    #[tokio::test]
    async fn stale_destructive_operations_cannot_clear_successor_credentials_after_profile_close() {
        for remove in [false, true] {
            let (fixture, dir, old, connection, _hub) = responses_fixture().await;
            let file = old.inner.store.lock(LOCK_TIMEOUT).await.unwrap();
            let actor = old.clone();
            let id = connection.id.clone();
            let pending = tokio::spawn(async move {
                if remove {
                    actor.delete(&id).await
                } else {
                    actor.sign_out(&id).await
                }
            });
            tokio::time::sleep(Duration::from_millis(35)).await;
            old.cancel_all();
            let successor = fixture.manager(dir.path());
            let id = connection.id.clone();
            // Model a newer verified authorization commit while the old operation
            // is queued. OAuth signature validation is exercised separately above.
            let (file, revision) = successor
                .inner
                .store
                .run_locked(file, move |store| {
                    let mut envelope = store.load()?.ok_or("fixture missing")?;
                    let registration = envelope
                        .registrations
                        .get_mut(&id)
                        .ok_or("fixture missing")?;
                    registration.revision += 1;
                    registration
                        .session
                        .as_mut()
                        .ok_or("fixture missing")?
                        .access_token = "successor-access".into();
                    let revision = registration.revision;
                    store.save(&envelope)?;
                    Ok(revision)
                })
                .await
                .unwrap();
            drop(file);
            assert_eq!(
                pending.await.unwrap().err().as_deref(),
                Some("siwc_profile_closed")
            );
            let lease = successor
                .acquire_access(&connection.id, false)
                .await
                .unwrap();
            assert_eq!(lease.credential_revision, revision);
            assert_eq!(lease.access_token, "successor-access");
            assert_eq!(
                successor.list().await.unwrap()[0].status,
                SiwcStatus::Connected
            );
        }
    }
}
