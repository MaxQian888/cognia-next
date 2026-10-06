//! Shared companion command bodies and wire DTOs.
use cognia_companion::{browser_access, host_identity, reachability_config, security_store};
use serde::Serialize;
use std::net::IpAddr;

/// The tenant every desktop-paired device belongs to. Resolved once here
/// because the grant commands below must address the same tenant the pairing
/// commands enrolled the device into — a mismatch would write grants nothing
/// looks up.
///
/// Used to be the `local_acct_a` literal, which made every install share one
/// tenant id. It now comes from the host binding, and falls back to the
/// unclaimed bucket before anyone has unlocked — the same tenant
/// [`cognia_companion::api::registration_authority`] enrols into, so the two stay paired.
pub fn paired_tenant_id() -> String {
    host_identity::current_tenant_or_unbound()
}

/// Snapshot of the current server lifecycle for the settings UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionServerStatus {
    /// Whether the axum listener is currently bound.
    pub running: bool,
    /// `"loopback"` | `"lan"` | `"none"`.
    ///
    /// `"none"` is emitted when the server is stopped — distinct from
    /// `"loopback"` so the UI can keep the previously-chosen radio button
    /// state separately from the live binding.
    pub bind_mode: &'static str,
    /// The OS-assigned bound port if the server is running.
    pub bound_port: Option<u16>,
}

/// One-time owner invitation and discovery data encoded in a pairing QR.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerInvitationIssue {
    pub invitation: String,
    pub expires_at_ms: i64,
    pub base_url: String,
    pub fingerprint: String,
    pub app_version: String,
    pub host_id: String,
    pub tenant_id: String,
    /// ADR-0170: the one-shot relay room a device may pair through when it
    /// cannot reach `base_url` directly. Absent when this Host is not sitting
    /// in a rendezvous (WebRTC tier off, or the companion server is down),
    /// in which case the invitation is a plain `cgnp3`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay: Option<cognia_companion::signaling::pairing::PairingRoomIssue>,
}

/// Renderer-facing view of the browser-access configuration.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessSummary {
    /// Whether the user has switched browser access on.
    pub enabled: bool,
    /// Exact browser origins allowed to reach this Host.
    pub allowed_origins: Vec<String>,
    /// Configured loopback port for the plaintext listener.
    pub port: u16,
    /// The port the listener is actually bound to right now. `None` when the
    /// server is stopped or the listener could not bind — which is how the UI
    /// distinguishes "configured" from "working".
    pub bound_port: Option<u16>,
    /// Origins offered as a starting point. Never applied implicitly.
    pub suggested_origins: Vec<String>,
    /// Base URL a browser should use, once the listener is live.
    pub browser_base_url: Option<String>,
    /// Origin a "pair in browser" link should open.
    pub primary_origin: Option<String>,
}

/// The summary from a config plus whatever port the listener is bound to.
/// Shared with the host-admin RPC arm (ADR-0170), which has no
/// `CompanionServerState` on a headless Host.
pub fn browser_access_summary_from(
    config: browser_access::BrowserAccessConfig,
    bound_port: Option<u16>,
) -> BrowserAccessSummary {
    BrowserAccessSummary {
        browser_base_url: bound_port.map(|port| format!("http://127.0.0.1:{port}")),
        primary_origin: config.primary_origin().map(str::to_string),
        enabled: config.enabled,
        allowed_origins: config.allowed_origins.clone(),
        port: config.port,
        bound_port,
        suggested_origins: browser_access::SUGGESTED_ORIGINS
            .iter()
            .map(|origin| (*origin).to_string())
            .collect(),
    }
}

