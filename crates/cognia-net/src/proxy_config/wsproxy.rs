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
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
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
        ProxyProtocol::Socks5 => connect_socks5(cfg, target_host, target_port)
            .await
            .map_err(|e| format!("SOCKS5 tunnel failed: {e}")),
    }
}

async fn connect_http_tunnel(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<ProxyStream, IoError> {
    let proxy_addr = super::authority(&cfg.host, cfg.port);
    let mut stream = TcpStream::connect(&proxy_addr).await?;
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
    let mut stream = connector
        .connect(server_name, tcp)
        .await
        .map_err(|error| IoError::new(ErrorKind::ConnectionAborted, error.to_string()))?;
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

    // Read the status line + headers up to the blank line. We read in
    // small chunks rather than line-by-line to avoid mangling LF/CRLF
    // boundaries on slow proxies.
    let mut buf = Vec::with_capacity(512);
    let mut tmp = [0u8; 256];
    loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Err(IoError::new(
                ErrorKind::UnexpectedEof,
                "proxy closed before completing CONNECT response",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return Err(IoError::new(
                ErrorKind::InvalidData,
                "proxy response too large",
            ));
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

async fn connect_socks5(
    cfg: &ProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<ProxyStream, IoError> {
    let proxy_addr = super::authority(&cfg.host, cfg.port);
    let target = (target_host, target_port);
    let stream = match (cfg.username.as_deref(), cfg.password.as_deref()) {
        (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
            tokio_socks::tcp::Socks5Stream::connect_with_password(proxy_addr.as_str(), target, u, p)
                .await
                .map_err(|e| IoError::new(ErrorKind::Other, e.to_string()))?
        }
        _ => tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target)
            .await
            .map_err(|e| IoError::new(ErrorKind::Other, e.to_string()))?,
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
