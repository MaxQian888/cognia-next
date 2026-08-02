//! Versioned, re-resolvable element locators (Epic 5 — ADR-0020).
//!
//! ## What this replaces
//!
//! The macOS backend minted `ElementRef`s two different ways, and neither
//! survived:
//!
//!   - `read_tree` inserted live `AXUIElement` handles into a `HashMap` keyed
//!     by `macos|pid=N|element=<ptr>`, and **cleared that map on every
//!     `read_tree` call**. Any ref handed out before the next tree read
//!     resolved to `StaleElement`.
//!   - `find` / `get_focus` / `pick_at_point` minted
//!     `macos|pid=N|title=…` / `macos|role=…|title=…` strings that were never
//!     inserted into the map at all, so they could not be acted on — the ref
//!     was, in the old comment's words, "an observability string, not a
//!     re-resolvable handle".
//!
//! An {@link ElementLocator} is a *recipe* instead of a pointer: process and
//! window identity plus the ancestry path from the window root to the node.
//! Re-resolution replays the recipe against the live tree, so a ref stays
//! valid across cache resets, across `read_tree` calls, and across the app
//! rebuilding part of its view — and fails loudly (`StaleElement`) when the
//! recipe no longer picks out exactly one node.
//!
//! ## Why the matching is here and not in the AX module
//!
//! Same discipline as `tree_shape` / `keymap`: the FFI lives in the platform
//! module, the *logic* lives here, generic over {@link LocatorNode}. That keeps
//! it unit-tested on every host — including hosts where AX/AT-SPI do not
//! compile — against a fake tree, which is the only way to test the
//! ambiguity and drift cases at all. You cannot ask a real desktop to produce
//! two identically-named siblings on demand.
//!
//! ## Encoding
//!
//! The wire form is `ael1:<base64url-json>`. The prefix is a version tag: a
//! future `ael2:` can change the recipe shape, and {@link decode} rejects an
//! unknown version instead of mis-parsing it. Callers treat the whole string as
//! opaque — nothing outside this module parses it.

use serde::{Deserialize, Serialize};

/// Current locator encoding version. Bumped only when the recipe shape changes
/// incompatibly; `decode` refuses anything it does not know.
pub const LOCATOR_VERSION: u8 = 1;

/// Wire prefix. `ael` = automation element locator.
const LOCATOR_PREFIX: &str = "ael1:";

/// Which accessibility backend minted the locator. Re-resolving a locator on a
/// different backend is a hard refusal, not a best-effort attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocatorBackend {
    Macos,
    Atspi,
}

/// Identity of the owning application. `pid` is the fast path; the other two
/// let a locator survive an app restart that changed the pid.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppIdentity {
    pub pid: u32,
    /// Bundle id (macOS) or the AT-SPI application name (Linux).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
}

/// Identity of the window the path is rooted at.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WindowIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Index among the application's windows at capture time. Used only when
    /// the title does not single one out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u32>,
}

/// One hop from parent to child in the ancestry recipe.
///
/// `ordinal` is the index among the parent's children **that match the same
/// role/subrole**, not the raw child index — a raw index breaks as soon as an
/// unrelated sibling (a separator, a hidden pane) is inserted, which is exactly
/// the drift this recipe has to survive.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AncestryStep {
    /// `AXIdentifier` (macOS) or the AT-SPI accessible id. The strongest signal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Index among same-role/subrole siblings at capture time.
    #[serde(default)]
    pub ordinal: u32,
}

/// A re-resolvable element locator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElementLocator {
    pub version: u8,
    pub backend: LocatorBackend,
    pub app: AppIdentity,
    #[serde(default)]
    pub window: WindowIdentity,
    /// Path from the window root to the target. Empty = the window root itself.
    #[serde(default)]
    pub path: Vec<AncestryStep>,
}

impl ElementLocator {
    pub fn new(backend: LocatorBackend, app: AppIdentity) -> Self {
        Self {
            version: LOCATOR_VERSION,
            backend,
            app,
            window: WindowIdentity::default(),
            path: Vec::new(),
        }
    }

    /// Encode to the opaque wire string handed out as `ElementRef`.
    pub fn encode(&self) -> String {
        // `serde_json` cannot fail on this shape (no maps with non-string keys,
        // no non-finite floats), but a panic here would take down the worker,
        // so an empty body is preferred over `unwrap`. `decode` rejects it.
        let json = serde_json::to_vec(self).unwrap_or_default();
        format!("{LOCATOR_PREFIX}{}", base64_url_encode(&json))
    }

