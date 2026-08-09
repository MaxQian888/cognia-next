import type { Experimental_RealtimeModelV4ClientEvent as RealtimeClientEvent } from "@ai-sdk/provider"

const requestRealtimeToolApproval = jest.fn()
const realtimeToolWillPrompt = jest.fn(() => false)
const cancelRealtimeToolApproval = jest.fn()

jest.mock("./approval", () => ({
  requestRealtimeToolApproval: (...args: Parameters<typeof requestRealtimeToolApproval>) =>
    requestRealtimeToolApproval(...args),
  realtimeToolWillPrompt: (...args: Parameters<typeof realtimeToolWillPrompt>) =>
    realtimeToolWillPrompt(...args),
  cancelRealtimeToolApproval: (...args: Parameters<typeof cancelRealtimeToolApproval>) =>
    cancelRealtimeToolApproval(...args),
}))

import { createLiveVoiceAudioGate } from "./audio-gate"
import {
  createRealtimeToolRuntime,
  parseToolArguments,
  REALTIME_TOOL_DENIED_ERROR,
  serializeToolOutput,
  type RealtimeToolExecutionResult,
} from "./tool-runtime"

function makeGate() {
  return createLiveVoiceAudioGate({
    setMicrophoneEnabled: jest.fn(),
    cancelResponse: jest.fn(),
    interruptPlayback: jest.fn(),
    isUserMuted: () => false,
  })
}

function makeRuntime(
  execute: jest.Mock = jest.fn(
    async () => ({ result: { ok: true } }) as RealtimeToolExecutionResult
  )
) {
  const sent: RealtimeClientEvent[] = []
  const gate = makeGate()
  const runtime = createRealtimeToolRuntime({
    sessionId: "s1",
    policy: {},
    gate,
    send: (event) => void sent.push(event),
    execute,
  })
  return { runtime, sent, gate, execute }
}

/** The output JSON string of the nth `conversation-item-create`. */
function outputs(sent: RealtimeClientEvent[]): unknown[] {
  return sent
    .filter((event) => event.type === "conversation-item-create")
    .map((event) => JSON.parse((event as unknown as { item: { output: string } }).item.output))
}

beforeEach(() => {
  jest.clearAllMocks()
  requestRealtimeToolApproval.mockResolvedValue({ approved: true, reason: "rule" })
  realtimeToolWillPrompt.mockReturnValue(false)
})

describe("parseToolArguments", () => {
  it("parses an object", () => {
    expect(parseToolArguments('{"q":"hi"}')).toEqual({ args: { q: "hi" } })
  })

  it("treats an empty string as no arguments", () => {
    // Providers spell "no arguments" as "", which JSON.parse rejects.
    expect(parseToolArguments("")).toEqual({ args: {} })
    expect(parseToolArguments("   ")).toEqual({ args: {} })
  })

  it("reports malformed JSON as a tool error rather than throwing", () => {
    // Throwing would skip the output the model is waiting on.
    expect(parseToolArguments("{oops")).toEqual({
      error: "tool arguments were not valid JSON",
    })
  })

  it("rejects a non-object payload", () => {
    expect(parseToolArguments("[1,2]")).toMatchObject({ error: expect.any(String) })
    expect(parseToolArguments("42")).toMatchObject({ error: expect.any(String) })
    expect(parseToolArguments("null")).toMatchObject({ error: expect.any(String) })
  })
})

describe("serializeToolOutput", () => {
  it("serializes a result", () => {
    expect(serializeToolOutput({ result: { hits: 2 } })).toBe('{"hits":2}')
  })

  it("serializes undefined as null rather than the string 'undefined'", () => {
    // JSON.stringify(undefined) returns undefined, which is not a valid output.
    expect(serializeToolOutput({})).toBe("null")
  })

  it("wraps an error", () => {
    expect(serializeToolOutput({ error: "nope" })).toBe('{"error":"nope"}')
  })

  it("reports an unserializable result instead of emitting a broken frame", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(JSON.parse(serializeToolOutput({ result: circular }))).toMatchObject({
      error: expect.stringContaining("serialized"),
    })
  })
})

