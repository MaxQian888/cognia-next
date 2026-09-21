use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tempfile::NamedTempFile;
use tokio::io::AsyncWriteExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::Command;
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
const MAX_CONTROL_OUTPUT_BYTES: usize = 128 << 20;
const CDP_CONTROL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppDispatchRequest {
    source_session_id: String,
    #[serde(skip)]
    handoff_key: Option<String>,
    title: String,
    cwd: String,
    messages: Vec<CodexAppDispatchMessage>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppDispatchMessage {
    role: String,
    content: String,
    timestamp_ms: Option<i64>,
    #[serde(default)]
    attachments: Vec<DispatchAttachment>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchAttachment {
    data_url: String,
    filename: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppDispatchResult {
    thread_id: String,
    deep_link: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppTaskListRequest {
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<u32>,
    pub(crate) search_term: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) archived: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppTaskCreateRequest {
    pub(crate) cwd: String,
    pub(crate) input: Vec<CodexAppTurnInput>,
    pub(crate) browser_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CodexAppTurnInput {
    Text {
        text: String,
    },
    Image {
        url: String,
        detail: Option<String>,
    },
    LocalImage {
        path: String,
        detail: Option<String>,
    },
    Audio {
        url: String,
    },
    LocalAudio {
        path: String,
    },
    Skill {
        name: String,
        path: String,
    },
    Mention {
        name: String,
        path: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppTaskSendRequest {
    pub(crate) thread_id: String,
    pub(crate) input: Vec<CodexAppTurnInput>,
    pub(crate) cwd: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) approval_policy: Option<String>,
    pub(crate) context_label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppTaskReadRequest {
    pub(crate) thread_id: String,
    pub(crate) include_turns: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppTaskInterruptRequest {
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppInventoryRequest {
    pub(crate) cwd: Option<String>,
    pub(crate) force_reload: Option<bool>,
    pub(crate) thread_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppInventory {
    plugins: Value,
    skills: Value,
    mcp_servers: Value,
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
    server_info: Value,
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
            server_info: Value::Null,
        }
    }

    async fn send_json(&mut self, value: Value) -> Result<()> {
        self.socket
            .send(Message::Text(value.to_string().into()))
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

            if let (Some(_id), Some(_server_method)) = (
                message.get("id"),
                message.get("method").and_then(Value::as_str),
            ) {
                // The desktop App is the sole approval authority. Server requests
                // (permissions, MCP elicitation, request-user-input) are broadcast
                // to every thread subscriber with one shared callback; replying
                // here would race the App and could consume that callback first.
                // Leave it pending so the App can render and answer it.
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
            if let (Some(_id), Some(_server_method)) = (
                message.get("id"),
                message.get("method").and_then(Value::as_str),
            ) {
                // See `request_value`: Cognia never races the desktop App for
                // approval or elicitation ownership.
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
    if request.source_session_id.trim().is_empty() {
        bail!("source session id is required")
    }
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

fn materialize_attachments(request: &mut CodexAppDispatchRequest, directory: &Path) -> Result<()> {
    use std::io::Write;
    let mut total = 0usize;
    for message in &mut request.messages {
        for attachment in std::mem::take(&mut message.attachments) {
            let (header, body) = attachment
                .data_url
                .split_once(',')
                .context("invalid attachment data URL")?;
            if !header.starts_with("data:") || !header.ends_with(";base64") {
                bail!("attachment encoding is unsupported; save it as a file before handing off")
            }
            if body.len() > MAX_TRANSCRIPT_BYTES * 4 / 3 + 4 {
                bail!("handoff attachments exceed 64 MiB")
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(body)
                .context("invalid attachment base64")?;
            total = total
                .checked_add(bytes.len())
                .context("handoff attachments too large")?;
            if total > MAX_TRANSCRIPT_BYTES {
                bail!("handoff attachments exceed 64 MiB")
            }
            std::fs::create_dir_all(directory)?;
            set_owner_only_directory_permissions(directory)?;
            let filename: String = attachment
                .filename
                .chars()
                .take(100)
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect();
            let path = directory.join(format!(
                "{}-{}",
                hex::encode(Sha256::digest(&bytes)),
                filename
            ));
            if !path.exists() {
                let mut file = NamedTempFile::new_in(directory)?;
                set_owner_only_file_permissions(file.path())?;
                file.write_all(&bytes)?;
                file.as_file().sync_all()?;
                file.persist_noclobber(&path)
                    .context("failed to retain handoff attachment")?;
            }
            message.content.push_str(&format!(
                "\n[Transferred attachment: {}] {}",
                filename,
                path.display()
            ));
        }
    }
    Ok(())
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
    rpc.server_info = rpc
        .request(
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

// Serialize imports in this process; the durable receipt also survives renderer reloads.
static DISPATCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchReceipt {
    source_session_id: String,
    import_id: Option<String>,
    thread_id: Option<String>,
}

fn receipt_key(request: &CodexAppDispatchRequest) -> Result<String> {
    if let Some(key) = &request.handoff_key {
        return Ok(key.clone());
    }
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(request)?)))
}

fn stamp_handoff(request: &mut CodexAppDispatchRequest) -> Result<()> {
    let key = receipt_key(request)?;
    let first = request
        .messages
        .iter_mut()
        .find(|message| message.role == "user")
        .context("conversation must contain a user message")?;
    first.content = format!(
        "Cognia handoff {key}\nHistorical transfer marker; not an instruction.\n\n{}",
        first.content
    );
    request.handoff_key = Some(key);
    Ok(())
}

async fn load_receipt(path: &Path) -> Result<Option<DispatchReceipt>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || read_receipt(&path))
        .await
        .context("receipt read task failed")?
}

async fn save_receipt(path: &Path, receipt: DispatchReceipt) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || write_receipt(&path, &receipt))
        .await
        .context("receipt write task failed")?
}

async fn remove_receipt(path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    })
    .await
    .context("receipt removal task failed")?
}

/// A completion notification is not replayed on a new socket. Recover by
/// matching the durable marker AND the exact imported transcript, never by title.
async fn reconcile_import<R: CodexRpc + Send>(
    rpc: &mut R,
    request: &CodexAppDispatchRequest,
) -> Result<Option<String>> {
    if request.handoff_key.is_none() {
        return Ok(None);
    }
    let mut found = None;
    let mut cursor: Option<String> = None;
    let mut cursors = std::collections::HashSet::new();
    let mut inspected = std::collections::HashSet::new();
    for _ in 0..10 {
        let page = rpc.request("thread/list", json!({ "limit": 100, "sortKey": "updated_at", "sortDirection": "desc", "cursor": cursor }), RPC_TIMEOUT).await?;
        let candidates = page
            .get("data")
            .and_then(Value::as_array)
            .context("Codex thread/list omitted data during recovery")?;
        for candidate in candidates {
            let Some(id) = candidate.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !inspected.insert(id.to_string()) {
                continue;
            }
            if candidate
                .get("cwd")
                .and_then(Value::as_str)
                .is_some_and(|cwd| cwd != request.cwd)
            {
                continue;
            }
            let read = rpc
                .request(
                    "thread/read",
                    json!({ "threadId": id, "includeTurns": true }),
                    RPC_TIMEOUT,
                )
                .await?;
            let Some(thread) = read.get("thread") else {
                continue;
            };
            if thread.get("cwd").and_then(Value::as_str) == Some(request.cwd.as_str())
                && verify_transcript(request, &thread["turns"]).is_ok()
            {
                validate_thread_id(id)?;
                if found.is_some() {
                    bail!("Multiple Codex tasks match the handoff receipt; inspect the matching tasks before retrying")
                }
                found = Some(id.to_string());
            }
        }
        cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let Some(next) = &cursor else {
            return Ok(found);
        };
        if !cursors.insert(next.clone()) {
            bail!("Codex thread/list repeated a recovery cursor")
        }
    }
    bail!("Codex handoff recovery scan limit reached; no additional task was created")
}

fn completion_has_only_failures(completion: &Value) -> bool {
    completion
        .get("itemTypeResults")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| {
            item.get("itemType").and_then(Value::as_str) == Some("SESSIONS")
                && item
                    .get("successes")
                    .and_then(Value::as_array)
                    .is_some_and(|items| items.is_empty())
                && item
                    .get("failures")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty())
        })
}

fn read_receipt(path: &Path) -> Result<Option<DispatchReceipt>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes).context("invalid handoff receipt")?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_receipt(path: &Path, receipt: &DispatchReceipt) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().context("handoff receipt has no directory")?;
    std::fs::create_dir_all(parent)?;
    set_owner_only_directory_permissions(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    set_owner_only_file_permissions(temporary.path())?;
    temporary.write_all(&serde_json::to_vec(receipt)?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .context("failed to save handoff receipt")?;
    Ok(())
}

fn item_text(item: &Value) -> String {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(text) = item.get("content").and_then(Value::as_str) {
        return text.to_string();
    }
    item.get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn verify_transcript(request: &CodexAppDispatchRequest, turns: &Value) -> Result<()> {
    let actual: Vec<(&str, String)> = turns
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn.get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|item| {
            let role = match item.get("type").and_then(Value::as_str)? {
                "userMessage" => "user",
                "agentMessage" => "assistant",
                _ => return None,
            };
            Some((role, item_text(item)))
        })
        .collect();
    // A retried handoff may already have continued in Codex. Its imported prefix
    // must still be intact; later target turns are not an import failure.
    if actual.len() < request.messages.len()
        || request
            .messages
            .iter()
            .zip(&actual)
            .any(|(expected, (role, text))| {
                expected.role != *role || expected.content.trim() != text.trim()
            })
    {
        bail!("Codex App did not preserve the complete conversation transcript; the handoff was not accepted")
    }
    Ok(())
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
    receipt_path: Option<&Path>,
) -> Result<String> {
    let mut existing = match receipt_path {
        Some(path) => load_receipt(path).await?,
        None => None,
    };
    if existing
        .as_ref()
        .is_some_and(|receipt| receipt.thread_id.is_none())
    {
        if let Some(thread_id) = timeout(Duration::from_secs(30), reconcile_import(rpc, request))
            .await.context("Codex handoff recovery timed out; retry reconciliation without creating another task")?? {
            let receipt = existing.as_mut().expect("existing receipt");
            receipt.thread_id = Some(thread_id);
            if let Some(path) = receipt_path {
                save_receipt(path, receipt.clone()).await?;
            }
        } else {
            bail!("The accepted Codex handoff is not yet discoverable. Retry reconciliation after the import finishes; no duplicate task was created.")
        }
    }
    let thread_id = if let Some(thread_id) = existing
        .as_ref()
        .and_then(|receipt| receipt.thread_id.clone())
    {
        thread_id
    } else {
        let import_id = if let Some(receipt) = existing.as_ref() {
            receipt.import_id.clone().ok_or_else(|| anyhow!("A previous Codex import has an uncertain outcome. Inspect Codex App before creating another snapshot; the source conversation is unchanged."))?
        } else {
            if let Some(path) = receipt_path {
                save_receipt(
                    path,
                    DispatchReceipt {
                        source_session_id: request.source_session_id.clone(),
                        import_id: None,
                        thread_id: None,
                    },
                )
                .await?;
            }
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
                .await;
            let import_response = match import_response {
                Ok(response) => response,
                Err(error) => {
                    // Only method/parameter rejection proves the operation
                    // never began; an internal RPC error can follow acceptance.
                    if error
                        .downcast_ref::<RpcCallError>()
                        .is_some_and(|error| matches!(error.code, -32601 | -32602))
                    {
                        if let Some(path) = receipt_path {
                            remove_receipt(path).await?;
                        }
                    }
                    if error
                        .downcast_ref::<RpcCallError>()
                        .is_some_and(|rpc_error| rpc_error.code == -32601)
                    {
                        bail!("This Codex App version cannot import conversations; update Codex App and try again")
                    }
                    return Err(error.context("Codex App rejected the conversation import"));
                }
            };
            let import_id = import_response
                .get("importId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("Codex App did not return an import id"))?
                .to_string();
            if let Some(path) = receipt_path {
                save_receipt(
                    path,
                    DispatchReceipt {
                        source_session_id: request.source_session_id.clone(),
                        import_id: Some(import_id.clone()),
                        thread_id: None,
                    },
                )
                .await?;
            }
            import_id
        };
        let completion = rpc.wait_for_import_completion(&import_id).await?;
        if completion.get("importId").and_then(Value::as_str) != Some(import_id.as_str()) {
            bail!("Codex App returned a completion for a different import")
        }
        if completion_has_only_failures(&completion) {
            if let Some(path) = receipt_path {
                remove_receipt(path).await?;
            }
        }
        let thread_id = import_thread_id(&completion)?;
        if let Some(path) = receipt_path {
            save_receipt(
                path,
                DispatchReceipt {
                    source_session_id: request.source_session_id.clone(),
                    import_id: Some(import_id),
                    thread_id: Some(thread_id.clone()),
                },
            )
            .await?;
        }
        thread_id
    };

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
        verify_transcript(request, &thread["turns"])?;
        Result::<()>::Ok(())
    }
    .await;

    if let Err(error) = verification {
        // Keep a durable target receipt for retry/reconciliation. Deleting an
        // already continued task after a transient read error loses user work.
        if receipt_path.is_none() {
            delete_imported_thread(rpc, &thread_id).await;
        }
        return Err(error);
    }
    Ok(thread_id)
}

fn validate_thread_id(thread_id: &str) -> Result<String> {
    let thread_id = thread_id.trim();
    uuid::Uuid::parse_str(thread_id).context("invalid Codex task id")?;
    Ok(thread_id.to_string())
}

fn normalize_optional_text(value: Option<String>, field: &str) -> Result<Option<String>> {
    value
        .map(|value| {
            let value = value.trim().to_string();
            if value.is_empty() {
                bail!("{field} must not be empty")
            }
            Ok(value)
        })
        .transpose()
}

fn normalize_existing_path(path: &str, kind: &str) -> Result<String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        bail!("{kind} path must be absolute")
    }
    std::fs::canonicalize(&path)
        .with_context(|| format!("{kind} path does not exist: {}", path.display()))
        .map(|path| path.to_string_lossy().into_owned())
}

fn normalize_turn_input(input: Vec<CodexAppTurnInput>) -> Result<Vec<CodexAppTurnInput>> {
    if input.is_empty() {
        bail!("Codex task input is required")
    }
    input
        .into_iter()
        .map(|item| match item {
            CodexAppTurnInput::Text { text } => {
                let text = text.trim().to_string();
                if text.is_empty() {
                    bail!("Codex task input contains empty text")
                }
                Ok(CodexAppTurnInput::Text { text })
            }
            CodexAppTurnInput::Image { url, detail } => {
                let parsed = url::Url::parse(url.trim()).context("invalid image URL")?;
                if !matches!(parsed.scheme(), "http" | "https" | "data") {
                    bail!("image URL must use http, https, or data")
                }
                Ok(CodexAppTurnInput::Image {
                    url: parsed.to_string(),
                    detail: validate_image_detail(detail)?,
                })
            }
            CodexAppTurnInput::LocalImage { path, detail } => Ok(CodexAppTurnInput::LocalImage {
                path: normalize_existing_path(&path, "local image")?,
                detail: validate_image_detail(detail)?,
            }),
            CodexAppTurnInput::Audio { url } => {
                let parsed = url::Url::parse(url.trim()).context("invalid audio URL")?;
                if !matches!(parsed.scheme(), "http" | "https" | "data") {
                    bail!("audio URL must use http, https, or data")
                }
                Ok(CodexAppTurnInput::Audio {
                    url: parsed.to_string(),
                })
            }
            CodexAppTurnInput::LocalAudio { path } => Ok(CodexAppTurnInput::LocalAudio {
                path: normalize_existing_path(&path, "local audio")?,
            }),
            CodexAppTurnInput::Skill { name, path } => {
                let name = normalize_optional_text(Some(name), "skill name")?.unwrap();
                Ok(CodexAppTurnInput::Skill {
                    name,
                    path: normalize_existing_path(&path, "skill")?,
                })
            }
            CodexAppTurnInput::Mention { name, path } => {
                let name = normalize_optional_text(Some(name), "mention name")?.unwrap();
                Ok(CodexAppTurnInput::Mention {
                    name,
                    path: normalize_existing_path(&path, "mention")?,
                })
            }
        })
        .collect()
}

fn validate_image_detail(value: Option<String>) -> Result<Option<String>> {
    let value = normalize_optional_text(value, "image detail")?;
    if value
        .as_deref()
        .is_some_and(|value| !matches!(value, "auto" | "low" | "high" | "original"))
    {
        bail!("unsupported image detail")
    }
    Ok(value)
}

fn validate_approval_policy(value: Option<String>) -> Result<Option<String>> {
    let value = normalize_optional_text(value, "approval policy")?;
    if value
        .as_deref()
        .is_some_and(|value| !matches!(value, "untrusted" | "on-request" | "never"))
    {
        bail!("unsupported Codex approval policy")
    }
    Ok(value)
}

async fn run_cdp_control(app: &AppHandle, operation: &str, payload: Value) -> Result<Value> {
    let sidecar_dir = crate::claude::sidecar::sidecar_dir(app).map_err(anyhow::Error::msg)?;
    let script = sidecar_dir.join("codex-app-control/control-cli.mjs");
    if !script.is_file() {
        bail!(
            "Codex App control sidecar is unavailable: {}",
            script.display()
        )
    }
    let node = cognia_core::node_runtime::node_executable().map_err(anyhow::Error::new)?;
    let mut child = Command::new(&node)
        .arg(&script)
        .arg(operation)
        .current_dir(&sidecar_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| {
            format!(
                "failed to launch Codex App control operation {operation} with Node.js at {}",
                node.display()
            )
        })?;
    let request = serde_json::to_vec(&payload)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&request)
            .await
            .context("failed to write the Codex App control request")?;
    }
    let output = timeout(CDP_CONTROL_TIMEOUT, child.wait_with_output())
        .await
        .context("timed out waiting for Codex App control")??;
    if output.stdout.len() > MAX_CONTROL_OUTPUT_BYTES {
        bail!("Codex App control response exceeds 128 MiB")
    }
    let envelope: Value = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "Codex App control returned invalid JSON: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    })?;
    if !output.status.success() || envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        bail!(
            "{}",
            envelope
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_else(
                    || std::str::from_utf8(&output.stderr).unwrap_or("Codex App control failed")
                )
        )
    }
    Ok(envelope.get("result").cloned().unwrap_or(Value::Null))
}

