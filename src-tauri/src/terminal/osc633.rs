//! OSC 633 shell-integration sequence parser.
//!
//! VS Code defines an `ESC ] 633 ; <C> ; <args> BEL` family that integration
//! scripts emit at prompt boundaries, command pre/post-exec, and cwd
//! changes. We stream PTY output through `Osc633Parser::feed`, which:
//!   * yields the raw bytes back unchanged (the terminal still needs them
//!     in its scrollback for fonts/colors/etc.), and
//!   * surfaces a typed `IntegrationEvent` whenever a complete sequence is
//!     recognised.
//!
//! The parser validates the per-spawn nonce stamped in `$COGNIA_TERM_NONCE`
//! so a hostile process inside the terminal can't fabricate prompt
//! decorations by writing its own OSC 633 sequences.

use serde::{Deserialize, Serialize};

/// Decoded OSC 633 events emitted by the integration scripts.
///
/// The shape mirrors the subset of VS Code's OSC 633 protocol we actually
/// consume. Sequences we don't recognise are dropped (with the raw bytes
/// still passing through so the terminal sees them).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IntegrationEvent {
    /// `ESC ] 633 ; A ; <nonce> BEL` — prompt start.
    PromptStart,
    /// `ESC ] 633 ; B ; <nonce> BEL` — prompt end / command-line start.
    PromptEnd,
    /// `ESC ] 633 ; C ; <nonce> BEL` — command pre-exec (user pressed enter).
    CommandStart,
    /// `ESC ] 633 ; D ; <nonce> [; <exit-code>] BEL` — command finished.
    CommandEnd { exit_code: Option<i32> },
    /// `ESC ] 633 ; P ; <nonce> ; Cwd=<path> BEL`.
    CwdChanged { cwd: String },
}

const ESC: u8 = 0x1B;
const BEL: u8 = 0x07;
/// The `\` half of an `ESC \` String Terminator (ST).
const ST_TAIL: u8 = 0x5C;

#[derive(Debug, PartialEq, Eq)]
enum State {
    Normal,
    /// Saw ESC. The next byte determines whether this is the start of an
    /// OSC (`]`) or some unrelated escape (e.g. CSI).
    Esc,
    /// Inside the OSC introducer — accumulating up to `633;` before we
    /// commit to capturing the body. If we don't see `633;` we discard
    /// the partial buffer and resume Normal.
    OscIntro(Vec<u8>),
    /// Inside the body of an `ESC ] 633 ;` sequence — collect bytes until
    /// BEL or ST. The byte cap is enforced here so a runaway sequence
    /// can't pin memory.
    Body(Vec<u8>),
    /// Saw ESC while in Body — next byte determines ST (`\\`) or false
    /// alarm.
    BodyEsc(Vec<u8>),
}

/// Streaming parser. One instance per PTY session. `feed` is the only
/// entry point; events are returned in arrival order.
pub struct Osc633Parser {
    state: State,
    /// Per-spawn nonce required in every sequence. Sequences whose nonce
    /// doesn't match are dropped silently.
    nonce: String,
    /// Hard cap on the body buffer (bytes). 4 KiB is generous — the
    /// longest legitimate sequence is `P;Cwd=<path>` which fits.
    body_cap: usize,
}

impl Osc633Parser {
    pub fn new(nonce: impl Into<String>) -> Self {
        Self {
            state: State::Normal,
            nonce: nonce.into(),
            body_cap: 4096,
        }
    }

