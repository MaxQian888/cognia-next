//! Remote desktop observations reuse the local revision/token manager, but each
//! connection owns a distinct manager and input lock. Legacy computer-server
//! cannot attest individual windows: its one application is the whole desktop.

use super::{protocol, remote_client::CuaRemoteClient, CuaSandboxRegistry};
use crate::automation::{
    commands::now_ms, permission::ScreenshotScalingSettings,
    platform::shared::screenshot::downscale_encoded, session::*, types::*,
};
use base64::Engine as _;
use serde::Serialize;
use serde_json::json;
use std::time::{Duration, Instant};

const CONTROL_TTL: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlLease {
    pub token: String,
    pub expires_at: i64,
}

#[derive(Default)]
pub(crate) struct RemoteDesktop {
    pub sessions: UiSessionManager,
    control: Option<(ControlLease, Instant)>,
    // Set before a remote mutation can start. Cancellation drops the mutex
    // guard but leaves this state resident until completion is confirmed.
    cleanup_unconfirmed: bool,
    pub(crate) held_mouse_buttons: Vec<MouseButton>,
}

fn denied(reason: impl Into<String>) -> AutomationError {
    AutomationError::PermissionDenied {
        reason: reason.into(),
    }
}
fn backend(message: impl Into<String>) -> AutomationError {
    AutomationError::BackendError {
        message: message.into(),
    }
}
fn session_error(error: SessionError) -> AutomationError {
    match error {
        SessionError::TurnTokenUnknown
        | SessionError::TurnTokenConsumed
        | SessionError::TurnTokenExpired
        | SessionError::TurnBindingMismatch => denied(error.to_string()),
        _ => AutomationError::StaleElement,
    }
}

impl RemoteDesktop {
    pub(crate) fn invalidate(&mut self) {
        self.sessions = UiSessionManager::default();
        self.control = None;
    }
    fn expire(&mut self) {
        if self
            .control
            .as_ref()
            .is_some_and(|(_, deadline)| Instant::now() >= *deadline)
        {
            self.invalidate();
        }
    }
    pub(crate) fn require_quiescent(&self) -> Result<()> {
        if self.cleanup_unconfirmed {
            return Err(denied("sandbox execution or input cleanup is unconfirmed; stop the sandbox successfully before starting or controlling it again"));
        }
        Ok(())
    }
    pub(crate) fn confirm_quiescence(&mut self) {
        self.cleanup_unconfirmed = false;
        self.held_mouse_buttons.clear();
    }
    pub(crate) async fn run_mutation<T>(
        &mut self,
        operation: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        self.cleanup_unconfirmed = true;
        let result = operation.await;
        if result.is_ok() {
            self.cleanup_unconfirmed = false;
        }
        result
    }
    pub(crate) fn require_agent(&mut self) -> Result<()> {
        self.require_quiescent()?;
        self.expire();
        if self.control.is_some() {
            return Err(denied("sandbox desktop is under human control"));
        }
        Ok(())
    }
    pub(crate) fn require_controller(&mut self, token: &str) -> Result<()> {
        self.require_quiescent()?;
        self.expire();
        match &self.control {
            Some((lease, _)) if lease.token == token => Ok(()),
            _ => Err(denied(
                "sandbox control lease is absent, expired, or belongs to another controller",
            )),
        }
    }
    fn acquire(&mut self) -> Result<ControlLease> {
        self.require_agent()?;
        self.sessions = UiSessionManager::default();
        let lease = ControlLease {
            token: uuid::Uuid::now_v7().to_string(),
            expires_at: now_ms() + CONTROL_TTL.as_millis() as i64,
        };
        self.control = Some((lease.clone(), Instant::now() + CONTROL_TTL));
        Ok(lease)
    }
}

pub fn desktop_application(connection_id: &str) -> ResolvedApplication {
    ResolvedApplication {
        bundle_id: Some(format!("cognia.sandbox.desktop:{connection_id}")),
        path: None,
        display_name: "Sandbox desktop (all applications)".into(),
        process_id: 0,
    }
}

fn require_desktop_locator(connection_id: &str, locator: &AppLocator) -> Result<()> {
    match locator {
        AppLocator::BundleId { bundle_id }
            if Some(bundle_id) == desktop_application(connection_id).bundle_id.as_ref() => Ok(()),
        _ => Err(backend("This remote backend exposes the full desktop only. Use the exact bundleId returned by list_apps; application launch and window-scoped capture are unavailable.")),
    }
}

