//! Shared transport header policy (ADR-0090 Phase 1).
//!
//! Rust mirror of `packages/provider-types/src/transport-header-policy.ts`.
//! Both implementations iterate the SAME fixture
//! (`packages/provider-types/fixtures/header-policy-cases.json`) in their
//! test suites, so verdicts can never drift. Reason codes are stable strings
//! shared with the TS side (they key i18n messages).

/// Where a header comes from when validated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderContext {
    /// A TransportProfile `staticHeaders` entry (name + value).
    Static,
    /// A forwarded inbound header (name only; value re-checked at proxy time).
    Forward,
}

/// Stable policy reason codes (mirrors the TS `HeaderPolicyReason` union).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderPolicyReason {
    Ok,
    InvalidName,
    InvalidValue,
    AuthHeader,
    HopByHop,
    HostHeader,
    ContentFraming,
    CookieHeader,
    BrowserForwarding,
    InternalHeader,
}

impl HeaderPolicyReason {
    /// The wire/i18n code, byte-identical to the TS side.
    pub fn code(self) -> &'static str {
        match self {
            HeaderPolicyReason::Ok => "ok",
            HeaderPolicyReason::InvalidName => "invalid-name",
            HeaderPolicyReason::InvalidValue => "invalid-value",
            HeaderPolicyReason::AuthHeader => "auth-header",
            HeaderPolicyReason::HopByHop => "hop-by-hop",
            HeaderPolicyReason::HostHeader => "host-header",
            HeaderPolicyReason::ContentFraming => "content-framing",
            HeaderPolicyReason::CookieHeader => "cookie-header",
            HeaderPolicyReason::BrowserForwarding => "browser-forwarding",
            HeaderPolicyReason::InternalHeader => "internal-header",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeaderVerdict {
    pub allowed: bool,
    pub reason: HeaderPolicyReason,
}

const AUTH_HEADERS: [&str; 4] = [
    "authorization",
    "x-api-key",
    "proxy-authorization",
    "proxy-authenticate",
];

const HOP_BY_HOP_HEADERS: [&str; 6] = [
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
];

const COOKIE_HEADERS: [&str; 2] = ["cookie", "set-cookie"];

const BROWSER_FORWARDING_HEADERS: [&str; 3] = ["origin", "referer", "forwarded"];
const BROWSER_FORWARDING_PREFIXES: [&str; 2] = ["x-forwarded-", "sec-"];

const INTERNAL_PREFIXES: [&str; 1] = ["x-cognia-"];

/// Semantic headers forwarded by default on same-protocol routes (Phase 2).
pub const SEMANTIC_FORWARD_PREFIXES: [&str; 3] = ["anthropic-", "x-claude-code-", "x-stainless-"];
pub const SEMANTIC_FORWARD_HEADERS: [&str; 1] = ["x-app"];

fn is_token_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            matches!(b,
                b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.'
                | b'^' | b'_' | b'`' | b'|' | b'~'
                | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z')
        })
}

fn classify_name(name: &str) -> HeaderPolicyReason {
    if !is_token_name(name) {
        return HeaderPolicyReason::InvalidName;
    }
    let lower = name.to_ascii_lowercase();
    let lower = lower.as_str();
    if AUTH_HEADERS.contains(&lower) {
        return HeaderPolicyReason::AuthHeader;
    }
    if HOP_BY_HOP_HEADERS.contains(&lower) {
        return HeaderPolicyReason::HopByHop;
    }
    if lower == "host" {
        return HeaderPolicyReason::HostHeader;
    }
    if lower == "content-length" {
        return HeaderPolicyReason::ContentFraming;
    }
    if COOKIE_HEADERS.contains(&lower) {
        return HeaderPolicyReason::CookieHeader;
    }
    if BROWSER_FORWARDING_HEADERS.contains(&lower)
        || BROWSER_FORWARDING_PREFIXES
            .iter()
            .any(|p| lower.starts_with(p))
    {
        return HeaderPolicyReason::BrowserForwarding;
    }
    if INTERNAL_PREFIXES.iter().any(|p| lower.starts_with(p)) {
        return HeaderPolicyReason::InternalHeader;
    }
    HeaderPolicyReason::Ok
}

