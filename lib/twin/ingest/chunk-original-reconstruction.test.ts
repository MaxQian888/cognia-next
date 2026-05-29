/**
 * Regression coverage for T1.1 — the ingest job-runner used to recover a
 * chunk's displayable original via `parsed.originalText.slice(charStart, charEnd)`.
 * Those offsets index the *redacted* text (placeholders are a different length
 * than the originals), so every offset after the first redaction in a chunk is
 * shifted and the stored "original" is corrupted.
 *
 * The fix reconstructs the original by un-redacting the redacted chunk through
 * the redaction map, which is exact regardless of length changes. This test
 * pins that property and demonstrates the naive slice is wrong.
 */

import { redactText, unredactText } from "./redact"
import { prepareChunks } from "./chunk"

describe("chunk original reconstruction (T1.1)", () => {
  it("un-redacting a redacted slice recovers the original exactly", () => {
    const original =
      "Reach alice@example.com now. Some filler text to push the offset along. " +
      "Also contact bob@example.com here at the end."
    const { redacted, map } = redactText(original)

    // Placeholders are shorter than the emails they replace, so the redacted
    // text is strictly shorter than the source — this is what shifts offsets.
    expect(redacted.length).toBeLessThan(original.length)

    // The job-runner stores `content = unredactText(redactedChunk, map)`.
    // For the whole-text case the redacted "chunk" is the full redacted string.
    expect(unredactText(redacted, map)).toBe(original)

    // The old behaviour sliced originalText with redacted-coordinate offsets,
    // which truncates / mis-aligns once a placeholder has shifted positions:
    // the slice is strictly shorter than the source and loses the tail.
    const naive = original.slice(0, redacted.length)
    expect(naive).not.toBe(original)
    expect(naive.length).toBeLessThan(original.length) // the tail is lost
  })

  it("reconstructs every prepared chunk back to a verbatim source substring", () => {
    const original =
      "First, email alice@example.com.\n\n" +
      "Second paragraph with no PII at all, just plain prose to chunk.\n\n" +
      "Third, ping bob@example.com about the rollout."
    const { redacted, map } = redactText(original)

    const chunks = prepareChunks({
      redactedText: redacted,
      originalText: original,
      format: "markdown",
    })
    expect(chunks.length).toBeGreaterThan(0)

    for (const c of chunks) {
      const reconstructed = unredactText(c.content, map)
      // Every reconstructed chunk is verbatim source text (placeholders are not
      // split across chunk boundaries by the paragraph/heading chunker here).
      expect(original).toContain(reconstructed)
    }

    const joined = chunks.map((c) => unredactText(c.content, map)).join("\n")
    expect(joined).toContain("alice@example.com")
    expect(joined).toContain("bob@example.com")
  })

  it("is identity reconstruction when there is no PII", () => {
    const original = "Just a plain paragraph with no sensitive data whatsoever."
    const { redacted, map } = redactText(original)
    expect(redacted).toBe(original)
    expect(unredactText(redacted, map)).toBe(original)
  })
})
