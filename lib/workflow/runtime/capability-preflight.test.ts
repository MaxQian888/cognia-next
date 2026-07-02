/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

const mockHooksManager = {
  dispatchWorkflowStart: jest.fn(),
  dispatchWorkflowStepComplete: jest.fn(),
  dispatchWorkflowComplete: jest.fn(),
  dispatchWorkflowError: jest.fn(),
  dispatchWorkflowNodeStart: jest.fn(),
  dispatchWorkflowNodeComplete: jest.fn(),
  dispatchWorkflowNodeError: jest.fn(),
  dispatchWorkflowTriggerFired: jest.fn(),
}
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => mockHooksManager),
}))

import {
  CAPABILITY_MISSING_CODE_PREFIX,
  formatPreflightFailures,
  preflightCapabilities,
} from "./capability-preflight"
import { runWorkflow } from "./orchestrator"
import { listRunEvents } from "./event-log"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { TriggerEvent, VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

function node(id: string, type: WorkflowNode["type"]): WorkflowNode {
  return { id, type, typeVersion: 1, position: { x: 0, y: 0 }, data: { label: id, params: {} } }
}

describe("preflightCapabilities", () => {
  it("passes when every node's requirements are locally available", () => {
    const wf = { nodes: [node("n_t", "trigger.manual"), node("n_git", "action.git.commit")] }
    expect(preflightCapabilities(wf, ["webview", "shell"])).toEqual([])
  })

  it("reports one failure per node with unmet requirements, in node order", () => {
    const wf = {
      nodes: [
        node("n_t", "trigger.manual"),
        node("n_git", "action.git.commit"),
        node("n_shot", "action.desktop.screenshot"),
      ],
    }
    expect(preflightCapabilities(wf, ["webview"])).toEqual([
      { nodeId: "n_git", kind: "action.git.commit", missing: ["shell"] },
      { nodeId: "n_shot", kind: "action.desktop.screenshot", missing: ["uia-automation"] },
    ])
  })

  it("skips annotation nodes (no execution)", () => {
    const wf = { nodes: [node("n_note", "annotation.note"), node("n_grp", "annotation.group")] }
    expect(preflightCapabilities(wf, [])).toEqual([])
  })

  it("honors restrictToNodeIds (single-node runs ignore unrelated nodes)", () => {
    const wf = { nodes: [node("n_git", "action.git.commit"), node("n_ai", "ai.prompt")] }
    expect(preflightCapabilities(wf, ["webview"], { restrictToNodeIds: ["n_ai"] })).toEqual([])
    expect(preflightCapabilities(wf, ["webview"], { restrictToNodeIds: ["n_git"] })).toHaveLength(1)
  })

  it("honors seededNodeIds (pre-seeded outputs never execute)", () => {
    const wf = { nodes: [node("n_git", "action.git.commit")] }
    expect(preflightCapabilities(wf, ["webview"], { seededNodeIds: ["n_git"] })).toEqual([])
  })

  it("defaults to the local baseline (web under jsdom lacks shell)", () => {
    const wf = { nodes: [node("n_git", "action.git.commit")] }
    const failures = preflightCapabilities(wf)
    expect(failures).toEqual([{ nodeId: "n_git", kind: "action.git.commit", missing: ["shell"] }])
  })
})

describe("formatPreflightFailures", () => {
  it("enumerates every failing node with its missing capabilities", () => {
    const message = formatPreflightFailures([
      { nodeId: "n_a", kind: "action.git.commit", missing: ["shell"] },
      { nodeId: "n_b", kind: "action.terminal.session.run", missing: ["pty", "shell"] },
    ])
    expect(message).toContain("n_a (action.git.commit): shell")
    expect(message).toContain("n_b (action.terminal.session.run): pty, shell")
  })
})

describe("runWorkflow capability preflight integration", () => {
  // First getDb() + whenSeeded() on a fresh fake-indexeddb walks the full
  // schema ladder — comfortably over Jest's 5 s default on a busy machine.
  jest.setTimeout(30_000)

  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
    await getDb().workflowRuns.clear()
    await getDb().workflowRunEvents.clear()
    jest.clearAllMocks()
  })

  const trigger: TriggerEvent = {
    workflowId: "wf_cap",
    kind: "trigger.manual",
    payload: {},
    originAt: 1_700_000_000,
  }

  function buildWorkflow(nodes: VisualWorkflow["nodes"]): VisualWorkflow {
    return {
      id: "wf_cap",
      schemaVersion: 1,
      name: "Capability test workflow",
      createdAt: 0,
      updatedAt: 0,
      nodes,
      edges: [],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 60_000,
        concurrency: 1,
        retryDefaults: { attempts: 2, backoff: "fixed", baseMs: 0 },
      },
    }
  }

  it("fails a run at t=0 with a structured code when the platform lacks a capability", async () => {
    // jsdom has no Tauri marker → web baseline → no "shell".
    const wf = buildWorkflow([node("n_t", "trigger.manual"), node("n_git", "action.git.commit")])
    const result = await runWorkflow({ workflow: wf, trigger })

    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe(CAPABILITY_MISSING_CODE_PREFIX + "shell")
    expect(result.error?.nodeId).toBe("n_git")
    expect(result.error?.message).toContain("action.git.commit")

    const row = await getDb().workflowRuns.get(result.runId)
    expect(row?.status).toBe("failed")
    expect(row?.error?.code).toBe(CAPABILITY_MISSING_CODE_PREFIX + "shell")

    const events = await listRunEvents(result.runId)
    const failed = events.find((e) => e.type === "run_failed")
    expect(failed).toBeDefined()
    expect((failed?.payload as { code?: string }).code).toBe(
      CAPABILITY_MISSING_CODE_PREFIX + "shell"
    )
    // No step ever started.
    expect(events.some((e) => e.type === "step_started")).toBe(false)

    expect(mockHooksManager.dispatchWorkflowError).toHaveBeenCalled()
    expect(mockHooksManager.dispatchWorkflowComplete).toHaveBeenCalledWith("wf_cap", false)
  })

  it("runs capability-clean workflows unchanged on web", async () => {
    const wf = buildWorkflow([
      node("n_t", "trigger.manual"),
      {
        id: "n_set",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "set", params: { variable: "x", value: "1" } },
      },
    ])
    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")
  })
})
