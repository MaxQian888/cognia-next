/**
 * @jest-environment jsdom
 */

const mockInvoke = jest.fn()

interface MockChannel<T> {
  onmessage: ((event: T) => void) | undefined
  __fire(event: T): void
}

const channelInstances: MockChannel<unknown>[] = []

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  Channel: class<T> {
    onmessage: ((event: T) => void) | undefined
    constructor() {
      this.onmessage = undefined
      channelInstances.push(this as unknown as MockChannel<unknown>)
    }
    __fire(event: T): void {
      this.onmessage?.(event)
    }
  },
}))

import {
  FLOW_PAUSE_RENEW_MS,
  TerminalSession,
  listAllTerminals,
  listTerminalsForProject,
} from "./session"
import type { SessionInfo, TerminalEvent } from "./types"

const baseInfo: SessionInfo = {
  id: "sess-1",
  projectId: "proj-a",
  extensionId: null,
  origin: "local",
  shell: "/bin/bash",
}

// The desktop Channel carries `{ seq, event }` envelopes (1C). Fire the
// inner event wrapped with a monotonic seq, mirroring the Rust sink.
let seqCounter = 0
function fire(event: TerminalEvent): void {
  const ch = channelInstances[channelInstances.length - 1]
  if (!ch) throw new Error("no channel constructed")
  ;(ch as MockChannel<unknown>).__fire({ seq: ++seqCounter, event })
}

beforeEach(() => {
  mockInvoke.mockReset()
  channelInstances.length = 0
  seqCounter = 0
})

describe("TerminalSession.spawn", () => {
  it("invokes terminal_spawn with the request and channel and surfaces the session info", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "terminal_spawn") return { session: baseInfo }
      throw new Error(`unexpected ${cmd}`)
    })

    const session = await TerminalSession.spawn({
      profileId: "profile-1",
      shell: "/bin/bash",
      rows: 24,
      cols: 80,
    })

    expect(session.id).toBe("sess-1")
    expect(session.info).toEqual(baseInfo)
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_spawn",
      expect.objectContaining({
        req: expect.objectContaining({ shell: "/bin/bash", rows: 24 }),
        profileId: "profile-1",
        onEvent: expect.any(Object),
      })
    )
  })
})

describe("TerminalSession.reattach (1C)", () => {
  it("invokes terminal_reattach, seeds lastSeq, and dispatches replayed events", async () => {
    mockInvoke.mockResolvedValueOnce(baseInfo) // terminal_reattach returns SessionInfo
    const session = await TerminalSession.reattach("sess-1", 5)
    expect(session.info).toEqual(baseInfo)
    expect(session.lastSeq).toBe(5)
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_reattach",
      expect.objectContaining({ id: "sess-1", resumeFrom: 5, onEvent: expect.any(Object) })
    )
    const seen: Uint8Array[] = []
    session.onData((b) => seen.push(b))
    fire({ kind: "data", bytes: [9] })
    expect(seen).toHaveLength(1)
    expect(session.lastSeq).toBe(1) // tracks the last received envelope's seq
  })

  it("defaults resumeFrom to 0", async () => {
    mockInvoke.mockResolvedValueOnce(baseInfo)
    await TerminalSession.reattach("sess-1")
    expect(mockInvoke).toHaveBeenCalledWith(
      "terminal_reattach",
      expect.objectContaining({ resumeFrom: 0 })
    )
  })
})

