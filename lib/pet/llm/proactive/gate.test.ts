import { canSpeak } from "./gate"
import { EMPTY_PROACTIVE_STATE, type ProactiveState } from "./scheduler-state"
import { PROACTIVE_TIERS } from "./tiers"

const NOON_UTC = Date.UTC(2026, 5, 5, 12, 0, 0)
const tuning = PROACTIVE_TIERS.normal

function state(partial: Partial<ProactiveState>): ProactiveState {
  return { ...EMPTY_PROACTIVE_STATE, ...partial }
}

describe("canSpeak", () => {
  it("allows a fresh state", () => {
    expect(
      canSpeak({
        nowMs: NOON_UTC,
        tuning,
        state: EMPTY_PROACTIVE_STATE,
        dndActive: false,
        tz: "UTC",
      })
    ).toEqual({ ok: true })
  })

  it("DND blocks before anything else", () => {
    expect(
      canSpeak({
        nowMs: NOON_UTC,
        tuning,
        state: state({ dayKey: "2026-06-05", spokenToday: 999 }),
        dndActive: true,
        tz: "UTC",
      })
    ).toEqual({ ok: false, reason: "dnd" })
  })

  it("daily cap blocks on the same day and resets across days", () => {
    const capped = state({ dayKey: "2026-06-05", spokenToday: tuning.dailyCap })
    expect(
      canSpeak({ nowMs: NOON_UTC, tuning, state: capped, dndActive: false, tz: "UTC" })
    ).toEqual({ ok: false, reason: "dailyCap" })
    // Same counters but the clock is now tomorrow → cap no longer applies.
    const tomorrow = NOON_UTC + 24 * 3600_000
    expect(
      canSpeak({ nowMs: tomorrow, tuning, state: capped, dndActive: false, tz: "UTC" })
    ).toEqual({ ok: true })
  })

  it("min gap blocks a too-recent utterance", () => {
    const recent = state({ lastSpokeAtMs: NOON_UTC - tuning.minGapMs + 1000 })
    expect(
      canSpeak({ nowMs: NOON_UTC, tuning, state: recent, dndActive: false, tz: "UTC" })
    ).toEqual({ ok: false, reason: "minGap" })
    const longAgo = state({ lastSpokeAtMs: NOON_UTC - tuning.minGapMs - 1000 })
    expect(
      canSpeak({ nowMs: NOON_UTC, tuning, state: longAgo, dndActive: false, tz: "UTC" })
    ).toEqual({ ok: true })
  })
})
