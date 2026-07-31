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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ShortcutBindingDto {
    pub id: String,
    pub chord: String,
}

impl ShortcutRegistry {
    pub fn list(&self) -> Vec<ShortcutBindingDto> {
        let guard = self.inner.lock();
        guard
            .id_to_chord
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
        self.inner.lock().id_to_chord.get(id).cloned()
    }

    /// Returns the id that already owns `normalized_chord`, if any — the
    /// renderer asks via `shortcut_check_conflict` before recording a new
    /// binding so the user gets a warning before the OS-level call.
    pub fn conflict_for(&self, normalized_chord: &str, ignoring_id: &str) -> Option<String> {
        let guard = self.inner.lock();
        guard
            .chord_to_id
            .get(normalized_chord)
            .filter(|owner| owner.as_str() != ignoring_id)
            .cloned()
    }

    /// Bind `id → chord`. If `id` already had a binding, the old chord is
    /// unregistered with the OS first. Conflicts (another id already owns
    /// the chord) are rejected without touching the OS.
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
            if let Some(existing) = guard.chord_to_id.get(&normalized) {
                if existing != id {
                    return Err(ShortcutError::Conflict(normalized, existing.clone()));
                }
            }
        }

        // If `id` already has a binding, unregister the old chord first.
        let previous_chord = self.inner.lock().id_to_chord.get(id).cloned();
        if let Some(prev) = previous_chord.as_ref() {
            if prev != &normalized {
                if let Some(prev_parsed) = parse_chord(prev) {
                    let _ = app.global_shortcut().unregister(prev_parsed);
                }
            }
        }

        // OS-level register — duplicates are silently OK on the OS side
        // because we already filtered conflicts above.
        app.global_shortcut()
            .register(parsed)
            .map_err(|e| ShortcutError::OsRegister(e.to_string()))?;

        let mut guard = self.inner.lock();
        if let Some(prev) = previous_chord.as_ref() {
            guard.chord_to_id.remove(prev);
        }
        guard.chord_to_id.insert(normalized.clone(), id.to_string());
        guard.id_to_chord.insert(id.to_string(), normalized);
        Ok(())
    }

    pub fn unbind<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> Result<(), ShortcutError> {
        let chord = self.inner.lock().id_to_chord.remove(id);
        if let Some(chord) = chord {
            if let Some(parsed) = parse_chord(&chord) {
                app.global_shortcut()
                    .unregister(parsed)
                    .map_err(|e| ShortcutError::OsUnregister(e.to_string()))?;
            }
            self.inner.lock().chord_to_id.remove(&chord);
        }
        Ok(())
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
                let state = app.state::<crate::automation::commands::AutomationState>();
                state.gate.engage_kill_switch();
                // ADR-0020 W3 — parity with the `automation_kill_switch`
                // Tauri command (which is what the renderer's Settings →
                // Automation kill button calls): engaging the switch
                // drops every Rust-side per-session consent grant. The
                // shortcut path used to only flip the engine; now it
                // matches the renderer path so the operator-facing
                // semantics are the same regardless of trigger.
                state.consent.clear_session_grants();
                let _ = app.emit("automation:kill-switch", serde_json::Value::Null);
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
pub fn seed_builtins<R: Runtime>(app: &AppHandle<R>, registry: &ShortcutRegistry) {
    for (id, chord) in [
        ("tray.show", "ctrl+shift+space"),
        ("tray.open-logs", "ctrl+shift+l"),
        ("tray.automation-kill", "ctrl+alt+k"),
        ("selection.captureClipboard", "alt+shift+c"),
    ] {
        if let Err(e) = registry.bind(app, id, chord) {
            log::warn!("failed to seed built-in shortcut {id}={chord}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
