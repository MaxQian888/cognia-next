//! WebRTC signaling subsystem. ADR-0021.
//!
//! Public surface:
//!
//! - [`SignalingHub`] — process-wide registry of per-device signaling
//!   clients. Owned by the Tauri app via `.manage(...)` and shared with
//!   the companion server.
//! - [`commands`] — `#[tauri::command]` wrappers the renderer calls at
//!   boot, after every successful pair, and whenever the user toggles the
//!   feature or changes ICE/TURN configuration.
//!
//! Submodules:
//!
//! - [`envelope`] — canonical JSON + HMAC-SHA256 sign/verify. Mirror of
//!   `lib/signaling/envelope.ts`.
//! - [`peer`] — `webrtc-rs` `RTCPeerConnection` wrapper.
//! - [`dispatch`] — DataChannel ↔ `rpc::dispatch` + `EventBus` bridge.
//! - [`client`] — long-lived WSS client (one task per paired device).

pub mod client;
pub mod dispatch;
pub mod envelope;
pub mod peer;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use webrtc::ice_transport::ice_server::RTCIceServer;

use self::client::{spawn as spawn_client, ClientConfig, ClientHandle};
use self::envelope::now_ms;
use crate::companion_api::SharedState;

/// Default signaling URL when the renderer hasn't pushed an override yet.
/// Matches `AppSettings.signalingUrl` default in `lib/claude/types.ts`.
pub const DEFAULT_SIGNALING_URL: &str = "wss://signaling.cognia.app/v1/signaling";

/// Default STUN servers (Google + Cloudflare public). Mirrored in the
/// renderer's WebRtcCard component default population.
fn default_ice_servers() -> Vec<RTCIceServer> {
    vec![
        RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        },
        RTCIceServer {
            urls: vec!["stun:stun.cloudflare.com:3478".to_string()],
            ..Default::default()
        },
    ]
}

// ---------------------------------------------------------------------------
// SignalingHub
// ---------------------------------------------------------------------------

pub struct SignalingHub {
    inner: Mutex<HubInner>,
    /// Per-device tier table. Owned by the hub so [`TierWriter`] clones
    /// handed to each client task can update it concurrently without
    /// holding the `HubInner` lock.
    tiers: Arc<Mutex<HashMap<String, DeviceTierEntry>>>,
}

struct HubInner {
    enabled: bool,
    signaling_url: String,
    ice_servers: Vec<RTCIceServer>,
    /// Map keyed by `rendezvous_id`. One client task per paired device.
    clients: HashMap<String, ClientHandle>,
    bound: Option<Binding>,
    /// Last device set the renderer pushed via `sync_devices`. Cached so a
    /// `sync_devices → bind` ordering (renderer reaches Dexie before the
    /// companion server boots) still ends up with the right clients
    /// spawned once the binding lands.
    pending_devices: Vec<DeviceRegistration>,
}

#[derive(Clone)]
struct Binding {
    state: SharedState,
    app: tauri::AppHandle,
}