/// Fully decode bounded frames before issuing coordinate/token surfaces. Header
/// dimensions alone do not prove that the renderer can consume the pixel data.
pub(crate) async fn capture(client: &CuaRemoteClient) -> Result<Screenshot> {
    let response = client.call_simple(protocol::SCREENSHOT, json!({})).await?;
    let bytes = response
        .get("image_data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| backend("cua screenshot returned no image_data"))?;
    let bytes = bytes
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(bytes);
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(backend("cua screenshot exceeds 64 MiB"));
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(bytes)
        .map_err(|e| backend(format!("invalid cua screenshot: {e}")))?;
    let mut reader = xcap::image::ImageReader::new(std::io::Cursor::new(&decoded))
        .with_guessed_format()
        .map_err(|e| backend(e.to_string()))?;
    let encoded_format = reader.format();
    let format = match encoded_format {
        Some(xcap::image::ImageFormat::Png) => ImageFormat::Png,
        Some(xcap::image::ImageFormat::Jpeg) => ImageFormat::Jpeg,
        _ => return Err(backend("unsupported cua screenshot format")),
    };
    const MAX_DECODED_BYTES: u64 = 64 * 1024 * 1024;
    let mut limits = xcap::image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    reader.limits(limits.clone());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| backend(e.to_string()))?;
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return Err(backend("invalid cua screenshot dimensions"));
    }
    // Bound renderer RGBA allocation even for highly compressed RGB/gray frames.
    if u64::from(width) * u64::from(height) * 4 > MAX_DECODED_BYTES {
        return Err(backend(
            "cua screenshot exceeds 64 MiB decoded pixel budget",
        ));
    }
    let mut reader = xcap::image::ImageReader::new(std::io::Cursor::new(&decoded));
    reader.set_format(encoded_format.expect("PNG/JPEG format was validated"));
    reader.limits(limits);
    let image = reader
        .decode()
        .map_err(|e| backend(format!("invalid cua screenshot pixels: {e}")))?;
    if image.width() != width || image.height() != height {
        return Err(backend("cua screenshot dimensions changed during decoding"));
    }
    drop(image);
    Ok(Screenshot {
        bytes: bytes.into(),
        width,
        height,
        captured_at: now_ms(),
        format,
        source_width: None,
        source_height: None,
    })
}

