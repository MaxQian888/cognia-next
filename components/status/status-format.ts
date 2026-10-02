/**
 * Date and number formatting for the public status page.
 *
 * Timestamps in the contract are UTC. History periods and maintenance windows
 * are shown in UTC (their boundaries are UTC-aligned), with the reader's
 * local time added where planning matters.
 */

import { parseIsoMs, type HistoryBucket, type HistoryRange } from "@/lib/status/public-status"

function toDate(iso: string): Date | null {
  const ms = parseIsoMs(iso)
  return ms === null ? null : new Date(ms)
}

/** `Oct 2, 2026, 10:00 UTC` */
export function formatUtcDateTime(iso: string, locale: string): string {
  const date = toDate(iso)
  if (!date) return iso
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date)
}

/** The same instant in the reader's own time zone. */
export function formatLocalDateTime(iso: string, locale: string, timeZone?: string): string {
  const date = toDate(iso)
  if (!date) return iso
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).format(date)
}

/** `Oct 2, 2026, 10:00` in UTC, without the zone label (for "… UTC" templates). */
export function formatUtcDateTimeBare(iso: string, locale: string): string {
  const date = toDate(iso)
  if (!date) return iso
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date)
}

export function formatUtcDate(iso: string, locale: string): string {
  const date = toDate(iso)
  if (!date) return iso
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date)
}

function formatUtcHour(iso: string, locale: string): string {
  const date = toDate(iso)
  if (!date) return iso
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date)
}

/**
 * The period one history cell covers: an hour for the 24 h range, a UTC day
 * otherwise. Always labelled UTC because bucket boundaries are UTC.
 */
export function formatBucketPeriod(
  bucket: Pick<HistoryBucket, "start" | "end">,
  range: HistoryRange,
  locale: string
): string {
  if (range === "24h") {
    return `${formatUtcDate(bucket.start, locale)} ${formatUtcHour(bucket.start, locale)}–${formatUtcHour(bucket.end, locale)} UTC`
  }
  return `${formatUtcDate(bucket.start, locale)} UTC`
}

/** Snapshot age as the hero sentence needs it. */
export function ageParts(ageMs: number): { unit: "seconds" | "minutes" | "hours"; count: number } {
  if (ageMs < 60_000) return { unit: "seconds", count: Math.max(0, Math.floor(ageMs / 1000)) }
  if (ageMs < 3_600_000) return { unit: "minutes", count: Math.floor(ageMs / 60_000) }
  return { unit: "hours", count: Math.floor(ageMs / 3_600_000) }
}

/** "A, B and C" in the reader's language. */
export function formatList(items: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items)
}
