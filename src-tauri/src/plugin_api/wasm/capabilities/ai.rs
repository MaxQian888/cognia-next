//! `cognia:plugin/ai` host import — `generate-text` only in v0.1.

use super::super::store::HostState;

#[derive(Debug, Clone, Default)]
pub struct GenerateOptions {
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub model: Option<String>,
}

/// AI generation is gated on `network:fetch` (the call ultimately hits an
/// HTTPS endpoint). The host enforces no further cost ceiling at v0.1 —
/// rate limits live in the AI provider chain.
pub fn check(state: &HostState) -> Result<(), String> {
    if state.capabilities.allows("network:fetch") {
        Ok(())
    } else {
        Err(format!(
            "capability `network:fetch` (required for ai.generate-text) not granted to plugin `{}`",
            state.plugin_id
        ))
    }
}

pub fn validate(prompt: &str, opts: &GenerateOptions) -> Result<(), String> {
    if prompt.is_empty() {
        return Err("ai.generate-text: prompt is empty".into());
    }
    if prompt.len() > 1_000_000 {
        return Err("ai.generate-text: prompt exceeds 1 MiB".into());
    }
    if let Some(t) = opts.temperature {
        if !(0.0..=2.0).contains(&t) {
            return Err(format!("ai.generate-text: temperature out of range (got {t}, expected 0.0..=2.0)"));
        }
    }
    if let Some(m) = opts.max_tokens {
        if m == 0 || m > 100_000 {
            return Err(format!("ai.generate-text: max_tokens out of range (got {m})"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::store::CapabilitySet;
    use super::*;
    use wasmtime_wasi::{ResourceTable, WasiCtxBuilder};

    fn st(caps: &[&str]) -> HostState {
        HostState {
            plugin_id: "demo".into(),
            capabilities: CapabilitySet::from_iter(caps.iter().map(|s| (*s).to_string())),
            call_timeout_ms: 30_000,
            limits: wasmtime::StoreLimitsBuilder::new().build(),
            table: ResourceTable::new(),
            wasi: WasiCtxBuilder::new().build(),
        }
    }

    #[test]
    fn check_requires_network_fetch() {
        assert!(check(&st(&["network:fetch"])).is_ok());
        assert!(check(&st(&[])).is_err());
    }

    #[test]
    fn validate_rejects_empty_prompt() {
        let err = validate("", &GenerateOptions::default()).unwrap_err();
        assert!(err.contains("prompt is empty"));
    }

    #[test]
    fn validate_rejects_bad_temperature() {
        let mut o = GenerateOptions::default();
        o.temperature = Some(-1.0);
        assert!(validate("hi", &o).unwrap_err().contains("temperature"));
        o.temperature = Some(3.5);
        assert!(validate("hi", &o).unwrap_err().contains("temperature"));
        o.temperature = Some(0.7);
        assert!(validate("hi", &o).is_ok());
    }

    #[test]
    fn validate_rejects_bad_max_tokens() {
        let mut o = GenerateOptions::default();
        o.max_tokens = Some(0);
        assert!(validate("hi", &o).is_err());
        o.max_tokens = Some(200_000);
        assert!(validate("hi", &o).is_err());
        o.max_tokens = Some(1024);
        assert!(validate("hi", &o).is_ok());
    }
}
