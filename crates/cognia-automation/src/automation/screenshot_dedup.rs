//! Screenshot de-duplication for model-facing app-session reads.
//!
//! `get_app_state` is documented as "call before every action and again
//! immediately after every action", so a computer-use turn re-captures the
//! same window constantly. When nothing on screen moved, the second frame is
//! byte-identical to the first and inlining it again costs the caller a full
//! image's worth of tokens for no new information.
//!
//! Settings → Automation → Behavior → "Skip unchanged screenshots"
//! (`AutomationSettings::screenshot_dedup`, ON by default) withholds that
//! duplicate: the frame's bytes are dropped and the revision carries a short
//! note instead. Dimensions survive so a pixel-target action can still be
//! addressed against the frame the model already saw.
//!
//! Scope is deliberately narrow:
//!
//! * Only `get_app_state` — `desktop_screenshot` is the low-level capture used
//!   by OCR (`lib/automation/ocr-screen.ts`) and by one-off UI previews, which
//!   need the real bytes every time.
//! * Only model-facing surfaces (`ComputerUse` / `Mcp` / `Plugin`). The
//!   Settings → Automation Inspector reads app state over `Surface::Workflow`
//!   and renders the frame to a human, who would otherwise watch the preview
//!   go blank on the second capture of a still window.

use std::collections::HashMap;

use parking_lot::Mutex;

use super::permission::Surface;
use super::session::UiStateRevision;

/// Sessions tracked at once. A computer-use run uses one session id, so this
/// only grows when many runs overlap; the oldest entry is dropped past the cap
/// (a dropped entry costs one un-deduped frame, never a wrong answer).
const MAX_TRACKED_SESSIONS: usize = 64;

/// Whether `surface` shows its frames to a model rather than to a person.
pub fn is_model_facing(surface: Surface) -> bool {
    matches!(
        surface,
        Surface::ComputerUse | Surface::Mcp | Surface::Plugin
    )
}

