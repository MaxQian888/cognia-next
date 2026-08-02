//! Windows global input hook for the skill recorder.
//!
//! Installs low-level `WH_MOUSE_LL` + `WH_KEYBOARD_LL` hooks on a dedicated
//! thread that runs a message pump (LL hook callbacks are delivered only to a
//! thread with a running message loop). The callback does near-zero work —
//! timestamp + `try_send` a coarse `RawSignal` — because a slow LL hook is
//! silently dropped by Windows past `LowLevelHooksTimeout` (~300ms). All heavy
//! work (screenshot, element pick) happens off this thread in the async drain
//! loop.
//!
//! COM is NEVER initialized on this thread: element hit-testing routes through
//! the existing automation worker (`AutomationHandle::pick_at_point`), which
//! owns the COM apartment.

use std::cell::RefCell;
use std::sync::mpsc::channel;
use std::thread::{self, JoinHandle};

use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, GetKeyboardState, ToUnicodeEx,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HC_ACTION,
    KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_SYSKEYDOWN,
};

/// `ToUnicodeEx` flag bit 2: translate without mutating the keyboard state.
///
/// Without it, translating inside a low-level hook *consumes* a pending dead
/// key, so the foreground application would receive `e` where the user typed
/// `´` then `e`. Observing input must never change it. Available since Windows
/// 10 1607; on older builds the flag is ignored and translation still works,
/// just with the dead-key caveat.
const TO_UNICODE_NO_STATE_CHANGE: u32 = 1 << 2;

use super::{InputButton, InputEvent};

thread_local! {
    /// The active sender for the pump thread. Set before the hooks are
    /// installed; cleared when the pump exits. The hook callbacks read it.
    static SENDER: RefCell<Option<UnboundedSender<InputEvent>>> = const { RefCell::new(None) };
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(sig: InputEvent) {
    SENDER.with(|cell| {
        if let Some(tx) = cell.borrow().as_ref() {
            let _ = tx.send(sig);
        }
    });
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let (x, y) = (info.pt.x, info.pt.y);
        let ts = now_ms();
        let sig = match wparam.0 as u32 {
            WM_LBUTTONDOWN => Some(InputEvent::MouseDown {
                x,
                y,
                button: InputButton::Left,
                ts_ms: ts,
            }),
            WM_RBUTTONDOWN => Some(InputEvent::MouseDown {
                x,
                y,
                button: InputButton::Right,
                ts_ms: ts,
            }),
            WM_MBUTTONDOWN => Some(InputEvent::MouseDown {
                x,
                y,
                button: InputButton::Middle,
                ts_ms: ts,
            }),
            WM_LBUTTONUP => Some(InputEvent::MouseUp {
                x,
                y,
                button: InputButton::Left,
                ts_ms: ts,
            }),
            WM_RBUTTONUP => Some(InputEvent::MouseUp {
                x,
                y,
                button: InputButton::Right,
                ts_ms: ts,
            }),
            WM_MBUTTONUP => Some(InputEvent::MouseUp {
                x,
                y,
                button: InputButton::Middle,
                ts_ms: ts,
            }),
            WM_MOUSEWHEEL => {
                // HIWORD of mouseData is a signed wheel delta (multiple of 120).
                let delta = ((info.mouseData >> 16) & 0xFFFF) as u16 as i16 as i32;
                Some(InputEvent::Scroll {
                    x,
                    y,
                    dy: delta,
                    ts_ms: ts,
                })
            }
            _ => None,
        };
        if let Some(sig) = sig {
            send(sig);
        }
    }
    // hhk is ignored by CallNextHookEx on current Windows; pass a null handle.
    CallNextHookEx(None, code, wparam, lparam)
}

/// Decode the character this key press produces under the foreground window's
/// keyboard layout.
///
/// A virtual-key code is layout-blind — the same `vk` is `;` on a US layout and
/// `ö` on a German one — so transcribing typed text needs the translated
/// character. `None` for dead keys, pure modifiers, and anything that does not
/// resolve to a single `char`; all of those are described structurally
/// downstream rather than guessed at.
///
/// Cost is a few microseconds, which the low-level hook's timeout budget can
/// absorb. Nothing heavier (UIA, COM, the secure-field probe) belongs here —
/// Windows silently evicts a hook that overruns `LowLevelHooksTimeout`.
///
/// # Safety
/// Calls into user32 with stack buffers whose lengths are passed alongside them.
unsafe fn decode_unicode(info: &KBDLLHOOKSTRUCT) -> Option<char> {
    let mut state = [0u8; 256];
    if GetKeyboardState(&mut state).is_err() {
        return None;
    }
    let layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), None));
    let mut buf = [0u16; 8];
    let written = ToUnicodeEx(
        info.vkCode,
        info.scanCode,
        &state,
        &mut buf,
        TO_UNICODE_NO_STATE_CHANGE,
        Some(layout),
    );
    if written <= 0 {
        return None;
    }
    let len = (written as usize).min(buf.len());
    char::decode_utf16(buf[..len].iter().copied()).next()?.ok()
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                send(InputEvent::KeyDown {
                    vk: info.vkCode,
                    text: decode_unicode(info),
                    ts_ms: now_ms(),
                });
            }
            _ => {}
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Owns the hook thread. Dropping it posts `WM_QUIT` to break the message pump,
/// which then unhooks both hooks and exits; the thread is then joined.
pub(crate) struct HookGuard {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl HookGuard {
    pub(crate) fn install(tx: UnboundedSender<InputEvent>) -> Result<HookGuard, String> {
        let (ready_tx, ready_rx) = channel::<Result<u32, String>>();
        let join = thread::Builder::new()
            .name("skill-recorder-hook".into())
            .spawn(move || {
                SENDER.with(|cell| *cell.borrow_mut() = Some(tx));
                unsafe {
                    let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0);
                    let kbd = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0);
                    match (mouse, kbd) {
                        (Ok(mh), Ok(kh)) => {
                            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
                            let mut msg = MSG::default();
                            // GetMessageW returns 0 on WM_QUIT, -1 on error.
                            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                                let _ = TranslateMessage(&msg);
                                DispatchMessageW(&msg);
                            }
                            let _ = UnhookWindowsHookEx(mh);
                            let _ = UnhookWindowsHookEx(kh);
                        }
                        (m, k) => {
                            if let Ok(mh) = m {
                                let _ = UnhookWindowsHookEx(mh);
                            }
                            if let Ok(kh) = k {
                                let _ = UnhookWindowsHookEx(kh);
                            }
                            let _ = ready_tx
                                .send(Err("SetWindowsHookExW failed (input hook blocked?)".into()));
                        }
                    }
                }
                SENDER.with(|cell| *cell.borrow_mut() = None);
            })
            .map_err(|e| format!("spawn hook thread failed: {e}"))?;

        match ready_rx.recv() {
            Ok(Ok(thread_id)) => Ok(HookGuard {
                thread_id,
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
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_and_drop_round_trip() {
        // Installing a real hook on the Windows CI/dev host should succeed; the
        // guard's Drop must cleanly tear down the pump thread without hanging.
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<InputEvent>();
        let guard = HookGuard::install(tx).expect("install hook on windows");
        drop(guard); // joins the pump thread — must not hang
    }
}
