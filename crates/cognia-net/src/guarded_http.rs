//! DNS rebinding protection for the buffered and streaming desktop bridges.
//!
//! Direct connections use only the locally checked DNS answers. HTTP/SOCKS
//! proxies may resolve the destination remotely: local resolution is still
//! checked on every hop, but is only best effort on those routes. A proxy must
//! enforce its own destination policy to close that remote-resolution gap.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use reqwest::header::{
    AUTHORIZATION, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION,
    PROXY_AUTHORIZATION, REFERER, TRANSFER_ENCODING, WWW_AUTHENTICATE,
};
use reqwest::{ClientBuilder, Method, Request, RequestBuilder, Response, StatusCode, Url};

const PRIVATE_ADDRESS_PREFIX: &str = "refusing to fetch a private/loopback address";
const MAX_REDIRECTS: usize = 10;

pub const MAX_DOWNLOAD_BYTES: usize = 20 * 1024 * 1024;

/// Opt-in policy for public binary downloads. Callers own the origin grant;
/// every destination still passes DNS pinning and private-address rejection.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadPolicy {
    pub allowed_origins: Vec<String>,
    pub max_bytes: usize,
}

impl DownloadPolicy {
    pub fn validate(&self, target: &Url) -> Result<(), String> {
        if self.max_bytes == 0
            || self.max_bytes > MAX_DOWNLOAD_BYTES
            || self.allowed_origins.is_empty()
            || self.allowed_origins.len() > 32
        {
            return Err("download_policy_invalid".into());
        }
        let mut allowed = false;
        for origin in &self.allowed_origins {
            let parsed = Url::parse(origin).map_err(|_| "download_policy_invalid".to_string())?;
            if parsed.scheme() != "https"
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.path() != "/"
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return Err("download_policy_invalid".into());
            }
            allowed |= parsed.origin() == target.origin();
        }
        if target.scheme() != "https"
            || target.host_str().is_none()
            || !target.username().is_empty()
            || target.password().is_some()
            || !allowed
            || host_is_private(target.as_str())
        {
            return Err("download_destination_denied".into());
        }
        Ok(())
    }
}

/// Rust-only policy for an origin that explicitly delegates image delivery.
/// This does not expand the JSON DownloadPolicy used by bridge callers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublicRedirects {
    None,
    SameOrigin,
    Delegated,
}

fn validate_public_hop(
    target: &Url,
    initial: &url::Origin,
    redirects: PublicRedirects,
) -> Result<(), String> {
    if redirects == PublicRedirects::SameOrigin && target.origin() != *initial {
        return Err("public_redirect_denied".into());
    }
    DownloadPolicy {
        allowed_origins: vec![target.origin().ascii_serialization()],
        max_bytes: MAX_DOWNLOAD_BYTES,
    }
    .validate(target)
}

async fn resolve_public_host(url: Url, timeout: Duration) -> Result<CheckedHost, String> {
    let checked = resolve_before_timeout(&url, Some(timeout), CheckedHost::resolve(&url))
        .await
        .map_err(|_| "public_destination_denied".to_string())?;
    if checked
        .addrs
        .iter()
        .any(|addr| crate::egress::is_forbidden_dest_ip(&addr.ip()))
    {
        return Err("public_destination_denied".into());
    }
    Ok(checked)
}

