// Volcengine (火山方舟) Agent Plan / Coding Plan usage query.
//
// Unlike the Bearer data-plane balance APIs (Kimi/MiniMax), Volcengine's usage
// endpoint is a CONTROL-plane OpenAPI on the unified gateway
// `open.volcengineapi.com` (NOT the `ark.cn-beijing.volces.com` inference host),
// and it MANDATES Volcengine Signature V4 over an AccessKey ID + Secret — reusing
// the inference Bearer key is rejected with `400 InvalidAuthorization` at the
// gateway. So the AK/SK are a second credential distinct from the chat token.
//
// Auto-probe: `GetAFPUsage` first (Agent Plan → absolute Quota/Used), then
// `GetCodingPlanUsage` (Coding Plan → percentages) when the account has no
// Agent Plan. Both plans share the AK/SK, so an auth failure stops immediately.
//
// Ported from cc-switch v3.17 `services/coding_plan.rs`. The signature is the
// Volcengine variant of AWS SigV4 with two fatal deviations from stock SigV4:
//   1. canonical headers + SignedHeaders use a FIXED order
//      `host;x-date;x-content-sha256;content-type` (NOT alphabetical);
//   2. algorithm is `HMAC-SHA256` (no `AWS4` prefix), the credential scope ends
//      in `request` (not `aws4_request`), and the signing key derives from
//      `kDate = HMAC(SK, date)` (SK is NOT prefixed with `AWS4`).

use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const OPENAPI_HOST: &str = "open.volcengineapi.com";
const API_VERSION: &str = "2024-01-01";
const DEFAULT_REGION: &str = "cn-beijing";
const SERVICE: &str = "ark";
const CONTENT_TYPE: &str = "application/json; charset=utf-8";
const SIGNED_HEADERS: &str = "host;x-date;x-content-sha256;content-type";
const AKSK_HINT: &str =
    "Check the AccessKey ID / Secret are correct and the account has Ark usage-query (OpenAPI) permission.";

/// One normalized usage window. `name` is a cognia meter id (session/weekly/monthly).
#[derive(Debug, Serialize, PartialEq)]
pub struct VolcengineUsageTier {
    pub name: String,
    /// Used percent (0-100, uncapped).
    pub utilization: f64,
    /// ISO-8601 reset time, when known.
    pub resets_at: Option<String>,
}

/// Result of a usage query. `ok:false` + `auth_error:true` → prompt for AK/SK.
#[derive(Debug, Serialize)]
pub struct VolcengineUsage {
    pub ok: bool,
    pub plan: Option<String>,
    pub tiers: Vec<VolcengineUsageTier>,
    pub error: Option<String>,
    pub auth_error: bool,
}

/// Outcome of one signed OpenAPI call.
enum VolcCall {
    Body(Value),
    /// Hard auth failure (shared credential → stop, don't try the other plan).
    Auth(String),
    /// Non-auth HTTP / unparsable body → record and try the other plan.
    Soft(String),
    /// Transient transport failure → caller propagates as `Err`.
    Transient(String),
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// RFC3986 unreserved passthrough; everything else `%XX` (canonical query).
fn uri_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => {
                use std::fmt::Write;
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

/// Derive the control-plane Region from the data-plane base URL
/// (`ark.cn-beijing.volces.com` → `cn-beijing`); falls back to `cn-beijing`.
pub fn region_of(base_url: &str) -> String {
    let host = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or("");
    host.split('.')
        .find(|p| p.starts_with("cn-") || p.starts_with("ap-"))
        .map(|p| p.to_string())
        .unwrap_or_else(|| DEFAULT_REGION.to_string())
}

fn is_auth_error_code(code: &str) -> bool {
    let c = code.to_lowercase();
    c.contains("auth")
        || c.contains("signature")
        || c.contains("accessdenied")
        || c.contains("denied")
        || c.contains("unauthorized")
        || c.contains("forbidden")
        || c.contains("credential")
        || c.contains("token")
}

/// Pull `ResponseMetadata.Error` (or top-level `Error`) as `(code, message)`.
fn response_error(body: &Value) -> Option<(String, String)> {
    let err = body
        .get("ResponseMetadata")
        .and_then(|m| m.get("Error"))
        .or_else(|| body.get("Error"))?;
    let code = err.get("Code").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let msg = err.get("Message").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if code.is_empty() && msg.is_empty() {
        None
    } else {
        Some((code, msg))
    }
}

/// Coerce a JSON number or numeric string to f64.
fn parse_f64(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    v.as_str().and_then(|s| s.trim().parse::<f64>().ok())
}

/// Resolve a reset value (ISO string, or unix seconds/millis) to an ISO-8601 string.
fn extract_reset(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        let t = s.trim();
        return if t.is_empty() { None } else { Some(t.to_string()) };
    }
    let n = parse_f64(v)?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    // < 1e12 can't be epoch-ms → treat as seconds.
    let ms = if n < 1e12 { (n * 1000.0) as i64 } else { n as i64 };
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms).map(|dt| {
        dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
    })
}

