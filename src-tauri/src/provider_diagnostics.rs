//! Provider diagnostics native security boundary.
//!
//! Balance scripts execute in a fresh QuickJS runtime with no host globals.
//! They can only describe bounded HTTP requests using credential references;
//! Rust resolves the references after evaluation and validates every network
//! hop before sending it.

use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use rquickjs::{Context, Runtime};
use serde::{Deserialize, Serialize};

const SECRET_NAMESPACE: &str = "provider-diagnostics-balance";
const MAX_SCRIPT_HEAP_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCRIPT_COMPUTE: Duration = Duration::from_millis(250);
const MAX_WALL_TIME: Duration = Duration::from_secs(15);
const MAX_REQUESTS: usize = 3;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_REDIRECTS: usize = 3;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceScriptGrant {
    pub domain: String,
    #[serde(default)]
    pub allow_http: bool,
    #[serde(default)]
    pub allow_private: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceScriptRunRequest {
    pub source_id: String,
    pub script: String,
    pub provider_metadata: serde_json::Value,
    pub same_origin: String,
    #[serde(default)]
    pub grants: Vec<BalanceScriptGrant>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScriptRequestTemplate {
    url: String,
    #[serde(default = "default_get")]
    method: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
    credential_ref: String,
    #[serde(default = "default_authorization_header")]
    credential_header: String,
    #[serde(default = "default_bearer_prefix")]
    credential_prefix: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScriptResponseData {
    status: u16,
    headers: std::collections::HashMap<String, String>,
    body: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceScriptAmount {
    unit: String,
    remaining: Option<f64>,
    total: Option<f64>,
    used: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ScriptOutput {
    amounts: Vec<BalanceScriptAmountInput>,
    available: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct BalanceScriptAmountInput {
    unit: String,
    remaining: Option<f64>,
    total: Option<f64>,
    used: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceScriptRunResult {
    source_id: String,
    amounts: Vec<BalanceScriptAmount>,
    available: Option<bool>,
    request_count: usize,
}

fn default_get() -> String {
    "GET".into()
}

fn default_authorization_header() -> String {
    "authorization".into()
}

fn default_bearer_prefix() -> String {
    "Bearer ".into()
}

fn validate_source_id(source_id: &str) -> Result<(), String> {
    if source_id.is_empty()
        || source_id.len() > 128
        || !source_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.'))
    {
        return Err("invalid balance source id".into());
    }
    Ok(())
}

fn evaluate_script(
    script: &str,
    function_name: &str,
    input: &serde_json::Value,
) -> Result<String, String> {
    let runtime = Runtime::new().map_err(|error| format!("script runtime failed: {error}"))?;
    runtime.set_memory_limit(MAX_SCRIPT_HEAP_BYTES);
    runtime.set_max_stack_size(512 * 1024);
    let deadline = Instant::now() + MAX_SCRIPT_COMPUTE;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context =
        Context::full(&runtime).map_err(|error| format!("script context failed: {error}"))?;
    let input_json = serde_json::to_string(input).map_err(|error| error.to_string())?;
    let quoted_input = serde_json::to_string(&input_json).map_err(|error| error.to_string())?;
    context.with(|ctx| {
        ctx.eval::<(), _>(script)
            .map_err(|error| format!("script evaluation failed: {error}"))?;
        let invocation = format!(
            "JSON.stringify((() => {{ if (typeof {function_name} !== 'function') throw new Error('{function_name} is required'); return {function_name}(JSON.parse({quoted_input})); }})())"
        );
        ctx.eval::<String, _>(invocation)
            .map_err(|error| format!("script {function_name} failed: {error}"))
    })
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

fn matching_grant<'a>(
    host: &str,
    grants: &'a [BalanceScriptGrant],
) -> Option<&'a BalanceScriptGrant> {
    grants
        .iter()
        .find(|grant| grant.domain.eq_ignore_ascii_case(host))
}

async fn validate_network_target(
    target: &url::Url,
    same_origin: &url::Url,
    grants: &[BalanceScriptGrant],
) -> Result<Vec<SocketAddr>, String> {
    if !target.username().is_empty() || target.password().is_some() {
        return Err("URL userinfo is denied".into());
    }
    let host = target
        .host_str()
        .ok_or_else(|| "request URL is missing a host".to_string())?;
    let same_host = target.scheme() == same_origin.scheme()
        && target.host_str() == same_origin.host_str()
        && target.port_or_known_default() == same_origin.port_or_known_default();
    let grant = matching_grant(host, grants);
    if !same_host && grant.is_none() {
        return Err(format!("network grant required for {host}"));
    }
    if target.scheme() != "https" && !grant.is_some_and(|value| value.allow_http) {
        return Err("plain HTTP requires an explicit grant".into());
    }
    if target.scheme() != "https" && target.scheme() != "http" {
        return Err("only HTTP(S) requests are allowed".into());
    }
    let port = target
        .port_or_known_default()
        .ok_or_else(|| "request URL has no resolvable port".to_string())?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("DNS resolution failed: {error}"))?
        .collect::<Vec<SocketAddr>>();
    if addresses.is_empty() {
        return Err("DNS resolution returned no addresses".into());
    }
    if addresses.iter().any(|address| is_private_ip(address.ip()))
        && !grant.is_some_and(|value| value.allow_private)
    {
        return Err("private, loopback, and link-local addresses require an explicit grant".into());
    }
    Ok(addresses)
}

fn validate_headers(headers: &std::collections::HashMap<String, String>) -> Result<(), String> {
    const DENIED: &[&str] = &[
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "cookie",
    ];
    if headers.len() > 32 {
        return Err("script request has too many headers".into());
    }
    for (name, value) in headers {
        if DENIED.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!("header {name} is denied"));
        }
        if value.len() > 8 * 1024 {
            return Err(format!("header {name} exceeds size limit"));
        }
        reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("invalid header name: {name}"))?;
        reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| format!("invalid header value: {name}"))?;
    }
    Ok(())
}

fn query_contains_secret(target: &url::Url, secret: &str) -> bool {
    target
        .query_pairs()
        .any(|(name, value)| name.contains(secret) || value.contains(secret))
}

async fn execute_template(
    template: &ScriptRequestTemplate,
    same_origin: &url::Url,
    grants: &[BalanceScriptGrant],
) -> Result<ScriptResponseData, String> {
    let method = match template.method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        _ => return Err("balance scripts may only use GET or POST".into()),
    };
    validate_headers(&template.headers)?;
    let credential_header = std::collections::HashMap::from([(
        template.credential_header.clone(),
        format!("{}credential", template.credential_prefix),
    )]);
    validate_headers(&credential_header)?;
    let secret = crate::secret_store::get(SECRET_NAMESPACE, &template.credential_ref)?
        .ok_or_else(|| "credential reference was not found".to_string())?;
    let mut current =
        url::Url::parse(&template.url).map_err(|error| format!("invalid request URL: {error}"))?;
    for redirect_count in 0..=MAX_REDIRECTS {
        if query_contains_secret(&current, &secret) {
            return Err("credential material in query strings is denied".into());
        }
        let addresses = validate_network_target(&current, same_origin, grants).await?;
        let host = current
            .host_str()
            .ok_or_else(|| "request URL is missing a host".to_string())?;
        // Pin the exact addresses that passed policy validation. Reqwest must
        // not perform a second DNS lookup that could be rebound to a private IP.
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(MAX_WALL_TIME)
            .resolve_to_addrs(host, &addresses);
        let (builder, _) = crate::proxy_config::apply_reqwest_policy(builder, current.as_str())
            .map_err(|error| error.to_string())?;
        let client = builder
            .build()
            .map_err(|error| format!("HTTP client failed: {error}"))?;
        let mut request = client.request(method.clone(), current.clone());
        for (name, value) in &template.headers {
            request = request.header(name, value);
        }
        request = request.header(
            &template.credential_header,
            format!("{}{}", template.credential_prefix, secret),
        );
        if let Some(body) = &template.body {
            if body.len() > MAX_RESPONSE_BYTES {
                return Err("script request body exceeds 1 MiB".into());
            }
            request = request.body(body.clone());
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("request failed: {error}"))?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err("redirect limit exceeded".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "redirect is missing Location".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("invalid redirect: {error}"))?;
            continue;
        }
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value.to_str().ok().map(|value| {
                    (
                        name.as_str().to_string(),
                        value.chars().take(8 * 1024).collect(),
                    )
                })
            })
            .take(32)
            .collect();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("response read failed: {error}"))?;
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err("script response exceeds 1 MiB".into());
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(ScriptResponseData {
            status,
            headers,
            body: String::from_utf8(body)
                .map_err(|_| "script response is not UTF-8".to_string())?,
        });
    }
    Err("redirect limit exceeded".into())
}

