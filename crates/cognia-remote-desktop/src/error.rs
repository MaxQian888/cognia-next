//! Typed refusals. Each carries a stable `remote_desktop_*` code the renderer
//! maps to a message; the optional detail is safe to show (never a password,
//! never a host the caller did not supply).

use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteDesktopError {
    pub code: &'static str,
    pub detail: Option<String>,
}

pub type Result<T> = std::result::Result<T, RemoteDesktopError>;

impl RemoteDesktopError {
    pub fn new(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    pub fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        let mut detail = detail.into();
        // Server-supplied reasons are untrusted; keep them short and printable.
        detail.retain(|c| !c.is_control());
        if detail.chars().count() > 300 {
            detail = detail.chars().take(300).collect::<String>() + "…";
        }
        Self {
            code,
            detail: Some(detail),
        }
    }
}

impl fmt::Display for RemoteDesktopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.detail {
            Some(detail) => write!(f, "{}: {}", self.code, detail),
            None => f.write_str(self.code),
        }
    }
}

impl std::error::Error for RemoteDesktopError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_is_bounded_and_stripped_of_control_characters() {
        let error = RemoteDesktopError::with_detail("remote_desktop_auth_failed", "bad\u{7}\npassword");
        assert_eq!(error.to_string(), "remote_desktop_auth_failed: badpassword");
        let long = RemoteDesktopError::with_detail("remote_desktop_auth_failed", "x".repeat(500));
        assert_eq!(long.detail.unwrap().chars().count(), 301);
        assert_eq!(
            RemoteDesktopError::new("remote_desktop_busy").to_string(),
            "remote_desktop_busy"
        );
    }
}
