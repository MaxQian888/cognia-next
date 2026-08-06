use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tempfile::NamedTempFile;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{client_async_with_config, WebSocketStream};

const CONTROL_SOCKET_RELATIVE_PATH: &str = "app-server-control/app-server-control.sock";
const UDS_WEBSOCKET_HANDSHAKE_URL: &str = "ws://localhost/rpc";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(150);
const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const IMPORT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_TRANSCRIPT_BYTES: usize = 64 << 20;
const MAX_WEBSOCKET_MESSAGE_BYTES: usize = 128 << 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppDispatchRequest {
    title: String,
    cwd: String,
    messages: Vec<CodexAppDispatchMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppDispatchMessage {
    role: String,
    content: String,
    timestamp_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppDispatchResult {
    thread_id: String,
    deep_link: String,
}

#[derive(Debug)]
struct RpcCallError {
    code: i64,
    message: String,
}

impl std::fmt::Display for RpcCallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcCallError {}

#[async_trait]
trait CodexRpc {
    async fn request(&mut self, method: &str, params: Value, wait: Duration) -> Result<Value>;
    async fn wait_for_import_completion(&mut self, import_id: &str) -> Result<Value>;
}

struct SocketRpc<S> {
    socket: WebSocketStream<S>,
    next_request_id: u64,
    notifications: VecDeque<(String, Value)>,
}

impl<S> SocketRpc<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn new(socket: WebSocketStream<S>) -> Self {
        Self {
            socket,
            next_request_id: 0,
            notifications: VecDeque::new(),
        }
    }

    async fn send_json(&mut self, value: Value) -> Result<()> {
        self.socket
            .send(Message::Text(value.to_string()))
            .await
            .context("failed to write to the Codex App control socket")
    }

    async fn read_json_until(&mut self, deadline: Instant) -> Result<Value> {
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(|| anyhow!("timed out waiting for Codex App"))?;
            let frame = timeout(remaining, self.socket.next())
                .await
                .context("timed out waiting for Codex App")?
                .ok_or_else(|| anyhow!("Codex App closed the control connection"))?
                .context("failed to read from the Codex App control socket")?;
            match frame {
                Message::Text(text) => {
                    return serde_json::from_str(&text)
                        .context("Codex App returned an invalid JSON-RPC message")
                }
                Message::Binary(bytes) => {
                    return serde_json::from_slice(&bytes)
                        .context("Codex App returned an invalid JSON-RPC message")
                }
                Message::Ping(payload) => {
                    self.socket.send(Message::Pong(payload)).await?;
                }
                Message::Pong(_) | Message::Frame(_) => {}
                Message::Close(_) => bail!("Codex App closed the control connection"),
            }
        }
    }

    async fn reject_server_request(&mut self, id: &Value, method: &str) -> Result<()> {
        self.send_json(json!({
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        }))
        .await
    }

    async fn request_value(
        &mut self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value> {
        self.next_request_id += 1;
        let request_id = self.next_request_id;
        self.send_json(json!({ "id": request_id, "method": method, "params": params }))
            .await?;

        let deadline = Instant::now() + wait;
        loop {
            let message = self.read_json_until(deadline).await?;
            if message.get("id") == Some(&json!(request_id)) && message.get("method").is_none() {
                if let Some(error) = message.get("error") {
                    return Err(RpcCallError {
                        code: error.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown Codex App error")
                            .to_string(),
                    }
                    .into());
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }

            if let (Some(id), Some(server_method)) = (
                message.get("id"),
                message.get("method").and_then(Value::as_str),
            ) {
                self.reject_server_request(id, server_method).await?;
            } else if let Some(notification_method) = message.get("method").and_then(Value::as_str)
            {
                self.notifications.push_back((
                    notification_method.to_string(),
                    message.get("params").cloned().unwrap_or(Value::Null),
                ));
            }
        }
    }

    async fn next_matching_import_completion(&mut self, import_id: &str) -> Result<Value> {
        if let Some(index) = self.notifications.iter().position(|(method, params)| {
            method == "externalAgentConfig/import/completed"
                && params.get("importId").and_then(Value::as_str) == Some(import_id)
        }) {
            return Ok(self.notifications.remove(index).expect("index exists").1);
        }

        let deadline = Instant::now() + IMPORT_TIMEOUT;
        loop {
            let message = self.read_json_until(deadline).await?;
            if let (Some(id), Some(server_method)) = (
                message.get("id"),
                message.get("method").and_then(Value::as_str),
            ) {
                self.reject_server_request(id, server_method).await?;
                continue;
            }
            let Some(method) = message.get("method").and_then(Value::as_str) else {
                continue;
            };
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            if method == "externalAgentConfig/import/completed"
                && params.get("importId").and_then(Value::as_str) == Some(import_id)
            {
                return Ok(params);
            }
            self.notifications.push_back((method.to_string(), params));
        }
    }
}

#[async_trait]
impl<S> CodexRpc for SocketRpc<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    async fn request(&mut self, method: &str, params: Value, wait: Duration) -> Result<Value> {
        self.request_value(method, params, wait).await
    }

    async fn wait_for_import_completion(&mut self, import_id: &str) -> Result<Value> {
        self.next_matching_import_completion(import_id).await
    }
}

fn validate_and_normalize_request(
    mut request: CodexAppDispatchRequest,
) -> Result<CodexAppDispatchRequest> {
    request.title = request.title.trim().to_string();
    if request.title.is_empty() {
        bail!("conversation title is required")
    }
    if request.messages.is_empty() {
        bail!("conversation has no messages to import")
    }
    if !request
        .messages
        .iter()
        .any(|message| message.role == "user")
    {
        bail!("conversation must contain at least one user message")
    }

    let mut transcript_bytes = 0usize;
    for message in &mut request.messages {
        if message.role != "user" && message.role != "assistant" {
            bail!("unsupported conversation role: {}", message.role)
        }
        message.content = message.content.trim().to_string();
        if message.content.is_empty() {
            bail!("conversation contains an empty message")
        }
        transcript_bytes = transcript_bytes
            .checked_add(message.content.len())
            .ok_or_else(|| anyhow!("conversation snapshot is too large"))?;
    }
    if transcript_bytes > MAX_TRANSCRIPT_BYTES {
        bail!("conversation snapshot exceeds the 64 MiB import limit")
    }

    let cwd = PathBuf::from(request.cwd.trim());
    if !cwd.is_absolute() {
        bail!("conversation working directory must be an absolute path")
    }
    let metadata = std::fs::metadata(&cwd).with_context(|| {
        format!(
            "conversation working directory does not exist: {}",
            cwd.display()
        )
    })?;
    if !metadata.is_dir() {
        bail!(
            "conversation working directory is not a directory: {}",
            cwd.display()
        )
    }
    request.cwd = std::fs::canonicalize(&cwd)
        .with_context(|| format!("failed to resolve working directory: {}", cwd.display()))?
        .to_string_lossy()
        .into_owned();
    Ok(request)
}

fn timestamp_text(timestamp_ms: Option<i64>, fallback_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp_ms.unwrap_or(fallback_ms))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn transcript_jsonl(request: &CodexAppDispatchRequest) -> Result<String> {
    let base_ms = chrono::Utc::now().timestamp_millis();
    let mut lines = Vec::with_capacity(request.messages.len() + 1);
    lines.push(json!({ "type": "custom-title", "customTitle": request.title }).to_string());
    for (index, message) in request.messages.iter().enumerate() {
        lines.push(
            json!({
                "type": message.role,
                "cwd": request.cwd,
                "timestamp": timestamp_text(message.timestamp_ms, base_ms + index as i64),
                "message": { "content": message.content },
            })
            .to_string(),
        );
    }
    Ok(lines.join("\n") + "\n")
}

fn prepare_private_temp_export(request: &CodexAppDispatchRequest) -> Result<NamedTempFile> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow!("could not resolve the user home directory"))?;
    let directory = home
        .join(".claude")
        .join("projects")
        .join("cognia-codex-handoff");
    std::fs::create_dir_all(&directory).with_context(|| {
        format!(
            "failed to create handoff directory: {}",
            directory.display()
        )
    })?;
    set_owner_only_directory_permissions(&directory)?;

    let mut file = tempfile::Builder::new()
        .prefix("cognia-")
        .suffix(".jsonl")
        .tempfile_in(&directory)
        .context("failed to create the temporary Codex handoff file")?;
    set_owner_only_file_permissions(file.path())?;
    use std::io::Write;
    file.write_all(transcript_jsonl(request)?.as_bytes())
        .context("failed to write the temporary Codex handoff file")?;
    file.flush()
        .context("failed to flush the temporary Codex handoff file")?;
    Ok(file)
}

