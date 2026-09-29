//! OS user presence: ask the person at the keyboard to prove they are the
//! signed-in user before a secret is revealed, copied or exported (ADR-0201).
//!
//! | OS | Mechanism | Fallback |
//! | --- | --- | --- |
//! | macOS | LocalAuthentication `LAPolicyDeviceOwnerAuthentication` (Touch ID, Apple Watch or the login password) | — |
//! | Windows | Windows Hello `UserConsentVerifier` (for the foreground window) | the Windows credential prompt restricted to the current user, verified with `LogonUserW` |
//! | Linux | polkit `pkcheck --allow-user-interaction` for this process on an action whose implicit authorization is `auth_self` (the signed-in user's own password) | an `auth_admin` action only when no `auth_self` action is installed |
//!
//! [`verify`] blocks until the user answers; call it off the UI thread and
//! off async executors (`spawn_blocking`). Any failure — including "this
//! machine has no way to ask" — refuses: callers must treat every `Err` as
//! "do not release the secret".
//!
//! Linux action choice: polkit has no stock "prove you are the user" action,
//! and the stock `org.freedesktop.policykit.exec` is `auth_admin` — on many
//! distributions (and for every non-admin account) it asks for an
//! administrator's password or cannot be answered at all. Cognia therefore
//! asks about its own action, [`COGNIA_POLKIT_ACTION`], shipped by the
//! package as [`COGNIA_POLKIT_POLICY`] with `auth_self` defaults. When that
//! policy is not installed, the first stock action in
//! [`AUTH_SELF_CANDIDATE_ACTIONS`] whose implicit active authorization
//! `pkaction --verbose` reports as `auth_self` is used instead. Only when no
//! `auth_self` action exists does it fall back to
//! [`FALLBACK_POLKIT_ACTION`]. An action whose implicit authorization is
//! `yes` (no prompt) is never used: it would release a secret unasked.

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserPresenceError {
    /// The user tried and failed (wrong password, too many attempts).
    Denied,
    /// The OS cannot verify presence here (no passcode set, no polkit agent,
    /// unsupported OS, non-interactive session).
    Unavailable,
    /// The user or the system dismissed the prompt.
    Cancelled,
    /// The OS call itself failed.
    Failed(String),
}

impl UserPresenceError {
    /// Stable machine-readable code carried in IPC error strings.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Denied => "user_presence_denied",
            Self::Unavailable => "user_presence_unavailable",
            Self::Cancelled => "user_presence_cancelled",
            Self::Failed(_) => "user_presence_failed",
        }
    }
}

impl fmt::Display for UserPresenceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(detail) => write!(f, "{}: {detail}", self.code()),
            other => f.write_str(other.code()),
        }
    }
}

impl std::error::Error for UserPresenceError {}

/// Ask the OS to verify the signed-in user. `reason` is shown in the prompt
/// ("Cognia wants to show a saved password").
pub fn verify(reason: &str) -> Result<(), UserPresenceError> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(UserPresenceError::Failed("empty reason".into()));
    }
    platform::verify(reason)
}

/// macOS `LAError` codes → outcome.
pub fn classify_la_error(code: isize) -> UserPresenceError {
    match code {
        // UserCancel, UserFallback, SystemCancel, AppCancel
        -2 | -3 | -4 | -9 => UserPresenceError::Cancelled,
        // AuthenticationFailed, BiometryLockout
        -1 | -8 => UserPresenceError::Denied,
        // PasscodeNotSet, BiometryNotAvailable, BiometryNotEnrolled,
        // InvalidContext, NotInteractive, WatchNotAvailable, …
        -5 | -6 | -7 | -10 | -11 | -1004 => UserPresenceError::Unavailable,
        other => UserPresenceError::Failed(format!("LAError {other}")),
    }
}

