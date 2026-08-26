/** @jest-environment jsdom */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { spanToLogEntry } from "@cognia/agent-trace/span-to-log-entry"
import type { StructuredLogEntry } from "@cognia/logging/types"

import { createLangfuseTransport, LangfuseTransport } from "./langfuse-transport"

function makeSpan(overrides: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "1111222233334444",
    traceId: "deadbeefdeadbeefdeadbeefdeadbeef",
    spanId: "1111222233334444",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_100,
    operationName: "chat",
    providerName: "anthropic",
    requestModel: "claude-sonnet-4-5",
    sessionId: "session-1",
    surface: "chat",
    inputPreview: "model input",
    outputPreview: "model output",
    ...overrides,
  }
}

function ordinaryLog(): StructuredLogEntry {
  return {
    id: "log-1",
    timestamp: "2026-08-26T00:00:00.000Z",
    level: "error",
    message: "ordinary application log",
    module: "test",
  }
}

describe("LangfuseTransport", () => {
  it("sends only AgentTrace spans through the Cognia Host", async () => {
    const batches: unknown[] = []
    const hostIngest = jest.fn(async (batch) => {
      batches.push(batch)
      return { status: 202 }
    })
    const transport = new LangfuseTransport({
      enabled: true,
      baseUrl: "https://langfuse.example/",
      publicKey: "pk-native",
      secretKeyConfigured: true,
      environment: "staging",
      captureModelContent: false,
      captureToolContent: false,
      bufferSize: 99,
      flushInterval: 0,
      hostIngest,
    })

    transport.log(ordinaryLog())
    transport.log(spanToLogEntry(makeSpan()))
    await transport.flush()

    expect(hostIngest).toHaveBeenCalledTimes(1)
    const body = JSON.stringify(batches)
    expect(body).toContain('"schemaVersion":1')
    expect(body).toContain('"operationName":"chat"')
    expect(body).not.toContain("trace-create")
    expect(body).not.toContain("event-create")
    expect(body).not.toContain("ordinary application log")
    expect(body).not.toContain("model input")
    expect(body).not.toContain("model output")
    await transport.close()
  })

  it.each([
    [false, false, false, false],
    [true, false, true, false],
    [false, true, false, true],
    [true, true, true, true],
  ])(
    "applies independent model/tool content consent (%s, %s)",
    async (captureModelContent, captureToolContent, expectModel, expectTool) => {
      const batches: unknown[] = []
      const transport = createLangfuseTransport({
        enabled: true,
        baseUrl: "https://langfuse.example",
        publicKey: "pk-native",
        secretKeyConfigured: true,
        environment: "test",
        captureModelContent,
        captureToolContent,
        bufferSize: 99,
        flushInterval: 0,
        hostIngest: jest.fn(async (batch) => {
          batches.push(batch)
          return { status: 202 }
        }),
      })
      transport.log(spanToLogEntry(makeSpan()))
      transport.log(
        spanToLogEntry(
          makeSpan({
            id: "2222333344445555",
            spanId: "2222333344445555",
            operationName: "execute_tool",
            toolName: "search",
            inputPreview: "tool input",
            outputPreview: "tool output",
          })
        )
      )
      transport.log(
        spanToLogEntry(
          makeSpan({
            id: "3333444455556666",
            spanId: "3333444455556666",
            operationName: "retrieval",
            inputPreview: "private retrieval query",
            outputPreview: "private retrieved documents",
          })
        )
      )

      await transport.flush()

      const wire = JSON.stringify(batches)
      expect(wire.includes("model input")).toBe(expectModel)
      expect(wire.includes("model output")).toBe(expectModel)
      expect(wire.includes("tool input")).toBe(expectTool)
      expect(wire.includes("tool output")).toBe(expectTool)
      expect(wire).not.toContain("private retrieval query")
      expect(wire).not.toContain("private retrieved documents")
      await transport.close()
    }
  )

  it("deduplicates a completed span ID before export", async () => {
    const batches: Array<{ schemaVersion: 1; spans: AgentTraceSpan[] }> = []
    const transport = createLangfuseTransport({
      enabled: true,
      baseUrl: "https://langfuse.example",
      publicKey: "pk-native",
      secretKeyConfigured: true,
      environment: "test",
      captureModelContent: false,
      captureToolContent: false,
      bufferSize: 99,
      flushInterval: 0,
      hostIngest: jest.fn(async (batch) => {
        batches.push(batch)
        return { status: 202 }
      }),
    })
    const entry = spanToLogEntry(makeSpan())
    transport.log(entry)
    transport.log(entry)

    await transport.flush()

    expect(batches[0].spans).toHaveLength(1)
    expect(transport.getHealth().droppedEntries).toBe(1)
    await transport.close()
  })

  it("routes a versioned AgentTrace batch through the Cognia Host", async () => {
    const hostIngest = jest.fn(async () => ({ status: 202 }))
    const transport = createLangfuseTransport({
      enabled: true,
      baseUrl: "https://langfuse.example",
      publicKey: "pk-native",
      secretKeyConfigured: true,
      environment: "test",
      captureModelContent: false,
      captureToolContent: false,
      bufferSize: 99,
      flushInterval: 0,
      hostIngest,
    })
    transport.log(spanToLogEntry(makeSpan()))

    await transport.flush()

    expect(hostIngest).toHaveBeenCalledWith({
      schemaVersion: 1,
      spans: [expect.objectContaining({ traceId: makeSpan().traceId })],
    })
    expect(hostIngest.mock.calls[0][0].spans[0]).not.toHaveProperty("inputPreview")
    const wire = JSON.stringify(hostIngest.mock.calls)
    expect(wire).not.toMatch(/authorization|secretKey|endpoint/i)
    await transport.close()
  })

  it("stays degraded and sends nothing until both project keys are configured", async () => {
    const hostIngest = jest.fn(async () => ({ status: 202 }))
    const transport = createLangfuseTransport({
      enabled: true,
      baseUrl: "https://langfuse.example",
      publicKey: "pk-native",
      secretKeyConfigured: false,
      environment: "test",
      captureModelContent: false,
      captureToolContent: false,
      flushInterval: 0,
      hostIngest,
    })
    transport.log(spanToLogEntry(makeSpan()))
    await transport.flush()

    expect(hostIngest).not.toHaveBeenCalled()
    expect(transport.getHealth().status).toBe("degraded")
    await transport.close()
  })
})
