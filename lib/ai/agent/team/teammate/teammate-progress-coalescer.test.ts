import {
  createTeammateProgressReporter,
  type TeammateProgressMeta,
} from "./teammate-progress-coalescer"
import type { AgentTeamEvent } from "@/types/agent/agent-team"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

const META: TeammateProgressMeta = {
  teamId: "team-1",
  teammateId: "tm-1",
  teammateName: "Researcher",
  taskId: "task-1",
  channel: "sidecar",
}

/**
 * Deterministic clock — advances only when the test calls `tick`. Starts well
 * past THROTTLE_MS so a fresh state's `lastEmitAt:0` lets the first non-boundary
 * event emit (mirroring real wall-clock timestamps).
 */
function fakeClock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms
    },
  }
}

const textDelta = (delta: string): CaptureStreamEvent => ({ type: "text-delta", delta })
const toolCall = (toolName: string): CaptureStreamEvent => ({
  type: "tool-call",
  toolName,
  input: {},
})

describe("createTeammateProgressReporter", () => {
  it("emits a start frame with phase=start", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>()
    const clock = fakeClock()
    const reporter = createTeammateProgressReporter(META, emit, clock.now)

    reporter.start()

    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0]![0]
    expect(ev.type).toBe("progress_update")
    expect(ev.teamId).toBe("team-1")
    expect(ev.taskId).toBe("task-1")
    expect(ev.data?.phase).toBe("start")
    expect(ev.data?.teammateName).toBe("Researcher")
    expect(ev.data?.channel).toBe("sidecar")
    expect(ev.data?.charCount).toBe(0)
  })

  it("emits immediately on a tool-call boundary and tracks the tool", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>()
    const clock = fakeClock()
    const reporter = createTeammateProgressReporter(META, emit, clock.now)
    reporter.start()
    emit.mockClear()

    reporter.onCaptureEvent(toolCall("Bash"))

    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0]![0]
    expect(ev.data?.phase).toBe("running")
    expect(ev.data?.toolCount).toBe(1)
    expect(ev.data?.currentTool).toBe("Bash")
  })

  it("accumulates text-delta chars but throttles non-boundary emits", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>()
    const clock = fakeClock()
    const reporter = createTeammateProgressReporter(META, emit, clock.now)
    reporter.start()
    emit.mockClear()

    // First text-delta: lastEmitAt is 0 → emits (now - 0 >= THROTTLE_MS).
    reporter.onCaptureEvent(textDelta("hello"))
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0].data?.charCount).toBe(5)

    // Immediately another delta with no time advance → throttled (no emit).
    emit.mockClear()
    reporter.onCaptureEvent(textDelta("world"))
    expect(emit).not.toHaveBeenCalled()

    // Advance past the heartbeat window → emits again with accumulated chars.
    clock.tick(6_000)
    reporter.onCaptureEvent(textDelta("!"))
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]![0].data?.charCount).toBe(11)
  })

  it("force-emits a terminal done frame", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>()
    const clock = fakeClock()
    const reporter = createTeammateProgressReporter(META, emit, clock.now)
    reporter.start()
    emit.mockClear()

    clock.tick(2_500)
    reporter.finalize("done")

    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0]![0]
    expect(ev.data?.phase).toBe("done")
    expect(ev.data?.elapsedMs).toBe(2_500)
  })

  it("emits a failed terminal frame", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>()
    const reporter = createTeammateProgressReporter(META, emit, fakeClock().now)
    reporter.finalize("failed")
    expect(emit.mock.calls[0]![0].data?.phase).toBe("failed")
  })

  it("ignores events after finalize (frozen)", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>()
    const reporter = createTeammateProgressReporter(META, emit, fakeClock().now)
    reporter.finalize("done")
    emit.mockClear()

    reporter.onCaptureEvent(toolCall("Bash"))
    reporter.finalize("failed")
    reporter.start()
    expect(emit).not.toHaveBeenCalled()
  })

  it("swallows a throwing emit sink", () => {
    const emit = jest.fn<void, [AgentTeamEvent]>(() => {
      throw new Error("sink boom")
    })
    const reporter = createTeammateProgressReporter(META, emit, fakeClock().now)
    expect(() => {
      reporter.start()
      reporter.onCaptureEvent(toolCall("Bash"))
      reporter.finalize("done")
    }).not.toThrow()
    expect(emit).toHaveBeenCalled()
  })
})