#[cfg(unix)]
fn set_owner_only_directory_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to secure handoff directory: {}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only_directory_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_owner_only_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to secure handoff file: {}", path.display()))
}

#[cfg(not(unix))]
fn set_owner_only_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

fn codex_home() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("CODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| anyhow!("could not resolve CODEX_HOME"))
}

#[cfg(unix)]
mod local_socket {
    use super::*;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};

    pub type Stream = tokio::net::UnixStream;

    pub async fn verify_path(path: &Path) -> Result<()> {
        let metadata = tokio::fs::symlink_metadata(path).await.with_context(|| {
            format!(
                "Codex App control socket is unavailable: {}",
                path.display()
            )
        })?;
        if !metadata.file_type().is_socket() {
            bail!(
                "refusing non-socket Codex App control path: {}",
                path.display()
            )
        }
        let current_uid = unsafe { libc::geteuid() };
        if metadata.uid() != current_uid {
            bail!("refusing a Codex App control socket owned by another OS user")
        }
        Ok(())
    }

    pub async fn connect(path: &Path) -> Result<Stream> {
        verify_path(path).await?;
        let current_uid = unsafe { libc::geteuid() };
        let stream = tokio::net::UnixStream::connect(path)
            .await
            .with_context(|| format!("failed to connect to Codex App: {}", path.display()))?;
        let peer = stream
            .peer_cred()
            .context("failed to verify the Codex App socket peer")?;
        if peer.uid() != current_uid {
            bail!("refusing a Codex App control peer owned by another OS user")
        }
        Ok(stream)
    }
}

