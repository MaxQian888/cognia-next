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

use parking_lot::RwLock;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

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

/// Internal — what `PolicyState` actually holds. Pre-compiled regex
/// instances eliminate the per-action allocator hit that the W1 plan
/// flagged on `policy.rs::evaluate`. `from_raw` returns an error if any
/// pattern fails to parse so the renderer can surface validation feedback
/// at `set()` time instead of silently denying every subsequent action.
#[derive(Clone, Debug, Default)]
pub struct CompiledPolicy {
    pub allowed_process_names: Vec<String>,
    pub allowed_window_title_patterns: Vec<Regex>,
    pub allowed_url_patterns: Vec<Regex>,
    pub forbidden_screen_regions: Vec<ScreenRect>,
}

#[derive(Debug, Clone)]
pub struct PolicyCompileError {
    pub field: &'static str,
    pub pattern: String,
    pub message: String,
}

impl std::fmt::Display for PolicyCompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "policy field `{}` rejected pattern {:?}: {}",
            self.field, self.pattern, self.message
        )
    }
}

impl std::error::Error for PolicyCompileError {}

impl CompiledPolicy {
    pub fn from_raw(raw: &Policy) -> Result<Self, PolicyCompileError> {
        let allowed_window_title_patterns =
            compile_all("allowedWindowTitlePatterns", &raw.allowed_window_title_patterns)?;
        let allowed_url_patterns =
            compile_all("allowedUrlPatterns", &raw.allowed_url_patterns)?;
        Ok(Self {
            allowed_process_names: raw.allowed_process_names.clone(),
            allowed_window_title_patterns,
            allowed_url_patterns,
            forbidden_screen_regions: raw.forbidden_screen_regions.clone(),
        })
    }