#[tauri::command]
pub fn provider_diagnostics_migrate_balance_token(
    source_id: String,
    token: String,
) -> Result<String, String> {
    validate_source_id(&source_id)?;
    if token.is_empty() || token.len() > 16 * 1024 {
        return Err("balance token is empty or too large".into());
    }
    crate::secret_store::set(SECRET_NAMESPACE, &source_id, &token)?;
    Ok(source_id)
}

#[tauri::command]
pub fn provider_diagnostics_clear_balance_token(source_id: String) -> Result<(), String> {
    validate_source_id(&source_id)?;
    crate::secret_store::delete(SECRET_NAMESPACE, &source_id)
}

#[tauri::command]
pub async fn provider_diagnostics_run_balance_script(
    request: BalanceScriptRunRequest,
) -> Result<BalanceScriptRunResult, String> {
    tokio::time::timeout(MAX_WALL_TIME, run_balance_script(request))
        .await
        .map_err(|_| "balance script exceeded the 15-second wall-time limit".to_string())?
}

async fn run_balance_script(
    request: BalanceScriptRunRequest,
) -> Result<BalanceScriptRunResult, String> {
    validate_source_id(&request.source_id)?;
    let same_origin = url::Url::parse(&request.same_origin)
        .map_err(|error| format!("invalid same-origin URL: {error}"))?;
    let build_input = serde_json::json!({ "provider": request.provider_metadata });
    let raw_templates = evaluate_script(&request.script, "buildRequests", &build_input)?;
    let templates: Vec<ScriptRequestTemplate> = serde_json::from_str(&raw_templates)
        .map_err(|error| format!("invalid request templates: {error}"))?;
    if templates.len() > MAX_REQUESTS {
        return Err(format!(
            "balance script exceeds {MAX_REQUESTS} request limit"
        ));
    }
    let mut responses = Vec::with_capacity(templates.len());
    for template in &templates {
        if template.credential_ref != request.source_id {
            return Err("script may only use its own credential reference".into());
        }
        responses.push(execute_template(template, &same_origin, &request.grants).await?);
    }
    let parse_input =
        serde_json::json!({ "provider": request.provider_metadata, "responses": responses });
    let raw_output = evaluate_script(&request.script, "parseResponses", &parse_input)?;
    let output: ScriptOutput = serde_json::from_str(&raw_output)
        .map_err(|error| format!("invalid script output: {error}"))?;
    let amounts = output
        .amounts
        .into_iter()
        .map(|amount| BalanceScriptAmount {
            unit: amount.unit,
            remaining: amount.remaining,
            total: amount.total,
            used: amount.used,
        })
        .collect();
    Ok(BalanceScriptRunResult {
        source_id: request.source_id,
        amounts,
        available: output.available,
        request_count: templates.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quickjs_has_no_host_capabilities_and_enforces_compute_limit() {
        let output = evaluate_script(
            "function buildRequests(input) { return [{ process: typeof process, fetch: typeof fetch, require: typeof require, timers: typeof setTimeout, value: input.provider.id }]; }",
            "buildRequests",
            &serde_json::json!({ "provider": { "id": "safe" } }),
        )
        .unwrap();
        assert!(output.contains(r#""process":"undefined""#));
        assert!(output.contains(r#""fetch":"undefined""#));
        assert!(output.contains(r#""require":"undefined""#));
        assert!(output.contains(r#""timers":"undefined""#));

        let error = evaluate_script(
            "function buildRequests() { while (true) {} }",
            "buildRequests",
            &serde_json::json!({}),
        )
        .unwrap_err();
        assert!(error.contains("interrupted") || error.contains("script"));
    }

    #[test]
    fn rejects_hop_by_hop_headers_private_ips_and_invalid_source_ids() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("Connection".into(), "keep-alive".into());
        assert!(validate_headers(&headers).is_err());
        assert!(is_private_ip("127.0.0.1".parse().unwrap()));
        assert!(is_private_ip("10.0.0.1".parse().unwrap()));
        assert!(!is_private_ip("1.1.1.1".parse().unwrap()));
        assert!(validate_source_id("../secret").is_err());
        assert!(validate_source_id("provider:source-1").is_ok());
        assert!(query_contains_secret(
            &url::Url::parse("https://example.test/?token=s%65cret").unwrap(),
            "secret"
        ));
    }

    fn script_request(method: &str, credential_ref: &str) -> ScriptRequestTemplate {
        ScriptRequestTemplate {
            url: "https://example.com/v1/balance".into(),
            method: method.into(),
            headers: std::collections::HashMap::new(),
            body: None,
            credential_ref: credential_ref.into(),
            credential_header: "authorization".into(),
            credential_prefix: "Bearer ".into(),
        }
    }

    #[tokio::test]
    async fn rejects_unsupported_methods_and_denied_credential_headers_before_secret_lookup() {
        let same_origin = url::Url::parse("https://example.com").unwrap();
        let error = execute_template(&script_request("DELETE", "missing"), &same_origin, &[])
            .await
            .unwrap_err();
        assert!(error.contains("GET or POST"));

        let mut request = script_request("GET", "missing");
        request.credential_header = "cookie".into();
        let error = execute_template(&request, &same_origin, &[])
            .await
            .unwrap_err();
        assert!(error.contains("header cookie is denied"));
    }

    #[tokio::test]
    async fn enforces_request_count_and_credential_reference_isolation_without_network_access() {
        let too_many = BalanceScriptRunRequest {
            source_id: "source-1".into(),
            script: r#"
                function buildRequests() {
                  return [1, 2, 3, 4].map(() => ({
                    url: "https://example.com/balance",
                    credentialRef: "source-1"
                  }));
                }
                function parseResponses() { return { amounts: [] }; }
            "#
            .into(),
            provider_metadata: serde_json::json!({ "id": "provider" }),
            same_origin: "https://example.com".into(),
            grants: vec![],
        };
        assert!(run_balance_script(too_many)
            .await
            .unwrap_err()
            .contains("3 request limit"));

        let wrong_credential = BalanceScriptRunRequest {
            source_id: "source-1".into(),
            script: r#"
                function buildRequests() {
                  return [{
                    url: "https://example.com/balance",
                    credentialRef: "source-2"
                  }];
                }
                function parseResponses() { return { amounts: [] }; }
            "#
            .into(),
            provider_metadata: serde_json::json!({ "id": "provider" }),
            same_origin: "https://example.com".into(),
            grants: vec![],
        };
        assert!(run_balance_script(wrong_credential)
            .await
            .unwrap_err()
            .contains("its own credential reference"));
    }

    #[tokio::test]
    async fn requires_separate_http_and_private_network_grants() {
        let target = url::Url::parse("http://127.0.0.1:18080/balance").unwrap();
        let same_origin = url::Url::parse("http://127.0.0.1:18080").unwrap();
        assert!(validate_network_target(&target, &same_origin, &[])
            .await
            .unwrap_err()
            .contains("plain HTTP"));

        let http_only = [BalanceScriptGrant {
            domain: "127.0.0.1".into(),
            allow_http: true,
            allow_private: false,
        }];
        assert!(validate_network_target(&target, &same_origin, &http_only)
            .await
            .unwrap_err()
            .contains("private, loopback"));

        let fully_granted = [BalanceScriptGrant {
            domain: "127.0.0.1".into(),
            allow_http: true,
            allow_private: true,
        }];
        assert!(
            validate_network_target(&target, &same_origin, &fully_granted)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn parses_zero_request_scripts_and_rejects_invalid_output_schema() {
        let valid = BalanceScriptRunRequest {
            source_id: "source-1".into(),
            script: r#"
                function buildRequests() { return []; }
                function parseResponses(input) {
                  return { amounts: [{ unit: "credits", remaining: 7 }], available: true };
                }
            "#
            .into(),
            provider_metadata: serde_json::json!({ "id": "provider" }),
            same_origin: "https://example.com".into(),
            grants: vec![],
        };
        let result = run_balance_script(valid).await.unwrap();
        assert_eq!(result.request_count, 0);
        assert_eq!(result.amounts[0].unit, "credits");
        assert_eq!(result.amounts[0].remaining, Some(7.0));

        let invalid = BalanceScriptRunRequest {
            source_id: "source-1".into(),
            script: r#"
                function buildRequests() { return []; }
                function parseResponses() { return { remaining: 7 }; }
            "#
            .into(),
            provider_metadata: serde_json::json!({}),
            same_origin: "https://example.com".into(),
            grants: vec![],
        };
        assert!(run_balance_script(invalid)
            .await
            .unwrap_err()
            .contains("invalid script output"));
    }
}
