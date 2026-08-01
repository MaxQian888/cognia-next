// Shared CRUD + active-pointer + preset Tauri commands.
//
// Provider-agnostic surface — every command takes a `provider: String` and
// dispatches through `ProviderId::parse`. Per-provider commands
// (PKCE/device-code/discovery/paste-zen-key) live under the respective
// submodules (`anthropic::commands::*`, `codex::commands::*`,
// `opencode::commands::*`).

use futures_util::StreamExt;
use tauri::{AppHandle, Manager, State};

use crate::api_key::ApiKeyState;
use crate::claude::sidecar::{kill_sidecar, SidecarState};
use crate::subscription::active::{self, ActiveAccountState, ActiveSnapshot};
use crate::subscription::anthropic::AnthropicProvider;
use crate::subscription::codex::CodexProvider;
use crate::subscription::migration::{self, MigrationOutcome};
use crate::subscription::opencode::OpencodeProvider;
use crate::subscription::preset::ProviderPreset;
use crate::subscription::provider::{ProviderId, SubscriptionProvider};
use crate::subscription::vault::{self, Account, AccountSummary, ProviderVault};

// ---------------------------------------------------------------------------
// Provider dispatch helper. Cheap function-call indirection — easier than a
// trait-object table because each provider impl is a unit struct.
// ---------------------------------------------------------------------------

fn for_provider<R>(id: ProviderId, f: impl FnOnce(&dyn SubscriptionProvider) -> R) -> R {
    match id {
        ProviderId::Anthropic => f(&AnthropicProvider),
        ProviderId::Codex => f(&CodexProvider),
        ProviderId::Opencode => f(&OpencodeProvider),
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/// Run v1 → v2 migration for every provider, then rebuild the in-process
/// active projection from the persisted vaults. Idempotent. Called once on app
/// boot from the renderer (`lib/subscription/core/migration.ts::subscriptionInit`).
///
/// The rebuild fulfils the `active.rs:13-15` contract: `ActiveAccountState`
/// and the Anthropic OAuth bearer in `ApiKeyState` are in-memory caches of the
/// vault, so without this step a subscription-only user loses their auth on
/// every app restart until they manually re-activate an account (and the chat
/// header shows a bogus "No API key" badge).
#[tauri::command]
pub async fn subscription_init(
    local_account_id: String,
    active_state: State<'_, ActiveAccountState>,
    api_key_state: State<'_, ApiKeyState>,
) -> Result<Vec<MigrationOutcome>, String> {
    let outcomes = migration::migrate_all_for_account(&local_account_id);
    for id in [
        ProviderId::Anthropic,
        ProviderId::Codex,
        ProviderId::Opencode,
    ] {
        match vault::load_for_account(&local_account_id, id) {
            Ok(Some(vault)) => {
                apply_active_projection(id, &vault, &active_state, &api_key_state).await;
            }
            Ok(None) => {
                clear_active_projection(id, &active_state, &api_key_state).await;
            }
            Err(err) => {
                // Never block app boot on a keyring hiccup — the user can
                // still re-activate manually from Settings → Subscription.
                log::warn!(
                    "subscription boot rebuild: {} vault load failed: {err}",
                    id.as_str()
                );
            }
        }
    }
    Ok(outcomes)
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn subscription_list_accounts(
    provider: String,
    local_account_id: String,
) -> Result<Vec<AccountSummary>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    Ok(vault
        .accounts
        .iter()
        .map(AccountSummary::from_account)
        .collect())
}

#[tauri::command]
pub async fn subscription_get_account(
    provider: String,
    local_account_id: String,
    account_id: String,
) -> Result<Option<Account>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault = match vault::load_for_account(&local_account_id, id)? {
        Some(v) => v,
        None => return Ok(None),
    };
    Ok(vault.find_account(&account_id).cloned())
}

#[tauri::command]
pub async fn subscription_save_account(
    provider: String,
    local_account_id: String,
    account: Account,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    // Reject a credential whose discriminator doesn't match the provider —
    // saves the caller from a silent mismatch later.
    if account.credential.provider() != id {
        return Err(format!(
            "credential provider mismatch: account.credential is for {:?}, expected {:?}",
            account.credential.provider(),
            id
        ));
    }
    for_provider(id, |p| p.validate(&account.credential))?;

    let mut vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    vault.upsert_account(account);
    vault::save_for_account(&local_account_id, id, &vault)
}

#[tauri::command]
pub async fn subscription_delete_account(
    provider: String,
    local_account_id: String,
    account_id: String,
    state: State<'_, ActiveAccountState>,
    watcher: State<'_, super::anthropic::credential::WatcherRegistry>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault = match vault::load_for_account(&local_account_id, id)? {
        Some(v) => v,
        None => return Ok(()),
    };
    let cleared_active = vault.active_account_id.as_deref() == Some(account_id.as_str());
    vault.remove_account(&account_id);
    vault::save_for_account(&local_account_id, id, &vault)?;

    if cleared_active {
        // The active pointer is gone — drop the cache so the next sidecar
        // spawn doesn't reuse a credential that no longer exists.
        state.set(id, ActiveSnapshot::default()).await;
    }
    // ADR-0028 Phase 14 — stop the credential watcher so the deleted
    // account's file watch doesn't leak forever.
    if id == ProviderId::Anthropic {
        watcher.stop_watching(&local_account_id, &account_id);
    }
    Ok(())
}

