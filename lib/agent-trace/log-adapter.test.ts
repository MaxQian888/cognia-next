import {
  AGENT_TRACE_MODULE,
  agentTraceEventToLogEntry,
  dbAgentTraceToLogEntry,
  getAgentTraceLogData,
} from "./log-adapter"
import type { StructuredLogEntry } from "@/lib/logging"

describe("agent-trace adapter stubs", () => {
  it("exports the synthetic module name", () => {
    expect(AGENT_TRACE_MODULE).toBe("agent.trace")
  })

  it("agentTraceEventToLogEntry returns null", () => {
    expect(agentTraceEventToLogEntry({ id: "x" })).toBeNull()
  })

  it("dbAgentTraceToLogEntry returns null", () => {
    expect(dbAgentTraceToLogEntry({ id: "y" })).toBeNull()
  })

  it("getAgentTraceLogData returns null", () => {
    const entry = { module: "x" } as unknown as StructuredLogEntry
    expect(getAgentTraceLogData(entry)).toBeNull()
  })
})
