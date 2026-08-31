//! `cognia:plugin/ai` host import — `generate-text` only.

use super::super::errors::{coded, WasmErrorCode};
use super::super::store::HostState;
use super::require;

/// The 1 MiB prompt cap. Stricter than the bridge's 4 MiB generic envelope
/// limit, and enforced earlier, so an oversized prompt never reaches the
/// pending-request pool.
pub const MAX_PROMPT_BYTES: usize = 1_000_000;

#[derive(Debug, Clone, Default)]
pub struct GenerateOptions {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub model: Option<String>,
}

/// AI generation requires `ai:chat`.
///
/// v0.1 gated this on `network:fetch` on the reasoning that the call ends up
/// on an HTTPS endpoint. That conflated two different consent decisions:
/// `network:fetch` grants raw outbound HTTP, while this route spends the user's
/// model quota and carries prompt text through the host's PII redaction gate.
/// A plugin that legitimately needs one very often should not get the other.
pub fn check(state: &HostState) -> Result<(), String> {
    require(state, "ai:chat")
}

pub fn validate(prompt: &str, opts: &GenerateOptions) -> Result<(), String> {
    if prompt.is_empty() {
        return Err(coded(
            WasmErrorCode::InvalidRequest,
            "ai.generate-text: prompt is empty",
        ));
    }
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(coded(
            WasmErrorCode::PayloadTooLarge,
            format!(
                "ai.generate-text: prompt is {} bytes, over the {MAX_PROMPT_BYTES} byte limit",
                prompt.len()
            ),
        ));
    }
    if let Some(t) = opts.temperature {
        if !(0.0..=2.0).contains(&t) {
            return Err(coded(
                WasmErrorCode::InvalidRequest,
                format!("ai.generate-text: temperature out of range (got {t}, expected 0.0..=2.0)"),
            ));
        }
    }
    if let Some(m) = opts.max_tokens {
        if m == 0 || m > 100_000 {
            return Err(coded(
                WasmErrorCode::InvalidRequest,
                format!("ai.generate-text: max_tokens out of range (got {m}, expected 1..=100000)"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::store::test_host_state;
    use super::*;

    fn st(caps: &[&str]) -> HostState {
        test_host_state("demo", caps)
    }

    #[test]
    fn check_requires_ai_chat_not_network_fetch() {
        // The v0.2 regression anchor. `network:fetch` grants raw outbound HTTP
        // and must NOT unlock the user's model quota.
        assert!(check(&st(&["ai:chat"])).is_ok());
        assert!(check(&st(&[])).is_err());

        let err = check(&st(&["network:fetch"])).unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
        assert!(
            err.contains("ai:chat"),
            "the denial must name the right capability: {err}"
        );
    }

    #[test]
    fn validate_rejects_empty_prompt() {
        let err = validate("", &GenerateOptions::default()).unwrap_err();
        assert!(err.starts_with("INVALID_REQUEST: "));
        assert!(err.contains("prompt is empty"));
    }

    #[test]
    fn validate_rejects_oversize_prompt_as_payload_too_large() {
        let big = "x".repeat(MAX_PROMPT_BYTES + 1);
        let err = validate(&big, &GenerateOptions::default()).unwrap_err();
        assert!(err.starts_with("PAYLOAD_TOO_LARGE: "));
        // At the boundary exactly, it passes.
        assert!(validate(&"x".repeat(MAX_PROMPT_BYTES), &GenerateOptions::default()).is_ok());
    }

    #[test]
    fn validate_rejects_bad_temperature() {
        let mut o = GenerateOptions {
            temperature: Some(-1.0),
            ..GenerateOptions::default()
        };
        assert!(validate("hi", &o).unwrap_err().contains("temperature"));
        o.temperature = Some(3.5);
        assert!(validate("hi", &o).unwrap_err().contains("temperature"));
        o.temperature = Some(0.7);
        assert!(validate("hi", &o).is_ok());
    }

    #[test]
    fn validate_rejects_bad_max_tokens() {
        let mut o = GenerateOptions {
            max_tokens: Some(0),
            ..GenerateOptions::default()
        };
        assert!(validate("hi", &o).is_err());
        o.max_tokens = Some(200_000);
        assert!(validate("hi", &o).is_err());
        o.max_tokens = Some(1024);
        assert!(validate("hi", &o).is_ok());
    }
}
