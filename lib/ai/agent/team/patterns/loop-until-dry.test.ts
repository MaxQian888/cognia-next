import { loopUntilDryNode } from "./loop-until-dry"
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
import { LOOP_FINDER_PROMPT } from "./pattern-prompts"

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

function makeCtx(params: Record<string, unknown>) {
  registerTeamRunContext({
    runId: "run1",
    teamId: "team1",
    team: { name: "Team", ...(teamProjectId ? { projectId: teamProjectId } : {}) },
    concurrency: { get: () => 4 },
    storeWriter: { addMessage: jest.fn(), setTaskStatus: jest.fn(), updateTeammate: jest.fn() },
  } as unknown as TeamRunContext)
  return {
    runId: "run1",
    stepId: "loop1",
    params,
    upstream: {},
    signal: new AbortController().signal,
    log: jest.fn(),
  } as unknown as StepExecutionContext
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __resetTeamRunContextForTesting())

describe("pattern.loop-until-dry", () => {
  it("stops after dryRoundsToStop consecutive empty rounds", async () => {
    dispatchStructuredMock
      .mockResolvedValueOnce({ value: { findings: [{ title: "A", detail: "d" }] } }) // round 1: +1
      .mockResolvedValueOnce({ value: { findings: [] } }) // round 2: dry 1
      .mockResolvedValueOnce({ value: { findings: [] } }) // round 3: dry 2 → stop

    const ctx = makeCtx({
      objective: "find bugs",
      finderPrompt: "look",
      dryRoundsToStop: 2,
      maxRounds: 10,
    })
    const result = await loopUntilDryNode.execute(ctx)

    expect(dispatchStructuredMock).toHaveBeenCalledTimes(3)
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(1)
    expect((result.output as { converged: boolean }).converged).toBe(true)
    expect((result.output as { rounds: number }).rounds).toBe(3)
  })

  it("dedupes findings across rounds (a repeat does not reset the dry streak)", async () => {
    dispatchStructuredMock
      .mockResolvedValueOnce({
        value: { findings: [{ title: "A", detail: "d", location: "x:1" }] },
      })
      .mockResolvedValueOnce({
        value: { findings: [{ title: "A", detail: "d", location: "x:1" }] },
      }) // dup → dry 1
      .mockResolvedValueOnce({ value: { findings: [] } }) // dry 2 → stop

    const ctx = makeCtx({ objective: "x", finderPrompt: "p", dryRoundsToStop: 2, maxRounds: 10 })
    const result = await loopUntilDryNode.execute(ctx)
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(1)
  })

  it("stops at maxRounds and warns about bounded coverage", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { findings: [{ title: "A", detail: "d" }] } })
    // Every round finds the same single finding (deduped) → never goes dry past 1,
    // but each round produces fresh=0 after the first, so it would converge…
    // Use unique findings each round so the streak never reaches the threshold.
    dispatchStructuredMock
      .mockReset()
      .mockResolvedValueOnce({ value: { findings: [{ title: "A", detail: "d" }] } })
      .mockResolvedValueOnce({ value: { findings: [{ title: "B", detail: "d" }] } })

    const ctx = makeCtx({ objective: "x", finderPrompt: "p", dryRoundsToStop: 5, maxRounds: 2 })
    const result = await loopUntilDryNode.execute(ctx)
    expect((result.output as { rounds: number }).rounds).toBe(2)
    expect((result.output as { converged: boolean }).converged).toBe(false)
    expect(ctx.log).toHaveBeenCalledWith("warn", expect.stringContaining("maxRounds"))
  })

  it("runs findersPerRound finders in parallel", async () => {
    dispatchStructuredMock
      .mockResolvedValueOnce({ value: { findings: [{ title: "A", detail: "d" }] } })
      .mockResolvedValueOnce({ value: { findings: [{ title: "B", detail: "d" }] } })
      .mockResolvedValue({ value: { findings: [] } })

    const ctx = makeCtx({
      objective: "x",
      finderPrompt: "p",
      dryRoundsToStop: 1,
      maxRounds: 5,
      findersPerRound: 2,
    })
    const result = await loopUntilDryNode.execute(ctx)
    // Round 1 = 2 finders (A, B), round 2 = 2 finders (empty) → dry 1 → stop.
    expect((result.output as { findings: unknown[] }).findings).toHaveLength(2)
  })

  it("applies default round knobs when omitted (dry=2, maxRounds=4, finders=1)", async () => {
    dispatchStructuredMock.mockResolvedValue({ value: { findings: [] } })
    const ctx = makeCtx({ objective: "x", finderPrompt: "p" })
    const result = await loopUntilDryNode.execute(ctx)
    // 2 empty rounds → converged at the default dryRoundsToStop of 2.
    expect(dispatchStructuredMock).toHaveBeenCalledTimes(2)
    expect((result.output as { converged: boolean }).converged).toBe(true)
  })

  it("throws when objective is missing", async () => {
    const ctx = makeCtx({ finderPrompt: "p" })
    await expect(loopUntilDryNode.execute(ctx)).rejects.toThrow(/objective/)
  })

  it("throws when finderPrompt is missing", async () => {
    const ctx = makeCtx({ objective: "x" })
    await expect(loopUntilDryNode.execute(ctx)).rejects.toThrow(/finderPrompt/)
  })
})

describe("pattern.loop-until-dry — Prompt Center (ADR-0236)", () => {
  it("sends the project's customized finder wording on every round", async () => {
    publishWorkspaceOverride(
      LOOP_FINDER_PROMPT,
      "{{objective}} | {{finderPrompt}} | {{knownSummary}}",
      "por-pattern-loop"
    )
    dispatchStructuredMock
      .mockResolvedValueOnce({ value: { findings: [{ title: "A", detail: "d" }] } })
      .mockResolvedValueOnce({ value: { findings: [] } })

    await loopUntilDryNode.execute(
      makeCtx({ objective: "find bugs", finderPrompt: "look", dryRoundsToStop: 1, maxRounds: 3 })
    )

    expect(dispatchStructuredMock.mock.calls[0][1].prompt).toBe(
      "find bugs | look | Nothing found yet."
    )
    expect(dispatchStructuredMock.mock.calls[1][1].prompt).toBe(
      "find bugs | look | Already found (do NOT repeat these):\n- A"
    )
  })
})
