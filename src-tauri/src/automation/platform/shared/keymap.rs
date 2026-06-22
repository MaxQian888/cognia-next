//! ADR-0020 W2 — backend-agnostic key chord parser.
//!
//! Pre-W2, modifier chords (`ctrl+shift+t`) only worked on Windows
//! because the `uiautomation::inputs::Keyboard::send_keys` API
//! understood them natively. The macOS / Linux `enigo`-backed backends
//! had a single-token branch that hard-failed anything more complex
//! (the BackendError listed Enter / Tab / Escape / Backspace / Delete /
//! Space as the only accepted tokens).
//!
//! This module factors out a small backend-agnostic IR (`KeyToken`)
//! plus a `parse_chord` that accepts the standard `+`-joined notation
//! every desktop app uses. The IR is consumed by:
//!
//! - The macOS / Linux backends: walk the IR pressing modifiers down,
//!   then the main key, then releasing modifiers up — matches how
//!   `enigo` expects a chord to be driven.
//! - The Windows backend (defence-in-depth): runs `parse_chord` as a
//!   validator before handing the raw string off to
//!   `uiautomation::Keyboard::send_keys`. A chord that fails the parser
//!   fails fast with a uniform error message instead of disappearing
//!   into the UIA layer.
//!
//! Syntax accepted (case-insensitive):
//!
//! - Single characters: `a`, `5`, `=`
//! - Modifier names: `shift`, `ctrl` / `control`, `alt` / `option`,
//!   `meta` / `cmd` / `win` / `super`
//! - Named keys: `enter` / `return`, `tab`, `escape` / `esc`,
//!   `backspace`, `delete` / `del`, `space`, `home`, `end`, `pageup` /
//!   `pgup`, `pagedown` / `pgdn`, `up`, `down`, `left`, `right`,
//!   `f1` .. `f24`
//! - Chord combinations: tokens joined by `+`, e.g. `ctrl+shift+t`,
//!   `alt+F4`, `meta+space`.
//!
//! Whitespace inside a token is rejected (so `"ctrl + t"` is an error
//! — chord notation across the desktop ecosystem doesn't use spaces).
//! An empty string is rejected. A chord with two non-modifier keys
//! (e.g. `a+b`) is rejected.

/// Backend-agnostic key chord parser output. Modifiers always precede
/// the single main key in the returned vector — `parse_chord` enforces
/// that ordering regardless of how the operator typed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyToken {
    Modifier(Modifier),
    Named(NamedKey),
    Char(char),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Modifier {
    Shift,
    Control,
    Alt,
    Meta,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamedKey {
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Space,
    Home,
    End,
    PageUp,
    PageDown,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    F(u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChordParseError {
    pub raw: String,
    pub message: String,
}

impl std::fmt::Display for ChordParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid key chord {:?}: {}", self.raw, self.message)
    }
}

impl std::error::Error for ChordParseError {}

/// Parse a `+`-joined chord into an IR. Returns the modifiers first
/// (sorted by `Modifier` declaration order — shift, control, alt, meta
/// — so the result is deterministic regardless of the operator's
/// typing order) followed by the single main key.
pub fn parse_chord(raw: &str) -> Result<Vec<KeyToken>, ChordParseError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ChordParseError {
            raw: raw.to_string(),
            message: "chord is empty".into(),
        });
    }
    let mut modifiers: Vec<Modifier> = Vec::new();
    let mut main: Option<KeyToken> = None;
    for part in trimmed.split('+') {
        // Inspect the *raw* segment for whitespace before trimming.
        // Chord notation across the desktop ecosystem never embeds
        // spaces inside a segment (see module docs), so `"ctrl+ a"` is
        // an operator error. Trimming first would silently swallow the
        // padding and accept the chord, defeating the check below.
        if part.contains(char::is_whitespace) {
            return Err(ChordParseError {
                raw: raw.to_string(),
                message: format!("segment {part:?} contains whitespace"),
            });
        }
        let token = part;
        if token.is_empty() {
            return Err(ChordParseError {
                raw: raw.to_string(),
                message: "empty segment between '+' separators".into(),
            });
        }
        if let Some(m) = parse_modifier(token) {
            if modifiers.contains(&m) {
                return Err(ChordParseError {
                    raw: raw.to_string(),
                    message: format!("modifier {token:?} listed twice"),
                });
            }
            modifiers.push(m);
            continue;
        }
        // Not a modifier — it must be the single main key. Reject any
        // chord with two main keys (e.g. "a+b") because most platforms
        // can't dispatch that as one event anyway.
        if main.is_some() {
            return Err(ChordParseError {
                raw: raw.to_string(),
                message: format!("chord declares more than one main key (extra: {token:?})"),
            });
        }
        if let Some(named) = parse_named(token) {
            main = Some(KeyToken::Named(named));
            continue;
        }
        // Final fallback — single character (case-preserving so
        // operators can express SHIFT-implied letters explicitly).
        let mut chars = token.chars();
        let first = chars.next().ok_or_else(|| ChordParseError {
            raw: raw.to_string(),
            message: "empty token after trim".into(),
        })?;
        if chars.next().is_some() {
            return Err(ChordParseError {
                raw: raw.to_string(),
                message: format!("unknown key token {token:?}"),
            });
        }
        main = Some(KeyToken::Char(first));
    }
    let Some(main_key) = main else {
        return Err(ChordParseError {
            raw: raw.to_string(),
            message: "chord has only modifiers and no main key".into(),
        });
    };
    // Sort modifiers for a deterministic output regardless of input
    // order. The order Shift < Control < Alt < Meta matches how most
    // desktop docs list chord components.
    modifiers.sort_by_key(|m| match m {
        Modifier::Shift => 0,
        Modifier::Control => 1,
        Modifier::Alt => 2,
        Modifier::Meta => 3,
    });
    let mut out: Vec<KeyToken> = modifiers.into_iter().map(KeyToken::Modifier).collect();
    out.push(main_key);
    Ok(out)
}

