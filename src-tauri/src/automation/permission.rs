//! Permission gate for desktop automation.
//!
//! Three independent tiers per consumer surface:
//!
//! - `off`: every call is denied.
//! - `whitelist`: only calls whose target window matches the whitelist are
//!   allowed. Untargeted calls (e.g., a full-screen screenshot) pass.
//! - `perCall`: read-only calls follow whitelist semantics; driving calls
//!   require HITL consent.
//!
//! Read-only calls: `capabilities`, `get_focus`, `read_tree`, `find`,
//! `screenshot`, `subscribe_events`, `unsubscribe`. Driving calls: `click`,
//! `type_text`, `send_keys`, `invoke_pattern`, `window_op`.
//!
//! The settings struct is what `AppSettings` persists to disk. The Rust
//! gate is authoritative; the TS-side mirror in `lib/automation/permission.ts`
//! is a UX optimization that lets the renderer short-circuit obvious denies
//! before the IPC hop.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

use super::types::AutomationError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Tier {
    Off,
    Whitelist,
    PerCall,
}

impl Default for Tier {
    fn default() -> Self {
        Tier::Off
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Surface {
    Workflow,
    ComputerUse,
    Mcp,
    Plugin,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Whitelist {
    pub process_names: Vec<String>,
    pub window_title_patterns: Vec<String>,
}

impl Whitelist {
    pub fn is_empty(&self) -> bool {
        self.process_names.is_empty() && self.window_title_patterns.is_empty()
    }

    pub fn matches(&self, meta: &TargetMeta) -> bool {
        if self.is_empty() {
            return true;
        }
        if let Some(proc) = &meta.process_name {
            let proc_lc = proc.to_lowercase();
            if self
                .process_names
                .iter()
                .any(|p| p.eq_ignore_ascii_case(&proc_lc) || p.eq_ignore_ascii_case(proc))
            {
                return true;
            }
        }
        if let Some(title) = &meta.window_title {
            if self
                .window_title_patterns
                .iter()
                .any(|p| glob_match(p, title))
            {
                return true;
            }
        }
        false
    }
}

fn glob_match(pattern: &str, value: &str) -> bool {
    // Tiny `*` glob — only wildcards we support for window-title matching.
    // Falls back to substring match when the pattern has no `*`.
    if !pattern.contains('*') {
        return value.contains(pattern);
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut cursor = 0usize;
    let mut first = true;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if first {
            if !pattern.starts_with('*') && !value[cursor..].starts_with(part) {
                return false;
            }
            match value[cursor..].find(part) {
                Some(idx) => cursor += idx + part.len(),
                None => return false,
            }
            first = false;
        } else {
            match value[cursor..].find(part) {
                Some(idx) => cursor += idx + part.len(),
                None => return false,
            }
        }
        if i + 1 == parts.len() && !pattern.ends_with('*') {
            // Last part must close the value if the pattern doesn't end with `*`.
            if cursor != value.len() {
                return false;
            }
        }
    }
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SurfacePolicy {
    pub tier: Tier,
    pub whitelist: Option<Whitelist>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginSurfacePolicy {
    pub tier: Tier,
    pub whitelist: Option<Whitelist>,
    pub per_plugin_overrides: HashMap<String, SurfacePolicy>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PerSurfacePolicies {
    pub workflow: SurfacePolicy,
    pub computer_use: SurfacePolicy,
    pub mcp: SurfacePolicy,
    pub plugin: PluginSurfacePolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditSettings {
    pub retention_days: u32,
    pub export_enabled: bool,
}

impl Default for AuditSettings {
    fn default() -> Self {
        Self {
            retention_days: 30,
            export_enabled: true,
        }
    }
}

/// Top-level settings struct persisted under `AppSettings.automation`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AutomationSettings {
    pub enabled: bool,
    pub default_tier: Tier,
    pub whitelist: Whitelist,
    pub per_surface: PerSurfacePolicies,
    pub audit: AuditSettings,
    pub redact_screenshots: bool,
}

impl Default for AutomationSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            default_tier: Tier::Off,
            whitelist: Whitelist::default(),
            per_surface: PerSurfacePolicies::default(),
            audit: AuditSettings::default(),
            redact_screenshots: false,
        }
    }
}

/// Metadata about the call's target — populated by Tauri commands before
/// hitting the gate. `None` everywhere means "untargeted" (e.g. full-screen
/// screenshot); the gate treats that as "no whitelist constraint applies".
#[derive(Debug, Clone, Default)]
pub struct TargetMeta {
    pub process_name: Option<String>,
    pub window_title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    ReadOnly,
    Driving,
}

#[derive(Debug, Clone)]
pub struct Call<'a> {
    pub command: &'a str,
    pub surface: Surface,
    pub plugin_id: Option<&'a str>,
    pub target: TargetMeta,
}

impl<'a> Call<'a> {
    pub fn kind(&self) -> CallKind {
        match self.command {
            "click"
            | "type"
            | "keys"
            | "invoke_pattern"
            | "window_op"
            | "mouse_move"
            | "drag"
            | "scroll"
            | "hold_key"
            | "mouse_button"
            | "computer_use"
            | "bash"
            | "text_editor" => CallKind::Driving,
            _ => CallKind::ReadOnly,
        }
    }
}

#[derive(Debug, Clone)]
pub enum Decision {
    Allow,
    Deny(AutomationError),
    RequireConsent { prompt: ConsentPrompt },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentPrompt {
    pub command: String,
    pub surface: Surface,
    pub plugin_id: Option<String>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
}

/// Thread-safe permission gate. Hold one of these in the Tauri state and
/// call `evaluate` from every command.
#[derive(Clone)]
pub struct PermissionGate {
    inner: Arc<RwLock<AutomationSettings>>,
}

impl PermissionGate {
    pub fn new(settings: AutomationSettings) -> Self {
        Self {
            inner: Arc::new(RwLock::new(settings)),
        }
    }

    pub fn settings(&self) -> AutomationSettings {
        self.inner.read().clone()
    }

    pub fn update<F: FnOnce(&mut AutomationSettings)>(&self, f: F) {
        let mut guard = self.inner.write();
        f(&mut guard);
    }

    pub fn engage_kill_switch(&self) {
        self.inner.write().enabled = false;
    }

    pub fn evaluate(&self, call: &Call<'_>) -> Decision {
        let s = self.inner.read();
        if !s.enabled {
            return Decision::Deny(AutomationError::KillSwitchActive);
        }
        // Resolve effective policy: per-plugin override → per-surface → default.
        let (tier, whitelist_opt) = match call.surface {
            Surface::Workflow => (
                effective_tier(&s, s.per_surface.workflow.tier),
                s.per_surface.workflow.whitelist.as_ref(),
            ),
            Surface::ComputerUse => (
                effective_tier(&s, s.per_surface.computer_use.tier),
                s.per_surface.computer_use.whitelist.as_ref(),
            ),
            Surface::Mcp => (
                effective_tier(&s, s.per_surface.mcp.tier),
                s.per_surface.mcp.whitelist.as_ref(),
            ),
            Surface::Plugin => {
                let p = &s.per_surface.plugin;
                if let Some(pid) = call.plugin_id {
                    if let Some(over) = p.per_plugin_overrides.get(pid) {
                        (
                            effective_tier(&s, over.tier),
                            over.whitelist.as_ref().or(p.whitelist.as_ref()),
                        )
                    } else {
                        (effective_tier(&s, p.tier), p.whitelist.as_ref())
                    }
                } else {
                    (effective_tier(&s, p.tier), p.whitelist.as_ref())
                }
            }
        };

        if tier == Tier::Off {
            return Decision::Deny(AutomationError::PermissionDenied {
                reason: format!("surface {:?} disabled", call.surface),
            });
        }

        // Whitelist gate. Effective whitelist is the surface-level one if
        // present, else the global one.
        let active = whitelist_opt.unwrap_or(&s.whitelist);
        if !active.is_empty() && (call.target.process_name.is_some() || call.target.window_title.is_some())
        {
            if !active.matches(&call.target) {
                return Decision::Deny(AutomationError::WhitelistMiss);
            }
        }

        match (tier, call.kind()) {
            (Tier::Whitelist, _) => Decision::Allow,
            (Tier::PerCall, CallKind::ReadOnly) => Decision::Allow,
            (Tier::PerCall, CallKind::Driving) => Decision::RequireConsent {
                prompt: ConsentPrompt {
                    command: call.command.to_string(),
                    surface: call.surface,
                    plugin_id: call.plugin_id.map(|s| s.to_string()),
                    process_name: call.target.process_name.clone(),
                    window_title: call.target.window_title.clone(),
                },
            },
            (Tier::Off, _) => unreachable!("guarded above"),
        }
    }
}

fn effective_tier(s: &AutomationSettings, surface_tier: Tier) -> Tier {
    // A surface-level Off explicitly overrides the default upward. A
    // surface-level default (the serde default is also Off) means "use the
    // top-level default_tier". We distinguish by treating the unset (Off)
    // case as "inherit" iff the global default is stricter — but that gets
    // confusing fast. The simplest stable rule: surface tier always wins.
    // The defaults serialize as Off, which is the conservative choice.
    let _ = s.default_tier;
    surface_tier
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(proc: &str) -> TargetMeta {
        TargetMeta {
            process_name: Some(proc.into()),
            window_title: None,
        }
    }

    fn read_call(surface: Surface) -> Call<'static> {
        Call {
            command: "screenshot",
            surface,
            plugin_id: None,
            target: TargetMeta::default(),
        }
    }

    fn click_call(surface: Surface) -> Call<'static> {
        Call {
            command: "click",
            surface,
            plugin_id: None,
            target: TargetMeta::default(),
        }
    }

    #[test]
    fn kill_switch_blocks_every_call() {
        let g = PermissionGate::new(AutomationSettings {
            enabled: false,
            ..Default::default()
        });
        let d = g.evaluate(&read_call(Surface::Workflow));
        assert!(matches!(d, Decision::Deny(AutomationError::KillSwitchActive)));
    }

    #[test]
    fn off_tier_denies() {
        let g = PermissionGate::new(AutomationSettings {
            enabled: true,
            ..Default::default()
        });
        let d = g.evaluate(&read_call(Surface::Workflow));
        assert!(matches!(
            d,
            Decision::Deny(AutomationError::PermissionDenied { .. })
        ));
    }

    #[test]
    fn whitelist_allows_matching_process() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.workflow.tier = Tier::Whitelist;
        s.per_surface.workflow.whitelist = Some(Whitelist {
            process_names: vec!["notepad.exe".into()],
            window_title_patterns: vec![],
        });
        let g = PermissionGate::new(s);
        let call = Call {
            command: "type",
            surface: Surface::Workflow,
            plugin_id: None,
            target: target("notepad.exe"),
        };
        assert!(matches!(g.evaluate(&call), Decision::Allow));
    }

