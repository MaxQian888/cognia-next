//! Stable error codes for the `cognia:plugin@0.2.0` contract.
//!
//! Every `result<..., string>` error the host returns to a guest carries a
//! machine-parseable prefix:
//!
//! ```text
//! "<CODE>: <human-readable message>"
//! ```
//!
//! Guests branch on the code via `split_once(": ")`. The codes are stable for
//! the life of the 0.2 contract; the trailing text is human-facing and may
//! change in any release. This mirrors the idiom v0.1 established with
//! `cognia:not-implemented`, but with a closed vocabulary instead of one code.

use std::fmt;

/// The closed set of error codes a v0.2 guest may observe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WasmErrorCode {
    /// The plugin was not granted the capability the call requires.
    CapabilityDenied,
    /// Malformed or out-of-range arguments.
    InvalidRequest,
    /// An argument or a response exceeded the documented cap.
    PayloadTooLarge,
    /// The host gave up waiting on the backing service.
    Timeout,
    /// The plugin was deactivated or unloaded mid-call.
    Cancelled,
    /// This host build has no backend for the capability (headless clipboard,
    /// unreachable renderer). Distinct from `PROVIDER_ERROR`: nothing failed,
    /// there was simply nothing to call.
    HostUnavailable,
    /// The backing service answered with a failure.
    ProviderError,
    /// The workflow runtime refused the event. A normal, retryable outcome.
    WorkflowRejected,
    /// The plugin was built against an api-version this host does not serve.
    /// Not reachable from a guest — a plugin that gets this never instantiated.
    UpgradeRequired,
}

impl WasmErrorCode {
    /// Every variant, so tests can assert the vocabulary exhaustively.
    pub const ALL: &'static [WasmErrorCode] = &[
        WasmErrorCode::CapabilityDenied,
        WasmErrorCode::InvalidRequest,
        WasmErrorCode::PayloadTooLarge,
        WasmErrorCode::Timeout,
        WasmErrorCode::Cancelled,
        WasmErrorCode::HostUnavailable,
        WasmErrorCode::ProviderError,
        WasmErrorCode::WorkflowRejected,
        WasmErrorCode::UpgradeRequired,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            WasmErrorCode::CapabilityDenied => "CAPABILITY_DENIED",
            WasmErrorCode::InvalidRequest => "INVALID_REQUEST",
            WasmErrorCode::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            WasmErrorCode::Timeout => "TIMEOUT",
            WasmErrorCode::Cancelled => "CANCELLED",
            WasmErrorCode::HostUnavailable => "HOST_UNAVAILABLE",
            WasmErrorCode::ProviderError => "PROVIDER_ERROR",
            WasmErrorCode::WorkflowRejected => "WORKFLOW_REJECTED",
            WasmErrorCode::UpgradeRequired => "UPGRADE_REQUIRED",
        }
    }

    /// Map a code string that arrived from the renderer back onto the closed
    /// vocabulary.
    ///
    /// Anything unrecognised becomes [`WasmErrorCode::ProviderError`]. This is a
    /// security boundary, not just tidiness: without it, a compromised or buggy
    /// renderer could hand a guest a forged `CAPABILITY_DENIED` (or, worse, a
    /// forged code the guest treats as retryable) for a request the host
    /// actually authorized.
    pub fn from_renderer_code(code: &str) -> WasmErrorCode {
        WasmErrorCode::ALL
            .iter()
            .copied()
            // `UpgradeRequired` is a load-time host verdict; a renderer must
            // never be able to claim it.
            .filter(|c| !matches!(c, WasmErrorCode::UpgradeRequired))
            .find(|c| c.as_str() == code)
            .unwrap_or(WasmErrorCode::ProviderError)
    }
}

impl fmt::Display for WasmErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Build the wire-format error string: `"<CODE>: <message>"`.
pub fn coded(code: WasmErrorCode, message: impl AsRef<str>) -> String {
    format!("{}: {}", code.as_str(), message.as_ref())
}

