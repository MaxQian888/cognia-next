// Screen-off Computer Use (ADR-0020 follow-up) — virtual-display driver
// installer. Mirrors `cognia-sandbox-setup.rs`: UAC-elevated, idempotent.
//
//   --install   : `pnputil /add-driver <bundled .inf> /install`, then write the
//                 success marker `<app_data>/cognia/display/vdd-setup.ok`.
//   --uninstall : remove the marker and best-effort `pnputil /delete-driver`.
//                 Called by the app-removal hook.
//
// Elevation comes from the launcher (the renderer's `virtual_display_setup`
// command runs this via `Start-Process -Verb RunAs`), matching how the sandbox
// setup binary is elevated. The bundled, Microsoft-signed parsec-vdd driver
// (.inf/.sys/.cat) lives next to the executable under `vdd/` — vendored at
// packaging time (see `resources/vdd/README.md`).

// The marker/driver-INF helpers and their imports feed only the
// `#[cfg(target_os = "windows")]` install/uninstall paths; the non-Windows
// stubs return an error without touching them, so gate the symbols to Windows.
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;

/// Success marker — kept in sync with
/// `automation::virtual_display::marker_path()` in the library.
#[cfg(target_os = "windows")]
fn marker() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("cognia").join("display").join("vdd-setup.ok"))
}

/// Path of the bundled driver INF, resolved relative to this executable.
#[cfg(target_os = "windows")]
fn driver_inf() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("vdd").join("parsec-vdd.inf")))
        .unwrap_or_else(|| PathBuf::from("vdd\\parsec-vdd.inf"))
}

fn main() {
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "--install".into());
    let result = match mode.as_str() {
        "--uninstall" => uninstall(),
        _ => install(),
    };
    if let Err(e) = result {
        eprintln!("cognia-vdd-setup failed: {e}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "windows")]
fn install() -> Result<(), String> {
    let inf = driver_inf();
    if !inf.exists() {
        return Err(format!(
            "bundled driver INF not found at {inf:?} — vendor the signed parsec-vdd payload under resources/vdd/"
        ));
    }
    let out = Command::new("pnputil")
        .args(["/add-driver", &inf.to_string_lossy(), "/install"])
        .output()
        .map_err(|e| format!("pnputil spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "pnputil /add-driver exited {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let m = marker().ok_or("could not resolve app data dir for marker")?;
    if let Some(parent) = m.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create marker dir failed: {e}"))?;
    }
    std::fs::write(&m, chrono::Utc::now().to_rfc3339())
        .map_err(|e| format!("write marker failed: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn uninstall() -> Result<(), String> {
    // Marker removal is unconditional so the app stops offering screen-off
    // mode immediately. Driver removal is best-effort: a thorough uninstall
    // enumerates `pnputil /enum-drivers` for the published oemNN.inf and
    // deletes that; here we attempt the bundled path, which is sufficient when
    // the package is still referenced.
    let inf = driver_inf();
    let _ = Command::new("pnputil")
        .args(["/delete-driver", &inf.to_string_lossy(), "/uninstall"])
        .output();
    if let Some(m) = marker() {
        let _ = std::fs::remove_file(m);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn install() -> Result<(), String> {
    Err("cognia-vdd-setup runs on Windows only".into())
}

#[cfg(not(target_os = "windows"))]
fn uninstall() -> Result<(), String> {
    Err("cognia-vdd-setup runs on Windows only".into())
}