/// Mint a one-shot Owner invitation for this Host and, when the Host sits
/// in a rendezvous, the pairing room it can be redeemed through (ADR-0170).
/// One implementation behind the desktop command, the host-admin RPC arm,
/// and the headless `pair` subcommand.
pub fn issue_owner_invitation(
    base_url: String,
    fingerprint: String,
    app_version: String,
    host_id: String,
    trust_root: &str,
) -> Result<OwnerInvitationIssue, String> {
    const INVITATION_TTL_SECS: i64 = 5 * 60;
    let now = unix_time_secs();
    let security = security_store::security_store()
        .ok_or_else(|| "companion security store is unavailable".to_string())?;
    // Resolve once: the tenant the invitation is filed under and the tenant
    // stamped into the QR must be the same string, or the phone dials a tenant
    // that holds no invitation.
    let tenant_id = paired_tenant_id();
    let invitation = security
        .create_owner_invitation(&tenant_id, trust_root, now, INVITATION_TTL_SECS)
        .map_err(|error| error.to_string())?;
    let expires_at_ms = now.saturating_add(INVITATION_TTL_SECS) * 1_000;
    // Open the pairing room the invitation points at. `None` is not an
    // error: it means "no relay for this invitation", exactly the QR every
    // Host issued before the relay existed.
    let relay = cognia_companion::signaling::installed_hub()
        .and_then(|hub| hub.open_pairing_room(expires_at_ms));

    Ok(OwnerInvitationIssue {
        invitation,
        expires_at_ms,
        base_url,
        fingerprint,
        app_version,
        host_id,
        tenant_id,
        relay,
    })
}

pub fn unix_time_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Install an FCM dispatcher built from a service-account JSON payload.
/// The JSON is exactly what the Google Cloud Console hands out under
/// IAM → Service Accounts → Keys → "Create new key" → JSON. Credentials
/// are persisted via the active `PushCredStore` (keyring on desktop, JSON
/// file in headless mode) so they survive restarts.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_configure_fcm(service_account_json: String) -> Result<(), String> {
    let creds: cognia_companion::dispatchers::FcmServiceAccount =
        serde_json::from_str(&service_account_json)
            .map_err(|e| format!("invalid FCM service-account JSON: {e}"))?;
    if let Some(store) = cognia_companion::push_creds::active() {
        store.store_fcm(&creds)?;
    }
    let dispatcher = cognia_companion::dispatchers::FcmDispatcher::new(creds);
    cognia_companion::push_dispatchers().set_fcm(dispatcher);
    Ok(())
}

/// Install an APNs dispatcher from key + identifier inputs.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_configure_apns(
    key_id: String,
    team_id: String,
    bundle_id: String,
    private_key_pem: String,
    production: bool,
) -> Result<(), String> {
    let persisted = cognia_companion::push_creds::PersistedApns {
        key_id,
        team_id,
        bundle_id,
        private_key_pem,
        production,
    };
    if let Some(store) = cognia_companion::push_creds::active() {
        store.store_apns(&persisted)?;
    }
    let dispatcher = cognia_companion::dispatchers::ApnsDispatcher::new(persisted.clone().into())?;
    cognia_companion::push_dispatchers().set_apns(dispatcher);
    Ok(())
}

/// Install Android Huawei Push Kit credentials on the host only.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_configure_hms(app_id: String, client_secret: String) -> Result<(), String> {
    let creds = cognia_companion::dispatchers::HmsCredentials {
        app_id: app_id.trim().into(),
        client_secret,
    };
    let dispatcher = cognia_companion::dispatchers::HmsDispatcher::new(creds.clone())?;
    let store = cognia_companion::push_creds::active()
        .ok_or("Push credential storage is not initialized")?;
    store.store_hms(&creds)?;
    cognia_companion::push_dispatchers().set_hms(dispatcher);
    Ok(())
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_clear_hms() -> Result<(), String> {
    if let Some(store) = cognia_companion::push_creds::active() {
        store.clear_hms()?;
    }
    cognia_companion::push_dispatchers().clear_hms();
    Ok(())
}

