//! The forwarding half: an HTTP/1 server in front of the daemon's Unix socket.
//!
//! Each request is classified and checked by [`crate::policy`]; a refusal
//! answers 403 with Docker's own error shape (`{"message": …}`) and never
//! reaches the daemon. A request that names a container, exec or volume is
//! forwarded only after the daemon confirms the target carries this
//! deployment's labels. `attach` and `exec start` hijack the connection
//! (`Upgrade: tcp` → 101): the proxy upgrades both sides and pipes them.

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full, Limited};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::UnixStream;

use crate::policy::{
    check_container_create, check_exec_create, check_snapshot_commit, check_snapshot_remove,
    check_volume_create, classify, scoped_list_query, snapshot_image_id, snapshot_tag, Ownership,
    ProxyPolicy, Route, Verb,
};

pub type ProxyBody = BoxBody<Bytes, hyper::Error>;

/// The largest request body forwarded. Every body the pool sends is a small
/// JSON document; image builds and archive uploads are refused by route.
pub const MAX_REQUEST_BODY: usize = 4 * 1024 * 1024;

/// What the daemon says about a target.
#[derive(Debug, PartialEq, Eq)]
enum Owner {
    Ours,
    NotOurs,
    /// The daemon has no such thing: forwarding answers its own 404, which
    /// callers rely on for idempotent removal.
    Missing,
}

#[derive(Clone)]
pub struct Proxy {
    policy: Arc<ProxyPolicy>,
    upstream: Arc<PathBuf>,
}

fn full(bytes: impl Into<Bytes>) -> ProxyBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

fn empty() -> ProxyBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