    /// Push a chunk of PTY output. Returns the events recognised in this
    /// chunk (zero or more). Bytes are not buffered for the caller — the
    /// caller still owns the raw chunk for forwarding to xterm.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<IntegrationEvent> {
        let mut events = Vec::new();
        for &byte in chunk {
            self.step(byte, &mut events);
        }
        events
    }

    fn step(&mut self, byte: u8, events: &mut Vec<IntegrationEvent>) {
        // Take the state by replacing with Normal — every branch decides
        // explicitly what to put back.
        let prev = std::mem::replace(&mut self.state, State::Normal);
        match prev {
            State::Normal => {
                if byte == ESC {
                    self.state = State::Esc;
                }
            }
            State::Esc => {
                if byte == b']' {
                    self.state = State::OscIntro(Vec::with_capacity(4));
                } else if byte == ESC {
                    self.state = State::Esc;
                }
                // anything else (e.g. CSI `[`, charset designators) → drop
                // back to Normal silently. We already consumed the ESC and
                // the next byte; this is fine because we don't try to
                // interpret non-OSC escapes here.
            }
            State::OscIntro(mut buf) => {
                buf.push(byte);
                // Wait until we have `633;` (4 bytes) — too few → keep
                // accumulating; doesn't match → drop.
                if buf.len() < 4 {
                    self.state = State::OscIntro(buf);
                } else if buf.starts_with(b"633;") {
                    self.state = State::Body(Vec::with_capacity(32));
                }
                // Otherwise: not our OSC — fall through to Normal.
                // (Don't try to skip ahead to the terminator: we'd risk
                // mis-interpreting bytes mid-escape from some other
                // sequence. Letting Normal pick up here is correct enough
                // for our needs since this code never claims to be a full
                // ANSI parser.)
            }
            State::Body(mut buf) => {
                if byte == BEL {
                    self.commit(&buf, events);
                } else if byte == ESC {
                    self.state = State::BodyEsc(buf);
                } else if buf.len() < self.body_cap {
                    buf.push(byte);
                    self.state = State::Body(buf);
                }
                // overflow → drop the sequence silently (we're back in
                // Normal because of the replace above)
            }
            State::BodyEsc(mut buf) => {
                if byte == ST_TAIL {
                    self.commit(&buf, events);
                } else {
                    // false alarm — stay in Body if we still have room.
                    if byte == ESC {
                        self.state = State::BodyEsc(buf);
                    } else if buf.len() + 1 < self.body_cap {
                        // The previous ESC was data after all; preserve it
                        // so cwd paths containing literal ESC bytes — rare
                        // but legal — still parse.
                        buf.push(ESC);
                        buf.push(byte);
                        self.state = State::Body(buf);
                    }
                }
            }
        }
    }

    fn commit(&self, body: &[u8], events: &mut Vec<IntegrationEvent>) {
        let Ok(text) = std::str::from_utf8(body) else {
            return;
        };
        let mut parts = text.split(';');
        let Some(cmd) = parts.next() else {
            return;
        };
        let Some(nonce) = parts.next() else {
            return;
        };
        if nonce != self.nonce {
            return;
        }
        match cmd {
            "A" => events.push(IntegrationEvent::PromptStart),
            "B" => events.push(IntegrationEvent::PromptEnd),
            "C" => events.push(IntegrationEvent::CommandStart),
            "D" => {
                let exit_code = parts.next().and_then(|s| s.parse::<i32>().ok());
                events.push(IntegrationEvent::CommandEnd { exit_code });
            }
            "P" => {
                if let Some(kv) = parts.next() {
                    if let Some(cwd) = kv.strip_prefix("Cwd=") {
                        events.push(IntegrationEvent::CwdChanged {
                            cwd: cwd.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nonce_seq(cmd: &str, nonce: &str) -> Vec<u8> {
        let mut v = vec![ESC, b']'];
        v.extend_from_slice(b"633;");
        v.extend_from_slice(cmd.as_bytes());
        v.push(b';');
        v.extend_from_slice(nonce.as_bytes());
        v.push(BEL);
        v
    }

    #[test]
    fn recognises_prompt_start() {
        let mut p = Osc633Parser::new("abc");
        let events = p.feed(&nonce_seq("A", "abc"));
        assert_eq!(events, vec![IntegrationEvent::PromptStart]);
    }

    #[test]
    fn recognises_all_simple_commands() {
        let mut p = Osc633Parser::new("nn");
        let mut buf = Vec::new();
        buf.extend(nonce_seq("A", "nn"));
        buf.extend(nonce_seq("B", "nn"));
        buf.extend(nonce_seq("C", "nn"));
        let events = p.feed(&buf);
        assert_eq!(
            events,
            vec![
                IntegrationEvent::PromptStart,
                IntegrationEvent::PromptEnd,
                IntegrationEvent::CommandStart,
            ]
        );
    }

    #[test]
    fn command_end_carries_exit_code() {
        let mut p = Osc633Parser::new("k");
        let mut buf = vec![ESC, b']'];
        buf.extend_from_slice(b"633;D;k;1");
        buf.push(BEL);
        assert_eq!(
            p.feed(&buf),
            vec![IntegrationEvent::CommandEnd { exit_code: Some(1) }]
        );
    }

    #[test]
    fn command_end_without_exit_code() {
        let mut p = Osc633Parser::new("k");
        let buf = nonce_seq("D", "k");
        assert_eq!(
            p.feed(&buf),
            vec![IntegrationEvent::CommandEnd { exit_code: None }]
        );
    }

    #[test]
    fn cwd_changed_parses_path() {
        let mut p = Osc633Parser::new("k");
        let mut buf = vec![ESC, b']'];
        buf.extend_from_slice(b"633;P;k;Cwd=/tmp/foo");
        buf.push(BEL);
        assert_eq!(
            p.feed(&buf),
            vec![IntegrationEvent::CwdChanged {
                cwd: "/tmp/foo".to_string()
            }]
        );
    }

    #[test]
    fn nonce_mismatch_drops_sequence() {
        let mut p = Osc633Parser::new("real");
        let events = p.feed(&nonce_seq("A", "spoofed"));
        assert!(events.is_empty());
    }

    #[test]
    fn st_terminator_works() {
        let mut p = Osc633Parser::new("k");
        let mut buf = vec![ESC, b']'];
        buf.extend_from_slice(b"633;A;k");
        buf.extend_from_slice(&[ESC, ST_TAIL]);
        assert_eq!(p.feed(&buf), vec![IntegrationEvent::PromptStart]);
    }

    #[test]
    fn handles_chunk_boundary_inside_sequence() {
        let mut p = Osc633Parser::new("k");
        // Split a `D;k;0` sequence across two feed calls.
        let mut first = vec![ESC, b']'];
        first.extend_from_slice(b"633;D");
        let first_events = p.feed(&first);
        assert!(first_events.is_empty());

        let mut second = Vec::new();
        second.extend_from_slice(b";k;0");
        second.push(BEL);
        let second_events = p.feed(&second);
        assert_eq!(
            second_events,
            vec![IntegrationEvent::CommandEnd { exit_code: Some(0) }]
        );
    }

    #[test]
    fn passes_through_unrelated_escapes() {
        // CSI sequence — not OSC, should produce no events and not break
        // a subsequent legitimate 633 sequence.
        let mut p = Osc633Parser::new("k");
        let mut buf = vec![ESC, b'[', b'3', b'1', b'm']; // SGR red
        buf.extend_from_slice(&nonce_seq("A", "k"));
        assert_eq!(p.feed(&buf), vec![IntegrationEvent::PromptStart]);
    }

    #[test]
    fn passes_through_unknown_osc() {
        // `ESC ] 9 ; foo BEL` (iTerm's growl notification OSC).
        let mut p = Osc633Parser::new("k");
        let mut buf = vec![ESC, b']'];
        buf.extend_from_slice(b"9;foo");
        buf.push(BEL);
        buf.extend_from_slice(&nonce_seq("A", "k"));
        assert_eq!(p.feed(&buf), vec![IntegrationEvent::PromptStart]);
    }

    #[test]
    fn body_overflow_drops_sequence_safely() {
        let mut p = Osc633Parser::new("k");
        p.body_cap = 8;
        let mut buf = vec![ESC, b']'];
        buf.extend_from_slice(b"633;P;k;Cwd=/a/long/path");
        buf.push(BEL);
        // Overflowed body → no event, and parser returns to Normal so a
        // subsequent valid sequence still works.
        assert!(p.feed(&buf).is_empty());
        let events = p.feed(&nonce_seq("A", "k"));
        assert_eq!(events, vec![IntegrationEvent::PromptStart]);
    }

    #[test]
    fn empty_nonce_means_no_sequence_is_accepted() {
        let mut p = Osc633Parser::new("");
        let buf = nonce_seq("A", "anything");
        assert!(p.feed(&buf).is_empty());
        // But the empty-nonce sequence (literal `A;`) parses.
        let mut explicit_empty = vec![ESC, b']'];
        explicit_empty.extend_from_slice(b"633;A;");
        explicit_empty.push(BEL);
        assert_eq!(p.feed(&explicit_empty), vec![IntegrationEvent::PromptStart]);
    }

    #[test]
    fn unknown_command_letter_is_ignored() {
        let mut p = Osc633Parser::new("k");
        let buf = nonce_seq("Z", "k");
        assert!(p.feed(&buf).is_empty());
    }
}
