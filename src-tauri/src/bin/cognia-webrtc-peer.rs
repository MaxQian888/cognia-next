//! `cognia-webrtc-peer` — headless desktop answerer for the WebRTC pair
//! harness (ADR-0021).
//!
//! This binary exists so `pnpm webrtc:pair` can drive the **production**
//! desktop WebRTC peer against a **real browser** `RTCPeerConnection` through a
//! **real** `cognia-signaling-server`. It is a thin `main()` around the same
//! code the desktop app runs:
//!
//! - [`SignalingHub`] — the real hub, driven through its real
//!   `configure()` / `sync_devices()` surface (so device diffing, tier
//!   bookkeeping, and client spawn/cancel are all exercised);
//! - `signaling::client` — the real WSS session loop, envelope sign/verify,
//!   replay window, and ICE-restart handling;
//! - `signaling::peer` — the real `webrtc-rs` answerer;
//! - `signaling::dispatch` — the real DataChannel ⇄ RPC/EventBus bridge.
//!
//! What it does **not** bring is a `tauri::AppHandle` or a headless services
//! registry, so `DispatchHost::from_state` resolves to `None` and inbound RPCs
//! answer the documented `service_unavailable` frame (same contract the HTTP
//! path returns in a bare state). That is deliberate: the harness's job is to
//! prove the transport, not to re-test the dispatch table, which already has
//! its own unit coverage.
//!
//! Gated behind the `webrtc-harness` cargo feature so normal desktop builds
//! never compile it:
//!
//! ```bash
//! cargo build --features webrtc-harness --bin cognia-webrtc-peer
//! ```
//!
//! ## Protocol (stdio)
//!
//! Emits one JSON object per line on **stdout**:
//!
//! - `{"kind":"ready"}` once the hub has spawned the device client
//! - `{"kind":"tier","tier":"awaiting|negotiating|connected|failed|offline",
//!    "lastError":…}` on every tier transition
//!
//! Reads one command per line on **stdin**:
//!
//! - `emit-event <eventType> <jsonPayload>` — publish an `EventBus` frame; the
//!   dispatcher forwards it over the open DataChannel so the browser side can
//!   assert delivery + `seq` monotonicity
//! - `quit` — cancel the device client and exit 0

use std::sync::Arc;
use std::time::Duration;

use app_lib::companion_api::signaling::{DeviceRegistration, SignalingHub};
use app_lib::companion_api::{
    deny_list::DenyList, desktop_messages_bridge::DesktopMessagesBridge,
    desktop_writes_bridge::DesktopWritesBridge, event_bus::EventBus, idempotency::IdempotencyCache,
    push::PushTokenRegistry, rate_limit::RateLimiter, sync_bridge::SyncBridge,
    sync_registry::SyncTableRegistry, CompanionState, SharedState,
};
use cognia_signaling_core::proto::RoomDescriptor;
use parking_lot::RwLock;
use tokio::io::{AsyncBufReadExt, BufReader};

/// Minimal CLI. Hand-rolled rather than `clap`-derived: the harness is the
/// only caller and the arg set is fixed, so a dependency + derive macro would
/// be more machinery than the four flags justify.
#[derive(Debug, PartialEq, Eq)]
struct Args {
    signaling_url: String,
    rendezvous_id: String,
    room_descriptor: RoomDescriptor,
    signing_private_key: String,
    device_id: String,
}

fn parse_args() -> Result<Args, String> {
    parse_args_from(std::env::args().skip(1))
}

fn parse_args_from<I, S>(args: I) -> Result<Args, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut signaling_url = None;
    let mut rendezvous_id = None;
    let mut room_descriptor = None;
    let mut signing_private_key = None;
    let mut device_id = None;

    let mut argv = args.into_iter().map(Into::into);
    while let Some(flag) = argv.next() {
        let mut take = |name: &str| -> Result<String, String> {
            argv.next()
                .ok_or_else(|| format!("{name} requires a value"))
        };
        match flag.as_str() {
            "--signaling" => signaling_url = Some(take("--signaling")?),
            "--rid" => rendezvous_id = Some(take("--rid")?),
            "--room-descriptor" => {
                let raw = take("--room-descriptor")?;
                room_descriptor = Some(
                    serde_json::from_str(&raw)
                        .map_err(|error| format!("--room-descriptor is invalid: {error}"))?,
                );
            }
            "--signing-private-key" => signing_private_key = Some(take("--signing-private-key")?),
            "--device-id" => device_id = Some(take("--device-id")?),
            other => return Err(format!("unknown flag: {other}")),
        }
    }

    Ok(Args {
        signaling_url: signaling_url.ok_or("--signaling is required")?,
        rendezvous_id: rendezvous_id.ok_or("--rid is required")?,
        room_descriptor: room_descriptor.ok_or("--room-descriptor is required")?,
        signing_private_key: signing_private_key.ok_or("--signing-private-key is required")?,
        device_id: device_id.ok_or("--device-id is required")?,
    })
}

/// Build the same `SharedState` shape `cognia-server` builds, minus every
/// service the WebRTC transport doesn't touch. `app_handle: None` is the
/// documented bare-state configuration (see `companion_api::CompanionState`).
fn harness_state() -> SharedState {
    Arc::new(CompanionState {
        secret: RwLock::new(vec![0u8; 32]),
        deny_list: Arc::new(DenyList::new()),
        app_handle: None,
        idempotency: Arc::new(IdempotencyCache::new()),
        event_bus: EventBus::new(),
        sync_bridge: SyncBridge::new(),
        desktop_messages_bridge: DesktopMessagesBridge::new(),
        desktop_writes_bridge: DesktopWritesBridge::new(),
        sync_registry: SyncTableRegistry::with_defaults(),
        rate_limiter: RateLimiter::with_defaults(),
        push_tokens: PushTokenRegistry::new(),
    })
}