#[cfg(windows)]
mod local_socket {
    use super::*;
    use async_io::Async;
    use std::io;
    use std::net::Shutdown;
    use std::ops::Deref;
    use std::os::windows::io::{AsRawSocket, AsSocket, BorrowedSocket};
    use std::pin::Pin;
    use std::task::{ready, Context as TaskContext, Poll};
    use tokio::io::ReadBuf;
    use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt};

    pub struct Stream(Compat<Async<WindowsUnixStream>>);

    pub async fn verify_path(_path: &Path) -> Result<()> {
        Ok(())
    }

    pub async fn connect(path: &Path) -> Result<Stream> {
        let path = path.to_path_buf();
        let stream = tokio::task::spawn_blocking(move || uds_windows::UnixStream::connect(path))
            .await
            .context("Codex App socket connection task failed")?
            .context("failed to connect to the Codex App control socket")?;
        Async::new(WindowsUnixStream(stream))
            .map(FuturesAsyncReadCompatExt::compat)
            .map(Stream)
            .context("failed to prepare the Codex App control socket")
    }

    struct WindowsUnixStream(uds_windows::UnixStream);

    impl Deref for WindowsUnixStream {
        type Target = uds_windows::UnixStream;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl AsSocket for WindowsUnixStream {
        fn as_socket(&self) -> BorrowedSocket<'_> {
            unsafe { BorrowedSocket::borrow_raw(self.as_raw_socket()) }
        }
    }

    impl io::Read for WindowsUnixStream {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            io::Read::read(&mut self.0, buffer)
        }
    }

    impl io::Write for WindowsUnixStream {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            io::Write::write(&mut self.0, buffer)
        }

        fn flush(&mut self) -> io::Result<()> {
            io::Write::flush(&mut self.0)
        }
    }

    impl AsyncRead for Stream {
        fn poll_read(
            self: Pin<&mut Self>,
            context: &mut TaskContext<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().0).poll_read(context, buffer)
        }
    }

    impl AsyncWrite for Stream {
        fn poll_write(
            self: Pin<&mut Self>,
            context: &mut TaskContext<'_>,
            buffer: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.get_mut().0).poll_write(context, buffer)
        }

        fn poll_flush(self: Pin<&mut Self>, context: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.get_mut().0).poll_flush(context)
        }

        fn poll_shutdown(
            self: Pin<&mut Self>,
            context: &mut TaskContext<'_>,
        ) -> Poll<io::Result<()>> {
            let stream = &mut self.get_mut().0;
            ready!(Pin::new(&mut *stream).poll_flush(context))?;
            stream.get_ref().get_ref().shutdown(Shutdown::Write)?;
            Poll::Ready(Ok(()))
        }
    }

    unsafe impl async_io::IoSafe for WindowsUnixStream {}
}