impl CuaSandboxRegistry {
    pub async fn acquire_control(&self, id: &str) -> Result<ControlLease> {
        let mut desktop = self.desktop_guard(id).await;
        desktop.require_agent()?;
        let client = self.client(id).await?;
        // A legacy mouse-down may intentionally span multiple agent calls.
        // Human takeover must not inherit that held button.
        let held = desktop.held_mouse_buttons.clone();
        if !held.is_empty() {
            desktop
                .run_mutation(async {
                    for button in held {
                        client
                            .call_simple("mouse_up", json!({"button": button_name(button)}))
                            .await?;
                    }
                    Ok(())
                })
                .await?;
            desktop.held_mouse_buttons.clear();
        }
        // Prove GUI availability before handing the viewer an input lease.
        capture(&client).await?;
        desktop.acquire()
    }
    pub async fn renew_control(&self, id: &str, token: &str) -> Result<ControlLease> {
        let mut desktop = self.desktop_guard(id).await;
        desktop.require_controller(token)?;
        let lease = ControlLease {
            token: token.into(),
            expires_at: now_ms() + CONTROL_TTL.as_millis() as i64,
        };
        desktop.control = Some((lease.clone(), Instant::now() + CONTROL_TTL));
        Ok(lease)
    }
    pub async fn release_control(&self, id: &str, token: &str) -> Result<()> {
        let mut desktop = self.desktop_guard(id).await;
        desktop.require_controller(token)?;
        desktop.invalidate();
        Ok(())
    }
    pub async fn desktop_frame(&self, id: &str) -> Result<Screenshot> {
        let _desktop = self.desktop_guard(id).await;
        capture(self.client(id).await?.as_ref()).await
    }
    pub async fn control_input(
        &self,
        id: &str,
        token: &str,
        point: Option<Point>,
        action: UiAction,
    ) -> Result<()> {
        let mut desktop = self.desktop_guard(id).await;
        desktop.require_controller(token)?;
        let client = self.client(id).await?;
        // Revalidate the surface on every manual action, including a drag end.
        let frame = capture(&client).await?;
        desktop.require_controller(token)?;
        if let Some(point) = point {
            validate_point(point, frame.width, frame.height)?;
        }
        if let UiAction::Drag { to, .. } = &action {
            validate_point(*to, frame.width, frame.height)?;
        }
        validate_action(point, &action)?;
        desktop.run_mutation(deliver(&client, point, &action)).await
    }
    pub async fn remote_list_apps(&self, id: &str) -> Result<Vec<ResolvedApplication>> {
        let _desktop = self.agent_guard(id).await?;
        capture(self.client(id).await?.as_ref()).await?;
        Ok(vec![desktop_application(id)])
    }
    pub async fn remote_get_app_state(
        &self,
        id: &str,
        session_id: String,
        turn_binding: String,
        locator: AppLocator,
        options: GetAppStateOptions,
        scaling: ScreenshotScalingSettings,
    ) -> Result<UiStateRevision> {
        require_desktop_locator(id, &locator)?;
        let mut desktop = self.agent_guard(id).await?;
        let client = self.client(id).await?;
        let original = capture(&client).await?;
        let (width, height) = (original.width, original.height);
        let shot = if scaling.enabled {
            downscale_encoded(original.clone(), scaling.max_width, scaling.max_height)?
        } else {
            original.clone()
        };
        // Optional accessibility must never suppress pixel access. Unsupported
        // tree commands yield a truthful empty tree; no semantic refs invented.
        let mut roots = match client
            .call_simple(protocol::ACCESSIBILITY_TREE, json!({}))
            .await
        {
            Ok(tree) => crate::automation::cua_route::flatten_a11y(
                tree.get("tree")
                    .or_else(|| tree.get("nodes"))
                    .unwrap_or(&tree),
                0,
            ),
            Err(_) => vec![],
        };
        if let Some(depth) = options.max_depth {
            limit_tree_depth(&mut roots, depth);
        }
        let mut revision = desktop
            .sessions
            .record_state(CapturedUiState {
                session_id,
                turn_binding,
                app: desktop_application(id),
                surface: UiSurface {
                    window_id: None,
                    display_id: Some(id.into()),
                    logical_bounds: Rect {
                        x: 0,
                        y: 0,
                        width: width as i32,
                        height: height as i32,
                    },
                    pixel_width: shot.width,
                    pixel_height: shot.height,
                    scale_factor: 1.0,
                    coordinate_space: CoordinateSpace::ScreenshotPixels,
                },
                zoom_source: ((width, height) != (shot.width, shot.height)).then_some(original),
                captured_at: shot.captured_at,
                screenshot: Some(shot),
                roots,
                max_nodes: options.max_nodes,
                projection: options.projection,
            })
            .map_err(session_error)?;
        if options.disable_diff {
            revision.diff = None;
        }
        revision.screenshot_note = Some("Full sandbox desktop; window identity and semantic actions are unavailable. Use pixel actions.".into());
        Ok(revision)
    }
    pub async fn remote_query_elements(
        &self,
        id: &str,
        session: &str,
        lineage: &str,
        revision: u64,
        locator: &Locator,
        limit: usize,
    ) -> Result<Vec<UiTreeNode>> {
        self.agent_guard(id)
            .await?
            .sessions
            .query_elements(session, lineage, revision, locator, limit)
            .map_err(session_error)
    }
    pub async fn remote_zoom(
        &self,
        id: &str,
        session: &str,
        lineage: &str,
        revision: u64,
        region: Rect,
    ) -> Result<ZoomedRegion> {
        self.agent_guard(id)
            .await?
            .sessions
            .zoom_region(session, lineage, revision, region)
            .map_err(session_error)
    }
    pub async fn remote_expand(
        &self,
        id: &str,
        handle: &ElementHandle,
        token: Option<&str>,
        limit: usize,
    ) -> Result<ExpandedElements> {
        self.agent_guard(id)
            .await?
            .sessions
            .expand_element(handle, token, limit)
            .map_err(session_error)
    }
    pub async fn remote_perform_action(
        &self,
        id: &str,
        request: ActionRequest,
        turn_binding: &str,
    ) -> Result<ActionResult> {
        let started = Instant::now();
        let mut desktop = self.agent_guard(id).await?;
        if matches!(request.strategy, ActionStrategy::Semantic)
            || matches!(request.target, ActionTarget::Element { .. })
        {
            return Err(AutomationError::UnsupportedPlatform);
        }
        let prepared = desktop
            .sessions
            .prepare_action(&request, turn_binding)
            .map_err(session_error)?;
        // Once an input can be submitted, no other observation may authorize
        // a follow-up action, even if this caller is cancelled during delivery.
        desktop.sessions = UiSessionManager::default();
        let mut action = request.action;
        if let UiAction::Drag { to, .. } = &mut action {
            *to = pixel_to_global_point(&prepared.state.surface, *to).map_err(session_error)?;
        }
        let client = self.client(id).await?;
        let current = capture(&client).await?;
        let bounds = prepared.state.surface.logical_bounds;
        if current.width != bounds.width as u32 || current.height != bounds.height as u32 {
            desktop.sessions = UiSessionManager::default();
            return Err(AutomationError::StaleElement);
        }
        validate_action(prepared.point, &action)?;
        desktop
            .run_mutation(deliver(&client, prepared.point, &action))
            .await?;
        Ok(ActionResult { status: ActionStatus::Delivered, method: Some(ActionMethod::Synthetic),
            before_revision: prepared.state.revision, after_revision: None,
            evidence: vec![ActionEvidence { kind: "remoteInputAcknowledged".into(),
                message: "computer-server acknowledged synthetic input; observe again to verify its effect".into(),
                revision: Some(prepared.state.revision) }],
            policy_decision: ActionPolicyDecision { allowed: true, reason: None },
            duration_ms: started.elapsed().as_millis() as u64 })
    }
}

