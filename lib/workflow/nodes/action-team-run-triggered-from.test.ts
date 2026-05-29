/**
 * Focused test for the `action.team.run` node's IM-origin derivation: it must
 * lift `ctx.trigger.binding` (set by `startWorkflowFromIM` on IM-triggered
 * runs) into a `triggeredFrom` dep so the team's synthesized run fans its
 * result back to the originating conversation. Mocks the three dynamic
 * imports the executor pulls in so we capture the deps without booting the
 * real team runtime / Zustand store.
 */

const runTeamLifecycle = jest.fn().mockResolvedValue({ runId: "team_run_1", status: "completed" })

jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({ runTeamLifecycle }))
jest.mock("@/lib/ai/agent/agent-team-runtime-deps", () => ({
  buildAgentTeamRuntimeDeps: () => ({
    notifierDeps: { toast: () => {}, osNotify: async () => {}, log: async () => {} },
  }),
}))
jest.mock("@/stores/agent/agent-team-store", () => {
  const state = {
    getTeam: (id: string) => (id === "team-1" ? { id: "team-1", name: "T" } : undefined),
    getTeammates: () => [],
    getTeamTasks: () => [],
    addMessage: () => {},
    setTaskStatus: () => {},
    updateTeammate: () => {},
  }
  return { useAgentTeamStore: { getState: () => state } }
})

import "./built-ins"
import { getExecutor } from "./registry"
import type {
  StepExecutionContext,
  TriggerEvent,
  WorkflowTriggerBinding,
} from "@/types/workflow/visual"

function ctxWithBinding(binding?: WorkflowTriggerBinding): StepExecutionContext {
  const trigger: TriggerEvent = {
    workflowId: "wf",
    kind: "trigger.manual",
    payload: {},
    originAt: 1,
    ...(binding ? { binding } : {}),
  }
  return {
    runId: "run_outer",
    workflowId: "wf",
    stepId: "n_team",
    params: { teamId: "team-1" },
    upstream: {},
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  }
}

async function run(binding?: WorkflowTriggerBinding) {
  const reg = getExecutor("action.team.run", 1)
  if (!reg) throw new Error("no executor")
  runTeamLifecycle.mockClear()
  await reg.execute(ctxWithBinding(binding))
  return runTeamLifecycle.mock.calls[0]?.[1] as { triggeredFrom?: unknown }
}

describe("action.team.run — IM origin derivation", () => {
  it("derives an IM triggeredFrom from a complete trigger binding", async () => {
    const deps = await run({
      adapterId: "lark:a1",
      conversationKey: "lark:a1:oc_1",
      sessionId: "sess_1",
    })
    expect(deps.triggeredFrom).toEqual({
      source: "im",
      adapterId: "lark:a1",
      conversationKey: "lark:a1:oc_1",
      sessionId: "sess_1",
    })
  })

  it("omits triggeredFrom when the trigger has no binding (UI/API run)", async () => {
    const deps = await run(undefined)
    expect(deps.triggeredFrom).toBeUndefined()
  })

  it("omits triggeredFrom when the binding lacks adapterId or conversationKey", async () => {
    const deps = await run({ adapterId: "lark:a1" })
    expect(deps.triggeredFrom).toBeUndefined()
  })
})
