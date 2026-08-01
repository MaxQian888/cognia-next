//! What a recording is allowed to see, and the native enforcement of it.
//!
//! Scope is checked **after coalescing and strictly before any pixel touches
//! disk**. An out-of-scope interaction produces an opaque marker step — never a
//! frame, never an element, never a title. The renderer only ever learns how
//! many such steps were ignored.
//!
//! Two rules here are load-bearing and easy to get wrong:
//!
//! - **Window identity is re-verified on every capture.** Window ids are OS
//!   handles and get recycled. Binding once at start and trusting the id
//!   afterwards would let a closed window's id, reused by something else, hand
//!   that something else's pixels to the model.
//! - **A key run is scoped by the focused process, not by the cursor.** Typed
//!   text has no coordinate. Falling back to "whatever is under the mouse" would
//!   capture a password typed into a floating password manager whenever the
//!   pointer happened to be resting over the scoped window.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::automation::session::AppLocator;
use crate::automation::types::{Point, Rect};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ScopeError {
    #[error("the selected window is no longer open")]
    WindowGone,
    #[error("the selected application is not running")]
    ApplicationGone,
}

/// The recording's field of view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CaptureScope {
    /// One native window. `window_id` is the OS handle (CGWindowID on macOS,
    /// HWND-as-u32 on Windows) — stable for the window's lifetime but **not**
    /// across restarts, hence the identity fields beside it.
    Window {
        window_id: u32,
        process_id: u32,
        app_name: String,
        /// Title at bind time. Advisory only — titles change constantly, so this
        /// is display text, never a gate.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// Every window of one application, including child dialogs that run under
    /// their own pid.
    Application { locator: AppLocator },
    /// The whole desktop. Cognia's own recorder surfaces are still excluded, via
    /// window content protection rather than via this check.
    Desktop,
}

impl CaptureScope {
    /// Log- and telemetry-safe descriptor. Carries the shape of the scope and
    /// nothing about what the user is looking at.
    pub fn kind_label(&self) -> &'static str {
        match self {
            CaptureScope::Window { .. } => "window",
            CaptureScope::Application { .. } => "application",
            CaptureScope::Desktop => "desktop",
        }
    }

    /// Human-facing summary for the consent prompt and the recoverable-bundle
    /// list. This one *does* name the target — that is the entire point of an
    /// informed consent dialog — so it must never be routed to telemetry.
    pub fn summary(&self) -> String {
        match self {
            CaptureScope::Window {
                app_name,
                title: Some(title),
                ..
            } if !title.is_empty() => format!("{app_name} — {title}"),
            CaptureScope::Window { app_name, .. } => app_name.clone(),
            CaptureScope::Application { locator } => locator_label(locator),
            CaptureScope::Desktop => "Whole desktop".into(),
        }
    }
}

fn locator_label(locator: &AppLocator) -> String {
    match locator {
        AppLocator::BundleId { bundle_id } => bundle_id.clone(),
        AppLocator::Path { path } => path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(path.as_str())
            .to_string(),
        AppLocator::DisplayName { display_name } => display_name.clone(),
    }
}

/// Minimal, testable projection of `xcap::Window`. Everything `decide` needs and
/// nothing it doesn't.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowSnapshot {
    pub id: u32,
    pub pid: u32,
    pub app_name: String,
    pub title: String,
    pub rect: Rect,
    pub minimized: bool,
    pub focused: bool,
    pub z: i32,
}

impl WindowSnapshot {
    fn contains(&self, p: Point) -> bool {
        p.x >= self.rect.x
            && p.y >= self.rect.y
            && p.x < self.rect.x.saturating_add(self.rect.width)
            && p.y < self.rect.y.saturating_add(self.rect.height)
    }
}

/// Outcome of one scope check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeVerdict {
    /// Capture exactly this global-logical rect. Already scope-clipped.
    Capture { rect: Rect },
    /// Whole-desktop capture is permitted.
    CaptureDesktop,
    /// The interaction happened outside scope. Record an opaque marker only.
    OutOfScope,
    /// The scope target vanished. Ends the session as `interrupted`, which keeps
    /// the journal recoverable.
    ScopeLost { reason: &'static str },
}

/// Live binding for the active session: the scope plus the identities it
/// currently resolves to. Re-derived per capture from a fresh window list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeBinding {
    pub scope: CaptureScope,
    /// Process ids the scope covers. Empty for `Desktop`.
    pub pids: Vec<u32>,
    /// Application names the scope covers. An app's child dialogs frequently run
    /// under their own pid, so name matching is what makes "application scope
    /// follows its child dialogs" true.
    pub app_names: Vec<String>,
}

