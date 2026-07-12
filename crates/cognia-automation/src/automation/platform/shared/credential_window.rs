//! Detect whether the OS-focused window is a credential / password prompt.
//!
//! Used by the screenshot redaction path (ADR-0020 W1 — when
//! `AutomationSettings.redact_screenshots == true`, the dispatcher swaps
//! the captured bytes for a black image of the same dimensions if a
//! credential prompt is on screen). Keeping the detection logic in a
//! shared module means every backend's screenshot path enforces the same
//! list, and the lookup is pure / synchronous so the dispatcher can call
//! it without an extra async hop.
//!
//! **Windows**: matches well-known class-name prefixes for the
//! `CredentialDialogXaml*` family (Windows credential prompts) and
//! `LogonUI` (the lock-screen variant). Class strings can be longer than
//! the buffer we read, but a prefix match is enough because Microsoft
//! versions the classes by adding `_<hex>` suffixes.
//!
//! **macOS / Linux**: today this returns `false`. Wave 2 adds get_focus
//! support on those platforms, after which we'll match against known
//! process names (Keychain Access / 1Password / Bitwarden / GNOME Keyring)
//! and lift this guard.

/// Returns `true` when the foreground window appears to be a credential
/// prompt. Pure — no I/O outside the platform window query (which is
/// itself sub-microsecond).
pub fn is_credential_window_focused() -> bool {
    platform::is_credential_window_focused()
}

#[cfg(target_os = "windows")]
mod platform {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow};

    /// Prefix list — Microsoft frequently versions credential XAML classes
    /// with hex suffixes (`CredentialDialogXaml_<hash>`), so we match by
    /// prefix rather than exact equality.
    const CREDENTIAL_CLASS_PREFIXES: &[&str] = &[
        "Credential Dialog Xaml Host",
        "CredentialDialogXaml",
        "CredentialUIBroker",
        "LogonUI",
        "Windows.UI.Core.CoreWindow.LogonUI",
    ];

    pub fn is_credential_window_focused() -> bool {
        let class_name = match foreground_window_class() {
            Some(c) => c,
            None => return false,
        };
        CREDENTIAL_CLASS_PREFIXES
            .iter()
            .any(|prefix| class_name.starts_with(prefix))
    }

    fn foreground_window_class() -> Option<String> {
        // SAFETY: `GetForegroundWindow` is a pure Win32 query; the returned
        // HWND may be null when no window is foreground (lock screen, UAC
        // transition). We guard against that explicitly.
        let hwnd: HWND = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let mut buf = [0u16; 256];
        // SAFETY: `GetClassNameW` writes at most `buf.len()` UTF-16 code
        // units and returns the count written (excluding the null
        // terminator). Negative / zero returns mean no class — treat as
        // "not credential".
        let n = unsafe { GetClassNameW(hwnd, pwstr_as_wide_mut(buf.as_mut_ptr())) };
        if n <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..n as usize]))
    }

    // The `pwstr_as_wide_mut` shim below lets us hand a raw slice to
    // `GetClassNameW`; the `windows` crate's PWSTR doesn't carry a
    // length, only a pointer. We implement the slice view explicitly
    // because pulling `PWSTR::from_raw` requires a null-terminated
    // source we don't have at call time.
    unsafe fn pwstr_as_wide_mut<'a>(ptr: *mut u16) -> &'a mut [u16] {
        // SAFETY: caller owns the underlying buffer; we only construct
        // the slice for the duration of the foreign call.
        std::slice::from_raw_parts_mut(ptr, 256)
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    pub fn is_credential_window_focused() -> bool {
        // Wave 2 will replace this with a `get_focus` + process-name
        // lookup against {Keychain Access, 1Password, Bitwarden,
        // GNOME Keyring, KWalletManager}. Until then the redact flag is a
        // Windows-only safety net; mac / linux capture without redaction.
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_a_bool_without_panicking() {
        // The function is a thin platform query; the only thing we can
        // assert here without standing up a real credential prompt is
        // that it returns *some* bool and doesn't panic on a CI host
        // where the foreground window is, say, the terminal.
        let _: bool = is_credential_window_focused();
    }
}
