//! One host owns Google document credentials, pending claims and revocation.
//! Renderer cancellation cannot release this owner or commit an obsolete result.
use cognia_secrets::keyring_secrets;
use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, OnceLock,
};
use tokio::sync::{Notify as TokioNotify, RwLock};

const NAMESPACE: &str = "docs-providers";
const STATE_KEY: &str = "google-connection-v1";
const WAIT: &str = "google_docs_disconnect_pending";
const STALE: &str = "google_docs_state_stale";
const MISMATCH: &str = "google_docs_state_mismatch";
pub const CHANGED_EVENT: &str = "google-docs-connection-changed";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    pub expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_type: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub state: String,
    pub code_verifier: String,
    pub redirect_uri: String,
    pub ts: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    version: u8,
    pub connection: String,
    pub authorization: String,
    pub tokens: Option<Tokens>,
    pub pending: Option<Pending>,
    claimed: bool,
    pub account_email: Option<String>,
    pub legacy_metadata: bool,
}
impl State {
    fn empty() -> Self {
        Self {
            version: 1,
            connection: nonce(),
            authorization: nonce(),
            tokens: None,
            pending: None,
            claimed: false,
            account_email: None,
            legacy_metadata: false,
        }
    }
    fn forget(&mut self) {
        self.connection = nonce();
        self.authorization = nonce();
        self.tokens = None;
        self.pending = None;
        self.claimed = false;
        self.account_email = None;
        self.legacy_metadata = false;
    }
}
fn nonce() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Input {
    Snapshot,
    Begin,
    SetPending {
        authorization: String,
        pending: Pending,
    },
    Claim {
        state: String,
        now: u64,
    },
    Commit {
        authorization: String,
        tokens: Tokens,
        account_email: Option<String>,
    },
    Refresh {
        connection: String,
        tokens: Tokens,
    },
    Invalidate {
        connection: String,
    },
    Disconnect,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub state: State,
    pub pending: Option<Pending>,
    pub outcome: Option<Outcome>,
}
#[derive(Clone, Serialize)]
pub struct Outcome {
    pub revoked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

trait Store: Send + Sync {
    fn load(&self) -> Result<State, String>;
    fn save(&self, state: &State) -> Result<(), String>;
}
struct EncryptedStore;
impl Store for EncryptedStore {
    fn load(&self) -> Result<State, String> {
        if let Some(raw) = keyring_secrets::get(NAMESPACE, STATE_KEY)? {
            let state: State =
                serde_json::from_str(&raw).map_err(|_| "invalid Google connection record")?;
            if state.version != 1 {
                return Err("unsupported Google connection record".into());
            }
            return Ok(state);
        }
        let mut state = State::empty();
        state.tokens =
            keyring_secrets::get(NAMESPACE, "google-tokens")?.and_then(|raw| legacy_tokens(&raw));
        state.pending = keyring_secrets::get(NAMESPACE, "google-oauth-pending")?
            .and_then(|raw| serde_json::from_str(&raw).ok());
        state.legacy_metadata = state.tokens.is_some();
        self.save(&state)?;
        Ok(state)
    }
    fn save(&self, state: &State) -> Result<(), String> {
        keyring_secrets::set(
            NAMESPACE,
            STATE_KEY,
            &serde_json::to_string(state).map_err(|e| e.to_string())?,
        )?;
        // Commit first; legacy cleanup cannot make a later load import old state.
        for key in ["google-tokens", "google-oauth-pending"] {
            if keyring_secrets::clear(NAMESPACE, key).is_err() {
                log::warn!("Google Docs legacy secret cleanup deferred");
            }
        }
        Ok(())
    }
}
type Revoker = Arc<dyn Fn(String) -> BoxFuture<'static, Result<bool, String>> + Send + Sync>;
type Notify = Arc<dyn Fn() + Send + Sync>;

struct Controller {
    store: Arc<dyn Store>,
    mutation: Mutex<()>,
    grants: RwLock<()>,
    cancelled: AtomicBool,
    disconnects: AtomicUsize,
    disconnect_done: TokioNotify,
    revoke: Revoker,
}
impl Controller {
    fn apply(&self, input: Input) -> Result<Reply, String> {
        let _guard = self.mutation.lock();
        let mut state = self.store.load()?;
        let mut pending = None;
        let cancelled = self.cancelled.load(Ordering::SeqCst);
        let beginning = matches!(input, Input::Begin);
        match input {
            Input::Snapshot => {
                if cancelled {
                    state.forget();
                }
                // A read never rolls a temporary cancellation projection back to disk.
                return Ok(Reply {
                    state,
                    pending: None,
                    outcome: None,
                });
            }
            Input::Begin => {
                if self.disconnects.load(Ordering::SeqCst) != 0 {
                    return Err(WAIT.into());
                }
                if cancelled {
                    state.forget();
                }
                state.authorization = nonce();
                state.pending = None;
                state.claimed = false;
            }
            Input::SetPending {
                authorization,
                pending: next,
            } => {
                if cancelled || state.authorization != authorization {
                    return Err(STALE.into());
                }
                state.pending = Some(next);
                state.claimed = false;
            }
            Input::Claim {
                state: requested,
                now,
            } => {
                if cancelled {
                    return Err(STALE.into());
                }
                let value = state
                    .pending
                    .as_ref()
                    .filter(|value| {
                        value.state == requested && now.saturating_sub(value.ts) <= 600_000
                    })
                    .ok_or_else(|| MISMATCH.to_string())?;
                pending = Some(value.clone());
                state.pending = None;
                state.claimed = true;
            }
            Input::Commit {
                authorization,
                tokens,
                account_email,
            } => {
                if cancelled || state.authorization != authorization || !state.claimed {
                    return Err(STALE.into());
                }
                validate_tokens(&tokens)?;
                // End the pending attempt as well as the old credential lineage.
                // A refresh started during consent must not adopt this account.
                state.authorization = nonce();
                state.connection = nonce();
                state.tokens = Some(tokens);
                state.account_email = account_email;
                state.claimed = false;
                state.legacy_metadata = false;
            }
            Input::Refresh { connection, tokens } => {
                if cancelled || state.connection != connection || state.tokens.is_none() {
                    return Err(STALE.into());
                }
                validate_tokens(&tokens)?;
                state.connection = nonce();
                state.tokens = Some(tokens);
            }
            Input::Invalidate { connection } => {
                if cancelled || state.connection != connection {
                    return Err(STALE.into());
                }
                state.connection = nonce();
                state.tokens = None;
                state.account_email = None;
                state.legacy_metadata = false;
            }
            Input::Disconnect => state.forget(),
        }
        self.store.save(&state)?;
        if beginning {
            self.cancelled.store(false, Ordering::SeqCst);
        }
        Ok(Reply {
            state,
            pending,
            outcome: None,
        })
    }
    async fn transaction(self: &Arc<Self>, input: Input) -> Result<Reply, String> {
        let owner = self.clone();
        tokio::task::spawn_blocking(move || owner.apply(input))
            .await
            .map_err(|e| e.to_string())?
    }
    async fn run(self: Arc<Self>, input: Input, notify: Notify) -> Result<Reply, String> {
        match input {
            Input::Begin => loop {
                self.wait_for_disconnects().await;
                let result = self.transaction(Input::Begin).await;
                if result.as_ref().err().map(String::as_str) == Some(WAIT) {
                    continue;
                }
                notify();
                return result;
            },
            Input::SetPending { .. } => {
                self.wait_for_disconnects().await;
                let _barrier = self.grants.write().await;
                let result = self.transaction(input).await;
                notify();
                result
            }
            Input::Disconnect => {
                let _revocation = self.grants.read().await;
                // Capture and invalidate under the same host lock. A renderer can
                // disappear without losing the token still needed for revocation.
                let owner = self.clone();
                let result = tokio::task::spawn_blocking(move || {
                    let _guard = owner.mutation.lock();
                    let mut state = owner.store.load()?;
                    let token = state.tokens.as_ref().map(|t| {
                        t.refresh_token
                            .clone()
                            .unwrap_or_else(|| t.access_token.clone())
                    });
                    state.forget();
                    owner.store.save(&state)?;
                    Ok::<_, String>((
                        Reply {
                            state,
                            pending: None,
                            outcome: None,
                        },
                        token,
                    ))
                })
                .await
                .map_err(|e| e.to_string())?;
                notify();
                let (mut reply, token) = result?;
                reply.outcome = Some(match token {
                    None => Outcome {
                        revoked: false,
                        reason: Some("not-connected".into()),
                    },
                    Some(token) => match (self.revoke)(token).await {
                        Ok(true) => Outcome {
                            revoked: true,
                            reason: None,
                        },
                        Ok(false) => Outcome {
                            revoked: false,
                            reason: Some("revocation failed".into()),
                        },
                        Err(error) => Outcome {
                            revoked: false,
                            reason: Some(error),
                        },
                    },
                });
                Ok(reply)
            }
            Input::Snapshot => self.transaction(input).await,
            _ => {
                let result = self.transaction(input).await;
                notify();
                result
            }
        }
    }
    async fn wait_for_disconnects(&self) {
        loop {
            let changed = self.disconnect_done.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.disconnects.load(Ordering::SeqCst) == 0 {
                return;
            }
            changed.await;
        }
    }
    fn start(
        self: Arc<Self>,
        input: Input,
        notify: Notify,
    ) -> tokio::task::JoinHandle<Result<Reply, String>> {
        tokio::spawn(async move {
            let disconnect = matches!(input, Input::Disconnect);
            let _active = if disconnect {
                let owner = self.clone();
                tokio::task::spawn_blocking(move || {
                    let _guard = owner.mutation.lock();
                    owner.disconnects.fetch_add(1, Ordering::SeqCst);
                    owner.cancelled.store(true, Ordering::SeqCst);
                })
                .await
                .map_err(|e| e.to_string())?;
                Some(ActiveDisconnect(self.clone()))
            } else {
                None
            };
            self.run(input, notify).await
        })
    }
}
struct ActiveDisconnect(Arc<Controller>);
impl Drop for ActiveDisconnect {
    fn drop(&mut self) {
        self.0.disconnects.fetch_sub(1, Ordering::SeqCst);
        self.0.disconnect_done.notify_waiters();
    }
}
fn legacy_tokens(raw: &str) -> Option<Tokens> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let optional = |key| value.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    Some(Tokens {
        access_token: value.get("accessToken")?.as_str()?.into(),
        expires_at: value.get("expiresAt")?.as_u64()?,
        refresh_token: optional("refreshToken"),
        scope: optional("scope"),
        token_type: optional("tokenType"),
    })
}
fn validate_tokens(tokens: &Tokens) -> Result<(), String> {
    if tokens.access_token.trim().is_empty() {
        return Err("invalid Google access token".into());
    }
    Ok(())
}
fn revocation_request(token: String) -> Result<crate::types::TauriHttpRequest, String> {
    Ok(crate::types::TauriHttpRequest {
        url: "https://oauth2.googleapis.com/revoke".into(),
        method: "POST".into(),
        headers: Some(
            [(
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            )]
            .into(),
        ),
        body: Some(serde_urlencoded::to_string([("token", token)]).map_err(|e| e.to_string())?),
        timeout_ms: Some(30_000),
        allow_invalid_certificates: None,
    })
}
fn classify_revocation(status: u16, body: &str) -> Result<bool, String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok();
    if (200..300).contains(&status)
        || parsed
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|v| v.as_str())
            == Some("invalid_token")
    {
        return Ok(true);
    }
    Err(parsed
        .as_ref()
        .and_then(|v| v.get("error_description"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Google returned HTTP {status}")))
}
fn controller() -> &'static Arc<Controller> {
    static OWNER: OnceLock<Arc<Controller>> = OnceLock::new();
    OWNER.get_or_init(|| {
        Arc::new(Controller {
            store: Arc::new(EncryptedStore),
            mutation: Mutex::new(()),
            grants: RwLock::new(()),
            cancelled: AtomicBool::new(false),
            disconnects: AtomicUsize::new(0),
            disconnect_done: TokioNotify::new(),
            revoke: Arc::new(|token| {
                Box::pin(async move {
                    let response =
                        crate::http_client::http_request(revocation_request(token)?).await?;
                    classify_revocation(response.status, &response.body)
                })
            }),
        })
    })
}

/// Jobs are host-owned and bounded by HTTP timeout, independently of the caller.
pub async fn execute_with_notify(
    input: Input,
    notify: Arc<dyn Fn() + Send + Sync>,
) -> Result<Reply, String> {
    controller()
        .clone()
        .start(input, notify)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Notify;

    #[tokio::test]
    async fn picker_epoch_survives_refresh_and_rejects_new_authorization_lineage() {
        let (owner, _) = owner(no_revoke());
        let original = owner.apply(Input::Snapshot).unwrap().state;
        let refreshed = owner
            .apply(Input::Refresh {
                connection: original.connection.clone(),
                tokens: tokens("refreshed"),
            })
            .unwrap()
            .state;
        assert_eq!(refreshed.authorization, original.authorization);
        assert_ne!(refreshed.connection, original.connection);
        let invalidated = owner
            .apply(Input::Invalidate {
                connection: refreshed.connection,
            })
            .unwrap()
            .state;
        assert_eq!(invalidated.authorization, original.authorization);
        assert!(invalidated.tokens.is_none());
        let attempt = owner.apply(Input::Begin).unwrap().state.authorization;
        assert_ne!(attempt, original.authorization);
        let committed_auth = claim(&owner);
        let committed = owner
            .apply(Input::Commit {
                authorization: committed_auth.clone(),
                tokens: tokens("new"),
                account_email: None,
            })
            .unwrap()
            .state;
        assert_ne!(committed.authorization, committed_auth);
        let disconnected = owner
            .clone()
            .start(Input::Disconnect, quiet())
            .await
            .unwrap()
            .unwrap()
            .state;
        assert_ne!(disconnected.authorization, committed.authorization);
        assert!(disconnected.tokens.is_none());
    }
    struct MemoryStore {
        state: Mutex<State>,
        fail: AtomicBool,
    }
    impl Store for MemoryStore {
        fn load(&self) -> Result<State, String> {
            Ok(self.state.lock().clone())
        }
        fn save(&self, state: &State) -> Result<(), String> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err("fixture storage failure".into());
            }
            *self.state.lock() = state.clone();
            Ok(())
        }
    }
    fn tokens(value: &str) -> Tokens {
        Tokens {
            access_token: value.into(),
            refresh_token: Some(format!("rt-{value}")),
            expires_at: 10000,
            scope: None,
            token_type: None,
        }
    }
    fn pending() -> Pending {
        Pending {
            state: "google:fixture".into(),
            code_verifier: "verifier".into(),
            redirect_uri: "http://127.0.0.1:7842/oauth/docs/google/callback".into(),
            ts: 0,
        }
    }
    fn owner(revoke: Revoker) -> (Arc<Controller>, Arc<MemoryStore>) {
        let mut state = State::empty();
        state.tokens = Some(tokens("old"));
        let store = Arc::new(MemoryStore {
            state: Mutex::new(state),
            fail: AtomicBool::new(false),
        });
        (
            Arc::new(Controller {
                store: store.clone(),
                mutation: Mutex::new(()),
                grants: RwLock::new(()),
                cancelled: AtomicBool::new(false),
                disconnects: AtomicUsize::new(0),
                disconnect_done: TokioNotify::new(),
                revoke,
            }),
            store,
        )
    }
    fn no_revoke() -> Revoker {
        Arc::new(|_| Box::pin(async { Ok(true) }))
    }
    fn quiet() -> NotifyCallback {
        Arc::new(|| {})
    }
    type NotifyCallback = Arc<dyn Fn() + Send + Sync>;
    fn claim(owner: &Controller) -> String {
        let auth = owner.apply(Input::Begin).unwrap().state.authorization;
        owner
            .apply(Input::SetPending {
                authorization: auth.clone(),
                pending: pending(),
            })
            .unwrap();
        owner
            .apply(Input::Claim {
                state: pending().state,
                now: 1,
            })
            .unwrap();
        auth
    }

    #[test]
    fn legacy_migration_sanitizes_optional_fields_and_wire_omits_null_tokens() {
        let token =
            legacy_tokens(r#"{"accessToken":"a","expiresAt":1,"refreshToken":5,"scope":{}}"#)
                .unwrap();
        let value = serde_json::to_value(token).unwrap();
        assert_eq!(value, serde_json::json!({"accessToken":"a","expiresAt":1}));
        assert!(legacy_tokens(r#"{"accessToken":"a"}"#).is_none());
        assert!(legacy_tokens("invalid json").is_none());
    }
    #[test]
    fn revocation_uses_bounded_form_request_and_classifies_actual_responses() {
        let request = revocation_request("rt & =".into()).unwrap();
        assert_eq!(request.url, "https://oauth2.googleapis.com/revoke");
        assert_eq!(request.method, "POST");
        assert_eq!(request.body.as_deref(), Some("token=rt+%26+%3D"));
        assert_eq!(request.timeout_ms, Some(30_000));
        assert_ne!(request.allow_invalid_certificates, Some(true));
        assert!(classify_revocation(200, "").unwrap());
        assert!(classify_revocation(400, r#"{"error":"invalid_token"}"#).unwrap());
        assert_eq!(
            classify_revocation(500, r#"{"error_description":"backend error"}"#).unwrap_err(),
            "backend error"
        );
        assert_eq!(
            classify_revocation(503, "unavailable").unwrap_err(),
            "Google returned HTTP 503"
        );
    }

    #[tokio::test]
    async fn begin_waits_for_a_registered_disconnect_before_token_capture() {
        let revoked = Arc::new(Mutex::new(Vec::new()));
        let observed = revoked.clone();
        let (owner, _) = owner(Arc::new(move |token| {
            observed.lock().push(token);
            Box::pin(async { Ok(true) })
        }));
        // Pause exactly between host registration and the disconnect transaction.
        owner.disconnects.fetch_add(1, Ordering::SeqCst);
        owner.cancelled.store(true, Ordering::SeqCst);
        let active = ActiveDisconnect(owner.clone());
        let beginning = owner.clone().start(Input::Begin, quiet());
        tokio::task::yield_now().await;
        assert!(!beginning.is_finished());
        assert!(owner.store.load().unwrap().tokens.is_some());
        owner.clone().run(Input::Disconnect, quiet()).await.unwrap();
        drop(active);
        beginning.await.unwrap().unwrap();
        assert_eq!(*revoked.lock(), vec!["rt-old"]);
    }

    #[tokio::test]
    async fn stale_writes_from_other_clients_fail_after_disconnect() {
        let (owner, _) = owner(no_revoke());
        let connection = owner.apply(Input::Snapshot).unwrap().state.connection;
        let auth = claim(&owner);
        owner
            .clone()
            .start(Input::Disconnect, quiet())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            owner
                .apply(Input::Refresh {
                    connection: connection.clone(),
                    tokens: tokens("late")
                })
                .err()
                .as_deref(),
            Some(STALE)
        );
        assert_eq!(
            owner
                .apply(Input::Commit {
                    authorization: auth,
                    tokens: tokens("late"),
                    account_email: None
                })
                .err()
                .as_deref(),
            Some(STALE)
        );
        assert_eq!(
            owner
                .apply(Input::Invalidate { connection })
                .err()
                .as_deref(),
            Some(STALE)
        );
        assert!(owner.apply(Input::Snapshot).unwrap().state.tokens.is_none());
    }
    #[tokio::test]
    async fn old_refresh_and_invalid_grant_cannot_change_a_new_account() {
        let (owner, _) = owner(no_revoke());
        let previous = owner.apply(Input::Snapshot).unwrap().state.connection;
        let authorization = claim(&owner);
        owner
            .apply(Input::Commit {
                authorization,
                tokens: tokens("new"),
                account_email: Some("fixture@example.test".into()),
            })
            .unwrap();
        assert!(owner
            .apply(Input::Refresh {
                connection: previous.clone(),
                tokens: tokens("stale")
            })
            .is_err());
        assert!(owner
            .apply(Input::Invalidate {
                connection: previous
            })
            .is_err());
        assert_eq!(
            owner
                .apply(Input::Snapshot)
                .unwrap()
                .state
                .tokens
                .unwrap()
                .access_token,
            "new"
        );
    }
    #[test]
    fn committing_an_account_ends_the_pending_authorization_generation() {
        let (owner, _) = owner(no_revoke());
        let authorization = claim(&owner);
        // A refresh may start on the old account while this attempt is pending.
        assert_eq!(
            owner.apply(Input::Snapshot).unwrap().state.authorization,
            authorization
        );
        let committed = owner
            .apply(Input::Commit {
                authorization: authorization.clone(),
                tokens: tokens("new-account"),
                account_email: None,
            })
            .unwrap();
        assert_ne!(committed.state.authorization, authorization);
    }

    #[tokio::test]
    async fn duplicate_callbacks_are_claimed_once_across_clients() {
        let (owner, _) = owner(no_revoke());
        let authorization = owner.apply(Input::Begin).unwrap().state.authorization;
        owner
            .apply(Input::SetPending {
                authorization,
                pending: pending(),
            })
            .unwrap();
        let (a, b) = tokio::join!(
            owner.transaction(Input::Claim {
                state: pending().state,
                now: 1
            }),
            owner.transaction(Input::Claim {
                state: pending().state,
                now: 1
            })
        );
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    }
    #[tokio::test]
    async fn cancellation_of_renderer_waiter_does_not_release_revoke_barrier() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (owner, _) = owner({
            let entered = entered.clone();
            let release = release.clone();
            Arc::new(move |_| {
                let entered = entered.clone();
                let release = release.clone();
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(true)
                })
            })
        });
        let announced = Arc::new(AtomicBool::new(false));
        let signal = announced.clone();
        let job = owner.clone().start(
            Input::Disconnect,
            Arc::new(move || {
                signal.store(true, Ordering::SeqCst);
            }),
        );
        entered.notified().await;
        assert!(announced.load(Ordering::SeqCst));
        assert!(owner
            .transaction(Input::Snapshot)
            .await
            .unwrap()
            .state
            .tokens
            .is_none());
        drop(job); // Renderer/RPC waiter disappears; the host job remains owned.
        let preparing = owner.clone().start(Input::Begin, quiet());
        tokio::task::yield_now().await;
        assert!(!preparing.is_finished());
        release.notify_one();
        let authorization = preparing.await.unwrap().unwrap().state.authorization;
        owner
            .clone()
            .start(
                Input::SetPending {
                    authorization: authorization.clone(),
                    pending: pending(),
                },
                quiet(),
            )
            .await
            .unwrap()
            .unwrap();
        owner
            .transaction(Input::Claim {
                state: pending().state,
                now: 1,
            })
            .await
            .unwrap();
        owner
            .transaction(Input::Commit {
                authorization,
                tokens: tokens("reconnected"),
                account_email: None,
            })
            .await
            .unwrap();
        assert_eq!(
            owner
                .transaction(Input::Snapshot)
                .await
                .unwrap()
                .state
                .tokens
                .unwrap()
                .access_token,
            "reconnected"
        );
    }
    #[tokio::test]
    async fn failed_second_disconnect_does_not_release_first_revoke() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (owner, store) = owner({
            let entered = entered.clone();
            let release = release.clone();
            Arc::new(move |_| {
                let entered = entered.clone();
                let release = release.clone();
                Box::pin(async move {
                    entered.notify_one();
                    release.notified().await;
                    Ok(true)
                })
            })
        });
        let first = owner.clone().start(Input::Disconnect, quiet());
        entered.notified().await;
        store.fail.store(true, Ordering::SeqCst);
        assert!(owner
            .clone()
            .start(Input::Disconnect, quiet())
            .await
            .unwrap()
            .is_err());
        let preparing = owner.clone().start(Input::Begin, quiet());
        tokio::task::yield_now().await;
        assert!(!preparing.is_finished());
        release.notify_one();
        first.await.unwrap().unwrap();
        preparing.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn failed_disconnect_blocks_old_claim_and_recovers_on_new_begin() {
        let (owner, store) = owner(no_revoke());
        let authorization = claim(&owner);
        store.fail.store(true, Ordering::SeqCst);
        assert!(owner
            .clone()
            .start(Input::Disconnect, quiet())
            .await
            .unwrap()
            .is_err());
        assert!(owner
            .apply(Input::Commit {
                authorization,
                tokens: tokens("late"),
                account_email: None
            })
            .is_err());
        assert!(owner.apply(Input::Snapshot).unwrap().state.tokens.is_none());
        let authorization = claim(&owner);
        owner
            .apply(Input::Commit {
                authorization,
                tokens: tokens("recovered"),
                account_email: None,
            })
            .unwrap();
        assert_eq!(
            owner
                .apply(Input::Snapshot)
                .unwrap()
                .state
                .tokens
                .unwrap()
                .access_token,
            "recovered"
        );
    }
    #[tokio::test]
    async fn restart_keeps_disconnect_fence_and_never_reimports_legacy() {
        let (owner, store) = owner(no_revoke());
        let authorization = claim(&owner);
        owner
            .clone()
            .start(Input::Disconnect, quiet())
            .await
            .unwrap()
            .unwrap();
        let restarted = Controller {
            store,
            mutation: Mutex::new(()),
            grants: RwLock::new(()),
            cancelled: AtomicBool::new(false),
            disconnects: AtomicUsize::new(0),
            disconnect_done: TokioNotify::new(),
            revoke: no_revoke(),
        };
        assert!(restarted
            .apply(Input::Snapshot)
            .unwrap()
            .state
            .tokens
            .is_none());
        assert!(restarted
            .apply(Input::Commit {
                authorization,
                tokens: tokens("old-process"),
                account_email: None
            })
            .is_err());
    }
    #[test]
    fn wire_uses_camel_case_fields_and_object_replies() {
        let input: Input = serde_json::from_value(serde_json::json!({"action":"commit","authorization":"a","tokens":{"accessToken":"a","refreshToken":"r","expiresAt":1},"accountEmail":"fixture@example.test"})).unwrap();
        assert!(matches!(input, Input::Commit { .. }));
        let reply = Reply {
            state: State::empty(),
            pending: None,
            outcome: None,
        };
        let wire = serde_json::to_value(reply).unwrap();
        assert!(wire.is_object());
        assert_eq!(wire["state"]["legacyMetadata"], false);
        assert!(wire["state"].get("accountEmail").is_some());
    }
    #[test]
    fn malformed_and_expired_pending_cannot_be_claimed() {
        let (owner, _) = owner(no_revoke());
        let authorization = owner.apply(Input::Begin).unwrap().state.authorization;
        owner
            .apply(Input::SetPending {
                authorization,
                pending: pending(),
            })
            .unwrap();
        assert!(owner
            .apply(Input::Claim {
                state: "google:other".into(),
                now: 1
            })
            .is_err());
        assert!(owner
            .apply(Input::Snapshot)
            .unwrap()
            .state
            .pending
            .is_some());
        assert!(owner
            .apply(Input::Claim {
                state: pending().state,
                now: 600001
            })
            .is_err());
    }
    #[test]
    fn failed_commit_is_atomic_and_does_not_wedge_the_owner() {
        let (owner, store) = owner(no_revoke());
        let authorization = claim(&owner);
        store.fail.store(true, Ordering::SeqCst);
        assert!(owner
            .apply(Input::Commit {
                authorization,
                tokens: tokens("uncommitted"),
                account_email: None
            })
            .is_err());
        assert_eq!(
            owner
                .apply(Input::Snapshot)
                .unwrap()
                .state
                .tokens
                .unwrap()
                .access_token,
            "old"
        );
        let authorization = claim(&owner);
        owner
            .apply(Input::Commit {
                authorization,
                tokens: tokens("committed"),
                account_email: None,
            })
            .unwrap();
    }
    #[test]
    fn encrypted_store_migrates_once_and_retains_authoritative_tombstone() {
        keyring_secrets::clear(NAMESPACE, STATE_KEY).unwrap();
        keyring_secrets::set(
            NAMESPACE,
            "google-tokens",
            &serde_json::to_string(&tokens("legacy")).unwrap(),
        )
        .unwrap();
        let store = EncryptedStore;
        let mut state = store.load().unwrap();
        assert_eq!(state.tokens.as_ref().unwrap().access_token, "legacy");
        state.forget();
        store.save(&state).unwrap();
        keyring_secrets::set(
            NAMESPACE,
            "google-tokens",
            &serde_json::to_string(&tokens("reappeared-legacy")).unwrap(),
        )
        .unwrap();
        assert!(store.load().unwrap().tokens.is_none());
        keyring_secrets::clear(NAMESPACE, STATE_KEY).unwrap();
        keyring_secrets::clear(NAMESPACE, "google-tokens").unwrap();
    }
}