fn has_illegal_value_bytes(value: &str) -> bool {
    value.bytes().any(|b| matches!(b, b'\r' | b'\n' | 0))
}

/// Validate one header for the given context (TS `checkHeader` mirror).
pub fn check_header(name: &str, value: Option<&str>, context: HeaderContext) -> HeaderVerdict {
    let name_reason = classify_name(name);
    if name_reason != HeaderPolicyReason::Ok {
        return HeaderVerdict {
            allowed: false,
            reason: name_reason,
        };
    }
    if context == HeaderContext::Static {
        match value {
            Some(v) if !has_illegal_value_bytes(v) => {}
            _ => {
                return HeaderVerdict {
                    allowed: false,
                    reason: HeaderPolicyReason::InvalidValue,
                }
            }
        }
    }
    HeaderVerdict {
        allowed: true,
        reason: HeaderPolicyReason::Ok,
    }
}

/// Whether an inbound header is on the built-in semantic forwarding
/// allowlist (TS `isForwardableSemanticHeader` mirror).
pub fn is_forwardable_semantic_header(name: &str) -> bool {
    if classify_name(name) != HeaderPolicyReason::Ok {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    let lower = lower.as_str();
    SEMANTIC_FORWARD_HEADERS.contains(&lower)
        || SEMANTIC_FORWARD_PREFIXES
            .iter()
            .any(|p| lower.starts_with(p))
}

/// Validate a static header map; returns `(name, reason-code)` violations.
pub fn validate_static_headers<'a, I>(headers: I) -> Vec<(String, &'static str)>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    headers
        .into_iter()
        .filter_map(|(name, value)| {
            let verdict = check_header(name, Some(value), HeaderContext::Static);
            if verdict.allowed {
                None
            } else {
                Some((name.to_string(), verdict.reason.code()))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Fixture {
        version: u32,
        cases: Vec<Case>,
        #[serde(rename = "semanticForwardCases")]
        semantic_forward_cases: Vec<SemanticCase>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        value: Option<String>,
        context: String,
        allowed: bool,
        reason: String,
    }

    #[derive(Deserialize)]
    struct SemanticCase {
        name: String,
        semantic: bool,
    }

    fn load_fixture() -> Fixture {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/provider-types/fixtures/header-policy-cases.json"
        );
        let raw = std::fs::read_to_string(path).expect("shared header-policy fixture must exist");
        serde_json::from_str(&raw).expect("fixture must parse")
    }

    #[test]
    fn fixture_parity_with_typescript() {
        let fixture = load_fixture();
        assert_eq!(fixture.version, 1, "bump both implementations together");
        for case in &fixture.cases {
            let context = match case.context.as_str() {
                "static" => HeaderContext::Static,
                "forward" => HeaderContext::Forward,
                other => panic!("unknown context {other}"),
            };
            let verdict = check_header(&case.name, case.value.as_deref(), context);
            assert_eq!(
                verdict.allowed, case.allowed,
                "allowed mismatch for {} ({})",
                case.name, case.context
            );
            assert_eq!(
                verdict.reason.code(),
                case.reason,
                "reason mismatch for {} ({})",
                case.name,
                case.context
            );
        }
    }

    #[test]
    fn semantic_forwarding_parity_with_typescript() {
        let fixture = load_fixture();
        for case in &fixture.semantic_forward_cases {
            assert_eq!(
                is_forwardable_semantic_header(&case.name),
                case.semantic,
                "semantic mismatch for {}",
                case.name
            );
        }
    }

    #[test]
    fn validate_static_headers_collects_reason_codes() {
        let violations = validate_static_headers([
            ("authorization", "Bearer sk"),
            ("x-good", "ok"),
            ("x-cognia-run", "1"),
        ]);
        assert_eq!(
            violations,
            vec![
                ("authorization".to_string(), "auth-header"),
                ("x-cognia-run".to_string(), "internal-header"),
            ]
        );
    }
}
