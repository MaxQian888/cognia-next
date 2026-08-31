//! App-scoped Computer Use sessions.
//!
//! A session couples one accessibility-tree revision with the screenshot and
//! coordinate surface observed in the same turn. Mutating actions must present
//! the fresh turn token issued by that revision; consuming the token forces the
//! caller to observe again before it can mutate a second time.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::automation::instruction_pack::{InstructionPack, InstructionPackRegistry};
use crate::automation::platform::shared::screenshot as shared_screenshot;
use crate::automation::platform::shared::tree_shape;
use crate::automation::types::{
    DragOpts, ElementInfo, KeyChord, Locator, MouseButton, Point, Rect, Screenshot, ScrollOpts,
};

pub const MODEL_TREE_MAX_NODES: usize = 1_000;
pub const MODEL_TREE_MAX_BYTES: usize = 256 * 1024;
pub const INSPECTOR_TREE_MAX_NODES: usize = 25_000;
pub const INSPECTOR_TREE_MAX_BYTES: usize = 8 * 1024 * 1024;
pub const EXPANSION_PAGE_MAX_NODES: usize = 250;
pub const TURN_TOKEN_TTL: Duration = Duration::from_secs(30);
/// How many sessions may hold a full-resolution `zoom_source` at once.
///
/// The shown frame is downscaled to the operator's vision budget, but the
/// capture it was made from is several MB of base64 on a Retina display, and
/// `sessions` is keyed by session id with no expiry: one entry per app the
/// agent ever touched, kept for the life of the process. Only the frame the
/// caller is currently reasoning about is worth that, so older sessions drop
/// theirs and `zoom_region` falls back to cropping the shown frame, which is
/// exactly what it already does when no scaling happened.
const MAX_RETAINED_ZOOM_SOURCES: usize = 2;

