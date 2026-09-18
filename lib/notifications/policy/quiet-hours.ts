// Notification V2 quiet hours — cross-midnight, DST-correct.
//
// Quiet hours are evaluated in the TARGET's timezone (each notification
// target / subscription carries its own IANA zone), never the host's. The
// window may wrap past midnight ("22:00" → "08:00"), and the release instant
// must land on the NEXT wall-clock `end` in that zone — which is a different
// UTC instant across a DST transition. `Intl.DateTimeFormat` does the
// wall-clock→parts conversion so DST is handled by the platform, not by
// hand-rolled offset math.
//
// A timezone CHANGE is handled by construction: the release instant is
// always recomputed from the current zone's wall clock, so a stored UTC
// deadline is never trusted to still mean "the next 08:00".

export interface QuietHoursWindow {
  enabled: boolean
  /** "HH:mm" in `timezone`. */
  start: string
  /** "HH:mm"; may wrap past midnight (start > end). */
  end: string
}

/** Parse "HH:mm" → minutes since local midnight. Returns null when malformed. */
function parseHhMm(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return hh * 60 + mm
}

interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** Minutes since local midnight. */
  minuteOfDay: number
}

/** Wall-clock parts of `instant` in `timezone` via Intl — DST handled. */
function zoneParts(instant: number, timezone: string): ZoneParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  const parts = dtf.formatToParts(new Date(instant))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const hour = get("hour")
  const minute = get("minute")
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute,
    second: get("second"),
    minuteOfDay: hour * 60 + minute,
  }
}

/**
 * The UTC instant of "the next `hh:mm` wall-clock at-or-after `fromInstant`"
 * in `timezone`. Uses a convergent guess-and-check: estimate the offset,
 * compute the candidate UTC instant, then correct once for the true offset
 * at that instant (handles the rare case where the offset differs between
 * `fromInstant` and the candidate — a DST boundary inside the window).
 */
function nextWallClockInstant(
  fromInstant: number,
  hhmm: number,
  timezone: string,
  allowSameMinute: boolean
): number {
  // Search a 48h window: candidate = each local day at hh:mm in the zone.
  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const probe = zoneParts(fromInstant + dayOffset * 24 * 60 * 60 * 1000, timezone)
    // Local midnight for that probe day, as a UTC estimate.
    const localMidnightUtc =
      fromInstant + dayOffset * 24 * 60 * 60 * 1000 - (probe.minuteOfDay * 60 + probe.second) * 1000
    const estimate = localMidnightUtc + hhmm * 60 * 1000
    // Refine into the real wall-clock instant (exact across a DST fold).
    const instant = refineInstant(estimate, hhmm, timezone)
    if (instant > fromInstant || (allowSameMinute && instant === fromInstant)) {
      return instant
    }
  }
  // Fallback: 24h later (should be unreachable with a sane zone).
  return fromInstant + 24 * 60 * 60 * 1000
}

/**
 * Refine a UTC estimate into the instant that lands exactly on `hh:mm`
 * wall-clock in `timezone`. Iterates: read the zone time at the guess,
 * shift the guess by the wall-clock error. Converges in ≤3 steps and is
 * exact across a DST fold (it searches for the real wall-clock match).
 */
function refineInstant(estimate: number, hhmm: number, timezone: string): number {
  let guess = estimate
  for (let i = 0; i < 4; i += 1) {
    const parts = zoneParts(guess, timezone)
    const errorMin = parts.minuteOfDay - hhmm
    if (errorMin === 0 && parts.second === 0) return guess
    guess -= errorMin * 60 * 1000 + parts.second * 1000
  }
  return guess
}

/** Is `instant` inside the quiet window (in `timezone`)? */
export function isInQuietHours(
  instant: number,
  window: QuietHoursWindow,
  timezone: string
): boolean {
  if (!window.enabled) return false
  const start = parseHhMm(window.start)
  const end = parseHhMm(window.end)
  if (start === null || end === null) return false
  const { minuteOfDay } = zoneParts(instant, timezone)
  if (start === end) return false // a zero-length window quiets nothing
  if (start < end) {
    // Same-day window: e.g. 13:00 → 17:00.
    return minuteOfDay >= start && minuteOfDay < end
  }
  // Wrapped window: e.g. 22:00 → 08:00. Quiet when past start OR before end.
  return minuteOfDay >= start || minuteOfDay < end
}

/**
 * The instant quiet hours END — the deferred-release deadline. For a fact
 * emitted inside the window this is the next wall-clock `end`; for a fact
 * outside it the window isn't holding it, so callers don't call this.
 */
export function quietHoursReleaseAt(
  instant: number,
  window: QuietHoursWindow,
  timezone: string
): number {
  const end = parseHhMm(window.end)
  if (end === null) return instant
  return nextWallClockInstant(instant, end, timezone, false)
}

/**
 * Evaluate quiet hours for one delivery. Returns `{ deferred, releaseAt }` —
 * `deferred` when the fact must be held until `releaseAt`. `allowCritical`
 * bypasses for critical-level facts.
 */
export function evaluateQuietHours(input: {
  instant: number
  window: QuietHoursWindow
  timezone: string
  level: "critical" | string
  allowCritical: boolean
}): { deferred: boolean; releaseAt?: number } {
  if (input.allowCritical && input.level === "critical") return { deferred: false }
  if (!isInQuietHours(input.instant, input.window, input.timezone)) return { deferred: false }
  return {
    deferred: true,
    releaseAt: quietHoursReleaseAt(input.instant, input.window, input.timezone),
  }
}
