//! macOS global input hook for the skill recorder (CGEventTap).
//!
//! The macOS counterpart to `hook_win.rs`. A dedicated thread runs a CFRunLoop
//! with a HID-level, **listen-only** event tap that maps coarse mouse-up /
//! scroll / key-down events into `RawSignal`s and `try_send`s them into the
//! recorder's drain channel. Like the Windows callback it does near-zero work —
//! timestamp + non-blocking send — so it never stalls the event stream; all
//! heavy capture (screenshot, element pick) happens off this thread in the
//! async drain loop.
//!
//! Requires Accessibility / Input Monitoring permission. Without it
//! `CGEventTapCreate` returns null, `install` fails, and the command maps the
//! error to a `record:event` error — the same graceful degradation the old
//! non-Windows stub gave, but now Mac users who *have* granted permission get
//! real recordings.
//!
//! macOS virtual keycodes live in a different space from the Windows VK codes
//! the platform-agnostic reducer (`session.rs`: `vk_to_char` / `is_commit_key`)
//! expects, so `cg_keycode_to_vk` translates them — keeping the shared coalescer
//! and its tests correct across platforms.

use std::ffi::c_void;
use std::sync::mpsc::channel;
use std::sync::{Arc, OnceLock};
use std::thread::{self, JoinHandle};

use core_foundation::base::TCFType;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_graphics::event::{
    CGEvent, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement,
    CGEventTapProxy, CGEventType, CallbackResult, EventField,
};
use tokio::sync::mpsc::Sender;

use super::{InputButton, InputEvent};

extern "C" {
    /// Re-enable a tap the system disabled (timeout / secure-input switch).
    /// `core-graphics` keeps its own `CGEventTapEnable` private, so we bind it
    /// directly; the symbol resolves through the CoreGraphics framework the
    /// crate already links.
    fn CGEventTapEnable(tap: *const c_void, enable: bool);
}

/// Windows `WHEEL_DELTA` — one notch. The Windows hook reports wheel motion in
/// multiples of this; macOS reports small line deltas, so we scale to the same
/// unit to keep the coarse `scroll_dy` hint comparable across platforms.
const WHEEL_DELTA: i32 = 120;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A raw CoreFoundation pointer we promise to use only in thread-safe ways
/// (`CGEventTapEnable` and `CFRunLoopStop` are both documented thread-safe).
struct SendPtr(*const c_void);
// SAFETY: only ever read to call the thread-safe `CGEventTapEnable`.
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

/// The hook thread's run loop, handed back to the guard so `Drop` can stop it
/// from another thread (`CFRunLoopStop` is thread-safe).
struct SendRunLoop(CFRunLoop);
// SAFETY: we only call the thread-safe `stop()` / drop it.
unsafe impl Send for SendRunLoop {}

/// Translate a macOS virtual keycode (`kVK_ANSI_*`) into the Windows virtual-key
/// code the shared reducer understands. Returns `0` for every key the reducer
/// ignores — `vk_to_char` drops it and `is_commit_key` is false — so modifiers,
/// arrows, function keys, etc. fold away exactly as a non-printable Windows vk
/// would.
pub(crate) fn cg_keycode_to_vk(keycode: i64) -> u32 {
    match keycode {
        // Letters → VK 'A'..'Z' (0x41..=0x5A).
        0x00 => 0x41,
        0x0B => 0x42,
        0x08 => 0x43,
        0x02 => 0x44,
        0x0E => 0x45,
        0x03 => 0x46,
        0x05 => 0x47,
        0x04 => 0x48,
        0x22 => 0x49,
        0x26 => 0x4A,
        0x28 => 0x4B,
        0x25 => 0x4C,
        0x2E => 0x4D,
        0x2D => 0x4E,
        0x1F => 0x4F,
        0x23 => 0x50,
        0x0C => 0x51,
        0x0F => 0x52,
        0x01 => 0x53,
        0x11 => 0x54,
        0x20 => 0x55,
        0x09 => 0x56,
        0x0D => 0x57,
        0x07 => 0x58,
        0x10 => 0x59,
        0x06 => 0x5A,
        // Digits → VK '0'..'9' (0x30..=0x39).
        0x1D => 0x30,
        0x12 => 0x31,
        0x13 => 0x32,
        0x14 => 0x33,
        0x15 => 0x34,
        0x17 => 0x35,
        0x16 => 0x36,
        0x1A => 0x37,
        0x1C => 0x38,
        0x19 => 0x39,
        // Space / Tab / Return → VK_SPACE / VK_TAB / VK_RETURN. Tab + Return are
        // the reducer's commit keys (a natural workflow boundary).
        0x31 => 0x20,
        0x30 => 0x09,
        0x24 => 0x0D,
        _ => 0,
    }
}

