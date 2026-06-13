/**
 * A pure state machine that splits a raw terminal stdin stream into ordinary
 * keystrokes and bracketed-paste spans. Terminals wrap a paste in the markers
 * `ESC [200~` … `ESC [201~`; without reassembly the body would arrive
 * character-by-character. `createPasteParser` reassembles each span so a paste
 * surfaces atomically, even when a marker is split across `feed` calls.
 */

/** The bytes a terminal emits immediately before a bracketed paste body. */
const START = "\x1b[200~"
/** The bytes a terminal emits immediately after a bracketed paste body. */
const END = "\x1b[201~"

/** Result of feeding one raw stdin chunk to the parser. */
export interface FeedResult {
  /** Ordinary keystrokes seen outside any paste, in order. */
  keys: string
  /** Fully-reassembled paste bodies completed during this feed, in order. */
  pastes: string[]
}

/** Incremental parser splitting raw stdin into keys and bracketed pastes. */
export interface PasteParser {
  /** Feed one raw chunk; returns the keys and any completed pastes it yielded. */
  feed(chunk: string): FeedResult
}

/** True when `s` is a proper prefix of `marker` (and therefore still ambiguous). */
function isPrefixOf(s: string, marker: string): boolean {
  return s.length < marker.length && marker.startsWith(s)
}

/**
 * Create a bracketed-paste parser.
 *
 * The parser keeps an internal `tail` of trailing bytes that could still be the
 * start of a marker, so a marker straddling a chunk boundary is never lost. In
 * `"keys"` mode it watches for {@link START}; in `"paste"` mode it accumulates
 * the body and watches for {@link END}.
 */
export function createPasteParser(): PasteParser {
  let mode: "keys" | "paste" = "keys"
  let pasteBuf = ""
  /** Unresolved trailing bytes that may be a partial marker. */
  let tail = ""

  return {
    feed(chunk: string): FeedResult {
      let keys = ""
      const pastes: string[] = []
      let buf = tail + chunk
      tail = ""

      while (buf.length > 0) {
        const marker = mode === "keys" ? START : END
        const idx = buf.indexOf(marker)

        if (idx >= 0) {
          // A complete marker is present: emit everything before it, then flip.
          const before = buf.slice(0, idx)
          if (mode === "keys") keys += before
          else pasteBuf += before
          buf = buf.slice(idx + marker.length)
          if (mode === "keys") {
            mode = "paste"
            pasteBuf = ""
          } else {
            mode = "keys"
            pastes.push(pasteBuf)
            pasteBuf = ""
          }
          continue
        }

        // No complete marker. Find the longest suffix of `buf` that is still a
        // proper prefix of the marker we are waiting for, and hold it as tail.
        let hold = 0
        for (let len = Math.min(marker.length - 1, buf.length); len > 0; len--) {
          if (isPrefixOf(buf.slice(buf.length - len), marker)) {
            hold = len
            break
          }
        }
        const emit = buf.slice(0, buf.length - hold)
        if (mode === "keys") keys += emit
        else pasteBuf += emit
        tail = buf.slice(buf.length - hold)
        buf = ""
      }

      return { keys, pastes }
    },
  }
}
