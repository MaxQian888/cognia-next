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
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// ADR-0028 §Audit + observability. Sandbox calls go through
    /// `sandbox::sandbox_exec`, NOT through `command_body!` — but their
    /// audit rows share the same ring + Dexie mirror. This variant lets
    /// those rows serialize as `"sandbox"` and filter cleanly in the
    /// Diagnostics tab.
    Sandbox,
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

/// Screenshot down-scaling applied before frames reach vision models.
/// Enabled by default; the operator can opt out via Settings → Automation →
/// Behavior. 1280×800 (WXGA) is the Anthropic-recommended sweet spot for
/// computer-use click accuracy vs token cost.
///
/// The default was `false` until the chat render benchmark
/// (`tests/e2e/mobile/chat-render-perf.spec.ts`) put a number on it: an
/// un-scaled Retina frame inlines as several MB of base64 into
/// `messages.parts`, and a session's worth of them costs gigabytes of renderer
/// heap. Coordinates survive the change because `lib/automation/coordinate-
/// scaler.ts` already maps model space back to physical pixels off the
/// `source_width`/`source_height` stamped below — that path existed for this
/// setting and was simply never exercised by default.
///
/// Must stay in step with `defaultAutomationSettings()` in
/// `lib/automation/client.ts`: whichever side answers first wins, so a
/// disagreement shows up as scaling that flips depending on boot order.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenshotScalingSettings {
    pub enabled: bool,
    pub max_width: u32,
    pub max_height: u32,
}

impl Default for ScreenshotScalingSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_width: 1280,
            max_height: 800,
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
    pub screenshot_scaling: ScreenshotScalingSettings,
    /// Renderer-side action mapper returns "screen unchanged" text instead
    /// of a duplicate image when consecutive screenshots hash identically.
    /// Default ON.
    pub screenshot_dedup: bool,
    /// Prevent the renderer from showing Computer Use activity in PiP.
    pub always_hide_picture_in_picture: bool,
    /// `type` calls longer than this many chars transparently use the
    /// clipboard-paste fast path. 0 disables. Default 200.
    pub paste_threshold_chars: u32,
    /// How long a `PerCall` consent prompt waits for an answer before
    /// fail-closing. Raised from the original hard-coded 30 s so a remote
    /// approver has time to receive the push, unlock, and open the app.
    ///
    /// Read through [`consent_timeout_ms`](Self::consent_timeout_ms), which
    /// clamps it below the sidecar's plugin-tool budget — a consent window
    /// wider than that would expire against a tool call that already died.
    pub consent_timeout_ms: u64,
}

/// Upper bound for [`AutomationSettings::consent_timeout_ms`].
///
/// The sidecar aborts a plugin tool call at `DEFAULT_PLUGIN_TOOL_TIMEOUT_MS`
/// (120 s, `sidecar/builtin-tools/plugin-tools.mjs`). A consent window at or
/// past that ceiling is worse than useless: the operator answers, and the
/// answer lands on a tool call the sidecar already gave up on. Leave headroom.
pub const MAX_CONSENT_TIMEOUT_MS: u64 = 115_000;

/// Floor for the same setting — below this the prompt is unanswerable even
/// with the app already open.
pub const MIN_CONSENT_TIMEOUT_MS: u64 = 5_000;

/// Default consent wait. Long enough to cover push → unlock → open app.
pub const DEFAULT_CONSENT_TIMEOUT_MS: u64 = 90_000;