    /// Decode a wire string. Returns `None` for anything that is not a
    /// locator of a version we understand — including the legacy
    /// `macos|pid=…` refs, which callers must treat as unresolvable rather
    /// than guess at.
    pub fn decode(raw: &str) -> Option<Self> {
        let body = raw.strip_prefix(LOCATOR_PREFIX)?;
        let json = base64_url_decode(body)?;
        let locator: ElementLocator = serde_json::from_slice(&json).ok()?;
        if locator.version != LOCATOR_VERSION {
            return None;
        }
        Some(locator)
    }

    /// Is this string a locator this build can decode?
    pub fn is_locator(raw: &str) -> bool {
        raw.starts_with(LOCATOR_PREFIX)
    }
}

/// The subset of a live accessibility node this module needs. Each backend
/// implements it over its native handle; nothing here touches FFI.
pub trait LocatorNode: Sized {
    fn identifier(&self) -> Option<String>;
    fn role(&self) -> Option<String>;
    fn subrole(&self) -> Option<String>;
    fn name(&self) -> Option<String>;
    /// Direct children, in presentation order.
    fn children(&self) -> Vec<Self>;
}

/// Why re-resolution failed. Every variant maps to `AutomationError::StaleElement`
/// at the backend boundary; they are distinguished here so the unit tests can
/// pin *which* failure occurred, and so a future diagnostics surface can say
/// something more useful than "stale".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveFailure {
    /// No child at this hop matched the step at all.
    NotFound,
    /// Several children matched equally well and the ordinal did not
    /// disambiguate. Refusing here is the point: acting on an arbitrary one of
    /// them would click the wrong thing.
    Ambiguous,
}

/// Replay one ancestry step against a parent's children.
///
/// Precedence, strongest first:
///   1. **`identifier`** — an app that sets `AXIdentifier` is telling us the
///      node is stable. A unique match wins outright, ignoring every other
///      field, because identifiers survive relabelling and re-layout.
///      Several children sharing one identifier is the app's bug, not a tie to
///      break by guessing: refuse.
///   2. **role + subrole + name** — a unique match wins.
///   3. **ordinal among role/subrole matches** — only when name-matching left
///      more than one candidate (or the name has since changed). The selected
///      candidate must still validate against the recorded role/subrole, so an
///      ordinal that now points at a different kind of node refuses instead of
///      returning a wrong element.
pub fn resolve_step<N: LocatorNode>(
    parent: &N,
    step: &AncestryStep,
) -> Result<N, ResolveFailure> {
    let children = parent.children();

    // (1) Identifier — strongest, and never overridden by a weaker signal.
    if let Some(want) = step.identifier.as_deref().filter(|s| !s.is_empty()) {
        let mut matches = children
            .into_iter()
            .filter(|c| c.identifier().as_deref() == Some(want));
        let first = matches.next().ok_or(ResolveFailure::NotFound)?;
        return match matches.next() {
            None => Ok(first),
            Some(_) => Err(ResolveFailure::Ambiguous),
        };
    }

    // Candidates for (2) and (3) share the role/subrole filter.
    let shape_matches: Vec<N> = children
        .into_iter()
        .filter(|c| matches_opt(step.role.as_deref(), c.role()))
        .filter(|c| matches_opt(step.subrole.as_deref(), c.subrole()))
        .collect();

    if shape_matches.is_empty() {
        return Err(ResolveFailure::NotFound);
    }

    // (2) Name, within the role/subrole shape.
    if let Some(want) = step.name.as_deref().filter(|s| !s.is_empty()) {
        let named: Vec<usize> = shape_matches
            .iter()
            .enumerate()
            .filter(|(_, c)| c.name().as_deref() == Some(want))
            .map(|(i, _)| i)
            .collect();
        if named.len() == 1 {
            return Ok(shape_matches.into_iter().nth(named[0]).expect("index in range"));
        }
        if named.len() > 1 {
            // Several identically-named siblings — fall through to the ordinal,
            // but only among the named ones, so a stable ordinal still works
            // for e.g. three "Delete" buttons in a list.
            let idx = step.ordinal as usize;
            return match named.get(idx) {
                Some(&pos) => Ok(shape_matches.into_iter().nth(pos).expect("index in range")),
                None => Err(ResolveFailure::Ambiguous),
            };
        }
        // No name match: the label changed. Fall through to the ordinal, which
        // is validated against role/subrole below.
    }

    // (3) Ordinal among role/subrole matches.
    let idx = step.ordinal as usize;
    match shape_matches.into_iter().nth(idx) {
        Some(node) => Ok(node),
        None => Err(ResolveFailure::NotFound),
    }
}

/// Replay a whole path from a window root. An empty path resolves to the root.
pub fn resolve_path<N: LocatorNode>(
    root: N,
    path: &[AncestryStep],
) -> Result<N, ResolveFailure> {
    let mut current = root;
    for step in path {
        current = resolve_step(&current, step)?;
    }
    Ok(current)
}

