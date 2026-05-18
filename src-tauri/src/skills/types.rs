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
    /// Last-modified time of SKILL.md in milliseconds since UNIX epoch.
    /// Zero when filesystem metadata cannot be read. Compared against
    /// `Skill.lastSyncedAt` in the frontend to decide pull-staleness.
    pub mtime_ms: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_skill_serializes_to_camel_case() {
        let s = NativeSkill {
            dir_name: "x".to_string(),
            file_path: "/p/SKILL.md".to_string(),
            content: "body".to_string(),
            resources: vec![],
            mtime_ms: 12345,
        };
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"dirName\":"));
        assert!(json.contains("\"filePath\":"));
        assert!(json.contains("\"mtimeMs\":12345"));
        // Snake-case field names must NOT leak into the wire format —
        // they're the Rust binding only.
        assert!(!json.contains("\"dir_name\""));
        assert!(!json.contains("\"mtime_ms\""));
    }

    #[test]
    fn native_skill_round_trip() {
        let s = NativeSkill {
            dir_name: "x".to_string(),
            file_path: "/p/SKILL.md".to_string(),
            content: "body".to_string(),
            resources: vec![NativeSkillResource {
                kind: "script".to_string(),
                path: "scripts/foo.sh".to_string(),
                name: "foo.sh".to_string(),
                content: "echo hi".to_string(),
                encoding: "utf-8".to_string(),
                mime_type: Some("text/x-shellscript".to_string()),
                size: 7,
            }],
            mtime_ms: 100,
        };
        let json = serde_json::to_string(&s).expect("serialize");
        let back: NativeSkill = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.dir_name, "x");
        assert_eq!(back.resources.len(), 1);
        assert_eq!(back.resources[0].mime_type.as_deref(), Some("text/x-shellscript"));
        assert_eq!(back.mtime_ms, 100);
    }

    #[test]
    fn install_request_round_trip() {
        let req = InstallSkillRequest {
            dir_name: "x".to_string(),
            content: "MD".to_string(),
            resources: vec![],
            clean: true,
        };
        let json = serde_json::to_string(&req).expect("serialize");
        assert!(json.contains("\"dirName\""));
        assert!(json.contains("\"clean\":true"));
        let back: InstallSkillRequest = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.dir_name, "x");
        assert!(back.clean);
    }

    #[test]
    fn install_response_carries_directory_and_written_files() {
        let resp = InstallSkillResponse {
            directory: "/u/.claude/skills/x".to_string(),
            written_files: vec!["a".to_string(), "b".to_string()],
        };
        let json = serde_json::to_string(&resp).expect("serialize");
        assert!(json.contains("\"writtenFiles\""));
        let back: InstallSkillResponse = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.written_files.len(), 2);
    }

    #[test]
    fn registry_entry_optional_fields_skipped_when_absent() {
        let raw = r#"{"id":"x","source":"s","sourceType":"github"}"#;
        let back: RegistryEntry = serde_json::from_str(raw).expect("deserialize");
        assert_eq!(back.id, "x");
        assert!(back.tags.is_none());
        assert!(back.skill_path.is_none());
    }

    #[test]
    fn scan_issue_round_trip() {
        let issue = ScanIssue {
            severity: "high".to_string(),
            kind: "shell-rmrf".to_string(),
            message: "danger".to_string(),
            line: Some(5),
        };
        let json = serde_json::to_string(&issue).expect("serialize");
        let back: ScanIssue = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.severity, "high");
        assert_eq!(back.line, Some(5));
    }

    #[test]
    fn native_skill_resource_round_trip_with_base64_encoding() {
        let r = NativeSkillResource {
            kind: "asset".to_string(),
            path: "assets/logo.png".to_string(),
            name: "logo.png".to_string(),
            content: "iVBORw0KGgo=".to_string(),
            encoding: "base64".to_string(),
            mime_type: Some("image/png".to_string()),
            size: 8,
        };
        let json = serde_json::to_string(&r).expect("serialize");
        let back: NativeSkillResource = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.encoding, "base64");
        assert_eq!(back.mime_type.as_deref(), Some("image/png"));
    }
}
