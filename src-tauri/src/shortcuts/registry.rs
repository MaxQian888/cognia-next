//! In-process registry of active global shortcut bindings.
//!
//! Two storage layers cooperate:
//!   - `chord_to_id`: the canonical map. A normalized chord string maps to
//!     the binding id the renderer wants to fire when that chord triggers.
//!   - `id_to_chord`: reverse lookup used when the renderer rebinds an
//!     existing id (so we know which chord to unregister with the OS).
//!
//! The renderer is the source of truth for persistence — Rust never writes
//! to disk; the renderer hydrates us via `shortcut_bind` at boot and again
//! every time the user changes a binding.

use std::collections::HashMap;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

#[derive(thiserror::Error, Debug)]
pub enum ShortcutError {
    #[error("chord '{0}' could not be parsed")]
    InvalidChord(String),
    #[error("chord '{0}' already bound to id '{1}'")]
    Conflict(String, String),
    #[error("OS-level register failed: {0}")]
    OsRegister(String),
    #[error("OS-level unregister failed: {0}")]
    OsUnregister(String),
}

#[derive(Default)]
pub struct ShortcutRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Default)]
struct RegistryInner {
    chord_to_id: HashMap<String, String>,
    id_to_chord: HashMap<String, String>,
    reserved_selection_chord_to_id: HashMap<String, String>,
    reserved_selection_id_to_chord: HashMap<String, String>,
    selection_scope_active: bool,
}

fn is_selection_scoped(id: &str) -> bool {
    id.starts_with("selection.")
}

