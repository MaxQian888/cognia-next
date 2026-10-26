// Wire DTOs shared by the read-only database and installed-skill adapters.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Counts of each table CCSwitch is known to populate. Used by the status
/// banner; schema mismatches are errors.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CcswitchCounts {
    pub providers: u64,
    #[serde(rename = "mcpServers")]
    pub mcp_servers: u64,
    pub prompts: u64,
    pub skills: u64,
}

/// One provider row, identified by the upstream (id, app_type) key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchProvider {
    pub id: String,
    pub name: String,
    /// "claude" | "codex" | "gemini" | "opencode" | "openclaw" | other
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(rename = "apiKey", skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(rename = "baseUrl", skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    #[serde(rename = "credentialEnv", skip_serializing_if = "Option::is_none")]
    pub credential_env: Option<String>,
    /// Per-tier model overrides Claude Code resolves from the `env` block —
    /// `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` — so a relay that maps the
    /// opus/sonnet/haiku aliases to concrete models (Kimi, GLM, …) surfaces its
    /// real model list to consumers. Absent when the env didn't declare them.
    #[serde(rename = "opusModel", skip_serializing_if = "Option::is_none")]
    pub opus_model: Option<String>,
    #[serde(rename = "sonnetModel", skip_serializing_if = "Option::is_none")]
    pub sonnet_model: Option<String>,
    #[serde(rename = "haikuModel", skip_serializing_if = "Option::is_none")]
    pub haiku_model: Option<String>,
    /// `ANTHROPIC_SMALL_FAST_MODEL` — the background/haiku-tier model.
    #[serde(rename = "smallFastModel", skip_serializing_if = "Option::is_none")]
    pub small_fast_model: Option<String>,
    /// Forwardable HTTP headers parsed from `ANTHROPIC_CUSTOM_HEADERS` /
    /// `ANTHROPIC_BETA` in the env block. Carries e.g.
    /// `anthropic-beta: context-1m-2025-08-07`, which unlocks the 1M context
    /// window on relays that gate it behind the beta header.
    #[serde(rename = "customHeaders", skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<BTreeMap<String, String>>,
    /// Free-form JSON — `sharedConfig` / `extra`. Preserved verbatim.
    #[serde(rename = "sharedConfig", skip_serializing_if = "Option::is_none")]
    pub shared_config: Option<serde_json::Value>,
    /// CCSwitch's optional `meta.usage_script` descriptor. Cognia exposes the
    /// metadata for safe, declarative import but never executes its JavaScript.
    #[serde(rename = "usageScript", skip_serializing_if = "Option::is_none")]
    pub usage_script: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(rename = "providerType", skip_serializing_if = "Option::is_none")]
    pub provider_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchMcpServer {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// Full config JSON exactly as CCSwitch stores it. Frontend maps this to
    /// cognia-next's `McpServerDraft` shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchPrompt {
    pub id: String,
    pub name: String,
    pub content: String,
    /// App the prompt belongs to ("claude" | "codex" | …). CCSwitch keys
    /// prompts by (id, app_type), so `id` alone is not unique.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CcswitchSkill {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// SKILL.md loaded from the installed directory. Empty when unavailable.
    pub content: String,
    #[serde(rename = "sourcePath", skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    pub resources: Vec<cognia_skills::types::NativeSkillResource>,
    #[serde(rename = "openaiYaml", skip_serializing_if = "Option::is_none")]
    pub openai_yaml: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_skill_fields_follow_the_frontend_wire_contract() {
        let skill = CcswitchSkill {
            id: "fixture".into(),
            name: "Example".into(),
            description: None,
            content: "# Workflow".into(),
            source_path: Some("/skills/example/SKILL.md".into()),
            resources: vec![],
            openai_yaml: Some("policy: {}".into()),
        };
        let wire = serde_json::to_value(&skill).unwrap();
        assert_eq!(wire["sourcePath"], "/skills/example/SKILL.md");
        assert_eq!(wire["openaiYaml"], "policy: {}");
        assert!(wire.get("source_path").is_none());
        assert!(wire["resources"].as_array().unwrap().is_empty());
        let restored: CcswitchSkill = serde_json::from_value(wire).unwrap();
        assert_eq!(restored.content, "# Workflow");
    }
}
