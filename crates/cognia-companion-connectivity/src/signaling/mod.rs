//! The WebRTC signaling leaves (ADR-0021).
//!
//! - [`envelope`] — ECDSA/ECDH/AES-GCM signaling protocol.
//! - [`peer`] — `webrtc-rs` `RTCPeerConnection` wrapper.
//! - [`carrier`] — where the dispatcher's frames go: the DataChannel when
//!   one is open, else the relay's data lane (ADR-0170).
//! - [`datachannel_framing`] — chunking and reassembly of DataChannel
//!   messages and binary resources.
//! - [`registration_store`] — the persisted device registrations.
//!
//! The hub, the WSS client, the dispatcher and the pairing rooms read
//! companion state, so they stay in the desktop's `companion_api::signaling`,
//! which re-exports these modules and the wire shapes below.

pub mod carrier;
pub mod datachannel_framing;
pub mod envelope;
pub mod peer;
pub mod registration_store;

use serde::{Deserialize, Serialize};
use webrtc::peer_connection::RTCIceServer;

// ---------------------------------------------------------------------------
// Device registration wire shapes
// ---------------------------------------------------------------------------

/// Per-device configuration the renderer pushes via
/// `companion_signaling_sync_devices`. One entry per paired device that
/// has a room descriptor and a host signing-key reference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration {
    pub device_id: String,
    pub rendezvous_id: String,
    pub room_descriptor: cognia_signaling_core::proto::RoomDescriptor,
    pub signaling_key_ref: String,
}

/// Configuration patch the renderer pushes via
/// `companion_signaling_configure` (called whenever the user edits the
/// WebRTC card in settings).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalingConfigPatch {
    pub enabled: bool,
    pub signaling_url: String,
    /// Plain `RTCIceServer` URL list (one entry per row in the textarea).
    pub ice_servers: Vec<IceServerSpec>,
    pub turn_servers: Vec<IceServerSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
        }
    }
}

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
}
