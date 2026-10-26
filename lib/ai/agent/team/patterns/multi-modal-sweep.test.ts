import { multiModalSweepNode } from "./multi-modal-sweep"
import {
  registerTeamRunContext,
  __resetTeamRunContextForTesting,
  type TeamRunContext,
} from "../team-run-context"
import type { StepExecutionContext } from "@/types/workflow/visual"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { PromptDefinitionV1 } from "@/lib/prompts/types"
import { SWEEP_FINDER_PROMPT, FINDINGS_SCHEMA_HINT_PROMPT } from "./pattern-prompts"

const dispatchStructuredMock = jest.fn()
jest.mock("../teammate/structured-dispatch", () => ({
  dispatchStructured: (...a: unknown[]) => dispatchStructuredMock(...a),
}))

/** The team's project for the next context; set by the Prompt Center tests. */
let teamProjectId: string | undefined

/** Publish one workspace-scoped override of `def` for project "ws-1" (ADR-0236). */
function publishWorkspaceOverride(def: PromptDefinitionV1, body: string, revisionId: string) {
  teamProjectId = "ws-1"
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: "pob",
        promptId: def.id,
        scope: "workspace",
        targetId: "ws-1",
        revisionId,
        body,
        contractVersion: def.contractVersion,
      },
    ])
  )
}

afterEach(() => {
  teamProjectId = undefined
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

function makeCtx(params: Record<string, unknown>, upstream: Record<string, unknown> = {}) {
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    team: { name: "Team", ...(teamProjectId ? { projectId: teamProjectId } : {}) },
    concurrency: { get: () => 4 },
    storeWriter: { addMessage: jest.fn(), setTaskStatus: jest.fn(), updateTeammate: jest.fn() },
  } as unknown as TeamRunContext)
  return {
    runId: "run1",
    stepId: "sweep1",
    workflowId: "wf1",
    params,
    upstream,
    signal: new AbortController().signal,
    log: jest.fn(),
    resolveSecret: jest.fn(),
    trigger: {},
  } as unknown as StepExecutionContext
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.multi-modal-sweep", () => {
  it("runs one finder per modality and returns the deduped union", async () => {
    dispatchStructuredMock
      .mockResolvedValueOnce({
        value: { findings: [{ title: "A", detail: "d", location: "x:1" }] },
      })
      .mockResolvedValueOnce({
        value: {
          findings: [
            { title: "A2", detail: "d", location: "x:1" }, // dup location → collapsed
            { title: "B", detail: "e", location: "y:2" },
          ],
        },
      })

    const ctx = makeCtx({
      teamId: "team1",
      objective: "find bugs",
      modalities: ["by-file", "by-call"],
    })
    const result = await multiModalSweepNode.execute(ctx)

    expect(dispatchStructuredMock).toHaveBeenCalledTimes(2)
    const findings = (result.output as { findings: unknown[] }).findings
    expect(findings).toHaveLength(2) // A + B, A2 deduped against A by location
    expect((result.output as { finderCount: number }).finderCount).toBe(2)
  })

  it("tolerates a finder failure and keeps the rest", async () => {
    dispatchStructuredMock
      .mockRejectedValueOnce(new Error("finder boom"))
      .mockResolvedValueOnce({ value: { findings: [{ title: "B", detail: "e" }] } })

    const ctx = makeCtx({ objective: "x", modalities: ["m1", "m2"] })
    const result = await multiModalSweepNode.execute(ctx)
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(1)
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("failed"))
  })

  it("throws when objective is missing", async () => {
    const ctx = makeCtx({ modalities: ["m1"] })
    await expect(multiModalSweepNode.execute(ctx)).rejects.toThrow(/objective/)
  })

  it("throws when no modalities are provided", async () => {
    const ctx = makeCtx({ objective: "x", modalities: [] })
    await expect(multiModalSweepNode.execute(ctx)).rejects.toThrow(/modalities/)
  })
})

describe("pattern.multi-modal-sweep — Prompt Center (ADR-0236)", () => {
  it("sends the project's customized finder wording and the inspect-only schema hint", async () => {
    publishWorkspaceOverride(
      SWEEP_FINDER_PROMPT,
      "Hunt {{objective}} via {{modality}}.",
      "por-pattern-sweep"
    )
    dispatchStructuredMock.mockResolvedValue({ value: { findings: [] } })

    await multiModalSweepNode.execute(makeCtx({ objective: "find bugs", modalities: ["by-file"] }))

    const [, args, , opts] = dispatchStructuredMock.mock.calls[0]
    expect(args.prompt).toBe("Hunt find bugs via by-file.")
    expect(opts).toEqual({ schemaHint: FINDINGS_SCHEMA_HINT_PROMPT.defaultBody })
  })
})