impl ScopeBinding {
    /// Pure binding against a supplied window list.
    ///
    /// `resolved_pid` is the backend's authoritative answer for an
    /// `Application` locator (macOS can resolve a bundle id properly); when the
    /// backend cannot resolve it, the window list is matched by name instead.
    pub fn bind(
        scope: CaptureScope,
        resolved_pid: Option<u32>,
        windows: &[WindowSnapshot],
    ) -> Result<Self, ScopeError> {
        match &scope {
            CaptureScope::Desktop => Ok(Self {
                scope,
                pids: Vec::new(),
                app_names: Vec::new(),
            }),
            CaptureScope::Window {
                window_id,
                process_id,
                app_name,
                ..
            } => {
                let found = windows
                    .iter()
                    .find(|w| w.id == *window_id && w.pid == *process_id);
                if found.is_none() {
                    return Err(ScopeError::WindowGone);
                }
                Ok(Self {
                    pids: vec![*process_id],
                    app_names: vec![app_name.clone()],
                    scope,
                })
            }
            CaptureScope::Application { locator } => {
                let mut pids: Vec<u32> = resolved_pid.into_iter().collect();
                let mut app_names: Vec<String> = Vec::new();
                for w in windows {
                    if pids.contains(&w.pid) || locator_matches(locator, &w.app_name) {
                        if !pids.contains(&w.pid) {
                            pids.push(w.pid);
                        }
                        if !app_names
                            .iter()
                            .any(|n| n.eq_ignore_ascii_case(&w.app_name))
                        {
                            app_names.push(w.app_name.clone());
                        }
                    }
                }
                if pids.is_empty() {
                    return Err(ScopeError::ApplicationGone);
                }
                if app_names.is_empty() {
                    app_names.push(locator_label(locator));
                }
                Ok(Self {
                    scope,
                    pids,
                    app_names,
                })
            }
        }
    }

    /// I/O wrapper over [`Self::bind`].
    pub fn resolve(scope: CaptureScope, resolved_pid: Option<u32>) -> Result<Self, ScopeError> {
        Self::bind(scope, resolved_pid, &snapshot_windows())
    }

    fn covers(&self, w: &WindowSnapshot) -> bool {
        self.pids.contains(&w.pid)
            || self
                .app_names
                .iter()
                .any(|n| n.eq_ignore_ascii_case(&w.app_name))
    }

    /// The pure decision. `point` is `None` for a key run, in which case
    /// `focus_pid` decides — see the module docs for why.
    pub fn decide(
        &self,
        point: Option<Point>,
        focus_pid: Option<u32>,
        windows: &[WindowSnapshot],
    ) -> ScopeVerdict {
        match &self.scope {
            CaptureScope::Desktop => ScopeVerdict::CaptureDesktop,

            CaptureScope::Window {
                window_id,
                process_id,
                app_name,
                ..
            } => {
                let Some(target) = windows.iter().find(|w| w.id == *window_id) else {
                    return ScopeVerdict::ScopeLost {
                        reason: "window-closed",
                    };
                };
                // The id alone proves nothing — the OS recycles handles.
                if target.pid != *process_id || !target.app_name.eq_ignore_ascii_case(app_name) {
                    return ScopeVerdict::ScopeLost {
                        reason: "window-identity-changed",
                    };
                }
                if target.minimized {
                    return ScopeVerdict::OutOfScope;
                }
                match point {
                    Some(p) if target.contains(p) => ScopeVerdict::Capture { rect: target.rect },
                    Some(_) => ScopeVerdict::OutOfScope,
                    None if focus_pid == Some(*process_id) => {
                        ScopeVerdict::Capture { rect: target.rect }
                    }
                    None => ScopeVerdict::OutOfScope,
                }
            }

            CaptureScope::Application { .. } => {
                let covered: Vec<&WindowSnapshot> =
                    windows.iter().filter(|w| self.covers(w)).collect();
                if covered.is_empty() {
                    return ScopeVerdict::ScopeLost {
                        reason: "application-exited",
                    };
                }
                match point {
                    Some(p) => covered
                        .iter()
                        .filter(|w| !w.minimized && w.contains(p))
                        // Topmost wins: a modal child dialog sits above its parent.
                        .max_by_key(|w| w.z)
                        .map(|w| ScopeVerdict::Capture { rect: w.rect })
                        .unwrap_or(ScopeVerdict::OutOfScope),
                    None => match focus_pid {
                        Some(pid) => covered
                            .iter()
                            .find(|w| w.pid == pid && !w.minimized)
                            .map(|w| ScopeVerdict::Capture { rect: w.rect })
                            .unwrap_or(ScopeVerdict::OutOfScope),
                        None => ScopeVerdict::OutOfScope,
                    },
                }
            }
        }
    }

