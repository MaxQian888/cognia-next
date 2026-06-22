//! Per-session "model view" state for the chat computer-use path.
//!
//! When screenshot down-scaling is enabled the model only ever sees the
//! scaled frame, so every coordinate it emits is in *scaled* space. This
//! module owns the per-session bookkeeping that maps those coordinates
//! back to physical pixels, dedups unchanged consecutive screenshots, and
//! tracks consecutive failures for runaway-loop guidance.
//!
//! Consumers:
//!   - `plugins::computer_use::commands::plugin_computer_use_execute` —
//!     the chat-path adapter for the Anthropic `computer_20251124` tool.
//!   - The renderer-side MCP / external-bridge path implements the same
//!     logic in `lib/automation/anthropic-action-mapper.ts` (it dispatches
//!     through individual `desktop_*` commands, not this module).
//!
//! State is keyed by the renderer-supplied `sessionKey` (falling back to
//! the sandbox connection id / "local") and is process-lifetime — entries
//! are tiny (4 ints + a hash) and chat sessions are bounded, so no
//! eviction is needed.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use super::types::*;

/// Cap for model-requested waits — keeps a confused model from parking a
/// gated automation session for minutes.
pub const MAX_WAIT_MS: u32 = 30_000;

/// After this many consecutive failed actions, guidance is appended to the
/// error so the model stops hammering a broken interaction.
pub const CONSECUTIVE_FAILURE_GUIDANCE_AT: u32 = 5;

#[derive(Debug, Default, Clone)]
struct ViewState {
    /// Dimensions of the last frame the model saw (post-downscale).
    scaled: Option<(u32, u32)>,
    /// Physical dimensions backing that frame.
    source: Option<(u32, u32)>,
    /// FNV-1a hash of the last screenshot payload (dedup).
    last_hash: Option<u64>,
    /// Consecutive failed actions.
    failures: u32,
}

static STATE: Lazy<Mutex<HashMap<String, ViewState>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Out-of-bounds tolerance in scaled pixels — models occasionally emit
/// coordinates a hair past the edge; those clamp instead of failing.
const EDGE_TOLERANCE: i32 = 2;

fn with_state<R>(key: &str, f: impl FnOnce(&mut ViewState) -> R) -> R {
    let mut map = STATE.lock().unwrap_or_else(|p| p.into_inner());
    f(map.entry(key.to_string()).or_default())
}

