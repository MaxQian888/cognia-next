// Third-party relay endpoint preset (Anthropic + Codex only).
//
// A `ProviderPreset` overrides the provider's default base URL and optionally
// adds custom headers. Use cases: AWS Bedrock for Anthropic, Azure-OpenAI /
// proxy relays for Codex. OpenCode does not support presets — it already is a
// multi-provider hub and configuring endpoints belongs in its own auth.json.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderPreset {
    /// UUIDv7 — stable across renames so the renderer can keep highlighting
    /// the active preset by id.
    pub id: String,
    /// Human-readable name surfaced in the picker ("AWS Bedrock", "Custom
    /// proxy", etc.).
    pub label: String,
    /// Base URL the provider's HTTP client should target instead of the
    /// upstream endpoint. Empty string is rejected at validation time.
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    /// Optional extra headers (added on every request). BTreeMap for
    /// deterministic serialization (relevant for tests + diff readability).
    #[serde(rename = "extraHeaders", default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra_headers: BTreeMap<String, String>,
}

impl ProviderPreset {
    /// Validate the preset structure. Returns `Err` with a user-readable
    /// message when the preset is unusable (empty id, empty label, blank
    /// base URL, or a base URL that fails URL parsing).
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("preset.id must not be empty".into());
        }
        if self.label.trim().is_empty() {
            return Err("preset.label must not be empty".into());
        }
        let base = self.base_url.trim();
        if base.is_empty() {
            return Err("preset.baseUrl must not be empty".into());
        }
        url::Url::parse(base).map_err(|e| format!("preset.baseUrl must be a valid URL: {e}"))?;
        // BTreeMap keys can't be empty strings — they're rare in practice but
        // would silently break header merging downstream.
        for k in self.extra_headers.keys() {
            if k.trim().is_empty() {
                return Err("preset.extraHeaders must not contain empty keys".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ProviderPreset {
        let mut headers = BTreeMap::new();
        headers.insert("X-Org".into(), "cognia".into());
        ProviderPreset {
            id: "0193c2b0-0000-7000-8000-000000000001".into(),
            label: "AWS Bedrock".into(),
            base_url: "https://bedrock-runtime.us-west-2.amazonaws.com".into(),
            extra_headers: headers,
        }
    }

    #[test]
    fn validate_accepts_sample() {
        assert!(sample().validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_id() {
        let mut p = sample();
        p.id = String::new();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_blank_label() {
        let mut p = sample();
        p.label = "   ".into();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_empty_base_url() {
        let mut p = sample();
        p.base_url = String::new();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_malformed_base_url() {
        let mut p = sample();
        p.base_url = "not a url".into();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_blank_header_key() {
        let mut p = sample();
        p.extra_headers.insert("".into(), "value".into());
        assert!(p.validate().is_err());
    }

    #[test]
    fn serialize_uses_camel_case_field_names() {
        let blob = serde_json::to_string(&sample()).unwrap();
        assert!(blob.contains("\"baseUrl\""));
        assert!(blob.contains("\"extraHeaders\""));
    }

    #[test]
    fn serialize_skips_empty_headers() {
        let mut p = sample();
        p.extra_headers.clear();
        let blob = serde_json::to_string(&p).unwrap();
        assert!(!blob.contains("extraHeaders"));
    }

    #[test]
    fn headers_serialize_in_sorted_order() {
        let mut headers = BTreeMap::new();
        headers.insert("z-last".into(), "1".into());
        headers.insert("a-first".into(), "2".into());
        let p = ProviderPreset {
            id: "id".into(),
            label: "l".into(),
            base_url: "https://example.com".into(),
            extra_headers: headers,
        };
        let blob = serde_json::to_string(&p).unwrap();
        let a = blob.find("a-first").unwrap();
        let z = blob.find("z-last").unwrap();
        assert!(a < z, "BTreeMap should produce sorted header order");
    }
}