    /// I/O wrapper over [`Self::decide`].
    pub fn evaluate(&self, point: Option<Point>, focus_pid: Option<u32>) -> ScopeVerdict {
        self.decide(point, focus_pid, &snapshot_windows())
    }
}

fn locator_matches(locator: &AppLocator, app_name: &str) -> bool {
    let candidate = match locator {
        AppLocator::DisplayName { display_name } => display_name.as_str(),
        AppLocator::BundleId { bundle_id } => bundle_id.rsplit('.').next().unwrap_or(bundle_id),
        AppLocator::Path { path } => {
            let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
            file.trim_end_matches(".app").trim_end_matches(".exe")
        }
    };
    !candidate.is_empty() && candidate.eq_ignore_ascii_case(app_name)
}

/// Enumerate the live window list. Best-effort: an enumeration failure yields an
/// empty list, which `decide` reads as `ScopeLost` for a scoped recording and as
/// "carry on" for desktop scope — the conservative reading in both cases.
pub fn snapshot_windows() -> Vec<WindowSnapshot> {
    let Ok(windows) = xcap::Window::all() else {
        return Vec::new();
    };
    windows
        .iter()
        .filter_map(|w| {
            Some(WindowSnapshot {
                id: w.id().ok()?,
                pid: w.pid().ok()?,
                app_name: w.app_name().ok()?,
                title: w.title().unwrap_or_default(),
                rect: Rect {
                    x: w.x().ok()?,
                    y: w.y().ok()?,
                    width: w.width().ok()? as i32,
                    height: w.height().ok()? as i32,
                },
                minimized: w.is_minimized().unwrap_or(false),
                focused: w.is_focused().unwrap_or(false),
                z: w.z().unwrap_or(0),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: u32, pid: u32, app: &str, x: i32, y: i32) -> WindowSnapshot {
        WindowSnapshot {
            id,
            pid,
            app_name: app.into(),
            title: "doc".into(),
            rect: Rect {
                x,
                y,
                width: 100,
                height: 100,
            },
            minimized: false,
            focused: false,
            z: 0,
        }
    }

    fn window_scope(id: u32, pid: u32, app: &str) -> CaptureScope {
        CaptureScope::Window {
            window_id: id,
            process_id: pid,
            app_name: app.into(),
            title: Some("doc".into()),
        }
    }

    fn bound(scope: CaptureScope, windows: &[WindowSnapshot]) -> ScopeBinding {
        ScopeBinding::bind(scope, None, windows).expect("bind")
    }

    #[test]
    fn window_scope_captures_a_point_inside_the_window() {
        let windows = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        assert_eq!(
            b.decide(Some(Point { x: 50, y: 50 }), None, &windows),
            ScopeVerdict::Capture {
                rect: windows[0].rect
            }
        );
    }

    #[test]
    fn window_scope_rejects_point_outside_rect() {
        let windows = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        assert_eq!(
            b.decide(Some(Point { x: 500, y: 500 }), None, &windows),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn window_scope_edges_are_half_open() {
        let windows = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        assert!(matches!(
            b.decide(Some(Point { x: 0, y: 0 }), None, &windows),
            ScopeVerdict::Capture { .. }
        ));
        assert!(matches!(
            b.decide(Some(Point { x: 99, y: 99 }), None, &windows),
            ScopeVerdict::Capture { .. }
        ));
        assert_eq!(
            b.decide(Some(Point { x: 100, y: 0 }), None, &windows),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn window_scope_rejects_recycled_id_with_different_pid() {
        let bind_time = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &bind_time);
        // Same OS handle, different process — the id was recycled.
        let later = vec![win(1, 99, "Banking", 0, 0)];
        assert_eq!(
            b.decide(Some(Point { x: 50, y: 50 }), None, &later),
            ScopeVerdict::ScopeLost {
                reason: "window-identity-changed"
            }
        );
    }

    #[test]
    fn window_scope_rejects_recycled_id_with_different_app_name() {
        let bind_time = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &bind_time);
        let later = vec![win(1, 10, "1Password", 0, 0)];
        assert!(matches!(
            b.decide(Some(Point { x: 50, y: 50 }), None, &later),
            ScopeVerdict::ScopeLost { .. }
        ));
    }

    #[test]
    fn window_scope_reports_lost_when_window_gone() {
        let windows = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        assert_eq!(
            b.decide(Some(Point { x: 50, y: 50 }), None, &[]),
            ScopeVerdict::ScopeLost {
                reason: "window-closed"
            }
        );
    }

    #[test]
    fn minimized_window_is_out_of_scope_not_lost() {
        let mut windows = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        windows[0].minimized = true;
        assert_eq!(
            b.decide(Some(Point { x: 50, y: 50 }), None, &windows),
            ScopeVerdict::OutOfScope,
            "a minimized window is temporarily unviewable, not gone"
        );
    }

    #[test]
    fn key_run_scoped_by_focus_pid_not_cursor() {
        // The scoped window sits under the pointer, but focus (and therefore the
        // typing) is in a password manager. Nothing may be captured.
        let windows = vec![win(1, 10, "Safari", 0, 0), win(2, 77, "1Password", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        assert_eq!(
            b.decide(None, Some(77), &windows),
            ScopeVerdict::OutOfScope,
            "typing into another process must never be captured"
        );
        assert!(matches!(
            b.decide(None, Some(10), &windows),
            ScopeVerdict::Capture { .. }
        ));
    }

    #[test]
    fn key_run_without_focus_information_is_out_of_scope() {
        let windows = vec![win(1, 10, "Safari", 0, 0)];
        let b = bound(window_scope(1, 10, "Safari"), &windows);
        assert_eq!(
            b.decide(None, None, &windows),
            ScopeVerdict::OutOfScope,
            "unknown focus must fail closed"
        );
    }

    #[test]
    fn application_scope_accepts_any_window_of_the_pid() {
        let windows = vec![win(1, 10, "Figma", 0, 0), win(2, 10, "Figma", 200, 0)];
        let b = bound(
            CaptureScope::Application {
                locator: AppLocator::DisplayName {
                    display_name: "Figma".into(),
                },
            },
            &windows,
        );
        assert_eq!(
            b.decide(Some(Point { x: 250, y: 10 }), None, &windows),
            ScopeVerdict::Capture {
                rect: windows[1].rect
            }
        );
    }

    #[test]
    fn application_scope_follows_child_dialogs_under_their_own_pid() {
        let windows = vec![
            win(1, 10, "Figma", 0, 0),
            // A helper process owns the save dialog.
            win(2, 44, "Figma", 10, 10),
        ];
        let b = bound(
            CaptureScope::Application {
                locator: AppLocator::DisplayName {
                    display_name: "Figma".into(),
                },
            },
            &windows,
        );
        assert!(b.pids.contains(&44), "the child pid must join the binding");
        assert!(matches!(
            b.decide(None, Some(44), &windows),
            ScopeVerdict::Capture { .. }
        ));
    }

    #[test]
    fn application_scope_picks_the_topmost_overlapping_window() {
        let mut back = win(1, 10, "Figma", 0, 0);
        back.z = 1;
        let mut front = win(2, 10, "Figma", 0, 0);
        front.z = 5;
        front.rect.width = 50;
        let windows = vec![back, front.clone()];
        let b = bound(
            CaptureScope::Application {
                locator: AppLocator::DisplayName {
                    display_name: "Figma".into(),
                },
            },
            &windows,
        );
        assert_eq!(
            b.decide(Some(Point { x: 10, y: 10 }), None, &windows),
            ScopeVerdict::Capture { rect: front.rect }
        );
    }

    #[test]
    fn application_scope_rejects_another_app() {
        let windows = vec![win(1, 10, "Figma", 0, 0), win(2, 20, "Mail", 200, 0)];
        let b = bound(
            CaptureScope::Application {
                locator: AppLocator::DisplayName {
                    display_name: "Figma".into(),
                },
            },
            &windows,
        );
        assert_eq!(
            b.decide(Some(Point { x: 250, y: 10 }), None, &windows),
            ScopeVerdict::OutOfScope
        );
    }

    #[test]
    fn application_scope_reports_lost_when_every_window_closes() {
        let windows = vec![win(1, 10, "Figma", 0, 0)];
        let b = bound(
            CaptureScope::Application {
                locator: AppLocator::DisplayName {
                    display_name: "Figma".into(),
                },
            },
            &windows,
        );
        assert_eq!(
            b.decide(Some(Point { x: 10, y: 10 }), None, &[]),
            ScopeVerdict::ScopeLost {
                reason: "application-exited"
            }
        );
    }

    #[test]
    fn desktop_scope_accepts_everything() {
        let b = bound(CaptureScope::Desktop, &[]);
        assert_eq!(
            b.decide(Some(Point { x: -900, y: 4000 }), None, &[]),
            ScopeVerdict::CaptureDesktop
        );
        assert_eq!(b.decide(None, None, &[]), ScopeVerdict::CaptureDesktop);
    }

    #[test]
    fn binding_a_missing_window_fails_fast() {
        assert_eq!(
            ScopeBinding::bind(window_scope(1, 10, "Safari"), None, &[]),
            Err(ScopeError::WindowGone)
        );
    }

    #[test]
    fn binding_a_missing_application_fails_fast() {
        assert_eq!(
            ScopeBinding::bind(
                CaptureScope::Application {
                    locator: AppLocator::DisplayName {
                        display_name: "NotRunning".into()
                    }
                },
                None,
                &[win(1, 10, "Figma", 0, 0)]
            ),
            Err(ScopeError::ApplicationGone)
        );
    }

    #[test]
    fn binding_uses_the_backend_resolved_pid_when_names_do_not_match() {
        // macOS resolves a bundle id to a pid whose xcap `app_name` differs.
        let windows = vec![win(1, 501, "Google Chrome", 0, 0)];
        let b = ScopeBinding::bind(
            CaptureScope::Application {
                locator: AppLocator::BundleId {
                    bundle_id: "com.google.Chrome".into(),
                },
            },
            Some(501),
            &windows,
        )
        .expect("resolved pid must be enough to bind");
        assert!(b.pids.contains(&501));
    }

    #[test]
    fn locator_matches_by_bundle_leaf_and_executable_name() {
        assert!(locator_matches(
            &AppLocator::BundleId {
                bundle_id: "com.apple.Safari".into()
            },
            "Safari"
        ));
        assert!(locator_matches(
            &AppLocator::Path {
                path: "/Applications/Safari.app".into()
            },
            "safari"
        ));
        assert!(locator_matches(
            &AppLocator::Path {
                path: "C:\\Program Files\\Notepad.exe".into()
            },
            "Notepad"
        ));
        assert!(!locator_matches(
            &AppLocator::DisplayName {
                display_name: "Safari".into()
            },
            "Mail"
        ));
    }

    #[test]
    fn scope_serializes_camel_case_tagged() {
        let json = serde_json::to_string(&window_scope(7, 8, "Safari")).unwrap();
        assert!(json.contains("\"kind\":\"window\""));
        assert!(json.contains("\"windowId\":7"));
        assert!(json.contains("\"processId\":8"));
        let back: CaptureScope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, window_scope(7, 8, "Safari"));

        let desktop = serde_json::to_string(&CaptureScope::Desktop).unwrap();
        assert_eq!(desktop, "{\"kind\":\"desktop\"}");
    }

    #[test]
    fn kind_label_is_log_safe() {
        // The label is what may reach telemetry; it must not vary with content.
        assert_eq!(window_scope(1, 2, "Banking").kind_label(), "window");
        assert_eq!(CaptureScope::Desktop.kind_label(), "desktop");
        assert_eq!(
            CaptureScope::Application {
                locator: AppLocator::DisplayName {
                    display_name: "Payroll".into()
                }
            }
            .kind_label(),
            "application"
        );
    }

    #[test]
    fn summary_names_the_target_for_the_consent_prompt() {
        assert_eq!(window_scope(1, 2, "Safari").summary(), "Safari — doc");
        assert_eq!(
            CaptureScope::Window {
                window_id: 1,
                process_id: 2,
                app_name: "Safari".into(),
                title: None,
            }
            .summary(),
            "Safari"
        );
        assert_eq!(CaptureScope::Desktop.summary(), "Whole desktop");
        assert_eq!(
            CaptureScope::Application {
                locator: AppLocator::Path {
                    path: "/Applications/Figma.app".into()
                }
            }
            .summary(),
            "Figma.app"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn snapshot_windows_is_callable() {
        // Host-dependent, so only totality is asserted — mirrors the probe test
        // style in platform/shared/screen_capture.rs.
        let _ = snapshot_windows();
    }
}
