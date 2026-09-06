//! What `/healthz` advertises about this rendezvous, shared by both backends.
//!
//! A client that wants to know whether the relay in front of it can carry
//! the application data lane (ADR-0170) used to have no way to ask: the
//! liveness JSON said `ok` and a version string, and a pre-lane deployment
//! answers exactly the same `ok`. It then forwards `data`-lane frames under
//! the signal lane's 8 KiB cap, so a paired device sees a relay that
//! "works" until the first frame that does not fit. The capabilities block
//! names the lanes this build serves, so the settings surface can say
//! "relay reachable, data lane missing" instead of "relay reachable".

use serde::{Deserialize, Serialize};

use crate::proto::RelayLane;

/// The wire-protocol generation this build speaks. Bumped when a new frame
/// kind or lane is added, so a client can compare numbers instead of
/// guessing from a version string.
pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub protocol: u32,
    /// Every lane the server budgets separately. A build without the data
    /// lane lists only `signal`.
    pub lanes: Vec<String>,
    /// Convenience for the client: `lanes` contains `data`.
    pub relay_data_lane: bool,
}

/// The capabilities of *this* build.
pub fn capabilities() -> Capabilities {
    let lanes = vec![
        RelayLane::Signal.as_str().to_string(),
        RelayLane::Data.as_str().to_string(),
    ];
    Capabilities {
        protocol: PROTOCOL_VERSION,
        relay_data_lane: lanes.iter().any(|lane| lane == RelayLane::Data.as_str()),
        lanes,
    }
}

/// Every `/healthz` response carries this so a browser tab on any origin can
/// read it. The endpoint is public liveness with no secret in it, and the
/// settings surface that probes it is a static export served from an origin
/// the relay has never heard of.
pub const CORS_ALLOW_ORIGIN_HEADER: (&str, &str) = ("access-control-allow-origin", "*");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_build_advertises_both_lanes_and_the_flag_agrees_with_the_list() {
        let caps = capabilities();
        assert_eq!(caps.protocol, PROTOCOL_VERSION);
        assert_eq!(caps.lanes, vec!["signal".to_string(), "data".to_string()]);
        assert!(caps.relay_data_lane);
    }

    #[test]
    fn serializes_camel_case_for_the_renderer() {
        let json = serde_json::to_value(capabilities()).unwrap();
        assert_eq!(json["protocol"], 2);
        assert_eq!(json["relayDataLane"], true);
        assert_eq!(json["lanes"][1], "data");
    }
}
