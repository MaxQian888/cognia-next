//! Foreground / source-app detection for content capture (renderer feature in
//! `lib/capture/`).
//!
//! `get_foreground_app` returns the OS-focused window's app name (best-effort)
//! so a captured clipboard item can be tagged with where it came from:
//!   - **Windows**: the foreground window title (via the same `GetWindowTextW`
//!     path as `pet_window::surfaces`). A precise executable name is a
//!     follow-up needing extra `windows`-crate process features.
//!   - **macOS**: the frontmost application name via `osascript`.
//!   - **other**: nulls.
//!
//! The command never panics regardless of window state; the renderer treats a
//! null/absent result as "unknown source".

use serde::Serialize;

#[derive(Debug, Default, Serialize)]
pub struct ForegroundApp {
    pub name: Option<String>,
    pub title: Option<String>,
}

#[tauri::command]
pub fn get_foreground_app() -> ForegroundApp {
    platform::get_foreground_app()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::ForegroundApp;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
    };

    pub fn get_foreground_app() -> ForegroundApp {
        // SAFETY: `GetForegroundWindow` is a pure Win32 query; the HWND may be
        // null (lock screen / UAC transition) — guard it explicitly.
        let hwnd: HWND = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return ForegroundApp::default();
        }
        let title = window_title(hwnd);
        ForegroundApp {
            name: title.clone(),
            title,
        }
    }

    fn window_title(hwnd: HWND) -> Option<String> {
        // SAFETY: length query then a bounded read into a matching buffer,
        // mirroring `pet_window::surfaces::window_title`.
        let len = unsafe { GetWindowTextLengthW(hwnd) };
        if len <= 0 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize) + 1];
        let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if n <= 0 {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..n as usize]);
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::ForegroundApp;
    use std::process::Command;

    pub fn get_foreground_app() -> ForegroundApp {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(
                "tell application \"System Events\" to get name of first process whose frontmost is true",
            )
            .output();
        let name = output.ok().and_then(|o| {
            if !o.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });
        ForegroundApp { name, title: None }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::ForegroundApp;

    pub fn get_foreground_app() -> ForegroundApp {
        ForegroundApp::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_foreground_app_never_panics() {
        // Fields may be None (headless CI / no focused window), but the call
        // itself must always succeed.
        let app = get_foreground_app();
        let _ = (app.name, app.title);
    }
}