/// FNV-1a over the base64 payload — cheap, no image decode.
fn hash_payload(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Record the dimensions of the latest screenshot the model saw and
/// report whether it is identical to the previous one (dedup). The hash
/// is updated unconditionally so a `true` only ever fires for genuinely
/// consecutive identical frames.
pub fn record_screenshot(key: &str, shot: &Screenshot) -> bool {
    let hash = hash_payload(&shot.bytes);
    with_state(key, |s| {
        s.scaled = Some((shot.width, shot.height));
        s.source = Some((
            shot.source_width.unwrap_or(shot.width),
            shot.source_height.unwrap_or(shot.height),
        ));
        s.failures = 0; // a successful screenshot clears the failure streak
        let unchanged = s.last_hash == Some(hash);
        s.last_hash = Some(hash);
        unchanged
    })
}

/// A driving action succeeded — the screen likely changed, so the next
/// screenshot must be delivered as a real image, and the failure streak
/// resets.
pub fn note_action_success(key: &str) {
    with_state(key, |s| {
        s.last_hash = None;
        s.failures = 0;
    })
}

/// An action failed. Returns the guidance suffix to append once the
/// consecutive-failure threshold is reached, `None` below it.
pub fn note_action_failure(key: &str) -> Option<String> {
    with_state(key, |s| {
        s.failures = s.failures.saturating_add(1);
        if s.failures >= CONSECUTIVE_FAILURE_GUIDANCE_AT {
            Some(format!(
                " ({} consecutive action failures — stop and ask the user before retrying)",
                s.failures
            ))
        } else {
            None
        }
    })
}

/// Translate one model-space point into physical pixels. Identity when no
/// screenshot has been recorded (the model can't know scaled space before
/// its first frame) or when no scaling was applied. Rejects coordinates
/// outside the frame the model saw — a misplaced click is worse than a
/// retried one.
fn map_point(key: &str, p: Point) -> Result<Point> {
    with_state(key, |s| {
        let (Some((sw, sh)), Some((ow, oh))) = (s.scaled, s.source) else {
            return Ok(p);
        };
        if sw == ow && sh == oh {
            return Ok(p);
        }
        let (sw_i, sh_i) = (sw as i32, sh as i32);
        if p.x < -EDGE_TOLERANCE
            || p.y < -EDGE_TOLERANCE
            || p.x > sw_i + EDGE_TOLERANCE
            || p.y > sh_i + EDGE_TOLERANCE
        {
            return Err(AutomationError::BackendError {
                message: format!(
                    "coordinate [{}, {}] is out of bounds for the {}x{} screenshot — take a fresh screenshot and retry",
                    p.x, p.y, sw, sh
                ),
            });
        }
        let cx = p.x.clamp(0, sw_i);
        let cy = p.y.clamp(0, sh_i);
        Ok(Point {
            x: ((cx as f64) * f64::from(ow) / f64::from(sw)).round() as i32,
            y: ((cy as f64) * f64::from(oh) / f64::from(sh)).round() as i32,
        })
    })
}

/// Map every coordinate a canonical action carries from model space to
/// physical pixels, and clamp `Wait` to [`MAX_WAIT_MS`]. Non-coordinate
/// actions pass through untouched.
pub fn map_action(key: &str, action: Action) -> Result<Action> {
    Ok(match action {
        Action::Click {
            target: ClickTarget::Point { x, y },
            opts,
        } => {
            let p = map_point(key, Point { x, y })?;
            Action::Click {
                target: ClickTarget::Point { x: p.x, y: p.y },
                opts,
            }
        }
        Action::MouseMove { point } => Action::MouseMove {
            point: map_point(key, point)?,
        },
        Action::Drag { from, to, opts } => Action::Drag {
            from: map_point(key, from)?,
            to: map_point(key, to)?,
            opts,
        },
        Action::Scroll {
            target: ScrollTarget::Point { x, y },
            opts,
        } => {
            let p = map_point(key, Point { x, y })?;
            Action::Scroll {
                target: ScrollTarget::Point { x: p.x, y: p.y },
                opts,
            }
        }
        Action::PickAtPoint { point } => Action::PickAtPoint {
            point: map_point(key, point)?,
        },
        Action::Wait { duration_ms } => Action::Wait {
            duration_ms: duration_ms.min(MAX_WAIT_MS),
        },
        other => other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: tests share the process-global STATE map and cargo runs them in
    // parallel — every test uses its own unique key for isolation instead
    // of a global reset (which would clobber concurrently-running tests).

    fn shot(bytes: &str, w: u32, h: u32, src: Option<(u32, u32)>) -> Screenshot {
        Screenshot {
            bytes: bytes.into(),
            width: w,
            height: h,
            captured_at: 1,
            format: ImageFormat::Png,
            source_width: src.map(|s| s.0),
            source_height: src.map(|s| s.1),
        }
    }

    #[test]
    fn record_screenshot_dedups_consecutive_identical_frames() {
        assert!(!record_screenshot("k1", &shot("SAME", 10, 10, None)));
        assert!(record_screenshot("k1", &shot("SAME", 10, 10, None)));
        // Different payload breaks the streak.
        assert!(!record_screenshot("k1", &shot("OTHER", 10, 10, None)));
    }

    #[test]
    fn driving_success_resets_dedup() {
        assert!(!record_screenshot("k2", &shot("SAME", 10, 10, None)));
        note_action_success("k2");
        assert!(!record_screenshot("k2", &shot("SAME", 10, 10, None)));
    }

    #[test]
    fn map_action_scales_click_coordinates() {
        record_screenshot("k3", &shot("X", 640, 360, Some((1280, 720))));
        let mapped = map_action(
            "k3",
            Action::Click {
                target: ClickTarget::Point { x: 320, y: 180 },
                opts: ClickOpts::default(),
            },
        )
        .unwrap();
        match mapped {
            Action::Click {
                target: ClickTarget::Point { x, y },
                ..
            } => {
                assert_eq!((x, y), (640, 360));
            }
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn map_action_identity_without_scaling() {
        record_screenshot("k4", &shot("X", 1920, 1080, None));
        let mapped = map_action(
            "k4",
            Action::MouseMove {
                point: Point { x: 5, y: 6 },
            },
        )
        .unwrap();
        match mapped {
            Action::MouseMove { point } => assert_eq!((point.x, point.y), (5, 6)),
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn map_action_rejects_out_of_bounds() {
        record_screenshot("k5", &shot("X", 640, 360, Some((1280, 720))));
        let result = map_action(
            "k5",
            Action::Click {
                target: ClickTarget::Point { x: 900, y: 100 },
                opts: ClickOpts::default(),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn map_action_clamps_edge_tolerance() {
        record_screenshot("k6", &shot("X", 640, 360, Some((1280, 720))));
        let mapped = map_action(
            "k6",
            Action::MouseMove {
                point: Point { x: 641, y: -1 },
            },
        )
        .unwrap();
        match mapped {
            Action::MouseMove { point } => assert_eq!((point.x, point.y), (1280, 0)),
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn map_action_caps_wait() {
        let mapped = map_action(
            "k7",
            Action::Wait {
                duration_ms: 120_000,
            },
        )
        .unwrap();
        match mapped {
            Action::Wait { duration_ms } => assert_eq!(duration_ms, MAX_WAIT_MS),
            other => panic!("unexpected action: {other:?}"),
        }
    }

    #[test]
    fn failure_guidance_after_threshold() {
        for i in 1..CONSECUTIVE_FAILURE_GUIDANCE_AT {
            assert!(note_action_failure("k8").is_none(), "no guidance at #{i}");
        }
        let g = note_action_failure("k8").expect("guidance at threshold");
        assert!(g.contains("consecutive action failures"));
        // Success resets the counter.
        note_action_success("k8");
        assert!(note_action_failure("k8").is_none());
    }

    #[test]
    fn drag_maps_both_endpoints() {
        record_screenshot("k9", &shot("X", 100, 100, Some((200, 200))));
        let mapped = map_action(
            "k9",
            Action::Drag {
                from: Point { x: 10, y: 10 },
                to: Point { x: 50, y: 50 },
                opts: DragOpts::default(),
            },
        )
        .unwrap();
        match mapped {
            Action::Drag { from, to, .. } => {
                assert_eq!((from.x, from.y), (20, 20));
                assert_eq!((to.x, to.y), (100, 100));
            }
            other => panic!("unexpected action: {other:?}"),
        }
    }
}