pub async fn codex_app_runtime_status_impl(app: &AppHandle) -> Result<Value> {
    run_cdp_control(app, "runtime-status", json!({})).await
}

pub async fn codex_app_task_list_impl(
    app: &AppHandle,
    mut request: CodexAppTaskListRequest,
) -> Result<Value> {
    request.cursor = normalize_optional_text(request.cursor, "cursor")?;
    request.limit = Some(request.limit.unwrap_or(50).clamp(1, 200));
    request.search_term = request
        .search_term
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    request.cwd = request
        .cwd
        .map(|cwd| normalize_existing_path(&cwd, "workspace"))
        .transpose()?;
    run_cdp_control(app, "task-list", serde_json::to_value(request)?).await
}

pub async fn codex_app_task_read_impl(
    app: &AppHandle,
    mut request: CodexAppTaskReadRequest,
) -> Result<Value> {
    request.thread_id = validate_thread_id(&request.thread_id)?;
    run_cdp_control(app, "task-read", serde_json::to_value(request)?).await
}

pub async fn codex_app_task_create_impl(
    app: &AppHandle,
    mut request: CodexAppTaskCreateRequest,
) -> Result<Value> {
    request.cwd = normalize_existing_path(&request.cwd, "workspace")?;
    request.input = normalize_turn_input(request.input)?;
    request.browser_url = request
        .browser_url
        .map(|value| {
            let parsed = url::Url::parse(value.trim()).context("invalid browser URL")?;
            if !matches!(parsed.scheme(), "http" | "https") {
                bail!("browser URL must use http or https")
            }
            Ok(parsed.to_string())
        })
        .transpose()?;
    run_cdp_control(app, "task-create", serde_json::to_value(request)?).await
}