/// FNV-1a over the base64 payload. Identity only — never a security boundary,
/// so a non-cryptographic hash is the right cost. Comparing the encoded string
/// is sound because the same capture path encodes both frames.
pub fn hash_frame(bytes: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The note the model reads in place of a withheld frame.
pub fn unchanged_note(previous_revision: u64) -> String {
    format!(
        "Screen unchanged since revision {previous_revision}; the image was omitted to save \
         tokens. The frame you already have is still accurate — read the tree below for \
         anything that did move, and re-read state after your next action."
    )
}

#[derive(Debug, Clone, Copy)]
struct Seen {
    hash: u64,
    revision: u64,
    /// Insertion counter, used to evict the oldest session past the cap.
    seq: u64,
}

/// Remembers the last frame each app session showed a model.
#[derive(Debug, Default)]
pub struct ScreenshotDedup {
    seen: Mutex<HashMap<String, Seen>>,
    seq: Mutex<u64>,
}

impl ScreenshotDedup {
    /// Withhold `revision`'s screenshot when it repeats the frame this session
    /// last showed. `enabled` is the operator setting; `surface` is the caller.
    /// Returns whether the frame was withheld.
    pub fn apply(&self, revision: &mut UiStateRevision, enabled: bool, surface: Surface) -> bool {
        if !enabled || !is_model_facing(surface) {
            return false;
        }
        let Some(shot) = revision.screenshot.as_mut() else {
            return false;
        };
        // An already-empty payload has nothing to compare or to save.
        if shot.bytes.is_empty() {
            return false;
        }
        let hash = hash_frame(&shot.bytes);

        let mut seen = self.seen.lock();
        let previous = seen.get(&revision.session_id).copied();
        if let Some(previous) = previous {
            if previous.hash == hash {
                // Keep the entry pointing at the ORIGINAL revision so a long
                // run of identical frames keeps naming the frame the model
                // actually holds, not the one just withheld.
                shot.bytes.clear();
                revision.screenshot_unchanged = true;
                revision.screenshot_note = Some(unchanged_note(previous.revision));
                return true;
            }
        }

        let mut seq = self.seq.lock();
        *seq += 1;
        let stamp = *seq;
        drop(seq);
        seen.insert(
            revision.session_id.clone(),
            Seen {
                hash,
                revision: revision.revision,
                seq: stamp,
            },
        );
        if seen.len() > MAX_TRACKED_SESSIONS {
            if let Some(oldest) = seen
                .iter()
                .min_by_key(|(_, entry)| entry.seq)
                .map(|(key, _)| key.clone())
            {
                seen.remove(&oldest);
            }
        }
        false
    }

    /// Forget every session. Used by the kill switch, where the next run must
    /// start from a frame the model can actually see.
    pub fn clear(&self) {
        self.seen.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::session::{
        CoordinateSpace, ResolvedApplication, UiStateRevision, UiSurface, UiTreeProjection,
        UiTreeProjectionKind,
    };
    use crate::automation::types::{ImageFormat, Rect, Screenshot};

    fn revision(session: &str, rev: u64, bytes: &str) -> UiStateRevision {
        UiStateRevision {
            session_id: session.into(),
            lineage_id: "lineage".into(),
            revision: rev,
            turn_token: "token".into(),
            app: ResolvedApplication {
                bundle_id: None,
                path: None,
                display_name: "Notes".into(),
                process_id: 1,
            },
            surface: UiSurface {
                window_id: None,
                display_id: None,
                logical_bounds: Rect {
                    x: 0,
                    y: 0,
                    width: 1280,
                    height: 800,
                },
                pixel_width: 1280,
                pixel_height: 800,
                scale_factor: 1.0,
                coordinate_space: CoordinateSpace::ScreenshotPixels,
            },
            screenshot: Some(Screenshot {
                bytes: bytes.into(),
                width: 1280,
                height: 800,
                captured_at: 0,
                format: ImageFormat::Png,
                source_width: None,
                source_height: None,
            }),
            projection: UiTreeProjectionKind::Model,
            tree: UiTreeProjection {
                nodes: Vec::new(),
                total_nodes: 0,
                truncated: false,
            },
            diff: None,
            truncation: Vec::new(),
            instruction_pack: None,
            captured_at: 0,
            screenshot_unchanged: false,
            screenshot_note: None,
        }
    }

    #[test]
    fn first_frame_is_always_sent() {
        let dedup = ScreenshotDedup::default();
        let mut first = revision("s1", 1, "AAAA");
        assert!(!dedup.apply(&mut first, true, Surface::ComputerUse));
        assert_eq!(first.screenshot.as_ref().unwrap().bytes, "AAAA");
        assert!(!first.screenshot_unchanged);
    }

    #[test]
    fn identical_second_frame_is_withheld_with_a_note() {
        let dedup = ScreenshotDedup::default();
        let mut first = revision("s1", 7, "AAAA");
        dedup.apply(&mut first, true, Surface::ComputerUse);

        let mut second = revision("s1", 8, "AAAA");
        assert!(dedup.apply(&mut second, true, Surface::ComputerUse));
        let shot = second.screenshot.as_ref().expect("dimensions must survive");
        assert!(shot.bytes.is_empty());
        // Pixel targeting still needs the frame's size.
        assert_eq!(shot.width, 1280);
        assert_eq!(shot.height, 800);
        assert!(second.screenshot_unchanged);
        assert!(second.screenshot_note.unwrap().contains("revision 7"));
    }

    #[test]
    fn a_run_of_identical_frames_keeps_naming_the_frame_the_model_holds() {
        let dedup = ScreenshotDedup::default();
        let mut first = revision("s1", 3, "AAAA");
        dedup.apply(&mut first, true, Surface::ComputerUse);
        for rev in 4..8 {
            let mut next = revision("s1", rev, "AAAA");
            assert!(dedup.apply(&mut next, true, Surface::ComputerUse));
            assert!(next.screenshot_note.unwrap().contains("revision 3"));
        }
    }

    #[test]
    fn a_changed_frame_is_sent_and_becomes_the_new_baseline() {
        let dedup = ScreenshotDedup::default();
        let mut first = revision("s1", 1, "AAAA");
        dedup.apply(&mut first, true, Surface::ComputerUse);
        let mut changed = revision("s1", 2, "BBBB");
        assert!(!dedup.apply(&mut changed, true, Surface::ComputerUse));
        assert_eq!(changed.screenshot.as_ref().unwrap().bytes, "BBBB");

        let mut repeat = revision("s1", 3, "BBBB");
        assert!(dedup.apply(&mut repeat, true, Surface::ComputerUse));
        assert!(repeat.screenshot_note.unwrap().contains("revision 2"));
    }

    #[test]
    fn sessions_do_not_share_a_baseline() {
        let dedup = ScreenshotDedup::default();
        let mut a = revision("s1", 1, "AAAA");
        dedup.apply(&mut a, true, Surface::ComputerUse);
        let mut b = revision("s2", 1, "AAAA");
        assert!(!dedup.apply(&mut b, true, Surface::ComputerUse));
        assert_eq!(b.screenshot.as_ref().unwrap().bytes, "AAAA");
    }

    #[test]
    fn the_setting_off_sends_every_frame() {
        let dedup = ScreenshotDedup::default();
        let mut first = revision("s1", 1, "AAAA");
        dedup.apply(&mut first, false, Surface::ComputerUse);
        let mut second = revision("s1", 2, "AAAA");
        assert!(!dedup.apply(&mut second, false, Surface::ComputerUse));
        assert_eq!(second.screenshot.as_ref().unwrap().bytes, "AAAA");
    }

    #[test]
    fn the_human_facing_inspector_keeps_every_frame() {
        // Settings → Automation → Inspector reads app state over
        // `Surface::Workflow` and renders the frame; blanking it would show a
        // human an empty preview.
        let dedup = ScreenshotDedup::default();
        let mut first = revision("settings:automation-inspector", 1, "AAAA");
        dedup.apply(&mut first, true, Surface::Workflow);
        let mut second = revision("settings:automation-inspector", 2, "AAAA");
        assert!(!dedup.apply(&mut second, true, Surface::Workflow));
        assert_eq!(second.screenshot.as_ref().unwrap().bytes, "AAAA");
    }

    #[test]
    fn clearing_sends_the_next_frame_whole() {
        // The kill switch calls this: whatever runs next has not seen the
        // screen, so it must get a real image rather than a back-reference.
        let dedup = ScreenshotDedup::default();
        let mut first = revision("s1", 1, "AAAA");
        dedup.apply(&mut first, true, Surface::ComputerUse);
        dedup.clear();
        let mut second = revision("s1", 2, "AAAA");
        assert!(!dedup.apply(&mut second, true, Surface::ComputerUse));
        assert_eq!(second.screenshot.as_ref().unwrap().bytes, "AAAA");
    }

    #[test]
    fn tracking_is_capped_and_evicts_the_oldest_session() {
        let dedup = ScreenshotDedup::default();
        for i in 0..(MAX_TRACKED_SESSIONS + 1) {
            let mut rev = revision(&format!("s{i}"), 1, "AAAA");
            dedup.apply(&mut rev, true, Surface::ComputerUse);
        }
        assert_eq!(dedup.seen.lock().len(), MAX_TRACKED_SESSIONS);
        // The first session was evicted, so its next frame is sent whole.
        let mut again = revision("s0", 2, "AAAA");
        assert!(!dedup.apply(&mut again, true, Surface::ComputerUse));
        // A recent one is still deduped.
        let mut recent = revision(&format!("s{MAX_TRACKED_SESSIONS}"), 2, "AAAA");
        assert!(dedup.apply(&mut recent, true, Surface::ComputerUse));
    }

    #[test]
    fn a_missing_or_empty_frame_is_left_alone() {
        let dedup = ScreenshotDedup::default();
        let mut none = revision("s1", 1, "AAAA");
        none.screenshot = None;
        assert!(!dedup.apply(&mut none, true, Surface::ComputerUse));

        let mut empty = revision("s1", 2, "");
        assert!(!dedup.apply(&mut empty, true, Surface::ComputerUse));
        assert!(!empty.screenshot_unchanged);
    }
}
