//! The crash report itself — MC-style human-readable `.txt` plus a structured
//! `.json` sidecar. Shared by the panic hook (in-process) and the crash
//! monitor (out-of-process), so both capture paths produce identical layouts.

use crate::crash::context::ContextSnapshot;
use crate::crash::system_info::{self, SystemDetails};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Envelope the app process ships to the out-of-process monitor via
/// `KIND_META`, so a later native crash can be rendered with the same context
/// and application state the in-process panic path would have used. The monitor
/// supplies `system` itself (same machine), so it isn't carried here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorMeta {
    pub context: ContextSnapshot,
    pub extra: serde_json::Value,
}

/// App-only extras the monitor can't compute for itself: native-logging
/// readiness and the resolved data/log/crash-report directories. Called in the
/// app process (panic hook + client-meta sender), never in the monitor.
pub fn app_extra() -> serde_json::Value {
    let log_dir = dirs::data_local_dir().map(|d| {
        d.join(super::APP_DIR_NAME)
            .join("logs")
            .to_string_lossy()
            .to_string()
    });
    serde_json::json!({
        "nativeLogging": crate::logging::native_bootstrap::get_native_logging_readiness(),
        "crashReportsDir": super::crash_reports_dir().map(|d| d.to_string_lossy().to_string()),
        "logDir": log_dir,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashKind {
    Panic,
    Native,
}

impl CrashKind {
    fn label(self) -> &'static str {
        match self {
            CrashKind::Panic => "panic",
            CrashKind::Native => "native",
        }
    }

    fn human(self) -> &'static str {
        match self {
            CrashKind::Panic => "Rust panic",
            CrashKind::Native => "Native crash (minidump)",
        }
    }
}

/// A fully-assembled crash report.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReport {
    pub kind: CrashKind,
    pub captured_at: String,
    pub thread: Option<String>,
    pub message: String,
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backtrace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dump_path: Option<String>,
    pub system: SystemDetails,
    pub context: ContextSnapshot,
    /// App-only extras (native-logging readiness, data-dir paths) the monitor
    /// can't compute for itself — supplied by the app process.
    pub extra: serde_json::Value,
}

/// Where both report files landed.
#[derive(Debug, Clone)]
pub struct WrittenReport {
    pub stem: String,
    pub txt_path: PathBuf,
    pub json_path: PathBuf,
}

impl WrittenReport {
    /// Compact payload for the `crash://captured` webview event.
    pub fn summary_json(&self) -> serde_json::Value {
        serde_json::json!({
            "stem": self.stem,
            "txtPath": self.txt_path.to_string_lossy(),
            "jsonPath": self.json_path.to_string_lossy(),
        })
    }
}

/// A filename-safe, timestamped stem like `crash-2026-05-25_14-30-00-panic`.
pub fn timestamped_stem(kind: CrashKind) -> String {
    let ts = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
    format!("crash-{ts}-{}", kind.label())
}

/// Deterministic-but-varied banner line (MC flavour) — keyed off the timestamp
/// so a given report is stable across renders but reports differ over time.
fn banner_line(seed: &str) -> &'static str {
    const LINES: [&str; 8] = [
        "// Oops. Something went sideways.",
        "// Don't panic. (We already did.)",
        "// This wasn't supposed to happen.",
        "// We're sorry about that.",
        "// Well, that escalated quickly.",
        "// Saving what we could before the lights went out.",
        "// Here's everything we know.",
        "// Take a deep breath — the logs are below.",
    ];
    let idx = seed.bytes().fold(0u32, |acc, b| acc.wrapping_add(b as u32)) as usize % LINES.len();
    LINES[idx]
}

