/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { appendEvent } from "./event-log"
import { listPendingApprovals, respondToApproval } from "./approval-registry"
import {
  RISK_GATE_CHECKPOINT_KEY,
  RiskGateRejected,
  applyNodeRiskGate,
  hasAncestorApproval,
  isInteractiveRun,
  isRiskGatingEnabled,
} from "./risk-gate"

const notifyRequested = jest.fn().mockResolvedValue(undefined)
jest.mock("./approval-notify", () => ({
  notifyApprovalRequested: (...a: unknown[]) => notifyRequested(...a),
  notifyApprovalResolved: jest.fn(),
}))

// Overridable seams for the failure branches. `null` = delegate to the real
// implementation, so every other test in this file exercises the real thing.
const seam: {
  subscribeWake: null | (() => Promise<unknown>)
  listRunEvents: null | (() => Promise<unknown>)
  appendEvent: null | (() => Promise<unknown>)
} = { subscribeWake: null, listRunEvents: null, appendEvent: null }

jest.mock("./wake-bus", () => {
  const actual = jest.requireActual("./wake-bus")
  return {
    ...actual,
    subscribeWake: (...a: unknown[]) =>
      seam.subscribeWake ? seam.subscribeWake() : actual.subscribeWake(...a),
  }
})

jest.mock("./event-log", () => {
  const actual = jest.requireActual("./event-log")
  return {
    ...actual,
    listRunEvents: (...a: unknown[]) =>
      seam.listRunEvents ? seam.listRunEvents() : actual.listRunEvents(...a),
    appendEvent: (...a: unknown[]) =>
      seam.appendEvent ? seam.appendEvent() : actual.appendEvent(...a),
  }
})

const node = (id: string, type: string): WorkflowNode =>
  ({ id, type, typeVersion: 1, position: { x: 0, y: 0 }, params: {} }) as unknown as WorkflowNode

const workflow = (over: Partial<VisualWorkflow> = {}): VisualWorkflow =>
  ({
    id: "wf1",
    schemaVersion: 2,
    name: "W",
    nodes: [node("n1", "action.desktop.performAction")],
    edges: [],
    settings: { riskGating: true },
    ...over,
  }) as unknown as VisualWorkflow

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  notifyRequested.mockClear()
  seam.subscribeWake = null
  seam.listRunEvents = null
  seam.appendEvent = null
  for (const p of listPendingApprovals())
    respondToApproval(p.approvalId, {
      decision: "rejected",
      respondedBy: "cleanup",
    })
})

describe("isRiskGatingEnabled — migration decision", () => {
  it("is OFF for a workflow with no field (authored before ADR-0070)", () => {
    // Opt-in by design: flipping this on retroactively would start failing
    // automations users already rely on.
    expect(isRiskGatingEnabled({ settings: {} } as never)).toBe(false)
  })

  it("is ON only when explicitly true", () => {
    expect(isRiskGatingEnabled({ settings: { riskGating: true } } as never)).toBe(true)
    expect(isRiskGatingEnabled({ settings: { riskGating: false } } as never)).toBe(false)
  })
})

describe("isInteractiveRun", () => {
  it("treats an absent trigger as a plain UI run", () => {
    expect(isInteractiveRun(undefined)).toBe(true)
  })

  it.each(["ui", "desktop", "chat"] as const)("%s is interactive", (source) => {
    expect(isInteractiveRun({ source } as never)).toBe(true)
  })

  it.each(["im", "api"] as const)("%s is headless", (source) => {
    expect(isInteractiveRun({ source } as never)).toBe(false)
  })
})

describe("hasAncestorApproval", () => {
  const wf = workflow({
    nodes: [
      node("a", "action.approval.request"),
      node("b", "flow.set"),
      node("risky", "action.desktop.performAction"),
      node("orphan", "action.system.terminal"),
    ],
    edges: [
      { id: "e1", source: "a", target: "b" },
      { id: "e2", source: "b", target: "risky" },
    ] as never,
  })

  it("finds an approval node transitively upstream", () => {
    expect(hasAncestorApproval(wf, "risky")).toBe(true)
  })

  it("returns false for a node with no approval ancestor", () => {
    expect(hasAncestorApproval(wf, "orphan")).toBe(false)
  })
})

