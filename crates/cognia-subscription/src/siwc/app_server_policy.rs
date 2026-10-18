//! Pure native app-server routing policy, independent of the desktop shell.
//! Keeping this in the credential owner permits fixture verification without
//! launching a real desktop profile or reading any CLI authentication files.
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn provider_args(base_url: &str) -> Vec<String> {
    let mut args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    for setting in [
        "model_provider=\"cognia_siwc\"".to_string(),
        "model_providers.cognia_siwc.name=\"ChatGPT plan\"".into(),
        format!(
            "model_providers.cognia_siwc.base_url={}",
            serde_json::to_string(base_url).unwrap()
        ),
        "model_providers.cognia_siwc.env_key=\"COGNIA_AGENT_SIWC_CAPABILITY\"".into(),
        "model_providers.cognia_siwc.wire_api=\"responses\"".into(),
        "model_providers.cognia_siwc.requires_openai_auth=false".into(),
        "model_providers.cognia_siwc.supports_websockets=false".into(),
        "model_providers.cognia_siwc.request_max_retries=0".into(),
        "model_providers.cognia_siwc.stream_max_retries=0".into(),
        "cli_auth_credentials_store=\"file\"".into(),
        "web_search=\"disabled\"".into(),
        "features.tool_search=false".into(),
    ] {
        args.push("-c".into());
        args.push(setting);
    }
    args
}

pub fn state_key(profile: &str, connection: &str, host: &str) -> String {
    let digest = Sha256::digest(serde_json::to_vec(&(profile, connection, host)).unwrap());
    format!(
        "siwc-{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

/// RPC cannot switch the immutable provider or import another CLI's history.
/// Only read-only account metadata is supported on this independent provider.
pub fn validate_message(message: &str) -> Result<(), String> {
    if message.len() > 16 * 1024 * 1024 {
        return Err("siwc_request_too_large".into());
    }
    let value: Value = serde_json::from_str(message.trim()).map_err(|_| "siwc_invalid_rpc")?;
    let object = value.as_object().ok_or("siwc_invalid_rpc")?;
    if let Some(method) = object.get("method").and_then(Value::as_str) {
        if method.starts_with("account/")
            && !matches!(method, "account/read" | "account/rateLimits/read")
        {
            return Err("siwc_auth_rpc_forbidden".into());
        }
        if method.starts_with("config/")
            && !matches!(
                method,
                "config/read" | "configRequirements/read" | "config/mcpServer/reload"
            )
        {
            return Err("siwc_config_rpc_forbidden".into());
        }
        if method == "initialize"
            && value
                .pointer("/params/clientInfo/name")
                .and_then(Value::as_str)
                != Some("cognia")
        {
            return Err("siwc_client_mismatch".into());
        }
        if let Some(params) = value.get("params").and_then(Value::as_object) {
            if method == "account/read" && params.get("refreshToken") == Some(&Value::Bool(true)) {
                return Err("siwc_auth_rpc_forbidden".into());
            }
            for key in ["modelProvider", "model_provider", "path", "history"] {
                if params.get(key).is_some_and(|v| !v.is_null()) {
                    return Err("siwc_provider_override_forbidden".into());
                }
            }
            if let Some(config) = params.get("config").and_then(Value::as_object) {
                for key in config.keys() {
                    if !(key == "mcp_servers" || key.starts_with("mcp_servers.")) {
                        return Err("siwc_provider_override_forbidden".into());
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_is_fixed_http_without_cli_auth_or_inference_retries() {
        let args = provider_args("http://127.0.0.1:1234/v1").join(" ");
        for expected in [
            "requires_openai_auth=false",
            "supports_websockets=false",
            "request_max_retries=0",
            "stream_max_retries=0",
            "cli_auth_credentials_store=\"file\"",
            "env_key=\"COGNIA_AGENT_SIWC_CAPABILITY\"",
        ] {
            assert!(args.contains(expected));
        }
        assert!(args.contains("127.0.0.1:1234/v1"));
    }
    #[test]
    fn isolated_history_key_pins_profile_registration_and_host() {
        let key = state_key("a", "b", "c");
        assert!(key.len() < 128 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        for tuple in [
            ("other", "b", "c"),
            ("a", "other", "c"),
            ("a", "b", "other"),
        ] {
            assert_ne!(key, state_key(tuple.0, tuple.1, tuple.2));
        }
        assert_ne!(state_key("a:b", "c", "d"), state_key("a", "b:c", "d"));
    }
    #[test]
    fn authentication_provider_mutations_and_imported_history_are_refused() {
        for request in [
            json!({"method":"account/login/start"}),
            json!({"method":"account/logout"}),
            json!({"method":"account/read","params":{"refreshToken":true}}),
            json!({"method":"config/value/write"}),
            json!({"method":"thread/resume","params":{"path":"other-history"}}),
            json!({"method":"thread/start","params":{"modelProvider":"openai"}}),
            json!({"method":"thread/start","params":{"config":{"model_provider":"openai"}}}),
            json!({"method":"initialize","params":{"clientInfo":{"name":"other"}}}),
        ] {
            assert!(validate_message(&request.to_string()).is_err());
        }
        for request in [
            json!({"method":"initialize","params":{"clientInfo":{"name":"cognia"}}}),
            json!({"method":"thread/resume","params":{"threadId":"thread-test"}}),
            json!({"method":"thread/start","params":{"config":{"mcp_servers":{}}}}),
            json!({"method":"account/read","params":{"refreshToken":false}}),
        ] {
            assert!(validate_message(&request.to_string()).is_ok());
        }
    }
}
