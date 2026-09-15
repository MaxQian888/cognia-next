//! The production [`RegistryTransport`]: reqwest through the Host's proxy
//! policy, redirects returned to the client, DNS resolved and checked here.
//!
//! On a direct route the name is resolved once, every address is checked
//! (never a cloud metadata address; loopback only when the request allows
//! it), and the connection is pinned to those addresses so a second lookup
//! cannot rebind the name. Through a proxy the proxy resolves the name, so
//! only an IP literal can be checked locally — the same trade the other
//! proxied egress paths on the Host make.

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use cognia_net::proxy_config::{apply_reqwest_policy, ProxyRouteSummary};
use url::Host;

use super::{
    authority, check_address, literal_ip, HttpMethod, RegistryError, RegistryRequest,
    RegistryResponse, RegistryTransport,
};

const USER_AGENT: &str = concat!("cognia-environment/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Clone, Copy)]
pub struct ReqwestTransport {
    pub connect_timeout: Duration,
    /// Whole-exchange ceiling; metadata documents are small.
    pub timeout: Duration,
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            timeout: Duration::from_secs(60),
        }
    }
}

impl RegistryTransport for ReqwestTransport {
    fn send(
        &self,
        request: RegistryRequest,
    ) -> impl Future<Output = Result<RegistryResponse, RegistryError>> + Send {
        let settings = *self;
        async move { settings.exchange(request).await }
    }
}

