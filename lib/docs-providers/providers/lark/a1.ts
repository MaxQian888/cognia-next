/**
 * A1-notation helpers for the Feishu sheets v2 values endpoint, which takes a
 * `<sheetId>!A1:<col><row>` range string rather than numeric bounds.
 */

/**
 * 1-based column index → spreadsheet column letters (1 → `A`, 27 → `AA`).
 *
 * Bijective base-26: there is no zero digit, so the usual `% 26` needs the
 * off-by-one correction below or column 26 renders as `A@`.
 */
export function columnLetters(index: number): string {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`column index must be a positive integer, got ${index}`)
  }
  let out = ""
  let remaining = index
  while (remaining > 0) {
    const digit = (remaining - 1) % 26
    out = String.fromCharCode(65 + digit) + out
    remaining = Math.floor((remaining - 1) / 26)
  }
  return out
}

/** Build the `<sheetId>!A1:<col><row>` range Lark's v2 values API expects. */
export function sheetRange(sheetId: string, rows: number, cols: number): string {
  return `${sheetId}!A1:${columnLetters(Math.max(1, cols))}${Math.max(1, rows)}`
}