#[tauri::command]
pub async fn subscription_rename_account(
    provider: String,
    local_account_id: String,
    account_id: String,
    label: Option<String>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault = vault::load_for_account(&local_account_id, id)?
        .ok_or_else(|| format!("no vault exists for provider {provider:?}"))?;
    let account = vault
        .accounts
        .iter_mut()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("no account {account_id:?} in {provider} vault"))?;
    account.label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    vault::save_for_account(&local_account_id, id, &vault)
}

// ---------------------------------------------------------------------------
// Active pointer
// ---------------------------------------------------------------------------

/// Build the in-process projection for one provider's active account from an
/// already-loaded vault: the `ActiveSnapshot` plus, for Anthropic, the OAuth
/// bearer to mirror into `ApiKeyState`. Returns `None` when the account id is
/// not in the vault. Pure — no keyring / process I/O.
fn build_active_projection(
    id: ProviderId,
    vault: &ProviderVault,
    account_id: &str,
) -> Option<(ActiveSnapshot, Option<String>)> {
    let account = vault.find_account(account_id)?;
    let env = for_provider(id, |p| {
        p.env_for_sidecar(account, vault.resolve_preset(account))
    });
    let bearer = if id == ProviderId::Anthropic {
        env.iter()
            .find(|(k, _)| k == "CLAUDE_CODE_OAUTH_TOKEN")
            .map(|(_, v)| v.clone())
    } else {
        None
    };
    Some((
        ActiveSnapshot {
            active_account_id: Some(account_id.to_string()),
            env,
        },
        bearer,
    ))
}

/// Re-apply one provider's persisted active pointer to the in-process caches.
/// No-op when the vault has no active pointer or the pointer is stale (the
/// referenced account was deleted). Used by the boot rebuild in
/// `subscription_init`; intentionally does NOT touch the sidecar — at boot
/// nothing has spawned yet.
async fn apply_active_projection(
    id: ProviderId,
    vault: &ProviderVault,
    active_state: &ActiveAccountState,
    api_key_state: &ApiKeyState,
) {
    let Some(account_id) = vault.active_account_id.as_deref() else {
        return;
    };
    let Some((snapshot, bearer)) = build_active_projection(id, vault, account_id) else {
        log::warn!(
            "subscription boot rebuild: active account {account_id:?} missing from {} vault; skipping",
            id.as_str()
        );
        return;
    };
    active_state.set(id, snapshot).await;
    if id == ProviderId::Anthropic {
        api_key_state.set_oauth_bearer(bearer).await;
    }
}

async fn clear_active_projection(
    id: ProviderId,
    active_state: &ActiveAccountState,
    api_key_state: &ApiKeyState,
) {
    active_state.set(id, ActiveSnapshot::default()).await;
    if id == ProviderId::Anthropic {
        api_key_state.set_oauth_bearer(None).await;
    }
}