/// Project a tap event (already reduced to plain integers) into a `RawSignal`.
/// Pure — unit-tested without a live event tap. Mouse-*up* (not down) mirrors
/// the Windows hook so a click commits once, on release.
pub(crate) fn to_signal(
    etype: CGEventType,
    x: i32,
    y: i32,
    scroll_dy: i32,
    keycode: i64,
    ts_ms: i64,
) -> Option<InputEvent> {
    match etype {
        CGEventType::LeftMouseDown => Some(InputEvent::MouseDown {
            x,
            y,
            button: InputButton::Left,
            ts_ms,
        }),
        CGEventType::RightMouseDown => Some(InputEvent::MouseDown {
            x,
            y,
            button: InputButton::Right,
            ts_ms,
        }),
        CGEventType::OtherMouseDown => Some(InputEvent::MouseDown {
            x,
            y,
            button: InputButton::Middle,
            ts_ms,
        }),
        CGEventType::LeftMouseUp => Some(InputEvent::MouseUp {
            x,
            y,
            button: InputButton::Left,
            ts_ms,
        }),
        CGEventType::RightMouseUp => Some(InputEvent::MouseUp {
            x,
            y,
            button: InputButton::Right,
            ts_ms,
        }),
        CGEventType::OtherMouseUp => Some(InputEvent::MouseUp {
            x,
            y,
            button: InputButton::Middle,
            ts_ms,
        }),
        CGEventType::ScrollWheel => Some(InputEvent::Scroll {
            x,
            y,
            dy: scroll_dy,
            ts_ms,
        }),
        CGEventType::KeyDown => Some(InputEvent::KeyDown {
            vk: cg_keycode_to_vk(keycode),
            ts_ms,
        }),
        _ => None,
    }
}

/// Read the integer event fields `to_signal` needs and emit the projected
/// signal. Disable notifications re-enable the tap so a transient timeout /
/// secure-input switch doesn't silently kill the session mid-recording.
fn on_event(
    tx: &Sender<InputEvent>,
    port: &OnceLock<SendPtr>,
    etype: CGEventType,
    event: &CGEvent,
) {
    match etype {
        CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
            if let Some(p) = port.get() {
                unsafe { CGEventTapEnable(p.0, true) };
            }
        }
        _ => {
            let loc = event.location();
            let scroll_dy =
                event.get_integer_value_field(EventField::SCROLL_WHEEL_EVENT_DELTA_AXIS_1) as i32
                    * WHEEL_DELTA;
            let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
            if let Some(sig) = to_signal(
                etype,
                loc.x as i32,
                loc.y as i32,
                scroll_dy,
                keycode,
                now_ms(),
            ) {
                // Non-blocking: a full buffer drops coarse observational noise
                // rather than stalling the event stream.
                let _ = tx.try_send(sig);
            }
        }
    }
}

/// Owns the hook thread + its run loop. Dropping it stops the run loop, which
/// returns from `CFRunLoop::run_current`, drops (invalidates) the tap, and lets
/// the thread exit; the thread is then joined.
pub(crate) struct HookGuard {
    run_loop: SendRunLoop,
    join: Option<JoinHandle<()>>,
}

impl HookGuard {
    pub(crate) fn install(tx: Sender<InputEvent>) -> Result<HookGuard, String> {
        let (ready_tx, ready_rx) = channel::<Result<SendRunLoop, String>>();
        let join = thread::Builder::new()
            .name("skill-recorder-hook".into())
            .spawn(move || {
                // Set once the tap exists so `on_event` can re-enable it after a
                // system-issued disable. The closure and the post-creation
                // setter share it via `Arc`.
                let port: Arc<OnceLock<SendPtr>> = Arc::new(OnceLock::new());
                let port_cb = port.clone();
                let callback =
                    move |_proxy: CGEventTapProxy, etype: CGEventType, event: &CGEvent| {
                        on_event(&tx, &port_cb, etype, event);
                        CallbackResult::Keep
                    };

                let tap = match CGEventTap::new(
                    CGEventTapLocation::HID,
                    CGEventTapPlacement::HeadInsertEventTap,
                    CGEventTapOptions::ListenOnly,
                    vec![
                        CGEventType::LeftMouseDown,
                        CGEventType::RightMouseDown,
                        CGEventType::OtherMouseDown,
                        CGEventType::LeftMouseUp,
                        CGEventType::RightMouseUp,
                        CGEventType::OtherMouseUp,
                        CGEventType::ScrollWheel,
                        CGEventType::KeyDown,
                    ],
                    callback,
                ) {
                    Ok(tap) => tap,
                    Err(()) => {
                        let _ = ready_tx.send(Err(
                            "input recording needs Accessibility / Input Monitoring \
                             permission (System Settings → Privacy & Security)"
                                .into(),
                        ));
                        return;
                    }
                };

                // Publish the port so the callback can re-enable on disable.
                let _ = port.set(SendPtr(
                    tap.mach_port().as_concrete_TypeRef() as *const c_void
                ));

                let source = match tap.mach_port().create_runloop_source(0) {
                    Ok(source) => source,
                    Err(()) => {
                        let _ = ready_tx.send(Err("failed to create run-loop source".into()));
                        return;
                    }
                };

                let run_loop = CFRunLoop::get_current();
                unsafe { run_loop.add_source(&source, kCFRunLoopCommonModes) };
                tap.enable();

                // Hand the run loop to the guard, then block until it stops.
                let _ = ready_tx.send(Ok(SendRunLoop(run_loop)));
                CFRunLoop::run_current();
                // run_current returned (guard dropped → stop). `tap`/`source`
                // drop here, invalidating the mach port and detaching the source.
            })
            .map_err(|e| format!("spawn hook thread failed: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok(run_loop)) => Ok(HookGuard {
                run_loop,
                join: Some(join),
            }),
            Ok(Err(e)) => {
                let _ = join.join();
                Err(e)
            }
            Err(e) => Err(format!("hook thread exited before ready: {e}")),
        }
    }
}

