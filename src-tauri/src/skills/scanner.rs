// Lightweight security scanner for SKILL.md content + bundled scripts.
// We're not trying to catch motivated attackers — the user voluntarily
// installed the skill; this is just a "before you run this, here are some
// things that look risky" surface.

use regex::Regex;

use super::types::ScanIssue;

pub struct ScanInput {
    pub label: String,
    pub content: String,
}

#[tauri::command]
pub fn skills_scan_security(content: String) -> Result<Vec<ScanIssue>, String> {
    Ok(scan(&[ScanInput {
        label: "SKILL.md".to_string(),
        content,
    }]))
}

#[tauri::command]
pub fn skills_scan_resources(resources: Vec<(String, String)>) -> Result<Vec<ScanIssue>, String> {
    let inputs: Vec<ScanInput> = resources
        .into_iter()
        .map(|(label, content)| ScanInput { label, content })
        .collect();
    Ok(scan(&inputs))
}

fn scan(inputs: &[ScanInput]) -> Vec<ScanIssue> {
    let rules = build_rules();
    let mut out: Vec<ScanIssue> = Vec::new();
    for input in inputs {
        for (line_no, line) in input.content.lines().enumerate() {
            for rule in &rules {
                if rule.pattern.is_match(line) {
                    out.push(ScanIssue {
                        severity: rule.severity.to_string(),
                        kind: rule.kind.to_string(),
                        message: format!("{}: {}", input.label, rule.message),
                        line: Some((line_no as u32) + 1),
                    });
                }
            }
        }
    }
    out
}

struct Rule {
    pattern: Regex,
    severity: &'static str,
    kind: &'static str,
    message: &'static str,
}

fn build_rules() -> Vec<Rule> {
    let raw: &[(&str, &str, &str, &str)] = &[
        (
            r"\brm\s+-rf\s+/",
            "high",
            "shell-rmrf",
            "Recursive deletion at filesystem root.",
        ),
        (
            r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;:",
            "high",
            "shell-forkbomb",
            "Looks like a fork-bomb.",
        ),
        (
            r"\bcurl\s+[^|]+\|\s*sh\b",
            "high",
            "shell-curl-sh",
            "Piping curl directly into sh runs untrusted code.",
        ),
        (
            r"\bwget\s+[^|]+\|\s*sh\b",
            "high",
            "shell-wget-sh",
            "Piping wget directly into sh runs untrusted code.",
        ),
        (
            r"sudo\s+rm\b",
            "medium",
            "shell-sudo-rm",
            "sudo + rm — sanity-check the path before running.",
        ),
        (
            r"\beval\s*\(",
            "medium",
            "code-eval",
            "Dynamic eval can execute arbitrary input.",
        ),
        (
            r"DROP\s+TABLE\b",
            "medium",
            "sql-drop-table",
            "SQL DROP TABLE.",
        ),
        (
            r"AKIA[0-9A-Z]{16}",
            "high",
            "leaked-aws-key",
            "Possible AWS access key in content.",
        ),
        (
            r"-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----",
            "high",
            "leaked-private-key",
            "Embedded private key.",
        ),
    ];
    raw.iter()
        .filter_map(|(p, sev, kind, msg)| {
            Regex::new(p).ok().map(|re| Rule {
                pattern: re,
                severity: sev,
                kind,
                message: msg,
            })
        })
        .collect()
}
