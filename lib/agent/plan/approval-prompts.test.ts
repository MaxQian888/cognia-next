import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import type { AgentPlan, PlanStep } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"
import {
  PLAN_APPROVED_EDITED_PROMPT,
  PLAN_APPROVED_PROMPT,
  buildPlanApprovedPrompt,
  resolvePlanApprovedPrompt,
} from "./approval-prompts"

function step(id: string, title: string, order: number): PlanStep {
  return { id, title, kind: "agent_turn", status: "pending", order, dependencies: [] }
}

function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  const steps = over.steps ?? []
  return {
    id: "p1",
    sessionId: "ses",
    title: "Ship it",
    source: "exit_plan_mode",
    executionMode: "auto",
    steps,
    status: "awaiting_approval",
    totalSteps: steps.length,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

function publish(promptId: string, revisionId: string, body: string, scope = "account") {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot("test-db", [
      {
        bindingId: "pob",
        promptId,
        scope: scope as "account" | "session",
        targetId: scope === "session" ? "ses" : "",
        revisionId,
        body,
        contractVersion: 1,
      },
    ])
  )
}

describe("buildPlanApprovedPrompt", () => {
  it("returns the base prompt for an unedited plan", async () => {
    expect(await buildPlanApprovedPrompt(plan())).toBe(PLAN_APPROVED_PROMPT.defaultBody)
    expect(await buildPlanApprovedPrompt(plan({ metadata: { planText: "- x" } }))).toBe(
      PLAN_APPROVED_PROMPT.defaultBody
    )
    expect(PLAN_APPROVED_PROMPT.defaultBody).toBe(
      "The plan above is approved. Implement it now, step by step, following the plan."
    )
  })

  it("embeds the edited markdown body when present", async () => {
    const p = plan({ metadata: { userEdited: true, planText: "  ## Plan\n- do it  " } })
    expect(await buildPlanApprovedPrompt(p)).toBe(
      [
        "The plan is approved, but the user ADJUSTED it during review — the approved version below supersedes the plan you proposed earlier. Where they differ, follow the version below.",
        "",
        "# Ship it",
        "",
        "## Plan\n- do it",
        "",
        "Implement it now, step by step, following the approved plan above.",
      ].join("\n")
    )
  })

  it("falls back to a numbered step list when there is no markdown body", async () => {
    const p = plan({
      steps: [step("b", "second", 1), step("a", "first", 0)],
      metadata: { userEdited: true },
    })
    // Ordered by `order`, not array position.
    expect(await buildPlanApprovedPrompt(p)).toContain("1. first\n2. second")
  })
})

describe("Prompt Center overrides", () => {
  it("sends a session's published approval turn only in that session", async () => {
    publish(PLAN_APPROVED_PROMPT.id, "por-plan-approved-session", "Go ahead.", "session")
    expect(await resolvePlanApprovedPrompt({ sessionId: "ses" })).toBe("Go ahead.")
    expect(await buildPlanApprovedPrompt(plan(), { sessionId: "ses" })).toBe("Go ahead.")
    expect(await resolvePlanApprovedPrompt({ sessionId: "other" })).toBe(
      PLAN_APPROVED_PROMPT.defaultBody
    )
  })

  it("renders the title and approved plan into an edited-plan override", async () => {
    publish(
      PLAN_APPROVED_EDITED_PROMPT.id,
      "por-plan-approved-edited",
      "Use this version of {{title}}:\n{{plan}}"
    )
    const p = plan({ metadata: { userEdited: true, planText: "- alpha" } })
    expect(await buildPlanApprovedPrompt(p)).toBe("Use this version of Ship it:\n- alpha")
  })
})
