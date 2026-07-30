const mockHasNoLeakingPiiDeep = jest.fn((_value?: unknown) => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPiiDeep: (value: unknown) => mockHasNoLeakingPiiDeep(value),
}))

import { dispatchProtocolAdapterExec } from "./protocol-adapter-ipc"
import type { CodeProtocolAdapterFactory } from "@/types/plugin/plugin-protocol-adapter"

const event = {
  sessionId: "s1",
  execId: "ex1",
  pluginId: "acme",
  adapterId: "acme:wire",
  request: {
    model: "acme-1",
    messages: [{ role: "user", content: "hi" }],
    modelParams: {},
    credentials: { apiKey: "k" },
  },
}

function writer() {
  const calls: Record<string, unknown>[] = []
  return { calls, writeCommand: (m: Record<string, unknown>) => void calls.push(m) }
}

async function runExec(...args: Parameters<typeof dispatchProtocolAdapterExec>): Promise<void> {
  await dispatchProtocolAdapterExec(...args).done
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("condition was not met")
}

describe("dispatchProtocolAdapterExec", () => {
  beforeEach(() => {
    mockHasNoLeakingPiiDeep.mockReset().mockReturnValue(true)
  })

  it("streams chunks then done with harvested usage", async () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {
        yield { type: "text-delta", text: "Hel" }
        yield { type: "text-delta", text: "lo" }
        yield { type: "finish", usage: { promptTokens: 5, completionTokens: 2 } }
      },
    })
    const { calls, writeCommand } = writer()
    await runExec(event, { writeCommand, resolveExecutor: () => factory })

    const types = calls.map((c) => c.type)
    expect(types).toEqual([
      "protocol_adapter_chunk",
      "protocol_adapter_chunk",
      "protocol_adapter_chunk", // the finish chunk is forwarded too
      "protocol_adapter_done",
    ])
    expect(calls.at(-1)).toMatchObject({
      type: "protocol_adapter_done",
      execId: "ex1",
      usage: { promptTokens: 5, completionTokens: 2 },
    })
  })

  it("harvests AI SDK finish.totalUsage from code-adapter streams", async () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {
        yield { type: "finish", totalUsage: { inputTokens: 8, outputTokens: 3 } }
      },
    })
    const { calls, writeCommand } = writer()
    await runExec(event, { writeCommand, resolveExecutor: () => factory })

    expect(calls.at(-1)).toMatchObject({
      type: "protocol_adapter_done",
      execId: "ex1",
      usage: { inputTokens: 8, outputTokens: 3 },
    })
  })

  it("errors when no executor is registered", async () => {
    const { calls, writeCommand } = writer()
    await runExec(event, { writeCommand, resolveExecutor: () => undefined })
    expect(calls).toEqual([
      expect.objectContaining({
        type: "protocol_adapter_error",
        execId: "ex1",
        error: expect.stringContaining("no code adapter registered"),
      }),
    ])
  })

  it("rejects model-visible adapter input that fails the renderer PII gate", async () => {
    mockHasNoLeakingPiiDeep.mockReturnValue(false)
    const stream = jest.fn()
    const factory: CodeProtocolAdapterFactory = () => ({ stream })
    const { calls, writeCommand } = writer()

    await runExec(event, { writeCommand, resolveExecutor: () => factory })

    expect(mockHasNoLeakingPiiDeep).toHaveBeenCalledWith(
      expect.objectContaining({ messages: event.request.messages })
    )
    expect(stream).not.toHaveBeenCalled()
    expect(calls).toEqual([
      expect.objectContaining({
        type: "protocol_adapter_error",
        error: expect.stringContaining("renderer PII gate"),
      }),
    ])
  })

  it("forwards an error chunk as protocol_adapter_error and stops", async () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {
        yield { type: "text-delta", text: "partial" }
        yield { type: "error", error: "HTTP 429" }
        yield { type: "text-delta", text: "never" }
      },
    })
    const { calls, writeCommand } = writer()
    await runExec(event, { writeCommand, resolveExecutor: () => factory })
    expect(calls.map((c) => c.type)).toEqual(["protocol_adapter_chunk", "protocol_adapter_error"])
    expect(calls.at(-1)).toMatchObject({ error: "HTTP 429" })
  })

  it("surfaces a thrown stream as protocol_adapter_error", async () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {
        throw new Error("executor exploded")
      },
    })
    const { calls, writeCommand } = writer()
    await runExec(event, { writeCommand, resolveExecutor: () => factory })
    expect(calls).toEqual([
      expect.objectContaining({ type: "protocol_adapter_error", error: "executor exploded" }),
    ])
  })

  it("awaits an async factory", async () => {
    const factory: CodeProtocolAdapterFactory = async () => ({
      stream: async function* () {
        yield { type: "finish" }
      },
    })
    const { calls, writeCommand } = writer()
    await runExec(event, { writeCommand, resolveExecutor: () => factory })
    expect(calls.at(-1)).toMatchObject({ type: "protocol_adapter_done" })
    expect(calls.at(-1)).not.toHaveProperty("usage")
  })

  it("passes an abortSignal into the executor request and suppresses completion after cancel", async () => {
    let capturedSignal: AbortSignal | undefined
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* (req) {
        capturedSignal = req.abortSignal
        yield { type: "text-delta", text: "partial" }
        await new Promise<void>((resolve) =>
          req.abortSignal?.addEventListener("abort", () => resolve())
        )
        yield { type: "text-delta", text: "never" }
      },
    })
    const { calls, writeCommand } = writer()
    const handle = dispatchProtocolAdapterExec(event, {
      writeCommand,
      resolveExecutor: () => factory,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(capturedSignal).toBeInstanceOf(AbortSignal)
    expect(capturedSignal?.aborted).toBe(false)
    await waitFor(() => calls.length === 1)
    handle.cancel("interrupted")
    expect(capturedSignal?.aborted).toBe(true)
    await handle.done

    expect(calls.map((c) => c.type)).toEqual(["protocol_adapter_chunk"])
  })
})
