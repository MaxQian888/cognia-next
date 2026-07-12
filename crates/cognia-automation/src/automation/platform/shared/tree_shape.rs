//! Platform-agnostic tree-shaping helpers for the accessibility backends
//! (ADR-0020 cross-platform bounded subset).
//!
//! The macOS (AX) and Linux (AT-SPI) backends own different native element
//! handles, but the *logic* — how deep to walk, how many nodes to keep, how to
//! match a `Locator`, where the coordinate-click point of an element is — is
//! identical across them. Factoring it here keeps the native modules thin (just
//! the FFI to read a node's fields + children) and, crucially, keeps the logic
//! unit-tested on **every** host, including the Windows dev box where the AX /
//! AT-SPI backends don't even compile. Same `cfg(any(…, test))` discipline as
//! `keymap` / `shell_vars`.

use crate::automation::types::{ElementInfo, ElementRef, Locator, Point, Rect};

/// Bounds for a depth-capped tree walk. The native backends don't expose the
/// full (potentially huge) accessibility tree — they walk the frontmost
/// window's subtree under these caps so a snapshot stays bounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeBudget {
    /// Maximum depth, counting the root as depth 0. `1` = root only.
    pub max_depth: u32,
    /// Maximum total nodes materialized across the whole walk.
    pub max_nodes: usize,
}

impl TreeBudget {
    pub const DEFAULT: TreeBudget = TreeBudget {
        max_depth: 12,
        max_nodes: 600,
    };

    /// Resolve from a caller-supplied `max_depth` (e.g. `TreeOpts.max_depth`),
    /// clamped to sane bounds so a hostile/confused caller can't request an
    /// unbounded walk.
    pub fn from_opts(max_depth: Option<u32>) -> Self {
        TreeBudget {
            max_depth: max_depth.unwrap_or(Self::DEFAULT.max_depth).clamp(1, 64),
            max_nodes: Self::DEFAULT.max_nodes,
        }
    }
}

/// The subset of an element's fields a `Locator` can match against. Each
/// backend fills this from its native node; the matching logic stays here.
#[derive(Debug, Default, Clone)]
pub struct MatchFields<'a> {
    pub name: Option<&'a str>,
    pub automation_id: Option<&'a str>,
    pub control_type: Option<&'a str>,
    pub class_name: Option<&'a str>,
    pub process_name: Option<&'a str>,
    pub window_title: Option<&'a str>,
}

fn ci_eq(have: Option<&str>, want: &str) -> bool {
    have.map_or(false, |s| s.trim().eq_ignore_ascii_case(want.trim()))
}

fn ci_contains(have: Option<&str>, want: &str) -> bool {
    have.map_or(false, |s| s.to_lowercase().contains(&want.to_lowercase()))
}

/// Whether `fields` satisfy every constraint set on `locator`. A locator with
/// all-`None` fields matches everything. `name` / `automation_id` /
/// `control_type` / `class_name` / `process_name` are case-insensitive exact
/// (trimmed); `name_contains` / `window_title_contains` are case-insensitive
/// substrings. Mirrors the constraint semantics of the Windows UIA matcher.
pub fn matches_locator(fields: &MatchFields, locator: &Locator) -> bool {
    if let Some(name) = locator.name.as_deref() {
        if !ci_eq(fields.name, name) {
            return false;
        }
    }
    if let Some(sub) = locator.name_contains.as_deref() {
        if !ci_contains(fields.name, sub) {
            return false;
        }
    }
    if let Some(id) = locator.automation_id.as_deref() {
        if !ci_eq(fields.automation_id, id) {
            return false;
        }
    }
    if let Some(ct) = locator.control_type.as_deref() {
        if !ci_eq(fields.control_type, ct) {
            return false;
        }
    }
    if let Some(cn) = locator.class_name.as_deref() {
        if !ci_eq(fields.class_name, cn) {
            return false;
        }
    }
    if let Some(proc) = locator.process_name.as_deref() {
        if !ci_eq(fields.process_name, proc) {
            return false;
        }
    }
    if let Some(title) = locator.window_title_contains.as_deref() {
        if !ci_contains(fields.window_title, title) {
            return false;
        }
    }
    true
}

