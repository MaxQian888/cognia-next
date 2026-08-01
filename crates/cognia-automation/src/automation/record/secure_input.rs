//! Whether a key run may be transcribed, and how.
//!
//! The rule is one sentence: **anything we are not certain is a plain field is
//! treated as secure.** `Unknown` and `Secure` are the same decision at every
//! call site, and the classification is a union over the whole run rather than a
//! sample at its start — focus can move mid-run, and the conservative reading is
//! the only safe one.
//!
//! A [`TextCapture::Sensitive`] run carries nothing: not the characters, not the
//! length, not the shape. Length alone is enough to narrow a password, so the
//! placeholder is deliberately information-free.
//!
//! Classification ([`classify_run`]) is pure and exhaustively tested; the
//! platform focus query ([`PlatformSecureProbe`]) is the only impure part.

use super::journal::TextCapture;

/// Fail-closed tri-state. `Unknown` is not "probably fine" — it is "we could not
/// ask", and it is handled identically to `Secure`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureState {
    Plain,
    Secure,
    Unknown,
}

impl SecureState {
    /// The only predicate call sites should use. Named for what it decides
    /// rather than for the variant, so `Unknown` cannot be forgotten.
    pub fn blocks_transcription(self) -> bool {
        !matches!(self, SecureState::Plain)
    }
}

pub trait SecureFieldProbe: Send + Sync {
    fn probe(&self) -> SecureState;
}

/// Test double + the fallback on platforms with no probe.
pub struct FixedSecureProbe(pub SecureState);

impl SecureFieldProbe for FixedSecureProbe {
    fn probe(&self) -> SecureState {
        self.0
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification (pure)
// ─────────────────────────────────────────────────────────────────────────────

const VK_BACK: u32 = 0x08;
const VK_TAB: u32 = 0x09;
const VK_RETURN: u32 = 0x0D;
const VK_SHIFT: u32 = 0x10;
const VK_CONTROL: u32 = 0x11;
const VK_MENU: u32 = 0x12;
const VK_ESCAPE: u32 = 0x1B;
const VK_SPACE: u32 = 0x20;
const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_LEFT: u32 = 0x25;
const VK_UP: u32 = 0x26;
const VK_RIGHT: u32 = 0x27;
const VK_DOWN: u32 = 0x28;
const VK_DELETE: u32 = 0x2E;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;

/// Canonical modifier name, or `None` for a non-modifier key.
fn modifier_name(vk: u32) -> Option<&'static str> {
    match vk {
        VK_SHIFT | VK_LSHIFT | VK_RSHIFT => Some("shift"),
        VK_CONTROL | VK_LCONTROL | VK_RCONTROL => Some("ctrl"),
        VK_MENU | VK_LMENU | VK_RMENU => Some("alt"),
        VK_LWIN | VK_RWIN => Some("meta"),
        _ => None,
    }
}

/// Modifiers that turn a run into a *command* rather than typed text.
///
/// Shift is deliberately excluded: it is how a capital letter is produced, so
/// treating it as a command modifier would demote every sentence with a capital
/// in it. Ctrl/Alt/Meta are the opposite — `ctrl+c` is a copy, not the letter c,
/// and transcribing it as text would put a shortcut into the skill as if the
/// user had typed a character.
fn is_command_modifier(vk: u32) -> bool {
    matches!(modifier_name(vk), Some("ctrl") | Some("alt") | Some("meta"))
}

/// Structural name for a non-printable key. `None` means "no better name than
/// the raw code", which is rendered as `key<0x..>` rather than dropped — a
/// silently missing key would make the chord a lie.
fn key_name(vk: u32) -> Option<&'static str> {
    match vk {
        VK_BACK => Some("backspace"),
        VK_TAB => Some("tab"),
        VK_RETURN => Some("enter"),
        VK_ESCAPE => Some("esc"),
        VK_SPACE => Some("space"),
        VK_PRIOR => Some("pageup"),
        VK_NEXT => Some("pagedown"),
        VK_END => Some("end"),
        VK_HOME => Some("home"),
        VK_LEFT => Some("left"),
        VK_UP => Some("up"),
        VK_RIGHT => Some("right"),
        VK_DOWN => Some("down"),
        VK_DELETE => Some("delete"),
        0x70..=0x87 => Some("function-key"),
        _ => None,
    }
}

fn describe_key(vk: u32, decoded: Option<char>) -> String {
    if let Some(name) = key_name(vk) {
        return name.to_string();
    }
    match decoded {
        Some(c) if !c.is_control() => c.to_lowercase().to_string(),
        _ => match char::from_u32(vk) {
            // The classic VK range doubles as ASCII for letters and digits.
            Some(c) if c.is_ascii_alphanumeric() => c.to_ascii_lowercase().to_string(),
            _ => format!("key<0x{vk:02X}>"),
        },
    }
}

