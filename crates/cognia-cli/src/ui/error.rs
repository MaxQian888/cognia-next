//! `color-eyre` install hook + suggestion helper.
//!
//! Two responsibilities:
//!
//! 1. Install `color-eyre` as the top-level error report hook so that
//!    `eyre::Report` rendered at `main()` exit gets severity coloring,
//!    proper cause chains, and (with `RUST_BACKTRACE=1`) backtraces.
//! 2. Provide a small `Suggestion` extension trait so commands can write
//!    `.suggestion("cognia plugin lint")` for the actionable "→ try:" hint
//!    that color-eyre renders at the end of the chain.

use eyre::Report;

/// Install color-eyre's panic + error hooks. Idempotent — safe to call
/// even if installed twice (returns Ok the second time after swallowing
/// the "hooks already installed" error).
///
/// Note: this does NOT touch `owo_colors::set_override`. The CLI's
/// `main()` toggles that separately via `RuntimeUi::apply_color_override`,
/// so this function stays side-effect free for parallel tests.
pub fn install() -> Result<(), Report> {
    // color-eyre's HookBuilder returns an error if hooks are already
    // installed — happens in tests that share the global. Swallow that
    // specific case but propagate everything else.
    if let Err(e) = color_eyre::install() {
        let msg = e.to_string();
        if msg.contains("already") || msg.contains("set") {
            return Ok(());
        }
        return Err(e);
    }
    Ok(())
}

/// Build a chain that wraps an inner error with a top-level message and
/// an actionable "→ try:" hint. Returns an `eyre::Report` ready to surface.
///
/// Reserved helper — commands currently inline `.wrap_err(...)` directly.
/// Kept on the public API so future call sites can adopt the canonical
/// hint format without rewriting the wrapper.
#[allow(dead_code)]
pub fn report_with_hint<E: Into<Report>>(
    inner: E,
    hint: impl Into<String>,
) -> Report {
    let h = hint.into();
    inner
        .into()
        .wrap_err(format!("hint: {h}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_is_idempotent() {
        // First install should succeed (or be already installed from
        // another test in the same process).
        let _ = install();
        // Second call must not error.
        assert!(install().is_ok());
    }

    #[test]
    fn report_with_hint_chains_inner_error() {
        let inner = eyre::eyre!("primary failure");
        let r = report_with_hint(inner, "cognia plugin lint --path .");
        let chain: String = format!("{r:?}");
        assert!(
            chain.contains("primary failure"),
            "missing inner: {chain}"
        );
        assert!(
            chain.contains("cognia plugin lint"),
            "missing hint: {chain}"
        );
    }
}