/// Borrow an `ElementInfo`'s matchable fields.
pub fn fields_of(info: &ElementInfo) -> MatchFields<'_> {
    MatchFields {
        name: info.name.as_deref(),
        automation_id: info.automation_id.as_deref(),
        control_type: info.control_type.as_deref(),
        class_name: info.class_name.as_deref(),
        process_name: info.process_name.as_deref(),
        window_title: info.window_title.as_deref(),
    }
}

/// Depth-first pre-order search of an already-materialized tree for the first
/// node matching `locator`. The native `find` resolves the frontmost-window
/// subtree via `walk_tree`, then delegates here.
pub fn find_in_tree(root: &ElementInfo, locator: &Locator) -> Option<ElementRef> {
    if matches_locator(&fields_of(root), locator) {
        return Some(root.element_ref.clone());
    }
    if let Some(children) = root.children.as_ref() {
        for child in children {
            if let Some(found) = find_in_tree(child, locator) {
                return Some(found);
            }
        }
    }
    None
}

/// Coordinate-click point of an element: the center of its bounding rect.
/// Backends use this when a native pattern invoke isn't available and they
/// must fall back to a synthetic click. Reserved for that fallback path —
/// currently exercised only by tests, so allow it to be unused otherwise.
#[cfg_attr(not(test), allow(dead_code))]
pub fn rect_center(rect: &Rect) -> Point {
    Point {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
    }
}

/// Walk a native element tree into a bounded `ElementInfo`, depth-first.
///
/// `to_info` reads a node's flat fields (without children); `children` lists a
/// node's child handles. The walk stops descending at `budget.max_depth` and
/// stops materializing once `budget.max_nodes` nodes exist. Generic over the
/// native handle `N` so it's exercised against a fake tree on the Windows dev
/// host while the real backends pass `AXUIElement` / AT-SPI accessibles.
pub fn walk_tree<N>(
    root: &N,
    budget: TreeBudget,
    to_info: &impl Fn(&N) -> ElementInfo,
    children: &impl Fn(&N) -> Vec<N>,
) -> ElementInfo {
    let mut count = 0usize;
    walk_inner(root, budget, 0, &mut count, to_info, children)
}

