/**
 * Truncation caps for remote document bodies, and the marker every provider
 * appends when it hits one.
 *
 * These exist because a Bitable app can hold hundreds of thousands of records
 * and a spreadsheet can hold a million cells — inlining that into a prompt is
 * neither useful nor affordable. But truncating SILENTLY is worse than
 * refusing: the model would answer confidently from a body missing its tail.
 * So every cap is paired with `RemoteDocContent.truncated` AND a visible
 * in-body marker the model can read.
 *
 * The composer's own ceiling (`INLINE_TOKEN_CEILING`, 12k tokens, in
 * `lib/chat/attachments/dispatch.ts`) still applies on top of these and asks
 * the user to confirm; these caps only bound what we transfer in the first
 * place.
 */

/** Rows read per worksheet (Feishu sheets, Google Sheets). */
export const MAX_SHEET_ROWS = 500

/** Worksheets read per spreadsheet. */
export const MAX_SHEET_TABS = 10

/** Columns read per worksheet — bounds the A1 range we ask Lark/Google for. */
export const MAX_SHEET_COLS = 50

/** Tables read per Feishu Bitable app. */
export const MAX_BITABLE_TABLES = 5

/** Records read per Bitable table. */
export const MAX_BITABLE_ROWS = 200

/** Characters kept from a document body. ~50 KB ≈ the composer's soft ceiling. */
export const MAX_DOC_CHARS = 200_000

/**
 * Build the marker appended to a truncated body.
 *
 * Written in English on purpose: it is model-facing content, not UI copy, and
 * lands inside the prompt alongside the document text.
 */
export function truncationMarker(what: string, kept: number, unit: string): string {
  return `\n\n[Truncated by Cognia: only the first ${kept} ${unit} of ${what} were read. Ask the user for the full document if you need the rest.]`
}

/**
 * Clamp `text` to {@link MAX_DOC_CHARS}, appending a marker when it had to cut.
 * Returns the flag so the caller can set `RemoteDocContent.truncated`.
 */
export function clampDocText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOC_CHARS) return { text, truncated: false }
  return {
    text:
      text.slice(0, MAX_DOC_CHARS) + truncationMarker("this document", MAX_DOC_CHARS, "characters"),
    truncated: true,
  }
}
