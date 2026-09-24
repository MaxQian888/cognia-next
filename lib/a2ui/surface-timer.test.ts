import {
  SURFACE_TIMER_TICK_MS,
  SurfaceTimerRuntime,
  computeTimerFrame,
  formatTimerDisplay,
  resolveTimerDirection,
  restingTimerFrame,
  type SurfaceTimerHost,
} from "./surface-timer"
import { setValueByPath } from "./data-model"

/** Live in-memory host: reads always see the latest writes, like the store. */
function createHost(initial: Record<string, Record<string, unknown>>) {
  const surfaces = new Map(Object.entries(initial))
  const write = jest.fn((surfaceId: string, path: string, value: unknown) => {
    const current = surfaces.get(surfaceId)
    if (!current) return
    surfaces.set(surfaceId, setValueByPath(current, path, value))
  })
  const host: SurfaceTimerHost = { read: (id) => surfaces.get(id), write }
  return { host, surfaces, write }
}

describe("formatTimerDisplay", () => {
  it.each([
    [0, "00:00"],
    [59, "00:59"],
    [60, "01:00"],
    [1500, "25:00"],
    [3600, "60:00"],
    [-5, "00:00"],
    [Number.NaN, "00:00"],
    [90.7, "01:30"],
  ])("formats %p as %p", (seconds, expected) => {
    expect(formatTimerDisplay(seconds)).toBe(expected)
  })
})

describe("resolveTimerDirection", () => {
  it("counts down when a length is loaded", () => {
    expect(resolveTimerDirection({ totalSeconds: 300 })).toBe("countdown")
    expect(resolveTimerDirection({ totalSeconds: 1500, mode: "pomodoro" })).toBe("countdown")
    expect(resolveTimerDirection({ totalSeconds: "60", mode: "timer" })).toBe("countdown")
  })

  it("counts up for stopwatches and length-less timers", () => {
    expect(resolveTimerDirection({ totalSeconds: 0 })).toBe("countup")
    expect(resolveTimerDirection({})).toBe("countup")
    expect(resolveTimerDirection({ totalSeconds: 300, mode: "stopwatch" })).toBe("countup")
  })
})

describe("computeTimerFrame", () => {
  it("projects countdown remaining time and progress", () => {
    expect(computeTimerFrame("countdown", 1500, 8)).toEqual({
      seconds: 8,
      display: "24:52",
      progress: 1,
      finished: false,
    })
  })

  it("clamps an overrun countdown to finished", () => {
    expect(computeTimerFrame("countdown", 60, 75)).toEqual({
      seconds: 60,
      display: "00:00",
      progress: 100,
      finished: true,
    })
  })

  it("counts up without touching progress", () => {
    expect(computeTimerFrame("countup", 0, 125)).toEqual({
      seconds: 125,
      display: "02:05",
      progress: null,
      finished: false,
    })
  })

  it("derives the resting frame from the loaded length", () => {
    expect(restingTimerFrame({ totalSeconds: 1500 }).display).toBe("25:00")
    expect(restingTimerFrame({ totalSeconds: 0 }).display).toBe("00:00")
  })
})