impl AutomationSettings {
    /// The effective consent wait, clamped into
    /// `[MIN_CONSENT_TIMEOUT_MS, MAX_CONSENT_TIMEOUT_MS]`. A zero / absent
    /// stored value (older settings.json) reads as the default.
    pub fn consent_timeout_ms(&self) -> u64 {
        match self.consent_timeout_ms {
            0 => DEFAULT_CONSENT_TIMEOUT_MS,
            ms => ms.clamp(MIN_CONSENT_TIMEOUT_MS, MAX_CONSENT_TIMEOUT_MS),
        }
    }
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
            screenshot_scaling: ScreenshotScalingSettings::default(),
            screenshot_dedup: true,
            always_hide_picture_in_picture: false,
            paste_threshold_chars: 200,
            consent_timeout_ms: DEFAULT_CONSENT_TIMEOUT_MS,
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
    /// Shell-class commands run arbitrary host code (or, when a sandbox tier is
    /// active, sandboxed code). They must always face an informed consent
    /// prompt: a whitelist match is meaningless for an untargeted shell call,
    /// and the operator needs to see the command text. See `forces_per_call`.
    pub fn is_shell_class(&self) -> bool {
        matches!(self.command, "bash" | "text_editor" | "bash:restart")
    }

    /// Commands that must face an informed prompt regardless of the effective
    /// tier, once the surface itself is enabled.
    ///
    /// Shell-class calls (arbitrary code), plus `record_start`: arming a global
    /// input hook and continuous screen capture is categorically more invasive
    /// than any single action, and a `Whitelist` tier would otherwise auto-allow
    /// it with no review at all.
    pub fn forces_per_call(&self) -> bool {
        self.is_shell_class() || matches!(self.command, "record_start")
    }

    pub fn kind(&self) -> CallKind {
        match self.command {
            "click" | "type" | "keys" | "invoke_pattern" | "window_op" | "mouse_move" | "drag"
            | "scroll" | "hold_key" | "mouse_button" | "paste" | "launch_app" | "computer_use"
            | "perform_action" | "bash" | "text_editor" | "record_start" => CallKind::Driving,
            _ => CallKind::ReadOnly,
        }
    }

