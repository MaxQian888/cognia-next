//! Exact browser-origin policy shared by HTTP preflights and WS upgrades.

use std::collections::BTreeSet;

use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

const ALLOWED_ORIGINS_ENV: &str = "COGNIA_ALLOWED_WEB_ORIGINS";
const ALLOW_PRIVATE_NETWORK_ENV: &str = "COGNIA_ALLOW_PRIVATE_NETWORK";
const ALLOWED_METHODS: &str = "GET, POST, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS: &str = "authorization, dpop, content-type, accept, idempotency-key";
const VARY: &str = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

#[derive(Clone, Debug, Default)]
pub struct WebOriginPolicy {
    allowed_origins: BTreeSet<String>,
    allow_private_network: bool,
}

impl WebOriginPolicy {
    pub fn from_env() -> Self {
        Self::from_values(
            std::env::var(ALLOWED_ORIGINS_ENV).ok().as_deref(),
            std::env::var(ALLOW_PRIVATE_NETWORK_ENV).ok().as_deref(),
        )
    }

    /// Union of the environment policy and the desktop's saved browser-access
    /// origins.
    ///
    /// The env vars are how a headless deployment (compose, k8s, `dev:headless`)
    /// is configured; the saved config is how the *desktop app* is, because a
    /// GUI-launched app inherits no shell environment and therefore could never
    /// be configured by env alone. Both feed one allowlist so a Host answers the
    /// same set of origins regardless of which surface named them.
    pub fn from_env_and_config(config: &super::browser_access::BrowserAccessConfig) -> Self {
        let mut policy = Self::from_env();
        for origin in &config.allowed_origins {
            policy.allowed_origins.insert(origin.clone());
        }
        // Loopback is a private-network destination as far as Chrome's PNA
        // check is concerned, so an explicitly configured browser origin has to
        // carry the opt-in with it or the preflight it triggers would 403.
        if config.listener_enabled() {
            policy.allow_private_network = true;
        }
        policy
    }

    /// Turn on Private Network Access for this policy.
    ///
    /// A browser classifies `127.0.0.1` as a *private* destination, so a page
    /// on `http://localhost:3000` sends a PNA preflight before it may reach the
    /// plaintext loopback listener. [`Self::from_env_and_config`] sets this for
    /// the desktop whenever the saved config turns that listener on. The
    /// headless binary has no such config — its listener is opted into by
    /// `--browser-listener-port` — so it carries the same opt-in explicitly.
    /// Without it every cross-origin request to the browser plane dies in its
    /// preflight with `private_network_access_forbidden`.
    pub fn allowing_private_network(mut self) -> Self {
        self.allow_private_network = true;
        self
    }

    /// Whether any browser origin is allowed at all.
    ///
    /// A listener bound with an empty allowlist answers `403
    /// web_origin_forbidden` to every request carrying an `Origin` header —
    /// which is every request a browser makes. Callers that bind the browser
    /// plane check this first so the misconfiguration surfaces at startup
    /// instead of as an unexplained failure inside a tab.
    pub fn allows_any_origin(&self) -> bool {
        !self.allowed_origins.is_empty()
    }

    fn from_values(origins: Option<&str>, allow_private_network: Option<&str>) -> Self {
        let allowed_origins = origins
            .into_iter()
            .flat_map(|raw| raw.split(','))
            .filter_map(normalize_allowed_origin)
            .collect();
        let allow_private_network = allow_private_network.is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        });
        Self {
            allowed_origins,
            allow_private_network,
        }
    }

    fn evaluate(&self, headers: &HeaderMap) -> OriginDecision {
        let Some(origin) = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        else {
            return OriginDecision::Native;
        };
        if request_origin(headers).as_deref() == Some(origin) {
            return OriginDecision::SameOrigin;
        }
        if self.allowed_origins.contains(origin) {
            return OriginDecision::AllowedCrossOrigin(origin.to_string());
        }
        OriginDecision::Denied
    }
}

#[derive(Debug, Eq, PartialEq)]
enum OriginDecision {
    Native,
    SameOrigin,
    AllowedCrossOrigin(String),
    Denied,
}

