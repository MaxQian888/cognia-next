//! A2A server — cognia as an Agent2Agent (a2a-protocol.org) agent.
//!
//! Exposes two routes on the companion HTTP front door:
//! - `GET /.well-known/agent-card.json` — public Agent Card for discovery.
//! - `POST /a2a` — the A2A JSON-RPC endpoint (device-JWT gated).
//!
//! Like the sibling ACP server, every method reaches the host-generic
//! `claude_*` dispatch arms through `rpc::dispatch`, so the surface works on
//! both the desktop Tauri app and the headless `cognia-server`. The frame
//! translation is *shared* with ACP (`super::acp::translate`); this module only
//! reshapes the result into A2A `Task`/`Message` terms.
//!
//! Module layout:
//! - [`wire`]    — A2A wire shapes + `parts → SendContent` conversion.
//! - [`turn`]    — per-turn accumulator folding ACP actions into A2A.
//! - [`store`]   — process-wide task snapshot store (`tasks/get`/`cancel`).
//! - [`handler`] — axum handlers + the blocking `message/send` driver.
//!
//! Scope (MVP): `message/send` (blocking), `tasks/get`, `tasks/cancel`. The
//! Agent Card advertises `streaming:false`; `message/stream` returns an
//! `UnsupportedOperation` error until the streaming surface lands.

pub mod handler;
pub mod store;
pub mod turn;
pub mod wire;

pub use handler::{a2a_agent_card_handler, a2a_rpc_handler};

use serde_json::{json, Value};

/// Build cognia's A2A Agent Card. `base_url` is the externally reachable
/// origin the client used (e.g. `https://host:47820`); the advertised A2A
/// endpoint is `{base_url}/a2a`.
pub fn agent_card(base_url: &str) -> Value {
    let base = base_url.trim_end_matches('/');
    json!({
        "protocolVersion": wire::A2A_PROTOCOL_VERSION,
        "name": "Cognia",
        "description": "Cognia personal AI — drive Claude sessions, tools, skills, and teams over A2A.",
        "url": format!("{base}/a2a"),
        "preferredTransport": "JSONRPC",
        "version": env!("CARGO_PKG_VERSION"),
        "provider": { "organization": "Cognia", "url": "https://cognia.cn" },
        "capabilities": {
            "streaming": false,
            "pushNotifications": false,
            "stateTransitionHistory": false,
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "securitySchemes": {
            "bearer": {
                "type": "http",
                "scheme": "bearer",
                "description": "Cognia device JWT — pair with the desktop/cloud to obtain one.",
            },
        },
        "security": [{ "bearer": [] }],
        "skills": [
            {
                "id": "chat",
                "name": "Chat",
                "description": "Send a message to Cognia and receive a grounded reply. Tool calls that require interactive approval are declined automatically on this surface.",
                "tags": ["chat", "assistant", "claude"],
                "inputModes": ["text/plain"],
                "outputModes": ["text/plain"],
            },
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_card_shape() {
        let card = agent_card("https://host:47820/");
        assert_eq!(card["protocolVersion"], "0.3.0");
        assert_eq!(card["name"], "Cognia");
        // Trailing slash trimmed, /a2a appended once.
        assert_eq!(card["url"], "https://host:47820/a2a");
        assert_eq!(card["preferredTransport"], "JSONRPC");
        assert_eq!(card["capabilities"]["streaming"], false);
        assert_eq!(card["securitySchemes"]["bearer"]["scheme"], "bearer");
        assert_eq!(card["skills"][0]["id"], "chat");
        assert!(card["version"].as_str().is_some());
    }
}
