import {
  forwardMcpLog,
  subscribeToMcpLogs,
  MCP_LOG_UNKNOWN_SERVER,
  __resetMcpLogModuleTracking,
} from "./log-bridge"
import type { McpLogEvent } from "@cognia/agent-config-types"

const childLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}
const childFn = jest.fn((..._args: unknown[]) => childLogger)

jest.mock("@cognia/logging", () => ({
  loggers: { mcp: { child: (...args: unknown[]) => childFn(...args) } },
}))

const onClaudeMessage = jest.fn()
jest.mock("@/lib/claude/ipc", () => ({
  onClaudeMessage: (...args: unknown[]) => onClaudeMessage(...args),
}))

function makeEvent(overrides: Partial<McpLogEvent> = {}): McpLogEvent {
  return {
    type: "mcp_log",
    sessionId: "sess-1",
    ts: 1_700_000_000_000,
    level: "info",
    message: "hello",
    source: "diagnostic",
    server: "github",
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetMcpLogModuleTracking()
})

describe("forwardMcpLog", () => {
  it("routes to the mcp:<server> child logger", () => {
    forwardMcpLog(makeEvent({ server: "github" }))
    expect(childFn).toHaveBeenCalledWith("github")
  })

  it("falls back to the unknown-server module when server is absent", () => {
    forwardMcpLog(makeEvent({ server: undefined }))
    expect(childFn).toHaveBeenCalledWith(MCP_LOG_UNKNOWN_SERVER)
  })

  it("falls back to the unknown-server module when server is blank", () => {
    forwardMcpLog(makeEvent({ server: "   " }))
    expect(childFn).toHaveBeenCalledWith(MCP_LOG_UNKNOWN_SERVER)
  })

  it("tags the entry data with mcp runtime/origin and carries server/source/sessionId", () => {
    forwardMcpLog(makeEvent({ level: "info", source: "stderr", sessionId: "sess-9" }))
    expect(childLogger.info).toHaveBeenCalledWith("hello", {
      runtime: "mcp",
      origin: "mcp",
      server: "github",
      source: "stderr",
      sessionId: "sess-9",
    })
  })

  it("defaults source to stderr when the event omits it", () => {
    forwardMcpLog(makeEvent({ source: undefined }))
    expect(childLogger.info).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ source: "stderr" })
    )
  })

  it("maps error level via the (message, error, data) signature", () => {
    forwardMcpLog(makeEvent({ level: "error", message: "boom" }))
    expect(childLogger.error).toHaveBeenCalledWith(
      "boom",
      undefined,
      expect.objectContaining({ runtime: "mcp", origin: "mcp" })
    )
  })

  it("maps warn level", () => {
    forwardMcpLog(makeEvent({ level: "warn", message: "careful" }))
    expect(childLogger.warn).toHaveBeenCalledWith("careful", expect.any(Object))
  })

  it("maps debug level", () => {
    forwardMcpLog(makeEvent({ level: "debug", message: "trace" }))
    expect(childLogger.debug).toHaveBeenCalledWith("trace", expect.any(Object))
  })

  it("falls back to info for an unrecognised level", () => {
    forwardMcpLog(makeEvent({ level: "verbose" as McpLogEvent["level"], message: "meh" }))
    expect(childLogger.info).toHaveBeenCalledWith("meh", expect.any(Object))
  })

  it("caps distinct child-logger modules but keeps the real server name in data", () => {
    // Server names are parsed from arbitrary stderr tokens, so a chatty stream
    // must not register unbounded logger modules. Past the cap, novel names
    // route to the unknown module while their real name still rides in data.
    for (let i = 0; i < 100; i++) {
      const server = `srv-${i}`
      forwardMcpLog(makeEvent({ server }))
      expect(childLogger.info).toHaveBeenLastCalledWith(
        "hello",
        expect.objectContaining({ server })
      )
    }
    const modules = new Set(childFn.mock.calls.map((c) => c[0] as string))
    const realModules = [...modules].filter((m) => m !== MCP_LOG_UNKNOWN_SERVER)
    expect(realModules.length).toBeLessThanOrEqual(64)
    expect(modules.has(MCP_LOG_UNKNOWN_SERVER)).toBe(true)
  })
})

describe("subscribeToMcpLogs", () => {
  it("registers a single onClaudeMessage listener and returns its unlisten", async () => {
    const unlisten = jest.fn()
    onClaudeMessage.mockResolvedValue(unlisten)

    const returned = await subscribeToMcpLogs()

    expect(onClaudeMessage).toHaveBeenCalledTimes(1)
    expect(returned).toBe(unlisten)
  })

  it("forwards mcp_log events and ignores everything else", async () => {
    let handler: (evt: unknown) => void = () => {}
    onClaudeMessage.mockImplementation((h: (evt: unknown) => void) => {
      handler = h
      return Promise.resolve(jest.fn())
    })

    await subscribeToMcpLogs()

    handler({ type: "usage_headers", headers: {} })
    expect(childFn).not.toHaveBeenCalled()

    handler(makeEvent({ level: "warn", server: "slack", message: "reconnecting" }))
    expect(childFn).toHaveBeenCalledWith("slack")
    expect(childLogger.warn).toHaveBeenCalledWith("reconnecting", expect.any(Object))
  })
})