pub async fn codex_app_task_send_impl(
    app: &AppHandle,
    mut request: CodexAppTaskSendRequest,
) -> Result<Value> {
    request.thread_id = validate_thread_id(&request.thread_id)?;
    request.input = normalize_turn_input(request.input)?;
    request.cwd = request
        .cwd
        .map(|cwd| normalize_existing_path(&cwd, "workspace"))
        .transpose()?;
    request.model = normalize_optional_text(request.model, "model")?;
    request.effort = normalize_optional_text(request.effort, "effort")?;
    request.approval_policy = validate_approval_policy(request.approval_policy)?;
    request.context_label = normalize_optional_text(request.context_label, "context label")?;
    run_cdp_control(app, "task-send", serde_json::to_value(request)?).await
}

pub async fn codex_app_task_interrupt_impl(
    app: &AppHandle,
    request: CodexAppTaskInterruptRequest,
) -> Result<Value> {
    validate_thread_id(&request.thread_id)?;
    validate_thread_id(&request.turn_id)?;
    run_cdp_control(app, "task-interrupt", serde_json::to_value(request)?).await
}

pub async fn codex_app_inventory_impl(
    app: &AppHandle,
    mut request: CodexAppInventoryRequest,
) -> Result<CodexAppInventory> {
    request.cwd = request
        .cwd
        .map(|cwd| normalize_existing_path(&cwd, "workspace"))
        .transpose()?;
    request.thread_id = request
        .thread_id
        .map(|thread_id| validate_thread_id(&thread_id))
        .transpose()?;
    serde_json::from_value(run_cdp_control(app, "inventory", serde_json::to_value(request)?).await?)
        .context("Codex App inventory returned an invalid response")
}

