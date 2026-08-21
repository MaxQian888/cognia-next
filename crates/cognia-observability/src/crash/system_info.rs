//! System Details — the Minecraft "System Details" block. Self-gathered by
//! Rust so it's available even when the webview (and its `@tauri-apps/plugin-os`
//! bridge) is already dead.

use serde::{Deserialize, Serialize};

/// A point-in-time snapshot of the host + build. Cheap to gather; safe to call
/// from inside a panic hook or the crash monitor process.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemDetails {
    pub os: String,
    pub os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub arch: String,
    pub family: String,
    pub hostname: Option<String>,
    pub cpu: Option<String>,
    pub cpu_count: usize,
    pub total_memory_bytes: u64,
    pub used_memory_bytes: u64,
    pub app_version: String,
    pub tauri_version: String,
    pub profile: &'static str,
    pub enabled_features: Vec<String>,
}

/// Cargo features that are meaningful in a crash report — listing the enabled
/// OCR backends pins down which heavyweight native bindings were linked.
fn enabled_features() -> Vec<String> {
    let mut features = Vec::new();
    if cfg!(feature = "ocr-tesseract") {
        features.push("ocr-tesseract".to_string());
    }
    if cfg!(feature = "ocr-windows") {
        features.push("ocr-windows".to_string());
    }
    // apple-vision is not a Cargo feature: cognia-ocr links Vision.framework
    // whenever the target is macOS. Report it the same way.
    if cfg!(target_os = "macos") {
        features.push("apple-vision".to_string());
    }
    if cfg!(feature = "ocr-ocrs") {
        features.push("ocr-ocrs".to_string());
    }
    if cfg!(feature = "ocr-paddle") {
        features.push("ocr-paddle".to_string());
    }
    features
}

const fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

/// Gather the current System Details. Uses `sysinfo` for memory/CPU/OS version
/// and `std::env::consts` for arch/family.
pub fn gather() -> SystemDetails {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string());

    SystemDetails {
        os: sysinfo::System::name().unwrap_or_else(|| std::env::consts::OS.to_string()),
        os_version: sysinfo::System::os_version(),
        kernel_version: sysinfo::System::kernel_version(),
        arch: std::env::consts::ARCH.to_string(),
        family: std::env::consts::FAMILY.to_string(),
        hostname: sysinfo::System::host_name(),
        cpu: cpu.filter(|s| !s.is_empty()),
        cpu_count: sys.cpus().len(),
        total_memory_bytes: sys.total_memory(),
        used_memory_bytes: sys.used_memory(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION.to_string(),
        profile: build_profile(),
        enabled_features: enabled_features(),
    }
}

/// Render a single megabyte-rounded "used / total" string for the report.
pub fn format_memory(used: u64, total: u64) -> String {
    let mib = |bytes: u64| bytes / (1024 * 1024);
    format!("{} MiB / {} MiB", mib(used), mib(total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gather_populates_static_fields() {
        let d = gather();
        assert_eq!(d.arch, std::env::consts::ARCH);
        assert_eq!(d.family, std::env::consts::FAMILY);
        assert_eq!(d.app_version, env!("CARGO_PKG_VERSION"));
        assert!(matches!(d.profile, "debug" | "release"));
        // Memory is read from the host; on supported OSes it must be non-zero.
        if sysinfo::IS_SUPPORTED_SYSTEM {
            assert!(d.total_memory_bytes > 0);
        }
    }

    #[test]
    fn format_memory_rounds_to_mib() {
        assert_eq!(format_memory(0, 2 * 1024 * 1024), "0 MiB / 2 MiB");
        assert_eq!(format_memory(1024 * 1024, 8 * 1024 * 1024), "1 MiB / 8 MiB");
    }

    #[test]
    fn enabled_features_is_subset_of_known() {
        let known = [
            "ocr-tesseract",
            "ocr-windows",
            "apple-vision",
            "ocr-ocrs",
            "ocr-paddle",
        ];
        for f in enabled_features() {
            assert!(known.contains(&f.as_str()), "unexpected feature: {f}");
        }
    }

    /// The converse of the subset check above, which passes trivially on an
    /// EMPTY list — which is exactly how this broke during ADR-0067 Tier C.
    /// The `ocr-*` cfgs read features of THIS crate, but the real ones live in
    /// `cognia-ocr`; when the module moved out of `app_lib` the report silently
    /// went blank. `src-tauri` now enables a marker feature here under the same
    /// name, and this pins that forwarding.
    #[test]
    fn every_enabled_ocr_marker_is_reported() {
        let reported = enabled_features();
        for (enabled, name) in [
            (cfg!(feature = "ocr-tesseract"), "ocr-tesseract"),
            (cfg!(feature = "ocr-windows"), "ocr-windows"),
            (cfg!(feature = "ocr-ocrs"), "ocr-ocrs"),
            (cfg!(feature = "ocr-paddle"), "ocr-paddle"),
        ] {
            assert_eq!(
                enabled,
                reported.iter().any(|f| f == name),
                "{name}: compiled-in state and crash-report state disagree"
            );
        }
    }
}