/// How the caller names an application.
///
/// `rename_all_fields` is load-bearing, not cosmetic: `rename_all` alone renames
/// only the *variant* tags, so the payload fields stayed `bundle_id` /
/// `display_name` while every TypeScript producer — `lib/automation/types.ts`,
/// the `DesktopAppLocator` zod schema, and the inspector — has always sent
/// `bundleId` / `displayName`. Those two variants therefore failed to
/// deserialize; only `path` worked, because it is a single word.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AppLocator {
    BundleId { bundle_id: String },
    Path { path: String },
    DisplayName { display_name: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedApplication {
    pub bundle_id: Option<String>,
    pub path: Option<String>,
    pub display_name: String,
    pub process_id: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CoordinateSpace {
    GlobalLogicalPoints,
    ScreenshotPixels,
    ModelPixels,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiSurface {
    pub window_id: Option<u64>,
    pub display_id: Option<String>,
    pub logical_bounds: Rect,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale_factor: f64,
    pub coordinate_space: CoordinateSpace,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedUiState {
    pub session_id: String,
    pub turn_binding: String,
    pub app: ResolvedApplication,
    pub surface: UiSurface,
    /// The frame the caller will be shown, already scaled to the operator's
    /// budget. `surface.pixel_width` / `pixel_height` describe THIS frame, so
    /// every pixel coordinate in and out of the session speaks one space.
    pub screenshot: Option<Screenshot>,
    /// The frame as captured, kept only when it is larger than `screenshot`.
    /// `zoom` crops this one, which is the whole reason downscaling the shown
    /// frame costs no detail: whatever the scaling threw away is still here to
    /// be looked at one region at a time.
    #[serde(default)]
    pub zoom_source: Option<Screenshot>,
    pub roots: Vec<ElementInfo>,
    pub captured_at: i64,
    #[serde(default = "default_model_node_budget")]
    pub max_nodes: usize,
    #[serde(default)]
    pub projection: UiTreeProjectionKind,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UiTreeProjectionKind {
    #[default]
    Model,
    Inspector,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GetAppStateOptions {
    pub disable_diff: bool,
    pub allow_launch: bool,
    pub max_nodes: usize,
    pub max_depth: Option<u32>,
    pub projection: UiTreeProjectionKind,
}

impl Default for GetAppStateOptions {
    fn default() -> Self {
        Self {
            disable_diff: false,
            allow_launch: false,
            max_nodes: MODEL_TREE_MAX_NODES,
            max_depth: None,
            projection: UiTreeProjectionKind::Model,
        }
    }
}

fn default_model_node_budget() -> usize {
    MODEL_TREE_MAX_NODES
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ElementHandle {
    pub session_id: String,
    pub lineage_id: String,
    pub revision: u64,
    pub index: usize,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTreeNode {
    pub handle: ElementHandle,
    pub parent_index: Option<usize>,
    pub element: ElementInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTreeProjection {
    pub nodes: Vec<UiTreeNode>,
    pub total_nodes: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedElements {
    pub nodes: Vec<UiTreeNode>,
    pub continuation_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTreeDiff {
    pub from_revision: u64,
    pub to_revision: u64,
    pub added: Vec<ElementInfo>,
    pub removed: Vec<String>,
    pub updated: Vec<ElementInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TruncationDescriptor {
    pub reason: String,
    pub materialized_nodes: usize,
    pub omitted_nodes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiStateRevision {
    pub session_id: String,
    pub lineage_id: String,
    pub revision: u64,
    pub turn_token: String,
    pub app: ResolvedApplication,
    pub surface: UiSurface,
    pub screenshot: Option<Screenshot>,
    pub projection: UiTreeProjectionKind,
    pub tree: UiTreeProjection,
    pub diff: Option<UiTreeDiff>,
    pub truncation: Vec<TruncationDescriptor>,
    pub instruction_pack: Option<InstructionPack>,
    pub captured_at: i64,
    /// Set when `AutomationSettings::screenshot_dedup` withheld a frame that
    /// was byte-identical to the one this session last showed. `screenshot`
    /// still carries the dimensions so a pixel target stays addressable; only
    /// `bytes` is cleared. See `automation::screenshot_dedup`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub screenshot_unchanged: bool,
    /// Short text the model reads in place of a withheld frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_note: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActionStrategy {
    Semantic,
    Pixel,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PixelTarget {
    pub session_id: String,
    pub lineage_id: String,
    pub revision: u64,
    pub point: Point,
    pub screenshot_width: u32,
    pub screenshot_height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActionTarget {
    Element { handle: ElementHandle },
    Pixel { target: PixelTarget },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiAction {
    Click {
        #[serde(default)]
        button: Option<MouseButton>,
        #[serde(default)]
        count: Option<u32>,
    },
    Drag {
        to: Point,
        #[serde(default)]
        opts: DragOpts,
    },
    Scroll {
        #[serde(default)]
        opts: ScrollOpts,
    },
    PressKey {
        chord: KeyChord,
    },
    TypeText {
        text: String,
    },
    SetValue {
        value: String,
    },
    SelectText {
        start: usize,
        end: usize,
    },
    SecondaryAction {
        name: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub turn_token: String,
    pub target: ActionTarget,
    pub action: UiAction,
    pub strategy: ActionStrategy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActionStatus {
    Delivered,
    NotDelivered,
    Refused,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActionMethod {
    Ax,
    Synthetic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionEvidence {
    pub kind: String,
    pub message: String,
    pub revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActionPolicyDecision {
    pub allowed: bool,
    pub reason: Option<String>,
}

/// One `zoom` result: a crop of the revision's frame plus where that crop sits
/// inside it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoomedRegion {
    pub session_id: String,
    pub lineage_id: String,
    pub revision: u64,
    pub screenshot: Screenshot,
    /// Where the crop sits, in the pixel space of the frame the caller was
    /// shown. Without this a zoom is worse than useless for grounding: the
    /// caller would report coordinates in crop space and the click would land
    /// somewhere else.
    pub region: Rect,
    /// Crop pixels per `region` pixel. The crop is taken from the frame as
    /// captured, which is larger than the frame the caller was shown whenever
    /// screenshot scaling is on. A point read off the crop maps back with
    /// `region.origin + crop_point / scale`, and `scale` is 1.0 whenever no
    /// scaling was applied.
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub status: ActionStatus,
    pub method: Option<ActionMethod>,
    pub before_revision: u64,
    pub after_revision: Option<u64>,
    pub evidence: Vec<ActionEvidence>,
    pub policy_decision: ActionPolicyDecision,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Error, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionError {
    #[error("turn token is unknown")]
    TurnTokenUnknown,
    #[error("turn token was already consumed")]
    TurnTokenConsumed,
    #[error("turn token has expired")]
    TurnTokenExpired,
    #[error("turn token belongs to another authenticated model turn")]
    TurnBindingMismatch,
    #[error("element handle belongs to another session")]
    CrossSessionHandle,
    #[error("element handle belongs to a stale revision")]
    StaleRevision,
    #[error("stale element fingerprint no longer matches the current revision")]
    StaleElementNotFound,
    #[error("stale element fingerprint matches multiple elements in the current revision")]
    StaleElementAmbiguous,
    #[error("element handle is invalid")]
    InvalidHandle,
    #[error("continuation token is unknown, expired, or belongs to another element")]
    ContinuationTokenInvalid,
    #[error("pixel target dimensions do not match the revision screenshot")]
    PixelSurfaceMismatch,
    #[error("the revision has no screenshot for a pixel action")]
    PixelSurfaceMissing,
}

#[derive(Debug, Clone)]
struct TokenRecord {
    session_id: String,
    lineage_id: String,
    revision: u64,
    consumed: bool,
    issued_at: Instant,
    turn_binding: String,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    lineage_id: String,
    revision: u64,
    app_identity: String,
    current: UiStateRevision,
    /// See `CapturedUiState::zoom_source`. `None` means the shown frame was
    /// already the captured one, so `zoom` crops `current.screenshot`.
    zoom_source: Option<Screenshot>,
    canonical: Vec<FlatNode>,
}

#[derive(Debug, Clone)]
struct ExpansionRecord {
    handle: ElementHandle,
    offset: usize,
}

#[derive(Default)]
pub struct UiSessionManager {
    sessions: HashMap<String, SessionRecord>,
    tokens: HashMap<String, TokenRecord>,
    expansion_tokens: HashMap<String, ExpansionRecord>,
    instruction_packs: InstructionPackRegistry,
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedAction {
    pub state: UiStateRevision,
    pub element: Option<ElementInfo>,
    pub point: Option<Point>,
    pub refetched_from_revision: Option<u64>,
    pub pixel_surface: bool,
    pub turn_binding: String,
}

impl UiSessionManager {
    pub fn record_state(
        &mut self,
        mut capture: CapturedUiState,
    ) -> Result<UiStateRevision, SessionError> {
        let instruction_pack = capture
            .app
            .bundle_id
            .as_deref()
            .and_then(|bundle_id| self.instruction_packs.for_bundle_id(bundle_id))
            .cloned();
        let app_identity = application_identity(&capture.app);
        let previous = self.sessions.get(&capture.session_id);
        let same_lineage = previous.is_some_and(|record| record.app_identity == app_identity);
        let previous_state = same_lineage
            .then(|| previous.map(|record| record.current.clone()))
            .flatten();
        let lineage_id = if same_lineage {
            previous
                .map(|record| record.lineage_id.clone())
                .unwrap_or_default()
        } else {
            Uuid::now_v7().to_string()
        };
        let revision = if same_lineage {
            previous.map_or(1, |record| record.revision.saturating_add(1))
        } else {
            1
        };

        let (projection_max_nodes, projection_max_bytes) = match capture.projection {
            UiTreeProjectionKind::Model => (MODEL_TREE_MAX_NODES, MODEL_TREE_MAX_BYTES),
            UiTreeProjectionKind::Inspector => (INSPECTOR_TREE_MAX_NODES, INSPECTOR_TREE_MAX_BYTES),
        };
        let max_nodes = capture.max_nodes.clamp(1, projection_max_nodes);
        let roots = std::mem::take(&mut capture.roots);
        let (canonical, total_nodes) = flatten_roots(&roots, INSPECTOR_TREE_MAX_NODES);
        drop_element_trees_iteratively(roots);
        let mut nodes = Vec::new();
        let mut projected_bytes = 0usize;
        let mut byte_truncated = false;
        for (index, node) in canonical.iter().take(max_nodes).cloned().enumerate() {
            let projected = UiTreeNode {
                handle: ElementHandle {
                    session_id: capture.session_id.clone(),
                    lineage_id: lineage_id.clone(),
                    revision,
                    index,
                    fingerprint: element_fingerprint(&node.element, node.parent_index),
                },
                parent_index: node.parent_index,
                element: node.element,
            };
            let node_bytes = serde_json::to_vec(&projected)
                .map(|encoded| encoded.len())
                .unwrap_or(projection_max_bytes);
            if !nodes.is_empty()
                && projected_bytes.saturating_add(node_bytes) > projection_max_bytes
            {
                byte_truncated = true;
                break;
            }
            projected_bytes = projected_bytes.saturating_add(node_bytes);
            nodes.push(projected);
        }
        let omitted_nodes = total_nodes.saturating_sub(nodes.len());
        let truncation = (omitted_nodes > 0)
            .then(|| TruncationDescriptor {
                reason: if byte_truncated {
                    "byteBudget".into()
                } else {
                    "nodeBudget".into()
                },
                materialized_nodes: nodes.len(),
                omitted_nodes,
            })
            .into_iter()
            .collect();
        let turn_token = Uuid::now_v7().to_string();
        let tree = UiTreeProjection {
            nodes,
            total_nodes,
            truncated: omitted_nodes > 0,
        };
        let diff = previous_state
            .as_ref()
            .map(|previous| diff_trees(&previous.tree, &tree, previous.revision, revision));
        let state = UiStateRevision {
            session_id: capture.session_id.clone(),
            lineage_id: lineage_id.clone(),
            revision,
            turn_token: turn_token.clone(),
            app: capture.app,
            surface: capture.surface,
            screenshot: capture.screenshot,
            projection: capture.projection,
            tree,
            diff,
            truncation,
            instruction_pack,
            captured_at: capture.captured_at,
            // Filled in by `screenshot_dedup` at the command boundary, which
            // is where the operator setting and the calling surface are known.
            screenshot_unchanged: false,
            screenshot_note: None,
        };
        self.tokens
            .retain(|_, record| record.session_id != capture.session_id);
        self.expansion_tokens
            .retain(|_, record| record.handle.session_id != capture.session_id);
        self.tokens.insert(
            turn_token,
            TokenRecord {
                session_id: capture.session_id.clone(),
                lineage_id: lineage_id.clone(),
                revision,
                consumed: false,
                issued_at: Instant::now(),
                turn_binding: capture.turn_binding,
            },
        );
        let session_id = capture.session_id.clone();
        self.sessions.insert(
            capture.session_id,
            SessionRecord {
                lineage_id,
                revision,
                app_identity,
                current: state.clone(),
                zoom_source: capture.zoom_source,
                canonical,
            },
        );
        self.trim_zoom_sources(&session_id);
        Ok(state)
    }

    /// Release every full-resolution frame beyond the newest few.
    ///
    /// Ordering is by capture time, with the session just recorded pinned so a
    /// clock that did not advance cannot drop the frame the caller is about to
    /// zoom into. Dropping one only costs detail: `zoom_region` falls back to
    /// the shown frame.
    fn trim_zoom_sources(&mut self, keep: &str) {
        let mut retained: Vec<(i64, String)> = self
            .sessions
            .iter()
            .filter(|(id, record)| record.zoom_source.is_some() && id.as_str() != keep)
            .map(|(id, record)| (record.current.captured_at, id.clone()))
            .collect();
        // `keep` occupies one of the slots, so the rest share what is left.
        let budget = MAX_RETAINED_ZOOM_SOURCES.saturating_sub(1);
        if retained.len() <= budget {
            return;
        }
        // Newest first, then release everything past the budget.
        retained.sort_unstable_by_key(|(captured_at, _)| std::cmp::Reverse(*captured_at));
        for (_, id) in retained.into_iter().skip(budget) {
            if let Some(record) = self.sessions.get_mut(&id) {
                record.zoom_source = None;
            }
        }
    }

    pub(crate) fn prepare_action(
        &mut self,
        request: &ActionRequest,
        turn_binding: &str,
    ) -> Result<PreparedAction, SessionError> {
        let (session_id, lineage_id) = match &request.target {
            ActionTarget::Element { handle } => {
                (handle.session_id.as_str(), handle.lineage_id.as_str())
            }
            ActionTarget::Pixel { target } => {
                (target.session_id.as_str(), target.lineage_id.as_str())
            }
        };
        let token = self
            .tokens
            .get(&request.turn_token)
            .ok_or(SessionError::TurnTokenUnknown)?;
        if token.consumed {
            return Err(SessionError::TurnTokenConsumed);
        }
        if token.issued_at.elapsed() > TURN_TOKEN_TTL {
            return Err(SessionError::TurnTokenExpired);
        }
        if token.turn_binding != turn_binding {
            return Err(SessionError::TurnBindingMismatch);
        }
        if token.session_id != session_id || token.lineage_id != lineage_id {
            return Err(SessionError::CrossSessionHandle);
        }
        let session = self
            .sessions
            .get(session_id)
            .ok_or(SessionError::CrossSessionHandle)?;
        if session.lineage_id != lineage_id {
            return Err(SessionError::CrossSessionHandle);
        }
        if token.revision != session.revision {
            return Err(SessionError::StaleRevision);
        }

        let (element, point, refetched_from_revision) = match &request.target {
            ActionTarget::Element { handle } => {
                let current = session.canonical.get(handle.index).filter(|node| {
                    handle.revision == session.revision
                        && element_fingerprint(&node.element, node.parent_index)
                            == handle.fingerprint
                });
                let (element, refetched_from_revision) = if let Some(node) = current {
                    (node.element.clone(), None)
                } else {
                    let mut matches = session
                        .canonical
                        .iter()
                        .filter(|node| {
                            element_fingerprint(&node.element, node.parent_index)
                                == handle.fingerprint
                        })
                        .map(|node| node.element.clone());
                    let element = matches.next().ok_or(SessionError::StaleElementNotFound)?;
                    if matches.next().is_some() {
                        return Err(SessionError::StaleElementAmbiguous);
                    }
                    (element, Some(handle.revision))
                };
                (Some(element), None, refetched_from_revision)
            }
            ActionTarget::Pixel { target } => {
                if session.revision != target.revision || token.revision != target.revision {
                    return Err(SessionError::StaleRevision);
                }
                let screenshot = session
                    .current
                    .screenshot
                    .as_ref()
                    .ok_or(SessionError::PixelSurfaceMissing)?;
                if screenshot.width != target.screenshot_width
                    || screenshot.height != target.screenshot_height
                    || session.current.surface.pixel_width != target.screenshot_width
                    || session.current.surface.pixel_height != target.screenshot_height
                {
                    return Err(SessionError::PixelSurfaceMismatch);
                }
                (
                    None,
                    Some(pixel_to_global_point(
                        &session.current.surface,
                        target.point,
                    )?),
                    None,
                )
            }
        };
        self.tokens
            .get_mut(&request.turn_token)
            .ok_or(SessionError::TurnTokenUnknown)?
            .consumed = true;
        let state = self
            .sessions
            .get(session_id)
            .map(|session| session.current.clone())
            .ok_or(SessionError::CrossSessionHandle)?;
        Ok(PreparedAction {
            state,
            element,
            point,
            refetched_from_revision,
            pixel_surface: matches!(&request.target, ActionTarget::Pixel { .. }),
            turn_binding: turn_binding.to_string(),
        })
    }

    pub fn expand_element(
        &mut self,
        handle: &ElementHandle,
        continuation_token: Option<&str>,
        limit: usize,
    ) -> Result<ExpandedElements, SessionError> {
        let offset = match continuation_token {
            None => 0,
            Some(token) => {
                let record = self
                    .expansion_tokens
                    .remove(token)
                    .ok_or(SessionError::ContinuationTokenInvalid)?;
                if record.handle != *handle {
                    return Err(SessionError::ContinuationTokenInvalid);
                }
                record.offset
            }
        };
        let session = self.validate_handle(handle)?;
        let limit = limit.clamp(1, EXPANSION_PAGE_MAX_NODES);
        let children = session
            .canonical
            .iter()
            .enumerate()
            .filter(|(_, node)| node.parent_index == Some(handle.index))
            .collect::<Vec<_>>();
        let nodes = children
            .iter()
            .skip(offset)
            .take(limit)
            .map(|(index, node)| tree_node_for(session, *index, node))
            .collect::<Vec<_>>();
        let consumed = offset.saturating_add(nodes.len());
        let next = (consumed < children.len()).then(|| {
            let token = Uuid::now_v7().to_string();
            (token, consumed)
        });
        let continuation_token = next.as_ref().map(|(token, _)| token.clone());
        if let Some((token, offset)) = next {
            self.expansion_tokens.insert(
                token,
                ExpansionRecord {
                    handle: handle.clone(),
                    offset,
                },
            );
        }
        Ok(ExpandedElements {
            nodes,
            continuation_token,
        })
    }

    /// Crop the frame a revision was captured with, so the model can look at
    /// one region at the resolution it was captured rather than at whatever
    /// survives being squeezed into a vision budget.
    ///
    /// The crop comes from a STORED frame, not a fresh capture. That keeps the
    /// zoom in the exact coordinate space the model already measured against.
    /// A re-capture could race the UI and hand back a region that no longer
    /// matches the revision the model is reasoning about, which is the
    /// stale-frame class of bug the pixel-target guard exists to prevent.
    ///
    /// `region` arrives in the pixel space of the frame the model was SHOWN.
    /// When screenshot scaling shrank that frame, the crop is taken from the
    /// full-resolution capture instead, which is what makes the scaling free:
    /// the base frame stays cheap and the detail is still reachable one region
    /// at a time.
    pub fn zoom_region(
        &self,
        session_id: &str,
        lineage_id: &str,
        revision: u64,
        region: Rect,
    ) -> Result<ZoomedRegion, SessionError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or(SessionError::CrossSessionHandle)?;
        if session.lineage_id != lineage_id || session.revision != revision {
            return Err(SessionError::StaleRevision);
        }
        let shown = session
            .current
            .screenshot
            .as_ref()
            .filter(|shot| shot.width > 0 && shot.height > 0)
            .ok_or(SessionError::PixelSurfaceMissing)?;
        let source = session
            .zoom_source
            .as_ref()
            .or(session.current.screenshot.as_ref())
            .filter(|shot| !shot.bytes.is_empty())
            .ok_or(SessionError::PixelSurfaceMissing)?
            .clone();

        // Clamp in the space the caller measured in, so an overhanging region
        // is reported back with the same numbers the caller can reason about.
        let (x, y, w, h) = shared_screenshot::clamp_crop_region(region, shown.width, shown.height);
        let scale = f64::from(source.width) / f64::from(shown.width);
        let scaled = Rect {
            x: scale_span(x, scale),
            y: scale_span(y, scale),
            width: scale_span(w, scale),
            height: scale_span(h, scale),
        };
        let screenshot = shared_screenshot::crop_encoded(source, scaled)
            .map_err(|_| SessionError::PixelSurfaceMismatch)?;

        Ok(ZoomedRegion {
            session_id: session.current.session_id.clone(),
            lineage_id: session.lineage_id.clone(),
            revision: session.revision,
            region: Rect {
                x: i32::try_from(x).unwrap_or(i32::MAX),
                y: i32::try_from(y).unwrap_or(i32::MAX),
                width: i32::try_from(w).unwrap_or(i32::MAX),
                height: i32::try_from(h).unwrap_or(i32::MAX),
            },
            // Reported from the crop that actually came back rather than from
            // the requested ratio, so rounding in the crop cannot desync the
            // mapping the caller is told to use.
            scale: if w == 0 {
                1.0
            } else {
                f64::from(screenshot.width) / f64::from(w)
            },
            screenshot,
        })
    }

    pub fn query_elements(
        &self,
        session_id: &str,
        lineage_id: &str,
        revision: u64,
        locator: &Locator,
        limit: usize,
    ) -> Result<Vec<UiTreeNode>, SessionError> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or(SessionError::CrossSessionHandle)?;
        if session.lineage_id != lineage_id || session.revision != revision {
            return Err(SessionError::StaleRevision);
        }
        Ok(session
            .canonical
            .iter()
            .enumerate()
            .filter(|(_, node)| {
                tree_shape::matches_locator(&tree_shape::fields_of(&node.element), locator)
            })
            .take(limit.clamp(1, MODEL_TREE_MAX_NODES))
            .map(|(index, node)| tree_node_for(session, index, node))
            .collect())
    }

    fn validate_handle(&self, handle: &ElementHandle) -> Result<&SessionRecord, SessionError> {
        let session = self
            .sessions
            .get(&handle.session_id)
            .ok_or(SessionError::CrossSessionHandle)?;
        if session.lineage_id != handle.lineage_id || session.revision != handle.revision {
            return Err(SessionError::StaleRevision);
        }
        let node = session
            .canonical
            .get(handle.index)
            .ok_or(SessionError::InvalidHandle)?;
        if element_fingerprint(&node.element, node.parent_index) != handle.fingerprint {
            return Err(SessionError::InvalidHandle);
        }
        Ok(session)
    }
}

#[derive(Debug, Clone)]
struct FlatNode {
    parent_index: Option<usize>,
    element: ElementInfo,
}

fn tree_node_for(session: &SessionRecord, index: usize, node: &FlatNode) -> UiTreeNode {
    UiTreeNode {
        handle: ElementHandle {
            session_id: session.current.session_id.clone(),
            lineage_id: session.lineage_id.clone(),
            revision: session.revision,
            index,
            fingerprint: element_fingerprint(&node.element, node.parent_index),
        },
        parent_index: node.parent_index,
        element: node.element.clone(),
    }
}

fn flatten_roots(roots: &[ElementInfo], max_nodes: usize) -> (Vec<FlatNode>, usize) {
    let mut out = Vec::new();
    let mut total = 0usize;
    let mut stack = roots
        .iter()
        .rev()
        .map(|root| (root, None))
        .collect::<Vec<_>>();
    while let Some((element, parent_index)) = stack.pop() {
        total = total.saturating_add(1);
        let this_index = (out.len() < max_nodes).then_some(out.len());
        if let Some(this_index) = this_index {
            out.push(FlatNode {
                parent_index,
                element: clone_without_children(element),
            });
            if let Some(children) = element.children.as_ref() {
                for child in children.iter().rev() {
                    stack.push((child, Some(this_index)));
                }
            }
        } else if let Some(children) = element.children.as_ref() {
            for child in children.iter().rev() {
                stack.push((child, parent_index));
            }
        }
    }
    (out, total)
}

fn clone_without_children(element: &ElementInfo) -> ElementInfo {
    ElementInfo {
        element_ref: element.element_ref.clone(),
        name: element.name.clone(),
        automation_id: element.automation_id.clone(),
        control_type: element.control_type.clone(),
        class_name: element.class_name.clone(),
        bounding_rect: element.bounding_rect,
        is_enabled: element.is_enabled,
        is_focused: element.is_focused,
        process_id: element.process_id,
        process_name: element.process_name.clone(),
        window_title: element.window_title.clone(),
        children: None,
    }
}

fn drop_element_trees_iteratively(roots: Vec<ElementInfo>) {
    let mut stack = roots;
    while let Some(mut element) = stack.pop() {
        if let Some(children) = element.children.take() {
            stack.extend(children);
        }
    }
}

fn application_identity(app: &ResolvedApplication) -> String {
    app.bundle_id
        .as_ref()
        .or(app.path.as_ref())
        .cloned()
        .unwrap_or_else(|| app.display_name.to_lowercase())
}

fn element_fingerprint(element: &ElementInfo, parent_index: Option<usize>) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    element.automation_id.hash(&mut hasher);
    element.control_type.hash(&mut hasher);
    element.class_name.hash(&mut hasher);
    element.name.hash(&mut hasher);
    element.process_id.hash(&mut hasher);
    element.window_title.hash(&mut hasher);
    // Parent indices and geometry are deliberately excluded: insertion of an
    // unrelated sibling or a window move must not invalidate a structural
    // handle. A duplicate stable shape is rejected as ambiguous at refetch.
    let _ = parent_index;
    format!("{:016x}", hasher.finish())
}

/// Scale one span from the shown frame's pixel space into the captured
/// frame's. Saturating rather than wrapping, because a region that overflows
/// has to clamp to the frame edge and not wrap around to zero.
fn scale_span(value: u32, scale: f64) -> i32 {
    let scaled = (f64::from(value) * scale).round();
    if scaled >= f64::from(i32::MAX) {
        i32::MAX
    } else if scaled <= 0.0 {
        0
    } else {
        scaled as i32
    }
}

pub(crate) fn pixel_to_global_point(
    surface: &UiSurface,
    point: Point,
) -> Result<Point, SessionError> {
    if surface.pixel_width == 0
        || surface.pixel_height == 0
        || surface.logical_bounds.width <= 0
        || surface.logical_bounds.height <= 0
        || point.x < 0
        || point.y < 0
        || u32::try_from(point.x).map_or(true, |x| x >= surface.pixel_width)
        || u32::try_from(point.y).map_or(true, |y| y >= surface.pixel_height)
    {
        return Err(SessionError::PixelSurfaceMismatch);
    }
    let x = f64::from(surface.logical_bounds.x)
        + f64::from(point.x) * f64::from(surface.logical_bounds.width)
            / f64::from(surface.pixel_width);
    let y = f64::from(surface.logical_bounds.y)
        + f64::from(point.y) * f64::from(surface.logical_bounds.height)
            / f64::from(surface.pixel_height);
    Ok(Point {
        x: x.round() as i32,
        y: y.round() as i32,
    })
}

fn diff_trees(
    previous: &UiTreeProjection,
    current: &UiTreeProjection,
    from_revision: u64,
    to_revision: u64,
) -> UiTreeDiff {
    let previous_by_key = previous
        .nodes
        .iter()
        .map(|node| (node_identity(node), node))
        .collect::<HashMap<_, _>>();
    let current_by_key = current
        .nodes
        .iter()
        .map(|node| (node_identity(node), node))
        .collect::<HashMap<_, _>>();

    let mut added = current_by_key
        .iter()
        .filter(|(key, _)| !previous_by_key.contains_key(*key))
        .map(|(_, node)| node.element.clone())
        .collect::<Vec<_>>();
    let mut removed = previous_by_key
        .iter()
        .filter(|(key, _)| !current_by_key.contains_key(*key))
        .map(|(_, node)| node.handle.fingerprint.clone())
        .collect::<Vec<_>>();
    let mut updated = current_by_key
        .iter()
        .filter_map(|(key, current_node)| {
            let previous_node = previous_by_key.get(key)?;
            let before = serde_json::to_value(&previous_node.element).ok()?;
            let after = serde_json::to_value(&current_node.element).ok()?;
            (before != after).then(|| current_node.element.clone())
        })
        .collect::<Vec<_>>();

    added.sort_by_key(element_sort_key);
    removed.sort();
    updated.sort_by_key(element_sort_key);
    UiTreeDiff {
        from_revision,
        to_revision,
        added,
        removed,
        updated,
    }
}

fn node_identity(node: &UiTreeNode) -> String {
    let element = &node.element;
    let stable = element
        .automation_id
        .as_ref()
        .map(|id| format!("id:{id}"))
        .unwrap_or_else(|| {
            format!(
                "fallback:{}:{}:{}:{}",
                element.element_ref.0,
                element.control_type.as_deref().unwrap_or_default(),
                element.class_name.as_deref().unwrap_or_default(),
                element.name.as_deref().unwrap_or_default()
            )
        });
    format!("{}:{stable}", node.parent_index.unwrap_or(usize::MAX))
}

fn element_sort_key(element: &ElementInfo) -> String {
    format!(
        "{}:{}:{}",
        element.automation_id.as_deref().unwrap_or_default(),
        element.control_type.as_deref().unwrap_or_default(),
        element.name.as_deref().unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::types::{ElementInfo, ElementRef};

    #[test]
    fn app_locator_wire_shape_matches_the_typescript_mirror() {
        // These are the exact payloads `lib/automation/types.ts` declares and the
        // `DesktopAppLocator` zod schema validates. Before `rename_all_fields`,
        // `bundleId` and `displayName` failed to deserialize here while `path`
        // worked, so the mismatch was invisible in the one variant anyone tested.
        let bundle: AppLocator =
            serde_json::from_str(r#"{"kind":"bundleId","bundleId":"com.apple.Safari"}"#).unwrap();
        assert_eq!(
            bundle,
            AppLocator::BundleId {
                bundle_id: "com.apple.Safari".into()
            }
        );

        let display: AppLocator =
            serde_json::from_str(r#"{"kind":"displayName","displayName":"Safari"}"#).unwrap();
        assert_eq!(
            display,
            AppLocator::DisplayName {
                display_name: "Safari".into()
            }
        );

        let path: AppLocator =
            serde_json::from_str(r#"{"kind":"path","path":"/Applications/Safari.app"}"#).unwrap();
        assert_eq!(
            path,
            AppLocator::Path {
                path: "/Applications/Safari.app".into()
            }
        );

        // And it serializes back into the same shape the renderer stores.
        assert_eq!(
            serde_json::to_string(&bundle).unwrap(),
            r#"{"kind":"bundleId","bundleId":"com.apple.Safari"}"#
        );
        assert_eq!(
            serde_json::to_string(&display).unwrap(),
            r#"{"kind":"displayName","displayName":"Safari"}"#
        );
    }

    fn root(name: &str) -> ElementInfo {
        ElementInfo {
            element_ref: ElementRef(format!("ref:{name}")),
            name: Some(name.to_string()),
            automation_id: Some("root".into()),
            control_type: Some("window".into()),
            class_name: None,
            bounding_rect: None,
            is_enabled: true,
            is_focused: true,
            process_id: Some(42),
            process_name: Some("Notes".into()),
            window_title: Some("Notes".into()),
            children: None,
        }
    }

    impl CapturedUiState {
        fn fixture(root: ElementInfo) -> Self {
            Self {
                session_id: "session:test".into(),
                turn_binding: "turn:test".into(),
                app: ResolvedApplication {
                    bundle_id: Some("com.apple.Notes".into()),
                    path: Some("/System/Applications/Notes.app".into()),
                    display_name: "Notes".into(),
                    process_id: 42,
                },
                surface: UiSurface {
                    window_id: Some(7),
                    display_id: Some("main".into()),
                    logical_bounds: crate::automation::types::Rect {
                        x: 0,
                        y: 0,
                        width: 800,
                        height: 600,
                    },
                    pixel_width: 1_600,
                    pixel_height: 1_200,
                    scale_factor: 2.0,
                    coordinate_space: CoordinateSpace::ScreenshotPixels,
                },
                screenshot: None,
                zoom_source: None,
                roots: vec![root],
                captured_at: 1,
                max_nodes: MODEL_TREE_MAX_NODES,
                projection: UiTreeProjectionKind::Model,
            }
        }
    }

    fn png_shot(w: u32, h: u32) -> Screenshot {
        use base64::engine::general_purpose;
        use base64::Engine as _;
        use xcap::image::{self, RgbaImage};
        let img = RgbaImage::new(w, h);
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        Screenshot {
            bytes: general_purpose::STANDARD.encode(bytes.into_inner()),
            width: w,
            height: h,
            captured_at: 1,
            format: crate::automation::types::ImageFormat::Png,
            source_width: None,
            source_height: None,
        }
    }

    #[test]
    fn zoom_returns_the_region_and_where_it_sits() {
        let mut sessions = UiSessionManager::default();
        let mut state = CapturedUiState::fixture(root("Notes"));
        state.screenshot = Some(png_shot(1_600, 1_200));
        let revision = sessions.record_state(state).unwrap();

        let zoom = sessions
            .zoom_region(
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                Rect {
                    x: 400,
                    y: 300,
                    width: 320,
                    height: 240,
                },
            )
            .expect("zoom");

        assert_eq!((zoom.screenshot.width, zoom.screenshot.height), (320, 240));
        // Without the origin a zoom is worse than useless for grounding: the
        // model would report coordinates in crop space and the click would
        // land somewhere else entirely.
        assert_eq!(zoom.region.x, 400);
        assert_eq!(zoom.region.y, 300);
        assert_eq!(zoom.revision, revision.revision);
    }

    #[test]
    fn zoom_crops_the_captured_frame_not_the_one_that_was_shown() {
        // The whole point of scaling the shown frame: the detail it drops is
        // still reachable, because `zoom` reads the capture.
        let mut sessions = UiSessionManager::default();
        let mut state = CapturedUiState::fixture(root("Notes"));
        state.screenshot = Some(png_shot(800, 600));
        state.zoom_source = Some(png_shot(1_600, 1_200));
        let revision = sessions.record_state(state).unwrap();

        let zoom = sessions
            .zoom_region(
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                Rect {
                    x: 200,
                    y: 150,
                    width: 160,
                    height: 120,
                },
            )
            .expect("zoom");

        // Asked for 160x120 of the shown frame, got 320x240 real pixels.
        assert_eq!((zoom.screenshot.width, zoom.screenshot.height), (320, 240));
        // Reported back in the space the caller measured in, so the origin can
        // be added to a coordinate without converting anything first.
        assert_eq!((zoom.region.x, zoom.region.y), (200, 150));
        assert_eq!((zoom.region.width, zoom.region.height), (160, 120));
        assert_eq!(zoom.scale, 2.0);
    }

    #[test]
    fn zoom_reports_unit_scale_when_nothing_was_downscaled() {
        let mut sessions = UiSessionManager::default();
        let mut state = CapturedUiState::fixture(root("Notes"));
        state.screenshot = Some(png_shot(800, 600));
        let revision = sessions.record_state(state).unwrap();

        let zoom = sessions
            .zoom_region(
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                Rect {
                    x: 10,
                    y: 20,
                    width: 100,
                    height: 80,
                },
            )
            .expect("zoom");

        assert_eq!(zoom.scale, 1.0);
        assert_eq!((zoom.screenshot.width, zoom.screenshot.height), (100, 80));
    }

    #[test]
    fn zoom_clamps_an_overhanging_region_in_the_space_the_caller_measured_in() {
        let mut sessions = UiSessionManager::default();
        let mut state = CapturedUiState::fixture(root("Notes"));
        state.screenshot = Some(png_shot(800, 600));
        state.zoom_source = Some(png_shot(1_600, 1_200));
        let revision = sessions.record_state(state).unwrap();

        let zoom = sessions
            .zoom_region(
                &revision.session_id,
                &revision.lineage_id,
                revision.revision,
                Rect {
                    x: 700,
                    y: 500,
                    width: 400,
                    height: 400,
                },
            )
            .expect("zoom");

        // Clamped against the SHOWN frame (800x600), not the capture, so the
        // numbers coming back are the ones the caller can reason about.
        assert_eq!((zoom.region.width, zoom.region.height), (100, 100));
        assert_eq!((zoom.screenshot.width, zoom.screenshot.height), (200, 200));
        assert_eq!(zoom.scale, 2.0);
    }

    #[test]
    fn only_the_newest_sessions_keep_a_full_resolution_frame() {
        // The captured frame is several MB on a Retina display and `sessions`
        // never expires, so retaining one per app the agent ever touched hands
        // back the memory the downscale exists to save.
        let mut sessions = UiSessionManager::default();
        for index in 0..(MAX_RETAINED_ZOOM_SOURCES + 2) {
            let mut state = CapturedUiState::fixture(root("Notes"));
            state.session_id = format!("desktop-{index}");
            state.captured_at = index as i64;
            state.screenshot = Some(png_shot(800, 600));
            state.zoom_source = Some(png_shot(1_600, 1_200));
            sessions.record_state(state).unwrap();
        }
        let retained = sessions
            .sessions
            .values()
            .filter(|record| record.zoom_source.is_some())
            .count();
        assert_eq!(retained, MAX_RETAINED_ZOOM_SOURCES);
        // Releasing one costs detail, never correctness: the zoom falls back
        // to cropping the frame that was shown.
        let oldest = sessions.sessions.get("desktop-0").expect("session kept");
        assert!(oldest.zoom_source.is_none());
        assert!(oldest.current.screenshot.is_some());
    }

    #[test]
    fn the_session_just_recorded_always_keeps_its_frame() {
        // A clock that did not advance must not let the sweep drop the frame
        // the caller is about to zoom into.
        let mut sessions = UiSessionManager::default();
        for index in 0..(MAX_RETAINED_ZOOM_SOURCES + 2) {
            let mut state = CapturedUiState::fixture(root("Notes"));
            state.session_id = format!("desktop-{index}");
            state.captured_at = 7;
            state.screenshot = Some(png_shot(800, 600));
            state.zoom_source = Some(png_shot(1_600, 1_200));
            sessions.record_state(state).unwrap();
        }
        let newest = format!("desktop-{}", MAX_RETAINED_ZOOM_SOURCES + 1);
        assert!(sessions.sessions[&newest].zoom_source.is_some());
    }

    #[test]
    fn zoom_refuses_a_stale_revision() {
        let mut sessions = UiSessionManager::default();
        let mut state = CapturedUiState::fixture(root("Notes"));
        state.screenshot = Some(png_shot(400, 400));
        let revision = sessions.record_state(state).unwrap();

        let err = sessions.zoom_region(
            &revision.session_id,
            &revision.lineage_id,
            revision.revision + 1,
            Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
        );
        assert!(matches!(err, Err(SessionError::StaleRevision)));
    }

    #[test]
    fn zoom_refuses_a_revision_with_no_frame() {
        // A withheld (deduped) frame has empty bytes — cropping nothing and
        // returning a blank image would look like a real answer.
        let mut sessions = UiSessionManager::default();
        let revision = sessions
            .record_state(CapturedUiState::fixture(root("Notes")))
            .unwrap();
        let err = sessions.zoom_region(
            &revision.session_id,
            &revision.lineage_id,
            revision.revision,
            Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
        );
        assert!(matches!(err, Err(SessionError::PixelSurfaceMissing)));
    }

    #[test]
    fn recording_state_issues_a_revision_and_model_turn_bound_single_use_token() {
        let mut sessions = UiSessionManager::default();
        let state = sessions
            .record_state(CapturedUiState::fixture(root("Notes")))
            .expect("record state");

        assert_eq!(state.revision, 1);
        assert_eq!(state.tree.nodes.len(), 1);
        assert!(!state.turn_token.is_empty());
        assert_eq!(
            state
                .instruction_pack
                .as_ref()
                .expect("bundle-matched built-in instruction pack")
                .bundle_id,
            "com.apple.Notes"
        );

        let handle = state.tree.nodes[0].handle.clone();
        let request = ActionRequest {
            turn_token: state.turn_token.clone(),
            target: ActionTarget::Element {
                handle: handle.clone(),
            },
            action: UiAction::Click {
                button: None,
                count: None,
            },
            strategy: ActionStrategy::Semantic,
        };
        assert!(matches!(
            sessions.prepare_action(&request, "another-turn"),
            Err(SessionError::TurnBindingMismatch)
        ));
        sessions
            .prepare_action(&request, "turn:test")
            .expect("fresh token");
        assert!(matches!(
            sessions.prepare_action(&request, "turn:test"),
            Err(SessionError::TurnTokenConsumed)
        ));
    }

    #[test]
    fn consecutive_states_publish_a_deterministic_tree_diff() {
        let mut sessions = UiSessionManager::default();
        let mut first_root = root("Notes");
        let mut save = root("Save");
        save.automation_id = Some("save".into());
        save.control_type = Some("button".into());
        first_root.children = Some(vec![save.clone()]);
        sessions
            .record_state(CapturedUiState::fixture(first_root))
            .expect("first state");

        save.is_enabled = false;
        let mut cancel = root("Cancel");
        cancel.automation_id = Some("cancel".into());
        cancel.control_type = Some("button".into());
        let mut second_root = root("Notes");
        second_root.children = Some(vec![save, cancel]);
        let second = sessions
            .record_state(CapturedUiState::fixture(second_root))
            .expect("second state");

        let diff = second.diff.expect("diff from previous revision");
        assert_eq!(diff.from_revision, 1);
        assert_eq!(diff.to_revision, 2);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.updated.len(), 1);
        assert!(diff.removed.is_empty());
        assert_eq!(diff.added[0].automation_id.as_deref(), Some("cancel"));
        assert_eq!(diff.updated[0].automation_id.as_deref(), Some("save"));
    }

    #[test]
    fn expansion_pages_children_from_the_canonical_tree_not_the_model_projection() {
        let mut parent = root("Notes");
        parent.children = Some(
            (0..300)
                .map(|index| {
                    let mut child = root(&format!("Row {index}"));
                    child.automation_id = Some(format!("row-{index}"));
                    child.control_type = Some("row".into());
                    child
                })
                .collect(),
        );
        let mut capture = CapturedUiState::fixture(parent);
        capture.max_nodes = 1;
        let mut sessions = UiSessionManager::default();
        let state = sessions.record_state(capture).expect("state");

        assert_eq!(state.tree.nodes.len(), 1);
        assert!(state.tree.truncated);
        let first = sessions
            .expand_element(&state.tree.nodes[0].handle, None, 999)
            .expect("first page");
        assert_eq!(first.nodes.len(), 250);
        assert!(first.continuation_token.is_some());
        let second = sessions
            .expand_element(
                &state.tree.nodes[0].handle,
                first.continuation_token.as_deref(),
                250,
            )
            .expect("second page");
        assert_eq!(second.nodes.len(), 50);
        assert_eq!(second.continuation_token, None);
        assert_eq!(
            second.nodes[49].element.automation_id.as_deref(),
            Some("row-299")
        );
    }

    #[test]
    fn inspector_projection_materializes_beyond_the_model_node_limit() {
        let mut parent = root("Notes");
        parent.children = Some(
            (0..1_250)
                .map(|index| {
                    let mut child = root(&format!("Row {index}"));
                    child.automation_id = Some(format!("row-{index}"));
                    child.control_type = Some("row".into());
                    child
                })
                .collect(),
        );
        let mut capture = CapturedUiState::fixture(parent);
        capture.max_nodes = INSPECTOR_TREE_MAX_NODES;
        capture.projection = UiTreeProjectionKind::Inspector;
        let state = UiSessionManager::default()
            .record_state(capture)
            .expect("inspector state");

        assert_eq!(state.projection, UiTreeProjectionKind::Inspector);
        assert_eq!(state.tree.nodes.len(), 1_251);
        assert!(!state.tree.truncated);
    }

    #[test]
    fn session_flattens_and_releases_a_ten_thousand_level_tree_iteratively() {
        #[derive(Clone)]
        struct ChainNode(u32);

        let deep_root = tree_shape::walk_tree(
            &ChainNode(10_000),
            crate::automation::platform::shared::tree_shape::TreeBudget {
                max_nodes: 10_001,
                max_bytes: 64 * 1024 * 1024,
                ..crate::automation::platform::shared::tree_shape::TreeBudget::DEFAULT
            },
            &|node| root(&format!("Depth {}", node.0)),
            &|node, _| {
                (node.0 > 0)
                    .then(|| ChainNode(node.0 - 1))
                    .into_iter()
                    .collect()
            },
        );
        let mut capture = CapturedUiState::fixture(deep_root);
        capture.max_nodes = INSPECTOR_TREE_MAX_NODES;
        capture.projection = UiTreeProjectionKind::Inspector;

        let state = UiSessionManager::default()
            .record_state(capture)
            .expect("deep state");

        assert_eq!(state.tree.nodes.len(), 10_001);
        assert_eq!(state.tree.nodes.last().unwrap().parent_index, Some(9_999));
    }

    #[test]
    fn query_searches_the_canonical_tree_and_returns_current_revision_handles() {
        let mut parent = root("Notes");
        parent.children = Some(
            (0..20)
                .map(|index| {
                    let mut child = root(&format!("Row {index}"));
                    child.automation_id = Some(format!("row-{index}"));
                    child.control_type = Some("row".into());
                    child
                })
                .collect(),
        );
        let mut capture = CapturedUiState::fixture(parent);
        capture.max_nodes = 1;
        let mut sessions = UiSessionManager::default();
        let state = sessions.record_state(capture).expect("state");

        let matches = sessions
            .query_elements(
                &state.session_id,
                &state.lineage_id,
                state.revision,
                &crate::automation::types::Locator {
                    automation_id: Some("row-19".into()),
                    ..Default::default()
                },
                10,
            )
            .expect("query");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].handle.index, 20);
        assert_eq!(matches[0].handle.revision, state.revision);
    }

    #[test]
    fn stale_handle_refetches_only_on_one_structural_match() {
        let mut first_root = root("Notes");
        let mut save = root("Save");
        save.automation_id = Some("save".into());
        save.control_type = Some("button".into());
        first_root.children = Some(vec![save.clone()]);
        let mut sessions = UiSessionManager::default();
        let first = sessions
            .record_state(CapturedUiState::fixture(first_root))
            .unwrap();
        let stale_handle = first.tree.nodes[1].handle.clone();

        save.bounding_rect = Some(crate::automation::types::Rect {
            x: 300,
            y: 200,
            width: 80,
            height: 30,
        });
        let mut second_root = root("Notes");
        second_root.children = Some(vec![save]);
        let second = sessions
            .record_state(CapturedUiState::fixture(second_root))
            .unwrap();
        let prepared = sessions
            .prepare_action(
                &ActionRequest {
                    turn_token: second.turn_token,
                    target: ActionTarget::Element {
                        handle: stale_handle,
                    },
                    action: UiAction::Click {
                        button: None,
                        count: None,
                    },
                    strategy: ActionStrategy::Semantic,
                },
                "turn:test",
            )
            .unwrap();

        assert_eq!(prepared.refetched_from_revision, Some(1));
        assert_eq!(
            prepared.element.unwrap().automation_id.as_deref(),
            Some("save")
        );
    }

    #[test]
    fn stale_handle_refetch_rejects_ambiguous_fingerprints() {
        let mut first_root = root("Notes");
        let mut save = root("Save");
        save.automation_id = Some("save".into());
        save.control_type = Some("button".into());
        first_root.children = Some(vec![save.clone()]);
        let mut sessions = UiSessionManager::default();
        let first = sessions
            .record_state(CapturedUiState::fixture(first_root))
            .unwrap();
        let stale_handle = first.tree.nodes[1].handle.clone();

        let mut second_root = root("Notes");
        second_root.children = Some(vec![save.clone(), save]);
        let second = sessions
            .record_state(CapturedUiState::fixture(second_root))
            .unwrap();
        let error = sessions
            .prepare_action(
                &ActionRequest {
                    turn_token: second.turn_token,
                    target: ActionTarget::Element {
                        handle: stale_handle,
                    },
                    action: UiAction::Click {
                        button: None,
                        count: None,
                    },
                    strategy: ActionStrategy::Semantic,
                },
                "turn:test",
            )
            .unwrap_err();

        assert_eq!(error, SessionError::StaleElementAmbiguous);
    }

    #[test]
    fn stale_handle_refetch_rejects_missing_fingerprint() {
        let mut first_root = root("Notes");
        let mut save = root("Save");
        save.automation_id = Some("save".into());
        save.control_type = Some("button".into());
        first_root.children = Some(vec![save]);
        let mut sessions = UiSessionManager::default();
        let first = sessions
            .record_state(CapturedUiState::fixture(first_root))
            .unwrap();
        let stale_handle = first.tree.nodes[1].handle.clone();

        let second = sessions
            .record_state(CapturedUiState::fixture(root("Notes")))
            .unwrap();
        let error = sessions
            .prepare_action(
                &ActionRequest {
                    turn_token: second.turn_token,
                    target: ActionTarget::Element {
                        handle: stale_handle,
                    },
                    action: UiAction::Click {
                        button: None,
                        count: None,
                    },
                    strategy: ActionStrategy::Semantic,
                },
                "turn:test",
            )
            .unwrap_err();

        assert_eq!(error, SessionError::StaleElementNotFound);
    }

    #[test]
    fn pixel_surface_maps_retina_and_negative_display_origins() {
        let surface = UiSurface {
            window_id: Some(77),
            display_id: Some("2".into()),
            logical_bounds: crate::automation::types::Rect {
                x: -1512,
                y: 100,
                width: 1512,
                height: 982,
            },
            pixel_width: 3024,
            pixel_height: 1964,
            scale_factor: 2.0,
            coordinate_space: CoordinateSpace::ScreenshotPixels,
        };

        assert_eq!(
            pixel_to_global_point(&surface, Point { x: 1512, y: 982 }).unwrap(),
            Point { x: -756, y: 591 }
        );
        assert_eq!(
            pixel_to_global_point(&surface, Point { x: 3024, y: 0 }),
            Err(SessionError::PixelSurfaceMismatch)
        );
    }
}