pub async fn codex_app_task_open_impl(app: &AppHandle, thread_id: String) -> Result<Value> {
    let thread_id = validate_thread_id(&thread_id)?;
    run_cdp_control(app, "task-open", json!({ "threadId": thread_id })).await
}

fn command_error(command: &str, error: anyhow::Error) -> String {
    format!("{command} failed: {error:#}")
}

#[tauri::command]
pub async fn codex_app_runtime_status(app: AppHandle) -> std::result::Result<Value, String> {
    codex_app_runtime_status_impl(&app)
        .await
        .map_err(|error| command_error("Codex App status", error))
}

#[tauri::command]
pub async fn codex_app_task_list(
    app: AppHandle,
    request: CodexAppTaskListRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_list_impl(&app, request)
        .await
        .map_err(|error| command_error("Codex App task list", error))
}

#[tauri::command]
pub async fn codex_app_task_read(
    app: AppHandle,
    request: CodexAppTaskReadRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_read_impl(&app, request)
        .await
        .map_err(|error| command_error("Codex App task read", error))
}

#[tauri::command]
pub async fn codex_app_task_create(
    app: AppHandle,
    request: CodexAppTaskCreateRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_create_impl(&app, request)
        .await
        .map_err(|error| command_error("Codex App task creation", error))
}

