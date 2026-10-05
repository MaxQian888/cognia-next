/**
 * Hybrid logical clocks (protocol §9). Every synced field carries the clock
 * of the write that set it; merge keeps the greater `(ms, c, deviceId)`.
 *
 * Encoded as `ms` in 12 hex digits, `c` in 4, then the device id, so plain
 * string order is clock order and the encoding is what goes on the wire and
 * into `syncFieldClocks`.
 */

import { isDeviceId } from "./ids"

export interface HlcTime {
  /** Wall-clock milliseconds, at most 48 bits. */
  ms: number
  /** Logical counter for writes within one millisecond, at most 16 bits. */
  c: number
}

export interface Hlc extends HlcTime {
  deviceId: string
}

const MAX_MS = 2 ** 48 - 1
const MAX_COUNTER = 0xffff
/** A remote clock further ahead of our wall clock than this is applied, never adopted. */
export const HLC_MAX_DRIFT_MS = 5 * 60 * 1000

function isTime(value: HlcTime): boolean {
  return (
    Number.isSafeInteger(value.ms) &&
    value.ms >= 0 &&
    value.ms <= MAX_MS &&
    Number.isInteger(value.c) &&
    value.c >= 0 &&
    value.c <= MAX_COUNTER
  )
}

export function encodeHlc(hlc: Hlc): string {
  if (!isTime(hlc) || !isDeviceId(hlc.deviceId)) throw new RangeError("invalid HLC")
  return hlc.ms.toString(16).padStart(12, "0") + hlc.c.toString(16).padStart(4, "0") + hlc.deviceId
}

const ENCODED = /^([0-9a-f]{12})([0-9a-f]{4})(.+)$/

export function parseHlc(value: unknown): Hlc | null {
  if (typeof value !== "string") return null
  const match = ENCODED.exec(value)
  if (!match || !isDeviceId(match[3])) return null
  return { ms: parseInt(match[1], 16), c: parseInt(match[2], 16), deviceId: match[3] }
}

export function isEncodedHlc(value: unknown): value is string {
  return parseHlc(value) !== null
}

/** Order of two encoded clocks: negative, zero or positive. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function maxHlc(values: Iterable<string>): string | null {
  let best: string | null = null
  for (const value of values) if (best === null || value > best) best = value
  return best
}

function compareTime(a: HlcTime, b: HlcTime): number {
  return a.ms !== b.ms ? a.ms - b.ms : a.c - b.c
}

/** The clock for a local write: strictly after `last`, and never behind the wall clock. */
export function sendHlc(last: HlcTime | null, now: number, deviceId: string): Hlc {
  const wall = Math.min(Math.max(0, Math.floor(now)), MAX_MS)
  if (!last || wall > last.ms) return { ms: wall, c: 0, deviceId }
  if (last.c < MAX_COUNTER) return { ms: last.ms, c: last.c + 1, deviceId }
  return { ms: Math.min(last.ms + 1, MAX_MS), c: 0, deviceId }
}

/**
 * The local clock after seeing `remote`: it moves up to `remote`, unless
 * `remote` is more than {@link HLC_MAX_DRIFT_MS} ahead of our wall clock. A
 * device whose clock runs fast must not drag every other device's clock (and
 * so win every later write) with it.
 */
export function receiveHlc(local: HlcTime | null, remote: HlcTime, now: number): HlcTime | null {
  if (remote.ms > now + HLC_MAX_DRIFT_MS) return local
  if (!local || compareTime(remote, local) > 0) return { ms: remote.ms, c: remote.c }
  return local
}
