import {
  __resetTeamWorkflowNodesForTesting,
  hasTeamWorkflowNodes,
  loadTeamWorkflowNodes,
  resolveTeamWorkflowKnowledgeBaseIds,
} from "@/lib/workflow/nodes/teams/team-runtime-port"
import { installTeamWorkflowNodeRuntime } from "./install"
import { teamWorkflowNodes } from "./index"

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: {
    getState: () => ({ getTeam: () => ({ config: {} }), getTeammates: () => [] }),
  },
}))

afterEach(() => __resetTeamWorkflowNodesForTesting())

describe("installTeamWorkflowNodeRuntime", () => {
  it("installs the team implementations into the workflow port", async () => {
    installTeamWorkflowNodeRuntime()
    expect(hasTeamWorkflowNodes()).toBe(true)
    expect(await loadTeamWorkflowNodes("action.team.run")).toBe(teamWorkflowNodes)
    await expect(resolveTeamWorkflowKnowledgeBaseIds("team-1")).resolves.toEqual([])
  })

  it("is idempotent across composition roots", async () => {
    installTeamWorkflowNodeRuntime()
    const first = await loadTeamWorkflowNodes("action.team.run")
    installTeamWorkflowNodeRuntime()
    expect(await loadTeamWorkflowNodes("action.team.status")).toBe(first)
  })

  it("provides an implementation for every team node kind", () => {
    expect(Object.keys(teamWorkflowNodes).sort()).toEqual(
      [
        "compose",
        "delegate",
        "dispatchTask",
        "message",
        "reconcile",
        "reviewTask",
        "run",
        "status",
      ].sort()
    )
    for (const implementation of Object.values(teamWorkflowNodes)) {
      expect(typeof implementation).toBe("function")
    }
  })
})

describe("team run recovery ownership", () => {
  it("keeps workflow resume from replaying synthesized team runs", async () => {
    jest.resetModules()
    const reloadInFlightRuns = jest.fn(async () => [
      {
        runId: "r1",
        workflowId: "__team__:t1:abc",
        startedAt: 0,
        snapshot: { id: "__team__:t1:abc" },
      },
    ])
    const runWorkflow = jest.fn()
    jest.doMock("@/lib/workflow/runtime/tauri-bridge", () => ({ reloadInFlightRuns }))
    jest.doMock("@/lib/workflow/runtime/orchestrator", () => ({ runWorkflow }))
    const { installTeamWorkflowNodeRuntime: install } = await import("./install")
    const { resumeInFlightRuns } = await import("@/lib/workflow/runtime/resume-controller")
    install()
    expect(await resumeInFlightRuns()).toMatchObject({ attempted: 1, delegated: 1, failed: 0 })
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})