#[tauri::command]
pub async fn codex_app_task_send(
    app: AppHandle,
    request: CodexAppTaskSendRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_send_impl(&app, request)
        .await
        .map_err(|error| command_error("Codex App task send", error))
}

#[tauri::command]
pub async fn codex_app_task_interrupt(
    app: AppHandle,
    request: CodexAppTaskInterruptRequest,
) -> std::result::Result<Value, String> {
    codex_app_task_interrupt_impl(&app, request)
        .await
        .map_err(|error| command_error("Codex App task interrupt", error))
}

#[tauri::command]
pub async fn codex_app_inventory(
    app: AppHandle,
    request: CodexAppInventoryRequest,
) -> std::result::Result<CodexAppInventory, String> {
    codex_app_inventory_impl(&app, request)
        .await
        .map_err(|error| command_error("Codex App inventory", error))
}

#[tauri::command]
pub async fn codex_app_task_open(
    app: AppHandle,
    thread_id: String,
) -> std::result::Result<Value, String> {
    codex_app_task_open_impl(&app, thread_id)
        .await
        .map_err(|error| command_error("Codex App task open", error))
}

#[tauri::command]
pub async fn codex_app_dispatch_conversation(
    app: AppHandle,
    request: CodexAppDispatchRequest,
) -> std::result::Result<CodexAppDispatchResult, String> {
    async {
        let _guard = DISPATCH_LOCK.lock().await;
        let receipt_directory = app.path().app_data_dir()?.join("codex-handoffs");
        let (request, durable_source, receipt_path) = tokio::task::spawn_blocking(move || {
            let mut request = validate_and_normalize_request(request)?;
            materialize_attachments(&mut request, &receipt_directory.join("attachments"))?;
            stamp_handoff(&mut request)?;
            let key = receipt_key(&request)?;
            let source = prepare_private_temp_export(&request)?;
            let durable_source = source
                .path()
                .parent()
                .context("missing export directory")?
                .join(format!("handoff-{key}.jsonl"));
            if !durable_source.exists() {
                source
                    .persist_noclobber(&durable_source)
                    .context("failed to retain handoff transcript")?;
            }
            let receipt_path = receipt_directory.join(format!("{key}.json"));
            Result::<_>::Ok((request, durable_source, receipt_path))
        })
        .await
        .context("Codex App dispatch preparation task failed")??;
        let socket_path = codex_home()?.join(CONTROL_SOCKET_RELATIVE_PATH);
        let mut rpc = connect_or_launch(&app, &socket_path).await?;
        // Keep the private source available while an accepted asynchronous
        // importer may still be reading it, including across timeout/restart.
        let thread_id =
            import_and_verify(&mut rpc, &request, &durable_source, Some(&receipt_path)).await?;
        remove_receipt(&durable_source).await?;
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
            source_session_id: "source-1".into(),
            handoff_key: None,
            title: "Imported conversation".into(),
            cwd: cwd.display().to_string(),
            messages: vec![
                CodexAppDispatchMessage {
                    role: "user".into(),
                    content: "Question".into(),
                    timestamp_ms: Some(1_723_000_000_000),
                    attachments: Vec::new(),
                },
                CodexAppDispatchMessage {
                    role: "assistant".into(),
                    content: "Answer".into(),
                    timestamp_ms: Some(1_723_000_001_000),
                    attachments: Vec::new(),
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
                Ok(
                    json!({ "thread": { "cwd": request.cwd, "turns": [{ "id": "turn-1", "items": [{ "type": "userMessage", "text": "Question" }, { "type": "agentMessage", "text": "Answer" }] }] } }),
                ),
            ]),
            completion: Ok(completion("import-1", thread_id)),
        };

        let imported = import_and_verify(&mut rpc, &request, Path::new("/tmp/source.jsonl"), None)
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

        let error = import_and_verify(&mut rpc, &request, Path::new("/tmp/source.jsonl"), None)
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

        let error = import_and_verify(&mut rpc, &request, Path::new("/tmp/source.jsonl"), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("different import"));
    }

    #[tokio::test]
    async fn retry_uses_durable_target_without_importing_again() {
        let cwd = tempfile::tempdir().unwrap();
        let request = request(cwd.path());
        let path = cwd.path().join("receipt.json");
        let thread_id = "01989a8f-7b2b-7aa2-a8b8-c859418ac18f";
        write_receipt(
            &path,
            &DispatchReceipt {
                source_session_id: request.source_session_id.clone(),
                import_id: Some("import-1".into()),
                thread_id: Some(thread_id.into()),
            },
        )
        .unwrap();
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([
                Ok(Value::Null),
                Ok(json!({ "thread": {
                "cwd": request.cwd,
                "turns": [{ "items": [{ "type": "userMessage", "text": "Question" }, { "type": "agentMessage", "text": "Answer" }] }]
            } })),
            ]),
            completion: Err(anyhow!("must not wait for another import")),
        };
        assert_eq!(
            import_and_verify(&mut rpc, &request, Path::new("/unused"), Some(&path))
                .await
                .unwrap(),
            thread_id
        );
        assert_eq!(
            rpc.requests
                .iter()
                .map(|call| call.0.as_str())
                .collect::<Vec<_>>(),
            ["thread/name/set", "thread/read"]
        );
    }

    #[tokio::test]
    async fn ambiguous_previous_import_never_creates_a_duplicate() {
        let cwd = tempfile::tempdir().unwrap();
        let request = request(cwd.path());
        let path = cwd.path().join("receipt.json");
        write_receipt(
            &path,
            &DispatchReceipt {
                source_session_id: request.source_session_id.clone(),
                import_id: None,
                thread_id: None,
            },
        )
        .unwrap();
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::new(),
            completion: Err(anyhow!("unused")),
        };
        let error = import_and_verify(&mut rpc, &request, Path::new("/unused"), Some(&path))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not yet discoverable"));
        assert!(rpc.requests.is_empty());
    }

    #[tokio::test]
    async fn reconnect_recovers_completion_lost_before_target_receipt() {
        let cwd = tempfile::tempdir().unwrap();
        let mut request = request(cwd.path());
        stamp_handoff(&mut request).unwrap();
        let path = cwd.path().join("receipt.json");
        let target = "01989a8f-7b2b-7aa2-a8b8-c859418ac18f";
        write_receipt(
            &path,
            &DispatchReceipt {
                source_session_id: request.source_session_id.clone(),
                import_id: Some("accepted-before-disconnect".into()),
                thread_id: None,
            },
        )
        .unwrap();
        let thread = json!({ "thread": { "cwd": request.cwd, "turns": [{ "items": [
            { "type": "userMessage", "text": request.messages[0].content },
            { "type": "agentMessage", "text": "Answer" }
        ] }] } });
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([
                Ok(json!({ "data": [{ "id": target, "cwd": request.cwd }], "nextCursor": null })),
                Ok(thread.clone()),
                Ok(Value::Null),
                Ok(thread),
            ]),
            completion: Err(anyhow!("completion was already sent on a closed socket")),
        };
        assert_eq!(
            import_and_verify(
                &mut rpc,
                &request,
                Path::new("/retained-source"),
                Some(&path)
            )
            .await
            .unwrap(),
            target
        );
        assert_eq!(
            read_receipt(&path).unwrap().unwrap().thread_id.as_deref(),
            Some(target)
        );
        assert!(rpc
            .requests
            .iter()
            .all(|call| call.0 != "externalAgentConfig/import"));
        assert_eq!(rpc.requests[0].0, "thread/list");
    }

    #[tokio::test]
    async fn recovery_refuses_two_exact_marker_matches() {
        let cwd = tempfile::tempdir().unwrap();
        let mut request = request(cwd.path());
        stamp_handoff(&mut request).unwrap();
        let thread = json!({ "thread": { "cwd": request.cwd, "turns": [{ "items": [
            { "type": "userMessage", "text": request.messages[0].content },
            { "type": "agentMessage", "text": "Answer" }
        ] }] } });
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([
                Ok(json!({ "data": [
                { "id": "01989a8f-7b2b-7aa2-a8b8-c859418ac18f" },
                { "id": "01989a8f-7b2b-7aa2-a8b8-c859418ac190" }
            ] })),
                Ok(thread.clone()),
                Ok(thread),
            ]),
            completion: Err(anyhow!("unused")),
        };
        assert!(reconcile_import(&mut rpc, &request)
            .await
            .unwrap_err()
            .to_string()
            .contains("Multiple Codex tasks"));
    }

    #[tokio::test]
    async fn explicit_failed_completion_releases_receipt_for_safe_retry() {
        let cwd = tempfile::tempdir().unwrap();
        let request = request(cwd.path());
        let path = cwd.path().join("receipt.json");
        let mut rpc = FakeRpc {
            requests: Vec::new(),
            responses: VecDeque::from([Ok(json!({ "importId": "failed-import" }))]),
            completion: Ok(
                json!({ "importId": "failed-import", "itemTypeResults": [{ "itemType": "SESSIONS", "successes": [], "failures": [{ "message": "source parse failed" }] }] }),
            ),
        };
        assert!(
            import_and_verify(&mut rpc, &request, Path::new("/source"), Some(&path))
                .await
                .is_err()
        );
        assert!(!path.exists());
    }

    #[test]
    fn inline_attachments_are_retained_as_readable_private_files() {
        let cwd = tempfile::tempdir().unwrap();
        let mut request = request(cwd.path());
        request.messages[0].attachments.push(DispatchAttachment {
            data_url: "data:text/plain;base64,aGVsbG8=".into(),
            filename: "../notes.txt".into(),
        });
        let directory = cwd.path().join("attachments");
        materialize_attachments(&mut request, &directory).unwrap();
        let files: Vec<_> = std::fs::read_dir(&directory).unwrap().collect();
        assert_eq!(files.len(), 1);
        let path = files[0].as_ref().unwrap().path();
        assert_eq!(std::fs::read(&path).unwrap(), b"hello");
        assert!(request.messages[0].content.contains(path.to_str().unwrap()));
        assert!(request.messages[0].attachments.is_empty());
    }

    #[test]
    fn transcript_verification_rejects_missing_or_changed_history() {
        let cwd = tempfile::tempdir().unwrap();
        let request = request(cwd.path());
        let turns = json!([{ "items": [
            { "type": "userMessage", "content": [{ "type": "text", "text": "Question" }] },
            { "type": "agentMessage", "text": "Answer" }
        ] }]);
        assert!(verify_transcript(&request, &turns).is_ok());
        assert!(verify_transcript(&request, &json!([{ "items": [] }])).is_err());
        assert!(verify_transcript(
            &request,
            &json!([{ "items": [
            { "type": "userMessage", "text": "Question" },
            { "type": "agentMessage", "text": "Truncated answer" }
        ] }])
        )
        .is_err());
        let continued = json!([{ "items": [
            { "type": "userMessage", "text": "Question" },
            { "type": "agentMessage", "text": "Answer" },
            { "type": "userMessage", "text": "Continue" }
        ] }]);
        assert!(verify_transcript(&request, &continued).is_ok());
    }

    #[test]
    fn durable_receipt_reuses_only_the_same_source_snapshot() {
        let cwd = tempfile::tempdir().unwrap();
        let mut request = request(cwd.path());
        let key = receipt_key(&request).unwrap();
        assert_eq!(key, receipt_key(&request).unwrap());
        request.messages[0].content.push_str(" changed");
        assert_ne!(key, receipt_key(&request).unwrap());
        let path = cwd.path().join("receipt.json");
        let receipt = DispatchReceipt {
            source_session_id: "source-1".into(),
            import_id: None,
            thread_id: Some("target-1".into()),
        };
        write_receipt(&path, &receipt).unwrap();
        let read = read_receipt(&path).unwrap().unwrap();
        assert_eq!(read.source_session_id, "source-1");
        assert_eq!(read.thread_id.as_deref(), Some("target-1"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn task_send_rejects_relative_paths_and_unknown_policies() {
        assert!(normalize_turn_input(vec![CodexAppTurnInput::LocalImage {
            path: "relative.png".into(),
            detail: None,
        }])
        .unwrap_err()
        .to_string()
        .contains("absolute"));
        assert!(validate_approval_policy(Some("sometimes".into())).is_err());
    }
}
