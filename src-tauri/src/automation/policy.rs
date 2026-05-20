// ADR-0028 Phase 5 / T5 — per-action policy gate for `computer_use`.
//
// The desktop-driving `computer_use` tool cannot be process-sandboxed (its
// whole point is to drive the host UI). Defence stack already in place:
//
//   1. `automation/permission.rs` — 3-tier `Tier` enum (Off / Whitelist /
//      PerCall) keyed by `Surface`.
//   2. `automation/consent.rs` — HITL consent broker.
//   3. `automation/audit.rs` — append-only audit log.
//   4. `Character.computerUseSettings.allowedToolIds` — per-character
//      registry filter.
//
// This module adds a FIFTH layer: per-action policy. A `Policy` is a set
// of constraints — e.g. "only operate on Chrome", "never click in the
// password-manager screen region", "the target URL must match `^https://`".
// `evaluate(policy, action)` runs immediately AFTER the `PerCall` consent
// resolution and returns Allow / Deny.
//
// Stored on `AppSettings.automationPolicy` (settings JSON) so power users
// can edit it through the renderer's "Settings → Sandbox → Per-action
// policy" card. Empty policy = no extra constraints (today's behaviour).

#![allow(dead_code)]

use regex::Regex;
use serde::{Deserialize, Serialize};

/// One per-action constraint set. All fields optional — empty = no
/// additional constraint beyond what the 3-tier permission gate already
/// enforces.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Policy {
    /// Allowlist of `process_name` values (case-insensitive). Empty =
    /// match anything.
    pub allowed_process_names: Vec<String>,
    /// Allowlist of regex patterns against the target window title.
    /// Empty = match anything.
    pub allowed_window_title_patterns: Vec<String>,
    /// Allowlist of regex patterns against the URL (for browser
    /// targets — supplied by the renderer or extracted by UIA).
    pub allowed_url_patterns: Vec<String>,
    /// Forbidden screen regions, in absolute pixels. Click / drag actions
    /// whose target falls inside any of these are denied. Useful for
    /// excluding password-manager popups, system tray secrets, etc.
    pub forbidden_screen_regions: Vec<ScreenRect>,
}

/// Rectangular screen region, absolute pixels.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl ScreenRect {
    /// True when `(px, py)` is inside the rectangle.
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.x + self.width && py >= self.y && py < self.y + self.height
    }
}

/// Facts about the action being evaluated. Constructed by the
/// `automation::commands` dispatcher before the policy check; fields are
/// best-effort and may be `None` when UIA can't surface them.
#[derive(Debug, Clone, Default)]
pub struct ActionFacts<'a> {
    pub process_name: Option<&'a str>,
    pub window_title: Option<&'a str>,
    pub target_url: Option<&'a str>,
    pub click_x: Option<i32>,
    pub click_y: Option<i32>,
}

/// Evaluation outcome. The dispatcher treats `Deny` exactly like a
/// `PerCall` consent deny: abort the action and emit an audit row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny { reason: String },
}