impl SignalingHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HubInner {
                enabled: true,
                signaling_url: DEFAULT_SIGNALING_URL.to_string(),
                ice_servers: default_ice_servers(),
                clients: HashMap::new(),
                bound: None,
                pending_devices: Vec::new(),
            }),
            tiers: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Wire the hub to the live companion state + Tauri app handle. Called
    /// once at server start; subsequent restarts reuse the same hub
    /// instance via `tauri::Manager::state`. The first bind also reapplies
    /// any pending device registrations the renderer pushed before the
    /// server was up.
    pub fn bind(&self, state: SharedState, app: tauri::AppHandle) {
        let pending: Vec<DeviceRegistration>;
        {
            let mut inner = self.inner.lock();
            inner.bound = Some(Binding {
                state: state.clone(),
                app: app.clone(),
            });
            // Take ownership of any registrations the renderer queued
            // before the server was up so `sync_devices` runs through the
            // usual diff path below — re-binding after the server stops
            // and starts again is also handled because `pending_devices`
            // is updated on every `sync_devices` call.
            pending = inner.pending_devices.clone();
        }
        if !pending.is_empty() {
            self.sync_devices(pending);
        }
    }

    /// Renderer push: replace the configured signaling URL + ICE/TURN
    /// servers. Any device clients already running are restarted so they
    /// pick up the new endpoint.
    pub fn configure(&self, enabled: bool, signaling_url: String, ice_servers: Vec<RTCIceServer>) {
        // Snapshot the prior device list so we can restart them after the
        // configuration mutation. We don't want to hold the parking_lot
        // mutex across `spawn_client`, which doesn't await but does touch
        // the global tokio runtime.
        let devices_to_restart: Vec<(String, String, String)>;
        let binding: Option<Binding>;
        {
            let mut inner = self.inner.lock();
            inner.enabled = enabled;
            inner.signaling_url = signaling_url;
            inner.ice_servers = ice_servers;
            binding = inner.bound.clone();
            devices_to_restart = inner
                .clients
                .values()
                .map(|h| {
                    (
                        h.config.rendezvous_id.clone(),
                        h.config.rendezvous_secret.clone(),
                        h.config.device_id.clone(),
                    )
                })
                .collect();
        }
        // Tear down all current clients.
        self.clear_clients();
        // Restart under the new config (if enabled + bound).
        if enabled {
            if let Some(binding) = binding {
                for (rid, secret, device_id) in devices_to_restart {
                    self.spawn_device_locked(&binding, rid, secret, device_id);
                }
            }
        }
    }

    /// Renderer push: declare the complete set of currently-paired devices.
    /// The hub diffs against its existing clients — new devices get a
    /// freshly spawned client task; removed devices have their client
    /// cancelled.
    pub fn sync_devices(&self, devices: Vec<DeviceRegistration>) {
        let binding: Option<Binding>;
        let enabled: bool;
        let wanted: HashMap<String, DeviceRegistration>;
        let to_remove: Vec<String>;
        let to_add: Vec<DeviceRegistration>;
        {
            let mut inner = self.inner.lock();
            binding = inner.bound.clone();
            enabled = inner.enabled;
            wanted = devices
                .iter()
                .cloned()
                .map(|d| (d.rendezvous_id.clone(), d))
                .collect();
            // Remember the latest sync so a subsequent `bind()` (server
            // restart, late-arriving Tauri state) can replay the diff.
            inner.pending_devices = devices;
            to_remove = inner
                .clients
                .keys()
                .filter(|rid| !wanted.contains_key(*rid))
                .cloned()
                .collect();
            to_add = wanted
                .values()
                .filter(|d| !inner.clients.contains_key(&d.rendezvous_id))
                .cloned()
                .collect();
        }
        for rid in to_remove {
            self.cancel_one(&rid);
        }
        if !enabled {
            return;
        }
        let Some(binding) = binding else { return };
        for d in to_add {
            self.spawn_device_locked(
                &binding,
                d.rendezvous_id,
                d.rendezvous_secret,
                d.device_id,
            );
        }
    }

    fn spawn_device_locked(
        &self,
        binding: &Binding,
        rendezvous_id: String,
        rendezvous_secret: String,
        device_id: String,
    ) {
        let (signaling_url, ice_servers) = {
            let inner = self.inner.lock();
            (inner.signaling_url.clone(), inner.ice_servers.clone())
        };
        let tier_writer = self.new_tier_writer(&rendezvous_id, &device_id);
        // Seed the tier table so a snapshot taken immediately after
        // `sync_devices` already shows the device — clients land in
        // `Offline` until the WSS task transitions them to `Awaiting`.
        tier_writer.set(DeviceTier::Offline);
        let config = ClientConfig {
            signaling_url,
            rendezvous_id: rendezvous_id.clone(),
            rendezvous_secret,
            device_id,
            ice_servers,
            tier_writer,
        };
        let handle = spawn_client(config, binding.state.clone(), binding.app.clone());
        let mut inner = self.inner.lock();
        inner.clients.insert(rendezvous_id, handle);
    }

    fn cancel_one(&self, rendezvous_id: &str) {
        let handle = {
            let mut inner = self.inner.lock();
            inner.clients.remove(rendezvous_id)
        };
        // Drop the tier entry — the renderer reads "device not tracked"
        // by absence rather than a sentinel value.
        self.tiers.lock().remove(rendezvous_id);
        if let Some(h) = handle {
            // Fire-and-forget the shutdown — the task will observe the
            // cancel signal on its next poll. We don't await because that
            // would mean holding back the renderer's RPC for the full
            // backoff window of the current session.
            tokio::spawn(async move {
                h.shutdown().await;
            });
        }
    }

    fn clear_clients(&self) {
        let drained: Vec<ClientHandle> = {
            let mut inner = self.inner.lock();
            inner.clients.drain().map(|(_, h)| h).collect()
        };
        self.tiers.lock().clear();
        for h in drained {
            tokio::spawn(async move {
                h.shutdown().await;
            });
        }
    }

    /// Snapshot of currently-registered rendezvous ids — diagnostic only.
    pub fn registered_rendezvous_ids(&self) -> Vec<String> {
        self.inner.lock().clients.keys().cloned().collect()
    }

    /// Force-restart the signaling client task for one paired device. Used
    /// by the "Reconnect" button on the desktop WebRTC card. Idempotent —
    /// returns `Err` only when the device id is unknown.
    ///
    /// Implementation: cancel the existing client (which drops its
    /// `PeerSession`), then re-spawn against the cached
    /// `DeviceRegistration` so the WSS subscribe / SDP offer cycle starts
    /// fresh. The hub's tier entry is replaced; consumers polling
    /// [`devices_status`](Self::devices_status) will see the row flicker
    /// through `Offline → Awaiting → …` again.
    pub fn reconnect_device(&self, rendezvous_id: &str) -> Result<(), String> {
        let (binding, enabled, registration) = {
            let inner = self.inner.lock();
            let registration = inner
                .pending_devices
                .iter()
                .find(|d| d.rendezvous_id == rendezvous_id)
                .cloned();
            (inner.bound.clone(), inner.enabled, registration)
        };
        let Some(registration) = registration else {
            return Err(format!(
                "reconnect_device: rendezvous id {rendezvous_id} not found"
            ));
        };
        // Cancel + drop the existing client. `cancel_one` also evicts the
        // tier entry so the UI immediately reads "device offline" between
        // the cancel and the respawn.
        self.cancel_one(rendezvous_id);
        if !enabled {
            // Mirror the `sync_devices` semantics — the user-facing toggle
            // wins; a reconnect attempt while disabled is silently a no-op
            // on the spawn side and the caller's tier table will stay
            // empty until they flip the master switch.
            return Ok(());
        }
        let Some(binding) = binding else {
            return Err("reconnect_device: hub is not bound yet".to_string());
        };
        self.spawn_device_locked(
            &binding,
            registration.rendezvous_id,
            registration.rendezvous_secret,
            registration.device_id,
        );
        Ok(())
    }

    /// Build a [`TierWriter`] handle scoped to the given device. The handle
    /// shares the hub's tier map by `Arc`, so concurrent updates from the
    /// client task land directly in the snapshot read by
    /// [`devices_status`](Self::devices_status).
    pub fn new_tier_writer(&self, rendezvous_id: &str, device_id: &str) -> TierWriter {
        TierWriter {
            map: Arc::clone(&self.tiers),
            rendezvous_id: rendezvous_id.to_string(),
            device_id: device_id.to_string(),
        }
    }

    /// Snapshot of every tracked device's current tier, sorted by
    /// `device_id` for stable rendering.
    pub fn devices_status(&self) -> Vec<DeviceTierEntry> {
        let mut out: Vec<DeviceTierEntry> = self.tiers.lock().values().cloned().collect();
        out.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        out
    }
}

