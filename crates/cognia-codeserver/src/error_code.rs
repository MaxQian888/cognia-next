//! Stable failure codes for the Pro IDE's lifecycle.
//!
//! Every error that can reach the pane (install, start, health, open) is a
//! string whose first token is one of these codes, then `: `, then detail for
//! the log. The renderer maps the code to a translated message and a next step
//! (`lib/codeserver/error-messages.ts`); before this it printed the raw
//! English chain (`install code-server: download https://…: error sending
//! request`) to every user in every locale.
//!
//! The list is mirrored in TypeScript and kept in lockstep by
//! `pnpm audit:pro-ide-constants`.

use std::fmt::Display;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodeServerErrorCode {
    /// No prebuilt code-server for this OS/arch (Windows, exotic arches).
    UnsupportedPlatform,
    /// The release download failed (network, HTTP status, disk while streaming).
    DownloadFailed,
    /// The user cancelled the download.
    DownloadCancelled,
    /// The download did not match the pinned SHA-256.
    ChecksumMismatch,
    /// The verified archive could not be unpacked or lacks `bin/code-server`.
    ArchiveInvalid,
    /// Preparing code-server's own directories or state failed.
    InstallFailed,
    /// The project folder does not exist or is not a directory.
    RootInvalid,
    /// The child process could not be started.
    SpawnFailed,
    /// code-server started but never answered `/healthz` in time.
    HealthTimeout,
    /// No running instance serves this project.
    NotRunning,
    /// A companion host has no code-server of the pinned version preloaded.
    UpgradeRequired,
    /// The desktop's owner has not yet let this paired device into this
    /// project's workbench; an approval prompt is showing on the desktop.
    RelayGrantRequired,
}

impl CodeServerErrorCode {
    pub const ALL: [CodeServerErrorCode; 12] = [
        Self::UnsupportedPlatform,
        Self::DownloadFailed,
        Self::DownloadCancelled,
        Self::ChecksumMismatch,
        Self::ArchiveInvalid,
        Self::InstallFailed,
        Self::RootInvalid,
        Self::SpawnFailed,
        Self::HealthTimeout,
        Self::NotRunning,
        Self::UpgradeRequired,
        Self::RelayGrantRequired,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedPlatform => "CODESERVER_UNSUPPORTED_PLATFORM",
            Self::DownloadFailed => "CODESERVER_DOWNLOAD_FAILED",
            Self::DownloadCancelled => "CODESERVER_DOWNLOAD_CANCELLED",
            Self::ChecksumMismatch => "CODESERVER_CHECKSUM_MISMATCH",
            Self::ArchiveInvalid => "CODESERVER_ARCHIVE_INVALID",
            Self::InstallFailed => "CODESERVER_INSTALL_FAILED",
            Self::RootInvalid => "CODESERVER_ROOT_INVALID",
            Self::SpawnFailed => "CODESERVER_SPAWN_FAILED",
            Self::HealthTimeout => "CODESERVER_HEALTH_TIMEOUT",
            Self::NotRunning => "CODESERVER_NOT_RUNNING",
            Self::UpgradeRequired => "CODESERVER_UPGRADE_REQUIRED",
            Self::RelayGrantRequired => "CODESERVER_RELAY_GRANT_REQUIRED",
        }
    }

    /// The code `message` already leads with, if any.
    pub fn of(message: &str) -> Option<Self> {
        let head = message.split(':').next().unwrap_or(message).trim();
        Self::ALL.into_iter().find(|code| code.as_str() == head)
    }
}

/// `CODE: detail`, the shape every lifecycle failure takes.
pub fn coded(code: CodeServerErrorCode, detail: impl Display) -> String {
    format!("{}: {detail}", code.as_str())
}

/// Keep a message that already leads with a code; otherwise prefix `fallback`.
///
/// For the boundaries where an inner step may or may not have classified its
/// own failure (an `anyhow` chain from the installer, a helper shared with
/// non-lifecycle callers).
pub fn ensure_coded(message: String, fallback: CodeServerErrorCode) -> String {
    if CodeServerErrorCode::of(&message).is_some() {
        message
    } else {
        coded(fallback, message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_unique_and_namespaced() {
        let mut seen = std::collections::HashSet::new();
        for code in CodeServerErrorCode::ALL {
            assert!(code.as_str().starts_with("CODESERVER_"));
            assert!(seen.insert(code.as_str()), "{} repeats", code.as_str());
        }
    }

    #[test]
    fn a_message_is_classified_by_its_leading_code_only() {
        let message = coded(CodeServerErrorCode::HealthTimeout, "port 1: 30s");
        assert_eq!(message, "CODESERVER_HEALTH_TIMEOUT: port 1: 30s");
        assert_eq!(
            CodeServerErrorCode::of(&message),
            Some(CodeServerErrorCode::HealthTimeout)
        );
        assert_eq!(
            CodeServerErrorCode::of("CODESERVER_DOWNLOAD_CANCELLED"),
            Some(CodeServerErrorCode::DownloadCancelled)
        );
        assert_eq!(
            CodeServerErrorCode::of("download x: CODESERVER_DOWNLOAD_FAILED: y"),
            None
        );
    }

    #[test]
    fn ensure_coded_keeps_an_inner_classification() {
        assert_eq!(
            ensure_coded(
                "CODESERVER_CHECKSUM_MISMATCH: a != b".into(),
                CodeServerErrorCode::InstallFailed
            ),
            "CODESERVER_CHECKSUM_MISMATCH: a != b"
        );
        assert_eq!(
            ensure_coded("disk full".into(), CodeServerErrorCode::InstallFailed),
            "CODESERVER_INSTALL_FAILED: disk full"
        );
    }
}