async fn connect_rpc(path: &Path) -> Result<SocketRpc<local_socket::Stream>> {
    let stream = local_socket::connect(path).await?;
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_WEBSOCKET_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_WEBSOCKET_MESSAGE_BYTES);
    let (socket, _) = client_async_with_config(UDS_WEBSOCKET_HANDSHAKE_URL, stream, Some(config))
        .await
        .context("Codex App rejected the WebSocket control handshake")?;
    let mut rpc = SocketRpc::new(socket);
    rpc.request(
        "initialize",
        json!({
            "clientInfo": { "name": "cognia", "title": "Cognia", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": {
                "experimentalApi": true,
                "requestAttestation": false,
                "mcpServerOpenaiFormElicitation": false
            }
        }),
        RPC_TIMEOUT,
    )
    .await
    .context("failed to initialize the Codex App control connection")?;
    rpc.send_json(json!({ "method": "initialized" })).await?;
    Ok(rpc)
}

async fn connect_or_launch(
    app: &AppHandle,
    socket_path: &Path,
) -> Result<SocketRpc<local_socket::Stream>> {
    if tokio::fs::try_exists(socket_path)
        .await
        .context("failed to inspect the Codex App control socket")?
    {
        local_socket::verify_path(socket_path).await?;
        if let Ok(rpc) = connect_rpc(socket_path).await {
            return Ok(rpc);
        }
    }

    app.opener()
        .open_url("codex://threads/new", None::<&str>)
        .context("failed to launch Codex App")?;

    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let mut last_error = None;
    while Instant::now() < deadline {
        if tokio::fs::try_exists(socket_path)
            .await
            .context("failed to inspect the Codex App control socket")?
        {
            local_socket::verify_path(socket_path).await?;
            match connect_rpc(socket_path).await {
                Ok(rpc) => return Ok(rpc),
                Err(error) => last_error = Some(error),
            }
        }
        sleep(CONNECT_RETRY_DELAY).await;
    }
    Err(last_error.unwrap_or_else(|| {
        anyhow!(
            "Codex App did not expose its control socket at {}",
            socket_path.display()
        )
    }))
}

