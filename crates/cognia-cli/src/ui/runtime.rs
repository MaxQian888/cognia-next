//! `RuntimeUi` — the per-invocation UI bundle threaded into every command.
//!
//! Wraps four pieces of state:
//! 1. TTY detection (one-shot at construction).
//! 2. Color mode (auto / always / never), with env-var overrides.
//! 3. Global flags: `--json`, `--quiet`, `--verbose`, `--yes`.
//! 4. A boxed `Prompter` implementation chosen at construction time.

use std::env;
use std::io::IsTerminal;

use super::prompter::{DialoguerPrompter, NoninteractivePrompter, Prompter};

/// User-selected color mode. Mirrors `cargo --color`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Auto,
    Always,
    Never,
}

impl ColorMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "auto" => Ok(Self::Auto),
            "always" => Ok(Self::Always),
            "never" => Ok(Self::Never),
            other => Err(format!(
                "invalid --color value `{other}` (use auto/always/never)"
            )),
        }
    }
}

/// Compose-only flags struct fed by clap. Built in `main.rs::main()`.
#[derive(Debug, Clone)]
pub struct UiFlags {
    pub color: ColorMode,
    pub json: bool,
    pub quiet: bool,
    /// 0 = default, 1 = -v, 2 = -vv. Reserved for future log routing;
    /// parsed by `main()` but not yet read by any subcommand.
    #[allow(dead_code)]
    pub verbose: u8,
    pub yes: bool,
}

impl Default for UiFlags {
    fn default() -> Self {
        Self {
            color: ColorMode::Auto,
            json: false,
            quiet: false,
            verbose: 0,
            yes: false,
        }
    }
}

/// Resolved per-invocation UI state. Constructed once at top of `main()`
/// and threaded into every command via `&mut`.
pub struct RuntimeUi {
    /// `true` if stdout is a TTY. Spinner/progress/prompts depend on this.
    pub is_tty: bool,
    /// `true` if color output should be emitted to stdout/stderr.
    pub color: bool,
    /// Pass-through of the flags struct so commands can branch on `quiet`,
    /// `json`, `verbose`, `yes`.
    pub flags: UiFlags,
    /// The injected prompter. Non-TTY invocations get a `NoninteractivePrompter`
    /// that always errors out with an actionable message; TTY invocations
    /// get a `DialoguerPrompter`; tests construct `with_prompter()` directly.
    prompter: Box<dyn Prompter>,
}

impl RuntimeUi {
    /// Build the default runtime UI from CLI flags plus environment.
    ///
    /// Decision tree for `color`:
    ///
    /// - `ColorMode::Never`           → false
    /// - `ColorMode::Always`          → true
    /// - `ColorMode::Auto`:
    ///   - `NO_COLOR` set, non-empty  → false (industry std, https://no-color.org)
    ///   - `FORCE_COLOR` set, "1"+    → true
    ///   - else                       → `is_tty`
    pub fn new(flags: UiFlags) -> Self {
        let is_tty = std::io::stdout().is_terminal();
        let color = compute_color(flags.color, is_tty);

        // NOTE: we do not touch `owo_colors::set_override` here — that
        // global state is process-wide and would race with parallel tests.
        // The CLI's `main()` calls `apply_color_override()` once after
        // building the `RuntimeUi`; the bare struct stays side-effect free.

        let prompter: Box<dyn Prompter> = if is_tty {
            Box::new(DialoguerPrompter::new())
        } else {
            Box::new(NoninteractivePrompter)
        };

        Self {
            is_tty,
            color,
            flags,
            prompter,
        }
    }

    /// Push the resolved `color` flag into owo-colors' global override.
    /// Must be called by `main()` before any styled output. Kept out of
    /// `new()` so parallel tests don't fight over the global state.
    pub fn apply_color_override(&self) {
        owo_colors::set_override(self.color);
    }

    /// Inject a custom prompter (used by tests and by callers that want
    /// the `--yes` autoresponder layered in).
    #[allow(dead_code)]
    pub fn with_prompter(mut self, prompter: Box<dyn Prompter>) -> Self {
        self.prompter = prompter;
        self
    }

    /// Borrow the prompter mutably. Commands call `.prompter().confirm(...)`.
    pub fn prompter(&mut self) -> &mut dyn Prompter {
        &mut *self.prompter
    }

    /// Quiet mode collapses non-error output. Returns the inverse of `--quiet`.
    pub fn show_progress(&self) -> bool {
        !self.flags.quiet
    }