    /// Passive inspection reads the accessibility tree (or resolves an element
    /// under the cursor) without driving the desktop or capturing pixels. These
    /// power the Settings → Inspector diagnostic, which the operator opens
    /// explicitly. On the operator-facing `Workflow` surface `evaluate` lets
    /// them through regardless of the engine-enabled flag or the configured
    /// tier (short of an engaged kill switch); other surfaces still gate them
    /// normally. `screenshot` is deliberately excluded: it is read-only but
    /// leaks on-screen content, so it stays fully gated everywhere.
    pub fn is_passive_inspection(&self) -> bool {
        matches!(
            self.command,
            "get_focus"
                | "read_tree"
                | "find"
                | "cursor_position"
                | "pick_at_point"
                | "pick_session_start"
                | "pick_session_cancel"
        )
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
    /// Human-readable detail of *what* the call will do — the shell command
    /// string for `bash`, a `create <path>` summary for `text_editor`. The gate
    /// constructs the prompt without it (it doesn't see the action payload);
    /// the dispatcher fills it from `GateContext` so the consent overlay can
    /// show the operator the actual command instead of a bare verb. Display-only
    /// — never part of the session-grant key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_detail: Option<String>,
    /// Chat session this call belongs to. The gate can't see it (it has no
    /// access to the renderer context); the dispatcher fills it from
    /// `GateContext` the same way it fills `command_detail`. Unlike that
    /// field this one IS part of the session-grant key: a "don't ask again
    /// for 30 minutes" grant must not leak into a different conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_key: Option<String>,
}

impl ConsentPrompt {
    /// Prompts that may never be covered by, or converted into, a session grant.
    ///
    /// `record_start` arms a global input hook and continuous screen capture.
    /// "Don't ask again" is not an approval a user can meaningfully give in
    /// advance for that: they would be pre-authorizing a future recording whose
    /// scope, duration and content they cannot know. Authorization here is
    /// per-session by construction.
    ///
    /// Note that `session_key: None` does **not** achieve this on its own —
    /// `GrantKey::from_prompt` keys happily on `None`, so a grant would still
    /// form and still match.
    pub fn is_one_shot(&self) -> bool {
        self.command == "record_start"
    }
}

/// Build a consent prompt for `call` (command-detail filled later by the
/// dispatcher from `GateContext`).
fn consent_prompt(call: &Call<'_>) -> ConsentPrompt {
    ConsentPrompt {
        command: call.command.to_string(),
        surface: call.surface,
        plugin_id: call.plugin_id.map(|s| s.to_string()),
        process_name: call.target.process_name.clone(),
        window_title: call.target.window_title.clone(),
        command_detail: None,
        session_key: None,
    }
}

/// Thread-safe permission gate. Hold one of these in the Tauri state and
/// call `evaluate` from every command.
#[derive(Clone)]
pub struct PermissionGate {
    inner: Arc<RwLock<AutomationSettings>>,
    /// Runtime-only emergency stop, distinct from `settings.enabled` (the
    /// operator's master toggle). Once engaged, EVERY call — passive
    /// inspection included — is rejected with `KillSwitchActive` until the
    /// operator re-enables the engine. Not persisted: a restart starts clear.
    kill_switch: Arc<AtomicBool>,
}

impl PermissionGate {
    pub fn new(settings: AutomationSettings) -> Self {
        Self {
            inner: Arc::new(RwLock::new(settings)),
            kill_switch: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn settings(&self) -> AutomationSettings {
        self.inner.read().clone()
    }

    /// Mutate the persisted settings. Deliberately does NOT touch the kill
    /// switch: a bulk settings save (from any settings sub-panel) that happens
    /// to carry `enabled == true` must never silently resume automation after an
    /// emergency stop. Resuming is an explicit operator action via
    /// `set_enabled(true)`.
    pub fn update<F: FnOnce(&mut AutomationSettings)>(&self, f: F) {
        let mut guard = self.inner.write();
        f(&mut guard);
    }

    /// Explicit operator toggle of the master enable flag. Enabling is the
    /// operator's deliberate "resume" action, so it releases the emergency stop;
    /// disabling leaves the switch untouched (a disabled engine denies anyway).
    pub fn set_enabled(&self, enabled: bool) {
        self.inner.write().enabled = enabled;
        if enabled {
            self.kill_switch.store(false, Ordering::SeqCst);
        }
    }

    /// Whether the runtime emergency stop is currently engaged.
    pub fn kill_switch_engaged(&self) -> bool {
        self.kill_switch.load(Ordering::SeqCst)
    }

    pub fn engage_kill_switch(&self) {
        self.kill_switch.store(true, Ordering::SeqCst);
        self.inner.write().enabled = false;
    }

    pub fn evaluate(&self, call: &Call<'_>) -> Decision {
        // Emergency kill switch — a hard stop for every call, passive
        // inspection included. Cleared only when the operator explicitly
        // re-enables the engine (`set_enabled(true)`), never by a bulk save.
        if self.kill_switch.load(Ordering::SeqCst) {
            return Decision::Deny(AutomationError::KillSwitchActive);
        }
        let s = self.inner.read();
        // Passive inspection powers the Settings → Inspector diagnostic and is
        // allowed regardless of the master enable flag or the configured tier
        // (see `Call::is_passive_inspection`). Guarded above by the kill switch.
        // Scoped to the `Workflow` surface — the operator-facing diagnostic path.
        // External / less-trusted surfaces (MCP, plugin, computerUse) keep going
        // through the full tier gate so they can't enumerate the UI tree
        // unpermissioned.
        if call.surface == Surface::Workflow && call.is_passive_inspection() {
            return Decision::Allow;
        }
        if !s.enabled {
            return Decision::Deny(AutomationError::PermissionDenied {
                reason: "automation engine disabled".into(),
            });
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
            // Sandbox calls don't ride this gate; sandbox::sandbox_exec
            // owns its own strict-mode policy. Returning Allow here means
            // any code that *does* route a Sandbox-tagged call through
            // `command_body!` (e.g., future test scaffolding) will pass
            // the gate and rely on the sandbox subsystem's own checks.
            Surface::Sandbox => return Decision::Allow,
        };

        if tier == Tier::Off {
            return Decision::Deny(AutomationError::PermissionDenied {
                reason: format!("surface {:?} disabled", call.surface),
            });
        }

        // Whitelist gate. Effective whitelist is the surface-level one if
        // present, else the global one.
        let active = whitelist_opt.unwrap_or(&s.whitelist);
        if !active.is_empty()
            && (call.target.process_name.is_some() || call.target.window_title.is_some())
        {
            if !active.matches(&call.target) {
                return Decision::Deny(AutomationError::WhitelistMiss);
            }
        }

        // Always-consent calls, regardless of tier (once the surface is
        // enabled): a Whitelist tier would otherwise auto-allow an untargeted
        // `bash` — or a whole recording session — with zero per-command review
        // (the whitelist gate is skipped when there is no target window).
        if call.forces_per_call() {
            return Decision::RequireConsent {
                prompt: consent_prompt(call),
            };
        }

        match (tier, call.kind()) {
            (Tier::Whitelist, _) => Decision::Allow,
            (Tier::PerCall, CallKind::ReadOnly) => Decision::Allow,
            (Tier::PerCall, CallKind::Driving) => Decision::RequireConsent {
                prompt: consent_prompt(call),
            },
            (Tier::Off, _) => unreachable!("guarded above"),
        }
    }
}

fn effective_tier(s: &AutomationSettings, surface_tier: Tier) -> Tier {
    // ADR-0020 W1 — surface tier `Off` means "inherit from the global
    // `default_tier`". Anything else wins (so an explicit per-surface
    // PerCall is still respected even when the default is Whitelist).
    //
    // Pre-W1 semantics ("surface tier always wins") made the Settings UI
    // global "Default tier" control a no-op since the default serde
    // value for a surface is Off. We honour the operator's intent now.
    match surface_tier {
        Tier::Off => s.default_tier,
        other => other,
    }
}

/// ADR-0020 W1 — per-character / per-tool override that strengthens the
/// effective tier for a single call. Today only `force_tier ==
/// Some(PerCall)` has meaning: when the gate would have returned `Allow`
/// for a `Driving` call, upgrade to `RequireConsent`. Read-only calls and
/// other `force_tier` values pass through unchanged so the helper only
/// ever moves the safety dial *up*.
pub fn maybe_upgrade_to_consent(
    decision: Decision,
    force_tier: Option<Tier>,
    call: &Call<'_>,
) -> Decision {
    if force_tier != Some(Tier::PerCall) {
        return decision;
    }
    if call.kind() != CallKind::Driving {
        return decision;
    }
    match decision {
        Decision::Allow => Decision::RequireConsent {
            prompt: consent_prompt(call),
        },
        // Already RequireConsent / Deny — no movement needed.
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_timeout_defaults_when_unset() {
        // A settings.json written before this field existed deserializes to 0.
        let s = AutomationSettings {
            consent_timeout_ms: 0,
            ..AutomationSettings::default()
        };
        assert_eq!(s.consent_timeout_ms(), DEFAULT_CONSENT_TIMEOUT_MS);
    }

    #[test]
    fn consent_timeout_is_capped_below_the_sidecar_tool_budget() {
        // The sidecar abandons a plugin tool call at 120s. A longer consent
        // window would let the operator answer a call that is already dead.
        let s = AutomationSettings {
            consent_timeout_ms: 10 * 60 * 1000,
            ..AutomationSettings::default()
        };
        assert_eq!(s.consent_timeout_ms(), MAX_CONSENT_TIMEOUT_MS);
        const {
            assert!(MAX_CONSENT_TIMEOUT_MS < 120_000);
        }
    }

    #[test]
    fn consent_timeout_is_floored_at_an_answerable_window() {
        let s = AutomationSettings {
            consent_timeout_ms: 100,
            ..AutomationSettings::default()
        };
        assert_eq!(s.consent_timeout_ms(), MIN_CONSENT_TIMEOUT_MS);
    }

    #[test]
    fn consent_timeout_passes_through_a_sane_value() {
        let s = AutomationSettings {
            consent_timeout_ms: 45_000,
            ..AutomationSettings::default()
        };
        assert_eq!(s.consent_timeout_ms(), 45_000);
    }

    #[test]
    fn default_consent_timeout_is_the_documented_90s() {
        assert_eq!(
            AutomationSettings::default().consent_timeout_ms(),
            90_000,
            "the default must stay long enough to cover push → unlock → answer"
        );
    }

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

    fn inspect_call(surface: Surface) -> Call<'static> {
        Call {
            command: "read_tree",
            surface,
            plugin_id: None,
            target: TargetMeta::default(),
        }
    }

    #[test]
    fn settings_defaults_include_behavior_fields() {
        let s = AutomationSettings::default();
        // On by default: an un-scaled Retina frame inlines as megabytes of
        // base64 into the chat transcript (see the type's doc comment).
        assert!(s.screenshot_scaling.enabled);
        assert_eq!(s.screenshot_scaling.max_width, 1280);
        assert_eq!(s.screenshot_scaling.max_height, 800);
        assert!(s.screenshot_dedup);
        assert!(!s.always_hide_picture_in_picture);
        assert_eq!(s.paste_threshold_chars, 200);
    }

    #[test]
    fn settings_old_payload_without_behavior_fields_deserializes() {
        // Pre-existing persisted JSON (no behavior fields) must keep
        // round-tripping via the container-level #[serde(default)].
        let json = r#"{"enabled":true,"defaultTier":"off","whitelist":{"processNames":[],"windowTitlePatterns":[]},"audit":{"retentionDays":30,"exportEnabled":true},"redactScreenshots":false}"#;
        let s: AutomationSettings = serde_json::from_str(json).unwrap();
        assert!(s.enabled);
        assert!(s.screenshot_dedup);
        assert!(!s.always_hide_picture_in_picture);
        assert_eq!(s.paste_threshold_chars, 200);
        // A payload that predates the field adopts the new default rather than
        // staying off: not having chosen is what "default" means here. An
        // operator who explicitly turned scaling off has `enabled: false`
        // persisted and keeps it.
        assert!(s.screenshot_scaling.enabled);
    }

    fn record_start_call() -> Call<'static> {
        Call {
            command: "record_start",
            surface: Surface::ComputerUse,
            plugin_id: Some("cognia-skill-recorder"),
            target: TargetMeta {
                process_name: Some("Safari".into()),
                window_title: Some("Invoices".into()),
            },
        }
    }

    #[test]
    fn record_start_is_a_driving_call() {
        assert!(matches!(record_start_call().kind(), CallKind::Driving));
    }

    #[test]
    fn record_start_forces_per_call_even_on_a_whitelist_tier() {
        // The whole point: `Whitelist` would otherwise auto-allow arming a
        // global input hook plus continuous screen capture with no review.
        let mut whitelist = Whitelist::default();
        whitelist.process_names.push("Safari".into());
        let gate = PermissionGate::new(AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            whitelist,
            ..AutomationSettings::default()
        });
        assert!(matches!(
            gate.evaluate(&record_start_call()),
            Decision::RequireConsent { .. }
        ));
    }

