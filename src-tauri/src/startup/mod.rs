//! Desktop boot, run from the single `Builder::setup` hook in `lib.rs`.
//!
//! [`run`] executes [`STEPS`] in order. Each step handles its own failure —
//! it logs and returns — so one subsystem that cannot start never keeps the
//! window from painting, exactly as when these steps were one inline closure.
//! The order is load-bearing; the tests below pin the pairs that depend on it.

pub(crate) mod automation;
pub(crate) mod host_services;
pub(crate) mod services;
pub(crate) mod shell;
pub(crate) mod telemetry;

use std::time::Instant;

use tauri::App;

/// One named boot step.
pub(crate) struct Step {
    pub(crate) name: &'static str,
    pub(crate) run: fn(&App),
}

/// Every boot step, in the order `run` executes them.
pub(crate) const STEPS: &[Step] = &[
    Step {
        name: "gateway_session",
        run: services::gateway_session,
    },
    Step {
        name: "companion_reachability",
        run: services::companion_reachability,
    },
    Step {
        name: "node_runtime",
        run: services::node_runtime,
    },
    Step {
        name: "automation_state",
        run: automation::automation_state,
    },
    Step {
        name: "native_logging",
        run: telemetry::native_logging,
    },
    // After the logger, so its failures are recorded, and before the gateway
    // auto-start, which needs the brain bridge in place.
    Step {
        name: "host_services",
        run: host_services::install,
    },
    Step {
        name: "crash_and_recovery",
        run: telemetry::crash_and_recovery,
    },
    Step {
        name: "retention_sweep",
        run: telemetry::retention_sweep,
    },
    Step {
        name: "plugin_facts",
        run: automation::plugin_facts,
    },
    Step {
        name: "ocr_and_recorder",
        run: automation::ocr_and_recorder,
    },
    Step {
        name: "workflow",
        run: services::workflow,
    },
    Step {
        name: "scheduler_alarm",
        run: services::scheduler_alarm,
    },
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    Step {
        name: "shortcuts",
        run: shell::shortcuts,
    },
    #[cfg(desktop)]
    Step {
        name: "deep_links",
        run: shell::deep_links,
    },
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    Step {
        name: "cli_matches",
        run: shell::cli_matches,
    },
    #[cfg(desktop)]
    Step {
        name: "menu_and_tray",
        run: shell::menu_and_tray,
    },
    #[cfg(desktop)]
    Step {
        name: "main_window",
        run: shell::main_window,
    },
    Step {
        name: "a2ui_bridge",
        run: services::a2ui_bridge,
    },
    Step {
        name: "jobs_supervisor",
        run: services::jobs_supervisor,
    },
    Step {
        name: "agent_session_store",
        run: services::agent_session_store,
    },
    Step {
        name: "gateway_autostart",
        run: services::gateway_autostart,
    },
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    Step {
        name: "cli_bridge",
        run: services::cli_bridge,
    },
    #[cfg(desktop)]
    Step {
        name: "shutdown_signal",
        run: shell::shutdown_signal,
    },
];

/// The setup hook. Never fails: every step logs its own error.
pub(crate) fn run(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // `setup()` runs on the main thread before the event loop starts, so its
    // wall time directly gates window paint. Heavy subsystem opens are
    // lazy or spawned; what this logs is the residual synchronous cost, with
    // a per-step breakdown at debug level.
    let setup_start = Instant::now();
    for step in STEPS {
        let step_start = Instant::now();
        (step.run)(app);
        log::debug!("setup step {} took {:?}", step.name, step_start.elapsed());
    }
    log::info!(
        "native setup() completed in {:?} (heavy subsystem opens are lazy/spawned)",
        setup_start.elapsed()
    );
    Ok(())
}

/// Where the boot step named `name` runs, for the ordering tests next to
/// each step.
#[cfg(test)]
pub(crate) fn step_position(name: &str) -> usize {
    STEPS
        .iter()
        .position(|step| step.name == name)
        .unwrap_or_else(|| panic!("no boot step named `{name}`"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(name: &str) -> usize {
        step_position(name)
    }

    /// Tauri keeps only the last `Builder::setup` closure, so a second
    /// `.setup(` in `lib.rs` silently discards the first one's work.
    #[test]
    fn lib_rs_registers_exactly_one_setup_hook_and_it_is_run() {
        let lib_rs = include_str!("../lib.rs");
        let setup_calls: Vec<&str> = lib_rs
            .lines()
            .map(str::trim_start)
            .filter(|line| !line.starts_with("//"))
            .filter(|line| line.starts_with(".setup("))
            .collect();
        assert_eq!(
            setup_calls,
            vec![".setup(startup::run)"],
            "lib.rs must register exactly one setup hook, and it must be startup::run"
        );
    }

    #[test]
    fn step_names_are_unique() {
        let mut names: Vec<&str> = STEPS.iter().map(|step| step.name).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(names.len(), before, "two boot steps share a name");
    }

    /// A record written before `logging::bootstrap` is dropped, so host
    /// services install after it, and before the gateway auto-start, which
    /// needs the brain bridge they install.
    #[test]
    fn host_services_install_between_logging_and_the_gateway_autostart() {
        assert!(position("native_logging") < position("host_services"));
        assert!(position("host_services") < position("gateway_autostart"));
    }

    /// The whole order, pinned: a step that is dropped or moved has to show
    /// up here. (Before this list existed, six installs sat in a setup
    /// closure Tauri discarded, and nothing noticed.)
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    #[test]
    fn the_desktop_boot_order_is_pinned() {
        let names: Vec<&str> = STEPS.iter().map(|step| step.name).collect();
        assert_eq!(
            names,
            [
                "gateway_session",
                "companion_reachability",
                "node_runtime",
                "automation_state",
                "native_logging",
                "host_services",
                "crash_and_recovery",
                "retention_sweep",
                "plugin_facts",
                "ocr_and_recorder",
                "workflow",
                "scheduler_alarm",
                "shortcuts",
                "deep_links",
                "cli_matches",
                "menu_and_tray",
                "main_window",
                "a2ui_bridge",
                "jobs_supervisor",
                "agent_session_store",
                "gateway_autostart",
                "cli_bridge",
                "shutdown_signal",
            ]
        );
    }
}