    /// Convenience: `--yes` short-circuits any `Confirm` prompt to true.
    /// Most callers read `ui.flags.yes` directly; this method exists for
    /// downstream consumers who want a stable read-only accessor.
    #[allow(dead_code)]
    pub fn yes(&self) -> bool {
        self.flags.yes
    }

    /// Convenience: emit-json mode (per-command flag, dispatch checks this).
    /// Same rationale as [`Self::yes`].
    #[allow(dead_code)]
    pub fn json(&self) -> bool {
        self.flags.json
    }

    /// Confirm an overwrite of `path`. Three short-circuits in order:
    /// 1. `path` does not exist → return `Ok(true)` immediately.
    /// 2. `--yes`/`-y` flag is set → return `Ok(true)` without prompting.
    /// 3. Otherwise prompt with `default = false` (cautious default).
    ///
    /// `flag_hint` is the actionable flag a non-interactive caller should
    /// pass to skip; surfaced in the error if `Prompter::confirm` refuses.
    pub fn confirm_overwrite(
        &mut self,
        path: &std::path::Path,
        flag_hint: &str,
    ) -> Result<bool, super::prompter::PromptError> {
        if !path.exists() {
            return Ok(true);
        }
        if self.flags.yes {
            return Ok(true);
        }
        let msg = format!("Overwrite existing {}?", path.display());
        self.prompter().confirm(&msg, false, flag_hint)
    }
}

fn compute_color(mode: ColorMode, is_tty: bool) -> bool {
    match mode {
        ColorMode::Never => false,
        ColorMode::Always => true,
        ColorMode::Auto => {
            if env::var_os("NO_COLOR")
                .map(|v| !v.is_empty())
                .unwrap_or(false)
            {
                return false;
            }
            if env::var("FORCE_COLOR")
                .map(|v| !v.is_empty() && v != "0")
                .unwrap_or(false)
            {
                return true;
            }
            is_tty
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_never_overrides_tty() {
        assert!(!compute_color(ColorMode::Never, true));
        assert!(!compute_color(ColorMode::Never, false));
    }

    #[test]
    fn color_always_overrides_tty() {
        assert!(compute_color(ColorMode::Always, false));
    }

    #[test]
    fn color_auto_follows_tty_when_env_clean() {
        // Snapshot + clear env to avoid host pollution leaking into the test.
        let prior_no = env::var_os("NO_COLOR");
        let prior_force = env::var_os("FORCE_COLOR");
        env::remove_var("NO_COLOR");
        env::remove_var("FORCE_COLOR");
        assert!(compute_color(ColorMode::Auto, true));
        assert!(!compute_color(ColorMode::Auto, false));
        if let Some(v) = prior_no {
            env::set_var("NO_COLOR", v);
        }
        if let Some(v) = prior_force {
            env::set_var("FORCE_COLOR", v);
        }
    }

    #[test]
    fn color_auto_no_color_env_disables_color_even_on_tty() {
        let prior = env::var_os("NO_COLOR");
        env::set_var("NO_COLOR", "1");
        assert!(!compute_color(ColorMode::Auto, true));
        if let Some(v) = prior {
            env::set_var("NO_COLOR", v);
        } else {
            env::remove_var("NO_COLOR");
        }
    }

    #[test]
    fn color_auto_force_color_enables_color_off_tty() {
        let prior_no = env::var_os("NO_COLOR");
        let prior_force = env::var_os("FORCE_COLOR");
        env::remove_var("NO_COLOR");
        env::set_var("FORCE_COLOR", "1");
        assert!(compute_color(ColorMode::Auto, false));
        if let Some(v) = prior_force {
            env::set_var("FORCE_COLOR", v);
        } else {
            env::remove_var("FORCE_COLOR");
        }
        if let Some(v) = prior_no {
            env::set_var("NO_COLOR", v);
        }
    }

    #[test]
    fn color_mode_parser_round_trips() {
        assert_eq!(ColorMode::parse("auto").unwrap(), ColorMode::Auto);
        assert_eq!(ColorMode::parse("always").unwrap(), ColorMode::Always);
        assert_eq!(ColorMode::parse("never").unwrap(), ColorMode::Never);
        assert!(ColorMode::parse("rainbow").is_err());
    }

    #[test]
    fn flags_default_is_quiet_off_no_json() {
        let f = UiFlags::default();
        assert!(!f.quiet);
        assert!(!f.json);
        assert!(!f.yes);
        assert_eq!(f.verbose, 0);
    }
}