impl ReqwestTransport {
    async fn exchange(self, request: RegistryRequest) -> Result<RegistryResponse, RegistryError> {
        let url = request.url.clone();
        let registry = authority(&url).unwrap_or_default();
        let unreachable = |message: String| RegistryError::Unreachable {
            registry: registry.clone(),
            message,
        };
        let port = url
            .port_or_known_default()
            .ok_or_else(|| RegistryError::EndpointRefused {
                url: url.to_string(),
                reason: "it names no port".into(),
            })?;

        let builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(self.connect_timeout)
            .timeout(self.timeout);
        let (mut builder, route) = apply_reqwest_policy(builder, url.as_str())
            .map_err(|error| unreachable(format!("network policy: {error}")))?;

        match (route, url.host()) {
            (_, None) => {
                return Err(RegistryError::EndpointRefused {
                    url: url.to_string(),
                    reason: "it names no host".into(),
                })
            }
            (ProxyRouteSummary::Direct { .. }, Some(Host::Domain(domain))) => {
                let addresses: Vec<SocketAddr> = tokio::net::lookup_host((domain, port))
                    .await
                    .map_err(|error| unreachable(format!("DNS lookup failed: {error}")))?
                    .collect();
                if addresses.is_empty() {
                    return Err(unreachable(format!("{domain} resolved to no address")));
                }
                for address in &addresses {
                    check_address(&url, address.ip(), request.allow_loopback)?;
                }
                builder = builder.resolve_to_addrs(domain, &addresses);
            }
            (_, Some(_)) => {
                if let Some(ip) = literal_ip(&url) {
                    check_address(&url, ip, request.allow_loopback)?;
                }
            }
        }

        let client = builder
            .build()
            .map_err(|error| unreachable(format!("client: {error}")))?;
        let mut call = match request.method {
            HttpMethod::Get => client.get(url.clone()),
            HttpMethod::Post => client.post(url.clone()),
        };
        for (name, value) in &request.headers {
            call = call.header(name.as_str(), value.as_str());
        }
        if let Some((content_type, bytes)) = request.body {
            call = call.header("content-type", content_type).body(bytes);
        }

        let mut response = call
            .send()
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        let limit = request.max_body_bytes;
        if response
            .content_length()
            .is_some_and(|length| length > limit as u64)
        {
            return Err(RegistryError::ResponseTooLarge { limit });
        }
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
            })
            .collect();
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| unreachable(format!("reading the body: {error}")))?
        {
            if body.len() + chunk.len() > limit {
                return Err(RegistryError::ResponseTooLarge { limit });
            }
            body.extend_from_slice(&chunk);
        }
        Ok(RegistryResponse {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;

    use super::*;

    fn init_policy() {
        cognia_net::proxy_config::apply_current(cognia_net::proxy_config::ProxyConfig::default())
            .unwrap();
    }

    fn request(url: &str, allow_loopback: bool, max_body_bytes: usize) -> RegistryRequest {
        RegistryRequest {
            method: HttpMethod::Get,
            url: Url::parse(url).unwrap(),
            headers: vec![("accept".into(), "application/json".into())],
            body: None,
            max_body_bytes,
            allow_loopback,
        }
    }

    /// Serves `response` verbatim to one connection and returns what the
    /// client sent.
    async fn serve_once(response: &'static [u8]) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read the head, then exactly Content-Length body bytes: a request
            // may arrive in more than one segment.
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                if read == 0 {
                    break;
                }
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received).to_string();
                let Some(head_end) = text.find("\r\n\r\n") else {
                    continue;
                };
                let length = text[..head_end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if received.len() >= head_end + 4 + length {
                    break;
                }
            }
            socket.write_all(response).await.unwrap();
            socket.shutdown().await.unwrap();
            String::from_utf8_lossy(&received).to_string()
        });
        (port, handle)
    }

    #[tokio::test]
    async fn metadata_literals_are_refused_before_connecting() {
        init_policy();
        for url in [
            "http://169.254.169.254/latest/meta-data/",
            "https://[fd00:ec2::254]/",
            "https://100.96.0.96/",
        ] {
            let error = ReqwestTransport::default()
                .send(request(url, true, 1024))
                .await
                .unwrap_err();
            assert_eq!(error.code(), "registry_endpoint_refused", "{url}");
        }
    }

    #[tokio::test]
    async fn loopback_needs_the_request_to_allow_it() {
        init_policy();
        let (port, _server) = serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").await;
        let error = ReqwestTransport::default()
            .send(request(
                &format!("http://127.0.0.1:{port}/v2/"),
                false,
                1024,
            ))
            .await
            .unwrap_err();
        assert_eq!(error.code(), "registry_endpoint_refused");

        let error = ReqwestTransport::default()
            .send(request(
                &format!("http://localhost:{port}/v2/"),
                false,
                1024,
            ))
            .await
            .unwrap_err();
        assert_eq!(
            error.code(),
            "registry_endpoint_refused",
            "a name resolving to loopback too"
        );
    }

    #[tokio::test]
    async fn returns_status_headers_and_body_without_following_redirects() {
        init_policy();
        let (port, server) = serve_once(
            b"HTTP/1.1 307 Temporary Redirect\r\nLocation: https://cdn.example.com/blob\r\nDocker-Content-Digest: sha256:abc\r\nContent-Length: 5\r\n\r\nmoved",
        )
        .await;
        let mut outgoing = request(
            &format!("http://127.0.0.1:{port}/v2/acme/app/blobs/x"),
            true,
            1024,
        );
        outgoing
            .headers
            .push(("authorization".into(), "Bearer t".into()));
        let response = ReqwestTransport::default().send(outgoing).await.unwrap();
        assert_eq!(response.status, 307);
        assert_eq!(
            response.header("location"),
            Some("https://cdn.example.com/blob")
        );
        assert_eq!(response.header("Docker-Content-Digest"), Some("sha256:abc"));
        assert_eq!(response.body, b"moved");

        let sent = server.await.unwrap().to_ascii_lowercase();
        assert!(
            sent.starts_with("get /v2/acme/app/blobs/x http/1.1"),
            "{sent}"
        );
        assert!(sent.contains("authorization: bearer t"));
        assert!(sent.contains("user-agent: cognia-environment/"));
    }

    #[tokio::test]
    async fn bodies_past_the_limit_are_refused() {
        init_policy();
        let (port, _server) =
            serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789").await;
        let error = ReqwestTransport::default()
            .send(request(&format!("http://127.0.0.1:{port}/"), true, 4))
            .await
            .unwrap_err();
        assert_eq!(error.code(), "registry_response_too_large");

        let (port, _server) = serve_once(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n012345\r\n0\r\n\r\n",
        )
        .await;
        let error = ReqwestTransport::default()
            .send(request(&format!("http://127.0.0.1:{port}/"), true, 4))
            .await
            .unwrap_err();
        assert_eq!(
            error.code(),
            "registry_response_too_large",
            "without a Content-Length too"
        );
    }

    #[tokio::test]
    async fn posts_carry_their_form_body() {
        init_policy();
        let (port, server) =
            serve_once(b"HTTP/1.1 200 OK\r\nContent-Length: 18\r\n\r\n{\"token\":\"issued\"}")
                .await;
        let mut outgoing = request(&format!("http://127.0.0.1:{port}/token"), true, 1024);
        outgoing.method = HttpMethod::Post;
        outgoing.body = Some((
            "application/x-www-form-urlencoded".into(),
            b"grant_type=refresh_token".to_vec(),
        ));
        let response = ReqwestTransport::default().send(outgoing).await.unwrap();
        assert_eq!(response.status, 200);
        let sent = server.await.unwrap();
        assert!(sent.starts_with("POST /token"), "{sent}");
        assert!(sent
            .to_ascii_lowercase()
            .contains("content-type: application/x-www-form-urlencoded"));
        assert!(sent.ends_with("grant_type=refresh_token"), "{sent}");
    }
}
