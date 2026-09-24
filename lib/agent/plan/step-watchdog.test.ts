// The factory is driven with a hand-rolled store and jest's modern fake timers
// (which also fake `Date.now`), so every budget is exercised against the real
// clock arithmetic. The singleton is exercised against mocked `@/stores/chat`
// and `./runtime` modules to pin its wiring to `failInSessionStep`.

jest.mock("@/stores/chat", () => {
  const listeners = new Set<() => void>()
  const store = {
    state: { sessions: {} as Record<string, unknown> },
    getState: () => store.state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(sessions: Record<string, unknown>) {
      store.state = { sessions }
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
  return { useChatStore: store }
})

jest.mock("./runtime", () => ({
  getPlanRuntime: jest.fn(),
}))

jest.mock("@/lib/execution/chat-lease", () => ({
  isChatTurnQueued: jest.fn(() => false),
}))

import { useChatStore } from "@/stores/chat"
import { isChatTurnQueued } from "@/lib/execution/chat-lease"
import { getPlanRuntime } from "./runtime"
import {
  PLAN_STEP_SILENCE_TIMEOUT_MS,
  PLAN_STEP_START_TIMEOUT_MS,
  PLAN_STEP_UNRECORDED_GRACE_MS,
  __resetPlanStepWatchdogForTesting,
  armPlanStepWatch,
  createPlanStepWatchdog,
  disarmPlanStepWatch,
  type PlanStepStall,
  type PlanStepWatch,
  type WatchedSessionSlice,
} from "./step-watchdog"

const fakeStore = useChatStore as unknown as {
  set: (sessions: Record<string, unknown>) => void
  listenerCount: () => number
}
const getPlanRuntimeMock = getPlanRuntime as jest.Mock
const isChatTurnQueuedMock = isChatTurnQueued as jest.Mock

function slice(over: Partial<WatchedSessionSlice> = {}): WatchedSessionSlice {
  return {
    status: "idle",
    errorDiagnostic: null,
    errorMessage: null,
    runId: 0,
    pendingApprovals: [],
    toolTimestamps: {},
    ...over,
  }
}

/** A minimal store the factory reads: one mutable map + listeners. */
function harness() {
  let sessions: Record<string, WatchedSessionSlice | undefined> = {}
  const listeners = new Set<() => void>()
  const stalls: PlanStepStall[] = []
  const queued = new Set<string>()
  const watchdog = createPlanStepWatchdog({
    isQueued: (sessionId) => queued.has(sessionId),
    now: () => Date.now(),
    readSlice: (sessionId) => sessions[sessionId],
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    onStall: (stall) => stalls.push(stall),
  })
  return {
    watchdog,
    stalls,
    listeners,
    queued,
    write(sessionId: string, next: WatchedSessionSlice | undefined) {
      sessions = { ...sessions, [sessionId]: next }
      for (const listener of [...listeners]) listener()
    },
  }
}

function watch(over: Partial<PlanStepWatch> = {}): PlanStepWatch {
  return {
    planId: "p1",
    stepId: "s1",
    sessionId: "ses_a",
    generationId: "gen-1",
    dispatchedAt: Date.now(),
    ...over,
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(1_000_000)
})

afterEach(() => {
  jest.useRealTimers()
})

describe("createPlanStepWatchdog — never started", () => {
  it("reports a step whose turn never begins after the start budget", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())

    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS - 1)
    expect(h.stalls).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(h.stalls).toHaveLength(1)
    expect(h.stalls[0]).toMatchObject({ cause: "not_started", watch: { stepId: "s1" } })
    expect(h.stalls[0].detail).toContain("90s")
    expect(h.watchdog.armed()).toEqual([])
  })

  it("counts a fresh streaming edge (run counter bump) as the turn starting", () => {
    const h = harness()
    h.write("ses_a", slice({ runId: 3 }))
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "streaming", runId: 4 }))
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS + 1_000)
    expect(h.stalls).toHaveLength(0)
  })

  it("does not report a turn that is waiting for admission", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.queued.add("ses_a")
    h.watchdog.arm(watch())
    // Parked behind another conversation's working copy for far longer than
    // the start budget: still not a stall.
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS * 5)
    expect(h.stalls).toHaveLength(0)
    // Admitted: the turn starts streaming.
    h.queued.delete("ses_a")
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS + 1_000)
    expect(h.stalls).toHaveLength(0)
  })

  it("restarts the start clock once a queued turn stops waiting without starting", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.queued.add("ses_a")
    h.watchdog.arm(watch())
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS * 2)
    // Withdrawn: the wait ends and no turn ever runs.
    h.queued.delete("ses_a")
    h.write("ses_a", slice({ errorMessage: null }))
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS - 1)
    expect(h.stalls).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(h.stalls).toEqual([expect.objectContaining({ cause: "not_started" })])
  })

  it("treats a session that is already busy when armed as started", () => {
    const h = harness()
    h.write("ses_a", slice({ status: "streaming", runId: 2 }))
    h.watchdog.arm(watch())
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS + 1_000)
    expect(h.stalls).toHaveLength(0)
  })
})