fn import_thread_id(completion: &Value) -> Result<String> {
    let results = completion
        .get("itemTypeResults")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("Codex App returned an invalid import completion"))?;
    let sessions = results
        .iter()
        .find(|result| result.get("itemType").and_then(Value::as_str) == Some("SESSIONS"))
        .ok_or_else(|| anyhow!("Codex App omitted the session import result"))?;
    if let Some(failure) = sessions
        .get("failures")
        .and_then(Value::as_array)
        .and_then(|failures| failures.first())
    {
        bail!(
            "Codex App could not import the conversation: {}",
            failure
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown import failure")
        )
    }
    let thread_id = sessions
        .get("successes")
        .and_then(Value::as_array)
        .and_then(|successes| successes.first())
        .and_then(|success| success.get("target"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Codex App did not return the imported task id"))?;
    uuid::Uuid::parse_str(thread_id).context("Codex App returned an invalid imported task id")?;
    Ok(thread_id.to_string())
}

async fn delete_imported_thread<R: CodexRpc + Send>(rpc: &mut R, thread_id: &str) {
    let _ = rpc
        .request(
            "thread/delete",
            json!({ "threadId": thread_id }),
            RPC_TIMEOUT,
        )
        .await;
}

async fn import_and_verify<R: CodexRpc + Send>(
    rpc: &mut R,
    request: &CodexAppDispatchRequest,
    source_path: &Path,
) -> Result<String> {
    let import_response = rpc
        .request(
            "externalAgentConfig/import",
            json!({
                "migrationItems": [{
                    "itemType": "SESSIONS",
                    "description": "Import Cognia conversation snapshot",
                    "cwd": request.cwd,
                    "details": { "sessions": [{
                        "path": source_path,
                        "cwd": request.cwd,
                        "title": request.title,
                    }] }
                }],
                "source": "cognia",
                "providerId": "cognia"
            }),
            RPC_TIMEOUT,
        )
        .await
        .map_err(|error| {
            if error
                .downcast_ref::<RpcCallError>()
                .is_some_and(|rpc_error| rpc_error.code == -32601)
            {
                anyhow!("This Codex App version cannot import conversations; update Codex App and try again")
            } else {
                error.context("Codex App rejected the conversation import")
            }
        })?;
    let import_id = import_response
        .get("importId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Codex App did not return an import id"))?;
    let completion = rpc.wait_for_import_completion(import_id).await?;
    if completion.get("importId").and_then(Value::as_str) != Some(import_id) {
        bail!("Codex App returned a completion for a different import")
    }
    let thread_id = import_thread_id(&completion)?;

    let verification = async {
        rpc.request(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": request.title }),
            RPC_TIMEOUT,
        )
        .await
        .context("failed to preserve the conversation title")?;
        let read = rpc
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": true }),
                IMPORT_TIMEOUT,
            )
            .await
            .context("failed to verify the imported Codex task")?;
        let thread = read
            .get("thread")
            .ok_or_else(|| anyhow!("Codex App omitted the imported task"))?;
        let has_turns = thread
            .get("turns")
            .and_then(Value::as_array)
            .is_some_and(|turns| !turns.is_empty());
        if !has_turns {
            bail!("Codex App imported an empty task")
        }
        if thread.get("cwd").and_then(Value::as_str) != Some(request.cwd.as_str()) {
            bail!("Codex App did not preserve the conversation working directory")
        }
        Result::<()>::Ok(())
    }
    .await;

    if let Err(error) = verification {
        delete_imported_thread(rpc, &thread_id).await;
        return Err(error);
    }
    Ok(thread_id)
}

