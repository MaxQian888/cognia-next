//! Native outbound PII gate shared by host-side network transports.
//!
//! This mirrors the leak-detection half of `@cognia/redact` so callers that
//! bypass the renderer still cannot send recognized PII to a cloud service.
//!
//! Only the kinds that FAIL `hasNoLeakingPii` on the TypeScript side are
//! mirrored here. `CREDENTIAL_PATH` (`~/.ssh/…`, `.aws`, `.kube`, …) is
//! redact-only in `@cognia/redact` — naming a path leaks no secret — so it is
//! deliberately absent from this gate. Like the TS gate, [`has_no_leaking_pii`]
//! scans the raw text and then the [`normalize_for_redaction`] view, so a
//! secret split by a terminal escape or reordered by a bidi override is still
//! caught.

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
            r"|\b(?:sk-(?:ant-|proj-)?[a-z0-9_-]{16,}|[sr]k_(?:live|test)_[a-z0-9]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[abprs]-[a-z0-9-]{10,}|xapp-[a-z0-9-]{10,}|aiza[a-z0-9_-]{20,}|akia[a-z0-9]{16})\b",
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

/// Case-sensitive secret prefixes. Kept apart from [`sensitive_pattern`]
/// (which is `(?i)`) because their false-positive guards depend on case:
/// AWS `ASIA…` temporary keys (vs. "ASIAN markets"), Meta `EAA…` tokens and
/// Telegram bot tokens `<bot id>:<35-char secret>` (the fixed secret length
/// keeps `12:34` times and `ts:<sha1>` pairs out).
fn case_sensitive_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"\b(?:ASIA[A-Z0-9]{16}|EAA[A-Za-z0-9]{20,}|\d{6,10}:(?:AA[A-Za-z0-9_-]{30,}|[A-Za-z0-9_-]{34,35}))\b",
        )
        .expect("static case-sensitive secret regex")
    })
}

/// Google OAuth refresh tokens `1//…`. The TS pattern is
/// `\b(?<![.:/])1\/\/…`; the `regex` crate has no lookbehind, so the
/// preceding char is matched explicitly: start of text, or a char that is
/// neither an (ASCII) word char — the `\b` — nor `.` `:` `/`. That keeps
/// `http://10.0.0.1//long_path_segment` from reading as a token.
fn google_oauth_refresh_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?:^|[^A-Za-z0-9_.:/])1//[0-9A-Za-z_-]{20,}\b")
            .expect("static Google OAuth refresh regex")
    })
}

/// `Bearer <token>` (whitespace form). Group 1 is the token, which must also
/// pass [`is_token_like`]. The `bearer: …` / `bearer=…` form stays with the
/// hinted-secret alternative in [`sensitive_pattern`].
fn bearer_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\bbearer\s+([A-Za-z0-9._~+/=-]{16,})").expect("static bearer regex")
    })
}

/// Env-style secret assignments. Group 2 is the value, which must pass
/// [`is_redactable_env_value`]. Case-sensitive on purpose: the upper-case
/// env convention separates `OPENAI_API_KEY=…` from `cache_key = …` code.
fn env_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(concat!(
            r"\b((?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|VOYAGE_API_KEY|MISTRAL_API_KEY|GROQ_API_KEY|DEEPSEEK_API_KEY|HF_TOKEN|HUGGINGFACE_TOKEN|AWS_(?:SECRET_)?ACCESS_KEY[A-Z_]*|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|GOOGLE_API_KEY|GEMINI_API_KEY|OLLAMA_API_KEY)",
            r"|[A-Z][A-Z0-9_]*_(?:PRIVATE_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|CREDENTIAL))",
            r#""?\s*[=:]\s*["']?([^\s"']+)"#,
        ))
        .expect("static env-secret regex")
    })
}

/// Values that point at a secret instead of containing one (`$VAR`,
/// `${{ secrets.X }}`, `process.env.X`, …).
fn env_reference_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^(?:\$|%|\{\{|process\.env\b|import\.meta\.env\b|os\.environ\b|os\.getenv\b|getenv\(|env\()")
            .expect("static env-reference regex")
    })
}

/// One `@cognia/redact` placeholder (`PII_PLACEHOLDER_SOURCE`).
fn placeholder_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"<(?:EMAIL|PHONE|ID_CARD|BANK_CARD|NAME|IP|API_KEY|JWT|PEM_KEY|PASSPORT|DRIVER_LICENSE|CREDENTIAL_PATH)_\d{3,}>")
            .expect("static placeholder regex")
    })
}

