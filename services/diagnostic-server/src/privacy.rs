use regex::{bytes::Regex as BytesRegex, Regex};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyScan {
    pub redaction_version: &'static str,
    pub sanitized: Vec<u8>,
    pub removed_fields: Vec<&'static str>,
    pub rejected_credential_kind: Option<&'static str>,
}

impl PrivacyScan {
    pub fn is_rejected(&self) -> bool {
        self.rejected_credential_kind.is_some()
    }
}

#[derive(Clone)]
pub struct PrivacyGate {
    credentials: Vec<(&'static str, BytesRegex)>,
    email: Regex,
    bearer: Regex,
    file_path: Regex,
}

impl PrivacyGate {
    pub fn v1() -> Self {
        Self {
            credentials: vec![
                (
                    "private_key",
                    BytesRegex::new(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")
                        .expect("valid private key regex"),
                ),
                (
                    "aws_access_key",
                    BytesRegex::new(r"AKIA[0-9A-Z]{16}").expect("valid AWS key regex"),
                ),
                (
                    "provider_secret",
                    BytesRegex::new(r"(?:sk|rk|ghp)_[A-Za-z0-9_-]{24,}")
                        .expect("valid provider secret regex"),
                ),
                (
                    "jwt",
                    BytesRegex::new(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
                        .expect("valid JWT regex"),
                ),
            ],
            email: Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
                .expect("valid email regex"),
            bearer: Regex::new(r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]{8,}").expect("valid bearer regex"),
            file_path: Regex::new(r#"(?:/Users|/home)/[^\s"']+"#).expect("valid path regex"),
        }
    }

    pub fn scan(&self, input: &[u8]) -> PrivacyScan {
        for (kind, pattern) in &self.credentials {
            if pattern.is_match(input) {
                return PrivacyScan {
                    redaction_version: "server-v1",
                    sanitized: Vec::new(),
                    removed_fields: Vec::new(),
                    rejected_credential_kind: Some(kind),
                };
            }
        }

        let Ok(text) = std::str::from_utf8(input) else {
            return PrivacyScan {
                redaction_version: "server-v1",
                sanitized: input.to_vec(),
                removed_fields: Vec::new(),
                rejected_credential_kind: None,
            };
        };
        let mut removed_fields = Vec::new();
        let mut sanitized = text.to_owned();
        if self.bearer.is_match(&sanitized) {
            sanitized = self
                .bearer
                .replace_all(&sanitized, "Bearer [REDACTED]")
                .into_owned();
            removed_fields.push("authorization");
        }
        if self.email.is_match(&sanitized) {
            sanitized = self
                .email
                .replace_all(&sanitized, "[REDACTED_EMAIL]")
                .into_owned();
            removed_fields.push("email");
        }
        if self.file_path.is_match(&sanitized) {
            sanitized = self
                .file_path
                .replace_all(&sanitized, "[REDACTED_PATH]")
                .into_owned();
            removed_fields.push("file_path");
        }
        PrivacyScan {
            redaction_version: "server-v1",
            sanitized: sanitized.into_bytes(),
            removed_fields,
            rejected_credential_kind: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_credentials_without_returning_original_bytes() {
        let scan = PrivacyGate::v1().scan(b"token=sk_abcdefghijklmnopqrstuvwxyz012345");
        assert!(scan.is_rejected());
        assert_eq!(scan.rejected_credential_kind, Some("provider_secret"));
        assert!(scan.sanitized.is_empty());
    }

    #[test]
    fn re_redacts_ordinary_pii_before_storage() {
        let scan = PrivacyGate::v1()
            .scan(b"email me@example.com file /Users/alice/private.txt Bearer abcdefghijklmnop");
        let output = String::from_utf8(scan.sanitized).unwrap();
        assert_eq!(
            output,
            "email [REDACTED_EMAIL] file [REDACTED_PATH] Bearer [REDACTED]"
        );
        assert_eq!(scan.removed_fields, ["authorization", "email", "file_path"]);
    }

    #[test]
    fn preserves_non_text_artifacts_after_credential_scan() {
        let input = [0xff, 0x00, 0x01];
        let scan = PrivacyGate::v1().scan(&input);
        assert_eq!(scan.sanitized, input);
        assert!(!scan.is_rejected());
    }
}
