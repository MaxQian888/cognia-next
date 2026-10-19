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
struct CheckedHost {
    host: String,
    addrs: Vec<SocketAddr>,
}

impl CheckedHost {
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
    mut request: Request,
    redirect: Option<&str>,
    make_builder: F,
    resolve: R,
) -> Result<Response, String>
where
    F: Fn(&str) -> Result<ClientBuilder, String>,
    R: Fn(Url) -> Fut,
    Fut: Future<Output = Result<CheckedHost, String>>,
{
    let follow = redirect.unwrap_or("follow") == "follow";
    for hop in 0..=MAX_REDIRECTS {
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
