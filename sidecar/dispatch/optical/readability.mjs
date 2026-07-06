// Round-trip readability scoring for the optical renderer (ADR-0063 ext 2).
//
// After rendering a frame we ask a vision model to transcribe it, then score
// how much of the original text came back. A low score means the shape (font,
// cell size, provider) did not survive the model's OCR — the orchestrator then
// discards the frame and falls back to the text-summary path, so optical
// compaction never silently drops context to an unreadable image.

/** Lowercased alphanumeric word tokens (Unicode aware). */
function tokenize(s) {
  const out = []
  for (const m of String(s ?? "")
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+/gu)) {
    out.push(m[0])
  }
  return out
}

/**
 * Multiset word-recall of `original` recovered in `transcribed` (0..1). Recall
 * (not F1) is the right measure here: we care whether the model recovered the
 * archived content, not whether it added extra words.
 * @returns {number}
 */
export function readabilityScore(original, transcribed) {
  const orig = tokenize(original)
  if (orig.length === 0) return String(transcribed ?? "").trim() === "" ? 1 : 0
  const counts = new Map()
  for (const w of tokenize(transcribed)) counts.set(w, (counts.get(w) ?? 0) + 1)
  let hit = 0
  for (const w of orig) {
    const c = counts.get(w) ?? 0
    if (c > 0) {
      hit += 1
      counts.set(w, c - 1)
    }
  }
  return hit / orig.length
}

/**
 * Convenience wrapper: `{ score, ok }` where `ok` means the frame is readable
 * enough to keep. Default threshold 0.6 (recover ≥60% of the words).
 */
export function checkReadability(original, transcribed, threshold = 0.6) {
  const score = readabilityScore(original, transcribed)
  return { score, ok: score >= threshold }
}
