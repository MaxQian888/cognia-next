/**
 * @jest-environment node
 */
import {
  __resetToolHostStatusForTesting,
  clearToolHostStatus,
  latestToolHostStatus,
  publishToolHostStatus,
  readToolHostStatus,
  type ToolHostSnapshot,
} from "./status"

const snapshot = (overrides: Partial<ToolHostSnapshot> = {}): ToolHostSnapshot => ({
  backend: "codex",
  contextVersion: "v1",
  attachable: true,
  running: true,
  builtinToolCount: 4,
  hostToolCount: 1,
  subagentDispatch: false,
  userMcpCount: 0,
  connections: 1,
  ...overrides,
})

afterEach(() => __resetToolHostStatusForTesting())

describe("tool-host status registry", () => {
  it("returns undefined for a session that published nothing", () => {
    expect(readToolHostStatus("unknown")).toBeUndefined()
  })

  it("round-trips a published snapshot", () => {
    publishToolHostStatus("s1", snapshot())
    expect(readToolHostStatus("s1")).toMatchObject({ backend: "codex", contextVersion: "v1" })
  })

  it("replaces the previous snapshot rather than accumulating", () => {
    publishToolHostStatus("s1", snapshot())
    publishToolHostStatus("s1", snapshot({ contextVersion: "v2", running: false }))
    expect(readToolHostStatus("s1")).toMatchObject({ contextVersion: "v2", running: false })
  })

  it("keeps sessions independent", () => {
    publishToolHostStatus("s1", snapshot({ backend: "codex" }))
    publishToolHostStatus("s2", snapshot({ backend: "claude-code" }))
    expect(readToolHostStatus("s1")?.backend).toBe("codex")
    expect(readToolHostStatus("s2")?.backend).toBe("claude-code")
  })

  it("forgets a session on clear, so a stale panel cannot report a dead bridge", () => {
    publishToolHostStatus("s1", snapshot())
    clearToolHostStatus("s1")
    expect(readToolHostStatus("s1")).toBeUndefined()
  })

  it("exposes the most recent snapshot for surfaces with no session id", () => {
    expect(latestToolHostStatus()).toBeUndefined()
    publishToolHostStatus("s1", snapshot({ backend: "codex" }))
    publishToolHostStatus("s2", snapshot({ backend: "claude-code" }))
    expect(latestToolHostStatus()?.backend).toBe("claude-code")
  })
})