/// Render a non-transcribable run structurally.
///
/// With a modifier present the run reads as a shortcut (`ctrl+c`); without one
/// it reads as a sequence of named keys, with repeats collapsed (`backspace ×3`)
/// so a long hold does not produce a wall of text.
fn describe_run(vks: &[u32], decoded: &[Option<char>]) -> String {
    let mut modifiers: Vec<&'static str> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for (i, &vk) in vks.iter().enumerate() {
        match modifier_name(vk) {
            Some(name) => {
                if !modifiers.contains(&name) {
                    modifiers.push(name);
                }
            }
            None => keys.push(describe_key(vk, decoded.get(i).copied().flatten())),
        }
    }
    // Canonical order so the same shortcut always renders the same way.
    const ORDER: [&str; 4] = ["ctrl", "alt", "shift", "meta"];
    modifiers.sort_by_key(|m| ORDER.iter().position(|o| o == m).unwrap_or(usize::MAX));

    if !modifiers.is_empty() {
        let mut parts = modifiers;
        let mut seen: Vec<&str> = Vec::new();
        for key in &keys {
            if !seen.contains(&key.as_str()) {
                seen.push(key.as_str());
            }
        }
        parts.extend(seen);
        return parts.join("+");
    }

    let mut out: Vec<String> = Vec::new();
    let mut run: Option<(String, usize)> = None;
    for key in keys {
        match run.take() {
            Some((name, count)) if name == key => run = Some((name, count + 1)),
            Some((name, count)) => {
                out.push(collapse(name, count));
                run = Some((key, 1));
            }
            None => run = Some((key, 1)),
        }
    }
    if let Some((name, count)) = run {
        out.push(collapse(name, count));
    }
    out.join(" ")
}

fn collapse(name: String, count: usize) -> String {
    if count > 1 {
        format!("{name} \u{00d7}{count}")
    } else {
        name
    }
}