describe("event dispatch", () => {
  async function spawn(): Promise<TerminalSession> {
    mockInvoke.mockResolvedValueOnce({ session: baseInfo })
    return TerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
  }

  it("converts data event bytes to Uint8Array for subscribers", async () => {
    const session = await spawn()
    const seen: Uint8Array[] = []
    session.onData((b) => seen.push(b))
    fire({ kind: "data", bytes: [104, 105] })
    expect(seen).toHaveLength(1)
    expect(Array.from(seen[0]!)).toEqual([104, 105])
  })

  it("forwards integration events without rewrapping", async () => {
    const session = await spawn()
    const seen: unknown[] = []
    session.onIntegration((e) => seen.push(e))
    fire({ kind: "integration", event: { kind: "prompt_start" } })
    fire({
      kind: "integration",
      event: { kind: "command_end", exit_code: 1 },
    })
    expect(seen).toEqual([{ kind: "prompt_start" }, { kind: "command_end", exit_code: 1 }])
  })

  it("fires exit listeners and updates isExited / lastExitCode", async () => {
    const session = await spawn()
    let captured: number | null | undefined
    session.onExit((code) => {
      captured = code
    })
    fire({ kind: "exit", code: 42 })
    expect(captured).toBe(42)
    expect(session.isExited).toBe(true)
    expect(session.lastExitCode).toBe(42)
  })

  it("invokes onExit immediately for late subscribers", async () => {
    const session = await spawn()
    fire({ kind: "exit", code: 0 })
    let captured: number | null | undefined
    session.onExit((code) => {
      captured = code
    })
    await Promise.resolve()
    expect(captured).toBe(0)
  })

  it("unsubscribe returned from onData stops further dispatch", async () => {
    const session = await spawn()
    const seen: Uint8Array[] = []
    const off = session.onData((b) => seen.push(b))
    fire({ kind: "data", bytes: [1] })
    off()
    fire({ kind: "data", bytes: [2] })
    expect(seen).toHaveLength(1)
  })

  it("swallows listener exceptions and keeps fanning out", async () => {
    const session = await spawn()
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const seen: Uint8Array[] = []
    session.onData(() => {
      throw new Error("boom")
    })
    session.onData((b) => seen.push(b))
    fire({ kind: "data", bytes: [3] })
    expect(seen).toHaveLength(1)
    expect(consoleWarn).toHaveBeenCalled()
    consoleWarn.mockRestore()
  })

  it("dispatches replay gaps and controller changes", async () => {
    const session = await spawn()
    const gaps: unknown[] = []
    const controls: unknown[] = []
    session.onReplayGap((gap) => gaps.push(gap))
    session.onControlState((state) => controls.push(state))

    fire({ kind: "replay_gap", requested_after: 3, first_available: 8, last_available: 12 })
    fire({ kind: "controller_changed", controller: "mobile-device" })
    fire({ kind: "controller_changed", controller: "desktop" })

    expect(gaps).toEqual([{ requestedAfter: 3, firstAvailable: 8, lastAvailable: 12 }])
    expect(controls).toEqual([
      { role: "viewer", controllerId: "mobile-device", reason: "takeover" },
      { role: "controller", controllerId: "desktop", reason: undefined },
    ])
  })
})

describe("write / resize / ownership / kill", () => {
  async function spawn(): Promise<TerminalSession> {
    mockInvoke.mockResolvedValueOnce({ session: baseInfo })
    return TerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
  }

  it("encodes string input to bytes and calls terminal_write", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.write("hi")
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_write", {
      id: "sess-1",
      data: [104, 105],
    })
  })

  it("passes Uint8Array input as array on the wire", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.write(new Uint8Array([1, 2, 3]))
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_write", {
      id: "sess-1",
      data: [1, 2, 3],
    })
  })

  it("clamps resize dimensions to at least 1", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.resize(0, -3)
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_resize", {
      id: "sess-1",
      rows: 1,
      cols: 1,
    })
  })

  it("floors fractional resize dimensions", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.resize(24.7, 80.4)
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_resize", {
      id: "sess-1",
      rows: 24,
      cols: 80,
    })
  })

  it("kill is a no-op when already exited", async () => {
    const session = await spawn()
    fire({ kind: "exit", code: 0 })
    const beforeCallCount = mockInvoke.mock.calls.length
    await session.kill()
    expect(mockInvoke.mock.calls.length).toBe(beforeCallCount)
  })

  it("calls terminal_kill when not yet exited", async () => {
    const session = await spawn()
    mockInvoke.mockResolvedValueOnce(undefined)
    await session.kill()
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_kill", { id: "sess-1" })
  })

  it("detaches and transitions local control ownership", async () => {
    const session = await spawn()
    const controls: unknown[] = []
    session.onControlState((state) => controls.push(state))
    mockInvoke.mockResolvedValue(undefined)

    await session.detach()
    await session.takeControl()
    await session.releaseControl()

    expect(mockInvoke.mock.calls.slice(-3)).toEqual([
      ["terminal_detach", { id: "sess-1" }],
      ["terminal_take_control", { id: "sess-1" }],
      ["terminal_release_control", { id: "sess-1" }],
    ])
    expect(controls).toEqual([
      { role: "controller", controllerId: null },
      { role: "controller", controllerId: "local" },
      { role: "viewer", controllerId: null, reason: "released" },
    ])
  })
})

