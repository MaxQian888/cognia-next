//! App-scoped Computer Use sessions.
//!
//! A session couples one accessibility-tree revision with the screenshot and
//! coordinate surface observed in the same turn. Mutating actions must present
//! the fresh turn token issued by that revision; consuming the token forces the
//! caller to observe again before it can mutate a second time.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::automation::platform::shared::tree_shape;
use crate::automation::types::{ElementInfo, Locator, Rect, Screenshot};

pub const MODEL_TREE_MAX_NODES: usize = 1_000;
pub const INSPECTOR_TREE_MAX_NODES: usize = 25_000;
pub const EXPANSION_PAGE_MAX_NODES: usize = 250;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
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
    pub app: ResolvedApplication,
    pub surface: UiSurface,
    pub screenshot: Option<Screenshot>,
    pub roots: Vec<ElementInfo>,
    pub captured_at: i64,
    #[serde(default = "default_model_node_budget")]
    pub max_nodes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GetAppStateOptions {
    pub include_screenshot: bool,
    pub disable_diff: bool,
    pub allow_launch: bool,
    pub max_nodes: usize,
    pub max_depth: u32,
}

impl Default for GetAppStateOptions {
    fn default() -> Self {
        Self {
            include_screenshot: true,
            disable_diff: false,
            allow_launch: false,
            max_nodes: MODEL_TREE_MAX_NODES,
            max_depth: 64,
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
    pub tree: UiTreeProjection,
    pub diff: Option<UiTreeDiff>,
    pub truncation: Vec<TruncationDescriptor>,
    pub captured_at: i64,
}

#[derive(Debug, Clone, Error, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionError {
    #[error("turn token is unknown")]
    TurnTokenUnknown,
    #[error("turn token was already consumed")]
    TurnTokenConsumed,
    #[error("element handle belongs to another session")]
    CrossSessionHandle,
    #[error("element handle belongs to a stale revision")]
    StaleRevision,
    #[error("element handle is invalid")]
    InvalidHandle,
    #[error("continuation token is unknown, expired, or belongs to another element")]
    ContinuationTokenInvalid,
}

#[derive(Debug, Clone)]
struct TokenRecord {
    session_id: String,
    lineage_id: String,
    revision: u64,
    consumed: bool,
}

#[derive(Debug, Clone)]
struct SessionRecord {
    lineage_id: String,
    revision: u64,
    app_identity: String,
    current: UiStateRevision,
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
}

impl UiSessionManager {
    pub fn record_state(
        &mut self,
        capture: CapturedUiState,
    ) -> Result<UiStateRevision, SessionError> {
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

        let max_nodes = capture.max_nodes.clamp(1, MODEL_TREE_MAX_NODES);
        let (canonical, total_nodes) = flatten_roots(&capture.roots, INSPECTOR_TREE_MAX_NODES);
        let nodes = canonical
            .iter()
            .take(max_nodes)
            .cloned()
            .enumerate()
            .map(|(index, node)| UiTreeNode {
                handle: ElementHandle {
                    session_id: capture.session_id.clone(),
                    lineage_id: lineage_id.clone(),
                    revision,
                    index,
                    fingerprint: element_fingerprint(&node.element, node.parent_index),
                },
                parent_index: node.parent_index,
                element: node.element,
            })
            .collect::<Vec<_>>();
        let omitted_nodes = total_nodes.saturating_sub(nodes.len());
        let truncation = (omitted_nodes > 0)
            .then(|| TruncationDescriptor {
                reason: "nodeBudget".into(),
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
            tree,
            diff,
            truncation,
            captured_at: capture.captured_at,
        };
        self.tokens.insert(
            turn_token,
            TokenRecord {
                session_id: capture.session_id.clone(),
                lineage_id: lineage_id.clone(),
                revision,
                consumed: false,
            },
        );
        self.sessions.insert(
            capture.session_id,
            SessionRecord {
                lineage_id,
                revision,
                app_identity,
                current: state.clone(),
                canonical,
            },
        );
        Ok(state)
    }

    pub fn consume_turn(
        &mut self,
        turn_token: &str,
        handle: &ElementHandle,
    ) -> Result<(), SessionError> {
        let token = self
            .tokens
            .get_mut(turn_token)
            .ok_or(SessionError::TurnTokenUnknown)?;
        if token.consumed {
            return Err(SessionError::TurnTokenConsumed);
        }
        if token.session_id != handle.session_id || token.lineage_id != handle.lineage_id {
            return Err(SessionError::CrossSessionHandle);
        }
        if token.revision != handle.revision {
            return Err(SessionError::StaleRevision);
        }
        let session = self
            .sessions
            .get(&handle.session_id)
            .ok_or(SessionError::CrossSessionHandle)?;
        if session.lineage_id != handle.lineage_id || session.revision != handle.revision {
            return Err(SessionError::StaleRevision);
        }
        let node = session
            .current
            .tree
            .nodes
            .get(handle.index)
            .ok_or(SessionError::InvalidHandle)?;
        if node.handle.fingerprint != handle.fingerprint {
            return Err(SessionError::InvalidHandle);
        }
        token.consumed = true;
        Ok(())
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
    fn visit(
        element: &ElementInfo,
        parent_index: Option<usize>,
        max_nodes: usize,
        out: &mut Vec<FlatNode>,
        total: &mut usize,
    ) {
        *total = total.saturating_add(1);
        let this_index = (out.len() < max_nodes).then_some(out.len());
        if this_index.is_some() {
            let mut flat = element.clone();
            flat.children = None;
            out.push(FlatNode {
                parent_index,
                element: flat,
            });
        }
        if let Some(children) = element.children.as_ref() {
            for child in children {
                visit(child, this_index.or(parent_index), max_nodes, out, total);
            }
        }
    }

    let mut out = Vec::new();
    let mut total = 0usize;
    for root in roots {
        visit(root, None, max_nodes, &mut out, &mut total);
    }
    (out, total)
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
    element
        .bounding_rect
        .map(|rect| (rect.x, rect.y, rect.width, rect.height))
        .hash(&mut hasher);
    parent_index.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
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
                roots: vec![root],
                captured_at: 1,
                max_nodes: MODEL_TREE_MAX_NODES,
            }
        }
    }

    #[test]
    fn recording_state_issues_a_revision_bound_single_use_turn_token() {
        let mut sessions = UiSessionManager::default();
        let state = sessions
            .record_state(CapturedUiState::fixture(root("Notes")))
            .expect("record state");

        assert_eq!(state.revision, 1);
        assert_eq!(state.tree.nodes.len(), 1);
        assert!(!state.turn_token.is_empty());

        let handle = state.tree.nodes[0].handle.clone();
        sessions
            .consume_turn(&state.turn_token, &handle)
            .expect("fresh token");
        assert_eq!(
            sessions.consume_turn(&state.turn_token, &handle),
            Err(SessionError::TurnTokenConsumed)
        );
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
}