    #[test]
    fn forces_per_call_still_covers_shell_class() {
        let bash = Call {
            command: "bash",
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: TargetMeta::default(),
        };
        assert!(bash.forces_per_call());
        assert!(record_start_call().forces_per_call());
        let click = Call {
            command: "click",
            surface: Surface::ComputerUse,
            plugin_id: None,
            target: TargetMeta::default(),
        };
        assert!(!click.forces_per_call());
    }

    #[test]
    fn kill_switch_denies_record_start_before_any_prompt() {
        // The ordering IS the security contract: `evaluate` must reach the deny
        // before it can construct a consent prompt, so an engaged kill switch
        // can never produce a dialog that a user might approve.
        let gate = PermissionGate::new(AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..AutomationSettings::default()
        });
        gate.engage_kill_switch();
        assert!(matches!(
            gate.evaluate(&record_start_call()),
            Decision::Deny(AutomationError::KillSwitchActive)
        ));
    }

    #[test]
    fn disabled_engine_denies_record_start_without_prompting() {
        let gate = PermissionGate::new(AutomationSettings {
            enabled: false,
            default_tier: Tier::Whitelist,
            ..AutomationSettings::default()
        });
        assert!(matches!(
            gate.evaluate(&record_start_call()),
            Decision::Deny(AutomationError::PermissionDenied { .. })
        ));
    }