/// Evaluate the policy against the action's facts. Pure: no I/O. All
/// allowlists are AND-combined (a fact must pass every non-empty
/// allowlist that has a matching field on the action).
pub fn evaluate(policy: &Policy, facts: &ActionFacts<'_>) -> Decision {
    // Process name check — case-insensitive equality.
    if !policy.allowed_process_names.is_empty() {
        let proc_name = facts.process_name.unwrap_or("");
        let ok = policy
            .allowed_process_names
            .iter()
            .any(|p| p.eq_ignore_ascii_case(proc_name));
        if !ok {
            return Decision::Deny {
                reason: format!(
                    "process name {:?} not in allowed_process_names",
                    proc_name
                ),
            };
        }
    }

    // Window-title regex allowlist.
    if !policy.allowed_window_title_patterns.is_empty() {
        let title = facts.window_title.unwrap_or("");
        let ok = policy
            .allowed_window_title_patterns
            .iter()
            .any(|p| Regex::new(p).map(|re| re.is_match(title)).unwrap_or(false));
        if !ok {
            return Decision::Deny {
                reason: format!(
                    "window title {:?} did not match any allowed_window_title_patterns",
                    title
                ),
            };
        }
    }

    // Target-URL regex allowlist.
    if !policy.allowed_url_patterns.is_empty() {
        let url = facts.target_url.unwrap_or("");
        let ok = policy
            .allowed_url_patterns
            .iter()
            .any(|p| Regex::new(p).map(|re| re.is_match(url)).unwrap_or(false));
        if !ok {
            return Decision::Deny {
                reason: format!("URL {:?} did not match any allowed_url_patterns", url),
            };
        }
    }

    // Forbidden screen regions — only applies when the action carries
    // coordinates (clicks, drags). Mouse-move / scroll without a fixed
    // target skip this check.
    if let (Some(x), Some(y)) = (facts.click_x, facts.click_y) {
        for rect in &policy.forbidden_screen_regions {
            if rect.contains(x, y) {
                return Decision::Deny {
                    reason: format!(
                        "click target ({x},{y}) falls inside forbidden region {:?}",
                        rect
                    ),
                };
            }
        }
    }

    Decision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>() -> ActionFacts<'a> {
        ActionFacts::default()
    }

    #[test]
    fn empty_policy_allows_everything() {
        assert_eq!(evaluate(&Policy::default(), &facts()), Decision::Allow);
    }

    #[test]
    fn process_allowlist_denies_mismatch() {
        let policy = Policy {
            allowed_process_names: vec!["Chrome".into(), "Firefox".into()],
            ..Default::default()
        };
        let f = ActionFacts {
            process_name: Some("Notepad"),
            ..Default::default()
        };
        let decision = evaluate(&policy, &f);
        assert!(matches!(decision, Decision::Deny { .. }));
    }

    #[test]
    fn process_allowlist_case_insensitive() {
        let policy = Policy {
            allowed_process_names: vec!["chrome".into()],
            ..Default::default()
        };
        let f = ActionFacts {
            process_name: Some("Chrome"),
            ..Default::default()
        };
        assert_eq!(evaluate(&policy, &f), Decision::Allow);
    }

    #[test]
    fn window_title_regex_allowed_match() {
        let policy = Policy {
            allowed_window_title_patterns: vec![r"^Visual Studio Code".into()],
            ..Default::default()
        };
        let f = ActionFacts {
            window_title: Some("Visual Studio Code — main.rs"),
            ..Default::default()
        };
        assert_eq!(evaluate(&policy, &f), Decision::Allow);
    }

    #[test]
    fn window_title_regex_denies_mismatch() {
        let policy = Policy {
            allowed_window_title_patterns: vec![r"^Visual Studio Code".into()],
            ..Default::default()
        };
        let f = ActionFacts {
            window_title: Some("1Password"),
            ..Default::default()
        };
        let decision = evaluate(&policy, &f);
        assert!(matches!(decision, Decision::Deny { .. }));
    }

    #[test]
    fn url_pattern_allows_https_match() {
        let policy = Policy {
            allowed_url_patterns: vec![r"^https://".into()],
            ..Default::default()
        };
        let f = ActionFacts {
            target_url: Some("https://example.com/a"),
            ..Default::default()
        };
        assert_eq!(evaluate(&policy, &f), Decision::Allow);
    }

    #[test]
    fn forbidden_region_denies_click_inside() {
        let policy = Policy {
            forbidden_screen_regions: vec![ScreenRect {
                x: 100,
                y: 100,
                width: 200,
                height: 200,
            }],
            ..Default::default()
        };
        let f = ActionFacts {
            click_x: Some(150),
            click_y: Some(150),
            ..Default::default()
        };
        let decision = evaluate(&policy, &f);
        assert!(matches!(decision, Decision::Deny { .. }));
    }

    #[test]
    fn forbidden_region_allows_click_outside() {
        let policy = Policy {
            forbidden_screen_regions: vec![ScreenRect {
                x: 100,
                y: 100,
                width: 200,
                height: 200,
            }],
            ..Default::default()
        };
        let f = ActionFacts {
            click_x: Some(50),
            click_y: Some(50),
            ..Default::default()
        };
        assert_eq!(evaluate(&policy, &f), Decision::Allow);
    }

    #[test]
    fn screen_rect_contains_boundaries() {
        let r = ScreenRect {
            x: 10,
            y: 10,
            width: 5,
            height: 5,
        };
        assert!(r.contains(10, 10));
        assert!(r.contains(14, 14));
        assert!(!r.contains(15, 15));
        assert!(!r.contains(9, 10));
    }

    #[test]
    fn invalid_regex_does_not_panic_just_denies() {
        let policy = Policy {
            allowed_window_title_patterns: vec!["[invalid".into()],
            ..Default::default()
        };
        let f = ActionFacts {
            window_title: Some("anything"),
            ..Default::default()
        };
        // The regex `[invalid` does not compile; we treat it as "no match"
        // which surfaces as Deny (we can't grant access on an unparseable
        // rule).
        let decision = evaluate(&policy, &f);
        assert!(matches!(decision, Decision::Deny { .. }));
    }
}
