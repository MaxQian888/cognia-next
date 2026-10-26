//! Windows UI Automation back-end. Wraps `leexgone/uiautomation-rs` 0.25.
//!
//! The `UiaBackend` is constructed once on the worker thread (so COM is
//! initialized once in MTA). Every method is sync and assumes it's called
//! from that thread — the trait being `Send + !Sync` is enforced naturally
//! because `UIAutomation` is `Send` but not `Sync`.

use uiautomation::types::TreeScope;
use uiautomation::UIAutomation;

use crate::automation::backend::{ApplicationScreenshot, AutomationBackend, SelectionPreflight};
use crate::automation::platform::shared::tree_shape::{self, TreeBudget};
use crate::automation::session::{AppLocator, ResolvedApplication};
use crate::automation::types::*;

mod element;
mod events;
mod find;
mod input;
mod pattern;
mod text_selection;

use crate::automation::platform::shared::screenshot;
use crate::automation::selection::{build_text_selection, TextSelectionSnapshot};
use element::{element_info, ElementCache};

pub struct UiaBackend {
    automation: UIAutomation,
    cache: ElementCache,
    events: events::EventSubscriptions,
}

impl UiaBackend {
    fn application_window(
        &self,
        app: &ResolvedApplication,
        hint: Option<u32>,
    ) -> Result<xcap::Window> {
        let windows = xcap::Window::all().map_err(native_error)?;
        let candidates: Vec<_> = windows
            .iter()
            .filter_map(|window| {
                Some(crate::automation::backend::ApplicationWindow {
                    id: window.id().ok()?,
                    process_id: window.pid().ok()?,
                    focused: window.is_focused().unwrap_or(false),
                    minimized: window.is_minimized().unwrap_or(true),
                })
            })
            .collect();
        let selected = crate::automation::backend::select_application_window(
            &candidates,
            app.process_id,
            hint,
        )?;
        windows
            .into_iter()
            .find(|window| window.id().ok() == Some(selected))
            .ok_or(AutomationError::StaleElement)
    }

    fn require_foreground_element(&self, element: &uiautomation::UIElement) -> Result<()> {
        use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOT};
        if element.is_offscreen().unwrap_or(true) {
            return Err(AutomationError::StaleElement);
        }
        let rect = element.get_bounding_rectangle().map_err(native_error)?;
        let walker = self
            .automation
            .get_control_view_walker()
            .map_err(native_error)?;
        let mut current = element.clone();
        for _ in 0..64 {
            if let Ok(handle) = current.get_native_window_handle() {
                let hwnd: windows::Win32::Foundation::HWND = handle.into();
                if !hwnd.0.is_null() {
                    let target = unsafe { GetAncestor(hwnd, GA_ROOT) };
                    let foreground = unsafe { GetForegroundWindow() };
                    if !target.0.is_null() && target == foreground {
                        let mut bounds = windows::Win32::Foundation::RECT::default();
                        unsafe {
                            windows::Win32::UI::WindowsAndMessaging::GetWindowRect(
                                foreground,
                                &mut bounds,
                            )
                        }
                        .map_err(native_error)?;
                        crate::automation::platform::shared::pointer::foreground_center(
                            1,
                            Some(1),
                            true,
                            Rect {
                                x: rect.get_left(),
                                y: rect.get_top(),
                                width: rect.get_right() - rect.get_left(),
                                height: rect.get_bottom() - rect.get_top(),
                            },
                            Some(Rect {
                                x: bounds.left,
                                y: bounds.top,
                                width: bounds.right - bounds.left,
                                height: bounds.bottom - bounds.top,
                            }),
                        )?;
                        return Ok(());
                    }
                    break;
                }
            }
            let Ok(parent) = walker.get_parent(&current) else {
                break;
            };
            current = parent;
        }
        Err(AutomationError::PermissionDenied {
            reason: "coordinate fallback requires the target window to be foreground".into(),
        })
    }

    pub fn new() -> std::result::Result<Self, String> {
        let automation =
            UIAutomation::new().map_err(|e| format!("UIAutomation::new failed: {e}"))?;
        Ok(Self {
            automation,
            cache: ElementCache::new(),
            events: events::EventSubscriptions::new()
                .map_err(|err| format!("UIA event subsystem failed: {err}"))?,
        })
    }
}