/// Canonical query: key-sorted, per-segment URI-encoded. The SAME string is used
/// for signing AND the request URL so they match byte-for-byte.
fn canonical_query(action: &str, region: &str) -> String {
    let mut pairs = [("Action", action), ("Region", region), ("Version", API_VERSION)];
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k), uri_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Volcengine Signature V4 → `(Authorization, X-Date, X-Content-Sha256)`. `now`
/// is a parameter for deterministic tests.
fn sign(
    access_key_id: &str,
    secret_access_key: &str,
    region: &str,
    canonical_query: &str,
    body: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> (String, String, String) {
    let x_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = now.format("%Y%m%d").to_string();
    let x_content_sha256 = sha256_hex(body);

    // Fixed-order canonical headers (Volcengine-specific — NOT sorted).
    let canonical_headers = format!(
        "host:{OPENAPI_HOST}\nx-date:{x_date}\nx-content-sha256:{x_content_sha256}\ncontent-type:{CONTENT_TYPE}\n"
    );
    let canonical_request = format!(
        "POST\n/\n{canonical_query}\n{canonical_headers}\n{SIGNED_HEADERS}\n{x_content_sha256}"
    );

    let credential_scope = format!("{short_date}/{region}/{SERVICE}/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{x_date}\n{credential_scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    // kDate = HMAC(SK, date) — SK is NOT prefixed; terminator string is `request`.
    let k_date = hmac_sha256(secret_access_key.as_bytes(), short_date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, SERVICE.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature: String = hmac_sha256(&k_signing, string_to_sign.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();

    let authorization = format!(
        "HMAC-SHA256 Credential={access_key_id}/{credential_scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}"
    );
    (authorization, x_date, x_content_sha256)
}

async fn openapi_call(
    region: &str,
    access_key_id: &str,
    secret_access_key: &str,
    action: &str,
) -> VolcCall {
    let cq = canonical_query(action, region);
    let url = format!("https://{OPENAPI_HOST}/?{cq}");
    // Proxy-aware client (same as `subscription_authed_get`).
    let client = match super::commands::build_authed_get_client(&url) {
        Ok(c) => c,
        Err(e) => return VolcCall::Transient(e),
    };
    let body: &[u8] = b"";
    let (authorization, x_date, x_content_sha256) =
        sign(access_key_id, secret_access_key, region, &cq, body, chrono::Utc::now());

    let resp = client
        .post(&url)
        .header("X-Date", x_date)
        .header("X-Content-Sha256", x_content_sha256)
        .header("Content-Type", CONTENT_TYPE)
        .header("Authorization", authorization)
        .body(body.to_vec())
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return VolcCall::Transient(format!("Network error: {e}")),
    };

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return VolcCall::Auth(format!("Authentication failed (HTTP {status}). {AKSK_HINT}"));
    }
    if !status.is_success() {
        // The gateway often returns 4xx (usually 400) for signature/credential
        // errors carrying the same `ResponseMetadata.Error` envelope as 200.
        let raw = resp.text().await.unwrap_or_default();
        if let Ok(body) = serde_json::from_str::<Value>(&raw) {
            if let Some((code, msg)) = response_error(&body) {
                if is_auth_error_code(&code) {
                    return VolcCall::Auth(format!(
                        "Authentication failed (HTTP {status}, {code}): {msg}. {AKSK_HINT}"
                    ));
                }
                return VolcCall::Soft(format!("API error (HTTP {status}, {code}): {msg}"));
            }
        }
        return VolcCall::Soft(format!("API error (HTTP {status}): {raw}"));
    }

    let raw = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => return VolcCall::Transient(format!("Failed to read response: {e}")),
    };
    let body: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return VolcCall::Soft(format!("Failed to parse response: {e}")),
    };

    // Business errors often arrive as 200 + ResponseMetadata.Error.
    if let Some((code, msg)) = response_error(&body) {
        if is_auth_error_code(&code) {
            return VolcCall::Auth(format!("Authentication failed ({code}): {msg}. {AKSK_HINT}"));
        }
        return VolcCall::Soft(format!("API error ({code}): {msg}"));
    }

    VolcCall::Body(body)
}

