//! `cognia:plugin/clipboard` host import.
//!
//! Served in-process by the host's native clipboard plugin — no renderer round
//! trip. Clipboard contents are never logged, in full or in part.

use super::super::errors::{coded, WasmErrorCode};
use super::super::store::HostState;
use super::require;

/// Cap on a single `write-text`. Stricter than the bridge's generic envelope
/// limit and enforced before the native surface is touched at all.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;

pub fn check_read(state: &HostState) -> Result<(), String> {
    require(state, "clipboard:read")
}

pub fn check_write(state: &HostState) -> Result<(), String> {
    require(state, "clipboard:write")
}

/// Bound the payload before it reaches the OS clipboard. The error names only
/// the length — never any part of the value.
pub fn validate_write(value: &str) -> Result<(), String> {
    if value.len() > MAX_TEXT_BYTES {
        return Err(coded(
            WasmErrorCode::PayloadTooLarge,
            format!(
                "clipboard.write-text: value is {} bytes, over the {MAX_TEXT_BYTES} byte limit",
                value.len()
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::store::test_host_state;
    use super::*;

    fn st(caps: &[&str]) -> HostState {
        test_host_state("demo", caps)
    }

    #[test]
    fn read_and_write_caps_are_independent() {
        assert!(check_read(&st(&["clipboard:read"])).is_ok());
        assert!(check_write(&st(&["clipboard:read"])).is_err());
        assert!(check_read(&st(&["clipboard:write"])).is_err());
        assert!(check_write(&st(&["clipboard:write"])).is_ok());
    }

    #[test]
    fn denials_carry_the_capability_denied_code() {
        let err = check_read(&st(&[])).unwrap_err();
        assert!(err.starts_with("CAPABILITY_DENIED: "));
        assert!(err.contains("clipboard:read"));
    }

    #[test]
    fn validate_write_caps_the_payload_without_echoing_it() {
        assert!(validate_write("short").is_ok());
        assert!(validate_write(&"x".repeat(MAX_TEXT_BYTES)).is_ok());

        let secret = "TOPSECRET".repeat(MAX_TEXT_BYTES);
        let err = validate_write(&secret).unwrap_err();
        assert!(err.starts_with("PAYLOAD_TOO_LARGE: "));
        assert!(
            !err.contains("TOPSECRET"),
            "clipboard contents must never appear in an error: {err}"
        );
    }
}
