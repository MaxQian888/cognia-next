//! Raw input signals → committed steps.
//!
//! The platform hook emits one signal per physical event; a human "action" is
//! usually several of them (a double-click, a typed word, a scroll flick). This
//! reducer collapses them so the trace reads as a workflow instead of a
//! keystroke log.
//!
//! Extracted verbatim from the original `session.rs` and then extended with the
//! secure-input plumbing: each key now carries its layout-decoded character and
//! the focus state sampled *at the moment it was pressed*, so
//! [`super::secure_input::classify_run`] can take the conservative union over
//! the whole run rather than trusting a single sample at its start.
//!
//! The reducer is pure. It performs no capture, makes no scope decision and
//! touches no disk — the drain loop does all of that with what `fold`/`flush`
//! hand back.

use super::secure_input::SecureState;
use crate::automation::types::Point;

/// Rapid clicks closer together than this (ms) AND within `CLICK_COALESCE_PX`
/// are one step (double/triple-click).
pub const CLICK_COALESCE_MS: i64 = 400;
pub const CLICK_COALESCE_PX: i32 = 6;
/// A key run with inter-key gaps under this many ms is one step. The run also
/// commits on a non-key signal, on idle, or on Enter/Tab.
pub const KEY_IDLE_MS: i64 = 800;
/// Consecutive scrolls within this many ms accumulate into one step.
pub const SCROLL_COALESCE_MS: i64 = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawButton {
    Left,
    Right,
    Middle,
}

/// What the platform hook emits, normalized. Kept minimal so the hook callback
/// does near-zero work — on Windows it must return well under the
/// `LowLevelHooksTimeout`, or the OS silently evicts the hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawSignal {
    Click {
        x: i32,
        y: i32,
        button: RawButton,
        ts_ms: i64,
    },
    Scroll {
        x: i32,
        y: i32,
        dy: i32,
        ts_ms: i64,
    },
    Key {
        vk: u32,
        /// Layout-decoded character, when the hook could produce one. `None`
        /// falls back to a structural description rather than to a guess.
        text: Option<char>,
        /// Focus classification sampled when this key was pressed.
        secure: SecureState,
        ts_ms: i64,
    },
}

/// What the reducer decided to commit as one step.
#[derive(Debug, Clone, PartialEq)]
pub enum CommitIntent {
    Click {
        point: Point,
        ts_ms: i64,
    },
    Key {
        /// Parallel per-key data, handed straight to `classify_run`. Deliberately
        /// not pre-joined into a string: joining before the secure check would
        /// mean the sensitive characters existed as text, however briefly.
        decoded: Vec<Option<char>>,
        vks: Vec<u32>,
        states: Vec<SecureState>,
        ts_ms: i64,
    },
    Scroll {
        point: Point,
        dy: i32,
        ts_ms: i64,
    },
}

#[derive(Default)]
pub struct CoalesceState {
    vks: Vec<u32>,
    decoded: Vec<Option<char>>,
    states: Vec<SecureState>,
    keys_first_ts: i64,
    last_click: Option<(i32, i32, RawButton, i64)>,
    scroll: Option<(i32, i32, i32, i64)>, // x, y, accumulated dy, last ts
}

impl CoalesceState {
    /// Fold one raw signal, returning any steps that became final. Usually 0 or
    /// 1; occasionally 2 (a click that flushes a pending key run first).
    pub fn fold(&mut self, sig: RawSignal) -> Vec<CommitIntent> {
        let mut out = Vec::new();
        match sig {
            RawSignal::Click {
                x,
                y,
                button,
                ts_ms,
            } => {
                self.flush_keys(&mut out);
                self.flush_scroll(&mut out);
                if let Some((lx, ly, lb, lts)) = self.last_click {
                    let close = (ts_ms - lts) <= CLICK_COALESCE_MS
                        && (x - lx).abs() <= CLICK_COALESCE_PX
                        && (y - ly).abs() <= CLICK_COALESCE_PX
                        && lb == button;
                    if close {
                        // Absorb the repeat into the existing click step.
                        self.last_click = Some((x, y, button, ts_ms));
                        return out;
                    }
                }
                self.last_click = Some((x, y, button, ts_ms));
                out.push(CommitIntent::Click {
                    point: Point { x, y },
                    ts_ms,
                });
            }
            RawSignal::Key {
                vk,
                text,
                secure,
                ts_ms,
            } => {
                self.flush_scroll(&mut out);
                if self.vks.is_empty() {
                    self.keys_first_ts = ts_ms;
                }
                self.vks.push(vk);
                self.decoded.push(text);
                self.states.push(secure);
                if is_commit_key(vk) {
                    self.flush_keys(&mut out);
                }
            }
            RawSignal::Scroll { x, y, dy, ts_ms } => {
                self.flush_keys(&mut out);
                match self.scroll.take() {
                    Some((_sx, _sy, sdy, sts)) if (ts_ms - sts) <= SCROLL_COALESCE_MS => {
                        self.scroll = Some((x, y, sdy + dy, ts_ms));
                    }
                    Some((sx, sy, sdy, sts)) => {
                        out.push(CommitIntent::Scroll {
                            point: Point { x: sx, y: sy },
                            dy: sdy,
                            ts_ms: sts,
                        });
                        self.scroll = Some((x, y, dy, ts_ms));
                    }
                    None => {
                        self.scroll = Some((x, y, dy, ts_ms));
                    }
                }
            }
        }
        out
    }

