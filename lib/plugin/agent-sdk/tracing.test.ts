import { withRunTrace } from "./tracing"
import { startSpan, endSpan } from "@/lib/agent-trace/emitter"
import type { ExecuteAgentResult } from "@/lib/ai/agent/agent-executor"

jest.mock("@/lib/agent-trace/emitter", () => ({
  __esModule: true,
  startSpan: jest.fn(() => ({ spanId: "sp1", traceId: "tr1" })),
  endSpan: jest.fn(),
}))

const mockStart = startSpan as jest.MockedFunction<typeof startSpan>
const mockEnd = endSpan as jest.MockedFunction<typeof endSpan>

const result: ExecuteAgentResult = {
  text: "out",
  channel: "sidecar",
  toolsAvailable: true,
  finishReason: "stop",
  usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
}

beforeEach(() => jest.clearAllMocks())

describe("withRunTrace", () => {
  it("passes the run through untouched when disabled", async () => {
    const out = await withRunTrace(false, { agentId: "a1" }, "hi", async () => result)
    expect(out).toBe(result)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("opens and closes a plugin-hook span with usage on success", async () => {
    const out = await withRunTrace(
      true,
      { agentId: "a1", pluginId: "p1", model: "m" },
      "hi",
      async () => result
    )
    expect(out).toBe(result)
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "invoke_agent",
        providerName: "cognia.plugin",
        surface: "plugin-hook",
        sessionId: "a1",
        pluginId: "p1",
      })
    )
    expect(mockEnd).toHaveBeenCalledWith(
      "sp1",
      expect.objectContaining({
        usage: { inputTokens: 3, outputTokens: 4, cacheCreationTokens: 0, cacheReadTokens: 0 },
      })
    )
  })

  it("records the error and re-throws on failure", async () => {
    await expect(
      withRunTrace(true, { agentId: "a1" }, "hi", async () => {
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(mockEnd).toHaveBeenCalledWith("sp1", expect.objectContaining({ errorType: "error" }))
  })
})