    #[test]
    fn record_start_outside_the_whitelist_is_denied_not_prompted() {
        // Scope-derived target metadata is what makes this reachable at all —
        // the old bypassed path passed no target, so the whitelist never applied
        // to a recording.
        let mut whitelist = Whitelist::default();
        whitelist.process_names.push("Mail".into());
        let gate = PermissionGate::new(AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            whitelist,
            ..AutomationSettings::default()
        });
        assert!(matches!(
            gate.evaluate(&record_start_call()),
            Decision::Deny(AutomationError::WhitelistMiss)
        ));
    }

    #[test]
    fn record_start_prompt_is_one_shot() {
        match PermissionGate::new(AutomationSettings {
            enabled: true,
            default_tier: Tier::PerCall,
            ..AutomationSettings::default()
        })
        .evaluate(&record_start_call())
        {
            Decision::RequireConsent { prompt } => {
                assert!(prompt.is_one_shot());
                assert_eq!(prompt.command, "record_start");
            }
            other => panic!("expected a consent prompt, got {other:?}"),
        }
    }

    #[test]
    fn ordinary_prompts_are_not_one_shot() {
        let prompt = ConsentPrompt {
            command: "click".into(),
            surface: Surface::ComputerUse,
            plugin_id: None,
            process_name: None,
            window_title: None,
            command_detail: None,
            session_key: None,
        };
        assert!(!prompt.is_one_shot());
    }

    #[test]
    fn mutating_automation_commands_are_driving_calls() {
        let paste = Call {
            command: "paste",
            surface: Surface::Workflow,
            plugin_id: None,
            target: TargetMeta::default(),
        };
        assert!(matches!(paste.kind(), CallKind::Driving));
        let launch = Call {
            command: "launch_app",
            surface: Surface::Workflow,
            plugin_id: None,
            target: TargetMeta::default(),
        };
        assert!(matches!(launch.kind(), CallKind::Driving));
        let perform_action = Call {
            command: "perform_action",
            surface: Surface::Plugin,
            plugin_id: Some("computer-use"),
            target: TargetMeta::default(),
        };
        assert!(matches!(perform_action.kind(), CallKind::Driving));
    }

    #[test]
    fn disabled_engine_denies_driving_but_not_inspection() {
        // A merely-disabled engine (master toggle off, kill switch NOT
        // engaged) blocks anything that drives the desktop or captures pixels
        // with a plain PermissionDenied — not the emergency KillSwitchActive.
        let g = PermissionGate::new(AutomationSettings {
            enabled: false,
            ..Default::default()
        });
        assert!(matches!(
            g.evaluate(&read_call(Surface::Workflow)),
            Decision::Deny(AutomationError::PermissionDenied { .. })
        ));
        assert!(matches!(
            g.evaluate(&click_call(Surface::Workflow)),
            Decision::Deny(AutomationError::PermissionDenied { .. })
        ));
        // Passive inspection (the Settings → Inspector diagnostic) still works
        // even with the engine disabled and no tier configured.
        assert!(matches!(
            g.evaluate(&inspect_call(Surface::Workflow)),
            Decision::Allow
        ));
    }

    #[test]
    fn engaged_kill_switch_blocks_even_passive_inspection() {
        // The explicit emergency stop rejects EVERYTHING, inspection included,
        // until the operator re-enables the engine.
        let g = PermissionGate::new(AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        });
        assert!(matches!(
            g.evaluate(&inspect_call(Surface::Workflow)),
            Decision::Allow
        ));
        g.engage_kill_switch();
        assert!(matches!(
            g.evaluate(&inspect_call(Surface::Workflow)),
            Decision::Deny(AutomationError::KillSwitchActive)
        ));
        assert!(matches!(
            g.evaluate(&click_call(Surface::Workflow)),
            Decision::Deny(AutomationError::KillSwitchActive)
        ));
        // A bulk settings save carrying `enabled == true` must NOT release the
        // emergency stop (the stale-save resume bug).
        g.update(|s| s.enabled = true);
        assert!(matches!(
            g.evaluate(&inspect_call(Surface::Workflow)),
            Decision::Deny(AutomationError::KillSwitchActive)
        ));
        // Only the explicit operator resume (`set_enabled(true)`) releases it.
        g.set_enabled(true);
        assert!(matches!(
            g.evaluate(&inspect_call(Surface::Workflow)),
            Decision::Allow
        ));
    }

    #[test]
    fn set_enabled_false_leaves_kill_switch_untouched() {
        // Disabling the engine is not a resume — an engaged kill switch stays
        // engaged (and a disabled engine denies anyway).
        let g = PermissionGate::new(AutomationSettings {
            enabled: true,
            ..Default::default()
        });
        g.engage_kill_switch();
        g.set_enabled(false);
        assert!(g.kill_switch_engaged());
        assert!(matches!(
            g.evaluate(&inspect_call(Surface::Workflow)),
            Decision::Deny(AutomationError::KillSwitchActive)
        ));
    }

    #[test]
    fn surface_off_inherits_default_off() {
        // Default settings have default_tier = Off, so a surface that
        // serializes as Off still denies (inherit-from-default lands back
        // on Off). Pre-W1 this passed for the same reason, but the
        // reasoning shifts: surface-Off is now an inherit-marker, not a
        // hard deny override.
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
    fn surface_off_inherits_default_whitelist() {
        // ADR-0020 W1 — when a surface tier is left at the default Off,
        // the operator's global `default_tier` finally has meaning. A
        // global Whitelist with an untargeted read-only call should now
        // resolve Allow (was Deny pre-W1 because "surface always won").
        let s = AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        let d = g.evaluate(&read_call(Surface::Workflow));
        assert!(matches!(d, Decision::Allow));
    }

    #[test]
    fn surface_per_call_still_wins_over_default_whitelist() {
        // Per-W1 contract: surface tier wins when it is anything other than
        // Off. An explicit PerCall on `workflow` must keep requiring
        // consent on driving calls even when the global default is the
        // less-strict Whitelist.
        let mut s = AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        };
        s.per_surface.workflow.tier = Tier::PerCall;
        let g = PermissionGate::new(s);
        let d = g.evaluate(&click_call(Surface::Workflow));
        assert!(matches!(d, Decision::RequireConsent { .. }));
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

    fn bash_call(surface: Surface) -> Call<'static> {
        Call {
            command: "bash",
            surface,
            plugin_id: None,
            target: TargetMeta::default(),
        }
    }

    #[test]
    fn shell_class_bash_under_whitelist_requires_consent_not_allow() {
        // Regression: an untargeted bash call under Whitelist used to skip the
        // whitelist gate and auto-allow. It must now require consent.
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.computer_use.tier = Tier::Whitelist;
        let g = PermissionGate::new(s);
        let d = g.evaluate(&bash_call(Surface::ComputerUse));
        assert!(matches!(d, Decision::RequireConsent { .. }));
    }

    #[test]
    fn shell_class_bash_under_per_call_requires_consent() {
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.computer_use.tier = Tier::PerCall;
        let g = PermissionGate::new(s);
        assert!(matches!(
            g.evaluate(&bash_call(Surface::ComputerUse)),
            Decision::RequireConsent { .. }
        ));
    }

    #[test]
    fn shell_class_still_denied_when_surface_off() {
        // Off tier must still hard-deny shell-class (the consent upgrade only
        // fires once the surface is enabled).
        let g = PermissionGate::new(AutomationSettings {
            enabled: true,
            ..Default::default()
        });
        assert!(matches!(
            g.evaluate(&bash_call(Surface::ComputerUse)),
            Decision::Deny(_)
        ));
    }

    #[test]
    fn gate_consent_prompt_has_no_command_detail() {
        // The gate never sees the action payload; the dispatcher fills it.
        let mut s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        s.per_surface.computer_use.tier = Tier::PerCall;
        let g = PermissionGate::new(s);
        match g.evaluate(&bash_call(Surface::ComputerUse)) {
            Decision::RequireConsent { prompt } => {
                assert_eq!(prompt.command, "bash");
                assert!(prompt.command_detail.is_none());
            }
            other => panic!("expected consent, got {other:?}"),
        }
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
        assert!(matches!(
            d,
            Decision::Deny(AutomationError::KillSwitchActive)
        ));
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
            assert!(
                matches!(d, Decision::Allow),
                "surface {:?} should allow",
                surf
            );
        }
    }

    #[test]
    fn sandbox_surface_bypasses_permission_gate() {
        // Sandbox calls own their own strict-mode policy in
        // `sandbox::sandbox_exec`; if any caller routes a Sandbox-tagged
        // call through `command_body!`, the gate must let it through so
        // the sandbox subsystem can apply its own checks.
        let s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        let call = Call {
            command: "bash",
            surface: Surface::Sandbox,
            plugin_id: None,
            target: TargetMeta::default(),
        };
        assert!(matches!(g.evaluate(&call), Decision::Allow));
    }

    #[test]
    fn maybe_upgrade_to_consent_upgrades_allow_on_driving() {
        let s = AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        let call = click_call(Surface::ComputerUse);
        let allowed = g.evaluate(&call);
        assert!(matches!(allowed, Decision::Allow));
        let upgraded = maybe_upgrade_to_consent(allowed, Some(Tier::PerCall), &call);
        assert!(matches!(upgraded, Decision::RequireConsent { .. }));
    }

    #[test]
    fn maybe_upgrade_to_consent_skips_read_only_calls() {
        let s = AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        let call = read_call(Surface::ComputerUse);
        let allowed = g.evaluate(&call);
        let upgraded = maybe_upgrade_to_consent(allowed, Some(Tier::PerCall), &call);
        assert!(matches!(upgraded, Decision::Allow));
    }

    #[test]
    fn maybe_upgrade_to_consent_passes_through_when_force_tier_unset() {
        let s = AutomationSettings {
            enabled: true,
            default_tier: Tier::Whitelist,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        let call = click_call(Surface::ComputerUse);
        let allowed = g.evaluate(&call);
        let unchanged = maybe_upgrade_to_consent(allowed, None, &call);
        assert!(matches!(unchanged, Decision::Allow));
    }

    #[test]
    fn maybe_upgrade_to_consent_never_weakens_a_deny() {
        let s = AutomationSettings {
            enabled: true,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        // ComputerUse surface stays at default Off; default_tier Off too,
        // so the call denies. force_tier=PerCall must not reverse this.
        let call = click_call(Surface::ComputerUse);
        let denied = g.evaluate(&call);
        assert!(matches!(denied, Decision::Deny(_)));
        let still_denied = maybe_upgrade_to_consent(denied, Some(Tier::PerCall), &call);
        assert!(matches!(still_denied, Decision::Deny(_)));
    }

    #[test]
    fn sandbox_surface_denied_when_disabled() {
        // A disabled engine (master toggle off) still blocks even
        // sandbox-tagged calls — the safety invariant is "automation engine
        // off → all driving calls deny". Sandbox calls don't go through the
        // automation engine in practice, so this branch is mostly
        // defence-in-depth. Now that the emergency stop is a distinct flag,
        // a merely-disabled engine reports PermissionDenied rather than the
        // KillSwitchActive it used to.
        let s = AutomationSettings {
            enabled: false,
            ..Default::default()
        };
        let g = PermissionGate::new(s);
        let call = Call {
            command: "bash",
            surface: Surface::Sandbox,
            plugin_id: None,
            target: TargetMeta::default(),
        };
        assert!(matches!(
            g.evaluate(&call),
            Decision::Deny(AutomationError::PermissionDenied { .. })
        ));
    }
}