    /// Commit everything still buffered. Called on the idle tick and — crucially
    /// — on pause, stop and interrupt, which is what makes those operations
    /// lossless.
    pub fn flush(&mut self) -> Vec<CommitIntent> {
        let mut out = Vec::new();
        self.flush_keys(&mut out);
        self.flush_scroll(&mut out);
        out
    }

    /// True when a flush would produce nothing. Lets the drain loop skip an
    /// idle-tick round trip.
    pub fn is_empty(&self) -> bool {
        self.vks.is_empty() && self.scroll.is_none()
    }

    fn flush_keys(&mut self, out: &mut Vec<CommitIntent>) {
        if self.vks.is_empty() {
            return;
        }
        out.push(CommitIntent::Key {
            decoded: std::mem::take(&mut self.decoded),
            vks: std::mem::take(&mut self.vks),
            states: std::mem::take(&mut self.states),
            ts_ms: self.keys_first_ts,
        });
    }

    fn flush_scroll(&mut self, out: &mut Vec<CommitIntent>) {
        if let Some((x, y, dy, ts_ms)) = self.scroll.take() {
            out.push(CommitIntent::Scroll {
                point: Point { x, y },
                dy,
                ts_ms,
            });
        }
    }
}

/// Enter / Tab commit a key run immediately — they usually mean "submit" or
/// "next field", which is a natural boundary in a workflow.
pub fn is_commit_key(vk: u32) -> bool {
    const VK_TAB: u32 = 0x09;
    const VK_RETURN: u32 = 0x0D;
    vk == VK_TAB || vk == VK_RETURN
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::record::journal::TextCapture;
    use crate::automation::record::secure_input::classify_run;

    fn click(x: i32, y: i32, ts: i64) -> RawSignal {
        RawSignal::Click {
            x,
            y,
            button: RawButton::Left,
            ts_ms: ts,
        }
    }

    fn key(vk: u32, ts: i64) -> RawSignal {
        RawSignal::Key {
            vk,
            text: char::from_u32(vk).map(|c| c.to_ascii_lowercase()),
            secure: SecureState::Plain,
            ts_ms: ts,
        }
    }

    fn secure_key(vk: u32, ts: i64) -> RawSignal {
        RawSignal::Key {
            vk,
            text: char::from_u32(vk),
            secure: SecureState::Secure,
            ts_ms: ts,
        }
    }

    fn scroll(dy: i32, ts: i64) -> RawSignal {
        RawSignal::Scroll {
            x: 10,
            y: 10,
            dy,
            ts_ms: ts,
        }
    }

    fn count_clicks(out: &[CommitIntent]) -> usize {
        out.iter()
            .filter(|i| matches!(i, CommitIntent::Click { .. }))
            .count()
    }

    #[test]
    fn double_click_coalesces_to_one() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(click(102, 101, 50)));
        assert_eq!(
            count_clicks(&out),
            1,
            "rapid clicks within window+px collapse"
        );
    }

    #[test]
    fn separated_clicks_are_two() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(click(100, 100, 600)));
        assert_eq!(
            count_clicks(&out),
            2,
            "clicks beyond the window are distinct"
        );
    }

    #[test]
    fn far_apart_clicks_are_two() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(click(400, 400, 50)));
        assert_eq!(
            count_clicks(&out),
            2,
            "clicks far apart in space are distinct"
        );
    }

    #[test]
    fn different_buttons_do_not_coalesce() {
        let mut c = CoalesceState::default();
        let mut out = c.fold(click(100, 100, 0));
        out.extend(c.fold(RawSignal::Click {
            x: 100,
            y: 100,
            button: RawButton::Right,
            ts_ms: 10,
        }));
        assert_eq!(count_clicks(&out), 2);
    }

    #[test]
    fn key_run_collapses_to_a_single_intent() {
        let mut c = CoalesceState::default();
        for (i, vk) in [0x48u32, 0x45, 0x4C, 0x4C, 0x4F].iter().enumerate() {
            assert!(
                c.fold(key(*vk, i as i64 * 100)).is_empty(),
                "a key run must not commit mid-stream"
            );
        }
        let out = c.flush();
        assert_eq!(out.len(), 1);
        match &out[0] {
            CommitIntent::Key {
                decoded,
                vks,
                states,
                ..
            } => {
                assert_eq!(vks.len(), 5);
                assert_eq!(decoded.len(), 5);
                assert_eq!(states.len(), 5);
                assert_eq!(
                    classify_run(decoded, vks, states),
                    TextCapture::Text {
                        value: "hello".into()
                    }
                );
            }
            other => panic!("expected key commit, got {other:?}"),
        }
    }

    #[test]
    fn key_run_carries_secure_union() {
        let mut c = CoalesceState::default();
        c.fold(key(0x48, 0));
        c.fold(secure_key(0x49, 50)); // focus moved into a password field
        c.fold(key(0x4A, 100));
        let out = c.flush();
        match &out[0] {
            CommitIntent::Key {
                decoded,
                vks,
                states,
                ..
            } => {
                assert!(states.contains(&SecureState::Secure));
                assert_eq!(
                    classify_run(decoded, vks, states),
                    TextCapture::Sensitive,
                    "one secure sample must poison the whole run"
                );
            }
            other => panic!("expected key commit, got {other:?}"),
        }
    }

    #[test]
    fn key_intent_timestamps_the_start_of_the_run() {
        let mut c = CoalesceState::default();
        c.fold(key(0x48, 500));
        c.fold(key(0x49, 900));
        match &c.flush()[0] {
            CommitIntent::Key { ts_ms, .. } => assert_eq!(*ts_ms, 500),
            other => panic!("expected key commit, got {other:?}"),
        }
    }

    #[test]
    fn enter_commits_key_run_immediately() {
        let mut c = CoalesceState::default();
        c.fold(key(0x48, 0));
        let out = c.fold(key(0x0D, 50));
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], CommitIntent::Key { .. }));
        assert!(c.is_empty(), "the run must be drained by the commit key");
    }

    #[test]
    fn tab_commits_key_run_immediately() {
        let mut c = CoalesceState::default();
        c.fold(key(0x41, 0));
        assert_eq!(c.fold(key(0x09, 10)).len(), 1);
    }

    #[test]
    fn click_flushes_pending_key_run_first() {
        let mut c = CoalesceState::default();
        c.fold(key(0x41, 0));
        let out = c.fold(click(50, 50, 100));
        assert_eq!(out.len(), 2, "key run commits, then the click");
        assert!(matches!(out[0], CommitIntent::Key { .. }));
        assert!(matches!(out[1], CommitIntent::Click { .. }));
    }

    #[test]
    fn scroll_flushes_pending_key_run_first() {
        let mut c = CoalesceState::default();
        c.fold(key(0x41, 0));
        let out = c.fold(scroll(120, 100));
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], CommitIntent::Key { .. }));
    }

    #[test]
    fn scroll_burst_sums_dy() {
        let mut c = CoalesceState::default();
        assert!(c.fold(scroll(120, 0)).is_empty());
        assert!(c.fold(scroll(120, 100)).is_empty());
        assert!(c.fold(scroll(-60, 200)).is_empty());
        let out = c.flush();
        assert_eq!(out.len(), 1);
        match &out[0] {
            CommitIntent::Scroll { dy, .. } => assert_eq!(*dy, 180),
            other => panic!("expected scroll commit, got {other:?}"),
        }
    }

    #[test]
    fn scroll_beyond_the_window_starts_a_new_burst() {
        let mut c = CoalesceState::default();
        c.fold(scroll(120, 0));
        let out = c.fold(scroll(120, SCROLL_COALESCE_MS + 1));
        assert_eq!(out.len(), 1, "the stale burst commits");
        assert!(!c.is_empty(), "the new burst is still buffered");
    }

    #[test]
    fn flush_is_idempotent() {
        let mut c = CoalesceState::default();
        c.fold(key(0x41, 0));
        assert_eq!(c.flush().len(), 1);
        assert!(c.flush().is_empty(), "a second flush must produce nothing");
    }

    #[test]
    fn is_empty_tracks_buffered_state() {
        let mut c = CoalesceState::default();
        assert!(c.is_empty());
        c.fold(key(0x41, 0));
        assert!(!c.is_empty());
        c.flush();
        assert!(c.is_empty());
        c.fold(scroll(1, 0));
        assert!(!c.is_empty(), "a buffered scroll counts too");
    }

    #[test]
    fn a_click_does_not_leave_buffered_state() {
        let mut c = CoalesceState::default();
        c.fold(click(1, 1, 0));
        assert!(c.is_empty());
    }

    #[test]
    fn undecoded_key_still_records_its_vk() {
        let mut c = CoalesceState::default();
        c.fold(RawSignal::Key {
            vk: 0xF1,
            text: None,
            secure: SecureState::Plain,
            ts_ms: 0,
        });
        match &c.flush()[0] {
            CommitIntent::Key { decoded, vks, .. } => {
                assert_eq!(vks, &[0xF1]);
                assert_eq!(decoded, &[None]);
            }
            other => panic!("expected key commit, got {other:?}"),
        }
    }

    #[test]
    fn is_commit_key_covers_tab_and_enter_only() {
        assert!(is_commit_key(0x09));
        assert!(is_commit_key(0x0D));
        assert!(!is_commit_key(0x41));
        assert!(!is_commit_key(0x1B));
    }
}