impl Default for SignalingHub {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HubInner {
                enabled: true,
                signaling_url: DEFAULT_SIGNALING_URL.to_string(),
                ice_servers: default_ice_servers(),
                clients: HashMap::new(),
                bound: None,
                pending_devices: Vec::new(),
            }),
            tiers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ---------------------------------------------------------------------------
// Device registration wire shapes
// ---------------------------------------------------------------------------

/// Per-device configuration the renderer pushes via
/// `companion_signaling_sync_devices`. One entry per paired device that
/// has a `rendezvousId` + `rendezvousSecret` (i.e., was paired after the
/// pair-flow extension landed).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration {
    pub device_id: String,
    pub rendezvous_id: String,
    pub rendezvous_secret: String,
}

/// Configuration patch the renderer pushes via
/// `companion_signaling_configure` (called whenever the user edits the
/// WebRTC card in settings).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalingConfigPatch {
    pub enabled: bool,
    pub signaling_url: String,
    /// Plain `RTCIceServer` URL list (one entry per row in the textarea).
    pub ice_servers: Vec<IceServerSpec>,
    pub turn_servers: Vec<IceServerSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServerSpec {
    /// One or more `stun:` / `turn:` / `turns:` URLs.
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

impl From<IceServerSpec> for RTCIceServer {
    fn from(value: IceServerSpec) -> Self {
        RTCIceServer {
            urls: value.urls,
            username: value.username.unwrap_or_default(),
            credential: value.credential.unwrap_or_default(),
            ..Default::default()
        }
    }
}

/// Snapshot returned by `companion_signaling_status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalingStatus {
    pub enabled: bool,
    pub signaling_url: String,
    pub registered_devices: Vec<String>,
}