/// Docker's error shape, so a client prints the reason.
fn refusal(status: StatusCode, message: impl Into<String>) -> Response<ProxyBody> {
    let message = message.into();
    let body = serde_json::json!({ "message": message }).to_string();
    let mut response = Response::new(full(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    response
}

fn parse_body(bytes: &Bytes, empty_is: Value) -> Result<Value, String> {
    if bytes.is_empty() {
        return Ok(empty_is);
    }
    serde_json::from_slice(bytes).map_err(|e| format!("the request body is not JSON: {e}"))
}

fn snapshot_image_authorized(policy: &ProxyPolicy, id: &str, info: &Value) -> bool {
    let tags = info.get("RepoTags").and_then(Value::as_array);
    let same_id = !snapshot_image_id(id) || info.get("Id").and_then(Value::as_str) == Some(id);
    same_id
        && tags.is_some_and(|tags| {
            !tags.is_empty()
                && tags
                    .iter()
                    .all(|tag| tag.as_str().is_some_and(|tag| snapshot_tag(policy, tag)))
        })
}

fn snapshot_container_stopped(policy: &ProxyPolicy, info: &Value) -> bool {
    policy.owns(info.pointer("/Config/Labels").and_then(Value::as_object))
        && info.pointer("/State/Running").and_then(Value::as_bool) == Some(false)
        && info.pointer("/State/Paused").and_then(Value::as_bool) != Some(true)
}

impl Proxy {
    pub fn new(policy: ProxyPolicy, upstream: PathBuf) -> Self {
        Self {
            policy: Arc::new(policy),
            upstream: Arc::new(upstream),
        }
    }

    async fn send(&self, request: Request<Full<Bytes>>) -> Result<Response<Incoming>, String> {
        let stream = UnixStream::connect(self.upstream.as_ref())
            .await
            .map_err(|e| {
                format!(
                    "cannot reach the Docker daemon at {}: {e}",
                    self.upstream.display()
                )
            })?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| format!("Docker daemon handshake failed: {e}"))?;
        tokio::spawn(async move {
            if let Err(error) = connection.with_upgrades().await {
                tracing::debug!(%error, "upstream connection ended");
            }
        });
        sender
            .send_request(request)
            .await
            .map_err(|e| format!("Docker daemon request failed: {e}"))
    }

    /// `GET path` on the daemon: `None` on 404, the JSON otherwise.
    async fn lookup(&self, path: &str) -> Result<Option<Value>, String> {
        let request = Request::builder()
            .method(Method::GET)
            .uri(path)
            .header(header::HOST, "docker")
            .body(Full::new(Bytes::new()))
            .map_err(|e| e.to_string())?;
        let response = self.send(request).await?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|e| format!("reading {path}: {e}"))?
            .to_bytes();
        if !status.is_success() {
            return Err(format!("{path} answered {status}"));
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("{path} is not JSON: {e}"))
    }

    async fn container_owner(&self, id: &str) -> Result<Owner, String> {
        Ok(
            match self.lookup(&format!("/containers/{id}/json")).await? {
                None => Owner::Missing,
                Some(inspect) => {
                    let labels = inspect.get("Config").and_then(|c| c.get("Labels"));
                    if self.policy.owns(labels.and_then(Value::as_object)) {
                        Owner::Ours
                    } else {
                        Owner::NotOurs
                    }
                }
            },
        )
    }

    async fn owner(&self, ownership: &Ownership) -> Result<Owner, String> {
        match ownership {
            Ownership::None => Ok(Owner::Ours),
            Ownership::Container(id) => self.container_owner(id).await,
            Ownership::Exec(id) => match self.lookup(&format!("/exec/{id}/json")).await? {
                None => Ok(Owner::Missing),
                Some(exec) => match exec.get("ContainerID").and_then(Value::as_str) {
                    Some(container) => match self.container_owner(container).await? {
                        // An exec whose container is gone belongs to no one.
                        Owner::Missing => Ok(Owner::NotOurs),
                        owner => Ok(owner),
                    },
                    None => Ok(Owner::NotOurs),
                },
            },
            Ownership::Volume(name) => Ok(match self.lookup(&format!("/volumes/{name}")).await? {
                None => Owner::Missing,
                Some(volume) => {
                    if self
                        .policy
                        .owns(volume.get("Labels").and_then(Value::as_object))
                    {
                        Owner::Ours
                    } else {
                        Owner::NotOurs
                    }
                }
            }),
        }
    }

    /// Answer one client request.
    pub async fn handle(&self, mut request: Request<Incoming>) -> Response<ProxyBody> {
        let verb = Verb::parse(request.method().as_str());
        let path = request.uri().path().to_string();
        let route = match classify(verb, &path) {
            Ok(route) => route,
            Err(reason) => {
                tracing::warn!(method = %request.method(), %path, "refused");
                return refusal(StatusCode::FORBIDDEN, reason);
            }
        };
        let wants_upgrade = request.headers().contains_key(header::UPGRADE);
        let client_upgrade = wants_upgrade.then(|| hyper::upgrade::on(&mut request));
        let (parts, body) = request.into_parts();
        let bytes = match Limited::new(body, MAX_REQUEST_BODY).collect().await {
            Ok(collected) => collected.to_bytes(),
            Err(error) => {
                return refusal(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("the request body could not be read: {error}"),
                )
            }
        };

        let checked = match &route {
            Route::ContainerCreate => parse_body(&bytes, Value::Null)
                .and_then(|body| check_container_create(&self.policy, &body)),
            Route::ExecCreate { .. } => {
                parse_body(&bytes, serde_json::json!({})).and_then(|body| check_exec_create(&body))
            }
            Route::SnapshotCommit => parse_body(&bytes, serde_json::json!({}))
                .and_then(|body| check_snapshot_commit(&self.policy, parts.uri.query(), &body))
                .map(|_| ()),
            Route::SnapshotImage { id, remove: true } => {
                check_snapshot_remove(parts.uri.query(), id)
            }
            Route::ImagePull
                if parts.uri.query().is_some_and(|query| {
                    url::form_urlencoded::parse(query.as_bytes())
                        .any(|(_, value)| value.starts_with("cognia-snapshot-"))
                }) =>
            {
                Err("snapshot namespace cannot be pulled or imported".into())
            }
            Route::VolumeCreate => parse_body(&bytes, Value::Null)
                .and_then(|body| check_volume_create(&self.policy, &body)),
            _ => Ok(()),
        };
        if let Err(reason) = checked {
            tracing::warn!(method = %parts.method, %path, %reason, "refused");
            return refusal(StatusCode::FORBIDDEN, reason);
        }

        match &route {
            Route::SnapshotCommit => {
                let body =
                    parse_body(&bytes, serde_json::json!({})).expect("validated commit body");
                let id = check_snapshot_commit(&self.policy, parts.uri.query(), &body)
                    .expect("validated commit query");
                match self.lookup(&format!("/containers/{id}/json")).await {
                    Ok(Some(info)) if snapshot_container_stopped(&self.policy, &info) => {}
                    Ok(_) => {
                        return refusal(
                            StatusCode::FORBIDDEN,
                            "snapshot requires a stopped container of this deployment",
                        )
                    }
                    Err(error) => return refusal(StatusCode::BAD_GATEWAY, error),
                }
            }
            Route::SnapshotImage { id, .. } => {
                if !snapshot_image_id(id) && !snapshot_tag(&self.policy, id) {
                    return refusal(
                        StatusCode::FORBIDDEN,
                        "snapshot image is outside this deployment",
                    );
                }
                match self.lookup(&format!("/images/{id}/json")).await {
                    Ok(None) => {}
                    Ok(Some(info)) => {
                        if !snapshot_image_authorized(&self.policy, id, &info) {
                            return refusal(
                                StatusCode::FORBIDDEN,
                                "snapshot image has no exclusive deployment commit provenance",
                            );
                        }
                    }
                    Err(error) => return refusal(StatusCode::BAD_GATEWAY, error),
                }
            }
            _ => {}
        }

        match self.owner(&route.ownership()).await {
            Ok(Owner::Ours | Owner::Missing) => {}
            Ok(Owner::NotOurs) => {
                tracing::warn!(method = %parts.method, %path, "refused: not this deployment's");
                return refusal(
                    StatusCode::FORBIDDEN,
                    "the target is not a Cognia container or volume of this deployment",
                );
            }
            Err(reason) => return refusal(StatusCode::BAD_GATEWAY, reason),
        }

        let query = match &route {
            Route::ContainerList | Route::VolumeList => {
                match scoped_list_query(&self.policy, parts.uri.query()) {
                    Ok(query) => Some(query),
                    Err(reason) => return refusal(StatusCode::BAD_REQUEST, reason),
                }
            }
            _ => parts.uri.query().map(str::to_string),
        };
        let uri = match query {
            Some(query) if !query.is_empty() => format!("{path}?{query}"),
            _ => path.clone(),
        };

        let mut upstream = Request::builder().method(parts.method.clone()).uri(uri);
        for (name, value) in parts.headers.iter() {
            if name == header::HOST
                || name == header::CONTENT_LENGTH
                || name == header::TRANSFER_ENCODING
            {
                continue;
            }
            upstream = upstream.header(name, value);
        }
        upstream = upstream.header(header::HOST, "docker");
        if !bytes.is_empty() {
            upstream = upstream.header(header::CONTENT_LENGTH, bytes.len());
        }
        let upstream = match upstream.body(Full::new(bytes)) {
            Ok(request) => request,
            Err(error) => return refusal(StatusCode::BAD_REQUEST, error.to_string()),
        };

        let mut response = match self.send(upstream).await {
            Ok(response) => response,
            Err(reason) => return refusal(StatusCode::BAD_GATEWAY, reason),
        };

        if response.status() == StatusCode::SWITCHING_PROTOCOLS {
            let Some(client_upgrade) = client_upgrade else {
                return refusal(
                    StatusCode::BAD_GATEWAY,
                    "the daemon switched protocols on a request that did not ask to",
                );
            };
            let daemon_upgrade = hyper::upgrade::on(&mut response);
            tokio::spawn(async move {
                let (client, daemon) = match tokio::try_join!(client_upgrade, daemon_upgrade) {
                    Ok(pair) => pair,
                    Err(error) => {
                        tracing::debug!(%error, "upgrade failed");
                        return;
                    }
                };
                let mut client = TokioIo::new(client);
                let mut daemon = TokioIo::new(daemon);
                if let Err(error) = tokio::io::copy_bidirectional(&mut client, &mut daemon).await {
                    tracing::debug!(%error, "hijacked stream ended");
                }
            });
            let (parts, _) = response.into_parts();
            return Response::from_parts(parts, empty());
        }

        response.map(|body| body.boxed())
    }

    /// Serve one client connection until it closes.
    pub async fn serve_connection<I>(&self, io: I) -> Result<(), hyper::Error>
    where
        I: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let proxy = self.clone();
        let service = service_fn(move |request| {
            let proxy = proxy.clone();
            async move { Ok::<_, Infallible>(proxy.handle(request).await) }
        });
        http1::Builder::new()
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades()
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

    fn ours() -> Value {
        serde_json::json!({ "cognia.owner": "cognia-external-agent", "cognia.deployment": "dep1" })
    }

    /// A stand-in daemon: records what reaches it and answers the lookups.
    async fn fake_daemon(request: Request<Incoming>, seen: Seen) -> Response<ProxyBody> {
        let mut request = request;
        let method = request.method().to_string();
        let path_and_query = request
            .uri()
            .path_and_query()
            .map(|pq| pq.as_str().to_string())
            .unwrap_or_default();
        let path = request.uri().path().to_string();
        if request.headers().contains_key(header::UPGRADE) {
            let upgrade = hyper::upgrade::on(&mut request);
            seen.lock()
                .unwrap()
                .push((method, path_and_query, String::new()));
            tokio::spawn(async move {
                if let Ok(upgraded) = upgrade.await {
                    let mut io = TokioIo::new(upgraded);
                    let mut buf = [0u8; 64];
                    if let Ok(n) = io.read(&mut buf).await {
                        let _ = io.write_all(&buf[..n]).await;
                    }
                }
            });
            return Response::builder()
                .status(StatusCode::SWITCHING_PROTOCOLS)
                .header(header::CONNECTION, "Upgrade")
                .header(header::UPGRADE, "tcp")
                .body(empty())
                .unwrap();
        }
        let body = request.into_body().collect().await.unwrap().to_bytes();
        seen.lock().unwrap().push((
            method.clone(),
            path_and_query,
            String::from_utf8_lossy(&body).into_owned(),
        ));
        let json = |value: Value| Response::new(full(value.to_string()));
        match (method.as_str(), path.as_str()) {
            ("GET", "/containers/mine/json") => {
                json(serde_json::json!({ "Config": { "Labels": ours() } }))
            }
            ("GET", "/containers/foreign/json") => {
                json(serde_json::json!({ "Config": { "Labels": { "app": "db" } } }))
            }
            ("GET", "/exec/e-mine/json") => json(serde_json::json!({ "ContainerID": "mine" })),
            ("GET", "/exec/e-foreign/json") => {
                json(serde_json::json!({ "ContainerID": "foreign" }))
            }
            ("GET", "/volumes/vol-mine") => json(serde_json::json!({ "Labels": ours() })),
            ("GET", "/volumes/vol-foreign") => json(serde_json::json!({ "Labels": {} })),
            ("GET", p) if p.ends_with("/json") && p.starts_with("/containers/gone") => {
                Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(full(r#"{"message":"No such container"}"#))
                    .unwrap()
            }
            _ => json(serde_json::json!({ "ok": true })),
        }
    }

    struct Harness {
        _dir: tempfile::TempDir,
        proxy_socket: PathBuf,
        seen: Seen,
    }

    async fn harness() -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let daemon_socket = dir.path().join("docker.sock");
        let proxy_socket = dir.path().join("proxy.sock");
        let seen: Seen = Arc::default();

        let daemon = UnixListener::bind(&daemon_socket).unwrap();
        let daemon_seen = seen.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = daemon.accept().await {
                let seen = daemon_seen.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        let seen = seen.clone();
                        async move { Ok::<_, Infallible>(fake_daemon(request, seen).await) }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        });

        let proxy = Proxy::new(ProxyPolicy::new("dep1", "dep1_workspaces"), daemon_socket);
        let listener = UnixListener::bind(&proxy_socket).unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let proxy = proxy.clone();
                tokio::spawn(async move {
                    let _ = proxy.serve_connection(stream).await;
                });
            }
        });
        Harness {
            _dir: dir,
            proxy_socket,
            seen,
        }
    }

    async fn call(
        h: &Harness,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let stream = UnixStream::connect(&h.proxy_socket).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(connection);
        let bytes = body.map(|b| Bytes::from(b.to_string())).unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "docker")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(bytes))
            .unwrap();
        let response = sender.send_request(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    fn forwarded(h: &Harness, method: &str, path_prefix: &str) -> bool {
        h.seen
            .lock()
            .unwrap()
            .iter()
            .any(|(m, p, _)| m == method && p.starts_with(path_prefix))
    }

    fn create_body(labels: Value, mounts: Value) -> Value {
        serde_json::json!({
            "Image": "img@sha256:abc",
            "Labels": labels,
            "HostConfig": { "Mounts": mounts, "NetworkMode": "none", "CapDrop": ["ALL"] }
        })
    }

    #[test]
    fn snapshot_provenance_uses_immutable_id_and_exclusive_tags_never_image_labels() {
        let policy = ProxyPolicy::new("dep1", "dep1_workspaces");
        let image = format!("sha256:{}", "a".repeat(64));
        let tag = format!(
            "{}:{}",
            crate::policy::snapshot_repository(&policy),
            uuid::Uuid::new_v4()
        );
        let valid = serde_json::json!({ "Id": image, "RepoTags": [tag] });
        assert!(snapshot_image_authorized(&policy, &image, &valid));
        assert!(snapshot_image_authorized(&policy, &tag, &valid));
        let mut mismatch = valid.clone();
        mismatch["Id"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
        assert!(!snapshot_image_authorized(&policy, &image, &mismatch));
        for tags in [
            serde_json::json!([]),
            serde_json::json!(["foreign:latest"]),
            serde_json::json!([tag, "another-deployment:latest"]),
        ] {
            let forged = serde_json::json!({ "Id": image, "RepoTags": tags, "Config": { "Labels": ours() } });
            assert!(!snapshot_image_authorized(&policy, &image, &forged));
        }
        assert!(!snapshot_image_authorized(
            &ProxyPolicy::new("other", "v"),
            &image,
            &valid
        ));
    }

    #[test]
    fn snapshot_commit_needs_explicit_stopped_state_and_own_container() {
        let policy = ProxyPolicy::new("dep1", "dep1_workspaces");
        let mut info = serde_json::json!({ "Config": { "Labels": ours() }, "State": { "Running": false, "Paused": false } });
        assert!(snapshot_container_stopped(&policy, &info));
        info["State"]["Running"] = serde_json::json!(true);
        assert!(!snapshot_container_stopped(&policy, &info));
        info["State"]["Running"] = serde_json::json!(false);
        info["State"]["Paused"] = serde_json::json!(true);
        assert!(!snapshot_container_stopped(&policy, &info));
        info["State"] = serde_json::json!({});
        assert!(!snapshot_container_stopped(&policy, &info));
        info["State"] = serde_json::json!({"Running": false});
        assert!(!snapshot_container_stopped(
            &ProxyPolicy::new("other", "v"),
            &info
        ));
    }

    #[tokio::test]
    async fn forwards_daemon_facts_and_refuses_unknown_routes_without_reaching_the_daemon() {
        let h = harness().await;
        let (status, _) = call(&h, "GET", "/v1.53/_ping", None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, body) = call(&h, "POST", "/v1.53/build", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body["message"].as_str().unwrap().contains("does not allow"));
        assert!(!forwarded(&h, "POST", "/v1.53/build"));
    }

    #[tokio::test]
    async fn checks_a_create_body_before_the_daemon_sees_it() {
        let h = harness().await;
        let ok = create_body(
            ours(),
            serde_json::json!([{ "Type": "volume", "Source": "dep1_workspaces", "Target": "/workspace" }]),
        );
        let (status, _) = call(
            &h,
            "POST",
            "/v1.53/containers/create?name=cognia-agent-a",
            Some(ok),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(forwarded(
            &h,
            "POST",
            "/v1.53/containers/create?name=cognia-agent-a"
        ));

        let escape = create_body(
            ours(),
            serde_json::json!([{ "Type": "bind", "Source": "/", "Target": "/host" }]),
        );
        let (status, body) = call(
            &h,
            "POST",
            "/v1.53/containers/create?name=evil",
            Some(escape),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body["message"].as_str().unwrap().contains("bind mount"));
        assert!(!forwarded(&h, "POST", "/v1.53/containers/create?name=evil"));
    }

    #[tokio::test]
    async fn acts_only_on_this_deployments_containers() {
        let h = harness().await;
        let (status, _) = call(&h, "POST", "/v1.53/containers/mine/start", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(forwarded(&h, "POST", "/v1.53/containers/mine/start"));

        let (status, _) = call(&h, "POST", "/v1.53/containers/foreign/stop", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!forwarded(&h, "POST", "/v1.53/containers/foreign/stop"));

        // A container that is gone gets the daemon's own 404 (idempotent removal).
        let (status, _) = call(&h, "DELETE", "/v1.53/containers/gone?force=true", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(forwarded(&h, "DELETE", "/v1.53/containers/gone"));
    }

    #[tokio::test]
    async fn execs_only_into_this_deployments_containers() {
        let h = harness().await;
        let (status, _) = call(
            &h,
            "POST",
            "/v1.53/containers/mine/exec",
            Some(serde_json::json!({ "Cmd": ["true"] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(
            &h,
            "POST",
            "/v1.53/containers/mine/exec",
            Some(serde_json::json!({ "Cmd": ["sh"], "Privileged": true })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(
            &h,
            "POST",
            "/v1.53/containers/foreign/exec",
            Some(serde_json::json!({ "Cmd": ["sh"] })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(&h, "GET", "/v1.53/exec/e-foreign/json", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(&h, "GET", "/v1.53/exec/e-mine/json", None).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn removes_only_this_deployments_volumes_and_scopes_lists() {
        let h = harness().await;
        let (status, _) = call(&h, "DELETE", "/v1.53/volumes/vol-mine", None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = call(&h, "DELETE", "/v1.53/volumes/vol-foreign", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _) = call(&h, "GET", "/v1.53/containers/json?all=true", None).await;
        assert_eq!(status, StatusCode::OK);
        let seen = h.seen.lock().unwrap().clone();
        let (_, listed, _) = seen
            .iter()
            .find(|(m, p, _)| m == "GET" && p.starts_with("/v1.53/containers/json"))
            .expect("list forwarded");
        let filters = url::form_urlencoded::parse(listed.split_once('?').unwrap().1.as_bytes())
            .find(|(k, _)| k == "filters")
            .map(|(_, v)| v.into_owned())
            .expect("filters added");
        assert!(filters.contains("cognia.deployment=dep1"), "{filters}");
    }

    #[tokio::test]
    async fn pipes_a_hijacked_exec_stream_both_ways() {
        let h = harness().await;
        let stream = UnixStream::connect(&h.proxy_socket).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(connection.with_upgrades());
        let request = Request::builder()
            .method("POST")
            .uri("/v1.53/exec/e-mine/start")
            .header(header::HOST, "docker")
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "tcp")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(r#"{"Detach":false,"Tty":false}"#)))
            .unwrap();
        let response = sender.send_request(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let upgraded = hyper::upgrade::on(response).await.unwrap();
        let mut io = TokioIo::new(upgraded);
        io.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        io.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");

        // An exec into a foreign container never gets its stream.
        let stream = UnixStream::connect(&h.proxy_socket).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(connection.with_upgrades());
        let request = Request::builder()
            .method("POST")
            .uri("/v1.53/exec/e-foreign/start")
            .header(header::HOST, "docker")
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "tcp")
            .body(Full::new(Bytes::new()))
            .unwrap();
        let response = sender.send_request(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