describe("list helpers", () => {
  it("listTerminalsForProject calls the matching command", async () => {
    mockInvoke.mockResolvedValueOnce([baseInfo])
    const got = await listTerminalsForProject("proj-a")
    expect(got).toEqual([baseInfo])
    expect(mockInvoke).toHaveBeenCalledWith("terminal_list_for_project", {
      projectId: "proj-a",
    })
  })

  it("listAllTerminals calls the matching command", async () => {
    mockInvoke.mockResolvedValueOnce([baseInfo])
    const got = await listAllTerminals()
    expect(got).toEqual([baseInfo])
    expect(mockInvoke).toHaveBeenCalledWith("terminal_list_all")
  })
})

describe("TerminalSession flow control", () => {
  async function spawnSession() {
    mockInvoke.mockResolvedValueOnce({ session: baseInfo })
    return TerminalSession.spawn({ shell: "/bin/bash", rows: 24, cols: 80 })
  }

  it("invokes terminal_set_flow_control with the session id and desired state", async () => {
    const session = await spawnSession()
    mockInvoke.mockResolvedValue(undefined)

    await expect(session.setFlowControl(true)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_set_flow_control", {
      id: "sess-1",
      paused: true,
    })

    await expect(session.setFlowControl(false)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenLastCalledWith("terminal_set_flow_control", {
      id: "sess-1",
      paused: false,
    })
  })

  it("latches the capability off after an older host refuses, instead of retrying per frame", async () => {
    // The watermark path can cross back and forth many times a second; an
    // unlatched failure would mean an IPC round trip on every crossing.
    const session = await spawnSession()
    expect(session.supportsFlowControl).toBe(true)

    mockInvoke.mockRejectedValueOnce(new Error("unknown command"))
    await expect(session.setFlowControl(true)).resolves.toBe(false)
    expect(session.supportsFlowControl).toBe(false)

    const callsAfterFailure = mockInvoke.mock.calls.length
    await expect(session.setFlowControl(true)).resolves.toBe(false)
    expect(mockInvoke.mock.calls.length).toBe(callsAfterFailure)
  })

  describe("pause lease renewal", () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    function flowCalls(): unknown[][] {
      return mockInvoke.mock.calls.filter((call) => call[0] === "terminal_set_flow_control")
    }

    it("re-asserts an outstanding pause so the host's 30s reaper cannot resume a still-throttled client", async () => {
      // The renderer reports only the false→true watermark crossing, so a pause
      // that is never renewed is silently dropped mid-flood by
      // `TerminalHost::reap_flow_pauses` and never re-sent.
      const session = await spawnSession()
      mockInvoke.mockResolvedValue(undefined)

      await session.setFlowControl(true)
      expect(flowCalls()).toHaveLength(1)

      jest.advanceTimersByTime(FLOW_PAUSE_RENEW_MS * 3)
      expect(flowCalls()).toHaveLength(4)
      expect(flowCalls().every((call) => (call[1] as { paused: boolean }).paused)).toBe(true)
      expect(FLOW_PAUSE_RENEW_MS).toBeLessThan(30_000)
    })

    it("stops renewing once the pause is released", async () => {
      const session = await spawnSession()
      mockInvoke.mockResolvedValue(undefined)

      await session.setFlowControl(true)
      await session.setFlowControl(false)
      const settled = flowCalls().length

      jest.advanceTimersByTime(FLOW_PAUSE_RENEW_MS * 3)
      expect(flowCalls()).toHaveLength(settled)
    })

    it("stops renewing when the session exits", async () => {
      const session = await spawnSession()
      mockInvoke.mockResolvedValue(undefined)

      await session.setFlowControl(true)
      const settled = flowCalls().length
      fire({ kind: "exit", code: 0 })

      jest.advanceTimersByTime(FLOW_PAUSE_RENEW_MS * 3)
      expect(flowCalls()).toHaveLength(settled)
    })
  })
})