pub async fn enforce(
    State(policy): State<WebOriginPolicy>,
    request: Request,
    next: Next,
) -> Response {
    let workflow_embed_token = request.uri().path().starts_with("/api/apps/")
        && request.uri().path().ends_with("/embed-token");
    let decision = if workflow_embed_token {
        request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .and_then(normalize_allowed_origin)
            .map(OriginDecision::AllowedCrossOrigin)
            .unwrap_or(OriginDecision::Denied)
    } else {
        policy.evaluate(request.headers())
    };
    if decision == OriginDecision::Denied {
        return super::api::public_error_response(
            StatusCode::FORBIDDEN,
            "web_origin_forbidden",
            "the browser Origin is not allowed for this Host",
            false,
            serde_json::json!({}),
        );
    }

    let is_preflight = request.method() == Method::OPTIONS
        && request
            .headers()
            .contains_key("access-control-request-method");
    if is_preflight {
        if !preflight_is_valid(request.headers()) {
            return super::api::public_error_response(
                StatusCode::FORBIDDEN,
                "cors_preflight_forbidden",
                "the requested browser method or headers are not allowed",
                false,
                serde_json::json!({}),
            );
        }
        let asks_private_network = request
            .headers()
            .get("access-control-request-private-network")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        if asks_private_network
            && (!policy.allow_private_network
                || !matches!(decision, OriginDecision::AllowedCrossOrigin(_)))
        {
            return super::api::public_error_response(
                StatusCode::FORBIDDEN,
                "private_network_access_forbidden",
                "Private Network Access is not enabled for this Origin",
                false,
                serde_json::json!({}),
            );
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(response.headers_mut(), &decision);
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(ALLOWED_METHODS),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(ALLOWED_HEADERS),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        if asks_private_network {
            response.headers_mut().insert(
                "access-control-allow-private-network",
                HeaderValue::from_static("true"),
            );
        }
        return response;
    }

    let mut response = next.run(request).await;
    apply_cors_headers(response.headers_mut(), &decision);
    response
}

/// `https://…`, or `http://` on a loopback host. The transport predicate every
/// operator-supplied base URL in the companion is held to: a plaintext origin
/// is only ever acceptable when the bytes never leave the machine.
///
/// Shared with `lark_entry`'s `COGNIA_LARK_*` base validation so the two cannot
/// drift on what counts as loopback (`localhost`, `127.0.0.0/8`, `::1`).
pub(crate) fn is_secure_or_loopback(url: &url::Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost",
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn normalize_allowed_origin(raw: &str) -> Option<String> {
    let value = raw.trim().trim_end_matches('/');
    let url = url::Url::parse(value).ok()?;
    if !is_secure_or_loopback(&url)
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(value.to_string())
}

fn request_origin(headers: &HeaderMap) -> Option<String> {
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("https");
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))?
        .to_str()
        .ok()?;
    Some(format!("{scheme}://{host}"))
}

fn preflight_is_valid(headers: &HeaderMap) -> bool {
    let method = headers
        .get("access-control-request-method")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "DELETE") {
        return false;
    }
    let allowed = ALLOWED_HEADERS.split(", ").collect::<BTreeSet<_>>();
    headers
        .get("access-control-request-headers")
        .and_then(|value| value.to_str().ok())
        .map(|raw| {
            raw.split(',')
                .map(|value| value.trim().to_ascii_lowercase())
                .all(|value| allowed.contains(value.as_str()))
        })
        .unwrap_or(true)
}