impl Drop for HookGuard {
    fn drop(&mut self) {
        self.run_loop.0.stop();
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keycode_maps_letters_digits_and_commit_keys_to_vk() {
        // A handful of letters across the scattered macOS layout.
        assert_eq!(cg_keycode_to_vk(0x00), 0x41); // A
        assert_eq!(cg_keycode_to_vk(0x06), 0x5A); // Z
        assert_eq!(cg_keycode_to_vk(0x11), 0x54); // T
                                                  // Digits.
        assert_eq!(cg_keycode_to_vk(0x12), 0x31); // 1
        assert_eq!(cg_keycode_to_vk(0x1D), 0x30); // 0
                                                  // Commit + space.
        assert_eq!(cg_keycode_to_vk(0x24), 0x0D); // Return
        assert_eq!(cg_keycode_to_vk(0x30), 0x09); // Tab
        assert_eq!(cg_keycode_to_vk(0x31), 0x20); // Space
                                                  // Unmapped (e.g. Escape 0x35, Left Shift 0x38) → 0 (reducer ignores).
        assert_eq!(cg_keycode_to_vk(0x35), 0);
        assert_eq!(cg_keycode_to_vk(0x38), 0);
    }

    #[test]
    fn keycode_map_has_no_duplicate_targets_for_alphanumerics() {
        // Every letter and digit must map to a distinct VK so reconstructed
        // text hints aren't lossy beyond the documented case-folding.
        let mut seen = std::collections::HashSet::new();
        for kc in 0i64..=0x32 {
            let vk = cg_keycode_to_vk(kc);
            if vk != 0 {
                assert!(
                    seen.insert(vk),
                    "duplicate VK 0x{vk:02X} for keycode 0x{kc:02X}"
                );
            }
        }
        // 26 letters + 10 digits + space + tab + return = 39 distinct codes.
        assert_eq!(seen.len(), 39);
    }

    #[test]
    fn to_signal_maps_each_button_and_kind() {
        assert!(matches!(
            to_signal(CGEventType::LeftMouseUp, 3, 4, 0, 0, 9),
            Some(InputEvent::MouseUp {
                x: 3,
                y: 4,
                button: InputButton::Left,
                ts_ms: 9,
            })
        ));
        assert!(matches!(
            to_signal(CGEventType::RightMouseUp, 0, 0, 0, 0, 0),
            Some(InputEvent::MouseUp {
                button: InputButton::Right,
                ..
            })
        ));
        assert!(matches!(
            to_signal(CGEventType::OtherMouseUp, 0, 0, 0, 0, 0),
            Some(InputEvent::MouseUp {
                button: InputButton::Middle,
                ..
            })
        ));
        assert!(matches!(
            to_signal(CGEventType::ScrollWheel, 1, 2, -240, 0, 7),
            Some(InputEvent::Scroll { dy: -240, .. })
        ));
        assert!(matches!(
            to_signal(CGEventType::KeyDown, 0, 0, 0, 0x00, 0),
            Some(InputEvent::KeyDown { vk: 0x41, .. }) // A
        ));
    }

    #[test]
    fn to_signal_ignores_non_input_events() {
        assert!(matches!(
            to_signal(CGEventType::LeftMouseDown, 0, 0, 0, 0, 0),
            Some(InputEvent::MouseDown { .. })
        ));
        // Moves and disable notifications produce no observation.
        assert!(to_signal(CGEventType::MouseMoved, 0, 0, 0, 0, 0).is_none());
        assert!(to_signal(CGEventType::TapDisabledByTimeout, 0, 0, 0, 0, 0).is_none());
    }

    #[test]
    fn key_signal_carries_translated_vk_for_unmapped_keys() {
        // An unmapped key still emits a Key signal (vk 0) — the reducer buffers
        // it and `keys_to_hint` drops it, exactly like a Windows modifier.
        assert!(matches!(
            to_signal(CGEventType::KeyDown, 0, 0, 0, 0x35, 0),
            Some(InputEvent::KeyDown { vk: 0, .. })
        ));
    }

    // A real tap round-trip needs Accessibility permission and a live run loop,
    // so it can't run unattended in CI (mirrors the Windows hook's reliance on a
    // real desktop). Run locally with `cargo test -- --ignored` after granting
    // permission to verify install + clean teardown don't hang.
    #[test]
    #[ignore = "requires Accessibility/Input Monitoring permission + live run loop"]
    fn install_and_drop_round_trip() {
        let (tx, _rx) = tokio::sync::mpsc::channel::<InputEvent>(8);
        let guard = HookGuard::install(tx).expect("install tap (permission granted)");
        drop(guard); // stops the run loop + joins — must not hang
    }
}