/// Terminal escape sequences (CSI, OSC, two-char forms), removed whole.
fn escape_sequence_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
            .expect("static escape-sequence regex")
    })
}

/// C0/C1 controls except tab / LF / CR, DEL, and bidi embedding / override /
/// isolate chars (U+202A–202E, U+2066–2069).
fn stripped_control_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x{9F}\x{202A}-\x{202E}\x{2066}-\x{2069}]")
            .expect("static control-char regex")
    })
}

/// Mirror of `normalizeForRedaction` in `@cognia/redact`: drop terminal escape
/// sequences, C0/C1 controls (keeping `\t` `\n` `\r`) and bidi overrides.
pub fn normalize_for_redaction(text: &str) -> String {
    let without_escapes = escape_sequence_pattern().replace_all(text, "");
    stripped_control_pattern()
        .replace_all(&without_escapes, "")
        .into_owned()
}

/// A `Bearer` operand looks like a credential (a digit, or an upper-case
/// letter past the first char) rather than an English word.
fn is_token_like(token: &str) -> bool {
    token.bytes().any(|b| b.is_ascii_digit())
        || token.bytes().skip(1).any(|b| b.is_ascii_uppercase())
}

fn is_redactable_env_value(value: &str) -> bool {
    value.chars().count() >= 8
        && !placeholder_pattern().is_match(value)
        && !env_reference_pattern().is_match(value)
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

/// Return `true` only when no recognized PII shape remains in `text`, in
/// either the raw text or its [`normalize_for_redaction`] view.
pub fn has_no_leaking_pii(text: &str) -> bool {
    if !scan_is_clean(text) {
        return false;
    }
    let normalized = normalize_for_redaction(text);
    normalized == text || scan_is_clean(&normalized)
}

fn scan_is_clean(text: &str) -> bool {
    if sensitive_pattern().is_match(text)
        || case_sensitive_secret_pattern().is_match(text)
        || google_oauth_refresh_pattern().is_match(text)
        || phone_pattern().is_match(text)
        || driver_license_pattern().is_match(text)
    {
        return false;
    }
    if bearer_pattern()
        .captures_iter(text)
        .any(|caps| caps.get(1).is_some_and(|m| is_token_like(m.as_str())))
    {
        return false;
    }
    if env_secret_pattern().captures_iter(text).any(|caps| {
        caps.get(2)
            .is_some_and(|m| is_redactable_env_value(m.as_str()))
    }) {
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

    fn alnum(n: usize) -> String {
        "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0zC".repeat(4)[..n].to_string()
    }

    #[test]
    fn blocks_stripe_live_and_test_keys_but_not_sk_identifiers() {
        for prefix in ["sk_live_", "rk_live_", "sk_test_", "rk_test_"] {
            let text = format!("stripe {prefix}{}", alnum(24));
            assert!(!has_no_leaking_pii(&text), "allowed {text}");
        }
        assert!(has_no_leaking_pii(
            "const sk_live_connection_pool_size = sk_user_id + sk_live_mode"
        ));
    }

    #[test]
    fn blocks_github_token_family() {
        for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
            let text = format!("token {prefix}{}", alnum(36));
            assert!(!has_no_leaking_pii(&text), "allowed {text}");
        }
        assert!(has_no_leaking_pii("helper ghu_short and ghr_tmp"));
    }

    #[test]
    fn blocks_aws_asia_but_not_asia_prose() {
        assert!(!has_no_leaking_pii("id ASIAQ7RT2WXYZ3ABCDEF"));
        assert!(!has_no_leaking_pii("id AKIAIOSFODNN7EXAMPLE"));
        assert!(has_no_leaking_pii("ASIA PACIFIC region and ASIAN markets"));
    }

    #[test]
    fn blocks_google_oauth_refresh_but_not_comments_or_urls() {
        let token = format!("1//0g{}", alnum(40));
        assert!(!has_no_leaking_pii(&format!("refresh {token}")));
        assert!(!has_no_leaking_pii(&token));
        assert!(has_no_leaking_pii("x = 1//comment"));
        assert!(has_no_leaking_pii(
            "x = 1// a long trailing comment with spaces in it"
        ));
        assert!(has_no_leaking_pii(
            "see http://10.0.0.1//long_path_segment_value_here"
        ));
        assert!(has_no_leaking_pii(
            "see host:1//long_path_segment_value_here"
        ));
        assert!(has_no_leaking_pii("see a/1//long_path_segment_value_here"));
    }

    #[test]
    fn blocks_meta_eaa_but_not_short_eaa_prose() {
        assert!(!has_no_leaking_pii(&format!("fb EAAB{}", alnum(40))));
        assert!(has_no_leaking_pii("The EAAB meeting and EAACCESS notes"));
    }

    #[test]
    fn blocks_telegram_bot_tokens_but_not_times_or_ts_hash() {
        assert!(!has_no_leaking_pii(&format!(
            "bot 123456789:AA{}",
            alnum(33)
        )));
        assert!(has_no_leaking_pii("meet at 12:34 or 09:15:00"));
        // A 40-char sha1 after a unix timestamp is not the fixed 34/35-char
        // secret. (The bare 10-digit timestamp still trips the phone
        // detector, which — unlike the TS gate — this gate blocks on.)
        let ts_hash = "1700000000:da39a3ee5e6b4b0d3255bfef95601890afd80709";
        assert!(!case_sensitive_secret_pattern().is_match(ts_hash));
        assert!(phone_pattern().is_match(ts_hash));
    }

    #[test]
    fn blocks_slack_app_tokens_but_not_xapp_words() {
        assert!(!has_no_leaking_pii(&format!(
            "slack xapp-1-A0123456789-{}",
            alnum(20)
        )));
        assert!(has_no_leaking_pii("the xapp-config file"));
    }

    #[test]
    fn blocks_bearer_tokens_but_not_prose_or_short_operands() {
        let token = format!("{}.{}", alnum(20), alnum(12));
        assert!(!has_no_leaking_pii(&format!(
            "Authorization: Bearer {token}"
        )));
        assert!(!has_no_leaking_pii(&format!(
            "authorization: bearer\t{}",
            alnum(24)
        )));
        assert!(has_no_leaking_pii(
            "Use bearer authentication for the Bearer authorization scheme"
        ));
        assert!(has_no_leaking_pii("Bearer abc123"));
        assert!(has_no_leaking_pii("Bearer <API_KEY_001>"));
    }

    #[test]
    fn blocks_env_secret_assignments() {
        for text in [
            "DB_PASSWORD=hunter22hunter",
            r#"export STRIPE_WEBHOOK_SECRET="whsec_abcdef12""#,
            "HF_TOKEN: hf_abcdefgh",
            "AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI/K7MDENG",
            "SERVICE_CREDENTIALS='c0rrect-horse'",
            r#"{"MY_APP_PRIVATE_KEY": "shortkey1"}"#,
            "AWS_ACCESS_KEY_ID=notAkiaShaped1",
        ] {
            assert!(!has_no_leaking_pii(text), "allowed {text}");
        }
    }

    #[test]
    fn allows_short_env_values_references_and_code() {
        for text in [
            "FOO_KEY=1\nMAX_TOKEN=4096\nAPP_SECRET=short",
            "OPENAI_API_KEY=$OPENAI_API_KEY_FROM_VAULT",
            "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
            "const API_KEY = process.env.API_KEY",
            "cache_key = build_cache_key(user)",
            "OPENAI_API_KEY=<API_KEY_001>",
        ] {
            assert!(has_no_leaking_pii(text), "blocked {text}");
        }
    }

    #[test]
    fn credential_paths_are_not_blocking() {
        assert!(has_no_leaking_pii("how do I set up ~/.ssh/config?"));
        assert!(has_no_leaking_pii("cat ~/.ssh/id_ed25519"));
    }

    #[test]
    fn normalize_strips_escapes_controls_and_bidi() {
        let text = "\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}ok\u{1b}]8;;x\u{1b}\\ a\u{0}b\u{202E}c\u{2066}d\u{2069}";
        assert_eq!(normalize_for_redaction(text), "red ok abcd");
        let plain = "a\tb\nc\r\n张伟 — café ✓";
        assert_eq!(normalize_for_redaction(plain), plain);
    }

    #[test]
    fn gate_sees_secrets_split_by_escapes_or_controls() {
        assert!(!has_no_leaking_pii(
            "sk-proj-abcdefgh\u{1b}[0mijklmnop12345678"
        ));
        assert!(!has_no_leaking_pii("ghp_abcdefghij\u{202E}klmnopqrst1234"));
        assert!(has_no_leaking_pii("\u{1b}[32mPASS\u{1b}[0m 12 tests"));
    }
}