/// Parse `GetAFPUsage` `Result` into tiers. Shows 5h/weekly/monthly (AFPDaily is
/// hidden by the console). `Quota<=0` → window unsubscribed → skipped (also lets
/// "authed but no Agent Plan" fall through to Coding Plan probing).
fn parse_afp_tiers(result: &Value) -> Vec<VolcengineUsageTier> {
    let mut tiers = Vec::new();
    for (key, name) in [
        ("AFPFiveHour", "session"),
        ("AFPWeekly", "weekly"),
        ("AFPMonthly", "monthly"),
    ] {
        let Some(win) = result.get(key) else { continue };
        let quota = win.get("Quota").and_then(parse_f64).unwrap_or(0.0);
        if quota <= 0.0 {
            continue;
        }
        let used = win.get("Used").and_then(parse_f64).unwrap_or(0.0);
        tiers.push(VolcengineUsageTier {
            name: name.to_string(),
            utilization: used / quota * 100.0,
            resets_at: win.get("ResetTime").and_then(extract_reset),
        });
    }
    tiers
}

fn coding_window(label: &str) -> Option<&'static str> {
    match label.to_lowercase().as_str() {
        "session" | "5h" | "fivehour" | "five_hour" | "rolling_5h" => Some("session"),
        "weekly" | "week" | "7d" => Some("weekly"),
        "monthly" | "month" => Some("monthly"),
        _ => None,
    }
}

/// Parse `GetCodingPlanUsage` `Result` (defensive — the field spec is
/// undocumented). Percentages only; reset times are seconds.
fn parse_coding_plan_tiers(result: &Value) -> Vec<VolcengineUsageTier> {
    let mut tiers = Vec::new();
    let arr = result
        .get("QuotaUsage")
        .and_then(|v| v.as_array())
        .or_else(|| result.get("Usages").and_then(|v| v.as_array()))
        .or_else(|| result.get("Details").and_then(|v| v.as_array()));
    let Some(arr) = arr else { return tiers };

    for item in arr {
        let label = item
            .get("Level")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("Type").and_then(|v| v.as_str()))
            .or_else(|| item.get("Period").and_then(|v| v.as_str()))
            .or_else(|| item.get("Label").and_then(|v| v.as_str()))
            .or_else(|| item.get("Window").and_then(|v| v.as_str()))
            .unwrap_or("");
        let Some(name) = coding_window(label) else { continue };
        let utilization = item
            .get("Percent")
            .and_then(parse_f64)
            .or_else(|| item.get("UsedPercent").and_then(parse_f64))
            .or_else(|| item.get("UsagePercent").and_then(parse_f64))
            .unwrap_or(0.0);
        let resets_at = item
            .get("ResetTime")
            .or_else(|| item.get("ResetTimestamp"))
            .and_then(extract_reset);
        tiers.push(VolcengineUsageTier {
            name: name.to_string(),
            utilization,
            resets_at,
        });
    }
    tiers
}