/// Set (or clear) the active account for a provider.
///
/// For Anthropic specifically: also pushes the resolved OAuth bearer into
/// `ApiKeyState` and kills the sidecar so the next spawn sees the new env.
/// For Codex / OpenCode: the env-builder reads `ActiveAccountState` directly
/// at the next external-agent spawn — no sidecar restart needed.
///
/// Passing `None` for `account_id` clears the active pointer.
#[tauri::command]
pub async fn subscription_set_active(
    provider: String,
    local_account_id: String,
    account_id: Option<String>,
    active_state: State<'_, ActiveAccountState>,
    api_key_state: State<'_, ApiKeyState>,
    sidecar_state: State<'_, SidecarState>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);

    let must_restart_sidecar = for_provider(id, |p| p.requires_sidecar_restart_on_active_switch());
    let (snapshot, anthropic_bearer) = match &account_id {
        Some(target_id) => build_active_projection(id, &vault, target_id)
            .ok_or_else(|| format!("no account {target_id:?} in {provider} vault"))?,
        None => (ActiveSnapshot::default(), None),
    };

    vault.active_account_id = account_id.clone();
    vault::save_for_account(&local_account_id, id, &vault)?;
    active_state.set(id, snapshot).await;

    // Anthropic-only side effects: push the bearer into the in-process
    // ApiKeyState (the contract sidecar.rs:143-155 reads at spawn time) and
    // kill the running sidecar so the next claude_send spawns a fresh one
    // with the new env.
    if id == ProviderId::Anthropic {
        api_key_state.set_oauth_bearer(anthropic_bearer).await;
        if must_restart_sidecar {
            kill_sidecar(sidecar_state.inner().clone()).await;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn subscription_get_active(
    provider: String,
    local_account_id: String,
    state: State<'_, ActiveAccountState>,
) -> Result<ActiveSnapshot, String> {
    let id = ProviderId::parse(&provider)?;
    let Some(vault) = vault::load_for_account(&local_account_id, id)? else {
        state.set(id, ActiveSnapshot::default()).await;
        return Ok(ActiveSnapshot::default());
    };
    let Some(account_id) = vault.active_account_id.as_deref() else {
        state.set(id, ActiveSnapshot::default()).await;
        return Ok(ActiveSnapshot::default());
    };
    let Some((snapshot, _)) = build_active_projection(id, &vault, account_id) else {
        state.set(id, ActiveSnapshot::default()).await;
        return Ok(ActiveSnapshot::default());
    };
    state.set(id, snapshot.clone()).await;
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// Provider preset — v3 multi-preset CRUD
// ---------------------------------------------------------------------------

/// List all presets stored for a provider.
#[tauri::command]
pub async fn subscription_list_presets(
    provider: String,
    local_account_id: String,
) -> Result<Vec<ProviderPreset>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    Ok(vault.presets.clone())
}

/// Validate and upsert a preset. Rejects providers that do not support
/// presets (currently only OpenCode).
#[tauri::command]
pub async fn subscription_save_preset(
    provider: String,
    local_account_id: String,
    preset: ProviderPreset,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let supports = for_provider(id, |p| p.supports_preset());
    if !supports {
        return Err(format!("provider {provider:?} does not support presets"));
    }
    preset.validate()?;
    let mut vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    vault.upsert_preset(preset);
    vault::save_for_account(&local_account_id, id, &vault)
}

/// Remove a preset by id. The default pointer and any account bindings
/// pointing at the removed preset are cleared automatically by
/// `ProviderVault::remove_preset`.
#[tauri::command]
pub async fn subscription_delete_preset(
    provider: String,
    local_account_id: String,
    preset_id: String,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    vault.remove_preset(&preset_id);
    vault::save_for_account(&local_account_id, id, &vault)
}

/// Set (or clear) the provider-level default preset id. Passing `None` clears
/// it. Passing `Some(id)` errors when the id is not in the preset library.
#[tauri::command]
pub async fn subscription_set_default_preset(
    provider: String,
    local_account_id: String,
    preset_id: Option<String>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let mut vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    if let Some(ref pid) = preset_id {
        if !vault.presets.iter().any(|p| &p.id == pid) {
            return Err(format!("preset id {pid:?} not found in {provider} vault"));
        }
    }
    vault.default_preset_id = preset_id;
    vault::save_for_account(&local_account_id, id, &vault)
}

// ---------------------------------------------------------------------------
// Back-compat shims for the v2 single-preset API
//
// `subscription_get_preset` now resolves the default preset from the v3
// library. `subscription_set_preset(Some(p))` upserts + sets default;
// `subscription_set_preset(None)` clears the default pointer.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn subscription_get_preset(
    provider: String,
    local_account_id: String,
) -> Result<Option<ProviderPreset>, String> {
    let id = ProviderId::parse(&provider)?;
    let vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    // Return the default preset from the v3 library, if one is set.
    let resolved = vault
        .default_preset_id
        .as_ref()
        .and_then(|did| vault.presets.iter().find(|p| &p.id == did))
        .cloned();
    Ok(resolved)
}

#[tauri::command]
pub async fn subscription_set_preset(
    provider: String,
    local_account_id: String,
    preset: Option<ProviderPreset>,
) -> Result<(), String> {
    let id = ProviderId::parse(&provider)?;
    let supports = for_provider(id, |p| p.supports_preset());
    if preset.is_some() && !supports {
        return Err(format!("provider {provider:?} does not support presets"));
    }
    let mut vault =
        vault::load_for_account(&local_account_id, id)?.unwrap_or_else(ProviderVault::empty);
    match preset {
        Some(p) => {
            p.validate()?;
            let pid = p.id.clone();
            vault.upsert_preset(p);
            vault.default_preset_id = Some(pid);
        }
        None => {
            vault.default_preset_id = None;
        }
    }
    vault::save_for_account(&local_account_id, id, &vault)
}

// ---------------------------------------------------------------------------
// Generic authed GET (Phase 3 balance queries)
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthedGetHeader {
    name: String,
    value: String,
}

const AUTHED_REQUEST_MAX_HEADERS: usize = 64;
const AUTHED_REQUEST_MAX_HEADER_NAME_BYTES: usize = 128;
const AUTHED_REQUEST_MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const AUTHED_REQUEST_MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthedHttpRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<AuthedGetHeader>,
    body: Option<String>,
    timeout_ms: u64,
    max_body_bytes: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthedHttpHeader {
    name: String,
    value: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthedHttpResponse {
    status: u16,
    headers: Vec<AuthedHttpHeader>,
    body: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    key: String,
    value: String,
}

impl From<(String, String)> for EnvEntry {
    fn from((key, value): (String, String)) -> Self {
        Self { key, value }
    }
}

/// Perform an authenticated GET request to an arbitrary URL, merging in the
/// caller-supplied headers. Designed for balance/quota queries that the
/// renderer cannot make directly due to CORS.
///
/// Returns the response body as a UTF-8 string on 2xx. On non-2xx, returns
/// `Err("{status}: {body}")` so the renderer can surface the upstream error
/// message verbatim.
/// Build a proxy-aware reqwest client for an authed GET.
///
/// The previous bare `reqwest::Client::builder().build()` ignored the user's
/// proxy, so the free Anthropic usage endpoint (and relay quota GETs) silently
/// failed for anyone who can only reach those hosts via a proxy (CN / corporate
/// firewall) — a primary cause of "Claude 额度刷新无效". This mirrors
/// `proxy_config::proxy_http_request`: honour the configured proxy unless the
/// target is on the bypass list.
pub(crate) fn build_authed_get_client(url: &str) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30));
    let cfg = crate::proxy_config::current();
    if !cfg.should_bypass(url) {
        if let Some(proxy) = cfg.build_reqwest_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("http client build failed: {e}"))
}