fn process_path(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = vec![0_u16; 32_768];
    let mut len = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    result.ok()?;
    String::from_utf16(&buffer[..len as usize]).ok()
}

fn process_name(pid: u32) -> Option<String> {
    let path = process_path(pid)?;
    std::path::Path::new(&path)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_string)
}

fn native_error(error: impl std::fmt::Display) -> AutomationError {
    AutomationError::BackendError {
        message: error.to_string(),
    }
}

fn web_document_url(control_type: Option<&str>, value: &str) -> Option<String> {
    if control_type != Some("Document") {
        return None;
    }
    let parsed = url::Url::parse(value).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.to_string())
}

impl AutomationBackend for UiaBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            operations: OperationCapabilities {
                app_sessions: true,
                window_op: true,
                element_click: true,
                element_scroll: true,
                invoke_patterns: vec![
                    "invoke",
                    "toggle",
                    "value",
                    "selectionItem",
                    "rangeValue",
                    "expandCollapse",
                    "scrollItem",
                    "window",
                    "transform",
                    "text",
                ]
                .into_iter()
                .map(str::to_string)
                .collect(),
            },
            platform: Platform::Windows,
            has_uia: true,
            has_input_sim: true,
            has_screenshot: true,
            has_events: true,    // Native focus / structure / property UIA handlers.
            has_a11y_tree: true, // UIA exposes a full element tree.
            monitors: screenshot::list_monitors(),
        }
    }

    fn get_focus(&self) -> Result<ElementInfo> {
        let elt =
            self.automation
                .get_focused_element()
                .map_err(|e| AutomationError::BackendError {
                    message: format!("get_focused_element: {e}"),
                })?;
        Ok(element_info(&self.cache, &elt))
    }

    fn list_applications(&self) -> Result<Vec<ResolvedApplication>> {
        let windows = xcap::Window::all().map_err(native_error)?;
        let mut apps = std::collections::BTreeMap::new();
        for window in windows {
            let Ok(pid) = window.pid() else { continue };
            apps.entry(pid).or_insert_with(|| ResolvedApplication {
                bundle_id: None,
                path: process_path(pid),
                display_name: process_name(pid)
                    .or_else(|| window.app_name().ok())
                    .unwrap_or_else(|| pid.to_string()),
                process_id: pid,
            });
        }
        Ok(apps.into_values().collect())
    }

    fn resolve_application(
        &self,
        locator: &AppLocator,
        allow_launch: bool,
    ) -> Result<ResolvedApplication> {
        if matches!(locator, AppLocator::BundleId { .. }) {
            return Err(AutomationError::UnsupportedPlatform);
        }
        let resolve = || -> Result<Option<ResolvedApplication>> {
            let matches: Vec<_> = self
                .list_applications()?
                .into_iter()
                .filter(|app| match locator {
                    AppLocator::Path { path } => app
                        .path
                        .as_ref()
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(path)),
                    AppLocator::DisplayName { display_name } => {
                        app.display_name.eq_ignore_ascii_case(display_name)
                    }
                    AppLocator::BundleId { .. } => false,
                })
                .collect();
            match matches.len() {
                0 => Ok(None),
                1 => Ok(matches.into_iter().next()),
                _ => Err(AutomationError::BackendError {
                    message: "application locator is ambiguous; choose an executable path".into(),
                }),
            }
        };
        if let Some(app) = resolve()? {
            return Ok(app);
        }
        if !allow_launch {
            return Err(AutomationError::ElementNotFound);
        }
        let AppLocator::Path { path } = locator else {
            return Err(AutomationError::UnsupportedPlatform);
        };
        if !std::path::Path::new(path).is_absolute() || !std::path::Path::new(path).is_file() {
            return Err(AutomationError::BackendError {
                message: "application path must be an existing absolute executable".into(),
            });
        }
        let mut child = std::process::Command::new(path)
            .spawn()
            .map_err(native_error)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(app) = resolve()? {
                // Reap the launcher asynchronously without terminating the app.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(app);
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Err(AutomationError::ElementNotFound)
    }

    fn read_application_tree(
        &self,
        app: &ResolvedApplication,
        opts: TreeOpts,
    ) -> Result<Vec<ElementInfo>> {
        let window = self.application_window(app, None)?;
        let hwnd = windows::Win32::Foundation::HWND(
            window.id().map_err(native_error)? as usize as *mut std::ffi::c_void
        );
        let root = self
            .automation
            .element_from_handle(hwnd.into())
            .map_err(native_error)?;
        if root.get_process_id().ok() != Some(app.process_id) {
            return Err(AutomationError::StaleElement);
        }
        let condition = self
            .automation
            .create_true_condition()
            .map_err(native_error)?;
        let title = window.title().ok();
        let tree = tree_shape::walk_tree(
            &root,
            TreeBudget::from_opts(opts.max_depth),
            &|element| {
                let mut info = element_info(&self.cache, element);
                info.process_name = Some(app.display_name.clone());
                info.window_title = title.clone();
                info
            },
            &|element, limit| {
                element
                    .find_all(TreeScope::Children, &condition)
                    .unwrap_or_default()
                    .into_iter()
                    .take(limit)
                    .collect()
            },
        );
        Ok(vec![tree])
    }

    fn screenshot_application(
        &self,
        app: &ResolvedApplication,
        window_hint: Option<&ElementInfo>,
        opts: ScreenshotOpts,
    ) -> Result<ApplicationScreenshot> {
        if opts.region.is_some() {
            return Err(AutomationError::UnsupportedPlatform);
        }
        let hint_id = match window_hint {
            Some(info) => {
                let element = self
                    .cache
                    .get(&info.element_ref)
                    .ok_or(AutomationError::StaleElement)?;
                let handle = element.get_native_window_handle().map_err(native_error)?;
                let hwnd: windows::Win32::Foundation::HWND = handle.into();
                if hwnd.0.is_null() {
                    return Err(AutomationError::StaleElement);
                }
                Some(hwnd.0 as usize as u32)
            }
            None => None,
        };
        let window = self.application_window(app, hint_id)?;
        let bounds = Rect {
            x: window.x().map_err(native_error)?,
            y: window.y().map_err(native_error)?,
            width: i32::try_from(window.width().map_err(native_error)?).unwrap_or(i32::MAX),
            height: i32::try_from(window.height().map_err(native_error)?).unwrap_or(i32::MAX),
        };
        if bounds.width <= 0 || bounds.height <= 0 || window.is_minimized().map_err(native_error)? {
            return Err(AutomationError::BackendError {
                message: "target window is minimized or empty".into(),
            });
        }
        let shot = screenshot::capture_window(&window, &opts)?;
        Ok(ApplicationScreenshot {
            screenshot: shot,
            window_id: Some(u64::from(window.id().map_err(native_error)?)),
            display_id: window
                .current_monitor()
                .ok()
                .and_then(|monitor| monitor.id().ok())
                .map(|id| id.to_string()),
            logical_bounds: bounds,
            // Windows input and xcap bounds are both physical desktop pixels.
            scale_factor: 1.0,
        })
    }

    fn read_tree(&self, root: Option<ElementRef>, opts: TreeOpts) -> Result<Vec<ElementInfo>> {
        let root_elt = if let Some(r) = root {
            self.cache.get(&r).ok_or(AutomationError::StaleElement)?
        } else {
            self.automation
                .get_root_element()
                .map_err(|e| AutomationError::BackendError {
                    message: format!("get_root_element: {e}"),
                })?
        };
        let max_depth = opts.max_depth.unwrap_or(2);
        let mut out = Vec::new();
        walk(
            &self.cache,
            &self.automation,
            &root_elt,
            max_depth,
            &mut out,
        )?;
        Ok(out)
    }

    fn find(&self, locator: &Locator) -> Result<Option<ElementRef>> {
        let from_elt = if let Some(r) = &locator.from {
            self.cache.get(r)
        } else {
            None
        };
        let matcher = find::build_matcher(&self.automation, locator, from_elt.as_ref());
        match matcher.find_first() {
            Ok(elt) => Ok(Some(self.cache.insert(elt))),
            Err(_) => Ok(None),
        }
    }

    fn screenshot(&self, opts: ScreenshotOpts) -> Result<Screenshot> {
        screenshot::capture_primary(&opts)
    }

    fn click(&self, target: ClickTarget, opts: ClickOpts) -> Result<()> {
        if opts.modifier.is_some() {
            return Err(AutomationError::UnsupportedPlatform);
        }
        // Resolve effective click count: explicit `count` wins; otherwise
        // `double: true` means 2, anything else means 1. Triple-click only
        // round-trips reliably through the coordinate path, so we bypass
        // pattern dispatch when count > 1.
        let count = opts
            .count
            .unwrap_or_else(|| if opts.double == Some(true) { 2 } else { 1 })
            .max(1);

        match target {
            ClickTarget::Element { element_ref } => {
                let elt = self
                    .cache
                    .get(&element_ref)
                    .ok_or(AutomationError::StaleElement)?;

                if crate::automation::platform::shared::pointer::native_click_eligible(&opts) {
                    // UIA Pattern-first click strategy. `useNative` defaults
                    // to true: try Invoke → Toggle → SelectionItem; on miss,
                    // fall back to a coordinate click at the bounding-rect
                    // center.
                    let use_native = opts.use_native.unwrap_or(true);
                    if use_native {
                        if let Ok(true) = pattern::try_pattern_click(&elt) {
                            return Ok(());
                        }
                    }
                }

                // Multi-click or pattern miss: coordinate click at the
                // element's bounding-rect center, repeated `count` times with
                // OS double-click cadence.
                let rect =
                    elt.get_bounding_rectangle()
                        .map_err(|e| AutomationError::BackendError {
                            message: format!("bounding_rect for fallback click: {e}"),
                        })?;
                let cx = (rect.get_left() + rect.get_right()) / 2;
                let cy = (rect.get_top() + rect.get_bottom()) / 2;
                self.require_foreground_element(&elt)?;
                input::click_point_multi(cx, cy, count, opts.button.unwrap_or(MouseButton::Left))
            }
            ClickTarget::Point { x, y } => {
                input::click_point_multi(x, y, count, opts.button.unwrap_or(MouseButton::Left))
            }
        }
    }

    fn type_text(&self, text: &str, opts: TypeOpts) -> Result<()> {
        if let Some(target) = &opts.target {
            let elt = self
                .cache
                .get(target)
                .ok_or(AutomationError::StaleElement)?;
            elt.set_focus().map_err(|e| AutomationError::BackendError {
                message: format!("set_focus: {e}"),
            })?;
        }
        input::type_text(text, opts.delay_ms)
    }

    fn send_keys(&self, chord: &KeyChord) -> Result<()> {
        input::send_chord(chord)
    }

    fn invoke_pattern(
        &self,
        target: ElementRef,
        kind: PatternKind,
        args: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let elt = self
            .cache
            .get(&target)
            .ok_or(AutomationError::StaleElement)?;
        pattern::dispatch_pattern(&elt, kind, args)
    }

    fn window_op(&self, target: ElementRef, op: WindowOp) -> Result<()> {
        let elt = self
            .cache
            .get(&target)
            .ok_or(AutomationError::StaleElement)?;
        pattern::dispatch_window_op(&elt, op)
    }

    fn subscribe_events(&self, filter: EventFilter) -> Result<SubscriptionId> {
        let scope = match filter.scope.as_ref() {
            Some(element_ref) => Some(
                self.cache
                    .get(element_ref)
                    .ok_or(AutomationError::StaleElement)?,
            ),
            None => None,
        };
        self.events.subscribe(&filter, scope)
    }
    fn unsubscribe(&self, sub: SubscriptionId) -> Result<()> {
        self.events.unsubscribe(&sub)
    }

    fn read_text_selection(&self) -> Result<Option<TextSelectionSnapshot>> {
        let focused = self.automation.get_focused_element().map_err(|error| {
            AutomationError::BackendError {
                message: format!("get_focused_element: {error}"),
            }
        })?;
        let focused_info = element_info(&self.cache, &focused);
        let source_process = focused
            .get_process_id()
            .ok()
            .and_then(process_name)
            .or(focused_info.process_name.clone());
        let Some((_container, ranges)) =
            text_selection::selected_ranges(&self.automation, &focused)
        else {
            return Ok(None);
        };
        let Some(text) = text_selection::selected_text(&ranges) else {
            return Ok(None);
        };
        Ok(build_text_selection(
            &text,
            source_process.as_deref().unwrap_or("Unknown"),
            focused_info.window_title.as_deref(),
            text_selection::last_visible_bounds(&ranges),
        ))
    }

    fn selection_preflight(&self) -> Result<SelectionPreflight> {
        use uiautomation::patterns::UIValuePattern;

        let focused = self.automation.get_focused_element().map_err(|error| {
            AutomationError::BackendError {
                message: format!("get_focused_element: {error}"),
            }
        })?;
        let secure_field = focused.is_password().unwrap_or(false);
        let source_subrole = focused
            .get_control_type()
            .ok()
            .map(|control_type| format!("{control_type:?}"));
        let editable = !secure_field
            && focused
                .get_pattern::<UIValuePattern>()
                .ok()
                .and_then(|pattern| pattern.is_readonly().ok())
                .is_some_and(|read_only| !read_only);
        let walker = self.automation.get_control_view_walker().ok();
        let mut ancestor = focused.clone();
        let mut window_title = None;
        let mut source_url = None;
        for _ in 0..=8 {
            let control_type = ancestor
                .get_control_type()
                .ok()
                .map(|value| format!("{value:?}"));
            if window_title.is_none() && control_type.as_deref() == Some("Window") {
                window_title = ancestor.get_name().ok().filter(|value| !value.is_empty());
            }
            if source_url.is_none() {
                source_url = ancestor
                    .get_pattern::<UIValuePattern>()
                    .ok()
                    .and_then(|pattern| pattern.get_value().ok())
                    .and_then(|value| web_document_url(control_type.as_deref(), &value));
            }
            let Some(parent) = walker
                .as_ref()
                .and_then(|walker| walker.get_parent(&ancestor).ok())
            else {
                break;
            };
            ancestor = parent;
        }
        let pid = focused.get_process_id().ok();
        Ok(SelectionPreflight {
            pid,
            process_name: pid.and_then(process_name),
            window_title,
            source_url,
            source_subrole,
            editable,
            secure_field,
            trusted: true,
        })
    }

    // ── M5 completion primitives ─────────────────────────────────────────

    fn mouse_move(&self, point: Point) -> Result<()> {
        input::move_to(point.x, point.y)
    }

    fn drag(&self, from: Point, to: Point, opts: DragOpts) -> Result<()> {
        input::drag(from, to, opts)
    }

    fn scroll(&self, target: ScrollTarget, opts: ScrollOpts) -> Result<()> {
        match target {
            ScrollTarget::Element { element_ref } => {
                let elt = self
                    .cache
                    .get(&element_ref)
                    .ok_or(AutomationError::StaleElement)?;

                // Pattern-first: ScrollPattern → ScrollItemPattern → wheel.
                if let Ok(p) = elt.get_pattern::<uiautomation::patterns::UIScrollPattern>() {
                    let (h, v) = pattern::scroll_amounts(opts);
                    p.scroll(h, v).map_err(|e| AutomationError::BackendError {
                        message: format!("ScrollPattern.scroll: {e}"),
                    })?;
                    return Ok(());
                }
                if opts.dy != 0 {
                    if let Ok(p) = elt.get_pattern::<uiautomation::patterns::UIScrollItemPattern>()
                    {
                        p.scroll_into_view()
                            .map_err(|e| AutomationError::BackendError {
                                message: format!("ScrollItem.scroll_into_view: {e}"),
                            })?;
                        return Ok(());
                    }
                }
                // Fallback to wheel at the element's bounding center.
                let rect =
                    elt.get_bounding_rectangle()
                        .map_err(|e| AutomationError::BackendError {
                            message: format!("bounding_rect for wheel scroll: {e}"),
                        })?;
                let cx = (rect.get_left() + rect.get_right()) / 2;
                let cy = (rect.get_top() + rect.get_bottom()) / 2;
                self.require_foreground_element(&elt)?;
                input::scroll_at(Point { x: cx, y: cy }, opts)
            }
            ScrollTarget::Point { x, y } => input::scroll_at(Point { x, y }, opts),
        }
    }

    fn hold_key(&self, chord: &KeyChord, duration_ms: u32) -> Result<()> {
        input::hold_key(chord, duration_ms)
    }

    fn mouse_button(&self, button: MouseButton, transition: ButtonTransition) -> Result<()> {
        input::button(button, transition)
    }

    fn cursor_position(&self) -> Result<Point> {
        input::cursor_position()
    }

    fn pick_at_point(&self, point: Point) -> Result<ElementInfo> {
        let elt = self
            .automation
            .element_from_point(uiautomation::types::Point::new(point.x, point.y))
            .map_err(|e| AutomationError::BackendError {
                message: format!("element_from_point({}, {}): {e}", point.x, point.y),
            })?;
        Ok(element_info(&self.cache, &elt))
    }
}

