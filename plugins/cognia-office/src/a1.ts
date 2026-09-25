/**
 * A1-notation helpers (`B4`, `A1:C3`, column `AA`) with SheetJS-compatible
 * results for valid input. The workbook model needs them synchronously on
 * every operation; importing SheetJS for four string conversions pulled the
 * whole spreadsheet engine into plugin activation, so they live here and the
 * engines (`xlsx`, `exceljs`, `jszip`) load only when a file is read/written.
 *
 * Unlike SheetJS, malformed input throws instead of decoding to negative
 * coordinates, so callers validate with a try/catch.
 */

export interface CellAddress {
  /** 0-based row. */
  r: number
  /** 0-based column. */
  c: number
}

export interface RangeAddress {
  s: CellAddress
  e: CellAddress
}

const CELL_PATTERN = /^\$?([A-Z]+)\$?([0-9]+)$/

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function encodeColumn(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`invalid column index: ${index}`)
  let value = index + 1
  let result = ""
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

/** "A" → 0, "AA" → 26; an optional leading `$` is ignored. */
export function decodeColumn(letters: string): number {
  const clean = letters.replace(/^\$/, "")
  if (!/^[A-Z]+$/.test(clean)) throw new Error(`invalid column: ${letters}`)
  let value = 0
  for (const char of clean) value = value * 26 + (char.charCodeAt(0) - 64)
  return value - 1
}

export function encodeCell(address: CellAddress): string {
  if (!Number.isInteger(address.r) || address.r < 0)
    throw new Error(`invalid row index: ${address.r}`)
  return `${encodeColumn(address.c)}${address.r + 1}`
}

export function decodeCell(ref: string): CellAddress {
  const match = CELL_PATTERN.exec(ref)
  if (!match) throw new Error(`invalid cell reference: ${ref}`)
  return { r: Number.parseInt(match[2], 10) - 1, c: decodeColumn(match[1]) }
}

/** "A1:C3" → start/end; a single cell "B2" is a one-cell range. */
export function decodeRange(ref: string): RangeAddress {
  const parts = ref.split(":")
  if (parts.length > 2) throw new Error(`invalid range: ${ref}`)
  const s = decodeCell(parts[0])
  const e = parts.length === 2 ? decodeCell(parts[1]) : { ...s }
  return { s, e }
}

/** A one-cell range collapses to the cell ref, matching SheetJS. */
export function encodeRange(range: RangeAddress): string {
  const start = encodeCell(range.s)
  const end = encodeCell(range.e)
  return start === end ? start : `${start}:${end}`
}