#[tauri::command]
pub async fn codex_app_dispatch_conversation(
    app: AppHandle,
    request: CodexAppDispatchRequest,
) -> std::result::Result<CodexAppDispatchResult, String> {
    async {
        let (request, source) = tokio::task::spawn_blocking(move || {
            let request = validate_and_normalize_request(request)?;
            let source = prepare_private_temp_export(&request)?;
            Result::<_>::Ok((request, source))
        })
        .await
        .context("Codex App dispatch preparation task failed")??;
        let socket_path = codex_home()?.join(CONTROL_SOCKET_RELATIVE_PATH);
        let mut rpc = connect_or_launch(&app, &socket_path).await?;
        let thread_id = import_and_verify(&mut rpc, &request, source.path()).await?;
        Ok(CodexAppDispatchResult {
            deep_link: format!("codex://threads/{thread_id}"),
            thread_id,
        })
    }
    .await
    .map_err(|error: anyhow::Error| format!("Codex App dispatch failed: {error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct FakeRpc {
        requests: Vec<(String, Value)>,
        responses: VecDeque<Result<Value>>,
        completion: Result<Value>,
    }

    #[async_trait]
    impl CodexRpc for FakeRpc {
        async fn request(&mut self, method: &str, params: Value, _wait: Duration) -> Result<Value> {
            self.requests.push((method.to_string(), params));
            self.responses
                .pop_front()
                .unwrap_or_else(|| Err(anyhow!("unexpected request: {method}")))
        }

        async fn wait_for_import_completion(&mut self, _import_id: &str) -> Result<Value> {
            std::mem::replace(
                &mut self.completion,
                Err(anyhow!("completion already consumed")),
            )
        }
    }

    fn request(cwd: &Path) -> CodexAppDispatchRequest {
        CodexAppDispatchRequest {
            title: "Imported conversation".into(),
            cwd: cwd.display().to_string(),
            messages: vec![
                CodexAppDispatchMessage {
                    role: "user".into(),
                    content: "Question".into(),
                    timestamp_ms: Some(1_723_000_000_000),
                },
                CodexAppDispatchMessage {
                    role: "assistant".into(),
                    content: "Answer".into(),
                    timestamp_ms: Some(1_723_000_001_000),
                },
            ],
        }
    }

    fn completion(import_id: &str, thread_id: &str) -> Value {
        json!({
            "importId": import_id,
            "itemTypeResults": [{
                "itemType": "SESSIONS",
                "successes": [{ "itemType": "SESSIONS", "target": thread_id }],
                "failures": []
            }]
        })
    }

    #[test]
    fn jsonl_preserves_roles_cwd_title_and_timestamps() {
        let cwd = tempfile::tempdir().unwrap();
        let request = validate_and_normalize_request(request(cwd.path())).unwrap();
        let lines: Vec<Value> = transcript_jsonl(&request)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();

        assert_eq!(
            lines[0],
            json!({ "type": "custom-title", "customTitle": "Imported conversation" })
        );
        assert_eq!(lines[1]["type"], "user");
        assert_eq!(lines[1]["cwd"], request.cwd);
        assert_eq!(lines[1]["message"]["content"], "Question");
        assert_eq!(lines[1]["timestamp"], "2024-08-07T03:06:40.000Z");
        assert_eq!(lines[2]["type"], "assistant");
    }

    #[test]
    fn temporary_export_is_owner_only_and_removed_on_drop() {
        let cwd = tempfile::tempdir().unwrap();
        let request = validate_and_normalize_request(request(cwd.path())).unwrap();
        let path = {
            let export = prepare_private_temp_export(&request).unwrap();
            let path = export.path().to_path_buf();
            assert!(path.exists());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
            path
        };
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn import_waits_for_completion_then_names_and_verifies_the_task() {
        let cwd = tempfile::tempdir().unwrap();
        let request = validate_and_normalize_request(request(cwd.path())).unwrap();
        let thread_id = "01989a8f-7b2b-7aa2-a8b8-c859418ac18f";
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([
                Ok(json!({ "importId": "import-1" })),
                Ok(Value::Null),
                Ok(json!({ "thread": { "cwd": request.cwd, "turns": [{ "id": "turn-1" }] } })),
            ]),
            completion: Ok(completion("import-1", thread_id)),
        };

        let imported = import_and_verify(&mut rpc, &request, Path::new("/tmp/source.jsonl"))
            .await
            .unwrap();

        assert_eq!(imported, thread_id);
        assert_eq!(
            rpc.requests
                .iter()
                .map(|request| request.0.as_str())
                .collect::<Vec<_>>(),
            [
                "externalAgentConfig/import",
                "thread/name/set",
                "thread/read"
            ]
        );
        assert_eq!(
            rpc.requests[0].1["migrationItems"][0]["details"]["sessions"][0]["path"],
            "/tmp/source.jsonl"
        );
    }

    #[tokio::test]
    async fn verification_failure_deletes_the_created_task() {
        let cwd = tempfile::tempdir().unwrap();
        let request = validate_and_normalize_request(request(cwd.path())).unwrap();
        let thread_id = "01989a8f-7b2b-7aa2-a8b8-c859418ac18f";
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([
                Ok(json!({ "importId": "import-1" })),
                Ok(Value::Null),
                Ok(json!({ "thread": { "cwd": request.cwd, "turns": [] } })),
                Ok(Value::Null),
            ]),
            completion: Ok(completion("import-1", thread_id)),
        };

        let error = import_and_verify(&mut rpc, &request, Path::new("/tmp/source.jsonl"))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("empty task"));
        assert_eq!(rpc.requests.last().unwrap().0, "thread/delete");
        assert_eq!(rpc.requests.last().unwrap().1["threadId"], thread_id);
    }

    #[tokio::test]
    async fn rejects_a_completion_for_a_different_import() {
        let cwd = tempfile::tempdir().unwrap();
        let request = validate_and_normalize_request(request(cwd.path())).unwrap();
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([Ok(json!({ "importId": "import-1" }))]),
            completion: Ok(completion(
                "import-2",
                "01989a8f-7b2b-7aa2-a8b8-c859418ac18f",
            )),
        };

        let error = import_and_verify(&mut rpc, &request, Path::new("/tmp/source.jsonl"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("different import"));
    }
}