/// The selection bindings to register, in the order they must be registered.
///
/// Order is part of the contract, not an implementation detail. A chord can be
/// claimed by only one id, and a user reservation for one action can collide
/// with another action's built-in default (rebinding `selection.explain` to
/// `selection.copy`'s default chord is enough). Whoever binds first wins, so
/// iterating a `HashMap` here meant the same build gave a different answer on
/// different launches, with the loser dropped on a log line.
///
/// Two rules settle it:
///   1. reservations bind before defaults, so the chord the user explicitly
///      chose beats a default nobody asked for, and
///   2. within each group the ids are sorted, so a collision between two
///      reservations resolves the same way every time.
fn resolved_selection_bindings(
    defaults: &[(&str, &str)],
    reserved: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let mut reserved_bindings: Vec<(String, String)> = reserved
        .iter()
        .map(|(id, chord)| (id.clone(), chord.clone()))
        .collect();
    reserved_bindings.sort_unstable();

    let mut default_bindings: Vec<(String, String)> = defaults
        .iter()
        .filter(|(id, _)| !reserved.contains_key(*id))
        .map(|(id, chord)| ((*id).to_string(), (*chord).to_string()))
        .collect();
    default_bindings.sort_unstable();

    reserved_bindings.extend(default_bindings);
    reserved_bindings
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ShortcutBindingDto {
    pub id: String,
    pub chord: String,
}

impl ShortcutRegistry {
    pub fn list(&self) -> Vec<ShortcutBindingDto> {
        let guard = self.inner.lock();
        let mut bindings = guard.reserved_selection_id_to_chord.clone();
        bindings.extend(guard.id_to_chord.clone());
        bindings
            .iter()
            .map(|(id, chord)| ShortcutBindingDto {
                id: id.clone(),
                chord: chord.clone(),
            })
            .collect()
    }

    pub fn id_for_chord(&self, normalized: &str) -> Option<String> {
        self.inner.lock().chord_to_id.get(normalized).cloned()
    }

    pub fn chord_for_id(&self, id: &str) -> Option<String> {
        let guard = self.inner.lock();
        guard
            .id_to_chord
            .get(id)
            .or_else(|| guard.reserved_selection_id_to_chord.get(id))
            .cloned()
    }

    /// Returns the id that already owns `normalized_chord`, if any — the
    /// renderer asks via `shortcut_check_conflict` before recording a new
    /// binding so the user gets a warning before the OS-level call.
    pub fn conflict_for(&self, normalized_chord: &str, ignoring_id: &str) -> Option<String> {
        let guard = self.inner.lock();
        guard
            .chord_to_id
            .get(normalized_chord)
            .or_else(|| guard.reserved_selection_chord_to_id.get(normalized_chord))
            .filter(|owner| owner.as_str() != ignoring_id)
            .cloned()
    }

    /// Bind `id → chord`. A replacement is transactional: register the new OS
    /// chord first, release the old one, then commit maps/reservations.
    /// Conflicts are rejected without touching the OS.
    pub fn bind<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: &str,
        chord: &str,
    ) -> Result<(), ShortcutError> {
        let normalized = normalize_chord(chord);
        let parsed = parse_chord(&normalized)
            .ok_or_else(|| ShortcutError::InvalidChord(chord.to_string()))?;

        {
            let guard = self.inner.lock();
            if let Some(existing) = guard
                .chord_to_id
                .get(&normalized)
                .or_else(|| guard.reserved_selection_chord_to_id.get(&normalized))
            {
                if existing != id {
                    return Err(ShortcutError::Conflict(normalized, existing.clone()));
                }
            }
        }

        if is_selection_scoped(id) {
            let active = self.inner.lock().selection_scope_active;
            if !active {
                self.commit_selection_reservation(id, &normalized);
                return Ok(());
            }
            self.bind_active(app, id, &normalized, parsed)?;
            self.commit_selection_reservation(id, &normalized);
            return Ok(());
        }

        self.bind_active(app, id, &normalized, parsed)
    }

    fn commit_selection_reservation(&self, id: &str, normalized: &str) {
        let mut guard = self.inner.lock();
        if let Some(previous) = guard
            .reserved_selection_id_to_chord
            .insert(id.to_string(), normalized.to_string())
        {
            guard.reserved_selection_chord_to_id.remove(&previous);
        }
        guard
            .reserved_selection_chord_to_id
            .insert(normalized.to_string(), id.to_string());
    }

    fn bind_active<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        id: &str,
        normalized: &str,
        parsed: Shortcut,
    ) -> Result<(), ShortcutError> {
        {
            let guard = self.inner.lock();
            if let Some(existing) = guard.chord_to_id.get(normalized) {
                if existing != id {
                    return Err(ShortcutError::Conflict(
                        normalized.to_string(),
                        existing.clone(),
                    ));
                }
            }
        }

        let previous_chord = self.inner.lock().id_to_chord.get(id).cloned();
        if previous_chord.as_deref() == Some(normalized) {
            return Ok(());
        }

        // Register-first keeps the old binding intact if the OS rejects the
        // new chord. If releasing the old chord fails, roll the new one back
        // and leave the in-memory maps untouched.
        app.global_shortcut()
            .register(parsed.clone())
            .map_err(|e| ShortcutError::OsRegister(e.to_string()))?;
        if let Some(previous) = previous_chord.as_deref().and_then(parse_chord) {
            if let Err(error) = app.global_shortcut().unregister(previous) {
                let _ = app.global_shortcut().unregister(parsed);
                return Err(ShortcutError::OsUnregister(error.to_string()));
            }
        }

        let mut guard = self.inner.lock();
        if let Some(prev) = previous_chord.as_ref() {
            guard.chord_to_id.remove(prev);
        }
        guard
            .chord_to_id
            .insert(normalized.to_string(), id.to_string());
        guard
            .id_to_chord
            .insert(id.to_string(), normalized.to_string());
        Ok(())
    }

    pub fn unbind<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> Result<(), ShortcutError> {
        self.unbind_active(app, id)?;
        if is_selection_scoped(id) {
            let mut guard = self.inner.lock();
            if let Some(chord) = guard.reserved_selection_id_to_chord.remove(id) {
                guard.reserved_selection_chord_to_id.remove(&chord);
            }
        }
        Ok(())
    }

    fn unbind_active<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> Result<(), ShortcutError> {
        let chord = self.inner.lock().id_to_chord.get(id).cloned();
        let Some(chord) = chord else {
            return Ok(());
        };
        if let Some(parsed) = parse_chord(&chord) {
            app.global_shortcut()
                .unregister(parsed)
                .map_err(|e| ShortcutError::OsUnregister(e.to_string()))?;
        }
        let mut guard = self.inner.lock();
        guard.id_to_chord.remove(id);
        guard.chord_to_id.remove(&chord);
        Ok(())
    }

    pub fn activate_selection_scope<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        defaults: &[(&str, &str)],
    ) {
        self.inner.lock().selection_scope_active = true;
        let reserved = self.inner.lock().reserved_selection_id_to_chord.clone();
        // Custom selection.action:* chords hydrate while the scope is off.
        // They are not in the built-in defaults table, so fold every reserved
        // selection binding into activation rather than leaving plugin/user
        // actions permanently reserved-but-unregistered.
        let bindings = resolved_selection_bindings(defaults, &reserved);
        for (id, chord) in bindings {
            if let Err(error) = self.bind(app, &id, &chord) {
                log::warn!("selection shortcut {id}={chord} not activated: {error}");
            }
        }
    }

    pub fn deactivate_selection_scope<R: Runtime>(&self, app: &AppHandle<R>) {
        let ids: Vec<String> = self
            .inner
            .lock()
            .id_to_chord
            .keys()
            .filter(|id| is_selection_scoped(id))
            .cloned()
            .collect();
        let mut complete = true;
        for id in ids {
            if let Err(error) = self.unbind_active(app, &id) {
                complete = false;
                log::warn!("selection shortcut {id} not deactivated: {error}");
            }
        }
        self.inner.lock().selection_scope_active = !complete;
    }

    pub fn selection_scope_active(&self) -> bool {
        self.inner.lock().selection_scope_active
    }

    /// Look up the id for `shortcut` (matched by structural equality), run
    /// any built-in side effect, and emit `shortcut://triggered { id }`.
    /// Called once per chord press by the plugin-global-shortcut handler
    /// installed in `lib.rs`.
    ///
    /// The three built-in ids reproduce the behaviour the inline closure
    /// used to provide (toggle window / show logs / kill switch). Custom
    /// renderer-bound ids skip the native step and only get the event.
    pub fn dispatch<R: Runtime>(&self, app: &AppHandle<R>, shortcut: &Shortcut) {
        let normalized = format_shortcut(shortcut);
        let Some(id) = self.id_for_chord(&normalized) else {
            return;
        };
        log::debug!("shortcut dispatch: chord={normalized} id={id}");

        match id.as_str() {
            "tray.show" => {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    let focused = window.is_focused().unwrap_or(false);
                    if visible && focused {
                        let _ = window.hide();
                    } else {
                        crate::window_utils::bring_window_to_front(&window);
                    }
                }
            }
            "tray.open-logs" => {
                crate::window_utils::bring_main_window_to_front(app);
                let _ = app.emit("tray://open-logs", serde_json::Value::Null);
            }
            "tray.automation-kill" => {
                use tauri::Manager;
                // Parity with every other trigger is structural now rather than
                // maintained by hand: this path used to flip the engine and
                // clear grants, but skipped persisting the disabled state,
                // releasing a screen-off virtual display, and stopping an
                // in-flight recording.
                let state = app.state::<crate::automation::commands::AutomationState>();
                crate::automation::kill_switch::engage(
                    app,
                    &state,
                    crate::automation::kill_switch::KillSwitchCause::Shortcut,
                );
            }
            "selection.captureClipboard" => {
                crate::selection_toolbar::spawn_clipboard_capture(app);
            }
            // The six selection-toolbar action chords. Bound only while the
            // feature is running (see `selection_toolbar::bind_action_shortcuts`),
            // and a no-op unless a selection is currently on offer.
            other if other.starts_with("selection.") => {
                crate::selection_toolbar::dispatch_shortcut(app, other);
            }
            _ => {}
        }

        let _ = app.emit("shortcut://triggered", serde_json::json!({ "id": id }));
    }
}