fn parse_modifier(token: &str) -> Option<Modifier> {
    match token.to_ascii_lowercase().as_str() {
        "shift" => Some(Modifier::Shift),
        "ctrl" | "control" => Some(Modifier::Control),
        "alt" | "option" | "opt" => Some(Modifier::Alt),
        "meta" | "cmd" | "command" | "win" | "windows" | "super" => Some(Modifier::Meta),
        _ => None,
    }
}

fn parse_named(token: &str) -> Option<NamedKey> {
    let lower = token.to_ascii_lowercase();
    match lower.as_str() {
        "enter" | "return" => Some(NamedKey::Enter),
        "tab" => Some(NamedKey::Tab),
        "escape" | "esc" => Some(NamedKey::Escape),
        "backspace" => Some(NamedKey::Backspace),
        "delete" | "del" => Some(NamedKey::Delete),
        "space" | "spacebar" => Some(NamedKey::Space),
        "home" => Some(NamedKey::Home),
        "end" => Some(NamedKey::End),
        "pageup" | "pgup" => Some(NamedKey::PageUp),
        "pagedown" | "pgdn" => Some(NamedKey::PageDown),
        "up" | "uparrow" | "arrowup" => Some(NamedKey::ArrowUp),
        "down" | "downarrow" | "arrowdown" => Some(NamedKey::ArrowDown),
        "left" | "leftarrow" | "arrowleft" => Some(NamedKey::ArrowLeft),
        "right" | "rightarrow" | "arrowright" => Some(NamedKey::ArrowRight),
        _ => parse_function_key(&lower).map(NamedKey::F),
    }
}

fn parse_function_key(lower: &str) -> Option<u8> {
    let rest = lower.strip_prefix('f')?;
    let n: u8 = rest.parse().ok()?;
    if (1..=24).contains(&n) {
        Some(n)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_character_parses_as_char() {
        let out = parse_chord("a").unwrap();
        assert_eq!(out, vec![KeyToken::Char('a')]);
    }

    #[test]
    fn named_key_parses_as_named() {
        assert_eq!(
            parse_chord("Enter").unwrap(),
            vec![KeyToken::Named(NamedKey::Enter)]
        );
        assert_eq!(
            parse_chord("Tab").unwrap(),
            vec![KeyToken::Named(NamedKey::Tab)]
        );
        assert_eq!(
            parse_chord("ESC").unwrap(),
            vec![KeyToken::Named(NamedKey::Escape)]
        );
        assert_eq!(
            parse_chord("pgup").unwrap(),
            vec![KeyToken::Named(NamedKey::PageUp)]
        );
    }

    #[test]
    fn modifier_chord_orders_modifiers_canonically() {
        // Operator can type modifiers in any order; output is always
        // shift < control < alt < meta.
        let typed_alt_first = parse_chord("alt+ctrl+shift+t").unwrap();
        let typed_shift_first = parse_chord("shift+ctrl+alt+t").unwrap();
        assert_eq!(typed_alt_first, typed_shift_first);
        assert_eq!(
            typed_shift_first,
            vec![
                KeyToken::Modifier(Modifier::Shift),
                KeyToken::Modifier(Modifier::Control),
                KeyToken::Modifier(Modifier::Alt),
                KeyToken::Char('t'),
            ]
        );
    }

    #[test]
    fn modifier_aliases_canonicalize() {
        assert_eq!(
            parse_chord("control+shift+t").unwrap(),
            parse_chord("ctrl+shift+t").unwrap()
        );
        assert_eq!(
            parse_chord("option+f4").unwrap(),
            parse_chord("alt+F4").unwrap()
        );
        assert_eq!(
            parse_chord("cmd+a").unwrap(),
            parse_chord("meta+a").unwrap()
        );
        assert_eq!(
            parse_chord("win+r").unwrap(),
            parse_chord("super+r").unwrap()
        );
    }

    #[test]
    fn function_keys_f1_through_f24() {
        for n in 1..=24u8 {
            let label = format!("F{n}");
            let parsed = parse_chord(&label).unwrap();
            assert_eq!(parsed, vec![KeyToken::Named(NamedKey::F(n))]);
        }
    }

    #[test]
    fn rejects_empty_input() {
        assert!(parse_chord("").is_err());
        assert!(parse_chord("   ").is_err());
    }

    #[test]
    fn rejects_two_main_keys() {
        // `a+b` doesn't map to a single keyboard event on any
        // backend — refuse it explicitly so the operator gets a clear
        // error rather than a silently-truncated chord.
        let err = parse_chord("a+b").unwrap_err();
        assert!(err.message.contains("more than one main key"));
    }

    #[test]
    fn rejects_only_modifiers() {
        let err = parse_chord("ctrl+shift").unwrap_err();
        assert!(err.message.contains("no main key"));
    }

    #[test]
    fn rejects_whitespace_inside_segment() {
        let err = parse_chord("ctrl+ a").unwrap_err();
        assert!(err.message.contains("whitespace"));
    }

    #[test]
    fn rejects_empty_segment_between_plus() {
        let err = parse_chord("ctrl++a").unwrap_err();
        assert!(err.message.contains("empty segment"));
    }

    #[test]
    fn rejects_duplicate_modifier() {
        let err = parse_chord("ctrl+ctrl+a").unwrap_err();
        assert!(err.message.contains("listed twice"));
    }

    #[test]
    fn rejects_unknown_named_token_longer_than_one_char() {
        let err = parse_chord("zoom").unwrap_err();
        assert!(err.message.contains("unknown key token"));
    }
}