    pub fn to_raw(&self) -> Policy {
        Policy {
            allowed_process_names: self.allowed_process_names.clone(),
            allowed_window_title_patterns: self
                .allowed_window_title_patterns
                .iter()
                .map(|r| r.as_str().to_string())
                .collect(),
            allowed_url_patterns: self
                .allowed_url_patterns
                .iter()
                .map(|r| r.as_str().to_string())
                .collect(),
            forbidden_screen_regions: self.forbidden_screen_regions.clone(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.allowed_process_names.is_empty()
            && self.allowed_window_title_patterns.is_empty()
            && self.allowed_url_patterns.is_empty()
            && self.forbidden_screen_regions.is_empty()
    }

    pub fn evaluate(&self, facts: &ActionFacts<'_>) -> Decision {
        if !self.allowed_process_names.is_empty() {
            let proc_name = facts.process_name.unwrap_or("");
            let ok = self
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

        if !self.allowed_window_title_patterns.is_empty() {
            let title = facts.window_title.unwrap_or("");
            let ok = self
                .allowed_window_title_patterns
                .iter()
                .any(|re| re.is_match(title));
            if !ok {
                return Decision::Deny {
                    reason: format!(
                        "window title {:?} did not match any allowed_window_title_patterns",
                        title
                    ),
                };
            }
        }

        if !self.allowed_url_patterns.is_empty() {
            let url = facts.target_url.unwrap_or("");
            let ok = self.allowed_url_patterns.iter().any(|re| re.is_match(url));
            if !ok {
                return Decision::Deny {
                    reason: format!("URL {:?} did not match any allowed_url_patterns", url),
                };
            }
        }

        if let (Some(x), Some(y)) = (facts.click_x, facts.click_y) {
            for rect in &self.forbidden_screen_regions {
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
}

fn compile_all(field: &'static str, patterns: &[String]) -> Result<Vec<Regex>, PolicyCompileError> {
    patterns
        .iter()
        .map(|p| {
            Regex::new(p).map_err(|e| PolicyCompileError {
                field,
                pattern: p.clone(),
                message: e.to_string(),
            })
        })
        .collect()
}

/// Thread-safe holder for the per-action policy. One instance lives in
/// `AutomationState`; the renderer reads/writes via the
/// `automation_policy_get` / `automation_policy_set` Tauri commands.
///
/// ADR-0020 W1 — the held value is a `CompiledPolicy` so each
/// `dispatcher → evaluate` chain avoids re-parsing regex patterns. `set`
/// compiles on the way in; invalid regex surfaces as a
/// `PolicyCompileError` so the renderer can show per-row validation
/// feedback instead of "every subsequent action denies silently".
#[derive(Clone, Default)]
pub struct PolicyState {
    inner: Arc<RwLock<CompiledPolicy>>,
}

impl PolicyState {
    pub fn new(policy: Policy) -> Self {
        // `CompiledPolicy::from_raw` may fail on invalid patterns; the
        // production caller (`lib.rs` boot) only ever passes
        // `Policy::default()` so the unwrap is sound, and any custom
        // caller that constructs from a non-default policy should use
        // `try_new` instead.
        let compiled = CompiledPolicy::from_raw(&policy)
            .expect("PolicyState::new called with an unparseable policy; use try_new instead");
        Self {
            inner: Arc::new(RwLock::new(compiled)),
        }
    }

    /// Fallible constructor — use when the policy may carry user-provided
    /// regex (e.g., when hydrating from `AppSettings` on boot).
    pub fn try_new(policy: Policy) -> Result<Self, PolicyCompileError> {
        let compiled = CompiledPolicy::from_raw(&policy)?;
        Ok(Self {
            inner: Arc::new(RwLock::new(compiled)),
        })
    }

    pub fn get(&self) -> Policy {
        self.inner.read().to_raw()
    }

    /// Replace the held policy. Returns `Err` (without modifying state)
    /// when a regex fails to compile; the renderer should surface the
    /// `PolicyCompileError` to the operator.
    pub fn set(&self, policy: Policy) -> Result<(), PolicyCompileError> {
        let compiled = CompiledPolicy::from_raw(&policy)?;
        *self.inner.write() = compiled;
        Ok(())
    }

    /// Evaluate the held policy without cloning into the caller.
    pub fn evaluate(&self, facts: &ActionFacts<'_>) -> Decision {
        let guard = self.inner.read();
        guard.evaluate(facts)
    }

    /// True when the held policy has no active constraints — used by the
    /// dispatcher to fast-path the common "no policy configured" case.
    pub fn is_empty(&self) -> bool {
        self.inner.read().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>() -> ActionFacts<'a> {
        ActionFacts::default()
    }

    /// Test-only mirror of the pre-W1 free `evaluate` entry point. We keep
    /// the existing call shape (`evaluate(&policy, &facts)`) in the test
    /// suite so the unit-test asserts didn't need to learn about the
    /// `CompiledPolicy` API — but production code now always goes
    /// through `PolicyState`'s held compiled view. Invalid regex maps to
    /// Deny to match the pre-W1 "unparseable rule denies" semantics.
    fn evaluate(policy: &Policy, facts: &ActionFacts<'_>) -> Decision {
        match CompiledPolicy::from_raw(policy) {
            Ok(c) => c.evaluate(facts),
            Err(_) => Decision::Deny {
                reason: "test helper: policy contains an unparseable regex".into(),
            },
        }
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

    #[test]
    fn policy_state_get_returns_clone() {
        let state = PolicyState::new(Policy {
            allowed_process_names: vec!["Chrome".into()],
            ..Default::default()
        });
        let cloned = state.get();
        assert_eq!(cloned.allowed_process_names, vec!["Chrome".to_string()]);
    }

    #[test]
    fn policy_state_set_swaps_policy() {
        let state = PolicyState::default();
        assert!(state.is_empty());
        state
            .set(Policy {
                allowed_process_names: vec!["Firefox".into()],
                ..Default::default()
            })
            .unwrap();
        assert!(!state.is_empty());
        assert_eq!(
            state.get().allowed_process_names,
            vec!["Firefox".to_string()]
        );
    }

    #[test]
    fn policy_state_set_rejects_invalid_regex_without_corrupting_state() {
        // The pre-W1 evaluator silently treated unparseable regex as
        // "no match" → Deny on every subsequent action. W1 surfaces the
        // failure at `set` time so the renderer can correct the row.
        let state = PolicyState::default();
        // Seed a valid policy so we can prove `set` leaves it untouched
        // when the next call fails.
        state
            .set(Policy {
                allowed_process_names: vec!["Chrome".into()],
                ..Default::default()
            })
            .unwrap();
        let err = state
            .set(Policy {
                allowed_window_title_patterns: vec!["[invalid".into()],
                ..Default::default()
            })
            .unwrap_err();
        assert_eq!(err.field, "allowedWindowTitlePatterns");
        assert!(err.message.contains("regex parse error") || !err.message.is_empty());
        // State preserved — `allowed_process_names` still holds Chrome.
        assert_eq!(
            state.get().allowed_process_names,
            vec!["Chrome".to_string()]
        );
    }

    #[test]
    fn policy_state_get_reconstructs_raw_patterns_from_compiled_regex() {
        let state = PolicyState::default();
        state
            .set(Policy {
                allowed_url_patterns: vec![r"^https://example\.com/".into()],
                ..Default::default()
            })
            .unwrap();
        let raw = state.get();
        assert_eq!(raw.allowed_url_patterns.len(), 1);
        assert_eq!(raw.allowed_url_patterns[0], r"^https://example\.com/");
    }

    #[test]
    fn compiled_policy_evaluate_matches_test_helper_on_valid_policy() {
        // Sanity check that pre-compilation didn't change semantics for
        // valid inputs. The test-helper path (compile + evaluate) and a
        // direct CompiledPolicy::evaluate must agree on well-formed
        // policies — both go through `CompiledPolicy::from_raw` now, so
        // this is really a smoke test that nothing in `from_raw` drops
        // state.
        let raw = Policy {
            allowed_process_names: vec!["Chrome".into()],
            allowed_window_title_patterns: vec![r"^Inbox".into()],
            allowed_url_patterns: vec![r"^https://mail\.".into()],
            forbidden_screen_regions: vec![],
        };
        let facts = ActionFacts {
            process_name: Some("Chrome"),
            window_title: Some("Inbox — 3 unread"),
            target_url: Some("https://mail.example/"),
            click_x: None,
            click_y: None,
        };
        let from_helper = evaluate(&raw, &facts);
        let compiled = CompiledPolicy::from_raw(&raw).unwrap();
        let from_compiled = compiled.evaluate(&facts);
        assert_eq!(from_helper, from_compiled);
        assert_eq!(from_helper, Decision::Allow);
    }

    #[test]
    fn policy_state_evaluate_uses_held_policy() {
        let state = PolicyState::new(Policy {
            allowed_process_names: vec!["Chrome".into()],
            ..Default::default()
        });
        let allow = ActionFacts {
            process_name: Some("Chrome"),
            ..Default::default()
        };
        let deny = ActionFacts {
            process_name: Some("Notepad"),
            ..Default::default()
        };
        assert_eq!(state.evaluate(&allow), Decision::Allow);
        assert!(matches!(state.evaluate(&deny), Decision::Deny { .. }));
    }

    #[test]
    fn empty_policy_state_is_empty() {
        assert!(PolicyState::default().is_empty());
        assert!(PolicyState::new(Policy::default()).is_empty());
    }
}