fn limit_tree_depth(nodes: &mut [ElementInfo], remaining: u32) {
    for node in nodes {
        if remaining == 0 {
            node.children = None;
        } else if let Some(children) = node.children.as_mut() {
            limit_tree_depth(children, remaining - 1);
        }
    }
}

fn validate_point(point: Point, width: u32, height: u32) -> Result<()> {
    if point.x < 0 || point.y < 0 || point.x as u32 >= width || point.y as u32 >= height {
        return Err(backend("remote input point is outside the desktop surface"));
    }
    Ok(())
}

pub(crate) fn validate_action(point: Option<Point>, action: &UiAction) -> Result<()> {
    match action {
        UiAction::Click { count, .. } => {
            if point.is_none() {
                return Err(backend("remote pointer action requires a point"));
            }
            if !(1..=3).contains(&count.unwrap_or(1)) {
                return Err(backend("click count must be between 1 and 3"));
            }
        }
        UiAction::Drag { .. } | UiAction::Scroll { .. } => {
            if point.is_none() {
                return Err(backend("remote pointer action requires a point"));
            }
        }
        UiAction::PressKey { chord } if chord.0.split('+').all(|key| key.trim().is_empty()) => {
            return Err(backend("key chord is empty"))
        }
        UiAction::PressKey { .. } | UiAction::TypeText { .. } => {}
        _ => return Err(AutomationError::UnsupportedPlatform),
    }
    Ok(())
}

