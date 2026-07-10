/**
 * @jest-environment jsdom
 */
import {
  __resetBackgroundResultRuntimeForTesting,
  attemptBackgroundResultDelivery,
  maybeDrainBackgroundResults,
  onBackgroundRunSettled,
  registerBackgroundReplaySend,
  registerBackgroundResultNotifyStrings,
} from "./background-result-runtime"
import type {
  BackgroundTaskSettleInfo,
  BackgroundTaskStartMeta,
} from "@/lib/background-tasks/registry-core"

const isSessionOpen = jest.fn(() => true)
const sessionStatusOf = jest.fn(() => "idle")
const listBackgroundTaskRecords = jest.fn(async (): Promise<unknown[]> => [])
const updateBackgroundTaskRecord = jest.fn(async () => undefined)
const getSession = jest.fn(async (): Promise<unknown> => ({ id: "chat-1" }))
const notify = jest.fn(async () => "n1")

jest.mock("./steer-runtime", () => ({
  isSessionOpen: (...args: unknown[]) => isSessionOpen(...(args as [])),
  sessionStatusOf: (...args: unknown[]) => sessionStatusOf(...(args as [])),
}))
jest.mock("@/lib/db/background-tasks", () => ({
  listBackgroundTaskRecords: (...args: unknown[]) => listBackgroundTaskRecords(...(args as [])),
  updateBackgroundTaskRecord: (...args: unknown[]) => updateBackgroundTaskRecord(...(args as [])),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...args: unknown[]) => getSession(...(args as [])),
}))
jest.mock("@/lib/notifications/runtime", () => ({
  notify: (...args: unknown[]) => notify(...(args as [])),
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

function meta(over: Partial<BackgroundTaskStartMeta> = {}): BackgroundTaskStartMeta {
  return {
    kind: "subagent",
    subagentId: "explore",
    prompt: "look",
    sessionId: "chat-1",
    host: "renderer",
    startedAt: 1_000,
    mode: "background",
    ...over,
  }
}

function settle(over: Partial<BackgroundTaskSettleInfo> = {}): BackgroundTaskSettleInfo {
  return { status: "done", settledAt: 4_000, resultText: "findings", ...over }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetBackgroundResultRuntimeForTesting()
  isSessionOpen.mockReturnValue(true)
  sessionStatusOf.mockReturnValue("idle")
  getSession.mockResolvedValue({ id: "chat-1" })
  listBackgroundTaskRecords.mockResolvedValue([])
})

describe("onBackgroundRunSettled", () => {
  it("injects a framed turn into an open idle parent and marks the row delivered", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const [framed, sessionId] = send.mock.calls[0]
    expect(sessionId).toBe("chat-1")
    expect(framed).toContain("[background task update]")
    expect(framed).toContain('Subagent "explore" (runId run-1)')
    expect(framed).toContain("findings")
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })

  it("fires a completion notification with localized copy", async () => {
    registerBackgroundResultNotifyStrings({
      title: ({ subagentId, status, elapsed }) => `T:${subagentId}:${status}:${elapsed}`,
      body: ({ runId }) => `B:${runId}`,
    })
    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "session",
        level: "success",
        title: "T:explore:done:3s",
        body: "B:run-1",
        groupKey: "run-1",
      })
    )
  })

  it("uses the error level for failed runs and frames the cut-off text", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)

    onBackgroundRunSettled(
      "run-1",
      meta(),
      settle({ status: "error", resultText: "half done", error: "429 rate limit" })
    )
    await flush()

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }))
    const [framed] = send.mock.calls[0]
    expect(framed).toContain("(error):")
    expect(framed).toContain("half done")
    expect(framed).toContain("cut off by an error and did not finish: 429 rate limit")
  })

  it("stays pending while the parent is streaming, then drains at settle", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)
    sessionStatusOf.mockReturnValue("streaming")

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "pending" })
    )

    sessionStatusOf.mockReturnValue("idle")
    maybeDrainBackgroundResults("chat-1")
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("stays pending while the pane is closed, then drains on open", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)
    isSessionOpen.mockReturnValue(false)

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()
    expect(send).not.toHaveBeenCalled()

    isSessionOpen.mockReturnValue(true)
    maybeDrainBackgroundResults("chat-1")
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("marks entries orphaned (notification only) when the parent session is gone", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)
    getSession.mockResolvedValue(undefined)

    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalled()
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "orphaned" })
    )
  })

  it("batches racing completions into ONE framed turn ordered by settledAt", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)
    sessionStatusOf.mockReturnValue("streaming") // hold both pending

    onBackgroundRunSettled(
      "run-b",
      meta({ subagentId: "b" }),
      settle({ settledAt: 6_000, resultText: "second" })
    )
    onBackgroundRunSettled(
      "run-a",
      meta({ subagentId: "a" }),
      settle({ settledAt: 5_000, resultText: "first" })
    )
    await flush()

    sessionStatusOf.mockReturnValue("idle")
    maybeDrainBackgroundResults("chat-1")
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const [framed] = send.mock.calls[0]
    expect(framed.indexOf("first")).toBeLessThan(framed.indexOf("second"))
  })

  it("ignores non-subagent kinds and non-terminal settles", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)

    onBackgroundRunSettled("p1", meta({ kind: "plugin-agent" }), settle())
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it("keeps entries pending when no replay send is registered", async () => {
    onBackgroundRunSettled("run-1", meta(), settle())
    await flush()

    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "pending" })
    )
    expect(updateBackgroundTaskRecord).not.toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })
})

describe("relaunch drain from journaled pending rows", () => {
  it("delivers journal rows with deliveryState pending when the session opens idle", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)
    listBackgroundTaskRecords.mockResolvedValue([
      {
        runId: "old-1",
        kind: "subagent",
        subagentId: "explore",
        prompt: "look",
        sessionId: "chat-1",
        host: "renderer",
        status: "done",
        startedAt: 1_000,
        settledAt: 2_000,
        resultText: "from a previous app run",
        deliveryState: "pending",
      },
      // Other sessions / non-pending rows are ignored.
      {
        runId: "other",
        kind: "subagent",
        subagentId: "explore",
        prompt: "look",
        sessionId: "chat-2",
        host: "renderer",
        status: "done",
        startedAt: 1_000,
        settledAt: 2_000,
        deliveryState: "pending",
      },
      {
        runId: "already",
        kind: "subagent",
        subagentId: "explore",
        prompt: "look",
        sessionId: "chat-1",
        host: "renderer",
        status: "done",
        startedAt: 1_000,
        settledAt: 2_000,
        deliveryState: "delivered",
      },
    ])

    await attemptBackgroundResultDelivery("chat-1")

    expect(send).toHaveBeenCalledTimes(1)
    const [framed] = send.mock.calls[0]
    expect(framed).toContain("from a previous app run")
    expect(framed).not.toContain("runId other")
    expect(updateBackgroundTaskRecord).toHaveBeenCalledWith(
      "old-1",
      expect.objectContaining({ deliveryState: "delivered" })
    )
  })

  it("no-ops for empty session ids and when nothing is pending", async () => {
    const send = jest.fn()
    registerBackgroundReplaySend(send)

    await attemptBackgroundResultDelivery("")
    await attemptBackgroundResultDelivery("chat-1")

    expect(send).not.toHaveBeenCalled()
  })
})
