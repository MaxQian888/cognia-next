/**
 * @jest-environment jsdom
 *
 * Focused test for the `action.team.reconcile` executor: it reads the per-run
 * TeamRunContext, no-ops when workspace isolation is off, and delegates to the
 * (real) reconciler + clears the ledger when it is on. `getTeamRunContext` and
 * the LLM `executeAgent` are mocked; the reconciler runs for real (manual mode
 * touches no git).
 */

import "fake-indexeddb/auto"

const getTeamRunContextMock = jest.fn()
jest.mock("@/lib/ai/agent/team/team-run-context", () => ({
  getTeamRunContext: (...a: unknown[]) => getTeamRunContextMock(...a),
}))
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(async () => ({ text: "" })),
}))

import "./built-ins"
import { getExecutor } from "./registry"
import type { StepExecutionContext, TriggerEvent, WorkflowNodeKind } from "@/types/workflow/visual"

const trigger: TriggerEvent = { workflowId: "wf", kind: "trigger.manual", payload: {}, originAt: 1 }

function makeCtx<T extends Record<string, unknown>>(
  kind: WorkflowNodeKind,
  params: T
): StepExecutionContext<T> {
  return {
    runId: "run_test",
    workflowId: "wf",
    stepId: "n_test",
    params,
    upstream: {},
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext<T>
}

function handle(taskId: string) {
  return {
    key: taskId,
    runId: "run_test",
    teammateName: "A",
    taskId,
    branch: `agent/run_test/A/${taskId}`,
    path: `/wt/${taskId}`,
  }
}

beforeEach(() => {
  getTeamRunContextMock.mockReset()
})

describe("action.team.reconcile executor", () => {
  it("throws when no TeamRunContext is registered", async () => {
    getTeamRunContextMock.mockReturnValue(undefined)
    const exec = getExecutor("action.team.reconcile", 1)!
    await expect(exec.execute(makeCtx("action.team.reconcile", {}))).rejects.toThrow(
      /no TeamRunContext/
    )
  })

  it("is a no-op when workspace isolation is off", async () => {
    getTeamRunContextMock.mockReturnValue({ runId: "run_test" }) // no allocator/ledger
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(makeCtx("action.team.reconcile", {}))
    expect(res.output).toEqual({ reconciled: false })
  })

  it("reconciles the ledger and clears it (manual mode)", async () => {
    const ledger = new Map([
      ["t1", { handle: handle("t1"), ok: true }],
      ["t2", { handle: handle("t2"), ok: true }],
    ])
    getTeamRunContextMock.mockReturnValue({
      runId: "run_test",
      workspaceAllocator: { remove: jest.fn(), allocate: jest.fn(), commit: jest.fn() },
      workspaceLedger: ledger,
      workspaceIsolation: { mode: "manual" },
    })
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(makeCtx("action.team.reconcile", {}))
    const output = res.output as { reconciled: boolean; mode: string; branches: string[] }
    expect(output.reconciled).toBe(true)
    expect(output.mode).toBe("manual")
    expect(output.branches).toEqual(["agent/run_test/A/t1", "agent/run_test/A/t2"])
    // Ledger consumed so a later run-end reconcile only sees new dispatches.
    expect(ledger.size).toBe(0)
  })

  it("lets the node param override the team default mode", async () => {
    const alloc = { remove: jest.fn(async () => {}), allocate: jest.fn(), commit: jest.fn() }
    const ledger = new Map([
      ["t1", { handle: handle("t1"), ok: false }],
      ["t2", { handle: handle("t2"), ok: true }],
    ])
    getTeamRunContextMock.mockReturnValue({
      runId: "run_test",
      workspaceAllocator: alloc,
      workspaceLedger: ledger,
      workspaceIsolation: { mode: "manual" },
    })
    const exec = getExecutor("action.team.reconcile", 1)!
    const res = await exec.execute(
      makeCtx("action.team.reconcile", { mode: "select", selectStrategy: "first-success" })
    )
    const output = res.output as { reconciled: boolean; winnerKey?: string }
    expect(output.reconciled).toBe(true)
    expect(output.winnerKey).toBe("t2")
    // Loser t1 pruned via the allocator.
    expect(alloc.remove).toHaveBeenCalled()
  })
})
