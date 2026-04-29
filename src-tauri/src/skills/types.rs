// Wire types shared between the Rust skills module and the TypeScript
// frontend. Field names mirror the JS shapes (camelCase via serde rename) so
// the frontend can pass these payloads through `invoke()` without a manual
// remap step.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSkillResource {
    pub kind: String, // "script" | "reference" | "asset"
    pub path: String, // relative to the skill directory
    pub name: String,
    pub content: String,  // utf-8 or base64-encoded
    pub encoding: String, // "utf-8" | "base64"
    pub mime_type: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSkill {
    /// Directory name under ~/.claude/skills/ (kebab-case slug).
    pub dir_name: String,
    /// Absolute path to the SKILL.md file.
    pub file_path: String,
    /// Raw SKILL.md including frontmatter — frontend handles parsing.
    pub content: String,
    pub resources: Vec<NativeSkillResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillRequest {
    /// Frontend-derived directory slug (kebab-case skill name).
    pub dir_name: String,
    /// SKILL.md serialised body (with YAML frontmatter).
    pub content: String,
    pub resources: Vec<NativeSkillResource>,
    /// When true, blow away any pre-existing files in the directory before
    /// writing. When false, keep unrelated files (used during incremental
    /// pushes from the frontend).
    pub clean: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSkillResponse {
    pub directory: String,
    pub written_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub source: String,
    pub source_type: String,
    pub skill_path: Option<String>,
    pub computed_hash: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub author: Option<String>,
    pub icon_url: Option<String>,
    pub raw_skill_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIssue {
    pub severity: String, // "low" | "medium" | "high"
    pub kind: String,     // e.g., "shell-rmrf", "untrusted-fetch"
    pub message: String,
    pub line: Option<u32>,
}
