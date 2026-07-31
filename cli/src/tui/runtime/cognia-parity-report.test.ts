/**
 * @jest-environment node
 */
import { buildCogniaParityReport, parityHealthLine } from "./cognia-parity-report"
import type { ToolHostSnapshot } from "../../agent/tool-host/status"
import {
  __resetToolHostStatusForTesting,
  publishToolHostStatus,
} from "../../agent/tool-host/status"

const snapshot = (overrides: Partial<ToolHostSnapshot> = {}): ToolHostSnapshot => ({
  backend: "claude-code",
  contextVersion: "ctx1",
  attachable: true,
  running: true,
  builtinToolCount: 12,
  hostToolCount: 3,
  subagentDispatch: true,
  userMcpCount: 2,
  connections: 2,
  ...overrides,
})

afterEach(() => __resetToolHostStatusForTesting())

describe("buildCogniaParityReport", () => {
  it("is absent until the session publishes something", () => {
    expect(buildCogniaParityReport("s1")).toBeUndefined()
  })

  it("reads the live snapshot the session published", () => {
    publishToolHostStatus("s1", snapshot())
    expect(buildCogniaParityReport("s1")).toMatchObject({
      backend: "claude-code",
      contextVersion: "ctx1",
      attachable: true,
      running: true,
      builtinToolCount: 12,
      hostToolCount: 3,
      userMcpCount: 2,
      connections: 2,
    })
  })

  it("lists the settings that restart the agent's context", () => {
    const report = buildCogniaParityReport("s1", () => snapshot())!
    expect(report.restartRequired).toContain("System prompt")
    expect(report.restartRequired).toContain("MCP servers")
    expect(report.restartRequired).not.toContain("Thinking level")
  })
})

describe("parityHealthLine", () => {
  const report = (overrides: Partial<ToolHostSnapshot> = {}) =>
    buildCogniaParityReport("s1", () => snapshot(overrides))!

  it("counts what the current policy actually exposes", () => {
    expect(parityHealthLine(report())).toBe("Cognia tools: 12 built-in · 3 host · 2 user MCP")
  })

  it("distinguishes an unstarted bridge from an impossible one", () => {
    expect(parityHealthLine(report({ running: false }))).toMatch(/not started/)
    expect(parityHealthLine(report({ attachable: false }))).toMatch(/cannot host the bridge/)
  })
})