fn ok(tiers: Vec<VolcengineUsageTier>, plan: Option<String>) -> VolcengineUsage {
    VolcengineUsage { ok: true, plan, tiers, error: None, auth_error: false }
}

fn auth_err(detail: String) -> VolcengineUsage {
    VolcengineUsage { ok: false, plan: None, tiers: vec![], error: Some(detail), auth_error: true }
}

fn soft_err(detail: String) -> VolcengineUsage {
    VolcengineUsage { ok: false, plan: None, tiers: vec![], error: Some(detail), auth_error: false }
}

/// Query Volcengine Agent/Coding Plan usage. Returns `Err` only on transient
/// transport failures (so the renderer can retry + keep the last value); every
/// deterministic outcome (auth failure, no subscription, parse error) is an
/// `Ok(VolcengineUsage)` with `ok:false`.
pub async fn query_usage(
    access_key_id: &str,
    secret_access_key: &str,
    base_url: &str,
) -> Result<VolcengineUsage, String> {
    let region = region_of(base_url);
    let mut soft_errors: Vec<String> = Vec::new();

    // 1) Agent Plan.
    match openapi_call(&region, access_key_id, secret_access_key, "GetAFPUsage").await {
        VolcCall::Auth(detail) => return Ok(auth_err(detail)),
        VolcCall::Transient(detail) => return Err(format!("GetAFPUsage: {detail}")),
        VolcCall::Soft(detail) => soft_errors.push(format!("GetAFPUsage: {detail}")),
        VolcCall::Body(body) => {
            let result = body.get("Result").unwrap_or(&body);
            let tiers = parse_afp_tiers(result);
            if !tiers.is_empty() {
                let plan = result
                    .get("PlanType")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("Agent Plan {s}"));
                return Ok(ok(tiers, plan));
            }
        }
    }

    // 2) Coding Plan.
    match openapi_call(&region, access_key_id, secret_access_key, "GetCodingPlanUsage").await {
        VolcCall::Auth(detail) => return Ok(auth_err(detail)),
        VolcCall::Transient(detail) => return Err(format!("GetCodingPlanUsage: {detail}")),
        VolcCall::Soft(detail) => soft_errors.push(format!("GetCodingPlanUsage: {detail}")),
        VolcCall::Body(body) => {
            let result = body.get("Result").unwrap_or(&body);
            let tiers = parse_coding_plan_tiers(result);
            if !tiers.is_empty() {
                return Ok(ok(tiers, Some("Coding Plan".to_string())));
            }
        }
    }

    if !soft_errors.is_empty() {
        Ok(soft_err(soft_errors.join("; ")))
    } else {
        Ok(soft_err("No active Volcengine subscription found (signature OK).".to_string()))
    }
}

