/**
 * @jest-environment jsdom
 */

import { renderHook } from "@testing-library/react"

import { mcpServerModule, mcpServerLogsHref, useMcpServerLogs } from "./use-mcp-server-logs"
import type { StructuredLogEntry } from "@cognia/logging"

const useLogStreamMock = jest.fn()
jest.mock("@/hooks/logging/use-log-stream", () => ({
  useLogStream: (opts: unknown) => useLogStreamMock(opts),
}))

function entry(level: StructuredLogEntry["level"], message: string): StructuredLogEntry {
  return {
    id: `${level}-${message}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    module: "mcp:github",
  }
}

beforeEach(() => {
  useLogStreamMock.mockReset()
  useLogStreamMock.mockReturnValue({ logs: [], isLoading: false })
})

describe("mcpServerModule / mcpServerLogsHref", () => {
  it("builds the mcp:<server> module id", () => {
    expect(mcpServerModule("github")).toBe("mcp:github")
  })

  it("builds a src+module deep-link and encodes the module value", () => {
    expect(mcpServerLogsHref("github")).toBe("/logs?src=mcp&module=mcp%3Agithub")
  })
})

describe("useMcpServerLogs", () => {
  it("queries useLogStream scoped to the server module with live refresh", () => {
    renderHook(() => useMcpServerLogs("github", { limit: 25 }))
    expect(useLogStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ module: "mcp:github", autoRefresh: true, maxLogs: 25 })
    )
  })

  it("derives lastEntry, lastError and errorCount (newest-first)", () => {
    const logs = [
      entry("info", "connected"),
      entry("error", "tools() failed"),
      entry("warn", "slow"),
      entry("fatal", "crashed"),
    ]
    useLogStreamMock.mockReturnValue({ logs, isLoading: false })

    const { result } = renderHook(() => useMcpServerLogs("github"))
    expect(result.current.lastEntry?.message).toBe("connected")
    expect(result.current.lastError?.message).toBe("tools() failed")
    expect(result.current.errorCount).toBe(2) // error + fatal
    expect(result.current.logs).toHaveLength(4)
  })

  it("returns empty state and disables refresh for a blank server", () => {
    const { result } = renderHook(() => useMcpServerLogs("  "))
    expect(result.current).toEqual({
      logs: [],
      lastEntry: null,
      lastError: null,
      errorCount: 0,
      isLoading: false,
    })
    expect(useLogStreamMock).toHaveBeenCalledWith(expect.objectContaining({ autoRefresh: false }))
  })

  it("has no lastError when only info/warn are present", () => {
    useLogStreamMock.mockReturnValue({
      logs: [entry("info", "ok"), entry("warn", "hmm")],
      isLoading: false,
    })
    const { result } = renderHook(() => useMcpServerLogs("slack"))
    expect(result.current.lastError).toBeNull()
    expect(result.current.errorCount).toBe(0)
  })
})
