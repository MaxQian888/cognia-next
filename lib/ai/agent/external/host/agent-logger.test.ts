import type { Logger } from "@cognia/logging"
import { LOG_VALUE_MAX_CHARS } from "@cognia/logging/truncate"
import { createAgentLogger } from "./agent-logger"

function target() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
}

describe("createAgentLogger", () => {
  it("bounds oversized top-level strings before they reach the logging core", () => {
    const sink = target()
    const logger = createAgentLogger(sink as unknown as Logger)
    const huge = "E".repeat(LOG_VALUE_MAX_CHARS + 4096)
    logger.debug("stderr", { data: huge, code: 3 })
    const forwarded = sink.debug.mock.calls[0][1] as { data: string; code: number }
    expect(forwarded.data.length).toBeLessThan(huge.length)
    expect(forwarded.data).toContain("chars truncated")
    expect(forwarded.code).toBe(3)
  })

  it("passes small entries through untouched and forwards every level", () => {
    const sink = target()
    const logger = createAgentLogger(sink as unknown as Logger)
    const data = { name: "Codex", nested: { text: "kept as is" } }
    logger.info("connected", data)
    logger.warn("warned")
    logger.error("failed", { error: new Error("boom") })
    expect(sink.info).toHaveBeenCalledWith("connected", data)
    expect(sink.info.mock.calls[0][1]).toBe(data)
    expect(sink.warn).toHaveBeenCalledWith("warned", undefined)
    expect(sink.error).toHaveBeenCalledWith("failed", { error: expect.any(Error) })
  })
})