/// Clear the FCM dispatcher (e.g. after the user rotates credentials).
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_clear_fcm() -> Result<(), String> {
    if let Some(store) = cognia_companion::push_creds::active() {
        store.clear_fcm()?;
    }
    cognia_companion::push_dispatchers().clear_fcm();
    Ok(())
}

/// Clear the APNs dispatcher.
#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_clear_apns() -> Result<(), String> {
    if let Some(store) = cognia_companion::push_creds::active() {
        store.clear_apns()?;
    }
    cognia_companion::push_dispatchers().clear_apns();
    Ok(())
}

/// Diagnostics — which providers are currently configured. Used by the
/// Settings UI to render the "Configured ✓" badges.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigStatus {
    pub fcm_configured: bool,
    pub apns_configured: bool,
    pub hms_configured: bool,
}

#[cfg_attr(feature = "tauri-host", tauri::command)]
pub fn companion_push_status() -> Result<PushConfigStatus, String> {
    let store = cognia_companion::push_creds::active();
    let (fcm, apns, hms) = match store {
        Some(s) => (
            s.load_fcm()?.is_some(),
            s.load_apns()?.is_some(),
            s.load_hms()?.is_some(),
        ),
        None => (false, false, false),
    };
    Ok(PushConfigStatus {
        fcm_configured: fcm,
        apns_configured: apns,
        hms_configured: hms,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushBroadcastResult {
    pub sent: usize,
}

/// Build the deliberately metadata-only payload used by the unified
/// Notification Center's `push` channel. Notification title/body may contain
/// local or user-authored text, so they must never transit APNs/FCM here.
fn notification_center_push_payload(
    notification_id: &str,
    source: &str,
    level: &str,
    href: Option<&str>,
) -> Result<cognia_companion::push::PushPayload, String> {
    if notification_id.trim().is_empty()
        || notification_id.len() > 128
        || notification_id.chars().any(char::is_control)
    {
        return Err("notificationId must be 1..128 printable bytes".into());
    }
    if !matches!(level, "info" | "success" | "warning" | "error" | "critical") {
        return Err("level must be a valid notification level".into());
    }
    // Every `NotificationSource` (`types/notifications/index.ts`). A source
    // missing here silently loses its push channel: `notify()` treats the
    // refusal as a failed channel and keeps going.
    if !matches!(
        source,
        "scheduler"
            | "agent-team"
            | "plugin"
            | "connector"
            | "session"
            | "workflow"
            | "system"
            | "issue"
            | "site"
            | "collab"
    ) {
        return Err("source must be a valid notification source".into());
    }
    if href.is_some_and(|value| {
        !value.starts_with('/') || value.starts_with("//") || value.len() > 512
    }) {
        return Err("href must be an app-relative path".into());
    }

    let mut data = serde_json::Map::new();
    data.insert(
        "notificationId".into(),
        serde_json::Value::String(notification_id.to_string()),
    );
    data.insert("level".into(), serde_json::Value::String(level.to_string()));
    data.insert(
        "source".into(),
        serde_json::Value::String(source.to_string()),
    );
    if let Some(value) = href {
        data.insert("href".into(), serde_json::Value::String(value.to_string()));
    }

    Ok(cognia_companion::push::PushPayload {
        title: Some("Cognia".into()),
        body: Some("Open Cognia to view new activity".into()),
        data,
    })
}

/// Fan one notification-center item out to every offline device over the
/// configured push providers. Shared with the host-admin RPC arm (ADR-0170).
pub async fn broadcast_notification_push(
    push_tokens: &cognia_companion::push::PushTokenRegistry,
    notification_id: &str,
    source: &str,
    level: &str,
    href: Option<&str>,
) -> Result<PushBroadcastResult, String> {
    let payload = notification_center_push_payload(notification_id, source, level, href)?;
    let dispatchers = cognia_companion::push_dispatchers();
    let mut sent = 0;
    for provider in [
        cognia_companion::push::PushProvider::Fcm,
        cognia_companion::push::PushProvider::Apns,
        cognia_companion::push::PushProvider::Hms,
    ] {
        if let Some(dispatcher) = dispatchers.for_provider(provider) {
            sent += push_tokens
                .broadcast_to_offline(provider, &payload, dispatcher.as_ref())
                .await;
        }
    }
    Ok(PushBroadcastResult { sent })
}

/// Best-effort detect a routable LAN IPv4 address.  Returns `None` when the
/// host has no non-loopback interface (e.g., container without a network).
///
/// `pub(crate)` so the `companion_endpoints` RPC arm can report the same LAN
/// address the QR pair payload would have carried — a phone that paired over a
/// tunnel needs it to discover that the desktop is also reachable on the LAN.
pub fn detect_lan_ip() -> Option<String> {
    match local_ip_address::local_ip() {
        Ok(IpAddr::V4(v4)) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4.to_string()),
        Ok(IpAddr::V6(v6)) if !v6.is_loopback() && !v6.is_unspecified() => Some(v6.to_string()),
        _ => None,
    }
}

/// The host a LAN-bound listener advertises: the saved advertise host
/// (a mesh-VPN address the user chose, see [`cognia_companion::mesh`]) when there is
/// one, else the auto-detected LAN address.
///
/// One function behind the desktop invitation command, the host-admin
/// invitation arm and the `companion_endpoints` LAN report, so the three
/// surfaces that tell a device "reach me here" cannot disagree.
pub fn advertised_lan_host(data_dir: Option<&std::path::Path>) -> Option<String> {
    // Only a real data directory holds a preference worth trusting.
    // `reachability_config::config_path(None)` falls back to the system temp
    // directory, which on Unix is world-writable: reading it here would let any
    // local process drop a file that renames the host every paired device is
    // told to dial. Without a data dir (a headless `companion_endpoints`, a
    // desktop state with no resolved dir) there is no saved preference at all,
    // so detection is the whole answer.
    let saved = data_dir
        .map(|dir| reachability_config::load_config(Some(dir)))
        .unwrap_or_default();
    let host = match saved.advertise_host() {
        Some(host) => host.to_string(),
        None => detect_lan_ip()?,
    };
    Some(host_for_authority(&host))
}

/// A host as it may appear between `https://` and `:port`.
///
/// An IPv6 literal has to be bracketed there (RFC 3986 §3.2.2) or the colons
/// swallow the port: `https://fd7a::1:27890` names no host and no port any
/// parser can recover. Both sources reach this — a ZeroTier network with only
/// IPv6 auto-assign, and `detect_lan_ip`'s own V6 arm. Names, IPv4 addresses
/// and already-bracketed hosts pass through untouched.
fn host_for_authority(host: &str) -> String {
    if host.starts_with('[') || host.parse::<std::net::Ipv6Addr>().is_err() {
        host.to_string()
    } else {
        format!("[{host}]")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hms_configuration_persists_restores_and_clears() {
        let directory = tempfile::tempdir().unwrap();
        let store = cognia_companion::push_creds::FilePushCredStore::new(directory.path());
        cognia_companion::push_creds::install(store);
        assert!(companion_push_configure_hms("123".into(), " ".into()).is_err());
        companion_push_configure_hms("123".into(), "secret".into()).unwrap();
        assert!(companion_push_status().unwrap().hms_configured);
        assert_eq!(
            serde_json::to_value(companion_push_status().unwrap()).unwrap()["hmsConfigured"],
            true
        );
        cognia_companion::push_dispatchers().clear_hms();
        cognia_companion::push_creds::reinstall_persisted_dispatchers().unwrap();
        assert!(cognia_companion::push_dispatchers()
            .for_provider(cognia_companion::push::PushProvider::Hms)
            .is_some());
        companion_push_clear_hms().unwrap();
        assert!(!companion_push_status().unwrap().hms_configured);
    }

    #[test]
    fn an_ipv6_advertise_host_is_bracketed_for_the_url_authority() {
        assert_eq!(host_for_authority("100.101.2.3"), "100.101.2.3");
        assert_eq!(host_for_authority("host.example.com"), "host.example.com");
        assert_eq!(
            host_for_authority("fd7a:115c:a1e0::1"),
            "[fd7a:115c:a1e0::1]"
        );
        // Already bracketed stays as it is; double-bracketing is also invalid.
        assert_eq!(
            host_for_authority("[fd7a:115c:a1e0::1]"),
            "[fd7a:115c:a1e0::1]"
        );
    }

    #[test]
    fn without_a_data_dir_no_saved_advertise_host_is_consulted() {
        // `reachability_config::config_path(None)` resolves into the system
        // temp directory, which on Unix any local process can write. Planting
        // a preference there must not rename the host paired devices dial.
        //
        // Proved against a PRIVATE data dir rather than by writing the shared
        // temp path: cargo runs this crate's tests as parallel threads in one
        // binary, so planting a file at a process-global location races every
        // other test that reads it, and a panic before the restore leaves it
        // on disk for every later run. The same planted config is consulted
        // when a data dir names it and ignored when none is given, which is
        // exactly the distinction that matters.
        let dir = tempfile::tempdir().expect("tempdir");
        let planted = dir.path().join("cognia").join("reachability.json");
        std::fs::create_dir_all(planted.parent().expect("parent")).expect("create");
        std::fs::write(&planted, br#"{"advertiseHost":"attacker.example.com"}"#).expect("write");

        assert_eq!(
            advertised_lan_host(Some(dir.path())).as_deref(),
            Some("attacker.example.com"),
            "a preference under a real data dir is the whole point of the setting"
        );

        let answer = advertised_lan_host(None);
        assert_ne!(answer.as_deref(), Some("attacker.example.com"));
        // Whatever it answers is detection, which may legitimately be `None`.
        assert_eq!(answer, detect_lan_ip().map(|h| host_for_authority(&h)));
    }

    #[test]
    fn notification_center_push_payload_is_metadata_only() {
        let payload = notification_center_push_payload(
            "notification-1",
            "scheduler",
            "warning",
            Some("/inbox"),
        )
        .expect("valid payload");
        assert_eq!(payload.title.as_deref(), Some("Cognia"));
        assert_eq!(
            payload.data.get("notificationId").and_then(|v| v.as_str()),
            Some("notification-1")
        );
        assert_eq!(
            payload.data.get("href").and_then(|v| v.as_str()),
            Some("/inbox")
        );
        assert_eq!(
            payload.data.get("source").and_then(|v| v.as_str()),
            Some("scheduler")
        );
        let encoded = serde_json::to_string(&payload).expect("payload serializes");
        assert!(!encoded.contains("Private task title"));
        assert!(!encoded.contains("Private task body"));
    }

    #[test]
    fn notification_center_push_payload_accepts_every_notification_source() {
        // Mirrors `NOTIFICATION_SOURCES` in `types/notifications/index.ts`.
        for source in [
            "scheduler",
            "agent-team",
            "plugin",
            "connector",
            "session",
            "workflow",
            "system",
            "issue",
            "site",
            "collab",
        ] {
            assert!(
                notification_center_push_payload("id", source, "info", Some("/issues")).is_ok(),
                "{source} must be pushable"
            );
        }
    }

    #[test]
    fn notification_center_push_payload_rejects_unsafe_metadata() {
        assert!(notification_center_push_payload("", "system", "warning", None).is_err());
        assert!(notification_center_push_payload("id", "system", "debug", None).is_err());
        assert!(notification_center_push_payload("id", "unknown", "info", None).is_err());
        assert!(notification_center_push_payload(
            "id",
            "system",
            "info",
            Some("https://example.com")
        )
        .is_err());
        assert!(
            notification_center_push_payload("id", "system", "info", Some("//example.com"))
                .is_err()
        );
    }
}