fn pretty(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

impl CrashReport {
    /// Render the Minecraft-style human-readable report.
    pub fn render_txt(&self) -> String {
        let mut out = String::with_capacity(2048);
        out.push_str("---- Cognia Crash Report ----\n");
        out.push_str(banner_line(&self.captured_at));
        out.push_str("\n\n");

        out.push_str(&format!("Time: {}\n", self.captured_at));
        out.push_str(&format!("Kind: {}\n", self.kind.human()));
        if let Some(thread) = &self.thread {
            out.push_str(&format!("Thread: {thread}\n"));
        }
        out.push_str(&format!("Description: {}\n", self.message));
        if let Some(loc) = &self.location {
            out.push_str(&format!("Location: {loc}\n"));
        }
        if let Some(dump) = &self.dump_path {
            out.push_str(&format!("Minidump: {dump}\n"));
        }

        if let Some(bt) = &self.backtrace {
            out.push_str("\n-- Backtrace --\n");
            out.push_str(bt);
            if !bt.ends_with('\n') {
                out.push('\n');
            }
        }

        out.push_str("\n-- System Details --\n");
        let s = &self.system;
        out.push_str(&format!("Cognia Version: {}\n", s.app_version));
        out.push_str(&format!("Tauri Version: {}\n", s.tauri_version));
        out.push_str(&format!("Build Profile: {}\n", s.profile));
        let features = if s.enabled_features.is_empty() {
            "none".to_string()
        } else {
            s.enabled_features.join(", ")
        };
        out.push_str(&format!("Enabled Features: {features}\n"));
        out.push_str(&format!(
            "Operating System: {} ({}) version {}\n",
            s.os,
            s.arch,
            s.os_version.as_deref().unwrap_or("unknown")
        ));
        out.push_str(&format!(
            "Kernel: {}\n",
            s.kernel_version.as_deref().unwrap_or("unknown")
        ));
        out.push_str(&format!("Family: {}\n", s.family));
        out.push_str(&format!(
            "Host: {}\n",
            s.hostname.as_deref().unwrap_or("unknown")
        ));
        out.push_str(&format!(
            "CPU: {} ({} cores)\n",
            s.cpu.as_deref().unwrap_or("unknown"),
            s.cpu_count
        ));
        out.push_str(&format!(
            "Memory: {}\n",
            system_info::format_memory(s.used_memory_bytes, s.total_memory_bytes)
        ));

        if !self.extra.is_null() {
            out.push_str("\n-- Application State --\n");
            out.push_str(&pretty(&self.extra));
            out.push('\n');
        }

        if !self.context.config.is_null() {
            out.push_str("\n-- Configuration (redacted) --\n");
            out.push_str(&pretty(&self.context.config));
            out.push('\n');
        }

        if !self.context.breadcrumbs.is_empty() {
            out.push_str("\n-- Breadcrumbs --\n");
            for crumb in &self.context.breadcrumbs {
                out.push_str(&format!(
                    "[{}] {}: {}\n",
                    crumb.at, crumb.level, crumb.message
                ));
            }
        }

        out
    }

    /// Structured sidecar — mirrors the frontend `NativeCrashReport` type.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    /// Write `<stem>.txt` and `<stem>.json` into `dir`. Returns the paths.
    pub fn write_to(&self, dir: &Path, stem: &str) -> io::Result<WrittenReport> {
        fs::create_dir_all(dir)?;
        let txt_path = dir.join(format!("{stem}.txt"));
        let json_path = dir.join(format!("{stem}.json"));
        fs::write(&txt_path, self.render_txt())?;
        fs::write(&json_path, pretty(&self.to_json()))?;
        Ok(WrittenReport {
            stem: stem.to_string(),
            txt_path,
            json_path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crash::context::Breadcrumb;

    fn sample_system() -> SystemDetails {
        SystemDetails {
            os: "Windows".to_string(),
            os_version: Some("11".to_string()),
            kernel_version: Some("26200".to_string()),
            arch: "x86_64".to_string(),
            family: "windows".to_string(),
            hostname: Some("test-host".to_string()),
            cpu: Some("Test CPU".to_string()),
            cpu_count: 8,
            total_memory_bytes: 16 * 1024 * 1024 * 1024,
            used_memory_bytes: 8 * 1024 * 1024 * 1024,
            app_version: "0.1.0".to_string(),
            tauri_version: "2.0.0".to_string(),
            profile: "debug",
            enabled_features: vec!["ocr-windows".to_string()],
        }
    }

    fn sample_report() -> CrashReport {
        CrashReport {
            kind: CrashKind::Panic,
            captured_at: "2026-05-25T14:30:00+00:00".to_string(),
            thread: Some("main".to_string()),
            message: "boom".to_string(),
            location: Some("src/lib.rs:42:1".to_string()),
            backtrace: Some("0: do_thing\n1: main".to_string()),
            dump_path: None,
            system: sample_system(),
            context: ContextSnapshot {
                config: serde_json::json!({ "theme": "dark" }),
                breadcrumbs: vec![Breadcrumb {
                    at: "2026-05-25T14:29:00Z".to_string(),
                    level: "info".to_string(),
                    message: "opened settings".to_string(),
                }],
            },
            extra: serde_json::json!({ "nativeLogging": "healthy" }),
        }
    }

    #[test]
    fn render_txt_contains_all_sections() {
        let txt = sample_report().render_txt();
        assert!(txt.contains("---- Cognia Crash Report ----"));
        assert!(txt.contains("Kind: Rust panic"));
        assert!(txt.contains("Description: boom"));
        assert!(txt.contains("Location: src/lib.rs:42:1"));
        assert!(txt.contains("-- Backtrace --"));
        assert!(txt.contains("-- System Details --"));
        assert!(txt.contains("Cognia Version: 0.1.0"));
        assert!(txt.contains("Enabled Features: ocr-windows"));
        assert!(txt.contains("Memory: 8192 MiB / 16384 MiB"));
        assert!(txt.contains("-- Configuration (redacted) --"));
        assert!(txt.contains("-- Breadcrumbs --"));
        assert!(txt.contains("opened settings"));
    }

    #[test]
    fn native_kind_shows_minidump_not_backtrace() {
        let mut report = sample_report();
        report.kind = CrashKind::Native;
        report.backtrace = None;
        report.dump_path = Some("C:/x/crash.dmp".to_string());
        let txt = report.render_txt();
        assert!(txt.contains("Kind: Native crash (minidump)"));
        assert!(txt.contains("Minidump: C:/x/crash.dmp"));
        assert!(!txt.contains("-- Backtrace --"));
    }

    #[test]
    fn to_json_roundtrips_key_fields() {
        let json = sample_report().to_json();
        assert_eq!(json["kind"], "panic");
        assert_eq!(json["message"], "boom");
        assert_eq!(json["system"]["appVersion"], "0.1.0");
        assert_eq!(json["context"]["config"]["theme"], "dark");
    }

    #[test]
    fn write_to_produces_both_files() {
        let dir = std::env::temp_dir().join(format!("cognia-crash-test-{}", std::process::id()));
        let written = sample_report().write_to(&dir, "crash-test-panic").unwrap();
        assert!(written.txt_path.exists());
        assert!(written.json_path.exists());
        let txt = std::fs::read_to_string(&written.txt_path).unwrap();
        assert!(txt.contains("Description: boom"));
        // Cleanup.
        let _ = std::fs::remove_file(&written.txt_path);
        let _ = std::fs::remove_file(&written.json_path);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn timestamped_stem_is_filename_safe() {
        let stem = timestamped_stem(CrashKind::Panic);
        assert!(stem.starts_with("crash-"));
        assert!(stem.ends_with("-panic"));
        assert!(!stem.contains(':'));
        assert!(!stem.contains(' '));
    }
}