    #[test]
    fn whitelist_blocks_unlisted_process() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.workflow.tier = Tier::Whitelist;
        s.per_surface.workflow.whitelist = Some(Whitelist {
            process_names: vec!["notepad.exe".into()],
            window_title_patterns: vec![],
        });
        let g = PermissionGate::new(s);
        let call = Call {
            command: "type",
            surface: Surface::Workflow,
            plugin_id: None,
            target: target("malicious.exe"),
        };
        assert!(matches!(
            g.evaluate(&call),
            Decision::Deny(AutomationError::WhitelistMiss)
        ));
    }

    #[test]
    fn per_call_requires_consent_for_driving_calls() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.workflow.tier = Tier::PerCall;
        let g = PermissionGate::new(s);
        let d = g.evaluate(&click_call(Surface::Workflow));
        assert!(matches!(d, Decision::RequireConsent { .. }));
    }

    #[test]
    fn per_call_passes_read_only_calls_without_consent() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.workflow.tier = Tier::PerCall;
        let g = PermissionGate::new(s);
        let d = g.evaluate(&read_call(Surface::Workflow));
        assert!(matches!(d, Decision::Allow));
    }

    #[test]
    fn plugin_per_plugin_override_beats_surface_default() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.plugin.tier = Tier::Off;
        s.per_surface.plugin.per_plugin_overrides.insert(
            "trusted-plugin".into(),
            SurfacePolicy {
                tier: Tier::Whitelist,
                whitelist: Some(Whitelist {
                    process_names: vec!["notepad.exe".into()],
                    window_title_patterns: vec![],
                }),
            },
        );
        let g = PermissionGate::new(s);

        let trusted = Call {
            command: "type",
            surface: Surface::Plugin,
            plugin_id: Some("trusted-plugin"),
            target: target("notepad.exe"),
        };
        assert!(matches!(g.evaluate(&trusted), Decision::Allow));

        let untrusted = Call {
            command: "type",
            surface: Surface::Plugin,
            plugin_id: Some("other-plugin"),
            target: target("notepad.exe"),
        };
        assert!(matches!(
            g.evaluate(&untrusted),
            Decision::Deny(AutomationError::PermissionDenied { .. })
        ));
    }

    #[test]
    fn glob_match_basic_cases() {
        assert!(glob_match("*Excel*", "Microsoft Excel - Book1.xlsx"));
        assert!(glob_match("Notepad", "Untitled - Notepad"));
        assert!(!glob_match("Word", "Notepad"));
        assert!(glob_match("*.txt - Notepad", "test.txt - Notepad"));
        assert!(glob_match("*", "anything"));
    }

    #[test]
    fn engage_kill_switch_flips_enabled() {
        let g = PermissionGate::new(AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        });
        g.engage_kill_switch();
        let d = g.evaluate(&read_call(Surface::Workflow));
        assert!(matches!(d, Decision::Deny(AutomationError::KillSwitchActive)));
    }

    #[test]
    fn all_four_surfaces_evaluable() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.workflow.tier = Tier::Whitelist;
        s.per_surface.computer_use.tier = Tier::Whitelist;
        s.per_surface.mcp.tier = Tier::Whitelist;
        s.per_surface.plugin.tier = Tier::Whitelist;
        let g = PermissionGate::new(s);
        for surf in [
            Surface::Workflow,
            Surface::ComputerUse,
            Surface::Mcp,
            Surface::Plugin,
        ] {
            let d = g.evaluate(&read_call(surf));
            assert!(matches!(d, Decision::Allow), "surface {:?} should allow", surf);
        }
    }
}