pub(crate) async fn deliver(
    client: &CuaRemoteClient,
    point: Option<Point>,
    action: &UiAction,
) -> Result<()> {
    validate_action(point, action)?;
    let require_point = || point.ok_or_else(|| backend("remote pointer action requires a point"));
    match action {
        UiAction::Click { button, count } => {
            let point = require_point()?;
            let button = button.unwrap_or(MouseButton::Left);
            let count = count.unwrap_or(1);
            if count == 0 || count > 3 {
                return Err(backend("click count must be between 1 and 3"));
            }
            if button != MouseButton::Middle
                && (count == 1 || (button == MouseButton::Left && count == 2))
            {
                client
                    .call(protocol::click_request(point, button, count))
                    .await?;
            } else {
                client.call(protocol::move_request(point)).await?;
                for _ in 0..count {
                    client
                        .call_simple("mouse_down", json!({"button": button_name(button)}))
                        .await?;
                    client
                        .call_simple("mouse_up", json!({"button": button_name(button)}))
                        .await?;
                }
            }
        }
        UiAction::Drag { to, opts } => {
            client
                .call(protocol::drag_request(
                    require_point()?,
                    *to,
                    opts.button.unwrap_or(MouseButton::Left),
                    opts.duration_ms.unwrap_or(150) as f64 / 1000.0,
                ))
                .await?;
        }
        UiAction::Scroll { opts } => {
            client
                .call(protocol::move_request(require_point()?))
                .await?;
            client.call(protocol::scroll_request(opts)).await?;
        }
        UiAction::PressKey { chord } => {
            client.call(protocol::keys_request(chord)).await?;
        }
        UiAction::TypeText { text } => {
            client.call(protocol::type_text_request(text)).await?;
        }
        _ => return Err(AutomationError::UnsupportedPlatform),
    }
    Ok(())
}
fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn upload_admission_must_revalidate_a_lease_that_expires_before_dispatch() {
        let mut desktop = RemoteDesktop::default();
        let lease = desktop.acquire().unwrap();
        desktop.require_controller(&lease.token).unwrap();
        // Model a Docker admission await taking longer than the remaining lease.
        desktop.control.as_mut().unwrap().1 = Instant::now() - Duration::from_millis(1);
        tokio::task::yield_now().await;
        let mut dispatched = false;
        let result: Result<()> = async {
            desktop.require_controller(&lease.token)?;
            desktop
                .run_mutation(async {
                    dispatched = true;
                    Ok(())
                })
                .await
        }
        .await;
        assert!(result.is_err());
        assert!(!dispatched);
        assert!(desktop.require_agent().is_ok());
    }

    #[tokio::test]
    async fn acknowledged_file_error_preserves_control_but_cancelled_upload_quarantines() {
        let mut desktop = RemoteDesktop::default();
        let lease = desktop.acquire().unwrap();
        let reply = desktop
            .run_mutation(async {
                Ok(super::super::file_transfer::TransferReply(Err(
                    "File exists".into(),
                )))
            })
            .await
            .unwrap();
        assert!(reply.upload("/file", 0, "hash").is_err());
        assert!(desktop.require_controller(&lease.token).is_ok());
        let operation = desktop.run_mutation(std::future::pending::<
            Result<super::super::file_transfer::TransferReply>,
        >());
        assert!(tokio::time::timeout(Duration::from_millis(1), operation)
            .await
            .is_err());
        assert!(desktop.require_controller(&lease.token).is_err());
        desktop.invalidate();
        assert!(desktop.require_agent().is_err());
        desktop.confirm_quiescence();
        assert!(desktop.require_agent().is_ok());
    }

    #[test]
    fn desktop_identity_is_bound_to_connection_and_never_resolves_local_apps() {
        let locator = AppLocator::BundleId {
            bundle_id: desktop_application("a").bundle_id.unwrap(),
        };
        assert!(require_desktop_locator("a", &locator).is_ok());
        assert!(require_desktop_locator("b", &locator).is_err());
        assert!(require_desktop_locator(
            "a",
            &AppLocator::DisplayName {
                display_name: "Safari".into()
            }
        )
        .is_err());
    }
    #[test]
    fn takeover_excludes_agents_other_controllers_and_expired_tokens() {
        let mut desktop = RemoteDesktop::default();
        let lease = desktop.acquire().unwrap();
        assert!(desktop.require_agent().is_err());
        assert!(desktop.acquire().is_err());
        assert!(desktop.require_controller("wrong").is_err());
        assert!(desktop.require_controller(&lease.token).is_ok());
        desktop.control.as_mut().unwrap().1 = Instant::now() - Duration::from_millis(1);
        assert!(desktop.require_controller(&lease.token).is_err());
        assert!(desktop.require_agent().is_ok());
        assert_ne!(desktop.acquire().unwrap().token, lease.token);
    }
    #[test]
    fn requested_tree_depth_is_enforced_before_session_projection() {
        let mut roots = crate::automation::cua_route::flatten_a11y(
            &json!({"children":[{"children":[{"title":"hidden"}]}]}),
            0,
        );
        limit_tree_depth(&mut roots, 1);
        assert!(roots[0].children.as_ref().unwrap()[0].children.is_none());
    }
    #[test]
    fn manual_input_rejects_out_of_surface_coordinates() {
        assert!(validate_point(Point { x: 99, y: 49 }, 100, 50).is_ok());
        assert!(validate_point(Point { x: 100, y: 49 }, 100, 50).is_err());
        assert!(validate_point(Point { x: -1, y: 0 }, 100, 50).is_err());
    }
    async fn fixture() -> (
        CuaSandboxRegistry,
        tokio::task::JoinHandle<()>,
        std::sync::Arc<tokio::sync::Mutex<Vec<String>>>,
    ) {
        fixture_with_input_gate(None).await
    }

    async fn fixture_with_input_gate(
        input_gate: Option<std::sync::Arc<tokio::sync::Notify>>,
    ) -> (
        CuaSandboxRegistry,
        tokio::task::JoinHandle<()>,
        std::sync::Arc<tokio::sync::Mutex<Vec<String>>>,
    ) {
        fixture_with_frame(input_gate, None).await
    }

    async fn fixture_with_frame(
        input_gate: Option<std::sync::Arc<tokio::sync::Notify>>,
        frame: Option<Vec<u8>>,
    ) -> (
        CuaSandboxRegistry,
        tokio::task::JoinHandle<()>,
        std::sync::Arc<tokio::sync::Mutex<Vec<String>>>,
    ) {
        use futures_util::{SinkExt, StreamExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let calls = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let server = tokio::spawn(async move {
            let mut ws = super::super::remote_client::accept_test_client(&listener).await;
            let image = xcap::image::RgbaImage::new(100, 80);
            let mut png = std::io::Cursor::new(Vec::new());
            image
                .write_to(&mut png, xcap::image::ImageFormat::Png)
                .unwrap();
            let bytes = base64::engine::general_purpose::STANDARD
                .encode(frame.unwrap_or_else(|| png.into_inner()));
            while let Some(Ok(message)) = ws.next().await {
                let Ok(text) = message.to_text() else {
                    continue;
                };
                let request: serde_json::Value = serde_json::from_str(text).unwrap();
                let command = request["command"].as_str().unwrap();
                recorded.lock().await.push(command.to_owned());
                if command == "left_click" {
                    if let Some(gate) = &input_gate {
                        gate.notified().await;
                    }
                }
                let response = match command {
                    "screenshot" => json!({"image_data":bytes}),
                    "get_accessibility_tree" => {
                        json!({"tree":{"role":"desktop","title":"Desktop"}})
                    }
                    _ => json!({"success":true}),
                };
                if ws
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        response.to_string().into(),
                    ))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        });
        let client = CuaRemoteClient::connect(
            "127.0.0.1",
            port,
            super::super::remote_client::TEST_AUTH_TOKEN,
        )
        .await
        .unwrap();
        let registry = CuaSandboxRegistry::default();
        registry.insert_test_client("a", client).await;
        (registry, server, calls)
    }

    fn png_frame() -> Vec<u8> {
        let mut png = std::io::Cursor::new(Vec::new());
        xcap::image::RgbaImage::new(100, 80)
            .write_to(&mut png, xcap::image::ImageFormat::Png)
            .unwrap();
        png.into_inner()
    }

    async fn assert_frame_rejected(frame: Vec<u8>, expected_error: &str) {
        let (registry, server, _) = fixture_with_frame(None, Some(frame)).await;
        let result = registry
            .remote_get_app_state(
                "a",
                "invalid-frame".into(),
                "turn".into(),
                AppLocator::BundleId {
                    bundle_id: desktop_application("a").bundle_id.unwrap(),
                },
                GetAppStateOptions::default(),
                ScreenshotScalingSettings {
                    enabled: false,
                    max_width: 100,
                    max_height: 80,
                },
            )
            .await;
        server.abort();
        assert!(result.is_err(), "invalid frame issued an observation token");
        assert!(result.unwrap_err().to_string().contains(expected_error));
        // Invalid read-only observations must not quarantine desktop mutations.
        assert!(registry.desktop_guard("a").await.require_agent().is_ok());
    }

    #[tokio::test]
    async fn screenshot_rejects_truncated_png_with_valid_dimensions() {
        let mut frame = png_frame();
        let idat = frame.windows(4).position(|chunk| chunk == b"IDAT").unwrap();
        frame.truncate(idat + 4);
        assert_eq!(
            xcap::image::ImageReader::new(std::io::Cursor::new(&frame))
                .with_guessed_format()
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (100, 80)
        );
        assert_frame_rejected(frame, "invalid cua screenshot pixels").await;
    }

    #[tokio::test]
    async fn screenshot_rejects_pixel_budget_before_decoding_payload() {
        let mut frame = png_frame();
        frame[16..20].copy_from_slice(&8192_u32.to_be_bytes());
        frame[20..24].copy_from_slice(&8192_u32.to_be_bytes());
        // Repair the IHDR CRC so this is valid metadata, not a corrupt header.
        let mut crc = u32::MAX;
        for byte in &frame[12..29] {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ (0xedb88320 & (0_u32.wrapping_sub(crc & 1)));
            }
        }
        frame[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert_eq!(
            xcap::image::ImageReader::new(std::io::Cursor::new(&frame))
                .with_guessed_format()
                .unwrap()
                .into_dimensions()
                .unwrap(),
            (8192, 8192)
        );
        assert_frame_rejected(frame, "cua screenshot exceeds 64 MiB decoded pixel budget").await;
    }

    async fn observe(reg: &CuaSandboxRegistry) -> UiStateRevision {
        reg.remote_get_app_state(
            "a",
            "session".into(),
            "turn".into(),
            AppLocator::BundleId {
                bundle_id: desktop_application("a").bundle_id.unwrap(),
            },
            GetAppStateOptions::default(),
            ScreenshotScalingSettings {
                enabled: false,
                max_width: 100,
                max_height: 80,
            },
        )
        .await
        .unwrap()
    }

    fn pixel_action(revision: &UiStateRevision) -> ActionRequest {
        ActionRequest {
            turn_token: revision.turn_token.clone(),
            strategy: ActionStrategy::Pixel,
            target: ActionTarget::Pixel {
                target: PixelTarget {
                    session_id: revision.session_id.clone(),
                    lineage_id: revision.lineage_id.clone(),
                    revision: revision.revision,
                    point: Point { x: 20, y: 30 },
                    screenshot_width: revision.surface.pixel_width,
                    screenshot_height: revision.surface.pixel_height,
                },
            },
            action: UiAction::Click {
                button: None,
                count: None,
            },
        }
    }

    #[tokio::test]
    async fn remote_tokens_are_target_bound_single_use_and_invalidated_by_takeover() {
        let (registry, server, calls) = fixture().await;
        let revision = observe(&registry).await;
        assert_eq!(revision.surface.pixel_width, 100);
        assert_eq!(revision.surface.pixel_height, 80);
        assert_eq!(revision.app.process_id, 0);
        let request = pixel_action(&revision);
        assert!(registry
            .remote_perform_action("b", request.clone(), "turn")
            .await
            .is_err());
        assert!(registry
            .remote_perform_action("a", request.clone(), "wrong-turn")
            .await
            .is_err());
        let result = registry
            .remote_perform_action("a", request.clone(), "turn")
            .await
            .unwrap();
        assert_eq!(result.status, ActionStatus::Delivered);
        assert_eq!(
            calls
                .lock()
                .await
                .iter()
                .filter(|c| *c == "left_click")
                .count(),
            1
        );
        assert!(registry
            .remote_perform_action("a", request, "turn")
            .await
            .is_err());
        let revision = observe(&registry).await;
        let lease = registry.acquire_control("a").await.unwrap();
        assert!(registry
            .remote_perform_action("a", pixel_action(&revision), "turn")
            .await
            .is_err());
        assert!(registry.agent_guard("a").await.is_err());
        assert!(registry
            .control_input(
                "a",
                &lease.token,
                Some(Point { x: 10, y: 10 }),
                UiAction::Click {
                    button: None,
                    count: Some(0)
                }
            )
            .await
            .is_err());
        assert!(registry.renew_control("a", &lease.token).await.is_ok());

        let blocked_exec = registry
            .exec(
                "a",
                &["xdotool".into(), "click".into(), "1".into()],
                None,
                &std::collections::BTreeMap::new(),
                None,
                Duration::from_secs(1),
            )
            .await;
        assert!(matches!(
            blocked_exec,
            Err(AutomationError::PermissionDenied { .. })
        ));

        assert!(registry.desktop_frame("a").await.is_ok());
        assert!(registry
            .control_input(
                "a",
                "wrong",
                None,
                UiAction::TypeText {
                    text: "blocked".into()
                }
            )
            .await
            .is_err());
        registry
            .control_input(
                "a",
                &lease.token,
                None,
                UiAction::TypeText {
                    text: "hello".into(),
                },
            )
            .await
            .unwrap();
        registry.release_control("a", &lease.token).await.unwrap();
        assert!(registry
            .remote_perform_action("a", pixel_action(&revision), "turn")
            .await
            .is_err());
        registry.disconnect_all().await;
        server.abort();
    }

    #[tokio::test]
    async fn query_zoom_and_expansion_never_read_another_targets_session() {
        let (registry, server, _) = fixture().await;
        let revision = observe(&registry).await;
        assert!(registry
            .remote_query_elements(
                "b",
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                &Locator::default(),
                10
            )
            .await
            .is_err());
        assert!(registry
            .remote_zoom(
                "b",
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                Rect {
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10
                }
            )
            .await
            .is_err());
        assert!(registry
            .remote_expand("b", &revision.tree.nodes[0].handle, None, 10)
            .await
            .is_err());
        let zoom = registry
            .remote_zoom(
                "a",
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                Rect {
                    x: 0,
                    y: 0,
                    width: 10,
                    height: 10,
                },
            )
            .await
            .unwrap();
        assert_eq!(zoom.screenshot.width, 10);
        registry.disconnect_all().await;
        server.abort();
    }
    fn clean_outcome() -> super::super::lifecycle::ExecOutcome {
        super::super::lifecycle::ExecOutcome {
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            duration_ms: 0,
            stdout_truncated: false,
            stderr_truncated: false,
        }
    }

    #[tokio::test]
    async fn cancelled_execution_quarantines_connection_until_confirmed_quiescence() {
        let registry = CuaSandboxRegistry::default();
        let executing = registry.clone();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let mut desktop = executing.agent_guard("cancelled").await.unwrap();
            desktop
                .run_mutation(async {
                    started.send(()).unwrap();
                    std::future::pending::<Result<super::super::lifecycle::ExecOutcome>>().await
                })
                .await
        });
        started_rx.await.unwrap();
        task.abort();
        let _ = task.await;
        // These must refuse before trying to locate Docker or a desktop server.
        assert!(matches!(
            registry.acquire_control("cancelled").await,
            Err(AutomationError::PermissionDenied { .. })
        ));
        assert!(registry.agent_guard("cancelled").await.is_err());
        let mut desktop = registry.desktop_guard("cancelled").await;
        desktop.invalidate(); // Suspend/failure invalidation cannot erase quarantine.
        assert!(desktop.require_agent().is_err());
        desktop.confirm_quiescence(); // Only acknowledged cleanup or stopped/absent container.
        assert!(desktop.require_agent().is_ok());
        assert!(desktop.acquire().is_ok());
    }

    #[tokio::test]
    async fn execution_errors_remain_quarantined_and_acknowledged_cleanup_reopens_admission() {
        let mut desktop = RemoteDesktop::default();
        desktop
            .run_mutation(async { Ok(clean_outcome()) })
            .await
            .unwrap();
        assert!(desktop.require_agent().is_ok());
        assert!(desktop
            .run_mutation(async { Err::<(), _>(backend("transport ended without cleanup frame")) })
            .await
            .is_err());
        assert!(desktop.require_agent().is_err());
        desktop.invalidate();
        assert!(desktop.require_agent().is_err());
    }

    #[tokio::test]
    async fn cancelling_sent_input_invalidates_other_sessions_before_acknowledgement() {
        let gate = std::sync::Arc::new(tokio::sync::Notify::new());
        let (registry, server, calls) = fixture_with_input_gate(Some(gate.clone())).await;
        let first = observe(&registry).await;
        let second = registry
            .remote_get_app_state(
                "a",
                "other-session".into(),
                "turn".into(),
                AppLocator::BundleId {
                    bundle_id: desktop_application("a").bundle_id.unwrap(),
                },
                GetAppStateOptions::default(),
                ScreenshotScalingSettings {
                    enabled: false,
                    max_width: 100,
                    max_height: 80,
                },
            )
            .await
            .unwrap();
        let executing = registry.clone();
        let task = tokio::spawn(async move {
            executing
                .remote_perform_action("a", pixel_action(&first), "turn")
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if calls.lock().await.iter().any(|call| call == "left_click") {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        task.abort();
        let _ = task.await;
        gate.notify_one();
        assert!(matches!(
            registry.acquire_control("a").await,
            Err(AutomationError::PermissionDenied { .. })
        ));
        // Even after cleanup is independently confirmed, the observation
        // predating the cancelled input must never become valid again.
        registry.desktop_guard("a").await.confirm_quiescence();
        assert!(matches!(
            registry
                .remote_perform_action("a", pixel_action(&second), "turn")
                .await,
            Err(AutomationError::PermissionDenied { .. })
        ));
        assert_eq!(
            calls
                .lock()
                .await
                .iter()
                .filter(|call| *call == "left_click")
                .count(),
            1
        );
        registry.disconnect_all().await;
        server.abort();
    }
    #[tokio::test]
    async fn takeover_releases_acknowledged_agent_mouse_buttons_before_granting_control() {
        let (registry, server, calls) = fixture().await;
        registry.desktop_guard("a").await.held_mouse_buttons =
            vec![MouseButton::Left, MouseButton::Middle];
        let lease = registry.acquire_control("a").await.unwrap();
        assert_eq!(
            calls
                .lock()
                .await
                .iter()
                .filter(|call| *call == "mouse_up")
                .count(),
            2
        );
        assert!(registry
            .desktop_guard("a")
            .await
            .held_mouse_buttons
            .is_empty());
        registry.release_control("a", &lease.token).await.unwrap();
        registry.disconnect_all().await;
        server.abort();
    }
}