/// Tauri command: query Volcengine Agent/Coding Plan usage with an AK/SK pair.
#[tauri::command]
pub async fn subscription_volcengine_usage(
    access_key_id: String,
    secret_access_key: String,
    base_url: String,
) -> Result<VolcengineUsage, String> {
    if access_key_id.trim().is_empty() || secret_access_key.trim().is_empty() {
        return Ok(soft_err("Missing Volcengine AccessKey ID / Secret.".to_string()));
    }
    query_usage(access_key_id.trim(), secret_access_key.trim(), &base_url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(1_700_000_000, 0).expect("valid timestamp")
    }

    #[test]
    fn region_is_derived_from_base_url() {
        assert_eq!(region_of("https://ark.cn-beijing.volces.com/api/coding"), "cn-beijing");
        assert_eq!(region_of("https://ark.ap-southeast.bytepluses.com/api/coding"), "ap-southeast");
        assert_eq!(region_of("https://example.com"), "cn-beijing"); // fallback
    }

    #[test]
    fn canonical_query_is_key_sorted_and_encoded() {
        let cq = canonical_query("GetAFPUsage", "cn-beijing");
        assert_eq!(cq, "Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01");
    }

    #[test]
    fn sign_is_deterministic_and_uses_volcengine_scheme() {
        let cq = canonical_query("GetAFPUsage", "cn-beijing");
        let (auth, x_date, x_content) = sign("AKID", "SECRET", "cn-beijing", &cq, b"", fixed_now());
        // Volcengine deviations: HMAC-SHA256 algorithm, scope ends in /request.
        assert!(auth.starts_with("HMAC-SHA256 Credential=AKID/"));
        assert!(auth.contains("/cn-beijing/ark/request,"));
        assert!(auth.contains("SignedHeaders=host;x-date;x-content-sha256;content-type"));
        assert_eq!(x_date, "20231114T221320Z");
        // Empty-body sha256 is the well-known constant.
        assert_eq!(
            x_content,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // Signature is a stable 64-hex-char HMAC output.
        let sig = auth.rsplit("Signature=").next().unwrap();
        assert_eq!(sig.len(), 64);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));
        // Re-signing the same inputs is byte-identical.
        let (auth2, _, _) = sign("AKID", "SECRET", "cn-beijing", &cq, b"", fixed_now());
        assert_eq!(auth, auth2);
    }

    #[test]
    fn parse_afp_tiers_skips_zero_quota_and_computes_percent() {
        let result = serde_json::json!({
            "AFPFiveHour": { "Quota": 100.0, "Used": 25.0, "ResetTime": 1_700_003_600 },
            "AFPWeekly": { "Quota": 0.0, "Used": 0.0 },
            "AFPMonthly": { "Quota": 200, "Used": 50 },
        });
        let tiers = parse_afp_tiers(&result);
        assert_eq!(tiers.len(), 2); // weekly skipped (Quota<=0)
        assert_eq!(tiers[0].name, "session");
        assert!((tiers[0].utilization - 25.0).abs() < 1e-9);
        assert!(tiers[0].resets_at.is_some());
        assert_eq!(tiers[1].name, "monthly");
        assert!((tiers[1].utilization - 25.0).abs() < 1e-9);
    }

    #[test]
    fn parse_coding_plan_tiers_maps_levels_and_percent() {
        let result = serde_json::json!({
            "QuotaUsage": [
                { "Level": "session", "Percent": 42.0 },
                { "Level": "weekly", "UsedPercent": 10.0 },
                { "Level": "bogus", "Percent": 99.0 },
            ]
        });
        let tiers = parse_coding_plan_tiers(&result);
        assert_eq!(tiers.len(), 2); // bogus level skipped
        assert_eq!(tiers[0].name, "session");
        assert!((tiers[0].utilization - 42.0).abs() < 1e-9);
        assert_eq!(tiers[1].name, "weekly");
    }

    #[test]
    fn auth_error_codes_are_recognized() {
        assert!(is_auth_error_code("SignatureDoesNotMatch"));
        assert!(is_auth_error_code("AccessDenied"));
        assert!(!is_auth_error_code("InvalidParameter"));
    }

    #[tokio::test]
    async fn empty_aksk_short_circuits() {
        let out = subscription_volcengine_usage(
            "".into(),
            "".into(),
            "https://ark.cn-beijing.volces.com/api/coding".into(),
        )
        .await
        .unwrap();
        assert!(!out.ok);
        assert!(!out.auth_error);
        assert!(out.error.is_some());
    }
}