/// Build the ancestry step describing `child` as seen from `parent`.
///
/// The ordinal is computed the same way {@link resolve_step} consumes it —
/// among same-role/subrole siblings, narrowed to same-name siblings when the
/// name is set and shared. Capture and replay must agree or the recipe is
/// worse than useless.
pub fn describe_step<N: LocatorNode>(parent: &N, child_index: usize) -> Option<AncestryStep> {
    let children = parent.children();
    let child = children.get(child_index)?;

    let role = child.role();
    let subrole = child.subrole();
    let name = child.name();
    let identifier = child.identifier().filter(|s| !s.is_empty());

    let shape_positions: Vec<usize> = children
        .iter()
        .enumerate()
        .filter(|(_, c)| c.role() == role && c.subrole() == subrole)
        .map(|(i, _)| i)
        .collect();

    let ordinal = match name.as_deref().filter(|s| !s.is_empty()) {
        Some(want) => {
            let named: Vec<usize> = shape_positions
                .iter()
                .copied()
                .filter(|&i| children[i].name().as_deref() == Some(want))
                .collect();
            if named.len() > 1 {
                named.iter().position(|&i| i == child_index).unwrap_or(0)
            } else {
                shape_positions
                    .iter()
                    .position(|&i| i == child_index)
                    .unwrap_or(0)
            }
        }
        None => shape_positions
            .iter()
            .position(|&i| i == child_index)
            .unwrap_or(0),
    };

    Some(AncestryStep {
        identifier,
        role,
        subrole,
        name,
        ordinal: ordinal as u32,
    })
}

/// Stamp re-resolvable locators onto a materialized `ElementInfo` tree.
///
/// This is the cheap path for `read_tree`: the walk has already read every
/// node's role/subrole/name/identifier, so the whole recipe can be derived from
/// the returned tree with **zero further accessibility round-trips**. Building
/// each node's locator by walking up through `AXParent` instead would be
/// O(nodes × depth) cross-process messages on a tree the budget allows to reach
/// 25 000 nodes.
///
/// Ordinals are computed among same-role/subrole siblings, matching
/// {@link resolve_step}. Budget truncation is safe here because the walk pages
/// children from offset 0 — it drops a suffix, so a kept sibling's ordinal is
/// the same as it is live.
///
/// One known weakening: `ElementInfo.name` may have been projected from
/// `AXValue` (a text field's contents) when the node had no title or
/// description, while re-resolution reads title/description only. Such a step
/// falls through to the ordinal, which is still validated against role and
/// subrole — so it degrades to "positional but type-checked", never to
/// "resolves to the wrong node".
pub fn assign_locators<N: ElementInfoLike>(root: &mut N, base: &ElementLocator) {
    assign_locators_inner(root, base, &[]);
}

fn assign_locators_inner<N: ElementInfoLike>(
    node: &mut N,
    base: &ElementLocator,
    path: &[AncestryStep],
) {
    let mut locator = base.clone();
    locator.path = path.to_vec();
    node.set_element_ref(locator.encode());

    let children = node.children_mut();
    // Ordinal bookkeeping per (role, subrole) and per (role, subrole, name),
    // mirroring `describe_step`.
    let shapes: Vec<(Option<String>, Option<String>, Option<String>)> = children
        .iter()
        .map(|c| (c.role(), c.subrole(), c.name()))
        .collect();

    for (index, child) in children.iter_mut().enumerate() {
        let (role, subrole, name) = shapes[index].clone();
        let same_shape: Vec<usize> = shapes
            .iter()
            .enumerate()
            .filter(|(_, (r, s, _))| *r == role && *s == subrole)
            .map(|(i, _)| i)
            .collect();
        let ordinal = match name.as_deref().filter(|s| !s.is_empty()) {
            Some(want) => {
                let named: Vec<usize> = same_shape
                    .iter()
                    .copied()
                    .filter(|&i| shapes[i].2.as_deref() == Some(want))
                    .collect();
                if named.len() > 1 {
                    named.iter().position(|&i| i == index).unwrap_or(0)
                } else {
                    same_shape.iter().position(|&i| i == index).unwrap_or(0)
                }
            }
            None => same_shape.iter().position(|&i| i == index).unwrap_or(0),
        };

        let mut child_path = path.to_vec();
        child_path.push(AncestryStep {
            identifier: child.identifier().filter(|s| !s.is_empty()),
            role,
            subrole,
            name,
            ordinal: ordinal as u32,
        });
        assign_locators_inner(child, base, &child_path);
    }
}

