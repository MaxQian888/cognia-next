// Persisted proactive counters. The state lives as a non-indexed field on the
// singleton `petProfile` row (no Dexie version bump) and is advanced purely —
// `applySpoke` returns a fresh object so callers patch it back via
// `patchPetProfile({ proactiveState })`. The shape itself lives in
// `types/pet/proactive.ts` (types stay in types/).

import type { ProactiveState } from "@/types/pet"

export type { ProactiveState }

export const EMPTY_PROACTIVE_STATE: ProactiveState = {
  lastSpokeAtMs: null,
  dayKey: null,
  spokenToday: 0,
  greetedWindows: [],
}

/** Local calendar day for `nowMs` as YYYY-MM-DD (en-CA renders ISO order). */
export function localDayKey(nowMs: number, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    ...(tz ? { timeZone: tz } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs))
}

/**
 * Local hour (0-23) for `nowMs` in `tz` (device zone when omitted). Used by the
 * time-of-day greeting engine so "good morning" fires on the *user's* clock,
 * not the device's — the two differ once a profile timezone is set or the app
 * is mirrored to a companion phone in another zone.
 */
export function localHour(nowMs: number, tz?: string): number {
  const rendered = new Intl.DateTimeFormat("en-US", {
    ...(tz ? { timeZone: tz } : {}),
    hour: "2-digit",
    hour12: false,
  }).format(new Date(nowMs))
  const parsed = Number.parseInt(rendered, 10)
  // Some engines render midnight as "24"; normalize to the 0-23 range.
  return Number.isFinite(parsed) ? parsed % 24 : new Date(nowMs).getHours()
}

/** Defensive read of a possibly-missing/stale persisted value. */
export function normalizeProactiveState(raw: unknown): ProactiveState {
  if (typeof raw !== "object" || raw === null) return EMPTY_PROACTIVE_STATE
  const r = raw as Partial<ProactiveState>
  return {
    lastSpokeAtMs: typeof r.lastSpokeAtMs === "number" ? r.lastSpokeAtMs : null,
    dayKey: typeof r.dayKey === "string" ? r.dayKey : null,
    spokenToday: typeof r.spokenToday === "number" && r.spokenToday >= 0 ? r.spokenToday : 0,
    greetedWindows: Array.isArray(r.greetedWindows)
      ? r.greetedWindows.filter((w): w is string => typeof w === "string")
      : [],
  }
}

/** Advance the counters after an accepted utterance (handles day rollover).
 *  `greetedWindow` marks a greeting window as used in the same step. */
export function applySpoke(
  state: ProactiveState,
  nowMs: number,
  opts: { tz?: string; greetedWindow?: string } = {}
): ProactiveState {
  const day = localDayKey(nowMs, opts.tz)
  const sameDay = state.dayKey === day
  const greeted = sameDay ? state.greetedWindows : []
  return {
    lastSpokeAtMs: nowMs,
    dayKey: day,
    spokenToday: (sameDay ? state.spokenToday : 0) + 1,
    greetedWindows: opts.greetedWindow ? [...greeted, opts.greetedWindow] : greeted,
  }
}
