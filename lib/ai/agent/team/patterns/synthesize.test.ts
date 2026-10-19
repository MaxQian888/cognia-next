import { synthesizeNode } from "./synthesize"
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
import { SYNTHESIZE_REPORT_PROMPT } from "./pattern-prompts"

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
  const addMessage = jest.fn()
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    team: { name: "Team", ...(teamProjectId ? { projectId: teamProjectId } : {}) },
    concurrency: { get: () => 4 },
    storeWriter: { addMessage, setTaskStatus: jest.fn(), updateTeammate: jest.fn() },
  } as unknown as TeamRunContext)
  const ctx = {
    runId: "run1",
    stepId: "syn1",
    params,
    upstream,
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
  return { ctx, addMessage }
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.synthesize", () => {
  it("folds findings + winner + gaps into a report and posts it to chat", async () => {
    dispatchStructuredMock.mockResolvedValue({
      value: { report: "Final report.", citations: ["a.ts:1"] },
      teammateId: "tm9",
    })
    const upstream = {
      verify: { findings: [{ title: "Bug", detail: "d", location: "a.ts:1" }] },
      judge: { winner: { attempt: { angle: "mvp", content: "do x" }, avgScore: 9 } },
      critic: { gaps: [{ description: "no perf check" }] },
    }
    const { ctx, addMessage } = makeCtx({ objective: "audit" }, upstream)

    const result = await synthesizeNode.execute(ctx)

    const out = result.output as { report: string; citations: string[]; findingCount: number }
    expect(out.report).toBe("Final report.")
    expect(out.citations).toEqual(["a.ts:1"])
    expect(out.findingCount).toBe(1)
    expect(addMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: "tm9", type: "result_share", content: "Final report." })
    )

    // The prompt should reference the winner + gaps it was given.
    const promptArg = dispatchStructuredMock.mock.calls[0][1] as { prompt: string }
    expect(promptArg.prompt).toContain("Winning approach")
    expect(promptArg.prompt).toContain("open gaps")
  })

  it("works with only findings and no winner/gaps", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { report: "R" }, teammateId: "tm1" })
    const { ctx } = makeCtx({ objective: "x" }, { v: { findings: [{ title: "A", detail: "d" }] } })
    const result = await synthesizeNode.execute(ctx)
    expect((result.output as { citations: string[] }).citations).toEqual([])
  })

  it("truncates a very long report in the chat message", async () => {
    const long = "x".repeat(5000)
    dispatchStructuredMock.mockResolvedValue({ value: { report: long }, teammateId: "tm1" })
    const { ctx, addMessage } = makeCtx({ objective: "x" })
    await synthesizeNode.execute(ctx)
    const msg = addMessage.mock.calls[0][0] as { content: string }
    expect(msg.content.length).toBeLessThan(long.length)
    expect(msg.content.endsWith("…")).toBe(true)
  })

  it("throws when objective is missing", async () => {
    const { ctx } = makeCtx({})
    await expect(synthesizeNode.execute(ctx)).rejects.toThrow(/objective/)
  })
})

describe("pattern.synthesize — Prompt Center (ADR-0236)", () => {
  it("sends the project's customized report wording", async () => {
    publishWorkspaceOverride(
      SYNTHESIZE_REPORT_PROMPT,
      "Report on {{objective}}: {{findingsBlock}}{{winnerBlock}}{{gapsBlock}}",
      "por-pattern-synthesize"
    )
    dispatchStructuredMock.mockResolvedValue({ value: { report: "r" }, teammateId: "tm" })

    await synthesizeNode.execute(makeCtx({ objective: "audit" }).ctx)

    expect(dispatchStructuredMock.mock.calls[0][1].prompt).toBe(
      "Report on audit: No verified findings."
    )
  })
})
