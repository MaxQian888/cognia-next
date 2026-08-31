//! Progress / spinner factories backed by `indicatif`.
//!
//! The factories check `RuntimeUi::show_progress()` (== `!quiet`) and
//! `is_tty` to decide whether the bar is visible or hidden. A "hidden"
//! `ProgressBar` still works — calls to `.set_message()` / `.tick()` /
//! `.finish_with_message()` are no-ops — so command code can be written
//! once and degrades to plain stdout under `--quiet` or non-TTY.

use std::time::Duration;

use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle};

use super::RuntimeUi;

/// Default tick interval for indeterminate spinners. Snappy without being
/// distracting; matches cargo's pre-`-vv` cadence.
const SPINNER_TICK: Duration = Duration::from_millis(80);

/// Build a spinner with a `→ message` template. Hidden when not on TTY
/// or under `--quiet`. Tick must be started separately via
/// `enable_steady_tick(SPINNER_TICK)` (callers may skip it for tests).
pub fn make_spinner(ui: &RuntimeUi, message: impl Into<String>) -> ProgressBar {
    let pb = if ui.is_tty && ui.show_progress() {
        ProgressBar::new_spinner()
    } else {
        ProgressBar::with_draw_target(None, ProgressDrawTarget::hidden())
    };
    pb.set_style(
        ProgressStyle::with_template("{spinner:.cyan} {msg}")
            .unwrap_or_else(|_| ProgressStyle::default_spinner())
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ "),
    );
    pb.set_message(message.into());
    if ui.is_tty && ui.show_progress() {
        pb.enable_steady_tick(SPINNER_TICK);
    }
    pb
}

/// Like `make_spinner`, but suitable as a *task* child inside a
/// [`MultiProgress`]. The MP itself decides whether to draw.
///
/// Reserved for nested-progress flows; `plugin dev`'s sticky panel
/// builds its bars inline today.
#[allow(dead_code)]
pub fn make_spinner_in_multi(mp: &MultiProgress, message: impl Into<String>) -> ProgressBar {
    let pb = mp.add(ProgressBar::new_spinner());
    pb.set_style(
        ProgressStyle::with_template("{spinner:.cyan} {msg}")
            .unwrap_or_else(|_| ProgressStyle::default_spinner())
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ "),
    );
    pb.set_message(message.into());
    pb.enable_steady_tick(SPINNER_TICK);
    pb
}

/// Build a `MultiProgress` whose draw target follows the runtime UI. When
/// hidden, every child bar is also a no-op.
///
/// `plugin dev` builds its own MultiProgress directly today; this helper
/// is a reusable shortcut for future callers.
#[allow(dead_code)]
pub fn make_multi_progress(ui: &RuntimeUi) -> MultiProgress {
    if ui.is_tty && ui.show_progress() {
        MultiProgress::new()
    } else {
        MultiProgress::with_draw_target(ProgressDrawTarget::hidden())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::runtime::{ColorMode, UiFlags};

    fn ui_with(flags: UiFlags) -> RuntimeUi {
        // Force is_tty=false by constructing manually rather than
        // through `RuntimeUi::new` (which probes stdout).
        let _ = flags;
        RuntimeUi::new(UiFlags {
            color: ColorMode::Never,
            quiet: true,
            ..UiFlags::default()
        })
    }

    #[test]
    fn spinner_is_hidden_under_quiet_flag() {
        let ui = ui_with(UiFlags {
            quiet: true,
            ..UiFlags::default()
        });
        let pb = make_spinner(&ui, "running");
        // Hidden bars still accept messages; they just don't draw.
        pb.set_message("still running");
        pb.finish_and_clear();
    }

    #[test]
    fn multi_progress_factory_returns_usable_handle() {
        let ui = ui_with(UiFlags::default());
        let mp = make_multi_progress(&ui);
        let child = make_spinner_in_multi(&mp, "child");
        child.finish_and_clear();
    }
}
