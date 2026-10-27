//! Narrow Cua Driver MCP bridge. Arbitrary tools, scripts, clipboard and held
//! input are deliberately absent from this desktop transport.
use super::{cli, contracts::ResourceRef, service::Service};
use crate::{
    automation::types::{AutomationError, Result},
    cua_sandbox::{protocol::WsRequest, remote_client::CuaRemoteClient},
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct MutationCleanup {
    service: Arc<Service>,
    reference: ResourceRef,
    armed: bool,
}
impl Drop for MutationCleanup {
    fn drop(&mut self) {
        if self.armed {
            let service = self.service.clone();
            let reference = self.reference.clone();
            tokio::spawn(async move {
                let _ = service
                    .quarantine(&reference, "lume_driver_interrupted")
                    .await;
                let _ = service.stop(&reference).await;
            });
        }
    }
}

const REQUIRED: &[&str] = &[
    "get_desktop_state",
    "get_screen_size",
    "get_cursor_position",
    "click",
    "double_click",
    "right_click",
    "move_cursor",
    "type_text",
    "press_key",
    "hotkey",
    "scroll",
    "drag",
];

fn error(code: &str) -> AutomationError {
    AutomationError::BackendError {
        message: code.into(),
    }
}

#[derive(Debug, Clone)]
pub enum DriverAction {
    Capture,
    Cursor,
    Size,
    Input {
        tool: &'static str,
        arguments: Value,
    },
}

/// Legacy protocol translation is private to this bridge. The Driver port
/// does not receive a computer-server command or an arbitrary MCP tool name.
fn translate(request: WsRequest) -> Result<DriverAction> {
    let tool = match request.command.as_str() {
        "screenshot" => return Ok(DriverAction::Capture),
        "get_cursor_position" => return Ok(DriverAction::Cursor),
        "get_screen_size" => return Ok(DriverAction::Size),
        "left_click" => "click",
        "double_click" => "double_click",
        "right_click" => "right_click",
        "type_text" => "type_text",
        "press_key" => "press_key",
        "hotkey" => "hotkey",
        "move_cursor" => "move_cursor",
        "scroll" => "scroll",
        "drag" => "drag",
        _ => return Err(AutomationError::UnsupportedPlatform),
    };
    let mut arguments = request.params;
    if !arguments.is_object() {
        return Err(error("lume_driver_arguments"));
    }
    if tool == "scroll" {
        let x = arguments["x"]
            .as_i64()
            .ok_or_else(|| error("lume_scroll_arguments"))?;
        let y = arguments["y"]
            .as_i64()
            .ok_or_else(|| error("lume_scroll_arguments"))?;
        if x != 0 && y != 0 {
            return Err(AutomationError::UnsupportedPlatform);
        }
        arguments = json!({"direction":if x<0{"left"}else if x>0{"right"}else if y<0{"up"}else{"down"},"amount":x.abs().max(y.abs())});
    }
    if tool == "drag" {
        let path = arguments["path"]
            .as_array()
            .ok_or_else(|| error("lume_drag_arguments"))?;
        if path.len() != 2 {
            return Err(AutomationError::UnsupportedPlatform);
        }
        arguments = json!({"from_x":path[0][0],"from_y":path[0][1],"to_x":path[1][0],"to_y":path[1][1],"button":arguments["button"]});
    }
    arguments["target"] = json!({"kind":"desktop","display_id":"primary"});
    arguments["delivery_mode"] = json!("foreground");
    Ok(DriverAction::Input { tool, arguments })
}

async fn send(
    writer: &mut tokio::process::ChildStdin,
    value: Value,
) -> std::result::Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| "lume_mcp_encode")?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| "lume_mcp_write".into())
}