describe("applyNodeRiskGate", () => {
  it("returns immediately for a low-risk node — no registry entry, no checkpoint", async () => {
    await applyNodeRiskGate({
      workflow: workflow({ nodes: [node("n1", "flow.set")] }),
      node: node("n1", "flow.set"),
      runId: "r1",
    })
    expect(listPendingApprovals()).toHaveLength(0)
    expect(notifyRequested).not.toHaveBeenCalled()
  })

  it("returns immediately when the workflow has gating off", async () => {
    await applyNodeRiskGate({
      workflow: workflow({ settings: { riskGating: false } } as never),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
    })
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it("does not double-gate a node already covered by an approval node", async () => {
    const wf = workflow({
      nodes: [node("a", "action.approval.request"), node("n1", "action.desktop.performAction")],
      edges: [{ id: "e1", source: "a", target: "n1" }] as never,
    })
    await applyNodeRiskGate({
      workflow: wf,
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
    })
    expect(notifyRequested).not.toHaveBeenCalled()
  })

  it("fails closed on a headless run, naming the surfaces", async () => {
    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        triggeredBy: { source: "im", adapterId: "a", conversationKey: "c" } as never,
      })
    ).rejects.toThrow(RiskGateRejected)

    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
        triggeredBy: { source: "im", adapterId: "a", conversationKey: "c" } as never,
      })
    ).rejects.toThrow(/computer-use/)
    // Fail-closed means it never registered a modal nobody would see.
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it("blocks interactively, then proceeds once approved", async () => {
    const p = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
    })
    await new Promise((r) => setTimeout(r, 20))
    const pending = listPendingApprovals()
    expect(pending).toHaveLength(1)
    expect(pending[0].message).toMatch(/computer-use/)
    expect(notifyRequested).toHaveBeenCalledTimes(1)

    respondToApproval(pending[0].approvalId, { decision: "approved", respondedBy: "alice" })
    await expect(p).resolves.toBeUndefined()
    // The entry is always cleaned up.
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it("throws when the human rejects", async () => {
    const p = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
    })
    await new Promise((r) => setTimeout(r, 20))
    const pending = listPendingApprovals()
    respondToApproval(pending[0].approvalId, { decision: "rejected", respondedBy: "alice" })
    await expect(p).rejects.toThrow(/rejected by alice/)
  })

  it("re-arms after a crash-resume WITHOUT re-notifying", async () => {
    // Mirror of the approval node's resume contract: a re-entered step must not
    // push the human a second copy of a question they already have.
    await appendEvent({
      runId: "r1",
      stepId: "n1",
      type: "step.long_running.checkpoint",
      payload: {
        checkpointKey: RISK_GATE_CHECKPOINT_KEY,
        state: { approvalId: "r1:n1", requestedAt: Date.now() },
      },
    })
    const p = applyNodeRiskGate({
      workflow: workflow(),
      node: node("n1", "action.desktop.performAction"),
      runId: "r1",
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(listPendingApprovals()).toHaveLength(1)
    expect(notifyRequested).not.toHaveBeenCalled()

    const pending = listPendingApprovals()
    respondToApproval(pending[0].approvalId, { decision: "approved", respondedBy: "bob" })
    await expect(p).resolves.toBeUndefined()
  })

  describe("failure branches", () => {
    it("treats an unreadable event log as a fresh gate rather than crashing", async () => {
      seam.listRunEvents = () => Promise.reject(new Error("no event log"))
      const p = applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
      })
      await new Promise((r) => setTimeout(r, 20))
      expect(listPendingApprovals()).toHaveLength(1)
      respondToApproval(listPendingApprovals()[0].approvalId, {
        decision: "approved",
        respondedBy: "alice",
      })
      await expect(p).resolves.toBeUndefined()
    })

    it("still gates when the checkpoint cannot be persisted", async () => {
      // Losing crash-resumability is bad; silently skipping the gate is worse.
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      seam.appendEvent = () => Promise.reject(new Error("disk full"))
      const p = applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
      })
      await new Promise((r) => setTimeout(r, 20))
      expect(listPendingApprovals()).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
      respondToApproval(listPendingApprovals()[0].approvalId, {
        decision: "approved",
        respondedBy: "alice",
      })
      await expect(p).resolves.toBeUndefined()
      warn.mockRestore()
    })

    it("rejects when the wait times out", async () => {
      seam.subscribeWake = () => Promise.reject(new Error("wake bus: timed out after 5ms"))
      await expect(
        applyNodeRiskGate({
          workflow: workflow(),
          node: node("n1", "action.desktop.performAction"),
          runId: "r1",
        })
      ).rejects.toThrow(/timed out unanswered/)
      expect(listPendingApprovals()).toHaveLength(0)
    })

    it("propagates a non-timeout wake error unchanged (e.g. run cancelled)", async () => {
      seam.subscribeWake = () => Promise.reject(new Error("wake bus: aborted"))
      await expect(
        applyNodeRiskGate({
          workflow: workflow(),
          node: node("n1", "action.desktop.performAction"),
          runId: "r1",
        })
      ).rejects.toThrow(/aborted/)
      // An abort is not a rejection — it must not masquerade as one.
      expect(listPendingApprovals()).toHaveLength(0)
    })
  })

  it("rejects rather than passing when the original budget already expired", async () => {
    await appendEvent({
      runId: "r1",
      stepId: "n1",
      type: "step.long_running.checkpoint",
      payload: {
        checkpointKey: RISK_GATE_CHECKPOINT_KEY,
        state: { approvalId: "r1:n1", requestedAt: Date.now() - 7_200_000 },
      },
    })
    await expect(
      applyNodeRiskGate({
        workflow: workflow(),
        node: node("n1", "action.desktop.performAction"),
        runId: "r1",
      })
    ).rejects.toThrow(/expired unanswered/)
  })
})
