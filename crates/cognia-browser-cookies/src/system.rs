//! The real OS secret sources behind [`OsSecrets`]:
//!
//! - macOS Keychain: supplied by the host (the desktop's Keychain adapter goes
//!   through `cognia-secrets::keychain_access`), wrapped as a [`Keychain`].
//! - Windows DPAPI: `CryptUnprotectData` for the current user.
//! - Linux Secret Service: `secret-tool lookup application <name>` (libsecret's
//!   CLI), so no D-Bus client is linked into this crate.
//!
//! On an OS a source does not exist on, it reports
//! [`ImportError::UnsupportedOs`] (DPAPI) or "no password" (Secret Service).

use crate::crypto::OsSecrets;
use crate::{ImportError, Keychain};

/// [`OsSecrets`] for the running OS, with the host's Keychain adapter.
pub struct SystemSecrets<'a> {
    keychain: &'a dyn Keychain,
}

impl<'a> SystemSecrets<'a> {
    pub fn new(keychain: &'a dyn Keychain) -> Self {
        Self { keychain }
    }
}

impl OsSecrets for SystemSecrets<'_> {
    fn keychain_password(&self, service: &str, account: &str) -> Result<String, ImportError> {
        self.keychain.read(service, account)
    }

    fn dpapi_unprotect(&self, data: &[u8]) -> Result<Vec<u8>, ImportError> {
        dpapi_unprotect(data)
    }

    fn secret_service_password(&self, application: &str) -> Result<Option<String>, ImportError> {
        secret_tool_lookup(application)
    }
}

/// A Keychain for hosts without one: every read is refused.
pub struct NoKeychain;

impl Keychain for NoKeychain {
    fn read(&self, _service: &str, _account: &str) -> Result<String, ImportError> {
        Err(ImportError::UnsupportedOs)
    }
}

#[cfg(windows)]
pub fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, ImportError> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let len = u32::try_from(data.len()).map_err(|_| ImportError::Decryption)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: len,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` points at `data` for the duration of the call; DPAPI
    // allocates `output` with LocalAlloc, which is copied, wiped and freed
    // below.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err(ImportError::PermissionDenied);
    }
    // SAFETY: DPAPI returned `cbData` valid bytes at `pbData`.
    let plaintext = unsafe {
        let slice = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let copy = slice.to_vec();
        slice
            .iter_mut()
            .for_each(|byte| std::ptr::write_volatile(byte, 0));
        LocalFree(output.pbData.cast());
        copy
    };
    Ok(plaintext)
}

#[cfg(not(windows))]
pub fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, ImportError> {
    Err(ImportError::UnsupportedOs)
}

/// `secret-tool` prints the secret (plus a newline on some versions) and
/// exits 0; a missing item exits non-zero with no output.
pub fn parse_secret_tool_output(success: bool, stdout: Vec<u8>) -> Option<String> {
    if !success {
        return None;
    }
    let mut text = String::from_utf8(stdout).ok()?;
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
    (!text.is_empty()).then_some(text)
}

#[cfg(target_os = "linux")]
pub fn secret_tool_lookup(application: &str) -> Result<Option<String>, ImportError> {
    let output = match std::process::Command::new("secret-tool")
        .args(["lookup", "application", application])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            log::info!("secret-tool is not installed; Chromium v11 values cannot be read");
            return Ok(None);
        }
        Err(_) => return Err(ImportError::PermissionDenied),
    };
    Ok(parse_secret_tool_output(
        output.status.success(),
        output.stdout,
    ))
}

#[cfg(not(target_os = "linux"))]
pub fn secret_tool_lookup(_application: &str) -> Result<Option<String>, ImportError> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedKeychain;

    impl Keychain for FixedKeychain {
        fn read(&self, service: &str, account: &str) -> Result<String, ImportError> {
            Ok(format!("{service}/{account}"))
        }
    }

    #[test]
    fn delegates_the_keychain_to_the_host_adapter() {
        let secrets = SystemSecrets::new(&FixedKeychain);
        assert_eq!(secrets.keychain_password("s", "a").unwrap(), "s/a");
        assert_eq!(NoKeychain.read("s", "a"), Err(ImportError::UnsupportedOs));
    }

    #[test]
    fn parses_secret_tool_output() {
        assert_eq!(
            parse_secret_tool_output(true, b"pw\n".to_vec()),
            Some("pw".into())
        );
        assert_eq!(
            parse_secret_tool_output(true, b"pw".to_vec()),
            Some("pw".into())
        );
        assert_eq!(parse_secret_tool_output(true, Vec::new()), None);
        assert_eq!(parse_secret_tool_output(false, b"pw".to_vec()), None);
        assert_eq!(parse_secret_tool_output(true, vec![0xff]), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn dpapi_is_windows_only() {
        assert_eq!(
            SystemSecrets::new(&NoKeychain).dpapi_unprotect(b"x"),
            Err(ImportError::UnsupportedOs)
        );
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_for_the_current_user() {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
        let data = b"profile-key";
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut output,
            )
        };
        assert_ne!(ok, 0);
        let wrapped =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData.cast()) };
        assert_eq!(dpapi_unprotect(&wrapped).unwrap(), data);
        assert_eq!(
            dpapi_unprotect(b"garbage"),
            Err(ImportError::PermissionDenied)
        );
    }
}