async fn receive(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    id: u64,
) -> std::result::Result<Value, String> {
    for _ in 0..32 {
        let mut bytes = Vec::new();
        // read_until is bounded by take, including a malicious unbroken line.
        use tokio::io::AsyncReadExt;
        let count = reader
            .take(12 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|_| "lume_mcp_read")?;
        if count == 0 || count > 12 * 1024 * 1024 {
            return Err("lume_mcp_frame_limit".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "lume_mcp_schema")?;
        if value["id"] == id {
            if value.get("error").is_some() {
                return Err("lume_mcp_rpc_error".into());
            }
            return value
                .get("result")
                .cloned()
                .ok_or_else(|| "lume_mcp_result".into());
        }
        if value.get("id").is_some() {
            return Err("lume_mcp_response_order".into());
        }
    }
    Err("lume_mcp_notification_limit".into())
}

impl Service {
    pub(crate) async fn driver_probe(
        &self,
        reference: &ResourceRef,
        expected_version: &str,
        cancel: Arc<std::sync::atomic::AtomicBool>,
        identity: &cognia_desktop_guest::lume::DriverIdentity,
    ) -> std::result::Result<String, String> {
        let work = async {
            let mut session = self
                .driver_session(reference, expected_version, Some(identity))
                .await?;
            session.call(DriverAction::Capture).await?;
            Ok(session.schema_hash.clone())
        };
        tokio::select! {
            biased;
            _ = async { while !cancel.load(std::sync::atomic::Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(25)).await; } } => Err("lume_operation_cancelled".into()),
            result = work => result,
        }
    }

    async fn driver_session(
        &self,
        reference: &ResourceRef,
        expected_version: &str,
        identity: Option<&cognia_desktop_guest::lume::DriverIdentity>,
    ) -> std::result::Result<McpSession, String> {
        if !self.journal.lock().await.data.enabled {
            return Err("lume_feature_disabled".into());
        }
        let (owned, inspection) = self
            .verify(
                reference,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .await?;
        if owned.projection.quarantine || inspection.status != "running" {
            return Err("lume_driver_unavailable".into());
        }
        let key = cognia_secrets::keyring_secrets::get("lume-ssh", &reference.resource_id)?
            .ok_or("lume_ssh_key_missing")?;
        let files = cli::SshFiles::new(
            &key,
            owned
                .ssh_host_key
                .as_deref()
                .ok_or("lume_ssh_trust_required")?,
        )?;
        let mut command = files.command(
            inspection.ip_address.ok_or("lume_guest_ip_missing")?,
            owned.ssh_user.as_deref().ok_or("lume_ssh_user_missing")?,
            cli::DRIVER_COMMAND,
        )?;
        command.stdin(std::process::Stdio::piped());
        let child = command.spawn().map_err(|_| "lume_mcp_spawn")?;
        McpSession::connect(
            child,
            files,
            expected_version,
            owned.driver_schema_hash.as_deref(),
            Some(
                identity
                    .or(owned.driver_identity.as_ref())
                    .ok_or("lume_driver_identity_missing")?,
            ),
        )
        .await
    }

    pub(crate) async fn desktop_client(
        self: &Arc<Self>,
        reference: ResourceRef,
        binding: Option<super::contracts::BindingRef>,
    ) -> std::result::Result<Arc<CuaRemoteClient>, String> {
        let owned = self.journal.lock().await.resource(&reference)?.clone();
        if !owned.projection.readiness.gui || owned.projection.quarantine {
            return Err("lume_gui_unqualified".into());
        }
        let version = owned.driver_version.ok_or("lume_driver_unqualified")?;
        let session = Arc::new(tokio::sync::Mutex::new(
            self.driver_session(&reference, &version, None).await?,
        ));
        let native = self.send_fence(&reference, binding.as_ref());
        let service = self.clone();
        Ok(CuaRemoteClient::from_handler(Arc::new(
            move |request, admission| {
                let service = service.clone();
                let reference = reference.clone();
                let binding = binding.clone();
                let session = session.clone();
                let native = native.clone();
                Box::pin(async move {
                    if let Some(binding) = binding {
                        service.bound(&binding).await.map_err(|code| error(&code))?;
                    }
                    let action = translate(request)?;
                    if matches!(&action, DriverAction::Input { .. }) {
                        // GUI apps can save asynchronously after input returns.
                        // Typed writes cannot claim CAS against those writers.
                        service
                            .retain_workspace_writers(&reference)
                            .await
                            .map_err(|code| error(&code))?;
                    }
                    let (owned, inspection) = service
                        .verify(
                            &reference,
                            Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        )
                        .await
                        .map_err(|code| error(&code))?;
                    if !service.journal.lock().await.data.enabled
                        || !owned.projection.readiness.gui
                        || owned.projection.quarantine
                        || inspection.status != "running"
                    {
                        return Err(error("lume_gui_unavailable"));
                    }
                    let mut session = session.lock().await;
                    if matches!(&action, DriverAction::Input { .. }) {
                        service
                            .live_gui_profile(&reference)
                            .await
                            .map_err(|code| error(&code))?;
                    }
                    if !native() {
                        return Err(AutomationError::PreemptedBeforeSend);
                    }
                    if let Some(check) = admission {
                        check()?;
                    }
                    let mut cleanup = MutationCleanup {
                        service: service.clone(),
                        reference: reference.clone(),
                        armed: matches!(&action, DriverAction::Input { .. }),
                    };
                    let result = session.call(action).await;
                    if !native() {
                        let _ = service.quarantine(&reference, "lume_driver_revoked").await;
                        if cleanup.armed {
                            let _ = service.stop(&reference).await;
                        }
                        cleanup.armed = false;
                        return Err(error("lume_driver_revoked"));
                    }
                    if let Err(code) = &result {
                        let _ = service.quarantine(&reference, code).await;
                        let _ = service.stop(&reference).await;
                    }
                    cleanup.armed = false;
                    result.map_err(|code| error(&code))
                })
            },
        )))
    }
}

struct McpSession {
    _child: tokio::process::Child,
    writer: tokio::process::ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
    _files: cli::SshFiles,
    next_id: u64,
    label: String,
    failed: bool,
    schema_hash: String,
}

impl McpSession {
    async fn connect(
        mut child: tokio::process::Child,
        files: cli::SshFiles,
        expected_version: &str,
        expected_schema: Option<&str>,
        expected_identity: Option<&cognia_desktop_guest::lume::DriverIdentity>,
    ) -> std::result::Result<Self, String> {
        let mut writer = child.stdin.take().ok_or("lume_mcp_stdin")?;
        let mut reader = BufReader::new(child.stdout.take().ok_or("lume_mcp_stdout")?);
        let handshake = async {
            send(&mut writer,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cognia-lume","version":"1"},"cogniaDriverIdentity":expected_identity}})).await?;
            let initialized = receive(&mut reader, 1).await?;
            if initialized["serverInfo"]["version"] != expected_version
                || initialized["protocolVersion"] != "2024-11-05"
            {
                return Err("lume_driver_version".into());
            }
            send(
                &mut writer,
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            )
            .await?;
            send(
                &mut writer,
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
            )
            .await?;
            let tools = receive(&mut reader, 2).await?;
            validate_tools(&tools)?;
            let mut schemas: Vec<_> = tools["tools"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|tool| REQUIRED.iter().any(|name| tool["name"] == *name))
                .map(|tool| json!({"name":tool["name"],"inputSchema":tool["inputSchema"]}))
                .collect();
            schemas.sort_by_key(|schema| schema["name"].as_str().unwrap_or("").to_string());
            let hash = cognia_desktop_guest::lume::content_hash(
                serde_json::to_string(&schemas)
                    .map_err(|_| "lume_driver_schema")?
                    .as_bytes(),
            );
            if expected_schema.is_some_and(|expected| expected != hash) {
                return Err("lume_driver_schema_changed".into());
            }
            Ok::<String, String>(hash)
        };
        let negotiated = tokio::time::timeout(Duration::from_secs(10), handshake)
            .await
            .map_err(|_| "lume_driver_timeout".to_string())
            .and_then(|result| result);
        let schema_hash = match negotiated {
            Ok(hash) => hash,
            Err(code) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(code);
            }
        };
        Ok(Self {
            _child: child,
            writer,
            reader,
            _files: files,
            next_id: 3,
            label: format!("cognia-{}", uuid::Uuid::new_v4()),
            failed: false,
            schema_hash,
        })
    }
    async fn call(&mut self, action: DriverAction) -> std::result::Result<Value, String> {
        if self.failed {
            return Err("lume_mcp_session_closed".into());
        }
        // Dropping an in-flight call loses its ordered response. Keep the
        // session closed unless that exact request completes successfully.
        self.failed = true;
        let (tool, mut arguments) = match action {
            DriverAction::Capture => ("get_desktop_state", json!({"max_image_dimension":0})),
            DriverAction::Cursor => ("get_cursor_position", json!({})),
            DriverAction::Size => ("get_screen_size", json!({})),
            DriverAction::Input { tool, arguments } => (tool, arguments),
        };
        arguments["session"] = json!(self.label);
        let id = self.next_id;
        self.next_id += 1;
        let work = async {
            send(&mut self.writer,json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":tool,"arguments":arguments}})).await?;
            normalize(tool, receive(&mut self.reader, id).await?)
        };
        let result = tokio::time::timeout(Duration::from_secs(10), work)
            .await
            .map_err(|_| "lume_driver_timeout".to_string())
            .and_then(|r| r);
        if result.is_err() {
            let _ = self._child.kill().await;
            let _ = self._child.wait().await;
        } else {
            self.failed = false;
        }
        result
    }
}

fn validate_tools(value: &Value) -> std::result::Result<(), String> {
    let tools = value["tools"]
        .as_array()
        .ok_or("lume_driver_tools_schema")?;
    if tools.len() > 256
        || !REQUIRED.iter().all(|name| {
            tools
                .iter()
                .any(|tool| tool["name"] == *name && tool["inputSchema"]["type"] == "object")
        })
    {
        return Err("lume_driver_tools_missing".into());
    }
    Ok(())
}

fn normalize(tool: &str, value: Value) -> std::result::Result<Value, String> {
    if value["isError"] == true {
        return Err("lume_driver_tool_refused".into());
    }
    let content = value["content"].as_array().ok_or("lume_driver_content")?;
    if tool == "get_desktop_state" {
        let image = content
            .iter()
            .find(|c| c["type"] == "image")
            .ok_or("lume_driver_capture_missing")?;
        if !matches!(image["mimeType"].as_str(), Some("image/png" | "image/jpeg"))
            || image["data"]
                .as_str()
                .is_none_or(|s| s.len() > 12 * 1024 * 1024)
        {
            return Err("lume_driver_capture_limit".into());
        }
        validate_capture(image["data"].as_str().unwrap())?;
        return Ok(json!({"image_data":image["data"]}));
    }
    let result = value
        .get("structuredContent")
        .cloned()
        .or_else(|| {
            content
                .iter()
                .filter_map(|c| c["text"].as_str())
                .find_map(|text| serde_json::from_str::<Value>(text).ok())
        })
        .ok_or("lume_driver_result_schema")?;
    if result["effect"] == "refused" || result["success"] == false {
        return Err("lume_driver_action_refused".into());
    }
    if result["verified"] == false
        || matches!(
            result["effect"].as_str(),
            Some("unverifiable" | "suspected_noop")
        )
    {
        return Err("lume_driver_effect_unconfirmed".into());
    }
    match tool {
        "get_cursor_position"
            if result["x"].as_f64().is_some_and(f64::is_finite)
                && result["y"].as_f64().is_some_and(f64::is_finite) =>
        {
            Ok(json!({"position":[result["x"],result["y"]]}))
        }
        "get_screen_size"
            if result["width"].as_f64().is_some_and(|v| v > 0.0)
                && result["height"].as_f64().is_some_and(|v| v > 0.0) =>
        {
            Ok(json!({"size":[result["width"],result["height"]]}))
        }
        "get_cursor_position" | "get_screen_size" => Err("lume_driver_result_schema".into()),
        "move_cursor" if result["success"] == true => Ok(json!({"success":true})),
        _ if result["effect"] == "confirmed" => Ok(json!({"success":true})),
        _ => Err("lume_driver_effect_unconfirmed".into()),
    }
}

fn validate_capture(image: &str) -> std::result::Result<(), String> {
    use base64::Engine;
    if image.len() > 12 * 1024 * 1024 {
        return Err("lume_driver_capture_limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image)
        .map_err(|_| "lume_driver_capture_encoding")?;
    let format = xcap::image::guess_format(&bytes).map_err(|_| "lume_driver_capture_format")?;
    if !matches!(
        format,
        xcap::image::ImageFormat::Png | xcap::image::ImageFormat::Jpeg
    ) {
        return Err("lume_driver_capture_format".into());
    }
    let mut reader = xcap::image::ImageReader::new(std::io::Cursor::new(bytes));
    reader.set_format(format);
    let mut limits = xcap::image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| "lume_driver_capture_invalid")?;
    if u64::from(decoded.width())
        .saturating_mul(u64::from(decoded.height()))
        .saturating_mul(4)
        > 64 * 1024 * 1024
    {
        return Err("lume_driver_capture_limit".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    fn mcp_peer(
        version: &str,
        reply: Option<Value>,
    ) -> (tempfile::TempDir, tokio::process::Child, cli::SshFiles) {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("mcp-peer");
        let initialized = json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fixture","version":version}}});
        let tools = json!({"jsonrpc":"2.0","id":2,"result":{"tools":REQUIRED.iter().map(|name| json!({"name":name,"inputSchema":{"type":"object"}})).collect::<Vec<_>>()}});
        let emit = |value: &Value| {
            format!(
                "printf '%s\\n' '{}'\n",
                value.to_string().replace('\'', "'\\''")
            )
        };
        let script = format!("#!/bin/sh\nroot=$(dirname \"$0\")\nrecv() {{ IFS= read -r line || exit 0; printf '%s\\n' \"$line\" >> \"$root/requests\"; }}\nrecv\n{}recv\nrecv\n{}recv\ntouch \"$root/call-seen\"\n{}recv\ntouch \"$root/replayed\"\n", emit(&initialized), emit(&tools), reply.as_ref().map(emit).unwrap_or_default());
        std::fs::write(&binary, script).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let child = cli::command(&binary, &[])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        (
            root,
            child,
            cli::SshFiles::new("fixture", "fixture").unwrap(),
        )
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_handshake_pins_version_and_schema_before_tool_calls() {
        for (version, pin, code) in [
            ("changed", None, "lume_driver_version"),
            (
                "approved",
                Some("changed-schema"),
                "lume_driver_schema_changed",
            ),
        ] {
            let (root, child, files) = mcp_peer(version, None);
            let result = McpSession::connect(child, files, "approved", pin, None).await;
            assert!(matches!(result, Err(ref error) if error == code));
            let sent = std::fs::read_to_string(root.path().join("requests")).unwrap();
            assert!(!sent.contains("tools/call"));
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn supported_stdio_peer_returns_a_valid_observation() {
        let (root, child, files) = mcp_peer(
            "approved",
            Some(
                json!({"jsonrpc":"2.0","id":3,"result":{"content":[],"structuredContent":{"x":4,"y":6}}}),
            ),
        );
        let mut session = McpSession::connect(child, files, "approved", None, None)
            .await
            .unwrap();
        assert_eq!(session.schema_hash.len(), 64);
        assert_eq!(
            session.call(DriverAction::Cursor).await.unwrap(),
            json!({"position":[4,6]})
        );
        assert!(!session.failed);
        assert!(root.path().join("call-seen").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn initialize_carries_the_approved_identity_to_the_guest_guard() {
        let identity = cognia_desktop_guest::lume::DriverIdentity::from_codesign(
            &format!("Identifier=com.trycua.driver\nTeamIdentifier=TEAM123456\nCDHash={}\ndesignated => identifier \"com.trycua.driver\" and anchor apple generic\n", "a".repeat(40)), "b".repeat(64), 42, 501).unwrap();
        let (root, child, files) = mcp_peer("approved", None);
        let _session = McpSession::connect(child, files, "approved", None, Some(&identity))
            .await
            .unwrap();
        let sent = std::fs::read_to_string(root.path().join("requests")).unwrap();
        let initialize: Value = serde_json::from_str(sent.lines().next().unwrap()).unwrap();
        assert_eq!(
            initialize["params"]["cogniaDriverIdentity"],
            serde_json::to_value(identity).unwrap()
        );
        assert!(!sent.contains("tools/call"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_stdio_reply_reaps_the_child_and_never_replays() {
        for reply in [
            json!({"jsonrpc":"2.0","id":999,"result":{}}),
            json!({"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"image","mimeType":"image/png","data":"invalid"}]}}),
        ] {
            let (root, child, files) = mcp_peer("approved", Some(reply));
            let mut session = McpSession::connect(child, files, "approved", None, None)
                .await
                .unwrap();
            assert!(session.call(DriverAction::Capture).await.is_err());
            assert!(session.failed);
            assert!(session._child.try_wait().unwrap().is_some());
            assert_eq!(
                session.call(DriverAction::Capture).await.unwrap_err(),
                "lume_mcp_session_closed"
            );
            let sent = std::fs::read_to_string(root.path().join("requests")).unwrap();
            assert_eq!(
                sent.lines()
                    .filter(|line| line.contains("tools/call"))
                    .count(),
                1
            );
            assert!(!root.path().join("replayed").exists());
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn dropped_stdio_call_cannot_reuse_an_unsettled_response() {
        let (root, child, files) = mcp_peer("approved", None);
        let mut session = McpSession::connect(child, files, "approved", None, None)
            .await
            .unwrap();
        let mut call = Box::pin(session.call(DriverAction::Cursor));
        tokio::select! {
            result = &mut call => panic!("unexpected completion: {result:?}"),
            result = tokio::time::timeout(Duration::from_secs(2), async {
                while !root.path().join("call-seen").exists() { tokio::task::yield_now().await; }
            }) => result.unwrap(),
        }
        drop(call);
        assert_eq!(
            session.call(DriverAction::Cursor).await.unwrap_err(),
            "lume_mcp_session_closed"
        );
        assert!(!root.path().join("replayed").exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_timeout_closes_the_session_and_reaps_its_child() {
        let (_root, child, files) = mcp_peer("approved", None);
        let mut session = McpSession::connect(child, files, "approved", None, None)
            .await
            .unwrap();
        assert_eq!(
            session.call(DriverAction::Cursor).await.unwrap_err(),
            "lume_driver_timeout"
        );
        assert!(session._child.try_wait().unwrap().is_some());
        assert_eq!(
            session.call(DriverAction::Cursor).await.unwrap_err(),
            "lume_mcp_session_closed"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn interrupted_input_cleanup_stops_the_owned_vm_and_revokes_its_fence() {
        let (root, service, reference) = super::super::service::tests::lifecycle_fixture().await;
        let fence = service.send_fence(&reference, None);
        let (ready, entered) = tokio::sync::oneshot::channel();
        let cleanup_service = service.clone();
        let task = tokio::spawn(async move {
            let _cleanup = MutationCleanup {
                service: cleanup_service,
                reference,
                armed: true,
            };
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        entered.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if root.path().join("stop-called").exists()
                    && service.snapshot().await["resources"][0]["state"] == "stopped"
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!fence());
    }
    #[test]
    fn clipboard_scripts_and_held_inputs_cannot_reach_mcp() {
        for command in [
            "clipboard_read",
            "clipboard_write",
            "run_script",
            "key_down",
            "mouse_down",
            "get_accessibility_tree",
        ] {
            assert!(translate(WsRequest {
                command: command.into(),
                params: json!({})
            })
            .is_err());
        }
        let action = translate(WsRequest {
            command: "left_click".into(),
            params: json!({"x":4,"y":6}),
        })
        .unwrap();
        assert!(matches!(action, DriverAction::Input { tool: "click", .. }));
    }
    #[test]
    fn tool_errors_and_invalid_capture_types_never_become_success() {
        assert!(normalize("click", json!({"isError":true,"content":[]})).is_err());
        assert!(normalize(
            "get_desktop_state",
            json!({"content":[{"type":"image","mimeType":"image/svg+xml","data":"x"}]})
        )
        .is_err());
        assert!(validate_tools(&json!({"tools":[]})).is_err());
        for result in [
            json!({}),
            json!({"effect":"unknown"}),
            json!({"effect":"unverifiable"}),
            json!({"effect":"suspected_noop"}),
            json!({"effect":"confirmed","verified":false}),
        ] {
            assert!(normalize("click", json!({"content":[],"structuredContent":result})).is_err());
        }
        assert!(normalize(
            "click",
            json!({"content":[],"structuredContent":{"effect":"confirmed","verified":true}})
        )
        .is_ok());
        assert!(normalize(
            "get_cursor_position",
            json!({"content":[],"structuredContent":{"x":null,"y":1}})
        )
        .is_err());
        assert!(normalize(
            "get_cursor_position",
            json!({"content":[],"structuredContent":{"effect":"confirmed","x":null,"y":1}})
        )
        .is_err());
        assert!(normalize(
            "get_screen_size",
            json!({"content":[],"structuredContent":{"effect":"confirmed","width":0,"height":768}})
        )
        .is_err());
    }
    #[test]
    fn runtime_capture_rejects_invalid_bytes_before_returning_a_frame() {
        use base64::Engine;
        for data in [
            "invalid-base64".to_string(),
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n"),
        ] {
            assert!(normalize(
                "get_desktop_state",
                json!({"content":[{"type":"image","mimeType":"image/png","data":data}]})
            )
            .is_err());
        }
        assert!(normalize(
            "get_screen_size",
            json!({"content":[],"structuredContent":{"width":0,"height":768}})
        )
        .is_err());
    }
    #[test]
    fn decodable_runtime_capture_keeps_the_original_encoded_frame() {
        use base64::Engine;
        let mut bytes = std::io::Cursor::new(Vec::new());
        xcap::image::DynamicImage::new_rgb8(2, 3)
            .write_to(&mut bytes, xcap::image::ImageFormat::Png)
            .unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
        let result = normalize(
            "get_desktop_state",
            json!({"content":[{"type":"image","mimeType":"image/png","data":encoded}]}),
        )
        .unwrap();
        assert_eq!(result["image_data"], encoded);
    }
    #[test]
    fn runtime_capture_respects_the_shared_rgba_frame_budget() {
        use base64::Engine;
        let mut bytes = std::io::Cursor::new(Vec::new());
        xcap::image::DynamicImage::new_luma8(5000, 5000)
            .write_to(&mut bytes, xcap::image::ImageFormat::Png)
            .unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
        assert!(normalize(
            "get_desktop_state",
            json!({"content":[{"type":"image","mimeType":"image/png","data":encoded}]})
        )
        .is_err());
    }
}