/// Canonicalise a chord string. Matches `lib/shortcuts/utils.ts:
/// normalizeKeyCombo` so the two sides round-trip cleanly:
///   - lowercase
///   - whitespace stripped from each part
///   - modifiers sorted (ctrl → alt → shift → meta), keys after them
///     lexicographically
pub fn normalize_chord(chord: &str) -> String {
    const MODIFIER_ORDER: [&str; 4] = ["ctrl", "alt", "shift", "meta"];
    let mut parts: Vec<String> = chord
        .split('+')
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
        .collect();
    parts.sort_by(|a, b| {
        let a_idx = MODIFIER_ORDER.iter().position(|m| *m == a);
        let b_idx = MODIFIER_ORDER.iter().position(|m| *m == b);
        match (a_idx, b_idx) {
            (Some(ai), Some(bi)) => ai.cmp(&bi),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
    parts.join("+")
}

/// Parse a normalized chord into a `tauri_plugin_global_shortcut::Shortcut`.
/// Returns `None` for chords with unknown key codes.
pub fn parse_chord(normalized: &str) -> Option<Shortcut> {
    let mut modifiers = Modifiers::empty();
    let mut key: Option<Code> = None;
    for part in normalized.split('+') {
        match part {
            "ctrl" => modifiers |= Modifiers::CONTROL,
            "alt" => modifiers |= Modifiers::ALT,
            "shift" => modifiers |= Modifiers::SHIFT,
            "meta" => modifiers |= Modifiers::META,
            other => {
                if key.is_some() {
                    return None;
                }
                key = code_from_part(other);
            }
        }
    }
    key.map(|code| Shortcut::new(Some(modifiers), code))
}

/// Render a parsed `Shortcut` back to the normalized chord form so the
/// global-shortcut handler can look up which id fired.
pub fn format_shortcut(shortcut: &Shortcut) -> String {
    let mut parts: Vec<&'static str> = Vec::new();
    if shortcut.mods.contains(Modifiers::CONTROL) {
        parts.push("ctrl");
    }
    if shortcut.mods.contains(Modifiers::ALT) {
        parts.push("alt");
    }
    if shortcut.mods.contains(Modifiers::SHIFT) {
        parts.push("shift");
    }
    if shortcut.mods.contains(Modifiers::META) {
        parts.push("meta");
    }
    let key_lower = part_from_code(shortcut.key);
    if !key_lower.is_empty() {
        let mut owned: Vec<String> = parts.into_iter().map(String::from).collect();
        owned.push(key_lower);
        owned.join("+")
    } else {
        parts.join("+")
    }
}

/// Subset of physical-key codes the unified shortcut panel needs. The full
/// surface lives in `tauri_plugin_global_shortcut::Code`; we expose the
/// characters / function keys the renderer actually offers in its capture
/// UI plus the three built-in chord keys (Space, KeyL, KeyK).
fn code_from_part(part: &str) -> Option<Code> {
    // Letters a-z
    if part.len() == 1 {
        let c = part.chars().next()?;
        if c.is_ascii_alphabetic() {
            return Some(match c.to_ascii_uppercase() {
                'A' => Code::KeyA,
                'B' => Code::KeyB,
                'C' => Code::KeyC,
                'D' => Code::KeyD,
                'E' => Code::KeyE,
                'F' => Code::KeyF,
                'G' => Code::KeyG,
                'H' => Code::KeyH,
                'I' => Code::KeyI,
                'J' => Code::KeyJ,
                'K' => Code::KeyK,
                'L' => Code::KeyL,
                'M' => Code::KeyM,
                'N' => Code::KeyN,
                'O' => Code::KeyO,
                'P' => Code::KeyP,
                'Q' => Code::KeyQ,
                'R' => Code::KeyR,
                'S' => Code::KeyS,
                'T' => Code::KeyT,
                'U' => Code::KeyU,
                'V' => Code::KeyV,
                'W' => Code::KeyW,
                'X' => Code::KeyX,
                'Y' => Code::KeyY,
                'Z' => Code::KeyZ,
                _ => return None,
            });
        }
        if c.is_ascii_digit() {
            return Some(match c {
                '0' => Code::Digit0,
                '1' => Code::Digit1,
                '2' => Code::Digit2,
                '3' => Code::Digit3,
                '4' => Code::Digit4,
                '5' => Code::Digit5,
                '6' => Code::Digit6,
                '7' => Code::Digit7,
                '8' => Code::Digit8,
                '9' => Code::Digit9,
                _ => return None,
            });
        }
    }
    Some(match part {
        "space" => Code::Space,
        "enter" => Code::Enter,
        "tab" => Code::Tab,
        "escape" | "esc" => Code::Escape,
        "backspace" => Code::Backspace,
        "delete" => Code::Delete,
        "arrowup" | "up" => Code::ArrowUp,
        "arrowdown" | "down" => Code::ArrowDown,
        "arrowleft" | "left" => Code::ArrowLeft,
        "arrowright" | "right" => Code::ArrowRight,
        "f1" => Code::F1,
        "f2" => Code::F2,
        "f3" => Code::F3,
        "f4" => Code::F4,
        "f5" => Code::F5,
        "f6" => Code::F6,
        "f7" => Code::F7,
        "f8" => Code::F8,
        "f9" => Code::F9,
        "f10" => Code::F10,
        "f11" => Code::F11,
        "f12" => Code::F12,
        _ => return None,
    })
}

fn part_from_code(code: Code) -> String {
    match code {
        Code::KeyA => "a",
        Code::KeyB => "b",
        Code::KeyC => "c",
        Code::KeyD => "d",
        Code::KeyE => "e",
        Code::KeyF => "f",
        Code::KeyG => "g",
        Code::KeyH => "h",
        Code::KeyI => "i",
        Code::KeyJ => "j",
        Code::KeyK => "k",
        Code::KeyL => "l",
        Code::KeyM => "m",
        Code::KeyN => "n",
        Code::KeyO => "o",
        Code::KeyP => "p",
        Code::KeyQ => "q",
        Code::KeyR => "r",
        Code::KeyS => "s",
        Code::KeyT => "t",
        Code::KeyU => "u",
        Code::KeyV => "v",
        Code::KeyW => "w",
        Code::KeyX => "x",
        Code::KeyY => "y",
        Code::KeyZ => "z",
        Code::Digit0 => "0",
        Code::Digit1 => "1",
        Code::Digit2 => "2",
        Code::Digit3 => "3",
        Code::Digit4 => "4",
        Code::Digit5 => "5",
        Code::Digit6 => "6",
        Code::Digit7 => "7",
        Code::Digit8 => "8",
        Code::Digit9 => "9",
        Code::Space => "space",
        Code::Enter => "enter",
        Code::Tab => "tab",
        Code::Escape => "escape",
        Code::Backspace => "backspace",
        Code::Delete => "delete",
        Code::ArrowUp => "arrowup",
        Code::ArrowDown => "arrowdown",
        Code::ArrowLeft => "arrowleft",
        Code::ArrowRight => "arrowright",
        Code::F1 => "f1",
        Code::F2 => "f2",
        Code::F3 => "f3",
        Code::F4 => "f4",
        Code::F5 => "f5",
        Code::F6 => "f6",
        Code::F7 => "f7",
        Code::F8 => "f8",
        Code::F9 => "f9",
        Code::F10 => "f10",
        Code::F11 => "f11",
        Code::F12 => "f12",
        _ => return String::new(),
    }
    .to_string()
}

/// Seed the built-in shortcut ids on startup. The renderer overrides
/// any of them via `shortcut_bind` later; this just guarantees the OS-level
/// hot-keys are registered before the renderer has a chance to hydrate.
pub const BUILTIN_SHORTCUT_DEFAULTS: &[(&str, &str)] = &[
    ("tray.show", "ctrl+shift+space"),
    ("tray.open-logs", "ctrl+shift+l"),
    ("tray.automation-kill", "ctrl+alt+k"),
    ("chat.captureSmartSnapshot", "alt+shift+s"),
];

pub fn seed_builtins<R: Runtime>(app: &AppHandle<R>, registry: &ShortcutRegistry) {
    for (id, chord) in BUILTIN_SHORTCUT_DEFAULTS {
        if let Err(e) = registry.bind(app, id, chord) {
            log::warn!("failed to seed built-in shortcut {id}={chord}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_include_smart_snapshot_shortcut() {
        assert!(BUILTIN_SHORTCUT_DEFAULTS
            .iter()
            .any(|(id, chord)| *id == "chat.captureSmartSnapshot" && *chord == "alt+shift+s"));
    }

    #[test]
    fn normalize_chord_lowercases_and_sorts_modifiers() {
        assert_eq!(normalize_chord("Ctrl+Shift+Space"), "ctrl+shift+space");
        assert_eq!(normalize_chord("Shift + Ctrl + L"), "ctrl+shift+l");
        assert_eq!(normalize_chord("META + Alt + K"), "alt+meta+k");
    }

    #[test]
    fn normalize_chord_ignores_empty_segments() {
        assert_eq!(normalize_chord("Ctrl++S"), "ctrl+s");
        assert_eq!(normalize_chord("  Ctrl  +  s  "), "ctrl+s");
    }

    #[test]
    fn parse_chord_recognises_common_combos() {
        let s = parse_chord("ctrl+shift+space").unwrap();
        assert!(s.mods.contains(Modifiers::CONTROL | Modifiers::SHIFT));
        assert_eq!(s.key, Code::Space);

        let s = parse_chord("ctrl+alt+k").unwrap();
        assert!(s.mods.contains(Modifiers::CONTROL | Modifiers::ALT));
        assert_eq!(s.key, Code::KeyK);
    }

    #[test]
    fn parse_chord_rejects_unknown_keys() {
        assert!(parse_chord("ctrl+f99").is_none());
        assert!(parse_chord("ctrl").is_none()); // no key
    }

    #[test]
    fn format_shortcut_round_trips_through_parse() {
        let original = "ctrl+shift+l";
        let parsed = parse_chord(original).unwrap();
        assert_eq!(format_shortcut(&parsed), original);
    }

    #[test]
    fn conflict_for_ignores_self_match() {
        let reg = ShortcutRegistry::default();
        {
            // Manually seed without going through `bind` to avoid needing
            // an AppHandle; conflict detection only reads the maps.
            let mut g = reg.inner.lock();
            g.chord_to_id.insert("ctrl+s".into(), "doc.save".into());
            g.id_to_chord.insert("doc.save".into(), "ctrl+s".into());
        }
        assert_eq!(reg.conflict_for("ctrl+s", "doc.save"), None);
        assert_eq!(
            reg.conflict_for("ctrl+s", "other.id"),
            Some("doc.save".into())
        );
    }

    #[test]
    fn list_returns_every_binding() {
        let reg = ShortcutRegistry::default();
        {
            let mut g = reg.inner.lock();
            g.id_to_chord.insert("a".into(), "ctrl+a".into());
            g.id_to_chord.insert("b".into(), "ctrl+b".into());
            g.chord_to_id.insert("ctrl+a".into(), "a".into());
            g.chord_to_id.insert("ctrl+b".into(), "b".into());
        }
        let mut listed: Vec<String> = reg.list().into_iter().map(|b| b.id).collect();
        listed.sort();
        assert_eq!(listed, vec!["a", "b"]);
    }

    #[test]
    fn chord_for_id_returns_normalized_chord_or_none() {
        let reg = ShortcutRegistry::default();
        {
            let mut g = reg.inner.lock();
            g.id_to_chord
                .insert("tray.show".into(), "ctrl+shift+space".into());
            g.chord_to_id
                .insert("ctrl+shift+space".into(), "tray.show".into());
        }
        assert_eq!(
            reg.chord_for_id("tray.show"),
            Some("ctrl+shift+space".to_string())
        );
        assert_eq!(reg.chord_for_id("unknown.id"), None);
    }

    #[test]
    fn inactive_selection_bindings_remain_visible_and_reserved() {
        let reg = ShortcutRegistry::default();
        {
            let mut guard = reg.inner.lock();
            guard
                .reserved_selection_id_to_chord
                .insert("selection.showToolbar".into(), "alt+shift+space".into());
            guard
                .reserved_selection_chord_to_id
                .insert("alt+shift+space".into(), "selection.showToolbar".into());
        }

        assert_eq!(
            reg.chord_for_id("selection.showToolbar"),
            Some("alt+shift+space".into())
        );
        assert_eq!(
            reg.conflict_for("alt+shift+space", "other.id"),
            Some("selection.showToolbar".into())
        );
        assert!(reg
            .list()
            .iter()
            .any(|binding| binding.id == "selection.showToolbar"));
        assert!(!reg.selection_scope_active());
    }

    #[test]
    fn selection_shortcuts_are_not_unconditional_builtins() {
        assert!(BUILTIN_SHORTCUT_DEFAULTS
            .iter()
            .all(|(id, _)| !is_selection_scoped(id)));
    }

    #[test]
    fn selection_scope_activation_includes_reserved_custom_actions() {
        let reserved = HashMap::from([
            ("selection.copy".into(), "alt+shift+x".into()),
            (
                "selection.action:plug-a:rewrite".into(),
                "alt+shift+r".into(),
            ),
        ]);
        let bindings = resolved_selection_bindings(
            &[
                ("selection.copy", "alt+shift+1"),
                ("selection.ask", "alt+shift+4"),
            ],
            &reserved,
        );
        let lookup = |id: &str| {
            bindings
                .iter()
                .find(|(candidate, _)| candidate == id)
                .map(|(_, chord)| chord.as_str())
        };
        assert_eq!(lookup("selection.copy"), Some("alt+shift+x"));
        assert_eq!(lookup("selection.ask"), Some("alt+shift+4"));
        assert_eq!(lookup("selection.action:plug-a:rewrite"), Some("alt+shift+r"));
        // One entry per id: a reserved chord replaces the default rather than
        // racing it through a second bind call.
        assert_eq!(bindings.len(), 3);
    }

    #[test]
    fn a_reserved_chord_beats_another_actions_default_deterministically() {
        // The user moved `selection.explain` onto `selection.copy`'s default
        // chord. Only one id can hold it, so the order decides, and the order
        // must be the user's choice every single time.
        let reserved = HashMap::from([("selection.explain".to_string(), "alt+shift+1".to_string())]);
        let defaults = &[
            ("selection.copy", "alt+shift+1"),
            ("selection.explain", "alt+shift+2"),
        ];
        let expected = vec![
            ("selection.explain".to_string(), "alt+shift+1".to_string()),
            ("selection.copy".to_string(), "alt+shift+1".to_string()),
        ];
        // Repeated because the defect was a HashMap walk: one pass could agree
        // with the contract by luck.
        for _ in 0..16 {
            assert_eq!(resolved_selection_bindings(defaults, &reserved), expected);
        }
    }
}