/// The slice of `ElementInfo` {@link assign_locators} needs. Declared as a
/// trait so this module stays free of the `types` module's serialization
/// concerns and stays testable against a fake node.
pub trait ElementInfoLike: Sized {
    fn identifier(&self) -> Option<String>;
    fn role(&self) -> Option<String>;
    fn subrole(&self) -> Option<String>;
    fn name(&self) -> Option<String>;
    fn children_mut(&mut self) -> &mut [Self];
    fn set_element_ref(&mut self, encoded: String);
}

/// `None` in the recipe means "was not recorded" and matches anything; a
/// recorded value must be present and equal.
fn matches_opt(want: Option<&str>, have: Option<String>) -> bool {
    match want {
        None => true,
        Some(w) => have.as_deref() == Some(w),
    }
}

// ── base64url (no padding) ──────────────────────────────────────────────────
// Hand-rolled rather than pulling a crate in: the alphabet is 6 lines, the
// automation crate has no base64 dependency today, and adding one for this
// would be the larger change.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn base64_url_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(triple >> 18) as usize & 0x3F] as char);
        out.push(B64[(triple >> 12) as usize & 0x3F] as char);
        if chunk.len() > 1 {
            out.push(B64[(triple >> 6) as usize & 0x3F] as char);
        }
        if chunk.len() > 2 {
            out.push(B64[triple as usize & 0x3F] as char);
        }
    }
    out
}

fn base64_url_decode(input: &str) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for ch in input.bytes() {
        let val = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    // Leftover bits must be zero padding, never dropped data.
    if acc != 0 {
        return None;
    }
    Some(out)
}