/// Windows `UserConsentVerificationResult` values → outcome. `None` means
/// "Hello is not usable here; fall back to the credential prompt".
pub fn classify_consent_result(result: i32) -> Option<Result<(), UserPresenceError>> {
    match result {
        0 => Some(Ok(())),
        // DeviceNotPresent, NotConfiguredForUser, DisabledByPolicy
        1..=3 => None,
        // DeviceBusy
        4 => Some(Err(UserPresenceError::Unavailable)),
        // RetriesExhausted
        5 => Some(Err(UserPresenceError::Denied)),
        // Canceled
        6 => Some(Err(UserPresenceError::Cancelled)),
        other => Some(Err(UserPresenceError::Failed(format!(
            "UserConsentVerificationResult {other}"
        )))),
    }
}

/// `pkcheck` exit status → outcome.
pub fn classify_pkcheck_exit(code: Option<i32>) -> Result<(), UserPresenceError> {
    match code {
        Some(0) => Ok(()),
        // Not authorized, or a challenge that could not be answered.
        Some(1) | Some(2) => Err(UserPresenceError::Denied),
        Some(3) => Err(UserPresenceError::Cancelled),
        Some(other) => Err(UserPresenceError::Failed(format!("pkcheck exited {other}"))),
        None => Err(UserPresenceError::Failed("pkcheck was terminated".into())),
    }
}

/// The start time (field 22) of `/proc/<pid>/stat`, which polkit needs to
/// identify a process without a PID-reuse race.
pub fn parse_proc_start_time(stat: &str) -> Option<u64> {
    // The command name (field 2) is parenthesized and may contain spaces or
    // parentheses; everything after the last ')' is space-separated.
    let rest = &stat[stat.rfind(')')? + 1..];
    // After ')' come fields 3.. ; field 22 is the 20th of them.
    rest.split_whitespace().nth(19)?.parse().ok()
}

/// The real UID from `/proc/<pid>/status`.
pub fn parse_proc_uid(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|uid| uid.parse().ok())
}

/// The polkit action Cognia asks about when the package installed
/// [`COGNIA_POLKIT_POLICY`].
pub const COGNIA_POLKIT_ACTION: &str = "com.cognia.desktop.verify-user";
/// Stock actions tried, in order, when Cognia's own policy is missing; each
/// is used only if `pkaction --verbose` reports an `auth_self` implicit
/// active authorization on this machine.
pub const AUTH_SELF_CANDIDATE_ACTIONS: &[&str] = &[
    "org.freedesktop.accounts.change-own-password",
    "org.freedesktop.accounts.change-own-user-data",
];
/// Last resort (`auth_admin`: asks for an administrator's password; nothing
/// is executed).
pub const FALLBACK_POLKIT_ACTION: &str = "org.freedesktop.policykit.exec";

/// The policy file the Linux packages install as
/// `/usr/share/polkit-1/actions/com.cognia.desktop.verify-user.policy`: every
/// check asks the signed-in user for their own password (`auth_self`, never
/// cached).
pub const COGNIA_POLKIT_POLICY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE policyconfig PUBLIC "-//freedesktop//DTD PolicyKit Policy Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/PolicyKit/1/policyconfig.dtd">
<policyconfig>
  <vendor>Cognia</vendor>
  <action id="com.cognia.desktop.verify-user">
    <description>Confirm it is you</description>
    <message>Cognia needs your password to reveal, copy or export a saved password</message>
    <defaults>
      <allow_any>auth_self</allow_any>
      <allow_inactive>auth_self</allow_inactive>
      <allow_active>auth_self</allow_active>
    </defaults>
  </action>
</policyconfig>
"#;

/// The `implicit active:` value of `pkaction --verbose --action-id <id>`.
pub fn parse_implicit_active(pkaction_verbose: &str) -> Option<String> {
    pkaction_verbose.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "implicit active").then(|| value.trim().to_string())
    })
}

/// Whether an implicit authorization makes the user prove it is them:
/// `auth_self` / `auth_self_keep`.
pub fn authenticates_self(implicit: &str) -> bool {
    matches!(implicit.trim(), "auth_self" | "auth_self_keep")
}