/// The actionable rebuild message a v0.1 plugin's author sees.
///
/// Deliberately verbose: this is the only feedback an author gets, it arrives
/// once, and every step is required. Naming the plugin matters because a user
/// upgrading with several v0.1 plugins installed needs to know which one.
pub fn upgrade_required(plugin_id: Option<&str>, plugin_api_version: &str) -> String {
    let subject = match plugin_id {
        Some(id) => format!("plugin `{id}`"),
        None => "this plugin".to_string(),
    };
    coded(
        WasmErrorCode::UpgradeRequired,
        format!(
            "{subject} was built against cognia:plugin@{plugin_api_version}; this host runs \
             0.2.x only. Rebuild against v0.2: set `wasm.apiVersion` to \"0.2.0\" in plugin.json, \
             replace `wit/world.wit` with the v0.2 contract from the SDK \
             (`plugin-sdk/wit/cognia-plugin.wit`), handle the new `result<_, string>` return from \
             `notification.notify`, change the AI permission from `network:fetch` to `ai:chat` if \
             you call `ai.generate-text`, add `extension:workflow` if you call \
             `workflow.emit-event`, then run `cognia plugin build`. There is no v0.1 \
             compatibility shim."
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_a_stable_string() {
        // Adding a variant without extending ALL fails the length assertion;
        // adding one without extending `as_str` fails to compile the match.
        assert_eq!(WasmErrorCode::ALL.len(), 9);
        let expected = [
            "CAPABILITY_DENIED",
            "INVALID_REQUEST",
            "PAYLOAD_TOO_LARGE",
            "TIMEOUT",
            "CANCELLED",
            "HOST_UNAVAILABLE",
            "PROVIDER_ERROR",
            "WORKFLOW_REJECTED",
            "UPGRADE_REQUIRED",
        ];
        let actual: Vec<&str> = WasmErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn codes_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for code in WasmErrorCode::ALL {
            assert!(
                seen.insert(code.as_str()),
                "duplicate code {}",
                code.as_str()
            );
        }
    }

    #[test]
    fn coded_prefix_is_parseable() {
        let msg = coded(WasmErrorCode::Timeout, "renderer did not answer");
        assert_eq!(msg, "TIMEOUT: renderer did not answer");
        let (code, detail) = msg.split_once(": ").expect("separator present");
        assert_eq!(code, "TIMEOUT");
        assert_eq!(detail, "renderer did not answer");
    }

    #[test]
    fn from_renderer_code_round_trips_known_codes() {
        for code in WasmErrorCode::ALL {
            if matches!(code, WasmErrorCode::UpgradeRequired) {
                continue;
            }
            assert_eq!(WasmErrorCode::from_renderer_code(code.as_str()), *code);
        }
    }

    #[test]
    fn from_renderer_code_downgrades_unknown_codes() {
        assert_eq!(
            WasmErrorCode::from_renderer_code("NOT_A_CODE"),
            WasmErrorCode::ProviderError
        );
        assert_eq!(
            WasmErrorCode::from_renderer_code(""),
            WasmErrorCode::ProviderError
        );
        // Case matters — the vocabulary is uppercase.
        assert_eq!(
            WasmErrorCode::from_renderer_code("capability_denied"),
            WasmErrorCode::ProviderError
        );
    }

    #[test]
    fn a_renderer_cannot_forge_upgrade_required() {
        // UPGRADE_REQUIRED is a load-time host verdict. If a renderer could
        // claim it, a guest would be told to rebuild over a transient failure.
        assert_eq!(
            WasmErrorCode::from_renderer_code("UPGRADE_REQUIRED"),
            WasmErrorCode::ProviderError
        );
    }

    #[test]
    fn upgrade_required_message_is_actionable() {
        let msg = upgrade_required(Some("acme.formatter"), "0.1.0");
        assert!(msg.starts_with("UPGRADE_REQUIRED: "));
        for needle in [
            "acme.formatter",
            "0.1.0",
            "0.2.x",
            "wasm.apiVersion",
            "notification.notify",
            "ai:chat",
            "extension:workflow",
            "cognia plugin build",
        ] {
            assert!(msg.contains(needle), "missing {needle:?} in: {msg}");
        }
    }

    #[test]
    fn upgrade_required_without_a_plugin_id_still_reads_well() {
        let msg = upgrade_required(None, "0.1.3");
        assert!(msg.contains("this plugin was built against cognia:plugin@0.1.3"));
    }
}