describe("createPlanStepWatchdog — turn failure", () => {
  it("reports a NEW error diagnostic immediately once the turn settles", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    h.write(
      "ses_a",
      slice({
        status: "idle",
        runId: 1,
        errorDiagnostic: {
          code: "externalAgent",
          message: "Pi process exited before the Cognia extension was ready",
        },
      })
    )
    expect(h.stalls).toEqual([
      expect.objectContaining({
        cause: "turn_failed",
        detail: "Pi process exited before the Cognia extension was ready",
      }),
    ])
  })

  it("attributes a refused send (diagnostic without any streaming) to the step", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "error", errorDiagnostic: { code: "externalAgentNotReady" } }))
    expect(h.stalls[0]).toMatchObject({ cause: "turn_failed", detail: "externalAgentNotReady" })
  })

  it("ignores the stale banner a previous turn left and the chat's own silence warning", () => {
    const h = harness()
    const stale = { code: "provider", message: "old failure" }
    h.write("ses_a", slice({ status: "error", errorDiagnostic: stale }))
    h.watchdog.arm(watch())
    // Re-written with the same diagnostic object: still the old banner.
    h.write("ses_a", slice({ status: "error", errorDiagnostic: stale, runId: 0 }))
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    h.write(
      "ses_a",
      slice({ status: "streaming", runId: 1, errorDiagnostic: { code: "turnSilent" } })
    )
    expect(h.stalls).toHaveLength(0)
  })

  it("falls back to the legacy error string when no diagnostic was emitted", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "error", errorMessage: "socket closed", runId: 1 }))
    expect(h.stalls[0]).toMatchObject({ cause: "turn_failed", detail: "socket closed" })
  })
})

describe("createPlanStepWatchdog — silence", () => {
  it("reports a streaming turn that produces nothing for the silence budget", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    jest.advanceTimersByTime(PLAN_STEP_SILENCE_TIMEOUT_MS - 1)
    expect(h.stalls).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(h.stalls[0]).toMatchObject({ cause: "silent" })
  })

  it("restarts the silence clock on every slice change", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    jest.advanceTimersByTime(PLAN_STEP_SILENCE_TIMEOUT_MS - 1_000)
    // A delta lands: a new slice object.
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    jest.advanceTimersByTime(PLAN_STEP_SILENCE_TIMEOUT_MS - 1_000)
    expect(h.stalls).toHaveLength(0)
    jest.advanceTimersByTime(1_000)
    expect(h.stalls).toHaveLength(1)
  })

  it("suspends the clock while a human is being asked or a tool is running", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "awaiting_approval", runId: 1 }))
    jest.advanceTimersByTime(PLAN_STEP_SILENCE_TIMEOUT_MS * 3)
    h.write(
      "ses_a",
      slice({ status: "streaming", runId: 1, toolTimestamps: { t1: { startedAt: 1 } } })
    )
    jest.advanceTimersByTime(PLAN_STEP_SILENCE_TIMEOUT_MS * 3)
    expect(h.stalls).toHaveLength(0)
    // The tool finishes; the clock restarts from that change.
    h.write(
      "ses_a",
      slice({ status: "streaming", runId: 1, toolTimestamps: { t1: { startedAt: 1, endedAt: 2 } } })
    )
    jest.advanceTimersByTime(PLAN_STEP_SILENCE_TIMEOUT_MS)
    expect(h.stalls[0]).toMatchObject({ cause: "silent" })
  })
})

describe("createPlanStepWatchdog — unrecorded", () => {
  it("reports a turn that ended cleanly without the step being recorded", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    h.write("ses_a", slice({ status: "idle", runId: 1 }))
    jest.advanceTimersByTime(PLAN_STEP_UNRECORDED_GRACE_MS - 1)
    expect(h.stalls).toHaveLength(0)
    jest.advanceTimersByTime(1)
    expect(h.stalls[0]).toMatchObject({ cause: "unrecorded" })
  })

  it("stays quiet when the driver records the step (the runtime disarms)", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_a", slice({ status: "streaming", runId: 1 }))
    h.write("ses_a", slice({ status: "idle", runId: 1 }))
    h.watchdog.disarm("p1")
    jest.advanceTimersByTime(PLAN_STEP_UNRECORDED_GRACE_MS * 2)
    expect(h.stalls).toHaveLength(0)
  })
})