describe("RealtimeToolRuntime", () => {
  it("runs an approved call and returns its output", async () => {
    const { runtime, sent, execute } = makeRuntime()

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: '{"q":"hi"}' })

    expect(execute).toHaveBeenCalledWith({
      sessionId: "s1",
      callId: "c1",
      name: "search",
      args: { q: "hi" },
      signal: expect.any(AbortSignal),
    })
    expect(sent[0]).toEqual({
      type: "conversation-item-create",
      item: {
        type: "function-call-output",
        callId: "c1",
        name: "search",
        output: '{"ok":true}',
      },
    })
  })

  it("executes a duplicated call id only once", async () => {
    const { runtime, sent, execute } = makeRuntime()
    const call = { callId: "c1", name: "search", arguments: '{"q":"hi"}' }

    await Promise.all([runtime.handleToolCall(call), runtime.handleToolCall(call)])

    expect(execute).toHaveBeenCalledTimes(1)
    expect(sent.filter((event) => event.type === "conversation-item-create")).toHaveLength(1)
  })

  it("carries the tool name, which Google needs to route the response", async () => {
    const { runtime, sent } = makeRuntime()
    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    const item = (sent[0] as Extract<RealtimeClientEvent, { type: "conversation-item-create" }>)
      .item
    expect(item).toMatchObject({ name: "search" })
  })

  it("asks the model to continue once the output is in", async () => {
    const { runtime, sent } = makeRuntime()
    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(sent.map((event) => event.type)).toEqual(["conversation-item-create", "response-create"])
  })

  it("returns an output when the user declines, so the model stops waiting", async () => {
    requestRealtimeToolApproval.mockResolvedValue({ approved: false, reason: "user" })
    const { runtime, sent, execute } = makeRuntime()

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(execute).not.toHaveBeenCalled()
    expect(outputs(sent)).toEqual([{ error: REALTIME_TOOL_DENIED_ERROR }])
    expect(sent.some((event) => event.type === "response-create")).toBe(true)
  })

  it("returns an output when the arguments do not parse", async () => {
    const { runtime, sent, execute } = makeRuntime()

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{oops" })

    expect(execute).not.toHaveBeenCalled()
    expect(requestRealtimeToolApproval).not.toHaveBeenCalled()
    expect(outputs(sent)[0]).toMatchObject({ error: expect.stringContaining("JSON") })
  })

  it("returns an output when the tool reports an error", async () => {
    const { runtime, sent } = makeRuntime(jest.fn(async () => ({ error: "plugin exploded" })))

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(outputs(sent)).toEqual([{ error: "plugin exploded" }])
  })

  it("returns an output even if execute breaks its no-throw contract", async () => {
    const onError = jest.fn()
    const gate = makeGate()
    const sent: RealtimeClientEvent[] = []
    const runtime = createRealtimeToolRuntime({
      sessionId: "s1",
      policy: {},
      gate,
      send: (event) => void sent.push(event),
      execute: jest.fn(async () => {
        throw new Error("boom")
      }),
      onError,
    })

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }))
    expect(outputs(sent)).toEqual([{ error: "boom" }])
  })

  it("leaves the microphone alone for a tool that auto-allows", async () => {
    // Muting around a silent auto-approved call would cut the user off for a
    // reason they cannot see.
    const { runtime, gate } = makeRuntime()
    realtimeToolWillPrompt.mockReturnValue(false)

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(gate.holds).toBe(0)
  })

  it("holds the microphone while a dialog is up and releases it after", async () => {
    realtimeToolWillPrompt.mockReturnValue(true)
    const { runtime, gate } = makeRuntime()
    let heldDuringApproval = 0
    requestRealtimeToolApproval.mockImplementation(async () => {
      heldDuringApproval = gate.holds
      return { approved: true, reason: "user" }
    })

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(heldDuringApproval).toBe(1)
    expect(gate.holds).toBe(0)
  })

  it("releases the microphone even when the tool fails", async () => {
    realtimeToolWillPrompt.mockReturnValue(true)
    const { runtime, gate } = makeRuntime(
      jest.fn(async () => {
        throw new Error("boom")
      })
    )

    await runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })

    expect(gate.holds).toBe(0)
  })

  it("sends exactly one response-create for a batch of concurrent calls", async () => {
    // Providers reject the extras with "conversation already has an active
    // response", which kills the turn.
    const { runtime, sent } = makeRuntime()

    await Promise.all([
      runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" }),
      runtime.handleToolCall({ callId: "c2", name: "lookup", arguments: "{}" }),
      runtime.handleToolCall({ callId: "c3", name: "fetch", arguments: "{}" }),
    ])

    expect(sent.filter((event) => event.type === "conversation-item-create")).toHaveLength(3)
    expect(sent.filter((event) => event.type === "response-create")).toHaveLength(1)
  })

  it("puts the continuation request last", async () => {
    const { runtime, sent } = makeRuntime()

    await Promise.all([
      runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" }),
      runtime.handleToolCall({ callId: "c2", name: "lookup", arguments: "{}" }),
    ])

    expect(sent.at(-1)?.type).toBe("response-create")
  })

  it("drops a result belonging to a session that already ended", async () => {
    // A callId the new session never issued makes most providers emit a fatal
    // error frame and kill it.
    let releaseExecute: (value: RealtimeToolExecutionResult) => void = () => {}
    const execute = jest.fn(
      () =>
        new Promise<RealtimeToolExecutionResult>((resolve) => {
          releaseExecute = resolve
        })
    )
    const { runtime, sent } = makeRuntime(execute as unknown as jest.Mock)

    const pending = runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })
    // Let the approval settle so the tool is actually running when the session
    // is torn down underneath it.
    await Promise.resolve()
    runtime.reset()
    releaseExecute({ result: "too late" })
    await pending

    expect(sent).toEqual([])
  })

  it("tracks calls in flight", async () => {
    let releaseExecute: (value: RealtimeToolExecutionResult) => void = () => {}
    const execute = jest.fn(
      () =>
        new Promise<RealtimeToolExecutionResult>((resolve) => {
          releaseExecute = resolve
        })
    )
    const { runtime } = makeRuntime(execute as unknown as jest.Mock)

    const pending = runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })
    await Promise.resolve()
    expect(runtime.pending).toBe(1)

    releaseExecute({ result: null })
    await pending
    expect(runtime.pending).toBe(0)
  })

  it("clears in-flight state on reset", async () => {
    const execute = jest.fn(() => new Promise<RealtimeToolExecutionResult>(() => {}))
    const { runtime } = makeRuntime(execute as unknown as jest.Mock)

    void runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })
    await Promise.resolve()
    runtime.reset()

    expect(runtime.pending).toBe(0)
    expect(cancelRealtimeToolApproval).toHaveBeenCalledWith("s1", "c1")
    expect(runtime.records).toEqual([
      expect.objectContaining({ callId: "c1", name: "search", status: "cancelled" }),
    ])
  })

  it("invalidates one provider-cancelled call and drops its late result", async () => {
    let releaseExecute: (value: RealtimeToolExecutionResult) => void = () => {}
    let observedSignal: AbortSignal | undefined
    const execute = jest.fn(
      (request: { signal: AbortSignal }) =>
        new Promise<RealtimeToolExecutionResult>((resolve) => {
          observedSignal = request.signal
          releaseExecute = resolve
        })
    )
    const { runtime, sent } = makeRuntime(execute as unknown as jest.Mock)
    const pending = runtime.handleToolCall({ callId: "c1", name: "search", arguments: "{}" })
    await Promise.resolve()

    runtime.cancel("c1")
    expect(observedSignal?.aborted).toBe(true)
    releaseExecute({ result: "too late" })
    await pending

    expect(cancelRealtimeToolApproval).toHaveBeenCalledWith("s1", "c1")
    expect(runtime.pending).toBe(0)
    expect(runtime.records).toEqual([
      expect.objectContaining({ callId: "c1", name: "search", status: "cancelled" }),
    ])
    expect(sent).toEqual([])
  })

  it("records completed, rejected and failed lifecycle outcomes", async () => {
    const { runtime } = makeRuntime()
    await runtime.handleToolCall({ callId: "ok", name: "search", arguments: "{}" })
    requestRealtimeToolApproval.mockResolvedValueOnce({ approved: false, reason: "user" })
    await runtime.handleToolCall({ callId: "no", name: "write", arguments: "{}" })
    await runtime.handleToolCall({ callId: "bad", name: "broken", arguments: "{" })

    expect(runtime.records.map(({ callId, status }) => [callId, status])).toEqual([
      ["ok", "completed"],
      ["no", "rejected"],
      ["bad", "failed"],
    ])
  })
})