/// A small buffered request over direct DNS pinning or a checked-IP proxy
/// tunnel. Callers own body limits and a total deadline enclosing body reads.
/// Every hop re-evaluates proxy/bypass policy. Delegated hops discard ALL
/// original headers; same-origin policy is required for token-bearing paths.
pub async fn send_pinned_public<F>(
    request: RequestBuilder,
    redirects: PublicRedirects,
    make_builder: F,
    timeout: Duration,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
{
    let request = request.build().map_err(|_| "public_request_invalid")?;
    if request
        .body()
        .is_some_and(|body| body.as_bytes().is_none_or(|bytes| bytes.len() > 64 * 1024))
    {
        return Err("public_request_invalid".into());
    }
    tokio::time::timeout(
        timeout,
        send_pinned_with_policy(
            request,
            redirects,
            make_builder,
            |url| resolve_public_host(url, timeout),
            || crate::proxy_config::current().map_err(|_| "public_proxy_policy_failed".into()),
        ),
    )
    .await
    .map_err(|_| "public_request_timed_out".to_string())?
    .map_err(|_| "public_request_failed".to_string())
}

async fn send_pinned_with_policy<F, R, Fut, P>(
    mut request: Request,
    redirects: PublicRedirects,
    make_builder: F,
    resolve: R,
    proxy: P,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
    R: Fn(Url) -> Fut,
    Fut: Future<Output = Result<CheckedHost, String>>,
    P: Fn() -> Result<crate::proxy_config::ProxyConfig, String>,
{
    let initial = request.url().origin();
    for hop in 0..=MAX_REDIRECTS {
        validate_public_hop(request.url(), &initial, redirects)?;
        request.headers_mut().remove(REFERER);
        request.headers_mut().remove(HOST);
        request.headers_mut().remove(PROXY_AUTHORIZATION);
        let checked = resolve(request.url().clone()).await?;
        let policy = proxy()?;
        let route = policy
            .route_for(request.url().as_str())
            .map_err(|_| "public_proxy_policy_failed")?;
        let mut next = request.try_clone().ok_or("public_request_not_replayable")?;
        let response = match route {
            crate::proxy_config::ProxyRouteSummary::Proxy { .. } => {
                crate::pinned_http::execute(request, &policy, &checked).await?
            }
            crate::proxy_config::ProxyRouteSummary::Direct { .. } => {
                // Preserve this hop's policy snapshot even if another window
                // rotates proxy settings while a client is being constructed.
                let builder = make_builder(request.url().as_str())?
                    .redirect(reqwest::redirect::Policy::none());
                let (builder, _) = policy
                    .apply_reqwest_policy(builder, request.url().as_str())
                    .map_err(|_| "public_proxy_policy_failed")?;
                checked
                    .pin(builder)
                    .build()
                    .map_err(|_| "public_client_failed")?
                    .execute(request)
                    .await
                    .map_err(|_| "public_request_failed")?
            }
        };
        if !is_redirect(response.status()) {
            return Ok(response);
        }
        if redirects == PublicRedirects::None {
            return Err("public_redirect_denied".into());
        }
        if hop == MAX_REDIRECTS {
            return Err("public_redirect_limit".into());
        }
        let target = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| response.url().join(value).ok())
            .ok_or("public_redirect_invalid")?;
        // Authorize and validate before resolving or contacting the next host.
        validate_public_hop(&target, &initial, redirects)?;
        let cross_origin = next.url().origin() != target.origin();
        prepare_redirect(&mut next, response.status(), target);
        if cross_origin {
            next.headers_mut().clear();
        }
        next.headers_mut().remove(REFERER);
        request = next;
    }
    unreachable!("redirect limit returns before the loop ends")
}

/// The builder must preserve host proxy policy and reject proxy routes whose
/// remote DNS cannot enforce the checked destination. Errors never expose URLs.
pub async fn send_download<F>(
    request: RequestBuilder,
    policy: &DownloadPolicy,
    make_builder: F,
    dns_timeout: Duration,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
{
    let mut request = request
        .build()
        .map_err(|_| "download_request_invalid".to_string())?;
    if request.method() != Method::GET || request.body().is_some() {
        return Err("download_request_invalid".into());
    }
    request.headers_mut().remove(HOST);
    send_checked_with_policy(
        request,
        None,
        make_builder,
        |url| async move {
            let checked =
                resolve_before_timeout(&url, Some(dns_timeout), CheckedHost::resolve(&url))
                    .await
                    .map_err(|_| "download_destination_denied".to_string())?;
            if checked
                .addrs
                .iter()
                .any(|addr| crate::egress::is_forbidden_dest_ip(&addr.ip()))
            {
                return Err("download_destination_denied".into());
            }
            Ok(checked)
        },
        Some(policy),
    )
    .await
    .map_err(|error| match error.as_str() {
        "download_policy_invalid"
        | "download_destination_denied"
        | "download_proxy_unsupported" => error,
        _ => "download_failed".to_string(),
    })
}

fn refused(url: &Url, reason: &str) -> String {
    format!("{PRIVATE_ADDRESS_PREFIX}: {url} ({reason})")
}

/// The bridge's existing literal-host guard; names need [`CheckedHost::resolve`]
/// before any connection. Kept here with the resolved-address range checks.
pub fn host_is_private(url: &str) -> bool {
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return true;
    };
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    let bare = h.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<IpAddr>().is_ok_and(ip_is_private)
}

fn ip_is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_private(v4),
        IpAddr::V6(v6) => ipv6_is_private(v6),
    }
}

fn ipv4_is_private(v4: Ipv4Addr) -> bool {
    if v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
        return true;
    }
    if v4.is_multicast() || v4.is_broadcast() {
        return true;
    }
    let [a, b, ..] = v4.octets();
    // 100.64.0.0/10 CGNAT + 240.0.0.0/4 reserved.
    (a == 100 && (64..=127).contains(&b)) || a >= 240
}

fn ipv6_is_private(v6: Ipv6Addr) -> bool {
    if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
        return true;
    }
    if let Some(v4) = v6.to_ipv4() {
        return ipv4_is_private(v4);
    }
    let first = v6.segments()[0];
    (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
}

/// A DNS override that can only be constructed after checking every answer.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CheckedHost {
    host: String,
    addrs: Vec<SocketAddr>,
}

impl CheckedHost {
    pub(crate) fn addresses(&self) -> &[SocketAddr] {
        &self.addrs
    }
    async fn resolve(url: &Url) -> Result<Self, String> {
        Self::resolve_with(url, |host, port| async move {
            tokio::net::lookup_host((host.as_str(), port))
                .await
                .map(|addrs| addrs.collect())
        })
        .await
    }

    async fn resolve_with<F, Fut>(url: &Url, resolve: F) -> Result<Self, String>
    where
        F: FnOnce(String, u16) -> Fut,
        Fut: Future<Output = std::io::Result<Vec<SocketAddr>>>,
    {
        if host_is_private(url.as_str()) {
            return Err(refused(url, "blocked host"));
        }
        let host = url.host_str().ok_or_else(|| refused(url, "missing host"))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| refused(url, "missing port"))?;
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        let addrs = match bare.parse::<IpAddr>() {
            Ok(ip) => vec![SocketAddr::new(ip, port)],
            Err(_) => resolve(host.to_string(), port)
                .await
                .map_err(|_| refused(url, "DNS resolution failed"))?,
        };
        if addrs.is_empty() || addrs.iter().any(|addr| ip_is_private(addr.ip())) {
            return Err(refused(url, "DNS returned no public-only address set"));
        }
        Ok(Self {
            host: host.to_string(),
            addrs,
        })
    }

    fn pin(&self, builder: ClientBuilder) -> ClientBuilder {
        builder.resolve_to_addrs(&self.host, &self.addrs)
    }
}

