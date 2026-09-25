/**
 * Cut text to a UTF-8 byte ceiling without splitting a codepoint.
 *
 * One implementation for both ends of the Browser Companion contract. The side
 * panel clips a capture before the user reviews it and the Host clips an answer
 * before it goes back, and both are denominated in the same unit for the same
 * reason: a CJK page hits a byte limit at roughly a third of the character
 * count, so a character cap silently means something different per language.
 *
 * The extension used to carry its own loop, which stepped back by UTF-16 code
 * units and could land between the two halves of a surrogate pair — leaving an
 * unpaired high surrogate that every UTF-8 encoder turns into U+FFFD, in text
 * the user had just approved as "what will be sent". Sharing the Host's version
 * is what keeps the two from drifting apart again.
 */
import { utf8ByteLength } from "./base64url"

/** Text that may have been cut, and says so. */
export interface ClippedText {
  text: string
  /** Whether {@link text} is shorter than the input. */
  truncated: boolean
}

/**
 * The longest prefix of `value` whose UTF-8 encoding fits in `limitBytes`, and
 * whether anything was dropped.
 *
 * A binary search over code-unit offsets, then one step back off a lone high
 * surrogate. Logarithmic rather than a walk that re-measures the prefix on
 * every step, which on a 128 KiB CJK page meant dozens of full encodings.
 *
 * A non-positive or non-finite limit clips to nothing rather than throwing: a
 * ceiling is a courtesy the Host re-checks, and the caller asking for zero
 * bytes has been told exactly what it asked for.
 */
export function clipToBytes(value: string, limitBytes: number): ClippedText {
  const limit = Number.isFinite(limitBytes) ? Math.max(0, Math.floor(limitBytes)) : 0
  if (utf8ByteLength(value) <= limit) return { text: value, truncated: false }
  // Largest code-unit count whose UTF-8 encoding still fits.
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (utf8ByteLength(value.slice(0, mid)) <= limit) low = mid
    else high = mid - 1
  }
  // `low` may sit between a surrogate pair. Backing off one unit is always
  // enough: a pair is exactly two units, and dropping the high surrogate can
  // only shrink the encoding.
  const cut = low > 0 && isHighSurrogate(value.charCodeAt(low - 1)) ? low - 1 : low
  return { text: value.slice(0, cut), truncated: true }
}

/** A UTF-16 leading surrogate — the first half of an astral codepoint. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}
