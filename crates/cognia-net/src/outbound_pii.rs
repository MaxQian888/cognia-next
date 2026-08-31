//! Native outbound PII gate shared by host-side network transports.
//!
//! This mirrors the leak-detection half of `@cognia/redact` so callers that
//! bypass the renderer still cannot send recognized PII to a cloud service.

use std::sync::OnceLock;

use regex::Regex;

fn sensitive_pattern() -> &'static Regex {
    static SENSITIVE: OnceLock<Regex> = OnceLock::new();
    SENSITIVE.get_or_init(|| {
        Regex::new(concat!(
            r"(?i)(?:",
            r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}",
            r"|\b\d{3}-\d{2}-\d{4}\b",
            r"|\b\d{17}[0-9x]\b",
            r"|\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{16,}|ghp_[a-z0-9]{20,}|gho_[a-z0-9]{20,}|ghs_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|aiza[a-z0-9_-]{20,}|akia[a-z0-9]{16})\b",
            r"|\beyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b",
            r"|-----begin (?:[a-z0-9]+ )*private key-----",
            r#"|\b(?:aws[_-]?secret[_-]?access[_-]?key|aws[_-]?secret|secret[_-]?access[_-]?key|api[_-]?key|apikey|secret|token|bearer|password)\b\s*[:=]\s*["']?[^\s"']{20,}"#,
            r"|\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s:/@]+@",
            r"|\b(?:[a-z]{1,2}\d{7,8}|e\d{8}|g\d{8}|eh\d{7}|ej\d{7})\b",
            r"|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b",
            r"|\b(?:[0-9a-f]{1,4}:){2,}:(?:[0-9a-f]{1,4}:?)*[0-9a-f]{1,4}\b",
            r")"
        ))
        .expect("static outbound PII regex")
    })
}

fn ipv4_pattern() -> &'static Regex {
    static IPV4: OnceLock<Regex> = OnceLock::new();
    IPV4.get_or_init(|| {
        Regex::new(r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b")
            .expect("static IPv4 regex")
    })
}

fn bank_card_pattern() -> &'static Regex {
    static BANK_CARD: OnceLock<Regex> = OnceLock::new();
    BANK_CARD
        .get_or_init(|| Regex::new(r"\b\d(?:[ -]?\d){12,18}\b").expect("static bank-card regex"))
}

fn phone_pattern() -> &'static Regex {
    static PHONE: OnceLock<Regex> = OnceLock::new();
    PHONE.get_or_init(|| {
        Regex::new(r"\b(?:\+\d{1,3}[ -]?)?(?:1\d{10}|\d{3}[ -]?\d{3,4}[ -]?\d{4}|\d{10,11})\b")
            .expect("static phone regex")
    })
}

fn driver_license_pattern() -> &'static Regex {
    static DRIVER_LICENSE: OnceLock<Regex> = OnceLock::new();
    DRIVER_LICENSE.get_or_init(|| {
        Regex::new(r"(?i)(?:driver[_\s-]?license|driver[_\s-]?lic|dl[\s#]?|driving[_\s-]?license|驾驶证|驾照)[^\d]{0,20}\d{12}")
            .expect("static driver-license regex")
    })
}

fn is_likely_public_ipv4(value: &str) -> bool {
    let parts = value
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(parts) = parts else { return false };
    let [a, b, _, _] = parts.as_slice() else {
        return false;
    };
    !(*a == 0
        || *a == 10
        || *a == 127
        || *a == 255
        || (*a == 169 && *b == 254)
        || (*a == 172 && (16..=31).contains(b))
        || (*a == 192 && *b == 168))
}

fn passes_luhn(value: &str) -> bool {
    let mut sum = 0_u32;
    let mut alternate = false;
    for byte in value.bytes().rev().filter(u8::is_ascii_digit) {
        let mut digit = u32::from(byte - b'0');
        if alternate {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
        alternate = !alternate;
    }
    sum.is_multiple_of(10)
}

/// Return `true` only when no recognized PII shape remains in `text`.
pub fn has_no_leaking_pii(text: &str) -> bool {
    if sensitive_pattern().is_match(text)
        || phone_pattern().is_match(text)
        || driver_license_pattern().is_match(text)
    {
        return false;
    }
    if ipv4_pattern()
        .find_iter(text)
        .any(|value| is_likely_public_ipv4(value.as_str()))
    {
        return false;
    }
    !bank_card_pattern()
        .find_iter(text)
        .any(|value| passes_luhn(value.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_recognized_pii_shapes() {
        for value in [
            "Speak to user@example.com",
            "SSN 123-45-6789",
            "card 4111 1111 1111 1111",
            "connect to 8.8.8.8",
            "token: abcdefghijklmnopqrstuvwxyz1234",
            "call 13812345678 now",
            "driver license: 123456789012",
        ] {
            assert!(!has_no_leaking_pii(value), "allowed {value}");
        }
    }

    #[test]
    fn allows_benign_text_and_private_addresses() {
        assert!(has_no_leaking_pii("Read the release notes aloud"));
        assert!(has_no_leaking_pii(
            "Local endpoint 127.0.0.1 or 192.168.1.2"
        ));
        assert!(has_no_leaking_pii("order 1234 5678 9012 3456"));
    }
}
