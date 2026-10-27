//! HTTP over a checked-IP proxy tunnel. Policy/DNS validation stays in guarded_http.
//! The original URL supplies TLS identity and HTTP Host; proxies never resolve it.

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};

use http_body_util::Full;
use hyper::body::{Body, Bytes, Frame, Incoming, SizeHint};
use hyper_util::rt::TokioIo;
use reqwest::{Request, Response, ResponseBuilderExt};

use crate::proxy_config::{wsproxy, ProxyConfig};

struct ConnectionDriver(tokio::task::JoinHandle<()>);

impl Drop for ConnectionDriver {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct DrivenBody {
    inner: Pin<Box<Incoming>>,
    _driver: ConnectionDriver,
}

impl Body for DrivenBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        self.get_mut().inner.as_mut().poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn native_tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(config) = CONFIG.get() {
        return Ok(config.clone());
    }
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        roots.add(cert).map_err(|_| "pinned_tls_roots_failed")?;
    }
    if roots.is_empty() {
        return Err("pinned_tls_roots_unavailable".into());
    }
    let config = Arc::new(
        rustls::ClientConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .map_err(|_| "pinned_tls_config_failed")?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    );
    let _ = CONFIG.set(config.clone());
    Ok(CONFIG.get().cloned().unwrap_or(config))
}

/// Caller owns the total deadline, every address's public-DNS admission, and
/// redirect policy. Dropping the returned body cancels its connection driver.
pub(crate) async fn execute(
    request: Request,
    proxy: &ProxyConfig,
    checked: &crate::guarded_http::CheckedHost,
) -> Result<Response, String> {
    execute_with_tls(request, proxy, checked.addresses(), native_tls_config()?).await
}

