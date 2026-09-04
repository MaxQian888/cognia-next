// Birthday source: celebrates the pet's hatch anniversary. Checks hourly (and
// once at wiring, so a launch on the birthday celebrates immediately) whether
// today's local month-day matches the Soul's `hatchDate` at least one year
// later, and emits a single XP-bearing `birthday` event per local day.
//
// The dedup record is a durable day marker on the profile. It used to be a
// scan of the newest 500 activity rows, but the ledger is capped and a busy
// hour can push today's birthday row out of that window, after which the next
// hourly tick celebrates again. The scan is kept as a backstop for profiles
// written before the marker existed.

import type { PetActivityRow, PetProfile } from "@/types/pet"
import { getPetProfile, listPetActivity, patchPetProfile } from "@/lib/db/pet"
import { localDayKey } from "@/lib/pet/economy/streak"
import type { PetEmit } from "../pet-event-bus"

/** Hourly — a birthday only needs day resolution; keep the reads negligible. */
export const BIRTHDAY_CHECK_INTERVAL_MS = 60 * 60_000

/** Ledger rows scanned for today's dedup record (well past one day of events). */
const DEDUP_SCAN_ROWS = 500

/**
 * True when `now` falls on the hatch anniversary: same local month + day,
 * at least one year after the hatch. Feb-29 hatchlings celebrate on Mar-1 in
 * non-leap years (their month-day never matches otherwise). Pure.
 */
export function isBirthdayToday(hatchDate: string, now: number): boolean {
  const hatch = new Date(hatchDate)
  if (Number.isNaN(hatch.getTime())) return false
  const today = new Date(now)
  if (today.getFullYear() <= hatch.getFullYear()) return false
  const isFeb29Hatch = hatch.getMonth() === 1 && hatch.getDate() === 29
  if (isFeb29Hatch) {
    const feb29 = new Date(today.getFullYear(), 1, 29)
    const leapYear = feb29.getMonth() === 1
    return leapYear
      ? today.getMonth() === 1 && today.getDate() === 29
      : today.getMonth() === 2 && today.getDate() === 1
  }
  return today.getMonth() === hatch.getMonth() && today.getDate() === hatch.getDate()
}

export interface BirthdayDeps {
  /** Override the check cadence (tests). */
  intervalMs?: number
  /** Injectable timer (tests) — defaults to the global `setInterval`. */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Injectable clear (tests) — defaults to the global `clearInterval`. */
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
  /** Injectable clock (tests). */
  now?: () => number
  /** Injectable profile read (tests) — defaults to the Dexie singleton. */
  getProfile?: () => Promise<PetProfile | undefined>
  /** Injectable ledger read (tests) — defaults to the Dexie ledger. */
  listActivity?: (limit: number) => Promise<PetActivityRow[]>
  /** Injectable profile patch (tests) — defaults to the Dexie singleton. */
  markCelebrated?: (day: string) => Promise<unknown>
}

/** Build a birthday source wire with injectable deps (for tests). */
export function createBirthdaySource(deps: BirthdayDeps = {}): (emit: PetEmit) => () => void {
  const intervalMs = deps.intervalMs ?? BIRTHDAY_CHECK_INTERVAL_MS
  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearIv = deps.clearInterval ?? ((h) => clearInterval(h))
  const nowFn = deps.now ?? Date.now
  const getProfile = deps.getProfile ?? getPetProfile
  const listActivity = deps.listActivity ?? listPetActivity
  const markCelebrated =
    deps.markCelebrated ?? ((day: string) => patchPetProfile({ lastBirthdayAwardDay: day }))

  return (emit) => {
    let disposed = false
    const tick = async () => {
      try {
        const profile = await getProfile()
        const hatchDate = profile?.soul?.hatchDate
        if (!hatchDate || disposed) return
        const now = nowFn()
        if (!isBirthdayToday(hatchDate, now)) return
        // One celebration per local day, recorded durably on the profile.
        //
        // This used to rest entirely on scanning the newest 500 activity rows
        // for a `birthday` entry from today. The ledger is capped at 2000, so
        // a busy hour can push that row out of the scanned window and the next
        // hourly tick celebrates again. A stored day cannot be pushed out.
        const today = localDayKey(now)
        if (profile?.lastBirthdayAwardDay === today) return
        // The ledger scan stays as a backstop for profiles written before the
        // marker existed, and for the gap between emitting and recording.
        const rows = await listActivity(DEDUP_SCAN_ROWS)
        if (disposed) return
        if (rows.some((r) => r.kind === "birthday" && localDayKey(r.ts) === today)) return
        emit({ source: "system", kind: "birthday", at: now })
        await markCelebrated(today)
      } catch {
        // Best-effort ambience — a failed check must never surface.
      }
    }
    void tick()
    const handle = setIv(() => void tick(), intervalMs)
    return () => {
      disposed = true
      clearIv(handle)
    }
  }
}

/** Default wire used by `DEFAULT_PET_SOURCES`. */
export const wireBirthdaySource = createBirthdaySource()
