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
//! **macOS / Linux**: reuses the platform focus snapshots already maintained by
//! the AX / AT-SPI backends. Dedicated credential applications and prompt
//! titles are matched conservatively; macOS also checks the focused AX control
//! for the `AXSecureTextField` subrole. Focus-query failures fail closed.

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

#[cfg(target_os = "macos")]
mod platform {
    pub fn is_credential_window_focused() -> bool {
        match crate::automation::platform::ax::focused_window_credential_signals() {
            Some((process_name, window_title, secure_text_field)) => {
                super::credential_context_is_sensitive(Some((
                    process_name.as_deref(),
                    window_title.as_deref(),
                    secure_text_field,
                )))
            }
            None => super::credential_context_is_sensitive(None),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    pub fn is_credential_window_focused() -> bool {
        match crate::automation::platform::atspi::focused_window_credential_signals() {
            Some((process_name, window_title, secure_text_field)) => {
                super::credential_context_is_sensitive(Some((
                    process_name.as_deref(),
                    window_title.as_deref(),
                    secure_text_field,
                )))
            }
            None => super::credential_context_is_sensitive(None),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    pub fn is_credential_window_focused() -> bool {
        true
    }
}

fn credential_context_is_sensitive(context: Option<(Option<&str>, Option<&str>, bool)>) -> bool {
    let Some((process_name, window_title, secure_text_field)) = context else {
        // A frame whose foreground owner cannot be established is not safe to
        // send to a remote approver. Blank it instead of guessing.
        return true;
    };
    if secure_text_field {
        return true;
    }

    let process_name = process_name.unwrap_or_default().to_ascii_lowercase();
    let window_title = window_title.unwrap_or_default().to_ascii_lowercase();
    if process_name.is_empty() && window_title.is_empty() {
        return true;
    }

    const CREDENTIAL_PROCESS_MARKERS: &[&str] = &[
        "1password",
        "bitwarden",
        "gcr-prompter",
        "gksu",
        "gnome-keyring",
        "keepassxc",
        "keychain access",
        "kdesu",
        "ksshaskpass",
        "kwallet",
        "lxqt-policykit",
        "mate-polkit",
        "pinentry",
        "pkexec",
        "polkit",
        "securityagent",
        "seahorse",
        "ssh-askpass",
        "xfce-polkit",
    ];
    const CREDENTIAL_TITLE_MARKERS: &[&str] = &[
        "authentication",
        "authentication required",
        "credential",
        "credentials required",
        "enter password",
        "passphrase",
        "password",
        "password required",
        "pin entry",
        "unlock",
        "unlock keyring",
        "unlock login keyring",
        "unlock wallet",
        "凭据",
        "密码",
        "认证",
        "解锁",
    ];

    CREDENTIAL_PROCESS_MARKERS
        .iter()
        .any(|marker| process_name.contains(marker))
        || CREDENTIAL_TITLE_MARKERS
            .iter()
            .any(|marker| window_title.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_context_matches_secure_fields_and_known_apps() {
        assert!(credential_context_is_sensitive(Some((
            Some("Safari"),
            Some("Sign in"),
            true,
        ))));
        assert!(credential_context_is_sensitive(Some((
            Some("1Password"),
            Some("Quick Access"),
            false,
        ))));
        assert!(credential_context_is_sensitive(Some((
            Some("gcr-prompter"),
            Some("Authentication Required"),
            false,
        ))));
        assert!(credential_context_is_sensitive(Some((
            Some("polkit-gnome-authentication-agent-1"),
            Some("System action"),
            false,
        ))));
        assert!(credential_context_is_sensitive(Some((
            Some("zenity"),
            Some("请输入密码"),
            false,
        ))));
    }

    #[test]
    fn credential_context_rejects_normal_windows() {
        assert!(!credential_context_is_sensitive(Some((
            Some("Terminal"),
            Some("cognia-next"),
            false,
        ))));
    }

    #[test]
    fn credential_context_fails_closed_when_focus_cannot_be_resolved() {
        assert!(credential_context_is_sensitive(None));
    }

    #[test]
    fn returns_a_bool_without_panicking() {
        // The function is a thin platform query; the only thing we can
        // assert here without standing up a real credential prompt is
        // that it returns *some* bool and doesn't panic on a CI host
        // where the foreground window is, say, the terminal.
        let _: bool = is_credential_window_focused();
    }
}