pub fn redirect_policy(mode: Option<&str>) -> Result<reqwest::redirect::Policy, String> {
    Ok(match mode.unwrap_or("follow") {
        "follow" => reqwest::redirect::Policy::limited(MAX_REDIRECTS),
        "manual" => reqwest::redirect::Policy::none(),
        "error" => reqwest::redirect::Policy::custom(|attempt| attempt.error("redirect blocked")),
        value => return Err(format!("invalid redirect mode: {value}")),
    })
}

/// Send unguarded requests through their original client unchanged. Guarded
/// requests get a fresh, checked DNS override per hop, including same-host
/// redirects. `make_builder` reapplies the caller's timeouts and proxy policy
/// for the actual hop URL (including proxy bypass rules).
pub async fn send<F>(
    request: RequestBuilder,
    block_private: Option<bool>,
    redirect: Option<&str>,
    make_builder: F,
    dns_timeout: Option<Duration>,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
{
    if block_private != Some(true) {
        return request.send().await.map_err(request_failed);
    }
    let request = request.build().map_err(request_failed)?;
    send_checked(request, redirect, make_builder, |url| async move {
        resolve_before_timeout(&url, dns_timeout, CheckedHost::resolve(&url)).await
    })
    .await
}

async fn resolve_before_timeout(
    url: &Url,
    timeout: Option<Duration>,
    resolution: impl Future<Output = Result<CheckedHost, String>>,
) -> Result<CheckedHost, String> {
    match timeout {
        Some(timeout) => tokio::time::timeout(timeout, resolution)
            .await
            .map_err(|_| refused(url, "DNS resolution timed out"))?,
        None => resolution.await,
    }
}

fn request_failed(error: reqwest::Error) -> String {
    format!("request failed: {}", error.without_url())
}

async fn send_checked<F, R, Fut>(
    request: Request,
    redirect: Option<&str>,
    make_builder: F,
    resolve: R,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
    R: Fn(Url) -> Fut,
    Fut: Future<Output = Result<CheckedHost, String>>,
{
    send_checked_with_policy(request, redirect, make_builder, resolve, None).await
}

async fn send_checked_with_policy<F, R, Fut>(
    mut request: Request,
    redirect: Option<&str>,
    make_builder: F,
    resolve: R,
    download_policy: Option<&DownloadPolicy>,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
    R: Fn(Url) -> Fut,
    Fut: Future<Output = Result<CheckedHost, String>>,
{
    let follow = redirect.unwrap_or("follow") == "follow";
    for hop in 0..=MAX_REDIRECTS {
        if let Some(policy) = download_policy {
            policy.validate(request.url())?;
            // A signed path/query is a credential too. Never synthesize Referer.
            request.headers_mut().remove(REFERER);
        }
        // Never rely on a proxy's DNS override support. Even a remote-DNS
        // HTTP/SOCKS route must pass this local check before it is sent.
        let checked = resolve(request.url().clone()).await?;
        let mut builder = make_builder(request.url().as_str())?;
        if follow {
            builder = builder.redirect(reqwest::redirect::Policy::none());
        }
        let client = checked
            .pin(builder)
            .build()
            .map_err(|error| format!("client build failed: {error}"))?;
        // Bridge bodies are buffered bytes, so replaying a 307/308 is safe.
        let mut next = request
            .try_clone()
            .ok_or_else(|| "request body cannot be replayed".to_string())?;
        let response = client.execute(request).await.map_err(request_failed)?;
        if !follow || !is_redirect(response.status()) {
            return Ok(response);
        }
        let Some(target) = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| response.url().join(value).ok())
        else {
            return Ok(response);
        };
        if hop == MAX_REDIRECTS {
            return Err("request failed: too many redirects".into());
        }
        if !matches!(target.scheme(), "http" | "https") {
            return Err("request failed: redirect to a non-HTTP(S) URL".into());
        }
        prepare_redirect(&mut next, response.status(), target);
        request = next;
    }
    unreachable!("redirect limit returns before the loop ends")
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

fn prepare_redirect(request: &mut Request, status: StatusCode, target: Url) {
    if (status == StatusCode::SEE_OTHER && request.method() != Method::HEAD)
        || (matches!(status.as_u16(), 301 | 302) && request.method() != Method::GET)
    {
        *request.method_mut() = Method::GET;
        *request.body_mut() = None;
        for name in [
            CONTENT_LENGTH,
            CONTENT_TYPE,
            CONTENT_ENCODING,
            TRANSFER_ENCODING,
        ] {
            request.headers_mut().remove(name);
        }
    }
    if request.url().origin() != target.origin() {
        for name in [
            AUTHORIZATION,
            COOKIE,
            PROXY_AUTHORIZATION,
            WWW_AUTHENTICATE,
            HOST,
        ] {
            request.headers_mut().remove(name);
        }
        request.headers_mut().remove("cookie2");
    }
    // Match reqwest's automatic Referer behavior without leaking userinfo or
    // sending an HTTPS URL as a Referer to a plaintext destination.
    if request.url().scheme() == "https" && target.scheme() == "http" {
        request.headers_mut().remove(REFERER);
    } else {
        let mut referer = request.url().clone();
        let _ = referer.set_username("");
        let _ = referer.set_password(None);
        referer.set_fragment(None);
        if let Ok(value) = referer.as_str().parse() {
            request.headers_mut().insert(REFERER, value);
        }
    }
    *request.url_mut() = target;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};

    #[test]
    fn public_redirects_are_https_only_and_scope_token_paths() {
        let initial = Url::parse("https://api.telegram.org/file/botSECRET/photo")
            .unwrap()
            .origin();
        assert!(validate_public_hop(
            &Url::parse("https://api.telegram.org/file/new").unwrap(),
            &initial,
            PublicRedirects::SameOrigin
        )
        .is_ok());
        assert!(validate_public_hop(
            &Url::parse("https://cdn.example/photo").unwrap(),
            &initial,
            PublicRedirects::SameOrigin
        )
        .is_err());
        assert!(validate_public_hop(
            &Url::parse("https://cdn.example/photo").unwrap(),
            &initial,
            PublicRedirects::Delegated
        )
        .is_ok());
        for target in [
            "http://cdn.example/image",
            "https://127.0.0.1/image",
            "https://user:SECRET@cdn.example/image",
        ] {
            let error = validate_public_hop(
                &Url::parse(target).unwrap(),
                &initial,
                PublicRedirects::Delegated,
            )
            .unwrap_err();
            assert!(!error.contains("SECRET"));
        }
    }

    #[tokio::test]
    async fn delegated_public_images_clear_all_headers_before_the_cdn_hop() {
        let (second, second_cert, second_task) = tls_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nDATA".to_vec(),
        )
        .await;
        let redirect = format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: https://public.test:{}/image\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", second.port());
        let (first, first_cert, first_task) = tls_response(redirect.into_bytes()).await;
        let builder = |_: &str| {
            Ok(reqwest::Client::builder()
                .no_proxy()
                .add_root_certificate(first_cert.clone())
                .add_root_certificate(second_cert.clone()))
        };
        let request = builder("")
            .unwrap()
            .build()
            .unwrap()
            .get(format!("https://public.test:{}/media", first.port()))
            .header(AUTHORIZATION, "Bearer secret")
            .header(COOKIE, "cookie=secret")
            .header("x-private-token", "secret")
            .header(REFERER, "https://source.test/token")
            .build()
            .unwrap();
        let response = send_pinned_with_policy(
            request,
            PublicRedirects::Delegated,
            builder,
            |url| async move {
                Ok(CheckedHost {
                    host: "public.test".into(),
                    addrs: vec![SocketAddr::from(([127, 0, 0, 1], url.port().unwrap()))],
                })
            },
            || Ok(crate::proxy_config::ProxyConfig::default()),
        )
        .await
        .unwrap();
        assert_eq!(
            crate::http_download::read_bounded_response(response, 4)
                .await
                .unwrap(),
            b"DATA"
        );
        let first_request = String::from_utf8(first_task.await.unwrap())
            .unwrap()
            .to_lowercase();
        assert!(first_request.contains("authorization: bearer secret"));
        assert!(!first_request.contains("referer:"));
        let second_request = String::from_utf8(second_task.await.unwrap())
            .unwrap()
            .to_lowercase();
        for header in ["authorization:", "cookie:", "x-private-token:", "referer:"] {
            assert!(!second_request.contains(header));
        }
    }

    #[tokio::test]
    async fn token_path_redirect_is_refused_before_resolving_the_other_origin() {
        let (first, cert, task) = tls_response(b"HTTP/1.1 302 Found\r\nLocation: https://other.test/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        let builder = |_: &str| {
            Ok(reqwest::Client::builder()
                .no_proxy()
                .add_root_certificate(cert.clone()))
        };
        let request = builder("")
            .unwrap()
            .build()
            .unwrap()
            .get(format!(
                "https://public.test:{}/botSECRET/photo",
                first.port()
            ))
            .build()
            .unwrap();
        let resolutions = AtomicUsize::new(0);
        let error = send_pinned_with_policy(
            request,
            PublicRedirects::SameOrigin,
            builder,
            |url| {
                resolutions.fetch_add(1, Ordering::SeqCst);
                async move {
                    Ok(CheckedHost {
                        host: url.host_str().unwrap().into(),
                        addrs: vec![first],
                    })
                }
            },
            || Ok(crate::proxy_config::ProxyConfig::default()),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "public_redirect_denied");
        assert_eq!(resolutions.load(Ordering::SeqCst), 1);
        assert!(!error.contains("SECRET"));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn pinned_public_redirect_checks_dns_again_before_a_same_host_retry() {
        let (first, cert, task) = tls_response(b"HTTP/1.1 308 Permanent Redirect\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        let builder = |_: &str| {
            Ok(reqwest::Client::builder()
                .no_proxy()
                .add_root_certificate(cert.clone()))
        };
        let request = builder("")
            .unwrap()
            .build()
            .unwrap()
            .get(format!("https://public.test:{}/first", first.port()))
            .build()
            .unwrap();
        let resolutions = AtomicUsize::new(0);
        let error = send_pinned_with_policy(
            request,
            PublicRedirects::Delegated,
            builder,
            |url| {
                let attempt = resolutions.fetch_add(1, Ordering::SeqCst);
                async move {
                    if attempt > 0 {
                        return Err("public_destination_denied".into());
                    }
                    Ok(CheckedHost {
                        host: url.host_str().unwrap().into(),
                        addrs: vec![first],
                    })
                }
            },
            || Ok(crate::proxy_config::ProxyConfig::default()),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "public_destination_denied");
        assert_eq!(resolutions.load(Ordering::SeqCst), 2);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn a_readonly_post_cannot_follow_307_to_another_same_origin_endpoint() {
        let (first,cert,task)=tls_response(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /write-endpoint\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()).await;
        let builder = |_: &str| {
            Ok(reqwest::Client::builder()
                .no_proxy()
                .add_root_certificate(cert.clone()))
        };
        let request = builder("")
            .unwrap()
            .build()
            .unwrap()
            .post(format!(
                "https://public.test:{}/read-endpoint",
                first.port()
            ))
            .body(r#"{"userid":"staff"}"#)
            .build()
            .unwrap();
        let resolutions = AtomicUsize::new(0);
        let error = send_pinned_with_policy(
            request,
            PublicRedirects::None,
            builder,
            |url| {
                resolutions.fetch_add(1, Ordering::SeqCst);
                async move {
                    Ok(CheckedHost {
                        host: url.host_str().unwrap().into(),
                        addrs: vec![first],
                    })
                }
            },
            || Ok(crate::proxy_config::ProxyConfig::default()),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "public_redirect_denied");
        assert_eq!(resolutions.load(Ordering::SeqCst), 1);
        task.await.unwrap();
    }

    #[test]
    fn download_policy_rejects_ungranted_insecure_and_credentialed_urls() {
        let policy = DownloadPolicy {
            allowed_origins: vec!["https://public.test".into()],
            max_bytes: 4,
        };
        assert!(policy
            .validate(&Url::parse("https://public.test/signed?token=secret").unwrap())
            .is_ok());
        for url in [
            "http://public.test/",
            "https://other.test/",
            "https://user:secret@public.test/",
            "https://127.0.0.1/",
            "https://public.test:8443/",
        ] {
            let error = policy.validate(&Url::parse(url).unwrap()).unwrap_err();
            assert_eq!(error, "download_destination_denied");
            assert!(!error.contains("secret"));
        }
        for max_bytes in [0, MAX_DOWNLOAD_BYTES + 1] {
            assert_eq!(
                DownloadPolicy {
                    max_bytes,
                    ..policy.clone()
                }
                .validate(&Url::parse("https://public.test/").unwrap())
                .unwrap_err(),
                "download_policy_invalid"
            );
        }
    }

    async fn tls_response(
        response: Vec<u8>,
    ) -> (
        SocketAddr,
        reqwest::Certificate,
        tokio::task::JoinHandle<Vec<u8>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        crate::proxy_config::ensure_crypto_provider();
        let certified = rcgen::generate_simple_self_signed(vec!["public.test".into()]).unwrap();
        let certificate = certified.cert.der().clone();
        let root = reqwest::Certificate::from_der(certificate.as_ref()).unwrap();
        let key =
            rustls::pki_types::PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
        let config = rustls::ServerConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key.into())
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut stream = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(config))
                .accept(tcp)
                .await
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                let n = stream.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..n]);
            }
            stream.write_all(&response).await.unwrap();
            stream.shutdown().await.unwrap();
            request
        });
        (addr, root, task)
    }

    #[tokio::test]
    async fn strict_tls_redirect_preserves_bytes_without_forwarding_credentials_or_referer() {
        let body = vec![0, 255, 128, b'P', b'K', 3, 4];
        let mut wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        wire.extend_from_slice(&body);
        let (second, second_cert, second_task) = tls_response(wire).await;
        let redirect = format!("HTTP/1.1 302 Found\r\nLocation: https://public.test:{}/end\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", second.port());
        let (first, first_cert, first_task) = tls_response(redirect.into_bytes()).await;
        let first_origin = format!("https://public.test:{}", first.port());
        let policy = DownloadPolicy {
            allowed_origins: vec![
                first_origin.clone(),
                format!("https://public.test:{}", second.port()),
            ],
            max_bytes: body.len(),
        };
        let builder = |_: &str| {
            Ok(reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .add_root_certificate(first_cert.clone())
                .add_root_certificate(second_cert.clone()))
        };
        let request = builder("")
            .unwrap()
            .build()
            .unwrap()
            .get(format!("{first_origin}/secret-path?token=secret"))
            .header(AUTHORIZATION, "Bearer secret")
            .header(COOKIE, "token=secret")
            .header(REFERER, "https://secret.test/path?secret")
            .build()
            .unwrap();
        let response = send_checked_with_policy(
            request,
            None,
            builder,
            |url| {
                let addr = if url.port() == Some(first.port()) {
                    first
                } else {
                    second
                };
                local_origin(url, addr)
            },
            Some(&policy),
        )
        .await
        .unwrap();
        assert_eq!(
            crate::http_download::read_bounded_response(response, policy.max_bytes)
                .await
                .unwrap(),
            body
        );
        assert!(String::from_utf8_lossy(&first_task.await.unwrap()).contains("Bearer secret"));
        let second_request = String::from_utf8(second_task.await.unwrap())
            .unwrap()
            .to_lowercase();
        assert!(!second_request.contains("authorization:"));
        assert!(!second_request.contains("cookie:"));
        assert!(!second_request.contains("referer:"));
        assert!(!second_request.contains("secret"));
    }

    #[tokio::test]
    async fn strict_tls_redirect_checks_policy_before_next_connection() {
        for target in [
            "http://public.test/end",
            "https://other.test/secret?token=secret",
            "https://user:secret@public.test/end",
            "https://127.0.0.1/end",
        ] {
            let response = format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let (addr, certificate, task) = tls_response(response.into_bytes()).await;
            let origin = format!("https://public.test:{}", addr.port());
            let policy = DownloadPolicy {
                allowed_origins: vec![origin.clone()],
                max_bytes: 4,
            };
            let builder = |_: &str| {
                Ok(reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(3))
                    .redirect(reqwest::redirect::Policy::none())
                    .add_root_certificate(certificate.clone()))
            };
            let request = builder("")
                .unwrap()
                .build()
                .unwrap()
                .get(format!("{origin}/start"))
                .build()
                .unwrap();
            let calls = AtomicUsize::new(0);
            let error = send_checked_with_policy(
                request,
                None,
                builder,
                |url| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    local_origin(url, addr)
                },
                Some(&policy),
            )
            .await
            .unwrap_err();
            assert_eq!(error, "download_destination_denied");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn stalled_dns_is_bounded_by_the_connection_timeout() {
        let url = Url::parse("https://public.test/").unwrap();
        let error =
            resolve_before_timeout(&url, Some(Duration::from_millis(1)), std::future::pending())
                .await
                .unwrap_err();
        assert!(error.starts_with(PRIVATE_ADDRESS_PREFIX));
        assert!(error.contains("DNS resolution timed out"));
    }

    struct UnexpectedDns;

    impl reqwest::dns::Resolve for UnexpectedDns {
        fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
            panic!("the checked override must prevent a second DNS resolution")
        }
    }

    #[tokio::test]
    async fn the_client_connects_to_the_pin_without_resolving_again() {
        crate::proxy_config::ensure_crypto_provider();
        let server = MockServer::start().await;
        Mock::given(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("pinned"))
            .mount(&server)
            .await;
        let addr = *server.address();
        let builder = |_: &str| {
            Ok(reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .dns_resolver(std::sync::Arc::new(UnexpectedDns)))
        };
        let request = reqwest::Client::new()
            .get(format!("http://public.test:{}/", addr.port()))
            .build()
            .unwrap();
        let response = send_checked(request, None, builder, |url| local_origin(url, addr))
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "pinned");
    }

    #[tokio::test]
    async fn refuses_any_private_answer_empty_answers_and_resolution_errors() {
        let url = Url::parse("https://public.test:8443/").unwrap();
        for addresses in [
            vec!["127.0.0.1:8443"],
            vec!["8.8.8.8:8443", "10.0.0.1:8443"],
            vec!["169.254.169.254:8443"],
            vec!["[::1]:8443"],
            vec!["[::ffff:127.0.0.1]:8443"],
            vec![],
        ] {
            let result = CheckedHost::resolve_with(&url, |host, port| async move {
                assert_eq!(host, "public.test");
                assert_eq!(port, 8443);
                Ok(addresses.iter().map(|addr| addr.parse().unwrap()).collect())
            })
            .await;
            assert!(result.unwrap_err().starts_with(PRIVATE_ADDRESS_PREFIX));
        }
        let error = CheckedHost::resolve_with(&url, |_, _| async {
            Err(std::io::Error::other("resolver failed"))
        })
        .await
        .unwrap_err();
        assert!(error.starts_with(PRIVATE_ADDRESS_PREFIX));
    }

    #[tokio::test]
    async fn pins_exactly_the_checked_addresses_with_the_urls_port() {
        for (url, port) in [
            ("https://public.test/", 443),
            ("http://public.test:8080/", 8080),
        ] {
            let url = Url::parse(url).unwrap();
            let expected = vec![
                SocketAddr::new("8.8.8.8".parse().unwrap(), port),
                SocketAddr::new("2606:4700::1111".parse().unwrap(), port),
            ];
            let checked = CheckedHost::resolve_with(&url, |_, actual_port| {
                assert_eq!(actual_port, port);
                std::future::ready(Ok(expected.clone()))
            })
            .await
            .unwrap();
            assert_eq!(checked.host, "public.test");
            assert_eq!(checked.addrs, expected);
        }
    }

    #[tokio::test]
    async fn literals_keep_the_existing_ranges_without_resolving() {
        for target in ["http://8.8.8.8/", "https://[2606:4700::1111]/"] {
            let url = Url::parse(target).unwrap();
            let checked = CheckedHost::resolve_with(&url, |_, _| async {
                panic!("IP literals must not use DNS")
            })
            .await
            .unwrap();
            assert_eq!(checked.addrs.len(), 1);
        }
        for target in [
            "http://localhost/",
            "http://app.localhost./",
            "http://127.0.0.1/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://192.168.1.1/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://240.0.0.1/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://[::ffff:127.0.0.1]/",
        ] {
            assert!(
                CheckedHost::resolve(&Url::parse(target).unwrap())
                    .await
                    .is_err(),
                "{target}"
            );
        }
    }

    fn local_builder(addr: SocketAddr, redirect: Option<&str>) -> ClientBuilder {
        crate::proxy_config::ensure_crypto_provider();
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .redirect(redirect_policy(redirect).unwrap())
            .resolve_to_addrs("public.test", &[addr])
    }

    // Stand in for an allowed public origin with an in-process server. Only
    // public.test gets this test override; later hosts use real guard checks.
    async fn local_origin(url: Url, addr: SocketAddr) -> Result<CheckedHost, String> {
        if url.host_str() == Some("public.test") {
            Ok(CheckedHost {
                host: "public.test".into(),
                addrs: vec![addr],
            })
        } else {
            CheckedHost::resolve_with(&url, |_, port| async move {
                Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), port)])
            })
            .await
        }
    }

    #[tokio::test]
    async fn redirects_to_private_literals_and_rebound_names_are_refused() {
        for target in ["http://127.0.0.1/private", "http://rebound.test/private"] {
            let server = MockServer::start().await;
            Mock::given(path("/start"))
                .respond_with(ResponseTemplate::new(302).insert_header("Location", target))
                .mount(&server)
                .await;
            let addr = *server.address();
            let request = local_builder(addr, None)
                .build()
                .unwrap()
                .get(format!("http://public.test:{}/start", addr.port()))
                .build()
                .unwrap();
            let error = send_checked(
                request,
                None,
                |_| Ok(local_builder(addr, None)),
                |url| local_origin(url, addr),
            )
            .await
            .unwrap_err();
            assert!(error.starts_with(PRIVATE_ADDRESS_PREFIX), "{error}");
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn same_host_redirects_cannot_rebind_to_a_private_address() {
        let server = MockServer::start().await;
        Mock::given(path("/start"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", "/end"))
            .mount(&server)
            .await;
        let addr = *server.address();
        let calls = AtomicUsize::new(0);
        let request = local_builder(addr, None)
            .build()
            .unwrap()
            .get(format!("http://public.test:{}/start", addr.port()))
            .build()
            .unwrap();
        let error = send_checked(
            request,
            None,
            |_| Ok(local_builder(addr, None)),
            |url| {
                let first = calls.fetch_add(1, Ordering::SeqCst) == 0;
                async move {
                    if first {
                        local_origin(url, addr).await
                    } else {
                        CheckedHost::resolve_with(&url, |_, port| async move {
                            Ok(vec![SocketAddr::new("127.0.0.1".parse().unwrap(), port)])
                        })
                        .await
                    }
                }
            },
        )
        .await
        .unwrap_err();
        assert!(error.starts_with(PRIVATE_ADDRESS_PREFIX));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn followed_cross_origin_post_redirect_sends_get_without_credentials_or_body() {
        let first = MockServer::start().await;
        let second = MockServer::start().await;
        Mock::given(path("/start"))
            .respond_with(ResponseTemplate::new(303).insert_header(
                "Location",
                format!("http://public.test:{}/end", second.address().port()),
            ))
            .mount(&first)
            .await;
        Mock::given(path("/end"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&second)
            .await;
        let first_addr = *first.address();
        let second_addr = *second.address();
        let routes = std::sync::Mutex::new(Vec::new());
        let request = local_builder(first_addr, None)
            .build()
            .unwrap()
            .post(format!("http://public.test:{}/start", first_addr.port()))
            .header(AUTHORIZATION, "Bearer secret")
            .header(COOKIE, "secret=true")
            .body("payload")
            .build()
            .unwrap();
        let response = send_checked(
            request,
            None,
            |url| {
                routes.lock().unwrap().push(url.to_string());
                Ok(local_builder(first_addr, None))
            },
            |url| {
                let addr = if url.port() == Some(first_addr.port()) {
                    first_addr
                } else {
                    second_addr
                };
                local_origin(url, addr)
            },
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(routes.lock().unwrap().len(), 2);
        let received = second.received_requests().await.unwrap();
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].method, Method::GET);
        assert!(received[0].body.is_empty());
        assert!(!received[0].headers.contains_key(AUTHORIZATION));
        assert!(!received[0].headers.contains_key(COOKIE));
    }

    #[tokio::test]
    async fn none_and_false_preserve_automatic_redirects_and_response_bytes() {
        let server = MockServer::start().await;
        Mock::given(path("/start"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("Location", format!("{}/end", server.uri())),
            )
            .mount(&server)
            .await;
        Mock::given(path("/end"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![0, 255, 42]))
            .mount(&server)
            .await;
        for block_private in [None, Some(false)] {
            let request = local_builder(*server.address(), None)
                .build()
                .unwrap()
                .get(format!(
                    "http://public.test:{}/start",
                    server.address().port()
                ));
            let response = send(
                request,
                block_private,
                None,
                |_| panic!("unguarded send must use the original client"),
                None,
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.bytes().await.unwrap().as_ref(), &[0, 255, 42]);
        }
    }

    #[tokio::test]
    async fn guarded_manual_and_error_modes_keep_their_redirect_behavior() {
        for mode in ["manual", "error"] {
            let server = MockServer::start().await;
            Mock::given(path("/"))
                .respond_with(
                    ResponseTemplate::new(302)
                        .insert_header("Location", "http://127.0.0.1/private"),
                )
                .mount(&server)
                .await;
            let addr = *server.address();
            let request = local_builder(addr, Some(mode))
                .build()
                .unwrap()
                .get(format!("http://public.test:{}/", addr.port()))
                .build()
                .unwrap();
            let result = send_checked(
                request,
                Some(mode),
                |_| Ok(local_builder(addr, Some(mode))),
                |url| local_origin(url, addr),
            )
            .await;
            if mode == "manual" {
                assert_eq!(result.unwrap().status(), StatusCode::FOUND);
            } else {
                assert!(result.unwrap_err().starts_with("request failed:"));
            }
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn each_hop_is_resolved_and_the_ten_redirect_limit_is_enforced() {
        let server = MockServer::start().await;
        Mock::given(path("/loop"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", "/loop"))
            .mount(&server)
            .await;
        let addr = *server.address();
        let calls = AtomicUsize::new(0);
        let request = local_builder(addr, None)
            .build()
            .unwrap()
            .get(format!("http://public.test:{}/loop", addr.port()))
            .build()
            .unwrap();
        let error = send_checked(
            request,
            None,
            |_| Ok(local_builder(addr, None)),
            |url| {
                calls.fetch_add(1, Ordering::SeqCst);
                local_origin(url, addr)
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("too many redirects"));
        assert_eq!(calls.load(Ordering::SeqCst), MAX_REDIRECTS + 1);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            MAX_REDIRECTS + 1
        );
    }

    #[test]
    fn redirects_rewrite_methods_and_bodies_and_strip_cross_origin_credentials() {
        crate::proxy_config::ensure_crypto_provider();
        for status in [301, 302, 303, 307, 308] {
            let client = reqwest::Client::new();
            let mut request = client
                .post("https://public.test/start")
                .header(AUTHORIZATION, "Bearer secret")
                .header(COOKIE, "session=secret")
                .header("cookie2", "session=legacy-secret")
                .header(WWW_AUTHENTICATE, "Basic secret")
                .header(CONTENT_TYPE, "text/plain")
                .header(CONTENT_LENGTH, "7")
                .body("payload")
                .build()
                .unwrap();
            prepare_redirect(
                &mut request,
                StatusCode::from_u16(status).unwrap(),
                Url::parse("https://other.test/end").unwrap(),
            );
            assert!(!request.headers().contains_key(AUTHORIZATION));
            assert!(!request.headers().contains_key(COOKIE));
            assert!(!request.headers().contains_key("cookie2"));
            assert!(!request.headers().contains_key(WWW_AUTHENTICATE));
            if status <= 303 {
                assert_eq!(request.method(), Method::GET);
                assert!(request.body().is_none());
                assert!(!request.headers().contains_key(CONTENT_TYPE));
                assert!(!request.headers().contains_key(CONTENT_LENGTH));
            } else {
                assert_eq!(request.method(), Method::POST);
                assert_eq!(request.body().unwrap().as_bytes().unwrap(), b"payload");
            }
        }
        let mut request = reqwest::Client::new()
            .get("https://public.test/start")
            .header(AUTHORIZATION, "Bearer secret")
            .header(COOKIE, "session=secret")
            .build()
            .unwrap();
        prepare_redirect(
            &mut request,
            StatusCode::FOUND,
            Url::parse("https://public.test/end").unwrap(),
        );
        assert!(request.headers().contains_key(AUTHORIZATION));
        assert!(request.headers().contains_key(COOKIE));
        prepare_redirect(
            &mut request,
            StatusCode::FOUND,
            Url::parse("http://public.test/end").unwrap(),
        );
        assert!(!request.headers().contains_key(AUTHORIZATION));
        assert!(!request.headers().contains_key(COOKIE));
        assert!(!request.headers().contains_key(REFERER));
    }

    #[tokio::test]
    async fn active_http_proxy_still_checks_local_dns_before_sending() {
        crate::proxy_config::ensure_crypto_provider();
        use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};
        let proxy = MockServer::start().await;
        Mock::given(path("/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("proxy resolves remotely"))
            .mount(&proxy)
            .await;
        let config = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".into(),
            port: proxy.address().port(),
            username: None,
            password: None,
            bypass: vec![],
            proxy_websockets: true,
        };
        let make_builder = |url: &str| {
            config
                .apply_reqwest_policy(
                    reqwest::Client::builder().timeout(Duration::from_secs(3)),
                    url,
                )
                .map(|(builder, _)| builder)
                .map_err(|error| error.to_string())
        };
        for private in [false, true] {
            let request = make_builder("http://public.test/")
                .unwrap()
                .build()
                .unwrap()
                .get("http://public.test/")
                .build()
                .unwrap();
            let result = send_checked(request, None, make_builder, |url| async move {
                CheckedHost::resolve_with(&url, |_, port| async move {
                    Ok(vec![SocketAddr::new(
                        if private { "127.0.0.1" } else { "8.8.8.8" }
                            .parse()
                            .unwrap(),
                        port,
                    )])
                })
                .await
            })
            .await;
            if private {
                assert!(result.unwrap_err().starts_with(PRIVATE_ADDRESS_PREFIX));
            } else {
                // The public address is checked/pinned, but the local proxy
                // still receives the hostname and owns remote resolution.
                assert_eq!(
                    result.unwrap().text().await.unwrap(),
                    "proxy resolves remotely"
                );
            }
        }
        assert_eq!(proxy.received_requests().await.unwrap().len(), 1);
    }
}