/// Projection of the backend-facing `ElementInfo` onto the recipe fields.
///
/// The field names differ because `ElementInfo` is the cross-platform
/// inspector shape (UIA vocabulary) while a recipe speaks the accessibility
/// tree's: `control_type` is the role, `class_name` is the subrole, and
/// `automation_id` is the identifier.
impl ElementInfoLike for crate::automation::types::ElementInfo {
    fn identifier(&self) -> Option<String> {
        self.automation_id.clone()
    }
    fn role(&self) -> Option<String> {
        self.control_type.clone()
    }
    fn subrole(&self) -> Option<String> {
        self.class_name.clone()
    }
    fn name(&self) -> Option<String> {
        self.name.clone()
    }
    fn children_mut(&mut self) -> &mut [Self] {
        // A leaf carries `None`, not an empty vec — hand back an empty slice
        // so the caller does not have to distinguish the two.
        self.children.as_deref_mut().unwrap_or(&mut [])
    }
    fn set_element_ref(&mut self, encoded: String) {
        self.element_ref = crate::automation::types::ElementRef(encoded);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake tree node — the whole reason the matching logic lives in this
    /// module. A real desktop cannot be asked for two identically-named
    /// siblings, an identifier collision, or a mid-walk relabel.
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    struct Fake {
        identifier: Option<String>,
        role: Option<String>,
        subrole: Option<String>,
        name: Option<String>,
        children: Vec<Fake>,
    }

    impl Fake {
        fn new(role: &str) -> Self {
            Fake {
                role: Some(role.into()),
                ..Default::default()
            }
        }
        fn id(mut self, v: &str) -> Self {
            self.identifier = Some(v.into());
            self
        }
        fn name(mut self, v: &str) -> Self {
            self.name = Some(v.into());
            self
        }
        fn subrole(mut self, v: &str) -> Self {
            self.subrole = Some(v.into());
            self
        }
        fn kids(mut self, v: Vec<Fake>) -> Self {
            self.children = v;
            self
        }
    }

    impl LocatorNode for Fake {
        fn identifier(&self) -> Option<String> {
            self.identifier.clone()
        }
        fn role(&self) -> Option<String> {
            self.role.clone()
        }
        fn subrole(&self) -> Option<String> {
            self.subrole.clone()
        }
        fn name(&self) -> Option<String> {
            self.name.clone()
        }
        fn children(&self) -> Vec<Self> {
            self.children.clone()
        }
    }

    fn app() -> AppIdentity {
        AppIdentity {
            pid: 4242,
            bundle_id: Some("com.example.app".into()),
            process_name: Some("Example".into()),
        }
    }

    // ── encoding ────────────────────────────────────────────────────────────

    #[test]
    fn round_trips_through_the_wire_form() {
        let mut loc = ElementLocator::new(LocatorBackend::Macos, app());
        loc.window = WindowIdentity {
            title: Some("Untitled — Example".into()),
            ordinal: Some(0),
        };
        loc.path = vec![
            AncestryStep {
                role: Some("AXGroup".into()),
                ordinal: 1,
                ..Default::default()
            },
            AncestryStep {
                identifier: Some("save-button".into()),
                role: Some("AXButton".into()),
                name: Some("Save".into()),
                ordinal: 0,
                ..Default::default()
            },
        ];
        let encoded = loc.encode();
        assert!(ElementLocator::is_locator(&encoded));
        assert_eq!(ElementLocator::decode(&encoded), Some(loc));
    }

    #[test]
    fn encodes_to_an_opaque_url_safe_string() {
        let encoded = ElementLocator::new(LocatorBackend::Macos, app()).encode();
        let body = encoded.strip_prefix("ael1:").expect("prefixed");
        assert!(!body.is_empty());
        assert!(
            body.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "not url-safe: {body}"
        );
        // Opaque: the window title must not be readable in the wire form.
        assert!(!encoded.contains("com.example.app"));
    }

    #[test]
    fn round_trips_unicode_and_empty_paths() {
        let mut loc = ElementLocator::new(LocatorBackend::Atspi, app());
        loc.window = WindowIdentity {
            title: Some("文档 — 未命名".into()),
            ordinal: None,
        };
        let decoded = ElementLocator::decode(&loc.encode()).expect("decodes");
        assert_eq!(decoded.window.title.as_deref(), Some("文档 — 未命名"));
        assert!(decoded.path.is_empty());
    }

    #[test]
    fn rejects_legacy_and_malformed_refs() {
        // The pre-Epic-5 shapes must be refused, not guessed at.
        assert_eq!(ElementLocator::decode("macos|pid=42|title=Untitled"), None);
        assert_eq!(ElementLocator::decode("macos|role=AXButton|title=Save"), None);
        assert_eq!(ElementLocator::decode(""), None);
        assert_eq!(ElementLocator::decode("ael1:"), None);
        assert_eq!(ElementLocator::decode("ael1:!!!not-base64!!!"), None);
        assert_eq!(ElementLocator::decode("ael1:AAAA"), None);
        assert!(!ElementLocator::is_locator("macos|pid=1"));
    }

    #[test]
    fn rejects_a_future_version_rather_than_misparsing_it() {
        let mut loc = ElementLocator::new(LocatorBackend::Macos, app());
        loc.version = 99;
        // Same prefix, newer body — decode must refuse.
        let encoded = format!("ael1:{}", base64_url_encode(&serde_json::to_vec(&loc).unwrap()));
        assert_eq!(ElementLocator::decode(&encoded), None);
    }

    #[test]
    fn base64_round_trips_every_chunk_remainder() {
        for len in 0..=16usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 % 256) as u8).collect();
            let encoded = base64_url_encode(&bytes);
            assert_eq!(base64_url_decode(&encoded).as_deref(), Some(&bytes[..]), "len {len}");
        }
    }

    #[test]
    fn base64_rejects_non_zero_padding_bits() {
        // "AB" carries 12 bits: 8 of data + 4 that must be zero. 'B' sets them.
        assert!(base64_url_decode("AB").is_none());
    }

    // ── identifier precedence ───────────────────────────────────────────────

    #[test]
    fn identifier_wins_over_a_changed_role_and_name() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").name("Cancel"),
            // Role, subrole and name all drifted; the identifier did not.
            Fake::new("AXMenuItem").id("save-button").name("Save As…"),
        ]);
        let step = AncestryStep {
            identifier: Some("save-button".into()),
            role: Some("AXButton".into()),
            name: Some("Save".into()),
            ordinal: 0,
            ..Default::default()
        };
        let found = resolve_step(&parent, &step).expect("resolves by identifier");
        assert_eq!(found.name.as_deref(), Some("Save As…"));
    }

    #[test]
    fn a_duplicated_identifier_is_ambiguous_not_first_wins() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").id("dupe").name("One"),
            Fake::new("AXButton").id("dupe").name("Two"),
        ]);
        let step = AncestryStep {
            identifier: Some("dupe".into()),
            ..Default::default()
        };
        assert_eq!(
            resolve_step(&parent, &step),
            Err(ResolveFailure::Ambiguous)
        );
    }

    #[test]
    fn a_missing_identifier_is_not_found_even_when_a_name_would_match() {
        // Identifier was recorded, so it is authoritative: not falling back to
        // the name is deliberate. The app removed the id; that is drift we must
        // report, not paper over by clicking a same-named node.
        let parent = Fake::new("AXWindow").kids(vec![Fake::new("AXButton").name("Save")]);
        let step = AncestryStep {
            identifier: Some("save-button".into()),
            name: Some("Save".into()),
            ..Default::default()
        };
        assert_eq!(resolve_step(&parent, &step), Err(ResolveFailure::NotFound));
    }

    #[test]
    fn an_empty_identifier_is_treated_as_absent() {
        let parent = Fake::new("AXWindow").kids(vec![Fake::new("AXButton").name("Save")]);
        let step = AncestryStep {
            identifier: Some(String::new()),
            role: Some("AXButton".into()),
            name: Some("Save".into()),
            ..Default::default()
        };
        assert!(resolve_step(&parent, &step).is_ok());
    }

    // ── role / subrole / name ───────────────────────────────────────────────

    #[test]
    fn matches_a_unique_role_subrole_name() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").subrole("AXCloseButton").name("Close"),
            Fake::new("AXButton").name("Save"),
        ]);
        let step = AncestryStep {
            role: Some("AXButton".into()),
            name: Some("Save".into()),
            ..Default::default()
        };
        let found = resolve_step(&parent, &step).expect("resolves");
        assert_eq!(found.name.as_deref(), Some("Save"));
    }

    #[test]
    fn subrole_discriminates_same_role_siblings() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").subrole("AXCloseButton").name("x"),
            Fake::new("AXButton").subrole("AXMinimizeButton").name("x"),
        ]);
        let step = AncestryStep {
            role: Some("AXButton".into()),
            subrole: Some("AXMinimizeButton".into()),
            name: Some("x".into()),
            ..Default::default()
        };
        let found = resolve_step(&parent, &step).expect("resolves");
        assert_eq!(found.subrole.as_deref(), Some("AXMinimizeButton"));
    }

    #[test]
    fn an_unrecorded_field_matches_anything() {
        let parent = Fake::new("AXWindow").kids(vec![Fake::new("AXButton")
            .subrole("AXSomething")
            .name("Go")]);
        let step = AncestryStep {
            name: Some("Go".into()),
            ..Default::default()
        };
        assert!(resolve_step(&parent, &step).is_ok());
    }

    // ── ordinal ─────────────────────────────────────────────────────────────

    #[test]
    fn ordinal_picks_among_identically_named_siblings() {
        let parent = Fake::new("AXList").kids(vec![
            Fake::new("AXButton").name("Delete"),
            Fake::new("AXButton").name("Delete"),
            Fake::new("AXButton").name("Delete"),
        ]);
        for want in 0..3u32 {
            let step = AncestryStep {
                role: Some("AXButton".into()),
                name: Some("Delete".into()),
                ordinal: want,
                ..Default::default()
            };
            assert!(resolve_step(&parent, &step).is_ok(), "ordinal {want}");
        }
        let step = AncestryStep {
            role: Some("AXButton".into()),
            name: Some("Delete".into()),
            ordinal: 3,
            ..Default::default()
        };
        assert_eq!(resolve_step(&parent, &step), Err(ResolveFailure::Ambiguous));
    }

    #[test]
    fn ordinal_counts_same_role_siblings_not_raw_indices() {
        // A separator inserted between the groups must not shift the ordinal.
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXGroup").name("first"),
            Fake::new("AXSplitter"),
            Fake::new("AXGroup").name("second"),
        ]);
        let step = AncestryStep {
            role: Some("AXGroup".into()),
            ordinal: 1,
            ..Default::default()
        };
        let found = resolve_step(&parent, &step).expect("resolves");
        assert_eq!(found.name.as_deref(), Some("second"));
    }

    #[test]
    fn a_relabelled_node_falls_back_to_the_ordinal() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").name("Alpha"),
            Fake::new("AXButton").name("Renamed"),
        ]);
        let step = AncestryStep {
            role: Some("AXButton".into()),
            name: Some("Beta".into()),
            ordinal: 1,
            ..Default::default()
        };
        let found = resolve_step(&parent, &step).expect("falls back to ordinal");
        assert_eq!(found.name.as_deref(), Some("Renamed"));
    }

    #[test]
    fn the_ordinal_fallback_still_validates_the_role() {
        // The node at ordinal 1 is now a different kind of control. Returning
        // it would click the wrong thing, so refuse.
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").name("Alpha"),
            Fake::new("AXTextField").name("Renamed"),
        ]);
        let step = AncestryStep {
            role: Some("AXButton".into()),
            name: Some("Beta".into()),
            ordinal: 1,
            ..Default::default()
        };
        assert_eq!(resolve_step(&parent, &step), Err(ResolveFailure::NotFound));
    }

    #[test]
    fn an_empty_parent_is_not_found() {
        let parent = Fake::new("AXWindow");
        assert_eq!(
            resolve_step(&parent, &AncestryStep::default()),
            Err(ResolveFailure::NotFound)
        );
    }

    // ── whole paths ─────────────────────────────────────────────────────────

    fn sample_tree() -> Fake {
        Fake::new("AXWindow").kids(vec![Fake::new("AXGroup").name("toolbar").kids(vec![
            Fake::new("AXButton").name("New"),
            Fake::new("AXButton").id("save-button").name("Save"),
        ])])
    }

    #[test]
    fn resolves_a_multi_hop_path() {
        let path = vec![
            AncestryStep {
                role: Some("AXGroup".into()),
                name: Some("toolbar".into()),
                ..Default::default()
            },
            AncestryStep {
                identifier: Some("save-button".into()),
                ..Default::default()
            },
        ];
        let found = resolve_path(sample_tree(), &path).expect("resolves");
        assert_eq!(found.name.as_deref(), Some("Save"));
    }

    #[test]
    fn an_empty_path_resolves_to_the_root() {
        let found = resolve_path(sample_tree(), &[]).expect("resolves");
        assert_eq!(found.role.as_deref(), Some("AXWindow"));
    }

    #[test]
    fn a_broken_hop_fails_the_whole_path() {
        let path = vec![
            AncestryStep {
                role: Some("AXGroup".into()),
                name: Some("gone".into()),
                ordinal: 7,
                ..Default::default()
            },
            AncestryStep {
                identifier: Some("save-button".into()),
                ..Default::default()
            },
        ];
        assert_eq!(
            resolve_path(sample_tree(), &path),
            Err(ResolveFailure::NotFound)
        );
    }

    // ── capture / replay agreement ──────────────────────────────────────────

    #[test]
    fn describe_step_produces_a_recipe_that_resolves_back() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXButton").name("Delete"),
            Fake::new("AXSplitter"),
            Fake::new("AXButton").name("Delete"),
            Fake::new("AXButton").id("unique").name("Save"),
        ]);
        for i in 0..4usize {
            let step = describe_step(&parent, i).expect("described");
            let resolved = resolve_step(&parent, &step)
                .unwrap_or_else(|e| panic!("child {i} did not resolve back: {e:?}"));
            let expected = &parent.children[i];
            assert_eq!(resolved.name, expected.name, "child {i} name");
            assert_eq!(resolved.role, expected.role, "child {i} role");
            assert_eq!(resolved.identifier, expected.identifier, "child {i} id");
        }
    }

    #[test]
    fn describe_step_ordinal_is_relative_to_same_role_siblings() {
        let parent = Fake::new("AXWindow").kids(vec![
            Fake::new("AXSplitter"),
            Fake::new("AXGroup").name("a"),
            Fake::new("AXGroup").name("b"),
        ]);
        assert_eq!(describe_step(&parent, 2).expect("described").ordinal, 1);
    }

    #[test]
    fn describe_step_returns_none_for_an_out_of_range_child() {
        assert!(describe_step(&Fake::new("AXWindow"), 0).is_none());
    }

    // ── assign_locators over a materialized tree ────────────────────────────

    /// Stand-in for `ElementInfo`: same fields, plus the ref slot to fill.
    #[derive(Debug, Clone, Default)]
    struct FakeInfo {
        identifier: Option<String>,
        role: Option<String>,
        subrole: Option<String>,
        name: Option<String>,
        element_ref: String,
        children: Vec<FakeInfo>,
    }

    impl FakeInfo {
        fn new(role: &str) -> Self {
            FakeInfo {
                role: Some(role.into()),
                ..Default::default()
            }
        }
        fn name(mut self, v: &str) -> Self {
            self.name = Some(v.into());
            self
        }
        fn id(mut self, v: &str) -> Self {
            self.identifier = Some(v.into());
            self
        }
        fn kids(mut self, v: Vec<FakeInfo>) -> Self {
            self.children = v;
            self
        }
        /// Mirror of the info tree as a live tree, so a stamped locator can be
        /// replayed against it.
        fn as_live(&self) -> Fake {
            Fake {
                identifier: self.identifier.clone(),
                role: self.role.clone(),
                subrole: self.subrole.clone(),
                name: self.name.clone(),
                children: self.children.iter().map(FakeInfo::as_live).collect(),
            }
        }
        fn find_ref(&self, name: &str) -> Option<&str> {
            if self.name.as_deref() == Some(name) {
                return Some(&self.element_ref);
            }
            self.children.iter().find_map(|c| c.find_ref(name))
        }
    }

    impl ElementInfoLike for FakeInfo {
        fn identifier(&self) -> Option<String> {
            self.identifier.clone()
        }
        fn role(&self) -> Option<String> {
            self.role.clone()
        }
        fn subrole(&self) -> Option<String> {
            self.subrole.clone()
        }
        fn name(&self) -> Option<String> {
            self.name.clone()
        }
        fn children_mut(&mut self) -> &mut [Self] {
            &mut self.children
        }
        fn set_element_ref(&mut self, encoded: String) {
            self.element_ref = encoded;
        }
    }

    fn info_tree() -> FakeInfo {
        FakeInfo::new("AXWindow").kids(vec![
            FakeInfo::new("AXGroup").name("toolbar").kids(vec![
                FakeInfo::new("AXButton").name("New"),
                FakeInfo::new("AXButton").id("save-button").name("Save"),
            ]),
            FakeInfo::new("AXSplitter"),
            FakeInfo::new("AXGroup").name("content").kids(vec![
                FakeInfo::new("AXButton").name("Delete"),
                FakeInfo::new("AXButton").name("Delete"),
            ]),
        ])
    }

    #[test]
    fn assign_locators_stamps_every_node_with_a_decodable_ref() {
        let mut tree = info_tree();
        let base = ElementLocator::new(LocatorBackend::Macos, app());
        assign_locators(&mut tree, &base);

        fn walk(node: &FakeInfo, seen: &mut Vec<String>) {
            assert!(
                ElementLocator::decode(&node.element_ref).is_some(),
                "undecodable ref on {:?}",
                node.role
            );
            seen.push(node.element_ref.clone());
            for c in &node.children {
                walk(c, seen);
            }
        }
        let mut refs = Vec::new();
        walk(&tree, &mut refs);
        // root + 3 children + toolbar's 2 + content's 2
        assert_eq!(refs.len(), 8);
        let unique: std::collections::HashSet<_> = refs.iter().collect();
        assert_eq!(unique.len(), refs.len(), "refs must be distinct per node");
    }

    #[test]
    fn the_root_gets_an_empty_path() {
        let mut tree = info_tree();
        assign_locators(&mut tree, &ElementLocator::new(LocatorBackend::Macos, app()));
        let decoded = ElementLocator::decode(&tree.element_ref).expect("decodes");
        assert!(decoded.path.is_empty());
        assert_eq!(decoded.app.pid, 4242);
    }

    #[test]
    fn every_stamped_ref_resolves_back_to_its_own_node() {
        let mut tree = info_tree();
        assign_locators(&mut tree, &ElementLocator::new(LocatorBackend::Macos, app()));
        let live = tree.as_live();

        for (name, expect_role) in [
            ("toolbar", "AXGroup"),
            ("New", "AXButton"),
            ("Save", "AXButton"),
            ("content", "AXGroup"),
        ] {
            let raw = tree.find_ref(name).expect("stamped");
            let loc = ElementLocator::decode(raw).expect("decodes");
            let found = resolve_path(live.clone(), &loc.path)
                .unwrap_or_else(|e| panic!("{name} did not resolve: {e:?}"));
            assert_eq!(found.name.as_deref(), Some(name));
            assert_eq!(found.role.as_deref(), Some(expect_role));
        }
    }

    #[test]
    fn identically_named_siblings_get_distinct_resolvable_refs() {
        let mut tree = info_tree();
        assign_locators(&mut tree, &ElementLocator::new(LocatorBackend::Macos, app()));
        let live = tree.as_live();

        let deletes = &tree.children[2].children;
        let a = ElementLocator::decode(&deletes[0].element_ref).expect("decodes");
        let b = ElementLocator::decode(&deletes[1].element_ref).expect("decodes");
        assert_ne!(a.path, b.path, "the two Delete buttons must differ");
        assert_eq!(a.path.last().map(|s| s.ordinal), Some(0));
        assert_eq!(b.path.last().map(|s| s.ordinal), Some(1));
        assert!(resolve_path(live.clone(), &a.path).is_ok());
        assert!(resolve_path(live, &b.path).is_ok());
    }

    #[test]
    fn ordinals_skip_unrelated_siblings() {
        let mut tree = info_tree();
        assign_locators(&mut tree, &ElementLocator::new(LocatorBackend::Macos, app()));
        // "content" is the 3rd raw child but the 2nd AXGroup — the splitter in
        // between must not shift it.
        let raw = tree.find_ref("content").expect("stamped");
        let loc = ElementLocator::decode(raw).expect("decodes");
        assert_eq!(loc.path.last().map(|s| s.ordinal), Some(1));
    }

    #[test]
    fn a_stamped_ref_survives_an_unrelated_sibling_being_inserted() {
        let mut tree = info_tree();
        assign_locators(&mut tree, &ElementLocator::new(LocatorBackend::Macos, app()));
        let raw = tree.find_ref("Save").expect("stamped");
        let loc = ElementLocator::decode(raw).expect("decodes");

        // The app inserts a separator into the toolbar after we captured.
        let mut drifted = tree.as_live();
        drifted.children[0]
            .children
            .insert(0, Fake::new("AXSplitter"));

        let found = resolve_path(drifted, &loc.path).expect("still resolves");
        assert_eq!(found.name.as_deref(), Some("Save"));
    }

    #[test]
    fn a_leaf_with_no_children_is_still_stamped() {
        let mut leaf = FakeInfo::new("AXButton").name("Solo");
        assign_locators(&mut leaf, &ElementLocator::new(LocatorBackend::Macos, app()));
        assert!(ElementLocator::decode(&leaf.element_ref).is_some());
    }
}