/// Lifecycle tier of one paired device's signaling client. Mirrors the
/// finite-state machine in [`client::run_with_reconnect`] /
/// [`client::run_one_session`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceTier {
    /// Hub is enabled, client task exists, but the WSS connection is not
    /// yet subscribed (initial state, between reconnects).
    Offline,
    /// WSS subscribed, waiting for the mobile peer to join the rendezvous.
    Awaiting,
    /// Mobile peer has joined; SDP/ICE exchange in flight.
    Negotiating,
    /// DataChannel is open — round-trip RPC available.
    Connected,
    /// Last session ended in error; client task is in its reconnect
    /// backoff window. `last_error` carries the reason.
    Failed,
}

/// One row in the [`SignalingHub::devices_status`] snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTierEntry {
    pub device_id: String,
    pub rendezvous_id: String,
    pub tier: DeviceTier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub updated_at_ms: i64,
}

/// Cheap clonable handle a client task uses to push its current tier into
/// the shared map owned by the hub. Each clone holds an `Arc` to the same
/// `HashMap`, so updates from any task land in `O(1)`.
#[derive(Clone)]
pub struct TierWriter {
    map: Arc<Mutex<HashMap<String, DeviceTierEntry>>>,
    rendezvous_id: String,
    device_id: String,
}

impl std::fmt::Debug for TierWriter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TierWriter")
            .field("rendezvous_id", &self.rendezvous_id)
            .field("device_id", &self.device_id)
            .finish()
    }
}

impl TierWriter {
    pub fn set(&self, tier: DeviceTier) {
        self.set_inner(tier, None);
    }

    pub fn set_with_error(&self, tier: DeviceTier, last_error: impl Into<String>) {
        self.set_inner(tier, Some(last_error.into()));
    }

    fn set_inner(&self, tier: DeviceTier, last_error: Option<String>) {
        let entry = DeviceTierEntry {
            device_id: self.device_id.clone(),
            rendezvous_id: self.rendezvous_id.clone(),
            tier,
            last_error,
            updated_at_ms: now_ms(),
        };
        self.map.lock().insert(self.rendezvous_id.clone(), entry);
    }

