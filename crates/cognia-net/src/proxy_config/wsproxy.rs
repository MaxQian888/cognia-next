//! HTTP CONNECT and SOCKS5 tunneling for outbound WebSocket connections.
//!
//! `tokio-tungstenite` doesn't natively understand the user's proxy
//! settings, so when the user opts in to `proxy_websockets`, we do the
//! transport handshake ourselves and hand the resulting raw stream to
//! tungstenite's `client_async_tls_with_config`.
//!
//! Two paths:
//!   * HTTP / HTTPS proxy → open TCP to the proxy, send a CONNECT request,
//!     verify a 200 response.
//!   * SOCKS5 → use `tokio_socks::tcp::Socks5Stream::connect[_with_password]`.

use std::io::{Error as IoError, ErrorKind};
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::{ProxyConfig, ProxyProtocol};

/// Box-erased AsyncRead+AsyncWrite stream so the caller doesn't have to
/// branch on which proxy variant produced it.
pub type ProxyStream = Box<dyn AsyncReadWrite + Unpin + Send>;

pub trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> AsyncReadWrite for T {}

/// Open a TCP/SOCKS5 stream to `target_host:target_port` via the configured
/// proxy. Caller is responsible for layering TLS on top for `wss://`.
///
/// Errors are returned as `String` so they slot into the existing Tauri
/// command error pattern.
pub async fn connect_via_proxy(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<ProxyStream, String> {
    if !cfg.is_active() {
        return Err("proxy is not active".to_string());
    }
    match cfg.protocol {
        ProxyProtocol::Http => connect_http_tunnel(cfg, target_host, target_port)
            .await
            .map_err(|e| format!("HTTP CONNECT tunnel failed: {e}")),
        ProxyProtocol::Https => connect_https_tunnel(cfg, target_host, target_port)
            .await
            .map_err(|e| format!("HTTPS CONNECT tunnel failed: {e}")),
        ProxyProtocol::Socks5 => connect_socks5(cfg, (target_host, target_port))
            .await
            .map_err(|e| format!("SOCKS5 tunnel failed: {e}")),
    }
}

/// Open a tunnel to an already-resolved address without delegating target DNS
/// to the proxy. HTTP(S) CONNECT uses an IP authority and SOCKS5 uses its binary
/// IP address form. A refusal is final: no hostname retry or direct fallback.
/// The caller owns destination policy checks and the overall dial timeout.
pub async fn connect_via_proxy_resolved(
    cfg: &ProxyConfig,
    target: SocketAddr,
) -> Result<ProxyStream, String> {
    if !cfg.is_active() {
        return Err("proxy is not active".to_string());
    }
    if cfg.protocol == ProxyProtocol::Socks5 {
        return connect_socks5(cfg, target)
            .await
            .map_err(|e| format!("SOCKS5 tunnel failed: {e}"));
    }
    connect_via_proxy(cfg, &target.ip().to_string(), target.port()).await
}

async fn connect_http_tunnel(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<ProxyStream, IoError> {
    let proxy_addr = super::authority(&cfg.host, cfg.port);
    let mut stream = BufReader::new(TcpStream::connect(&proxy_addr).await?);
    establish_connect_tunnel(&mut stream, cfg, target_host, target_port).await?;
    Ok(Box::new(stream))
}

async fn connect_https_tunnel(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<ProxyStream, IoError> {
    let native = rustls_native_certs::load_native_certs();
    let mut roots = rustls::RootCertStore::empty();
    for certificate in native.certs {
        roots
            .add(certificate)
            .map_err(|error| IoError::new(ErrorKind::InvalidData, error.to_string()))?;
    }
    if roots.is_empty() {
        return Err(IoError::new(
            ErrorKind::NotFound,
            "no native TLS roots are available for the HTTPS proxy",
        ));
    }
    let tls_config = rustls::ClientConfig::builder_with_provider(
        rustls::crypto::ring::default_provider().into(),
    )
    .with_safe_default_protocol_versions()
    .map_err(|error| IoError::new(ErrorKind::InvalidData, error.to_string()))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    connect_https_tunnel_with_config(cfg, target_host, target_port, Arc::new(tls_config)).await
}

async fn connect_https_tunnel_with_config(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
    tls_config: Arc<rustls::ClientConfig>,
) -> Result<ProxyStream, IoError> {
    let proxy_addr = super::authority(&cfg.host, cfg.port);
    let tcp = TcpStream::connect(&proxy_addr).await?;
    // The bare host, not the authority: `ServerName` takes a name or an IP,
    // never a bracketed one, and never a port.
    let server_name =
        rustls::pki_types::ServerName::try_from(super::normalize_host_for_match(&cfg.host))
            .map_err(|_| IoError::new(ErrorKind::InvalidInput, "invalid HTTPS proxy hostname"))?;
    let connector = tokio_rustls::TlsConnector::from(tls_config);
    let stream = connector
        .connect(server_name, tcp)
        .await
        .map_err(|error| IoError::new(ErrorKind::ConnectionAborted, error.to_string()))?;
    let mut stream = BufReader::new(stream);
    establish_connect_tunnel(&mut stream, cfg, target_host, target_port).await?;
    Ok(Box::new(stream))
}

async fn establish_connect_tunnel<S>(
    stream: &mut S,
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<(), IoError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Bracketed authority: an IPv6 target written bare would make
    // `CONNECT ::1:443` — which a proxy reads as host `::1:443` with no port,
    // or rejects outright.
    let target = super::authority(target_host, target_port);
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: keep-alive\r\n");
    if let Some(auth) = cfg.basic_auth_header() {
        request.push_str(&format!("Proxy-Authorization: {auth}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;

    // The caller's BufReader retains any first tunnel bytes alongside the
    // response. Consume exactly the header, with a limit even if the final
    // read also contains its delimiter.
    let mut buf = Vec::with_capacity(512);
    loop {
        if buf.len() == 16 * 1024 {
            return Err(IoError::new(
                ErrorKind::InvalidData,
                "proxy response too large",
            ));
        }
        buf.push(stream.read_u8().await?);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header = String::from_utf8_lossy(&buf);
    let status_line = header.lines().next().unwrap_or("");
    let parts: Vec<&str> = status_line.split_whitespace().collect();
    let status: u16 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    if !(200..300).contains(&status) {
        return Err(IoError::new(
            ErrorKind::PermissionDenied,
            format!("proxy returned status {status}: {status_line}"),
        ));
    }
    Ok(())
}

async fn connect_socks5<'a>(
    cfg: &ProxyConfig,
    target: impl tokio_socks::IntoTargetAddr<'a>,
) -> Result<ProxyStream, IoError> {
    let proxy_addr = super::authority(&cfg.host, cfg.port);
    let stream = match (cfg.username.as_deref(), cfg.password.as_deref()) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
            tokio_socks::tcp::Socks5Stream::connect_with_password(proxy_addr.as_str(), target, u, p)
                .await
                .map_err(|e| IoError::other(e.to_string()))?
        }
        _ => tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target)
            .await
            .map_err(|e| IoError::other(e.to_string()))?,
    };
    Ok(Box::new(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy_config::{ProxyConfig, ProxyMode, ProxyProtocol};
    use std::net::{Ipv4Addr, SocketAddrV4};
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn resolved_proxy_api_rejects_inactive_config() {
        assert!(connect_via_proxy_resolved(
            &ProxyConfig::default(),
            "93.184.216.34:443".parse().unwrap()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn connect_response_read_ahead_is_retained() {
        let (client, mut proxy) = tokio::io::duplex(32768);
        let server = tokio::spawn(async move {
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(proxy.read_u8().await.unwrap());
            }
            assert!(request.starts_with(b"CONNECT 93.184.216.34:443 HTTP/1.1\r\n"));
            proxy
                .write_all(b"HTTP/1.1 200 OK\r\n\r\nfirst tunnel bytes")
                .await
                .unwrap();
        });
        let mut client = BufReader::new(client);
        establish_connect_tunnel(&mut client, &ProxyConfig::default(), "93.184.216.34", 443)
            .await
            .unwrap();
        let mut tail = Vec::new();
        client.read_to_end(&mut tail).await.unwrap();
        assert_eq!(tail, b"first tunnel bytes");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_connect_response_is_rejected_with_delimiter() {
        let (mut client, mut proxy) = tokio::io::duplex(32768);
        let server = tokio::spawn(async move {
            proxy
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nX: {}\r\n\r\n", "a".repeat(16384)).as_bytes(),
                )
                .await
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(proxy.read_u8().await.unwrap());
            }
        });
        let error =
            establish_connect_tunnel(&mut client, &ProxyConfig::default(), "93.184.216.34", 443)
                .await
                .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::InvalidData);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn resolved_http_proxy_receives_ip_authority_and_refusal_is_final() {
        for target in ["93.184.216.34:443", "[2606:4700:4700::1111]:443"] {
            for status in [200, 403] {
                let target: SocketAddr = target.parse().unwrap();
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let cfg = ProxyConfig {
                    mode: ProxyMode::Manual,
                    protocol: ProxyProtocol::Http,
                    host: "127.0.0.1".into(),
                    port: listener.local_addr().unwrap().port(),
                    ..ProxyConfig::default()
                };
                let proxy = tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        request.push(stream.read_u8().await.unwrap());
                    }
                    let request = String::from_utf8(request).unwrap();
                    assert!(request
                        .starts_with(&format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n")));
                    stream
                        .write_all(format!("HTTP/1.1 {status} Test\r\n\r\n").as_bytes())
                        .await
                        .unwrap();
                    assert!(
                        tokio::time::timeout(
                            std::time::Duration::from_millis(50),
                            listener.accept()
                        )
                        .await
                        .is_err(),
                        "must not retry rejected IP CONNECT"
                    );
                });
                let result = connect_via_proxy_resolved(&cfg, target).await;
                assert_eq!(result.is_ok(), status == 200);
                drop(result);
                proxy.await.unwrap();
            }
        }
    }

    #[tokio::test]
    async fn resolved_socks_proxy_receives_binary_ip_not_dns_name() {
        for target in ["93.184.216.34:443", "[2606:4700:4700::1111]:443"] {
            let target: SocketAddr = target.parse().unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let cfg = ProxyConfig {
                mode: ProxyMode::Manual,
                protocol: ProxyProtocol::Socks5,
                host: "127.0.0.1".into(),
                port: listener.local_addr().unwrap().port(),
                ..ProxyConfig::default()
            };
            let proxy = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                assert_eq!(stream.read_u8().await.unwrap(), 5);
                let methods = stream.read_u8().await.unwrap();
                let mut auth = vec![0; methods as usize];
                stream.read_exact(&mut auth).await.unwrap();
                stream.write_all(&[5, 0]).await.unwrap();
                let mut head = [0; 4];
                stream.read_exact(&mut head).await.unwrap();
                let ip = match target.ip() {
                    std::net::IpAddr::V4(ip) => {
                        assert_eq!(head, [5, 1, 0, 1]);
                        ip.octets().to_vec()
                    }
                    std::net::IpAddr::V6(ip) => {
                        assert_eq!(head, [5, 1, 0, 4]);
                        ip.octets().to_vec()
                    }
                };
                let mut received = vec![0; ip.len()];
                stream.read_exact(&mut received).await.unwrap();
                assert_eq!(received, ip);
                assert_eq!(stream.read_u16().await.unwrap(), target.port());
                stream
                    .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
                    .await
                    .unwrap();
            });
            connect_via_proxy_resolved(&cfg, target).await.unwrap();
            proxy.await.unwrap();
        }
    }

    #[tokio::test]
    async fn connect_via_proxy_rejects_inactive_config() {
        let cfg = ProxyConfig::default();
        let err = match connect_via_proxy(&cfg, "example.com", 443).await {
            Ok(_) => panic!("expected an error for inactive proxy"),
            Err(e) => e,
        };
        assert!(err.contains("not active"));
    }

    #[tokio::test]
    async fn http_tunnel_completes_on_200_response() {
        // Spin a tiny mock proxy that accepts a CONNECT and replies 200.
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 1024];
                let mut total = 0;
                loop {
                    let n = stream.read(&mut buf[total..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    total += n;
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let _ = stream
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await;
                // Hold the stream open briefly so the test reader sees no EOF.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        });

        let cfg = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port,
            ..ProxyConfig::default()
        };
        match connect_via_proxy(&cfg, "example.com", 443).await {
            Ok(_) => {}
            Err(e) => panic!("tunnel should succeed: {e}"),
        }
    }

    #[tokio::test]
    async fn http_tunnel_rejects_407_response() {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = vec![0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
                    .await;
            }
        });

        let cfg = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Http,
            host: "127.0.0.1".to_string(),
            port,
            ..ProxyConfig::default()
        };
        let err = match connect_via_proxy(&cfg, "example.com", 443).await {
            Ok(_) => panic!("expected 407 error"),
            Err(e) => e,
        };
        assert!(err.contains("407"));
    }

    #[tokio::test]
    async fn https_proxy_layers_tls_before_connect() {
        use rustls::pki_types::PrivatePkcs8KeyDer;

        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let certificate = certified.cert.der().clone();
        let key = PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
        let server_config = rustls::ServerConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.clone()], key.into())
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
            let mut tls = acceptor.accept(tcp).await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 128];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = tls.read(&mut chunk).await.unwrap();
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            assert!(String::from_utf8_lossy(&request).starts_with("CONNECT example.com:443"));
            tls.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .unwrap();
        });

        let mut roots = rustls::RootCertStore::empty();
        roots.add(certificate).unwrap();
        let client_config = rustls::ClientConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let cfg = ProxyConfig {
            mode: ProxyMode::Manual,
            protocol: ProxyProtocol::Https,
            host: "localhost".into(),
            port,
            ..ProxyConfig::default()
        };
        connect_https_tunnel_with_config(&cfg, "example.com", 443, Arc::new(client_config))
            .await
            .unwrap();
    }
}