fn apply_cors_headers(headers: &mut HeaderMap, decision: &OriginDecision) {
    headers.insert(header::VARY, HeaderValue::from_static(VARY));
    if let OriginDecision::AllowedCrossOrigin(origin) = decision {
        if let Ok(value) = HeaderValue::from_str(origin) {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get, Router};
    use tower::ServiceExt as _;

    fn headers(origin: Option<&str>, host: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        headers
    }

    #[test]
    fn defaults_allow_same_origin_and_native_but_deny_cross_origin() {
        let policy = WebOriginPolicy::default();
        assert_eq!(
            policy.evaluate(&headers(None, "brain.example")),
            OriginDecision::Native
        );
        assert_eq!(
            policy.evaluate(&headers(Some("https://brain.example"), "brain.example")),
            OriginDecision::SameOrigin
        );
        assert_eq!(
            policy.evaluate(&headers(Some("https://web.example"), "brain.example")),
            OriginDecision::Denied
        );
    }

    #[test]
    fn allowlist_accepts_only_exact_https_origins() {
        let policy = WebOriginPolicy::from_values(
            Some("https://web.example, http://insecure.example, https://bad.example/path"),
            None,
        );
        assert_eq!(
            policy.evaluate(&headers(Some("https://web.example"), "brain.example")),
            OriginDecision::AllowedCrossOrigin("https://web.example".into())
        );
        assert_eq!(
            policy.evaluate(&headers(Some("https://web.example.evil"), "brain.example")),
            OriginDecision::Denied
        );
    }

    #[test]
    fn secure_or_loopback_admits_https_and_only_loopback_http() {
        for secure in [
            "https://web.example",
            "https://web.example:8443",
            "http://localhost:3000",
            "http://127.0.0.1:27890",
            "http://[::1]:27890",
        ] {
            assert!(
                is_secure_or_loopback(&url::Url::parse(secure).unwrap()),
                "{secure} should be accepted"
            );
        }
        for insecure in [
            "http://web.example",
            // `localhost.evil.example` must not pass as loopback by suffix.
            "http://localhost.evil.example",
            "http://10.0.0.1",
            "ftp://web.example",
            "file:///etc/passwd",
        ] {
            assert!(
                !is_secure_or_loopback(&url::Url::parse(insecure).unwrap()),
                "{insecure} should be rejected"
            );
        }
    }

    #[test]
    fn config_origins_join_the_env_allowlist_and_carry_pna() {
        use super::super::browser_access::BrowserAccessConfig;
        std::env::set_var(ALLOWED_ORIGINS_ENV, "https://web.example");
        let policy = WebOriginPolicy::from_env_and_config(
            &BrowserAccessConfig {
                enabled: true,
                allowed_origins: vec!["http://localhost:3000".into()],
                port: 27891,
            }
            .sanitized()
            .unwrap(),
        );
        std::env::remove_var(ALLOWED_ORIGINS_ENV);
        assert_eq!(
            policy.evaluate(&headers(Some("http://localhost:3000"), "127.0.0.1:27891")),
            OriginDecision::AllowedCrossOrigin("http://localhost:3000".into())
        );
        assert_eq!(
            policy.evaluate(&headers(Some("https://web.example"), "127.0.0.1:27891")),
            OriginDecision::AllowedCrossOrigin("https://web.example".into())
        );
        assert!(policy.allow_private_network);
    }

    #[test]
    fn the_headless_browser_listener_opt_in_carries_pna_without_a_saved_config() {
        // `cognia-server --browser-listener-port` has no BrowserAccessConfig to
        // read, so it must reach the same policy the desktop derives from one:
        // env origins plus Private Network Access.
        let policy = WebOriginPolicy::from_values(Some("http://localhost:3000"), None)
            .allowing_private_network();
        assert!(policy.allow_private_network);
        assert_eq!(
            policy.evaluate(&headers(Some("http://localhost:3000"), "127.0.0.1:27891")),
            OriginDecision::AllowedCrossOrigin("http://localhost:3000".into())
        );
    }

    #[test]
    fn an_empty_allowlist_is_visible_to_the_caller_that_would_bind_the_listener() {
        // The listener would still bind and still answer — with 403
        // web_origin_forbidden to every request a browser makes. Callers check
        // this so the misconfiguration surfaces at startup, not in a tab.
        assert!(!WebOriginPolicy::from_values(None, None).allows_any_origin());
        assert!(!WebOriginPolicy::from_values(Some("   "), None).allows_any_origin());
        assert!(
            WebOriginPolicy::from_values(Some("http://localhost:3000"), None).allows_any_origin()
        );
    }

    #[test]
    fn a_disabled_browser_access_config_grants_nothing() {
        use super::super::browser_access::BrowserAccessConfig;
        let policy = WebOriginPolicy::from_env_and_config(
            &BrowserAccessConfig {
                enabled: false,
                allowed_origins: vec!["http://localhost:3000".into()],
                port: 27891,
            }
            .sanitized()
            .unwrap(),
        );
        // The origin is remembered for the next enable, so it is still allowed
        // on the HTTPS plane — but nothing turns PNA on behind the user's back.
        assert!(!policy.allow_private_network);
    }

    #[test]
    fn pna_is_disabled_unless_explicitly_enabled() {
        assert!(
            !WebOriginPolicy::from_values(Some("https://web.example"), None).allow_private_network
        );
        assert!(
            WebOriginPolicy::from_values(Some("https://web.example"), Some("true"))
                .allow_private_network
        );
    }

    #[test]
    fn preflight_rejects_unlisted_methods_and_headers() {
        let mut valid = HeaderMap::new();
        valid.insert(
            "access-control-request-method",
            HeaderValue::from_static("POST"),
        );
        valid.insert(
            "access-control-request-headers",
            HeaderValue::from_static("content-type, dpop, authorization"),
        );
        assert!(preflight_is_valid(&valid));
        valid.insert(
            "access-control-request-headers",
            HeaderValue::from_static("x-unsafe"),
        );
        assert!(!preflight_is_valid(&valid));
    }

    fn test_router(policy: WebOriginPolicy) -> Router {
        Router::new()
            .route(
                "/ws/events",
                get(|| async { StatusCode::SWITCHING_PROTOCOLS }),
            )
            .route(
                "/api/apps/review/embed-token",
                get(|| async { StatusCode::OK }),
            )
            .layer(axum::middleware::from_fn_with_state(policy, enforce))
    }

    #[tokio::test]
    async fn embed_token_defers_an_exact_secure_origin_to_the_release_policy() {
        let response = test_router(WebOriginPolicy::default())
            .oneshot(
                Request::builder()
                    .uri("/api/apps/review/embed-token")
                    .header(header::HOST, "brain.example")
                    .header(header::ORIGIN, "https://embed.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://embed.example"
        );

        let insecure = test_router(WebOriginPolicy::default())
            .oneshot(
                Request::builder()
                    .uri("/api/apps/review/embed-token")
                    .header(header::HOST, "brain.example")
                    .header(header::ORIGIN, "http://embed.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(insecure.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn preflight_echoes_only_the_exact_allowed_origin_without_credentials() {
        let response = test_router(WebOriginPolicy::from_values(
            Some("https://web.example"),
            Some("false"),
        ))
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/ws/events")
                .header(header::HOST, "brain.example")
                .header(header::ORIGIN, "https://web.example")
                .header("access-control-request-method", "GET")
                .header("access-control-request-headers", "authorization, dpop")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://web.example"
        );
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
        assert_eq!(response.headers()[header::VARY], VARY);
    }

    #[tokio::test]
    async fn preflight_accepts_explicit_loopback_http_origins() {
        for origin in [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            let response = test_router(WebOriginPolicy::from_values(Some(origin), Some("false")))
                .oneshot(
                    Request::builder()
                        .method(Method::OPTIONS)
                        .uri("/ws/events")
                        .header(header::HOST, "127.0.0.1:27890")
                        .header(header::ORIGIN, origin)
                        .header("access-control-request-method", "GET")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::NO_CONTENT, "{origin}");
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                origin,
                "{origin}"
            );
        }
    }

    #[tokio::test]
    async fn preflight_rejects_an_explicit_non_loopback_http_origin() {
        let response = test_router(WebOriginPolicy::from_values(
            Some("http://web.example"),
            Some("false"),
        ))
        .oneshot(
            Request::builder()
                .method(Method::OPTIONS)
                .uri("/ws/events")
                .header(header::HOST, "127.0.0.1:27890")
                .header(header::ORIGIN, "http://web.example")
                .header("access-control-request-method", "GET")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[tokio::test]
    async fn browser_ws_origin_is_checked_but_originless_native_is_allowed() {
        let router = test_router(WebOriginPolicy::default());
        let denied = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/ws/events")
                    .header(header::HOST, "brain.example")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        let native = router
            .oneshot(
                Request::builder()
                    .uri("/ws/events")
                    .header(header::HOST, "brain.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(native.status(), StatusCode::SWITCHING_PROTOCOLS);
    }

    #[tokio::test]
    async fn pna_requires_both_an_allowlisted_origin_and_explicit_opt_in() {
        for (enabled, expected) in [
            ("false", StatusCode::FORBIDDEN),
            ("true", StatusCode::NO_CONTENT),
        ] {
            let response = test_router(WebOriginPolicy::from_values(
                Some("https://web.example"),
                Some(enabled),
            ))
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/ws/events")
                    .header(header::HOST, "192.168.1.20")
                    .header(header::ORIGIN, "https://web.example")
                    .header("access-control-request-method", "GET")
                    .header("access-control-request-private-network", "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), expected);
            assert_eq!(
                response
                    .headers()
                    .get("access-control-allow-private-network")
                    .is_some(),
                enabled == "true"
            );
        }
    }
}
