//! Color palette + small print helpers shared by every command.
//!
//! Built on `owo-colors`. Honors the global override set by
//! `RuntimeUi::apply_color_override` — when color is off, every helper
//! below decays to plain text.
//!
//! Implementation note: owo-colors' bare `.green()` / `.bold()` methods
//! always emit ANSI regardless of `set_override`. Only the
//! `if_supports_color(Stream, …)` adapter respects the override. Every
//! helper below routes through that adapter.

use owo_colors::{OwoColorize, Stream};

/// Render `s` as a "success" tag — bold green.
pub fn ok(s: impl AsRef<str>) -> String {
    s.as_ref()
        .if_supports_color(Stream::Stdout, |t| t.bold().green().to_string())
        .to_string()
}

/// Render `s` as an "error" tag — bold red.
pub fn error(s: impl AsRef<str>) -> String {
    s.as_ref()
        .if_supports_color(Stream::Stdout, |t| t.bold().red().to_string())
        .to_string()
}

/// Render `s` as a "warning" tag — bold yellow.
pub fn warn(s: impl AsRef<str>) -> String {
    s.as_ref()
        .if_supports_color(Stream::Stdout, |t| t.bold().yellow().to_string())
        .to_string()
}

/// Render `s` as a "hint" tag — bold cyan. Used for `→ try:` style suggestions.
pub fn hint(s: impl AsRef<str>) -> String {
    s.as_ref()
        .if_supports_color(Stream::Stdout, |t| t.bold().cyan().to_string())
        .to_string()
}

/// Render `s` as dim text — for secondary content like fingerprints or paths.
pub fn dim(s: impl AsRef<str>) -> String {
    s.as_ref()
        .if_supports_color(Stream::Stdout, |t| t.dimmed().to_string())
        .to_string()
}

/// Bold a string without changing its color.
pub fn bold(s: impl AsRef<str>) -> String {
    s.as_ref()
        .if_supports_color(Stream::Stdout, |t| t.bold().to_string())
        .to_string()
}

/// Standard success-marker prefix: green check + space.
pub fn success_prefix() -> String {
    ok("✓") + " "
}

/// Standard error-marker prefix: red cross + space.
pub fn error_prefix() -> String {
    error("✗") + " "
}

/// Standard warning-marker prefix: yellow triangle + space.
pub fn warn_prefix() -> String {
    warn("⚠") + " "
}

/// Standard hint-marker prefix: cyan arrow + `try:` + space.
pub fn hint_prefix() -> String {
    hint("→") + " " + &hint("try:") + " "
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serializes tests that toggle the process-wide owo-colors override.
    static COLOR_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn strip_ansi(s: &str) -> String {
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\u{1b}' {
                if let Some('[') = chars.next() {
                    for n in chars.by_ref() {
                        if n.is_ascii_alphabetic() {
                            break;
                        }
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    #[test]
    fn helpers_round_trip_text_under_no_color() {
        let _guard = COLOR_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        owo_colors::set_override(false);
        assert_eq!(ok("done"), "done");
        assert_eq!(error("nope"), "nope");
        assert_eq!(warn("careful"), "careful");
        assert_eq!(hint("try this"), "try this");
        assert_eq!(dim("path"), "path");
        assert_eq!(bold("x"), "x");
    }

    #[test]
    fn prefixes_strip_to_plain_glyphs_under_no_color() {
        let _guard = COLOR_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        owo_colors::set_override(false);
        assert_eq!(success_prefix(), "✓ ");
        assert_eq!(error_prefix(), "✗ ");
        assert_eq!(warn_prefix(), "⚠ ");
        assert_eq!(hint_prefix(), "→ try: ");
    }

    #[test]
    fn helpers_emit_ansi_under_color_override() {
        let _guard = COLOR_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        owo_colors::set_override(true);
        let s = ok("done");
        assert!(s.contains('\u{1b}'), "expected ANSI in {s:?}");
        assert_eq!(strip_ansi(&s), "done");
        owo_colors::set_override(false);
    }
}