/// Pick the polkit action: Cognia's own when installed with an `auth_self`
/// default, else the first `auth_self` stock candidate, else the
/// `auth_admin` fallback. `implicit_active(action)` returns the action's
/// implicit active authorization, or `None` when it is not installed.
pub fn choose_polkit_action(implicit_active: impl Fn(&str) -> Option<String>) -> &'static str {
    std::iter::once(COGNIA_POLKIT_ACTION)
        .chain(AUTH_SELF_CANDIDATE_ACTIONS.iter().copied())
        .find(|action| implicit_active(action).is_some_and(|value| authenticates_self(&value)))
        .unwrap_or(FALLBACK_POLKIT_ACTION)
}

/// The account part of a typed Windows user name: `DOMAIN\user` → `user`,
/// `user@domain` (UPN) → `user`, `.\user` → `user`, `user` → `user`.
pub fn account_name(typed: &str) -> &str {
    let after_domain = typed.rsplit('\\').next().unwrap_or(typed);
    after_domain.split('@').next().unwrap_or(after_domain).trim()
}

/// Whether the name typed into the credential prompt names the signed-in
/// account (`expected`, as `GetUserNameW` reports it), in any of the
/// `DOMAIN\user`, UPN or bare forms, compared case-insensitively
/// (Windows account names are case-insensitive, including non-ASCII ones).
pub fn typed_user_matches(typed: &str, expected: &str) -> bool {
    let account = account_name(typed);
    let expected = account_name(expected);
    !account.is_empty() && !expected.is_empty() && account.to_lowercase() == expected.to_lowercase()
}

