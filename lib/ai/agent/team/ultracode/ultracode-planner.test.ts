import { planUltracodeWorkflow } from "./ultracode-planner"
import type { TeamRunContext } from "../team-run-context"
import { ULTRACODE_PLAN_HINT_PROMPT, ULTRACODE_PLANNER_PROMPT } from "../team-prompts"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

const dispatchStructuredMock = jest.fn()
jest.mock("../teammate/structured-dispatch", () => ({
  dispatchStructured: (...a: unknown[]) => dispatchStructuredMock(...a),
}))

function ctx(taskText: string, ultracode?: Record<string, unknown>): TeamRunContext {
  return {
    team: { id: "t1", name: "Team", task: taskText, config: { ultracode } },
  } as unknown as TeamRunContext
}

beforeEach(() => jest.clearAllMocks())

describe("planUltracodeWorkflow", () => {
  it("returns the validated plan and dispatches with pure-reasoning", async () => {
    const plan = {
      summary: "sweep then verify",
      stages: [
        { pattern: "multi-modal-sweep", instruction: "find", variants: ["by-file"] },
        { pattern: "synthesize", instruction: "report" },
      ],
    }
    dispatchStructuredMock.mockResolvedValue({ value: plan, teammateId: "tm1" })

    const result = await planUltracodeWorkflow(ctx("audit the auth module"))

    expect(result).toEqual(plan)
    const args = dispatchStructuredMock.mock.calls[0][1] as {
      prompt: string
      preferToolEnabled: boolean
    }
    expect(args.preferToolEnabled).toBe(false)
    expect(args.prompt).toContain("audit the auth module")
  })

  it("folds team knobs into the prompt", async () => {
    dispatchStructuredMock.mockResolvedValue({
      value: { summary: "s", stages: [{ pattern: "synthesize", instruction: "r" }] },
    })
    await planUltracodeWorkflow(ctx("x", { skepticsPerFinding: 5, judgesPerAttempt: 4 }))
    const prompt = (dispatchStructuredMock.mock.calls[0][1] as { prompt: string }).prompt
    expect(prompt).toContain("default skeptics per finding: 5")
    expect(prompt).toContain("default judges per attempt: 4")
  })

  it("sends the plan schema hint from its inspect-only definition", async () => {
    dispatchStructuredMock.mockResolvedValue({
      value: { summary: "s", stages: [{ pattern: "synthesize", instruction: "r" }] },
    })
    await planUltracodeWorkflow(ctx("x"))
    expect(dispatchStructuredMock.mock.calls[0][3]).toEqual({
      schemaHint: ULTRACODE_PLAN_HINT_PROMPT.defaultBody,
    })
  })

  it("sends the team project's customized planner prompt (ADR-0236)", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: ULTRACODE_PLANNER_PROMPT.id,
          scope: "workspace",
          targetId: "ws-1",
          revisionId: "por-ultracode-planner",
          body: "Plan a sweep then synthesize.\nObjective: {{objective}}{{knobs}}",
          contractVersion: ULTRACODE_PLANNER_PROMPT.contractVersion,
        },
      ])
    )
    try {
      dispatchStructuredMock.mockResolvedValue({
        value: { summary: "s", stages: [{ pattern: "synthesize", instruction: "r" }] },
      })
      await planUltracodeWorkflow({
        team: {
          id: "t1",
          name: "Team",
          task: "audit auth",
          projectId: "ws-1",
          config: { ultracode: { maxFinderRounds: 3 } },
        },
      } as unknown as TeamRunContext)
      const prompt = (dispatchStructuredMock.mock.calls[0][1] as { prompt: string }).prompt
      expect(prompt).toBe(
        "Plan a sweep then synthesize.\nObjective: audit auth\n\nTeam knobs — max finder rounds: 3."
      )
    } finally {
      __setPromptOverrideSnapshotForTests(null)
      __resetPromptVerdictsForTests()
    }
  })

  it("propagates a validation failure from dispatchStructured", async () => {
    dispatchStructuredMock.mockRejectedValue(new Error("no valid structured output"))
    await expect(planUltracodeWorkflow(ctx("x"))).rejects.toThrow(/no valid structured output/)
  })
})