async fn execute_with_tls(
    request: Request,
    proxy: &ProxyConfig,
    checked_addresses: &[SocketAddr],
    tls_config: Arc<rustls::ClientConfig>,
) -> Result<Response, String> {
    let url = request.url().clone();
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("pinned_destination_invalid".into());
    }
    let host = url.host_str().ok_or("pinned_destination_invalid")?;
    let server_name = rustls::pki_types::ServerName::try_from(
        host.trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned(),
    )
    .map_err(|_| "pinned_destination_invalid")?;
    let body = match request.body() {
        Some(body) => body.as_bytes().ok_or("pinned_body_not_buffered")?.to_vec(),
        None => Vec::new(),
    };
    // Avatar/profile requests are small. Never replay an unbounded request body.
    if body.len() > 64 * 1024 {
        return Err("pinned_body_too_large".into());
    }
    let mut tunnel = None;
    for address in checked_addresses.iter().take(8) {
        if let Ok(stream) = wsproxy::connect_via_proxy_resolved(proxy, *address).await {
            tunnel = Some(stream);
            break;
        }
    }
    let tunnel = tunnel.ok_or("pinned_proxy_connect_failed")?;
    let stream = tokio_rustls::TlsConnector::from(tls_config)
        .connect(server_name, tunnel)
        .await
        .map_err(|_| "pinned_tls_failed")?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|_| "pinned_http_handshake_failed")?;
    let driver = ConnectionDriver(tokio::spawn(async move {
        let _ = connection.await;
    }));
    let target = &url[url::Position::BeforePath..url::Position::AfterQuery];
    let authority = &url[url::Position::BeforeHost..url::Position::AfterPort];
    let mut outbound = hyper::Request::builder()
        .method(request.method().clone())
        .uri(target)
        .body(Full::new(Bytes::from(body)))
        .map_err(|_| "pinned_request_invalid")?;
    *outbound.headers_mut() = request.headers().clone();
    for name in [
        reqwest::header::PROXY_AUTHORIZATION,
        reqwest::header::TRANSFER_ENCODING,
        reqwest::header::CONTENT_LENGTH,
        reqwest::header::CONNECTION,
    ] {
        outbound.headers_mut().remove(name);
    }
    outbound.headers_mut().insert(
        reqwest::header::HOST,
        authority.parse().map_err(|_| "pinned_request_invalid")?,
    );
    let response = sender
        .send_request(outbound)
        .await
        .map_err(|_| "pinned_request_failed")?;
    let (parts, body) = response.into_parts();
    let mut builder = hyper::Response::builder()
        .status(parts.status)
        .version(parts.version)
        .url(url);
    *builder.headers_mut().ok_or("pinned_response_invalid")? = parts.headers;
    let response = builder
        .body(reqwest::Body::wrap(DrivenBody {
            inner: Box::pin(body),
            _driver: driver,
        }))
        .map_err(|_| "pinned_response_invalid")?;
    Ok(Response::from(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::proxy_config::{ProxyMode, ProxyProtocol};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn origin(
        response: Vec<u8>,
        hold_open: bool,
    ) -> (
        SocketAddr,
        Arc<rustls::ClientConfig>,
        tokio::task::JoinHandle<Vec<u8>>,
    ) {
        let cert = rcgen::generate_simple_self_signed(vec!["public.test".into()]).unwrap();
        let der = cert.cert.der().clone();
        let key = rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der());
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let server = rustls::ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![der.clone()], key.into())
            .unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(der).unwrap();
        let client = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let Ok(mut stream) = tokio_rustls::TlsAcceptor::from(Arc::new(server))
                .accept(stream)
                .await
            else {
                return Vec::new();
            };
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let byte = stream.read_u8().await.unwrap();
                request.push(byte);
            }
            let body_len = std::str::from_utf8(&request)
                .unwrap()
                .lines()
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                .unwrap_or(0);
            assert!(body_len <= 64 * 1024);
            let mut body = vec![0; body_len];
            stream.read_exact(&mut body).await.unwrap();
            request.extend(body);
            stream.write_all(&response).await.unwrap();
            if hold_open {
                let mut byte = [0];
                while stream.read(&mut byte).await.is_ok_and(|n| n > 0) {}
            } else {
                let _ = stream.shutdown().await;
            }
            request
        });
        (addr, Arc::new(client), task)
    }

    async fn http_proxy(
        target: SocketAddr,
        refuse: bool,
    ) -> (ProxyConfig, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(stream.read_u8().await.unwrap());
            }
            if refuse {
                stream
                    .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
            } else {
                let mut upstream = tokio::net::TcpStream::connect(target).await.unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await
                    .unwrap();
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
            }
            String::from_utf8(head).unwrap()
        });
        (
            ProxyConfig {
                mode: ProxyMode::Manual,
                protocol: ProxyProtocol::Http,
                host: addr.ip().to_string(),
                port: addr.port(),
                username: Some("user".into()),
                password: Some("secret".into()),
                ..Default::default()
            },
            task,
        )
    }

    fn request(addr: SocketAddr, host: &str) -> Request {
        crate::proxy_config::ensure_crypto_provider();
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!(
                "https://{host}:{}/photo?token=URL_SECRET",
                addr.port()
            ))
            .header(reqwest::header::HOST, "wrong.test")
            .header(reqwest::header::PROXY_AUTHORIZATION, "Bearer MUST_NOT_LEAK")
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn proxy_tunnel_uses_the_checked_ip_but_preserves_origin_tls_and_http_host() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (addr, tls, origin_task) = origin(
                b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nDATA".to_vec(),
                false,
            )
            .await;
            let (proxy, proxy_task) = http_proxy(addr, false).await;
            let response = execute_with_tls(request(addr, "public.test"), &proxy, &[addr], tls)
                .await
                .unwrap();
            assert_eq!(response.url().host_str(), Some("public.test"));
            assert_eq!(
                crate::http_download::read_bounded_response(response, 4)
                    .await
                    .unwrap(),
                b"DATA"
            );
            let sent = String::from_utf8(origin_task.await.unwrap())
                .unwrap()
                .to_lowercase();
            assert!(sent.contains(&format!("host: public.test:{}", addr.port())));
            assert!(!sent.contains("proxy-authorization"));
            let connect = proxy_task.await.unwrap();
            assert!(connect.starts_with(&format!("CONNECT {addr} HTTP/1.1")));
            assert!(connect.contains("Proxy-Authorization: Basic "));
            assert!(!connect.contains("public.test") && !connect.contains("URL_SECRET"));
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn proxy_post_preserves_json_and_recomputes_request_framing() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (addr, tls, origin_task) = origin(
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".to_vec(),
                false,
            )
            .await;
            let (proxy, proxy_task) = http_proxy(addr, false).await;
            let payload = br#"{"userid":"staff-123"}"#;
            let mut request = request(addr, "public.test");
            *request.method_mut() = reqwest::Method::POST;
            request.url_mut().set_path("/topapi/v2/user/get");
            *request.body_mut() = Some(reqwest::Body::from(payload.to_vec()));
            for (name, value) in [
                (reqwest::header::CONTENT_TYPE, "application/json"),
                (reqwest::header::CONTENT_LENGTH, "999"),
                (reqwest::header::TRANSFER_ENCODING, "chunked"),
                (reqwest::header::CONNECTION, "CALLER_CONNECTION"),
            ] {
                request.headers_mut().insert(name, value.parse().unwrap());
            }
            let response = execute_with_tls(request, &proxy, &[addr], tls)
                .await
                .unwrap();
            assert_eq!(response.bytes().await.unwrap().as_ref(), b"OK");
            let sent = origin_task.await.unwrap();
            let head_len = sent
                .windows(4)
                .position(|part| part == b"\r\n\r\n")
                .unwrap()
                + 4;
            let head = std::str::from_utf8(&sent[..head_len])
                .unwrap()
                .to_lowercase();
            assert!(head.starts_with("post /topapi/v2/user/get?token=url_secret http/1.1\r\n"));
            assert!(head.contains("content-type: application/json\r\n"));
            assert!(head.contains(&format!("content-length: {}\r\n", payload.len())));
            assert!(!head.contains("transfer-encoding") && !head.contains("caller_connection"));
            assert!(!head.contains("proxy-authorization"));
            assert_eq!(&sent[head_len..], payload);
            let connect = proxy_task.await.unwrap();
            assert!(!connect.contains("userid") && !connect.contains("URL_SECRET"));
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn proxy_cannot_replace_the_origin_tls_identity() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (addr, tls, origin_task) = origin(Vec::new(), false).await;
            let (proxy, proxy_task) = http_proxy(addr, false).await;
            let error = execute_with_tls(request(addr, "wrong.test"), &proxy, &[addr], tls)
                .await
                .unwrap_err();
            assert_eq!(error, "pinned_tls_failed");
            assert!(!error.contains("URL_SECRET"));
            assert!(origin_task.await.unwrap().is_empty());
            proxy_task.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn proxy_refusal_never_dials_the_origin_directly() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (_, tls, origin_task) = origin(Vec::new(), false).await;
        origin_task.abort();
        let (proxy, proxy_task) = http_proxy(addr, true).await;
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            execute_with_tls(request(addr, "public.test"), &proxy, &[addr], tls),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err(), "pinned_proxy_connect_failed");
        proxy_task.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn proxy_response_reads_keep_declared_and_chunked_byte_caps() {
        for wire in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nOVERFLOW".to_vec(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n8\r\nOVERFLOW\r\n0\r\n\r\n".to_vec(),
        ] {
            tokio::time::timeout(std::time::Duration::from_secs(5),async {
                let (addr,tls,origin_task)=origin(wire,false).await;
                let (proxy,proxy_task)=http_proxy(addr,false).await;
                let response=execute_with_tls(request(addr,"public.test"),&proxy,&[addr],tls).await.unwrap();
                assert_eq!(crate::http_download::read_bounded_response(response,4).await.unwrap_err(),"download_body_too_large");
                origin_task.await.unwrap();proxy_task.await.unwrap();
            }).await.unwrap();
        }
    }

    #[tokio::test]
    async fn oversized_declared_proxy_body_is_rejected_without_waiting_for_data() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (addr, tls, origin_task) = origin(
                b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n".to_vec(),
                true,
            )
            .await;
            let (proxy, proxy_task) = http_proxy(addr, false).await;
            let response = execute_with_tls(request(addr, "public.test"), &proxy, &[addr], tls)
                .await
                .unwrap();
            assert_eq!(response.content_length(), Some(1_000_000));
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                crate::http_download::read_bounded_response(response, 4),
            )
            .await
            .unwrap();
            assert_eq!(result.unwrap_err(), "download_body_too_large");
            origin_task.await.unwrap();
            proxy_task.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn dropping_a_response_body_closes_the_proxy_and_origin_connections() {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (addr, tls, origin_task) = origin(
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n".to_vec(),
                true,
            )
            .await;
            let (proxy, proxy_task) = http_proxy(addr, false).await;
            let response = execute_with_tls(request(addr, "public.test"), &proxy, &[addr], tls)
                .await
                .unwrap();
            drop(response);
            origin_task.await.unwrap();
            proxy_task.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn dropping_a_connection_driver_cancels_its_task() {
        let task = tokio::spawn(std::future::pending::<()>());
        let handle = task.abort_handle();
        drop(ConnectionDriver(task));
        tokio::task::yield_now().await;
        assert!(handle.is_finished());
    }
}
