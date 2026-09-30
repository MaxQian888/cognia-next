/**
 * Excel date serials in the default 1900 date system (serial 1 = 1900-01-01,
 * epoch 1899-12-30, matching SheetJS). A workbook stores a date cell as an ISO
 * string and reads it in local time, so a serial is the local calendar date
 * and clock time — the preview formats with it and the formula evaluator
 * computes with it, and both must agree on the conversion.
 */

const EPOCH_UTC = Date.UTC(1899, 11, 30)
const DAY_MS = 86_400_000

/** The serial of `date`'s local date and time. */
export function dateToSerial(date: Date): number {
  return (date.getTime() - date.getTimezoneOffset() * 60_000 - EPOCH_UTC) / DAY_MS
}

/** The local-time Date a serial names; the inverse of `dateToSerial`. */
export function serialToDate(serial: number): Date {
  const utc = new Date(EPOCH_UTC + Math.round(serial * DAY_MS))
  return new Date(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
    utc.getUTCHours(),
    utc.getUTCMinutes(),
    utc.getUTCSeconds(),
    utc.getUTCMilliseconds()
  )
}
