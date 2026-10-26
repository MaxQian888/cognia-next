import type { RuleCheck } from "./adherence/checks"
import type { AuditRun } from "./model"
import { WITHHELD_TEXT, type GovernanceRuntime } from "./runtime/runtime"
import { ADHERENCE_TOOL, REPORT_TOOL } from "./skill"
import { adherenceTool, createGovernanceTools, reportTool } from "./tool"

const run: AuditRun = {
  id: "r",
  workspaceId: "w",
  startedAt: 0,
  finishedAt: Date.UTC(2026, 9, 20),
  targetModel: "m",
  surfaces: [
    {
      surface: { key: "k", name: "CLAUDE.md" } as AuditRun["surfaces"][number]["surface"],
      textHash: "",
      lineCount: 1,
    },
  ],
  findings: [],
  hunks: [
    {
      findingId: "F1",
      surfaceKey: "k",
      startLine: 1,
      endLine: 1,
      before: ["x"],
      after: [],
      proposedOnly: false,
    },
  ],
  failedSources: [],
  notes: [],
}

const check: RuleCheck = {
  id: "C",
  kind: "forbid",
  trigger: { family: "shell", command: "^rm" },
  scope: "turn",
  summary: "No rm",
  rule: { surfaceKey: "k", surfaceName: "CLAUDE.md", startLine: 2, endLine: 2, text: "Never rm." },
}

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    defaultWorkspace: jest.fn(async () => "default"),
    audit: jest.fn(async () => run),
    latestRun: jest.fn(async () => run),
    backtest: jest.fn(async () => undefined),
    forModel: jest.fn((text: string) => (text.includes("hunter2") ? WITHHELD_TEXT : text)),
    findings: jest.fn(async () => [
      {
        id: "F1",
        group: "dated-text",
        pattern: "fossil",
        location: { surfaceKey: "k", startLine: 1, endLine: 1 },
        evidence: "x",
        reason: "why",
        confidence: "high",
        action: "remove",
        sources: ["judge"],
      },
      {
        id: "F2",
        group: "hygiene",
        pattern: "unused-skill",
        location: { surfaceKey: "instruction-file:/Users/someone/repo/CLAUDE.md" },
        evidence: "token hunter2",
        reason: "",
        confidence: "low",
        action: "flag",
        sources: ["hygiene"],
      },
      {
        id: "F3",
        group: "hygiene",
        pattern: "unused-skill",
        location: { surfaceKey: "k" },
        evidence: "0",
        reason: "",
        confidence: "low",
        action: "flag",
        sources: ["hygiene"],
      },
    ]),
    store: {
      keptFindings: jest.fn(async () => new Set(["F3"])),
      checks: jest.fn(async () => ({
        derivedAt: 0,
        checks: [check],
        notCheckable: 0,
        rejected: 0,
      })),
      adherence: jest.fn(async () => ({
        ranAt: 0,
        sessions: 2,
        results: [
          {
            checkId: "C",
            sessionsScanned: 2,
            sessionsTriggered: 1,
            opportunities: 1,
            followed: 0,
            violated: 1,
            excluded: 0,
            samples: [],
          },
        ],
      })),
    },
    ...overrides,
  } as unknown as GovernanceRuntime & Record<string, jest.Mock>
}

const sessionWorkspace = jest.fn(async (sessionId: string) => (sessionId === "s" ? "w" : null))

describe("reportTool", () => {
  it("answers for the calling session's workspace, without kept findings", async () => {
    const rt = runtime()
    const answer = await reportTool(rt, sessionWorkspace, { limit: 10 }, {
      sessionId: "s",
    } as never)
    expect(rt.latestRun).toHaveBeenCalledWith("w")
    expect(rt.audit).not.toHaveBeenCalled()
    expect(answer).toMatchObject({
      ok: true,
      workspaceId: "w",
      audited: true,
      totalFindings: 2,
      keptByUser: 1,
      auditedAt: "2026-10-20T00:00:00.000Z",
    })
    const findings = (answer as { findings: Array<Record<string, unknown>> }).findings
    expect(findings[0]).toMatchObject({
      id: "F1",
      surface: "CLAUDE.md",
      lines: [1, 1],
      reason: "why",
      hasProposedEdit: true,
    })
    // An unnamed surface shows its owner, never the path in its key, and
    // evidence passes the host redaction before it reaches the model.
    expect(findings[1]).toMatchObject({
      id: "F2",
      surface: "instruction-file",
      evidence: WITHHELD_TEXT,
      hasProposedEdit: false,
    })
    expect(findings[1]).not.toHaveProperty("lines")
  })

  it("refreshes on request, falls back to the default workspace and reports errors", async () => {
    const rt = runtime()
    await reportTool(rt, sessionWorkspace, { refresh: true, limit: 0 })
    expect(rt.audit).toHaveBeenCalledWith("default")
    expect(
      await reportTool(runtime({ latestRun: jest.fn(async () => undefined) }), sessionWorkspace, {})
    ).toEqual({
      ok: true,
      workspaceId: "default",
      audited: false,
    })
    expect(
      await reportTool(
        runtime({
          latestRun: jest.fn(async () => {
            throw new Error("x")
          }),
        }),
        sessionWorkspace,
        {}
      )
    ).toEqual({
      ok: false,
      error: "x",
    })
  })
})

describe("adherenceTool", () => {
  it("returns each check with its verdict", async () => {
    const answer = await adherenceTool(runtime(), sessionWorkspace, {}, { sessionId: "s" } as never)
    expect(answer).toMatchObject({ ok: true, derived: true, sessions: 2 })
    expect((answer as { checks: unknown[] }).checks[0]).toMatchObject({
      id: "C",
      rule: "Never rm.",
      verdict: "not-followed",
      violated: 1,
      followRate: 0,
      line: 2,
    })
  })

  it("says when nothing is derived and replays on request", async () => {
    const none = runtime({ store: { checks: jest.fn(async () => undefined) } })
    expect(await adherenceTool(none, sessionWorkspace, {})).toEqual({
      ok: true,
      workspaceId: "default",
      derived: false,
    })
    const rt = runtime()
    await adherenceTool(rt, sessionWorkspace, { refresh: true })
    expect(rt.backtest).toHaveBeenCalledWith("default")
  })
})

describe("createGovernanceTools", () => {
  it("declares both read-only tools", async () => {
    const tools = createGovernanceTools(runtime(), sessionWorkspace)
    expect(tools.map((tool) => tool.name)).toEqual([REPORT_TOOL, ADHERENCE_TOOL])
    expect(tools.every((tool) => tool.definition.requiresApproval === false)).toBe(true)
    await expect(tools[0]!.execute({}, undefined as never)).resolves.toMatchObject({ ok: true })
    await expect(tools[1]!.execute({}, undefined as never)).resolves.toMatchObject({ ok: true })
  })
})
