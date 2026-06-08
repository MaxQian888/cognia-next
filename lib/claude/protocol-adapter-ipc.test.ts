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

describe("dispatchProtocolAdapterExec", () => {
  it("streams chunks then done with harvested usage", async () => {
    const factory: CodeProtocolAdapterFactory = () => ({
      stream: async function* () {
        yield { type: "text-delta", text: "Hel" }
        yield { type: "text-delta", text: "lo" }
        yield { type: "finish", usage: { promptTokens: 5, completionTokens: 2 } }
      },
    })
    const { calls, writeCommand } = writer()
    await dispatchProtocolAdapterExec(event, { writeCommand, resolveExecutor: () => factory })

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

  it("errors when no executor is registered", async () => {
    const { calls, writeCommand } = writer()
    await dispatchProtocolAdapterExec(event, { writeCommand, resolveExecutor: () => undefined })
    expect(calls).toEqual([
      expect.objectContaining({
        type: "protocol_adapter_error",
        execId: "ex1",
        error: expect.stringContaining("no code adapter registered"),
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
    await dispatchProtocolAdapterExec(event, { writeCommand, resolveExecutor: () => factory })
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
    await dispatchProtocolAdapterExec(event, { writeCommand, resolveExecutor: () => factory })
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
    await dispatchProtocolAdapterExec(event, { writeCommand, resolveExecutor: () => factory })
    expect(calls.at(-1)).toMatchObject({ type: "protocol_adapter_done" })
    expect(calls.at(-1)).not.toHaveProperty("usage")
  })
})