/// How to hand a typed name to `LogonUserW`: `DOMAIN\user` is split into
/// user and domain (`LogonUserW` does not parse it); a UPN goes whole with no
/// domain; a bare name uses the prompt's domain field, if any.
pub fn logon_parts(typed: &str, domain_field: &str) -> (String, Option<String>) {
    if let Some((domain, user)) = typed.rsplit_once('\\') {
        let domain = domain.trim();
        return (
            user.trim().to_string(),
            (!domain.is_empty()).then(|| domain.to_string()),
        );
    }
    if typed.contains('@') {
        return (typed.trim().to_string(), None);
    }
    let domain = domain_field.trim();
    (
        typed.trim().to_string(),
        (!domain.is_empty()).then(|| domain.to_string()),
    )
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAPolicy};

    use super::{classify_la_error, UserPresenceError};

    const PROMPT_TIMEOUT: Duration = Duration::from_secs(300);

    pub(super) fn verify(reason: &str) -> Result<(), UserPresenceError> {
        // SAFETY: LAContext is created, used and invalidated on this thread;
        // the reply block only sends on a channel.
        unsafe {
            let context = LAContext::new();
            let policy = LAPolicy::DeviceOwnerAuthentication;
            if let Err(error) = context.canEvaluatePolicy_error(policy) {
                return Err(match classify_la_error(error.code()) {
                    UserPresenceError::Failed(_) | UserPresenceError::Unavailable => {
                        UserPresenceError::Unavailable
                    }
                    other => other,
                });
            }
            let (tx, rx) = mpsc::sync_channel::<Result<(), isize>>(1);
            let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
                let outcome = if success.as_bool() {
                    Ok(())
                } else if error.is_null() {
                    Err(0)
                } else {
                    Err((*error).code())
                };
                let _ = tx.send(outcome);
            });
            let message = NSString::from_str(reason);
            context.evaluatePolicy_localizedReason_reply(policy, &message, &reply);
            match rx.recv_timeout(PROMPT_TIMEOUT) {
                Ok(Ok(())) => Ok(()),
                Ok(Err(code)) => Err(classify_la_error(code)),
                Err(_) => {
                    context.invalidate();
                    Err(UserPresenceError::Cancelled)
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows::core::{HSTRING, PCWSTR, PWSTR};
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED, HANDLE, HWND};
    use windows::Win32::Security::Credentials::{
        CredUIPromptForWindowsCredentialsW, CredUnPackAuthenticationBufferW,
        CREDUIWIN_ENUMERATE_CURRENT_USER, CREDUI_INFOW, CRED_PACK_FLAGS,
    };
    use windows::Win32::Security::{
        LogonUserW, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows::Win32::System::WindowsProgramming::GetUserNameW;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    use windows_future::IAsyncOperation;

    use super::{classify_consent_result, logon_parts, typed_user_matches, UserPresenceError};

    fn failed(error: windows::core::Error) -> UserPresenceError {
        UserPresenceError::Failed(error.message())
    }

    fn wipe(buffer: &mut [u16]) {
        for unit in buffer.iter_mut() {
            // SAFETY: `unit` is a valid, aligned element of `buffer`.
            unsafe { std::ptr::write_volatile(unit, 0) };
        }
    }

    fn hello(
        reason: &str,
        window: HWND,
    ) -> Result<Option<Result<(), UserPresenceError>>, UserPresenceError> {
        let availability = UserConsentVerifier::CheckAvailabilityAsync()
            .and_then(|operation| operation.join())
            .map_err(failed)?;
        if availability != UserConsentVerifierAvailability::Available {
            return Ok(None);
        }
        let message = HSTRING::from(reason);
        let result: UserConsentVerificationResult = if window.is_invalid() {
            UserConsentVerifier::RequestVerificationAsync(&message)
                .and_then(|operation| operation.join())
                .map_err(failed)?
        } else {
            let interop =
                windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                    .map_err(failed)?;
            // SAFETY: `window` is a live top-level window handle or invalid
            // (checked above); `message` outlives the call.
            let operation: IAsyncOperation<UserConsentVerificationResult> =
                unsafe { interop.RequestVerificationForWindowAsync(window, &message) }
                    .map_err(failed)?;
            operation.join().map_err(failed)?
        };
        Ok(classify_consent_result(result.0))
    }

    fn current_user() -> Option<String> {
        let mut buffer = [0_u16; 257];
        let mut size = buffer.len() as u32;
        // SAFETY: `buffer` holds `size` UTF-16 units.
        unsafe { GetUserNameW(Some(PWSTR(buffer.as_mut_ptr())), &mut size) }.ok()?;
        let len = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }

    fn credential_prompt(reason: &str, window: HWND) -> Result<(), UserPresenceError> {
        let message: Vec<u16> = reason.encode_utf16().chain(Some(0)).collect();
        let caption: Vec<u16> = "Cognia".encode_utf16().chain(Some(0)).collect();
        let info = CREDUI_INFOW {
            cbSize: std::mem::size_of::<CREDUI_INFOW>() as u32,
            hwndParent: window,
            pszMessageText: PCWSTR(message.as_ptr()),
            pszCaptionText: PCWSTR(caption.as_ptr()),
            ..Default::default()
        };
        let mut package = 0_u32;
        let mut out_buffer: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut out_size = 0_u32;
        // SAFETY: every pointer refers to a live local; CredUI allocates
        // `out_buffer` with CoTaskMemAlloc, freed below.
        let status = unsafe {
            CredUIPromptForWindowsCredentialsW(
                Some(&info),
                0,
                &mut package,
                None,
                0,
                &mut out_buffer,
                &mut out_size,
                None,
                CREDUIWIN_ENUMERATE_CURRENT_USER,
            )
        };
        if status == ERROR_CANCELLED.0 {
            return Err(UserPresenceError::Cancelled);
        }
        if status != 0 || out_buffer.is_null() {
            return Err(UserPresenceError::Failed(format!(
                "CredUIPromptForWindowsCredentialsW {status}"
            )));
        }
        let mut user = [0_u16; 514];
        let mut domain = [0_u16; 338];
        let mut password = [0_u16; 514];
        let (mut user_len, mut domain_len, mut password_len) = (
            user.len() as u32,
            domain.len() as u32,
            password.len() as u32,
        );
        // SAFETY: the buffers hold the advertised number of UTF-16 units and
        // `out_buffer` is CredUI's packed buffer of `out_size` bytes.
        let unpacked = unsafe {
            CredUnPackAuthenticationBufferW(
                CRED_PACK_FLAGS(0),
                out_buffer,
                out_size,
                Some(PWSTR(user.as_mut_ptr())),
                &mut user_len,
                Some(PWSTR(domain.as_mut_ptr())),
                Some(&mut domain_len),
                Some(PWSTR(password.as_mut_ptr())),
                &mut password_len,
            )
        };
        // SAFETY: wipe and free CredUI's buffer exactly once.
        unsafe {
            let bytes = std::slice::from_raw_parts_mut(out_buffer.cast::<u8>(), out_size as usize);
            bytes
                .iter_mut()
                .for_each(|byte| std::ptr::write_volatile(byte, 0));
            CoTaskMemFree(Some(out_buffer.cast_const()));
        }
        if let Err(error) = unpacked {
            wipe(&mut password);
            return Err(failed(error));
        }
        let text = |buffer: &[u16]| {
            let len = buffer
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(buffer.len());
            String::from_utf16_lossy(&buffer[..len])
        };
        let typed_user = text(&user);
        // `DOMAIN\user`, `user@domain` (UPN) or a bare name from the prompt;
        // the account part must be the signed-in user (case-insensitive).
        let expected = current_user().unwrap_or_default();
        if !typed_user_matches(&typed_user, &expected) {
            wipe(&mut password);
            return Err(UserPresenceError::Denied);
        }
        let (logon_user, logon_domain) = logon_parts(&typed_user, &text(&domain));
        let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        let logon_user = wide(&logon_user);
        let logon_domain = logon_domain.as_deref().map(wide);
        let mut token = HANDLE::default();
        let domain_ptr = match &logon_domain {
            Some(domain) => PCWSTR(domain.as_ptr()),
            None => PCWSTR::null(),
        };
        // SAFETY: NUL-terminated UTF-16 buffers that outlive the call.
        let logon = unsafe {
            LogonUserW(
                PCWSTR(logon_user.as_ptr()),
                domain_ptr,
                PCWSTR(password.as_ptr()),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut token,
            )
        };
        wipe(&mut password);
        match logon {
            Ok(()) => {
                // SAFETY: LogonUserW returned an owned token handle.
                let _ = unsafe { CloseHandle(token) };
                Ok(())
            }
            Err(_) => Err(UserPresenceError::Denied),
        }
    }

    pub(super) fn verify(reason: &str) -> Result<(), UserPresenceError> {
        // SAFETY: no preconditions.
        let window = unsafe { GetForegroundWindow() };
        match hello(reason, window) {
            Ok(Some(outcome)) => outcome,
            Ok(None) | Err(UserPresenceError::Failed(_)) => credential_prompt(reason, window),
            Err(other) => Err(other),
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::process::{Command, Stdio};

    use super::{
        choose_polkit_action, classify_pkcheck_exit, parse_implicit_active,
        parse_proc_start_time, parse_proc_uid, UserPresenceError,
    };

    /// The implicit active authorization of an installed action, via
    /// `pkaction --verbose`; `None` when it is not installed.
    fn implicit_active(action: &str) -> Option<String> {
        let output = Command::new("pkaction")
            .args(["--verbose", "--action-id", action])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_implicit_active(&String::from_utf8_lossy(&output.stdout))
    }

    pub(super) fn verify(_reason: &str) -> Result<(), UserPresenceError> {
        // polkit shows the action's own (translated) message; `reason` is not
        // passed through.
        let pid = std::process::id();
        let stat = std::fs::read_to_string("/proc/self/stat")
            .map_err(|_| UserPresenceError::Unavailable)?;
        let status = std::fs::read_to_string("/proc/self/status")
            .map_err(|_| UserPresenceError::Unavailable)?;
        let start_time = parse_proc_start_time(&stat).ok_or(UserPresenceError::Unavailable)?;
        let uid = parse_proc_uid(&status).ok_or(UserPresenceError::Unavailable)?;
        let action = choose_polkit_action(implicit_active);
        let outcome = Command::new("pkcheck")
            .args([
                "--action-id",
                action,
                "--process",
                &format!("{pid},{start_time},{uid}"),
                "--allow-user-interaction",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match outcome {
            Ok(status) => classify_pkcheck_exit(status.code()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(UserPresenceError::Unavailable)
            }
            Err(error) => Err(UserPresenceError::Failed(error.to_string())),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    use super::UserPresenceError;

    pub(super) fn verify(_reason: &str) -> Result<(), UserPresenceError> {
        Err(UserPresenceError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_are_the_ipc_contract() {
        assert_eq!(
            UserPresenceError::Denied.to_string(),
            "user_presence_denied"
        );
        assert_eq!(
            UserPresenceError::Unavailable.to_string(),
            "user_presence_unavailable"
        );
        assert_eq!(
            UserPresenceError::Cancelled.to_string(),
            "user_presence_cancelled"
        );
        assert_eq!(
            UserPresenceError::Failed("boom".into()).to_string(),
            "user_presence_failed: boom"
        );
        assert_eq!(
            UserPresenceError::Failed("x".into()).code(),
            "user_presence_failed"
        );
    }

    #[test]
    fn an_empty_reason_is_refused_before_prompting() {
        assert!(matches!(verify("   "), Err(UserPresenceError::Failed(_))));
    }

    #[test]
    fn classifies_local_authentication_errors() {
        for code in [-2, -3, -4, -9] {
            assert_eq!(classify_la_error(code), UserPresenceError::Cancelled);
        }
        for code in [-1, -8] {
            assert_eq!(classify_la_error(code), UserPresenceError::Denied);
        }
        for code in [-5, -6, -7, -10, -11, -1004] {
            assert_eq!(classify_la_error(code), UserPresenceError::Unavailable);
        }
        assert_eq!(
            classify_la_error(-99),
            UserPresenceError::Failed("LAError -99".into())
        );
    }

    #[test]
    fn classifies_windows_hello_results() {
        assert_eq!(classify_consent_result(0), Some(Ok(())));
        for fallback in 1..=3 {
            assert_eq!(classify_consent_result(fallback), None);
        }
        assert_eq!(
            classify_consent_result(4),
            Some(Err(UserPresenceError::Unavailable))
        );
        assert_eq!(
            classify_consent_result(5),
            Some(Err(UserPresenceError::Denied))
        );
        assert_eq!(
            classify_consent_result(6),
            Some(Err(UserPresenceError::Cancelled))
        );
        assert!(matches!(
            classify_consent_result(42),
            Some(Err(UserPresenceError::Failed(_)))
        ));
    }

    #[test]
    fn classifies_pkcheck_exits() {
        assert_eq!(classify_pkcheck_exit(Some(0)), Ok(()));
        assert_eq!(
            classify_pkcheck_exit(Some(1)),
            Err(UserPresenceError::Denied)
        );
        assert_eq!(
            classify_pkcheck_exit(Some(2)),
            Err(UserPresenceError::Denied)
        );
        assert_eq!(
            classify_pkcheck_exit(Some(3)),
            Err(UserPresenceError::Cancelled)
        );
        assert!(matches!(
            classify_pkcheck_exit(Some(4)),
            Err(UserPresenceError::Failed(_))
        ));
        assert!(matches!(
            classify_pkcheck_exit(None),
            Err(UserPresenceError::Failed(_))
        ));
    }

    #[test]
    fn parses_proc_fields() {
        let stat = "1234 (my (odd) app) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 4 0 987654 123456 789";
        assert_eq!(parse_proc_start_time(stat), Some(987_654));
        assert_eq!(parse_proc_start_time("garbage"), None);
        assert_eq!(parse_proc_start_time("1 (x) S 1"), None);
        let status = "Name:\tcognia\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n";
        assert_eq!(parse_proc_uid(status), Some(1000));
        assert_eq!(parse_proc_uid("Name: x\n"), None);
    }

    #[test]
    fn polkit_actions_are_fixed() {
        assert_eq!(COGNIA_POLKIT_ACTION, "com.cognia.desktop.verify-user");
        assert_eq!(FALLBACK_POLKIT_ACTION, "org.freedesktop.policykit.exec");
        assert!(COGNIA_POLKIT_POLICY.contains(COGNIA_POLKIT_ACTION));
        assert_eq!(
            COGNIA_POLKIT_POLICY.matches("<allow_active>auth_self</allow_active>").count(),
            1
        );
        assert!(!COGNIA_POLKIT_POLICY.contains("auth_admin"));
        assert!(!COGNIA_POLKIT_POLICY.contains(">yes<"));
    }

    #[test]
    fn parses_pkaction_implicit_authorizations() {
        let verbose = "org.freedesktop.accounts.change-own-password:\n  description:       Change your own user password\n  message:           Authentication is required\n  vendor:            The Freedesktop Project\n  implicit any:      auth_self\n  implicit inactive: auth_self\n  implicit active:   auth_self_keep\n";
        assert_eq!(parse_implicit_active(verbose).as_deref(), Some("auth_self_keep"));
        assert_eq!(parse_implicit_active("nothing here"), None);
        assert!(authenticates_self("auth_self"));
        assert!(authenticates_self("auth_self_keep"));
        assert!(!authenticates_self("auth_admin"));
        assert!(!authenticates_self("auth_admin_keep"));
        assert!(!authenticates_self("yes"));
        assert!(!authenticates_self("no"));
    }

    #[test]
    fn prefers_an_action_that_authenticates_the_user() {
        let installed = |pairs: &'static [(&'static str, &'static str)]| {
            move |action: &str| {
                pairs
                    .iter()
                    .find(|(id, _)| *id == action)
                    .map(|(_, value)| value.to_string())
            }
        };
        assert_eq!(
            choose_polkit_action(installed(&[
                (COGNIA_POLKIT_ACTION, "auth_self"),
                ("org.freedesktop.accounts.change-own-password", "auth_self"),
            ])),
            COGNIA_POLKIT_ACTION
        );
        // Cognia's policy missing: a stock auth_self action is used.
        assert_eq!(
            choose_polkit_action(installed(&[(
                "org.freedesktop.accounts.change-own-password",
                "auth_self_keep"
            )])),
            "org.freedesktop.accounts.change-own-password"
        );
        // An action that would not prompt (`yes`) or asks for an admin is
        // skipped.
        assert_eq!(
            choose_polkit_action(installed(&[
                (COGNIA_POLKIT_ACTION, "yes"),
                ("org.freedesktop.accounts.change-own-password", "auth_admin"),
                ("org.freedesktop.accounts.change-own-user-data", "auth_self"),
            ])),
            "org.freedesktop.accounts.change-own-user-data"
        );
        // Nothing authenticates the user: the admin fallback.
        assert_eq!(choose_polkit_action(|_| None), FALLBACK_POLKIT_ACTION);
    }

    #[test]
    fn windows_user_names_match_in_every_form() {
        for typed in ["ada", "ADA", "Ada", "CORP\\ada", ".\\Ada", "ada@corp.example", "ADA@CORP.EXAMPLE"] {
            assert!(typed_user_matches(typed, "ada"), "{typed}");
        }
        assert!(typed_user_matches("Émile", "émile"), "non-ASCII is case-folded");
        assert!(typed_user_matches("corp\\ada", "CORP\\Ada"));
        for typed in ["bob", "CORP\\bob", "bob@corp.example", "", "CORP\\", "@corp"] {
            assert!(!typed_user_matches(typed, "ada"), "{typed}");
        }
        assert!(!typed_user_matches("ada", ""));
        assert_eq!(account_name("CORP\\ada"), "ada");
        assert_eq!(account_name("ada@corp.example"), "ada");
    }

    #[test]
    fn windows_logon_parts_split_domain_forms() {
        assert_eq!(
            logon_parts("CORP\\ada", ""),
            ("ada".to_string(), Some("CORP".to_string()))
        );
        assert_eq!(
            logon_parts(".\\ada", ""),
            ("ada".to_string(), Some(".".to_string()))
        );
        assert_eq!(logon_parts("ada@corp.example", "IGNORED"), ("ada@corp.example".to_string(), None));
        assert_eq!(logon_parts("ada", ""), ("ada".to_string(), None));
        assert_eq!(
            logon_parts("ada", "CORP"),
            ("ada".to_string(), Some("CORP".to_string()))
        );
    }
}