fn emit(line: serde_json::Value) {
    println!("{line}");
    use std::io::Write as _;
    let _ = std::io::stdout().flush();
}

/// Minimal stderr logger — same shape as `cognia-server`'s, so the harness
/// carries no new logging dependency. Keeps the session loop's `log::` output
/// on **stderr**, leaving **stdout** exclusively for the JSON protocol the
/// driver parses.
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("[{}] {}", record.level(), record.args());
    }
    fn flush(&self) {}
}

static STDERR_LOGGER: StderrLogger = StderrLogger;

#[tokio::main]
async fn main() -> Result<(), String> {
    app_lib::proxy_config::clear_inherited_proxy_environment();
    app_lib::proxy_config::apply_current(Default::default()).map_err(|error| error.to_string())?;
    let level = match std::env::var("COGNIA_LOG").as_deref() {
        Ok("error") => log::LevelFilter::Error,
        Ok("warn") => log::LevelFilter::Warn,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("trace") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    };
    log::set_logger(&STDERR_LOGGER).ok();
    log::set_max_level(level);

    let args = parse_args()?;
    let state = harness_state();
    let hub = SignalingHub::new();

    // Real production path: bind → configure → sync_devices. No STUN servers —
    // the harness runs both peers on loopback, where host candidates are
    // sufficient and a public STUN round-trip would only add flake.
    hub.bind(Arc::clone(&state));
    hub.configure(true, args.signaling_url.clone(), Vec::new());
    hub.sync_harness_device(
        DeviceRegistration {
            device_id: args.device_id.clone(),
            rendezvous_id: args.rendezvous_id.clone(),
            room_descriptor: args.room_descriptor.clone(),
            signaling_key_ref: "webrtc-harness".into(),
        },
        args.signing_private_key.clone(),
    )?;

    emit(serde_json::json!({ "kind": "ready", "deviceId": args.device_id }));

    // Tier reporter: poll the hub's snapshot and emit on change. The hub
    // exposes a snapshot rather than a stream, so polling is the available
    // seam; 100 ms is far below the harness's assertion timeouts.
    {
        let hub = Arc::clone(&hub);
        tokio::spawn(async move {
            let mut last: Option<String> = None;
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let Some(entry) = hub.devices_status().into_iter().next() else {
                    continue;
                };
                let tier = format!("{:?}", entry.tier).to_lowercase();
                if last.as_deref() == Some(tier.as_str()) {
                    continue;
                }
                last = Some(tier.clone());
                emit(serde_json::json!({
                    "kind": "tier",
                    "tier": tier,
                    "lastError": entry.last_error,
                }));
            }
        });
    }

    // Command loop on stdin.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "quit" {
            break;
        }
        if let Some(rest) = line.strip_prefix("emit-event ") {
            let (event_type, payload_raw) = rest.split_once(' ').unwrap_or((rest, "null"));
            let payload: serde_json::Value =
                serde_json::from_str(payload_raw).unwrap_or(serde_json::Value::Null);
            let frame = state.event_bus.publish(event_type.to_string(), payload);
            emit(serde_json::json!({
                "kind": "emitted",
                "event": frame.event_type,
                "seq": frame.seq,
            }));
            continue;
        }
        emit(serde_json::json!({ "kind": "error", "message": format!("unknown command: {line}") }));
    }

    hub.sync_devices(Vec::new());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_args_from, Args};
    use cognia_signaling_core::proto::RoomDescriptor;

    #[test]
    fn parses_every_required_harness_argument() {
        assert_eq!(
            parse_args_from([
                "--signaling",
                "ws://127.0.0.1:8787/signaling",
                "--rid",
                "room-1",
                "--room-descriptor",
                r#"{"v":2,"roomId":"room-1","roomNonce":"nonce","desktopSigningKey":"desktop","mobileSigningKey":"mobile","notAfter":1900000000000}"#,
                "--signing-private-key",
                "private-key",
                "--device-id",
                "device-1",
            ]),
            Ok(Args {
                signaling_url: "ws://127.0.0.1:8787/signaling".to_string(),
                rendezvous_id: "room-1".to_string(),
                room_descriptor: RoomDescriptor {
                    v: 2,
                    room_id: "room-1".into(),
                    room_nonce: "nonce".into(),
                    desktop_signing_key: "desktop".into(),
                    mobile_signing_key: "mobile".into(),
                    not_after: 1_900_000_000_000,
                },
                signing_private_key: "private-key".to_string(),
                device_id: "device-1".to_string(),
            })
        );
    }

    #[test]
    fn rejects_missing_values_and_required_flags() {
        assert_eq!(
            parse_args_from(["--signaling"]),
            Err("--signaling requires a value".to_string())
        );
        assert_eq!(
            parse_args_from([
                "--signaling",
                "ws://localhost",
                "--rid",
                "room-1",
                "--room-descriptor",
                r#"{"v":2,"roomId":"room-1","roomNonce":"nonce","desktopSigningKey":"desktop","mobileSigningKey":"mobile","notAfter":1900000000000}"#,
                "--signing-private-key",
                "private-key",
            ]),
            Err("--device-id is required".to_string())
        );
    }

    #[test]
    fn rejects_unknown_flags() {
        assert_eq!(
            parse_args_from(["--wat"]),
            Err("unknown flag: --wat".to_string())
        );
    }
}
