use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_ATTACHMENTS: usize = 20;
pub const MAX_EVENTS: usize = 50_000;
pub const MAX_INCIDENT_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_MINIDUMP_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "incident_state", rename_all = "snake_case")]
pub enum IncidentState {
    Detected,
    Packaged,
    AwaitingConsent,
    Queued,
    Uploading,
    Processing,
    Accepted,
    Rejected,
    Cancelled,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncidentTransition {
    PackageCreated,
    ConsentRequired,
    ConsentGranted,
    UploadStarted,
    UploadCompleted,
    Accepted,
    Rejected,
    Cancelled,
    Deleted,
}

impl IncidentState {
    pub fn transition(self, transition: IncidentTransition) -> Result<Self, &'static str> {
        use IncidentState as S;
        use IncidentTransition as T;
        match (self, transition) {
            (S::Detected, T::PackageCreated) => Ok(S::Packaged),
            (S::Packaged, T::ConsentRequired) => Ok(S::AwaitingConsent),
            (S::AwaitingConsent, T::ConsentGranted) => Ok(S::Queued),
            (S::Queued, T::UploadStarted) => Ok(S::Uploading),
            (S::Uploading, T::UploadCompleted) => Ok(S::Processing),
            (S::Processing, T::Accepted) => Ok(S::Accepted),
            (S::Processing, T::Rejected) => Ok(S::Rejected),
            (S::AwaitingConsent | S::Queued | S::Uploading, T::Cancelled) => Ok(S::Cancelled),
            (S::Deleted, _) => Err("deleted incidents are terminal"),
            (_, T::Deleted) => Ok(S::Deleted),
            _ => Err("invalid incident transition"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "processing_state", rename_all = "snake_case")]
pub enum ProcessingState {
    Received,
    Scanning,
    Symbolicating,
    Grouping,
    Accepted,
    RetryableFailure,
    PermanentFailure,
    Deleted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IncidentLimits {
    pub attachment_count: usize,
    pub event_count: usize,
    pub total_bytes: u64,
    pub largest_attachment_bytes: u64,
    pub largest_minidump_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitViolation {
    TooManyAttachments,
    TooManyEvents,
    IncidentTooLarge,
    AttachmentTooLarge,
    MinidumpTooLarge,
}

impl IncidentLimits {
    pub fn validate(self) -> Result<(), LimitViolation> {
        if self.attachment_count > MAX_ATTACHMENTS {
            return Err(LimitViolation::TooManyAttachments);
        }
        if self.event_count > MAX_EVENTS {
            return Err(LimitViolation::TooManyEvents);
        }
        if self.total_bytes > MAX_INCIDENT_BYTES {
            return Err(LimitViolation::IncidentTooLarge);
        }
        if self.largest_attachment_bytes > MAX_ATTACHMENT_BYTES {
            return Err(LimitViolation::AttachmentTooLarge);
        }
        if self.largest_minidump_bytes > MAX_MINIDUMP_BYTES {
            return Err(LimitViolation::MinidumpTooLarge);
        }
        Ok(())
    }
}

/// Versioned deterministic grouping key. Empty/unstable frames are removed,
/// and only the first five symbolized frames contribute to the fingerprint.
pub fn fingerprint_incident(
    platform: &str,
    exception: &str,
    build_family: &str,
    module: &str,
    symbolized_frames: &[String],
) -> String {
    let mut normalized = vec![
        "fingerprint-v1".to_string(),
        platform.trim().to_lowercase(),
        exception.trim().to_lowercase(),
        build_family.trim().to_lowercase(),
        module.trim().to_lowercase(),
    ];
    normalized.extend(
        symbolized_frames
            .iter()
            .map(|frame| frame.trim().to_lowercase())
            .filter(|frame| !frame.is_empty())
            .take(5),
    );
    let digest = Sha256::digest(normalized.join("\n").as_bytes());
    format!("fp1:{}", hex::encode(digest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_requires_consent_before_upload() {
        assert_eq!(
            IncidentState::Detected.transition(IncidentTransition::UploadStarted),
            Err("invalid incident transition")
        );
        let accepted = [
            IncidentTransition::PackageCreated,
            IncidentTransition::ConsentRequired,
            IncidentTransition::ConsentGranted,
            IncidentTransition::UploadStarted,
            IncidentTransition::UploadCompleted,
            IncidentTransition::Accepted,
        ]
        .into_iter()
        .try_fold(IncidentState::Detected, IncidentState::transition)
        .unwrap();
        assert_eq!(accepted, IncidentState::Accepted);
    }

    #[test]
    fn limits_match_the_public_contract() {
        let valid = IncidentLimits {
            attachment_count: 20,
            event_count: 50_000,
            total_bytes: MAX_INCIDENT_BYTES,
            largest_attachment_bytes: MAX_ATTACHMENT_BYTES,
            largest_minidump_bytes: MAX_MINIDUMP_BYTES,
        };
        assert_eq!(valid.validate(), Ok(()));
        assert_eq!(
            IncidentLimits {
                attachment_count: 21,
                ..valid
            }
            .validate(),
            Err(LimitViolation::TooManyAttachments)
        );
    }

    #[test]
    fn fingerprint_is_stable_and_uses_only_five_frames() {
        let first = fingerprint_incident(
            "Windows",
            "AccessViolation",
            "0.1.x",
            "renderer",
            &[" A ", "B", "C", "D", "E", "ignored"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        );
        let second = fingerprint_incident(
            "windows",
            "accessviolation",
            "0.1.x",
            "renderer",
            &["a", "b", "c", "d", "e", "different"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        );
        assert_eq!(first, second);
        assert!(first.starts_with("fp1:"));
    }
}