describe("createPlanStepWatchdog — bookkeeping", () => {
  it("never reports on a missing slice (a closed tab is not evidence)", () => {
    const h = harness()
    h.watchdog.arm(watch())
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS * 4)
    expect(h.stalls).toHaveLength(0)
    expect(h.watchdog.isArmed("p1", "s1")).toBe(true)
  })

  it("replaces the watch when the same plan arms its next step", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch({ stepId: "s1" }))
    h.watchdog.arm(watch({ stepId: "s2" }))
    expect(h.watchdog.isArmed("p1", "s1")).toBe(false)
    expect(h.watchdog.isArmed("p1", "s2")).toBe(true)
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS)
    expect(h.stalls.map((stall) => stall.watch.stepId)).toEqual(["s2"])
  })

  it("holds one store subscription while anything is armed and drops it after", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch({ planId: "p1" }))
    h.watchdog.arm(watch({ planId: "p2", sessionId: "ses_b" }))
    expect(h.listeners.size).toBe(1)
    h.watchdog.disarm("p1")
    expect(h.listeners.size).toBe(1)
    h.watchdog.disarm("p2")
    expect(h.listeners.size).toBe(0)
  })

  it("ignores store writes that do not touch a watched session", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.write("ses_other", slice({ status: "error", errorMessage: "not ours" }))
    expect(h.stalls).toHaveLength(0)
  })

  it("dispose clears every watch", () => {
    const h = harness()
    h.write("ses_a", slice())
    h.watchdog.arm(watch())
    h.watchdog.dispose()
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS * 2)
    expect(h.stalls).toHaveLength(0)
    expect(h.listeners.size).toBe(0)
  })

  it("keeps working when the stall handler throws", () => {
    const listeners = new Set<() => void>()
    let sessions: Record<string, WatchedSessionSlice> = { ses_a: slice() }
    const watchdog = createPlanStepWatchdog({
      now: () => Date.now(),
      readSlice: (id) => sessions[id],
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onStall: () => {
        throw new Error("reporter down")
      },
      budgets: { startMs: 10 },
    })
    watchdog.arm(watch({ planId: "p1" }))
    watchdog.arm(watch({ planId: "p2", sessionId: "ses_b" }))
    sessions = { ...sessions, ses_b: slice() }
    expect(() => jest.advanceTimersByTime(10)).not.toThrow()
    expect(watchdog.armed()).toEqual([])
  })
})

describe("armPlanStepWatch (renderer singleton)", () => {
  const failInSessionStep = jest.fn().mockResolvedValue(null)

  beforeEach(() => {
    __resetPlanStepWatchdogForTesting()
    failInSessionStep.mockClear()
    getPlanRuntimeMock.mockReturnValue({ failInSessionStep })
    fakeStore.set({})
  })

  afterEach(() => {
    __resetPlanStepWatchdogForTesting()
  })

  it("asks the chat lease whether the step's turn is still queued", async () => {
    jest.useRealTimers()
    isChatTurnQueuedMock.mockReturnValue(true)
    try {
      fakeStore.set({ ses_a: slice() })
      await armPlanStepWatch(watch({ dispatchedAt: Date.now() - PLAN_STEP_START_TIMEOUT_MS * 2 }))
      fakeStore.set({ ses_a: slice({ runId: 0 }) })
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(isChatTurnQueuedMock).toHaveBeenCalledWith("ses_a")
      expect(failInSessionStep).not.toHaveBeenCalled()
    } finally {
      isChatTurnQueuedMock.mockReturnValue(false)
    }
  })

  it("reports a stall to the runtime with the generation captured at dispatch", async () => {
    fakeStore.set({ ses_a: slice() })
    await armPlanStepWatch(watch({ generationId: "gen-7" }))
    fakeStore.set({
      ses_a: slice({ status: "idle", runId: 1, errorDiagnostic: { message: "spawn failed" } }),
    })
    // The runtime is reached through a lazy import: let its promise chain run.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(failInSessionStep).toHaveBeenCalledWith("p1", {
      stepId: "s1",
      cause: "turn_failed",
      detail: "spawn failed",
      capturedGenerationId: "gen-7",
    })
  })

  it("disarm stops the watch and releases the store subscription", async () => {
    fakeStore.set({ ses_a: slice() })
    await armPlanStepWatch(watch())
    expect(fakeStore.listenerCount()).toBe(1)
    disarmPlanStepWatch("p1")
    expect(fakeStore.listenerCount()).toBe(0)
    jest.advanceTimersByTime(PLAN_STEP_START_TIMEOUT_MS * 2)
    expect(failInSessionStep).not.toHaveBeenCalled()
  })

  it("disarm before any watchdog exists is a harmless no-op", () => {
    expect(() => disarmPlanStepWatch("never-armed")).not.toThrow()
  })
})
