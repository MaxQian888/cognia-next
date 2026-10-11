import {
  buildModuleData,
  FOCUS_MS,
  initialState,
  localDay,
  minutesLeft,
  remainingAt,
  reset,
  RESET_COMMAND,
  restoreState,
  settle,
  toggle,
  TOGGLE_COMMAND,
  type FocusState,
  type Translate,
} from "./timer"

// Local noon, so a session never straddles midnight unless a test says so.
const NOON = new Date(2026, 9, 11, 12, 0, 0).getTime()
const MIN = 60_000

const t: Translate = (key, params) =>
  params
    ? `${key}(${Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")})`
    : key

describe("focus timer state", () => {
  it("starts idle with a full session and nothing done today", () => {
    expect(initialState(NOON)).toEqual({
      phase: "idle",
      endsAt: null,
      remainingMs: FOCUS_MS,
      day: localDay(NOON),
      completedToday: 0,
    })
  })

  it("starts, pauses with what is left, and resumes from there", () => {
    const running = toggle(initialState(NOON), NOON)
    expect(running).toMatchObject({ phase: "running", endsAt: NOON + FOCUS_MS })

    const paused = toggle(running, NOON + 10 * MIN)
    expect(paused).toMatchObject({ phase: "paused", endsAt: null, remainingMs: 15 * MIN })
    // Paused time does not count down.
    expect(remainingAt(paused, NOON + 60 * MIN)).toBe(15 * MIN)

    const resumed = toggle(paused, NOON + 60 * MIN)
    expect(resumed).toMatchObject({ phase: "running", endsAt: NOON + 75 * MIN })
  })

  it("counts a session done once its end has passed, on the day it ended", () => {
    const running = toggle(initialState(NOON), NOON)
    expect(settle(running, NOON + FOCUS_MS - 1).phase).toBe("running")
    const done = settle(running, NOON + FOCUS_MS)
    expect(done).toMatchObject({ phase: "idle", remainingMs: FOCUS_MS, completedToday: 1 })
    // Settling again changes nothing.
    expect(settle(done, NOON + FOCUS_MS + MIN)).toEqual(done)
  })

  it("starts a new count on a new day, even for a session that ended overnight", () => {
    const lateEvening = new Date(2026, 9, 11, 23, 50).getTime()
    const yesterday: FocusState = {
      ...toggle(initialState(lateEvening), lateEvening),
      completedToday: 3,
    }
    // The session ended at 00:15; read the next morning, it counts for the new day.
    const nextMorning = new Date(2026, 9, 12, 8, 0).getTime()
    const settled = settle(yesterday, nextMorning)
    expect(settled).toMatchObject({ phase: "idle", day: localDay(nextMorning), completedToday: 1 })

    // An idle state from yesterday just resets the count.
    const idleYesterday: FocusState = { ...initialState(lateEvening), completedToday: 4 }
    expect(settle(idleYesterday, nextMorning)).toMatchObject({ completedToday: 0 })
  })

  it("resets the session but keeps today's count", () => {
    const running = toggle({ ...initialState(NOON), completedToday: 2 }, NOON)
    expect(reset(running, NOON + MIN)).toMatchObject({
      phase: "idle",
      endsAt: null,
      remainingMs: FOCUS_MS,
      completedToday: 2,
    })
  })

  it("rounds the minutes left up", () => {
    const running = toggle(initialState(NOON), NOON)
    expect(minutesLeft(running, NOON)).toBe(25)
    expect(minutesLeft(running, NOON + FOCUS_MS - 1_000)).toBe(1)
  })

  it("restores a stored state and replaces anything that is not one", () => {
    const running = toggle(initialState(NOON), NOON)
    expect(restoreState(JSON.parse(JSON.stringify(running)), NOON)).toEqual(running)
    for (const broken of [
      null,
      "x",
      { ...running, phase: "spinning" },
      { ...running, endsAt: "soon" },
      { ...running, remainingMs: -5 },
      { ...running, remainingMs: FOCUS_MS * 2 },
      { ...running, completedToday: -1 },
      { ...running, day: 7 },
    ]) {
      expect(restoreState(broken, NOON)).toEqual(initialState(NOON))
    }
  })
})

describe("buildModuleData", () => {
  it("offers Start alone when idle, with today's count", () => {
    const data = buildModuleData({ ...initialState(NOON), completedToday: 2 }, NOON, t)
    expect(data.summary).toBe("summary.idle(count=2)")
    expect(data.stats).toEqual([
      { label: "stat.left", value: "stat.minutes(minutes=25)", tone: "muted" },
      { label: "stat.done", value: "2" },
    ])
    expect(data.actions).toEqual([
      { id: "toggle", label: "action.start", icon: "Play", command: TOGGLE_COMMAND },
    ])
  })

  it("offers Pause and Reset while running", () => {
    const running = toggle(initialState(NOON), NOON)
    const data = buildModuleData(running, NOON + 5 * MIN, t)
    expect(data.summary).toBe("summary.running(minutes=20)")
    expect(data.stats?.[0]).toMatchObject({ tone: "ok" })
    expect(data.actions).toEqual([
      { id: "toggle", label: "action.pause", icon: "Pause", command: TOGGLE_COMMAND },
      { id: "reset", label: "action.reset", icon: "RotateCcw", command: RESET_COMMAND },
    ])
  })

  it("offers Resume while paused", () => {
    const paused = toggle(toggle(initialState(NOON), NOON), NOON + 5 * MIN)
    const data = buildModuleData(paused, NOON + 30 * MIN, t)
    expect(data.summary).toBe("summary.paused(minutes=20)")
    expect(data.stats?.[0]).toMatchObject({ tone: "warn" })
    expect(data.actions?.[0]).toMatchObject({ label: "action.resume", icon: "Play" })
  })
})