#[cfg(test)]
mod selection_preflight_tests {
    use super::web_document_url;

    #[test]
    fn source_url_only_comes_from_a_document_control() {
        assert_eq!(
            web_document_url(Some("Document"), "https://example.com/path"),
            Some("https://example.com/path".into())
        );
        assert_eq!(
            web_document_url(Some("Edit"), "https://example.com/path"),
            None
        );
        assert_eq!(web_document_url(Some("Document"), "file:///private"), None);
    }
}

/// Depth-bounded tree walk. Each yielded node has `children = None` (we
/// flatten into the returned Vec instead of nesting) so the renderer can
/// rebuild the tree by `parent_ref` if it needs to.
fn walk(
    cache: &ElementCache,
    automation: &UIAutomation,
    root: &uiautomation::UIElement,
    max_depth: u32,
    out: &mut Vec<ElementInfo>,
) -> Result<()> {
    out.push(element_info(cache, root));
    if max_depth == 0 {
        return Ok(());
    }
    let cond = automation
        .create_true_condition()
        .map_err(|e| AutomationError::BackendError {
            message: format!("create_true_condition: {e}"),
        })?;
    let children =
        root.find_all(TreeScope::Children, &cond)
            .map_err(|e| AutomationError::BackendError {
                message: format!("find_all children: {e}"),
            })?;
    for child in &children {
        walk(cache, automation, child, max_depth - 1, out)?;
    }
    Ok(())
}