    /// Reads the most recent tier this writer pushed. Returns `None` if
    /// the entry has been evicted (device unpaired).
    #[allow(dead_code)] // exported for unit tests; not yet consumed by production code
    pub fn current(&self) -> Option<DeviceTier> {
        self.map
            .lock()
            .get(&self.rendezvous_id)
            .map(|entry| entry.tier)
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

pub mod commands {
    //! `#[tauri::command]` surface for the renderer. Wired into
    //! `tauri::Builder::invoke_handler` from `src-tauri/src/lib.rs`.

    use std::sync::Arc;

    use super::{
        DeviceRegistration, DeviceTierEntry, SignalingConfigPatch, SignalingHub,
        SignalingStatus,
    };

    /// Replace the currently-tracked set of paired devices. Idempotent —
    /// the hub diffs against its existing client map and only spawns /
    /// cancels what changed.
    #[tauri::command]
    pub async fn companion_signaling_sync_devices(
        hub: tauri::State<'_, Arc<SignalingHub>>,
        devices: Vec<DeviceRegistration>,
    ) -> Result<(), String> {
        hub.sync_devices(devices);
        Ok(())
    }

    /// Update signaling URL + ICE/TURN servers, and the master enabled
    /// toggle. Restarts every active client to pick up the new config.
    #[tauri::command]
    pub async fn companion_signaling_configure(
        hub: tauri::State<'_, Arc<SignalingHub>>,
        patch: SignalingConfigPatch,
    ) -> Result<(), String> {
        let mut servers: Vec<webrtc::ice_transport::ice_server::RTCIceServer> = patch
            .ice_servers
            .into_iter()
            .map(Into::into)
            .collect();
        servers.extend(patch.turn_servers.into_iter().map(Into::into));
        hub.configure(patch.enabled, patch.signaling_url, servers);
        Ok(())
    }

    /// Diagnostic snapshot — surfaced by the Mobile companion settings
    /// panel under the WebRTC card.
    #[tauri::command]
    pub fn companion_signaling_status(
        hub: tauri::State<'_, Arc<SignalingHub>>,
    ) -> Result<SignalingStatus, String> {
        let inner = hub.inner.lock();
        Ok(SignalingStatus {
            enabled: inner.enabled,
            signaling_url: inner.signaling_url.clone(),
            registered_devices: inner.clients.keys().cloned().collect(),
        })
    }

    /// Per-device tier snapshot — drives the device list rendered by the
    /// desktop WebRTC settings card. Each entry corresponds to one paired
    /// device with a live signaling client task. Devices that were
    /// unpaired (or never had a `rendezvousId` minted) are absent.
    #[tauri::command]
    pub fn companion_signaling_devices_status(
        hub: tauri::State<'_, Arc<SignalingHub>>,
    ) -> Result<Vec<DeviceTierEntry>, String> {
        Ok(hub.devices_status())
    }

    /// Force-restart one device's signaling client. Powers the per-row
    /// "Reconnect" button on the desktop WebRTC settings card. Returns
    /// `Err` when `rendezvous_id` is unknown — that surfaces in the UI as
    /// a `toast.error` so a stale row doesn't appear to work silently.
    #[tauri::command]
    pub async fn companion_signaling_reconnect_device(
        hub: tauri::State<'_, Arc<SignalingHub>>,
        rendezvous_id: String,
    ) -> Result<(), String> {
        hub.reconnect_device(&rendezvous_id)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ice_server_spec_converts_to_rtc_ice_server() {
        let spec = IceServerSpec {
            urls: vec!["turn:t.example:3478".into()],
            username: Some("alice".into()),
            credential: Some("s3cr3t".into()),
        };
        let server: RTCIceServer = spec.into();
        assert_eq!(server.urls, vec!["turn:t.example:3478".to_string()]);
        assert_eq!(server.username, "alice");
        assert_eq!(server.credential, "s3cr3t");
    }

    #[test]
    fn ice_server_spec_omits_optional_fields() {
        let spec = IceServerSpec {
            urls: vec!["stun:s.example:3478".into()],
            username: None,
            credential: None,
        };
        let server: RTCIceServer = spec.into();
        assert_eq!(server.username, "");
        assert_eq!(server.credential, "");
    }

    #[test]
    fn default_hub_has_default_url_and_two_stuns() {
        let hub = SignalingHub::new();
        let inner = hub.inner.lock();
        assert_eq!(inner.signaling_url, DEFAULT_SIGNALING_URL);
        assert_eq!(inner.ice_servers.len(), 2);
        assert!(inner
            .ice_servers
            .iter()
            .any(|s| s.urls[0].starts_with("stun:stun.l.google.com")));
    }

    #[test]
    fn registered_rendezvous_ids_is_empty_on_fresh_hub() {
        let hub = SignalingHub::new();
        assert!(hub.registered_rendezvous_ids().is_empty());
    }

    #[test]
    fn sync_devices_before_bind_caches_pending() {
        // A common boot ordering: the renderer hydrates Dexie and pushes
        // pairedDevices to the hub before `companion_server_start` has had
        // a chance to call `bind()`. The hub must remember the device set
        // and apply it once the binding lands; otherwise the device would
        // never receive an inbound rtc:offer.
        let hub = SignalingHub::new();
        hub.sync_devices(vec![DeviceRegistration {
            device_id: "d1".into(),
            rendezvous_id: "r1".into(),
            rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
        }]);
        // No binding yet — no clients spawned.
        assert!(hub.registered_rendezvous_ids().is_empty());
        // Cached for replay.
        let inner = hub.inner.lock();
        assert_eq!(inner.pending_devices.len(), 1);
        assert_eq!(inner.pending_devices[0].rendezvous_id, "r1");
    }

    #[test]
    fn sync_devices_with_disabled_flag_skips_spawn() {
        let hub = SignalingHub::new();
        hub.configure(false, DEFAULT_SIGNALING_URL.to_string(), vec![]);
        hub.sync_devices(vec![DeviceRegistration {
            device_id: "d1".into(),
            rendezvous_id: "r1".into(),
            rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
        }]);
        assert!(hub.registered_rendezvous_ids().is_empty());
        // …but still cached so re-enabling will pick it up.
        let inner = hub.inner.lock();
        assert_eq!(inner.pending_devices.len(), 1);
    }

    #[test]
    fn sync_devices_diff_removes_missing_ids() {
        let hub = SignalingHub::new();
        hub.sync_devices(vec![
            DeviceRegistration {
                device_id: "d1".into(),
                rendezvous_id: "r1".into(),
                rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
            },
            DeviceRegistration {
                device_id: "d2".into(),
                rendezvous_id: "r2".into(),
                rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
            },
        ]);
        // Reducing to a single device should evict r2 from pending.
        hub.sync_devices(vec![DeviceRegistration {
            device_id: "d1".into(),
            rendezvous_id: "r1".into(),
            rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
        }]);
        let inner = hub.inner.lock();
        assert_eq!(inner.pending_devices.len(), 1);
        assert_eq!(inner.pending_devices[0].rendezvous_id, "r1");
    }

    #[test]
    fn tier_writer_roundtrip_and_overwrite() {
        let hub = SignalingHub::new();
        let w = hub.new_tier_writer("r1", "d1");
        assert!(w.current().is_none());
        w.set(DeviceTier::Awaiting);
        assert_eq!(w.current(), Some(DeviceTier::Awaiting));
        w.set(DeviceTier::Connected);
        assert_eq!(w.current(), Some(DeviceTier::Connected));
        // Same hub returns the same shared map — a second writer for the
        // same rendezvous reads what the first wrote.
        let w2 = hub.new_tier_writer("r1", "d1");
        assert_eq!(w2.current(), Some(DeviceTier::Connected));
    }

    #[test]
    fn tier_writer_set_with_error_carries_message() {
        let hub = SignalingHub::new();
        let w = hub.new_tier_writer("r1", "d1");
        w.set_with_error(DeviceTier::Failed, "connection refused");
        let entries = hub.devices_status();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].tier, DeviceTier::Failed);
        assert_eq!(entries[0].last_error.as_deref(), Some("connection refused"));
        // A clean `set` after a `Failed` clears the error message so the
        // UI doesn't keep showing a stale reason next to a healthy tier.
        w.set(DeviceTier::Connected);
        let entries = hub.devices_status();
        assert!(entries[0].last_error.is_none());
    }

    #[test]
    fn devices_status_sorted_by_device_id() {
        let hub = SignalingHub::new();
        hub.new_tier_writer("rB", "device-banana").set(DeviceTier::Connected);
        hub.new_tier_writer("rA", "device-apple").set(DeviceTier::Awaiting);
        hub.new_tier_writer("rC", "device-cherry").set(DeviceTier::Negotiating);
        let entries = hub.devices_status();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].device_id, "device-apple");
        assert_eq!(entries[1].device_id, "device-banana");
        assert_eq!(entries[2].device_id, "device-cherry");
    }

    #[test]
    fn cancel_one_evicts_tier_entry() {
        let hub = SignalingHub::new();
        hub.new_tier_writer("r1", "d1").set(DeviceTier::Connected);
        assert_eq!(hub.devices_status().len(), 1);
        hub.cancel_one("r1");
        assert!(hub.devices_status().is_empty());
    }

    #[test]
    fn reconnect_device_unknown_rendezvous_id_errors() {
        let hub = SignalingHub::new();
        let err = hub.reconnect_device("does-not-exist").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn reconnect_device_returns_ok_when_disabled_with_known_id() {
        // The renderer pushed the device before the master toggle was
        // re-enabled, or the user just disabled it. Reconnect should
        // succeed silently — flipping the toggle back on will re-spawn.
        let hub = SignalingHub::new();
        hub.configure(false, DEFAULT_SIGNALING_URL.to_string(), vec![]);
        hub.sync_devices(vec![DeviceRegistration {
            device_id: "d1".into(),
            rendezvous_id: "r1".into(),
            rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
        }]);
        // Pre-condition: no clients spawned because hub is disabled.
        assert!(hub.registered_rendezvous_ids().is_empty());
        // The device is still in the pending_devices cache, so a
        // reconnect call against it is a known id → Ok(()).
        assert!(hub.reconnect_device("r1").is_ok());
        // Still no client (hub disabled).
        assert!(hub.registered_rendezvous_ids().is_empty());
    }

    #[test]
    fn reconnect_device_unknown_rendezvous_id_errors_after_some_devices() {
        let hub = SignalingHub::new();
        hub.sync_devices(vec![DeviceRegistration {
            device_id: "d1".into(),
            rendezvous_id: "r1".into(),
            rendezvous_secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(),
        }]);
        // r1 is in pending_devices but no `bind()` was called, so
        // reconnect should surface the "hub not bound" condition rather
        // than the "not found" condition.
        let err = hub.reconnect_device("r1").unwrap_err();
        assert!(err.contains("not bound"));
        // Unknown ids surface "not found" regardless of bind state.
        let err = hub.reconnect_device("r-nope").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn clear_clients_clears_tier_table() {
        let hub = SignalingHub::new();
        hub.new_tier_writer("r1", "d1").set(DeviceTier::Connected);
        hub.new_tier_writer("r2", "d2").set(DeviceTier::Failed);
        assert_eq!(hub.devices_status().len(), 2);
        hub.clear_clients();
        assert!(hub.devices_status().is_empty());
    }

    #[test]
    fn device_tier_serializes_as_kebab_case() {
        let json = serde_json::to_string(&DeviceTier::Negotiating).unwrap();
        assert_eq!(json, "\"negotiating\"");
        let json = serde_json::to_string(&DeviceTier::Awaiting).unwrap();
        assert_eq!(json, "\"awaiting\"");
    }

    #[test]
    fn device_tier_entry_camel_case_field_names() {
        let entry = DeviceTierEntry {
            device_id: "d1".into(),
            rendezvous_id: "r1".into(),
            tier: DeviceTier::Connected,
            last_error: None,
            updated_at_ms: 42,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"deviceId\":\"d1\""));
        assert!(json.contains("\"rendezvousId\":\"r1\""));
        assert!(json.contains("\"tier\":\"connected\""));
        assert!(json.contains("\"updatedAtMs\":42"));
        // `last_error` is `None` — should be omitted by `skip_serializing_if`.
        assert!(!json.contains("lastError"));
    }
}