/// Classify one coalesced key run.
///
/// `decoded`, `vks` and `states` are parallel: one entry per key press. A short
/// `states` slice is treated as `Unknown` for the missing keys — a truncated
/// sample must not read as a clean run.
pub fn classify_run(decoded: &[Option<char>], vks: &[u32], states: &[SecureState]) -> TextCapture {
    if vks.is_empty() {
        return TextCapture::Keys {
            chord: String::new(),
        };
    }
    let blocked = states.len() < vks.len()
        || states.iter().any(|s| s.blocks_transcription())
        || states.is_empty();
    if blocked {
        // `decoded` is dropped here without ever being formatted.
        return TextCapture::Sensitive;
    }

    // A command modifier anywhere in the run means the whole run is a shortcut.
    let printable: Option<String> = if vks.iter().copied().any(is_command_modifier) {
        None
    } else {
        vks.iter()
            .enumerate()
            .map(|(i, &vk)| {
                if modifier_name(vk).is_some() {
                    // A bare shift while typing is normal and contributes nothing.
                    return Some(String::new());
                }
                match decoded.get(i).copied().flatten() {
                    Some(c) if !c.is_control() => Some(c.to_string()),
                    _ => None,
                }
            })
            .collect::<Option<Vec<String>>>()
            .map(|parts| parts.concat())
    };

    match printable {
        Some(value) if !value.trim().is_empty() => TextCapture::Text { value },
        _ => TextCapture::Keys {
            chord: describe_run(vks, decoded),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform probe
// ─────────────────────────────────────────────────────────────────────────────

/// The real focus probe. Every platform arm returns `Unknown` when it cannot
/// answer, which the classifier reads as `Secure`.
pub struct PlatformSecureProbe;

impl SecureFieldProbe for PlatformSecureProbe {
    fn probe(&self) -> SecureState {
        platform::probe()
    }
}

/// One element's reply to "are you a password field?".
///
/// `Unanswered` is the variant that matters: an accessibility API that errors
/// has told us nothing, and reading that as "no" is how a password gets
/// transcribed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordAnswer {
    Yes,
    No,
    Unanswered,
}

/// How a bounded ancestor walk stopped once every element it reached replied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalkEnd {
    /// The walk reached the top of the accessibility tree — the chain is
    /// complete, so "no password anywhere in it" is a real answer.
    ReachedRoot,
    /// The walk ran out of its step budget with every element replying. The
    /// remaining ancestors are container chrome, not the field itself.
    BoundExhausted,
    /// The walk stopped before the root because a parent link could not be
    /// followed. The ancestor carrying the password flag may be exactly the one
    /// we failed to reach.
    LinkBroken,
}

/// Fold an ancestor walk into a decision.
///
/// Pure so the fail-closed rule is pinned by tests rather than by a Windows
/// box: the only paths to [`SecureState::Plain`] are a fully-answered chain
/// that reached the root and a fully-answered chain that exhausted its budget.
/// Every other shape is [`SecureState::Unknown`], which
/// [`SecureState::blocks_transcription`] treats exactly like `Secure`.
pub fn resolve_ancestor_walk(answers: &[PasswordAnswer], end: WalkEnd) -> SecureState {
    for answer in answers {
        match answer {
            PasswordAnswer::Yes => return SecureState::Secure,
            PasswordAnswer::Unanswered => return SecureState::Unknown,
            PasswordAnswer::No => {}
        }
    }
    match end {
        WalkEnd::ReachedRoot | WalkEnd::BoundExhausted => SecureState::Plain,
        WalkEnd::LinkBroken => SecureState::Unknown,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::SecureState;
    use crate::automation::platform::shared::credential_window;

    pub(super) fn probe() -> SecureState {
        if credential_window::is_credential_window_focused() {
            return SecureState::Secure;
        }
        // `focused_window_credential_signals` returns None when the AX focus
        // query itself failed — which is exactly the "we could not ask" case.
        match crate::automation::platform::ax::focused_window_credential_signals() {
            Some((_, _, true)) => SecureState::Secure,
            Some((_, _, false)) => SecureState::Plain,
            None => SecureState::Unknown,
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{resolve_ancestor_walk, PasswordAnswer, SecureState, WalkEnd};
    use crate::automation::platform::shared::credential_window;

    const MAX_ANCESTORS: usize = 8;

    thread_local! {
        /// One UIA client per calling thread. `UIAutomation::new()` performs the
        /// MTA `CoInitializeEx`, and the tokio worker a probe runs on can change
        /// between calls, so per-thread is both correct and cheap after the
        /// first hit.
        static UIA: Option<uiautomation::UIAutomation> = uiautomation::UIAutomation::new().ok();
    }

    pub(super) fn probe() -> SecureState {
        if credential_window::is_credential_window_focused() {
            return SecureState::Secure;
        }
        UIA.with(|uia| {
            let Some(uia) = uia.as_ref() else {
                return SecureState::Unknown;
            };
            let Ok(focused) = uia.get_focused_element() else {
                return SecureState::Unknown;
            };
            let Ok(walker) = uia.get_control_view_walker() else {
                return SecureState::Unknown;
            };
            // The root is looked up once so a broken parent link can be told
            // apart from the legitimate end of the chain. If UIA cannot even
            // name its root we never claim `ReachedRoot`, so the walk falls
            // through to `LinkBroken` — conservative, which is the point.
            let root = uia.get_root_element().ok();

            // Password state often lives on an ancestor of the focused leaf
            // (a composed text control), so walk up a bounded distance — the
            // same bound `uia::text_selection` already uses.
            let mut answers = Vec::with_capacity(MAX_ANCESTORS + 1);
            let mut end = WalkEnd::BoundExhausted;
            let mut element = focused;
            for _ in 0..=MAX_ANCESTORS {
                answers.push(match element.is_password() {
                    Ok(true) => PasswordAnswer::Yes,
                    Ok(false) => PasswordAnswer::No,
                    Err(_) => PasswordAnswer::Unanswered,
                });
                let at_root = root
                    .as_ref()
                    .and_then(|root| uia.compare_elements(&element, root).ok())
                    .unwrap_or(false);
                if at_root {
                    end = WalkEnd::ReachedRoot;
                    break;
                }
                match walker.get_parent(&element) {
                    Ok(parent) => element = parent,
                    Err(_) => {
                        end = WalkEnd::LinkBroken;
                        break;
                    }
                }
            }
            resolve_ancestor_walk(&answers, end)
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::SecureState;

    /// Recording is blocked on these platforms anyway; failing closed here means
    /// a future port cannot silently start transcribing before it has a probe.
    pub(super) fn probe() -> SecureState {
        SecureState::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(n: usize) -> Vec<SecureState> {
        vec![SecureState::Plain; n]
    }

    #[test]
    fn printable_run_becomes_text() {
        let vks = vec![0x48, 0x49];
        let decoded = vec![Some('h'), Some('i')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(2)),
            TextCapture::Text { value: "hi".into() }
        );
    }

    #[test]
    fn layout_decoded_unicode_survives() {
        // A German layout produces 'ü' from a key whose VK says something else.
        let vks = vec![0xBA];
        let decoded = vec![Some('ü')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(1)),
            TextCapture::Text { value: "ü".into() }
        );
    }

    #[test]
    fn shift_is_transparent_inside_a_printable_run() {
        let vks = vec![VK_SHIFT, 0x41];
        let decoded = vec![None, Some('A')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(2)),
            TextCapture::Text { value: "A".into() },
            "a modifier held to produce a capital must not demote the run"
        );
    }

    #[test]
    fn any_secure_sample_poisons_the_whole_run() {
        let vks = vec![0x48, 0x49, 0x4A];
        let decoded = vec![Some('h'), Some('i'), Some('j')];
        // Focus moved into a password field partway through.
        let states = vec![SecureState::Plain, SecureState::Secure, SecureState::Plain];
        assert_eq!(
            classify_run(&decoded, &vks, &states),
            TextCapture::Sensitive
        );
    }

    #[test]
    fn unknown_state_is_treated_as_secure() {
        let vks = vec![0x48];
        let decoded = vec![Some('h')];
        assert_eq!(
            classify_run(&decoded, &vks, &[SecureState::Unknown]),
            TextCapture::Sensitive,
            "a focus query we could not answer must fail closed"
        );
    }

    #[test]
    fn missing_state_samples_fail_closed() {
        let vks = vec![0x48, 0x49];
        let decoded = vec![Some('h'), Some('i')];
        assert_eq!(
            classify_run(&decoded, &vks, &[SecureState::Plain]),
            TextCapture::Sensitive,
            "fewer samples than keys means part of the run was unclassified"
        );
        assert_eq!(classify_run(&decoded, &vks, &[]), TextCapture::Sensitive);
    }

    #[test]
    fn sensitive_capture_carries_no_length() {
        let short = classify_run(&[Some('a')], &[0x41], &[SecureState::Secure]);
        let long = classify_run(&[Some('a'); 40], &[0x41; 40], &[SecureState::Secure; 40]);
        assert_eq!(
            short, long,
            "a 1-key and a 40-key secure run are indistinguishable"
        );
        assert_eq!(short, TextCapture::Sensitive);

        let json = serde_json::to_string(&short).unwrap();
        assert!(!json.contains('a'), "no character may survive: {json}");
    }

    #[test]
    fn non_printable_run_becomes_keys_not_text() {
        let vks = vec![VK_BACK, VK_BACK, VK_BACK];
        let decoded = vec![None, None, None];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(3)),
            TextCapture::Keys {
                chord: "backspace \u{00d7}3".into()
            }
        );
    }

    #[test]
    fn shortcut_run_renders_as_a_chord() {
        let vks = vec![VK_CONTROL, 0x43];
        let decoded = vec![None, Some('c')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(2)),
            TextCapture::Keys {
                chord: "ctrl+c".into()
            }
        );
    }

    #[test]
    fn chord_modifiers_are_canonically_ordered_and_deduped() {
        let vks = vec![VK_RSHIFT, VK_LCONTROL, VK_MENU, VK_LSHIFT, 0x53];
        let decoded = vec![None, None, None, None, Some('s')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(5)),
            TextCapture::Keys {
                chord: "ctrl+alt+shift+s".into()
            }
        );
    }

    #[test]
    fn arrow_navigation_reads_as_named_keys() {
        let vks = vec![VK_DOWN, VK_DOWN, VK_RIGHT];
        let decoded = vec![None, None, None];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(3)),
            TextCapture::Keys {
                chord: "down \u{00d7}2 right".into()
            }
        );
    }

    #[test]
    fn unnamed_key_is_reported_not_dropped() {
        let vks = vec![0xF1];
        let decoded = vec![None];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(1)),
            TextCapture::Keys {
                chord: "key<0xF1>".into()
            },
            "a dropped key would make the chord a lie about what was pressed"
        );
    }

    #[test]
    fn control_characters_never_become_text() {
        let vks = vec![VK_RETURN];
        let decoded = vec![Some('\r')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(1)),
            TextCapture::Keys {
                chord: "enter".into()
            }
        );
    }

    #[test]
    fn whitespace_only_run_is_not_text() {
        let vks = vec![VK_SPACE, VK_SPACE];
        let decoded = vec![Some(' '), Some(' ')];
        assert_eq!(
            classify_run(&decoded, &vks, &plain(2)),
            TextCapture::Keys {
                chord: "space \u{00d7}2".into()
            },
            "two spaces are a gesture, not typed content"
        );
    }

    #[test]
    fn empty_run_is_an_empty_chord() {
        assert_eq!(
            classify_run(&[], &[], &[]),
            TextCapture::Keys {
                chord: String::new()
            }
        );
    }

    #[test]
    fn partially_decoded_run_falls_back_to_keys() {
        // One key decoded, one didn't — transcribing half a run would be worse
        // than describing it.
        let vks = vec![0x48, 0xF2];
        let decoded = vec![Some('h'), None];
        assert!(matches!(
            classify_run(&decoded, &vks, &plain(2)),
            TextCapture::Keys { .. }
        ));
    }

    #[test]
    fn a_command_modifier_demotes_an_otherwise_printable_run() {
        // The decoded char for `ctrl+c` is still 'c'; without the command-modifier
        // rule the run would be transcribed as the user having typed the letter.
        for modifier in [VK_CONTROL, VK_MENU, VK_LWIN] {
            let vks = vec![modifier, 0x43];
            let decoded = vec![None, Some('c')];
            assert!(
                matches!(
                    classify_run(&decoded, &vks, &plain(2)),
                    TextCapture::Keys { .. }
                ),
                "modifier 0x{modifier:02X} must produce a chord, not text"
            );
        }
    }

    #[test]
    fn blocks_transcription_covers_unknown() {
        assert!(!SecureState::Plain.blocks_transcription());
        assert!(SecureState::Secure.blocks_transcription());
        assert!(SecureState::Unknown.blocks_transcription());
    }

    #[test]
    fn fixed_probe_reports_its_state() {
        assert_eq!(
            FixedSecureProbe(SecureState::Secure).probe(),
            SecureState::Secure
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn platform_probe_is_callable_and_total() {
        // Host-dependent, so only totality is asserted.
        let _ = PlatformSecureProbe.probe();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn unsupported_platform_probe_fails_closed() {
        assert_eq!(PlatformSecureProbe.probe(), SecureState::Unknown);
    }

    // ── ancestor-walk resolution ────────────────────────────────────────────
    //
    // These pin the fail-closed rule on every host, so the Windows probe's
    // contract is not left to a machine nobody runs CI on.

    use PasswordAnswer::{No, Unanswered, Yes};

    #[test]
    fn password_anywhere_in_the_chain_is_secure() {
        assert_eq!(
            resolve_ancestor_walk(&[No, No, Yes], WalkEnd::ReachedRoot),
            SecureState::Secure
        );
        assert_eq!(
            resolve_ancestor_walk(&[Yes], WalkEnd::LinkBroken),
            SecureState::Secure
        );
    }

    #[test]
    fn an_element_that_cannot_answer_is_unknown_not_plain() {
        // The regression this guards: `is_password()` erroring used to read as
        // "not a password", so a transient UIA or permission failure let a
        // password field be transcribed.
        assert_eq!(
            resolve_ancestor_walk(&[Unanswered], WalkEnd::ReachedRoot),
            SecureState::Unknown
        );
        assert_eq!(
            resolve_ancestor_walk(&[No, Unanswered, No], WalkEnd::BoundExhausted),
            SecureState::Unknown
        );
    }

    #[test]
    fn an_unanswered_element_outranks_a_clean_ending() {
        // Order matters only for `Yes`; an `Unanswered` before any `Yes` still
        // blocks, because we cannot know which it would have been.
        assert!(
            resolve_ancestor_walk(&[Unanswered, Yes], WalkEnd::ReachedRoot).blocks_transcription()
        );
    }

    #[test]
    fn a_broken_parent_link_is_unknown() {
        // The other half of the regression: stopping the walk early used to
        // fall through to `Plain`, even though the ancestor carrying the
        // password flag is precisely the one that was never reached.
        assert_eq!(
            resolve_ancestor_walk(&[No, No], WalkEnd::LinkBroken),
            SecureState::Unknown
        );
    }

    #[test]
    fn a_fully_answered_chain_is_plain() {
        assert_eq!(
            resolve_ancestor_walk(&[No, No, No], WalkEnd::ReachedRoot),
            SecureState::Plain
        );
        assert_eq!(
            resolve_ancestor_walk(&[No], WalkEnd::BoundExhausted),
            SecureState::Plain
        );
    }

    #[test]
    fn an_empty_walk_still_honours_how_it_ended() {
        // No element was ever asked. Only a clean ending may read as `Plain`.
        assert_eq!(
            resolve_ancestor_walk(&[], WalkEnd::LinkBroken),
            SecureState::Unknown
        );
        assert_eq!(
            resolve_ancestor_walk(&[], WalkEnd::BoundExhausted),
            SecureState::Plain
        );
    }
}
