import type { GovernanceRuntime } from "./runtime/runtime"
import { handleGovernanceCommand, parseGovernanceArgs } from "./slash"

const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

function deps(overrides: Record<string, unknown> = {}) {
  const runtime = {
    defaultWorkspace: jest.fn(async () => "default"),
    audit: jest.fn(async () => ({
      id: "r",
      workspaceId: "w",
      startedAt: 0,
      finishedAt: 0,
      targetModel: "m",
      surfaces: [],
      findings: [],
      hunks: [],
      failedSources: [],
      notes: [],
    })),
    deriveChecks: jest.fn(async () => ({ derivedAt: 0, checks: [], notCheckable: 0, rejected: 0 })),
    backtest: jest.fn(async () => ({ ranAt: 0, sessions: 0, results: [] })),
    store: { keptFindings: jest.fn(async () => new Set()), checks: jest.fn(async () => undefined) },
    ...overrides,
  } as unknown as GovernanceRuntime & Record<string, jest.Mock>
  return {
    runtime,
    t,
    openView: jest.fn(async () => {}),
    sessionWorkspace: jest.fn(async () => "w"),
  }
}

describe("parseGovernanceArgs", () => {
  it("defaults to open and rejects unknown subcommands", () => {
    expect(parseGovernanceArgs([])).toBe("open")
    expect(parseGovernanceArgs(["AUDIT"])).toBe("audit")
    expect(parseGovernanceArgs(["adherence"])).toBe("adherence")
    expect(parseGovernanceArgs(["nope"])).toBeNull()
  })
})

describe("handleGovernanceCommand", () => {
  it("opens the view", async () => {
    const d = deps()
    expect(await handleGovernanceCommand(d, [])).toEqual({ handled: true })
    expect(d.openView).toHaveBeenCalled()
  })

  it("prints usage for unknown subcommands", async () => {
    expect(await handleGovernanceCommand(deps(), ["x"])).toEqual({
      handled: true,
      message: "slash.usage",
    })
  })

  it("audits the session's workspace and answers with the report", async () => {
    const d = deps()
    const result = await handleGovernanceCommand(d, ["audit"], { sessionId: "s" })
    expect(d.runtime.audit).toHaveBeenCalledWith("w")
    expect(result.message).toContain("report.auditTitle")
    expect(result.message).toContain("slash.openHint")
  })

  it("derives checks when there are none, then replays", async () => {
    const d = deps()
    const result = await handleGovernanceCommand(d, ["adherence"])
    expect(d.runtime.deriveChecks).toHaveBeenCalledWith("default")
    expect(d.runtime.backtest).toHaveBeenCalledWith("default")
    expect(result.message).toContain("report.adherenceTitle")
  })

  it("reports failures in the chat", async () => {
    const d = deps({
      audit: jest.fn(async () => {
        throw new Error("busy")
      }),
    })
    expect(await handleGovernanceCommand(d, ["audit"])).toEqual({
      handled: true,
      message: 'slash.failed:{"error":"busy"}',
    })
  })
})