describe("SurfaceTimerRuntime", () => {
  let clock = 0
  const now = () => clock

  beforeEach(() => {
    jest.useFakeTimers()
    clock = 0
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  /** Advance both the injected wall clock and the fake interval scheduler. */
  function elapse(runtime: SurfaceTimerRuntime, ms: number) {
    for (let t = 0; t < ms; t += SURFACE_TIMER_TICK_MS) {
      clock += SURFACE_TIMER_TICK_MS
      jest.advanceTimersByTime(SURFACE_TIMER_TICK_MS)
    }
    return runtime
  }

  function pomodoro() {
    return createHost({
      p: { display: "25:00", seconds: 0, totalSeconds: 1500, progress: 0, isRunning: false },
    })
  }

  it("counts down from the live data model once started", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = pomodoro()

    expect(runtime.start("p", host)).toBe(true)
    expect(surfaces.get("p")?.isRunning).toBe(true)
    elapse(runtime, 8_000)

    expect(surfaces.get("p")).toMatchObject({ seconds: 8, display: "24:52", progress: 1 })
    runtime.stopAll()
  })

  it("measures wall-clock time, so throttled ticks do not stretch the countdown", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = pomodoro()
    runtime.start("p", host)

    // A backgrounded webview delivered no ticks for 90s, then one tick.
    clock += 90_000
    jest.advanceTimersByTime(SURFACE_TIMER_TICK_MS)

    expect(surfaces.get("p")).toMatchObject({ seconds: 90, display: "23:30" })
    runtime.stopAll()
  })

  it("rejects a second start while ticking and reports liveness", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host } = pomodoro()
    expect(runtime.start("p", host)).toBe(true)
    expect(runtime.start("p", host)).toBe(false)
    expect(runtime.isActive("p")).toBe(true)
    expect(runtime.size).toBe(1)
    runtime.stopAll()
    expect(runtime.isActive("p")).toBe(false)
  })

  it("starts even when a persisted run flag has no live ticker (reload)", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = createHost({
      p: { display: "24:00", seconds: 60, totalSeconds: 1500, progress: 4, isRunning: true },
    })

    expect(runtime.start("p", host)).toBe(true)
    elapse(runtime, 2_000)
    expect(surfaces.get("p")).toMatchObject({ seconds: 62, display: "23:58" })
    runtime.stopAll()
  })

  it("pauses at the elapsed position and resumes from it", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = pomodoro()
    runtime.start("p", host)
    clock += 3_600
    runtime.pause("p", host)

    expect(runtime.isActive("p")).toBe(false)
    expect(surfaces.get("p")).toMatchObject({ seconds: 3, display: "24:57", isRunning: false })

    elapse(runtime, 10_000)
    expect(surfaces.get("p")?.seconds).toBe(3)

    runtime.start("p", host)
    elapse(runtime, 2_000)
    expect(surfaces.get("p")).toMatchObject({ seconds: 5, display: "24:55" })
    runtime.stopAll()
  })

  it("pausing an idle timer just clears the run flag", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = createHost({ p: { isRunning: true, totalSeconds: 60 } })
    runtime.pause("p", host)
    expect(surfaces.get("p")?.isRunning).toBe(false)
  })

  it("resets to the resting frame and releases the ticker", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = pomodoro()
    runtime.start("p", host)
    elapse(runtime, 5_000)
    runtime.reset("p", host)

    expect(runtime.isActive("p")).toBe(false)
    expect(surfaces.get("p")).toMatchObject({
      seconds: 0,
      display: "25:00",
      progress: 0,
      isRunning: false,
    })
  })

  it("loads presets, stopping any running countdown", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = pomodoro()
    runtime.start("p", host)
    runtime.setPreset("p", host, 300)

    expect(runtime.isActive("p")).toBe(false)
    expect(surfaces.get("p")).toMatchObject({
      totalSeconds: 300,
      seconds: 0,
      display: "05:00",
      progress: 0,
      isRunning: false,
    })
  })

  it("finishes a countdown, clears the run flag, and restarts it on the next start", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = createHost({
      p: { display: "00:02", seconds: 0, totalSeconds: 2, progress: 0, isRunning: false },
    })
    runtime.start("p", host)
    elapse(runtime, 3_000)

    expect(surfaces.get("p")).toMatchObject({
      seconds: 2,
      display: "00:00",
      progress: 100,
      isRunning: false,
    })
    expect(runtime.isActive("p")).toBe(false)

    runtime.start("p", host)
    expect(surfaces.get("p")).toMatchObject({ seconds: 0, display: "00:02", isRunning: true })
    runtime.stopAll()
  })

  it("counts a stopwatch up without writing progress", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces, write } = createHost({
      s: { display: "00:00", seconds: 0, totalSeconds: 0, progress: 0, isRunning: false },
    })
    runtime.start("s", host)
    elapse(runtime, 65_000)

    expect(surfaces.get("s")).toMatchObject({ seconds: 65, display: "01:05", progress: 0 })
    expect(write.mock.calls.some(([, path]) => path === "/progress")).toBe(false)
    runtime.stopAll()
  })

  it("stops ticking when another writer clears the run flag", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces } = pomodoro()
    runtime.start("p", host)
    surfaces.set("p", { ...surfaces.get("p"), isRunning: false })
    elapse(runtime, 2_000)

    expect(runtime.isActive("p")).toBe(false)
    expect(surfaces.get("p")?.seconds).toBe(0)
  })

  it("stops ticking once the surface is deleted", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, surfaces, write } = pomodoro()
    runtime.start("p", host)
    surfaces.delete("p")
    write.mockClear()
    elapse(runtime, 2_000)

    expect(runtime.isActive("p")).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it("ignores unknown surfaces", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, write } = createHost({})
    expect(runtime.start("missing", host)).toBe(false)
    runtime.pause("missing", host)
    runtime.reset("missing", host)
    runtime.setPreset("missing", host, 60)
    expect(write).not.toHaveBeenCalled()
    expect(runtime.size).toBe(0)
  })

  it("only writes fields whose value changed on a tick", () => {
    const runtime = new SurfaceTimerRuntime(now)
    const { host, write } = pomodoro()
    runtime.start("p", host)
    write.mockClear()
    // Sub-second ticks inside the same whole second write nothing.
    elapse(runtime, 750)
    expect(write).not.toHaveBeenCalled()
    runtime.stopAll()
  })
})