fn walk_inner<N>(
    node: &N,
    budget: TreeBudget,
    depth: u32,
    count: &mut usize,
    to_info: &impl Fn(&N) -> ElementInfo,
    children: &impl Fn(&N) -> Vec<N>,
) -> ElementInfo {
    *count += 1;
    let mut info = to_info(node);
    // At the depth/node ceiling: emit this node as a leaf (drop any children).
    if depth + 1 >= budget.max_depth || *count >= budget.max_nodes {
        info.children = None;
        return info;
    }
    let mut out = Vec::new();
    for child in children(node) {
        if *count >= budget.max_nodes {
            break;
        }
        out.push(walk_inner(
            &child,
            budget,
            depth + 1,
            count,
            to_info,
            children,
        ));
    }
    info.children = if out.is_empty() { None } else { Some(out) };
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str, ct: &str) -> ElementInfo {
        ElementInfo {
            element_ref: ElementRef(format!("ref:{name}")),
            name: Some(name.to_string()),
            automation_id: None,
            control_type: Some(ct.to_string()),
            class_name: None,
            bounding_rect: None,
            is_enabled: true,
            is_focused: false,
            process_id: None,
            process_name: Some("App".to_string()),
            window_title: Some("Main Window".to_string()),
            children: None,
        }
    }

    #[test]
    fn empty_locator_matches_anything() {
        assert!(matches_locator(
            &fields_of(&info("Save", "button")),
            &Locator::default()
        ));
    }

    #[test]
    fn matches_exact_and_substring_case_insensitively() {
        let i = info("Save As…", "Button");
        let exact = Locator {
            name: Some("save as…".into()),
            ..Default::default()
        };
        assert!(matches_locator(&fields_of(&i), &exact));
        let sub = Locator {
            name_contains: Some("AS".into()),
            control_type: Some("button".into()),
            ..Default::default()
        };
        assert!(matches_locator(&fields_of(&i), &sub));
    }

    #[test]
    fn anded_constraints_reject_a_partial_match() {
        let i = info("Save", "button");
        let l = Locator {
            name: Some("Save".into()),
            automation_id: Some("save-btn".into()), // node has no automation_id
            ..Default::default()
        };
        assert!(!matches_locator(&fields_of(&i), &l));
    }

    #[test]
    fn window_title_contains_matches_against_window_title_field() {
        let i = info("x", "y");
        let l = Locator {
            window_title_contains: Some("main".into()),
            ..Default::default()
        };
        assert!(matches_locator(&fields_of(&i), &l));
    }

    #[test]
    fn rect_center_is_the_midpoint() {
        let c = rect_center(&Rect {
            x: 100,
            y: 200,
            width: 40,
            height: 20,
        });
        assert_eq!(c, Point { x: 120, y: 210 });
    }

    #[test]
    fn budget_clamps_caller_depth() {
        assert_eq!(TreeBudget::from_opts(Some(3)).max_depth, 3);
        assert_eq!(TreeBudget::from_opts(Some(0)).max_depth, 1); // clamped up
        assert_eq!(TreeBudget::from_opts(Some(9999)).max_depth, 64); // clamped down
        assert_eq!(
            TreeBudget::from_opts(None).max_depth,
            TreeBudget::DEFAULT.max_depth
        );
    }

    // A toy native node for exercising walk_tree without an OS accessibility API.
    struct Node {
        name: String,
        kids: Vec<Node>,
    }
    fn node(name: &str, kids: Vec<Node>) -> Node {
        Node {
            name: name.to_string(),
            kids,
        }
    }
    fn node_info(n: &Node) -> ElementInfo {
        info(&n.name, "group")
    }
    fn node_children(n: &Node) -> Vec<Node> {
        n.kids
            .iter()
            .map(|k| Node {
                name: k.name.clone(),
                kids: k
                    .kids
                    .iter()
                    .map(|g| Node {
                        name: g.name.clone(),
                        kids: vec![],
                    })
                    .collect(),
            })
            .collect()
    }

    #[test]
    fn walk_tree_respects_depth_cap() {
        let root = node("root", vec![node("a", vec![node("a1", vec![])])]);
        // max_depth 2 → root + its children, but grandchildren dropped.
        let budget = TreeBudget {
            max_depth: 2,
            max_nodes: 100,
        };
        let tree = walk_tree(&root, budget, &node_info, &node_children);
        let child = &tree.children.as_ref().unwrap()[0];
        assert_eq!(child.name.as_deref(), Some("a"));
        assert!(child.children.is_none()); // grandchild pruned by depth cap
    }

    #[test]
    fn walk_tree_respects_node_cap() {
        let root = node(
            "root",
            vec![node("a", vec![]), node("b", vec![]), node("c", vec![])],
        );
        let budget = TreeBudget {
            max_depth: 10,
            max_nodes: 2, // root + one child only
        };
        let tree = walk_tree(&root, budget, &node_info, &node_children);
        assert_eq!(tree.children.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn find_in_tree_returns_first_pre_order_match() {
        let mut root = info("root", "window");
        let mut a = info("Target", "button");
        a.automation_id = Some("ok".into());
        root.children = Some(vec![info("other", "text"), a]);
        let l = Locator {
            automation_id: Some("ok".into()),
            ..Default::default()
        };
        assert_eq!(
            find_in_tree(&root, &l),
            Some(ElementRef("ref:Target".into()))
        );
    }
}