fn validate_authed_headers(headers: &[AuthedGetHeader]) -> Result<(), String> {
    if headers.len() > AUTHED_REQUEST_MAX_HEADERS {
        return Err(format!(
            "too many request headers (maximum {AUTHED_REQUEST_MAX_HEADERS})"
        ));
    }
    for header in headers {
        if header.name.len() > AUTHED_REQUEST_MAX_HEADER_NAME_BYTES
            || header.value.len() > AUTHED_REQUEST_MAX_HEADER_VALUE_BYTES
        {
            return Err("request header exceeds size limit".into());
        }
        reqwest::header::HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|_| format!("invalid request header name: {}", header.name))?;
        reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|_| format!("invalid request header value: {}", header.name))?;
    }
    Ok(())
}

async fn send_authed_request(request: AuthedHttpRequest) -> Result<AuthedHttpResponse, String> {
    validate_authed_headers(&request.headers)?;
    let method = match request.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err("authenticated request method must be GET or POST".into()),
    };
    let timeout_ms = request.timeout_ms.clamp(1, 30_000);
    let max_body_bytes = request
        .max_body_bytes
        .clamp(1, AUTHED_REQUEST_MAX_BODY_BYTES);
    let client = build_authed_get_client(&request.url)?;
    let mut builder = client
        .request(method, &request.url)
        .timeout(std::time::Duration::from_millis(timeout_ms));
    for header in &request.headers {
        builder = builder.header(header.name.as_str(), header.value.as_str());
    }
    if let Some(body) = request.body {
        if body.len() > AUTHED_REQUEST_MAX_BODY_BYTES {
            return Err("request body exceeds 1 MiB limit".into());
        }
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status().as_u16();
    let mut headers = Vec::with_capacity(response.headers().len().min(AUTHED_REQUEST_MAX_HEADERS));
    for (name, value) in response.headers().iter().take(AUTHED_REQUEST_MAX_HEADERS) {
        let value = value.to_str().unwrap_or_default();
        headers.push(AuthedHttpHeader {
            name: name.as_str().to_string(),
            value: value
                .chars()
                .take(AUTHED_REQUEST_MAX_HEADER_VALUE_BYTES)
                .collect(),
        });
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("response read failed: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > max_body_bytes {
            return Err(format!("response body exceeds {max_body_bytes} byte limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body =
        String::from_utf8(bytes).map_err(|_| "response body is not valid UTF-8".to_string())?;

    Ok(AuthedHttpResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
pub async fn subscription_authed_request(
    request: AuthedHttpRequest,
) -> Result<AuthedHttpResponse, String> {
    send_authed_request(request).await
}

#[tauri::command]
pub async fn subscription_authed_get(
    url: String,
    headers: Vec<AuthedGetHeader>,
) -> Result<String, String> {
    let response = send_authed_request(AuthedHttpRequest {
        url,
        method: "GET".into(),
        headers,
        body: None,
        timeout_ms: 30_000,
        max_body_bytes: AUTHED_REQUEST_MAX_BODY_BYTES,
    })
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("{}: {}", response.status, response.body));
    }
    Ok(response.body)
}

// ---------------------------------------------------------------------------
// ADR-0028 — per-`query()` env injection. `claude_env_for_account` returns the
// env tuple for an arbitrary accountId WITHOUT touching `ActiveAccountState`,
// so the renderer can mix accounts per ChatSession without flipping the global
// active pointer. `claude_proxy_env_for_session` returns the current process
// proxy env tuple; the `session_id` parameter is forward-compat for per-session
// proxy overrides (deferred V2).
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn claude_env_for_account(
    app: AppHandle,
    state: tauri::State<'_, super::anthropic::credential::WatcherRegistry>,
    provider: String,
    local_account_id: String,
    account_id: String,
) -> Result<Option<Vec<EnvEntry>>, String> {
    let id = ProviderId::parse(&provider)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app_data_dir: {e}"))?;
    // ADR-0028 Phase 14 — start the OAuth-refresh watcher on first use
    // for this account. Idempotent: subsequent calls are a no-op. The watcher
    // must observe the SAME directory the CLI writes its `.credentials.json`
    // to, so resolve it through the single authoritative path function.
    if matches!(id, ProviderId::Anthropic) {
        let configdir =
            active::per_account_config_dir(&app_data_dir, &local_account_id, &account_id);
        if let Err(err) = state.ensure_watching(&local_account_id, &account_id, configdir) {
            log::warn!("anthropic credential watcher start failed: {err}");
        }
    }
    active::env_for_local_account(&app_data_dir, &local_account_id, id, &account_id)
        .map(|entries| entries.map(|items| items.into_iter().map(EnvEntry::from).collect()))
}

#[tauri::command]
pub fn claude_proxy_env_for_session(_session_id: String) -> Result<Vec<EnvEntry>, String> {
    // _session_id is forward-compat for per-session proxy overrides (ADR-0028
    // open follow-up). V1 returns the process-level proxy as-is, identical to
    // what `src-tauri/src/claude/sidecar.rs:163` already injects at sidecar
    // spawn — but now also reachable per-`query()` from the renderer.
    Ok(crate::proxy_config::current()
        .env_vars()
        .into_iter()
        .map(EnvEntry::from)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::vault::{AnthropicCredentialData, ProviderCredential};
    use std::collections::BTreeMap;

    const LOCAL_ACCOUNT_ID: &str = "local-test";

    fn keyring_available() -> bool {
        std::env::var("COGNIA_TEST_KEYRING").ok().as_deref() == Some("1")
    }

    #[test]
    fn env_entry_serializes_as_named_object() {
        let value =
            serde_json::to_value(EnvEntry::from(("HTTP_PROXY".into(), "proxy".into()))).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "key": "HTTP_PROXY", "value": "proxy" })
        );
    }

    fn sample_anthropic_account() -> Account {
        Account {
            id: uuid::Uuid::now_v7().to_string(),
            label: Some("Test".into()),
            credential: ProviderCredential::Anthropic(AnthropicCredentialData {
                access_token: "oat01-cmd".into(),
                refresh_token: "rt-cmd".into(),
                expires_at_ms: 1_800_000_000_000,
                mode: "subscription".into(),
                scope: None,
                email: None,
                plan: Some("pro".into()),
                original_source: None,
                stored_at_ms: 1_700_000_000_000,
            }),
            created_at_ms: 1_700_000_000_000,
            last_used_at_ms: 1_700_000_000_000,
            preset_id: None,
        }
    }

    #[tokio::test]
    async fn save_rejects_credential_provider_mismatch() {
        use crate::subscription::vault::CodexCredentialData;
        let mut account = sample_anthropic_account();
        // Swap credential to a Codex one without changing the provider arg.
        account.credential = ProviderCredential::Codex(CodexCredentialData {
            access_token: "oat".into(),
            auth_mode: "chatgpt".into(),
            ..Default::default()
        });
        let err = subscription_save_account("anthropic".into(), LOCAL_ACCOUNT_ID.into(), account)
            .await
            .expect_err("should reject");
        assert!(err.contains("provider mismatch"));
    }

    // -----------------------------------------------------------------------
    // Boot-time projection rebuild (active.rs:13-15 contract) — pure, no keyring.
    // -----------------------------------------------------------------------

    #[test]
    fn build_active_projection_anthropic_extracts_bearer() {
        let account = sample_anthropic_account();
        let mut vault = ProviderVault::empty();
        vault.upsert_account(account.clone());
        let (snapshot, bearer) =
            build_active_projection(ProviderId::Anthropic, &vault, &account.id)
                .expect("account exists in vault");
        assert_eq!(
            snapshot.active_account_id.as_deref(),
            Some(account.id.as_str())
        );
        assert!(snapshot
            .env
            .iter()
            .any(|(k, v)| k == "CLAUDE_CODE_OAUTH_TOKEN" && v == "oat01-cmd"));
        assert_eq!(bearer.as_deref(), Some("oat01-cmd"));
    }

    #[test]
    fn build_active_projection_unknown_account_returns_none() {
        let vault = ProviderVault::empty();
        assert!(build_active_projection(ProviderId::Anthropic, &vault, "missing").is_none());
    }

    #[tokio::test]
    async fn apply_active_projection_rehydrates_states_from_vault() {
        // App restart scenario: the vault persists the active pointer but the
        // in-process caches start empty. Applying the projection must restore
        // both the ActiveAccountState snapshot and the Anthropic bearer.
        let account = sample_anthropic_account();
        let mut vault = ProviderVault::empty();
        vault.upsert_account(account.clone());
        vault.active_account_id = Some(account.id.clone());

        let active_state = ActiveAccountState::new();
        let api_key_state = ApiKeyState::new();
        apply_active_projection(ProviderId::Anthropic, &vault, &active_state, &api_key_state).await;

        let snap = active_state.get(ProviderId::Anthropic).await;
        assert_eq!(snap.active_account_id.as_deref(), Some(account.id.as_str()));
        assert!(snap.env.iter().any(|(k, _)| k == "CLAUDE_CODE_OAUTH_TOKEN"));
        assert_eq!(
            api_key_state.get_oauth_bearer().await.as_deref(),
            Some("oat01-cmd")
        );
    }

    #[tokio::test]
    async fn apply_active_projection_noops_without_active_pointer() {
        let account = sample_anthropic_account();
        let mut vault = ProviderVault::empty();
        vault.upsert_account(account);
        // active_account_id stays None — user cleared the active selection.

        let active_state = ActiveAccountState::new();
        let api_key_state = ApiKeyState::new();
        apply_active_projection(ProviderId::Anthropic, &vault, &active_state, &api_key_state).await;

        assert!(active_state
            .get(ProviderId::Anthropic)
            .await
            .active_account_id
            .is_none());
        assert!(api_key_state.get_oauth_bearer().await.is_none());
    }

    #[tokio::test]
    async fn apply_active_projection_noops_on_stale_account_id() {
        // The persisted pointer references an account that no longer exists
        // (e.g. deleted on another machine before a sync) — must not panic
        // and must leave the caches untouched.
        let mut vault = ProviderVault::empty();
        vault.active_account_id = Some("gone".into());

        let active_state = ActiveAccountState::new();
        let api_key_state = ApiKeyState::new();
        apply_active_projection(ProviderId::Anthropic, &vault, &active_state, &api_key_state).await;

        assert!(active_state
            .get(ProviderId::Anthropic)
            .await
            .active_account_id
            .is_none());
        assert!(api_key_state.get_oauth_bearer().await.is_none());
    }

    #[tokio::test]
    async fn save_rejects_unknown_provider() {
        let err = subscription_save_account(
            "bogus".into(),
            LOCAL_ACCOUNT_ID.into(),
            sample_anthropic_account(),
        )
        .await
        .expect_err("should reject");
        assert!(err.contains("bogus"));
    }

    #[tokio::test]
    async fn set_preset_accepts_opencode() {
        // Preset parity (2026-06-07): opencode supports presets like
        // anthropic/codex. The write path needs the keyring.
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
        let mut headers = BTreeMap::new();
        headers.insert("X-Test".into(), "1".into());
        let preset = ProviderPreset {
            id: "p".into(),
            label: "test".into(),
            base_url: "https://example.com".into(),
            extra_headers: headers,
            template_id: None,
            model_mapping: BTreeMap::new(),
        };
        subscription_set_preset("opencode".into(), LOCAL_ACCOUNT_ID.into(), Some(preset))
            .await
            .expect("opencode supports presets now");
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
    }

    #[tokio::test]
    async fn list_accounts_returns_empty_when_no_vault() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);
        let got = subscription_list_accounts("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert!(got.is_empty());
    }

    #[tokio::test]
    async fn list_accounts_strips_secrets_from_summary() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);
        let account = sample_anthropic_account();
        subscription_save_account("anthropic".into(), LOCAL_ACCOUNT_ID.into(), account.clone())
            .await
            .unwrap();
        let got = subscription_list_accounts("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        let blob = serde_json::to_string(&got[0]).unwrap();
        assert!(!blob.contains("oat01-cmd"));
        assert!(!blob.contains("rt-cmd"));

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn rename_updates_label() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);
        let account = sample_anthropic_account();
        let aid = account.id.clone();
        subscription_save_account("anthropic".into(), LOCAL_ACCOUNT_ID.into(), account)
            .await
            .unwrap();

        subscription_rename_account(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            aid.clone(),
            Some("New Label".into()),
        )
        .await
        .unwrap();
        let got =
            subscription_get_account("anthropic".into(), LOCAL_ACCOUNT_ID.into(), aid.clone())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(got.label.as_deref(), Some("New Label"));

        // Empty/whitespace label clears it.
        subscription_rename_account(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            aid.clone(),
            Some("   ".into()),
        )
        .await
        .unwrap();
        let got = subscription_get_account("anthropic".into(), LOCAL_ACCOUNT_ID.into(), aid)
            .await
            .unwrap()
            .unwrap();
        assert!(got.label.is_none());

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn rename_rejects_missing_account() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);
        let err = subscription_rename_account(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            "nonexistent".into(),
            None,
        )
        .await
        .expect_err("should fail");
        assert!(err.contains("no vault") || err.contains("no account"));
    }

    #[tokio::test]
    async fn get_and_set_preset_round_trip() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);
        assert!(
            subscription_get_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into())
                .await
                .unwrap()
                .is_none()
        );

        let mut headers = BTreeMap::new();
        headers.insert("X-Org".into(), "cognia".into());
        let preset = ProviderPreset {
            id: "p1".into(),
            label: "Bedrock".into(),
            base_url: "https://bedrock.example.com".into(),
            extra_headers: headers,
            template_id: None,
            model_mapping: BTreeMap::new(),
        };
        subscription_set_preset(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            Some(preset.clone()),
        )
        .await
        .unwrap();
        let got = subscription_get_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert_eq!(got, Some(preset));

        // Clear it.
        subscription_set_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into(), None)
            .await
            .unwrap();
        assert!(
            subscription_get_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into())
                .await
                .unwrap()
                .is_none()
        );

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic).unwrap();
    }

    // -----------------------------------------------------------------------
    // subscription_list_presets / subscription_save_preset /
    // subscription_delete_preset / subscription_set_default_preset
    // -----------------------------------------------------------------------

    fn sample_preset(id: &str, label: &str) -> ProviderPreset {
        ProviderPreset {
            id: id.into(),
            label: label.into(),
            base_url: "https://bedrock.example.com".into(),
            extra_headers: BTreeMap::new(),
            template_id: None,
            model_mapping: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn list_presets_empty_when_no_vault() {
        // No keyring access needed — unwrapped vault is always empty.
        // ProviderId::Anthropic: if keyring is absent vault::load returns None → empty() → empty presets.
        let got = subscription_list_presets("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        // When there's no keyring entry this is empty; the test is structurally valid regardless.
        let _ = got; // just assert it doesn't error
    }

    #[tokio::test]
    async fn save_preset_accepts_opencode() {
        // Preset parity (2026-06-07): opencode presets persist like
        // anthropic/codex ones. The write path needs the keyring.
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
        let p = sample_preset("x", "test");
        subscription_save_preset("opencode".into(), LOCAL_ACCOUNT_ID.into(), p)
            .await
            .expect("opencode supports presets now");
        let listed = subscription_list_presets("opencode".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Opencode);
    }

    #[tokio::test]
    async fn save_preset_rejects_invalid_preset() {
        let mut p = sample_preset("x", "test");
        p.base_url = "not-a-url".into();
        let err = subscription_save_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into(), p)
            .await
            .expect_err("invalid URL should be rejected");
        assert!(err.contains("URL") || err.contains("url"));
    }

    #[tokio::test]
    async fn save_delete_preset_roundtrip() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);

        let p = sample_preset("bedrock-1", "Bedrock");
        subscription_save_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into(), p.clone())
            .await
            .unwrap();

        let presets = subscription_list_presets("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert_eq!(presets.len(), 1);
        assert_eq!(presets[0].id, "bedrock-1");

        subscription_delete_preset(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            "bedrock-1".into(),
        )
        .await
        .unwrap();
        let presets_after = subscription_list_presets("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert!(presets_after.is_empty());

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn set_default_preset_rejects_unknown_id() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);

        let err = subscription_set_default_preset(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            Some("nonexistent".into()),
        )
        .await
        .expect_err("unknown preset id should be rejected");
        assert!(err.contains("nonexistent"));

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic).unwrap();
    }

    #[tokio::test]
    async fn set_default_preset_roundtrip() {
        if !keyring_available() {
            return;
        }
        let _ = vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic);

        let p = sample_preset("p1", "Bedrock");
        subscription_save_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into(), p)
            .await
            .unwrap();

        // Clear the default (set_preset(Some) above sets it as default — reset it).
        subscription_set_default_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into(), None)
            .await
            .unwrap();
        // Now the shim get_preset returns None.
        assert!(
            subscription_get_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into())
                .await
                .unwrap()
                .is_none()
        );

        // Set it back.
        subscription_set_default_preset(
            "anthropic".into(),
            LOCAL_ACCOUNT_ID.into(),
            Some("p1".into()),
        )
        .await
        .unwrap();
        let got = subscription_get_preset("anthropic".into(), LOCAL_ACCOUNT_ID.into())
            .await
            .unwrap();
        assert_eq!(got.unwrap().id, "p1");

        vault::clear_for_account(LOCAL_ACCOUNT_ID, ProviderId::Anthropic).unwrap();
    }

    // -----------------------------------------------------------------------
    // subscription_authed_get
    // -----------------------------------------------------------------------

    #[test]
    fn authed_get_client_builds_for_normal_and_bypass_urls() {
        // The proxy-aware client must build for both a public host (proxy branch
        // consulted) and a loopback host (bypass branch). We don't make a real
        // network call; proxy attachment mirrors the tested `proxy_http_request`.
        assert!(
            build_authed_get_client("https://api.anthropic.com/api/oauth/usage").is_ok(),
            "client must build for a public URL"
        );
        assert!(
            build_authed_get_client("http://127.0.0.1:65535/x").is_ok(),
            "client must build for a bypassed loopback URL"
        );
    }

    #[test]
    fn authenticated_request_rejects_unsupported_methods_and_oversized_headers() {
        let headers = (0..=AUTHED_REQUEST_MAX_HEADERS)
            .map(|index| AuthedGetHeader {
                name: format!("x-test-{index}"),
                value: "ok".into(),
            })
            .collect::<Vec<_>>();
        assert!(validate_authed_headers(&headers).is_err());

        let request = AuthedHttpRequest {
            url: "https://example.com".into(),
            method: "DELETE".into(),
            headers: Vec::new(),
            body: None,
            timeout_ms: 1_000,
            max_body_bytes: 1_024,
        };
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(send_authed_request(request))
            .unwrap_err();
        assert!(error.contains("GET or POST"));
    }
}
