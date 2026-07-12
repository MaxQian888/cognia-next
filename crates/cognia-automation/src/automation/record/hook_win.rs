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

use tokio::sync::mpsc::Sender;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONUP, WM_MBUTTONUP, WM_MOUSEWHEEL, WM_QUIT,
    WM_RBUTTONUP, WM_SYSKEYDOWN,
};

use super::session::{RawButton, RawSignal};

thread_local! {
    /// The active sender for the pump thread. Set before the hooks are
    /// installed; cleared when the pump exits. The hook callbacks read it.
    static SENDER: RefCell<Option<Sender<RawSignal>>> = const { RefCell::new(None) };
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(sig: RawSignal) {
    SENDER.with(|cell| {
        if let Some(tx) = cell.borrow().as_ref() {
            // Non-blocking: never stall the input chain. A full buffer drops the
            // signal (it's coarse observational noise, not authoritative input).
            let _ = tx.try_send(sig);
        }
    });
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let (x, y) = (info.pt.x, info.pt.y);
        let ts = now_ms();
        let sig = match wparam.0 as u32 {
            WM_LBUTTONUP => Some(RawSignal::Click {
                x,
                y,
                button: RawButton::Left,
                ts_ms: ts,
            }),
            WM_RBUTTONUP => Some(RawSignal::Click {
                x,
                y,
                button: RawButton::Right,
                ts_ms: ts,
            }),
            WM_MBUTTONUP => Some(RawSignal::Click {
                x,
                y,
                button: RawButton::Middle,
                ts_ms: ts,
            }),
            WM_MOUSEWHEEL => {
                // HIWORD of mouseData is a signed wheel delta (multiple of 120).
                let delta = ((info.mouseData >> 16) & 0xFFFF) as u16 as i16 as i32;
                Some(RawSignal::Scroll {
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

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        match wparam.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                send(RawSignal::Key {
                    vk: info.vkCode,
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
    pub(crate) fn install(tx: Sender<RawSignal>) -> Result<HookGuard, String> {
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
        let (tx, _rx) = tokio::sync::mpsc::channel::<RawSignal>(8);
        let guard = HookGuard::install(tx).expect("install hook on windows");
        drop(guard); // joins the pump thread — must not hang
    }
}
