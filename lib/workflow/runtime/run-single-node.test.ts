jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: jest.fn(() => ({
    dispatchWorkflowStart: jest.fn(),
    dispatchWorkflowStepComplete: jest.fn(),
    dispatchWorkflowComplete: jest.fn(),
    dispatchWorkflowError: jest.fn(),
    dispatchWorkflowNodeStart: jest.fn(),
    dispatchWorkflowNodeComplete: jest.fn(),
    dispatchWorkflowNodeError: jest.fn(),
    dispatchWorkflowTriggerFired: jest.fn(),
  })),
}))

import { runSingleNode, ancestorsOf } from "./run-single-node"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listRunEvents } from "./event-log"
import type { VisualWorkflow } from "@/types/workflow/visual"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

function setNode(id: string, value: unknown): VisualWorkflow["nodes"][number] {
  return {
    id,
    type: "flow.set",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: { variable: id, value } },
  }
}

function chainWorkflow(): VisualWorkflow {
  // n_a → n_b → n_c, each copying its upstream's value.
  return {
    id: "wf_x",
    schemaVersion: 1,
    name: "chain",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      setNode("n_a", "A"),
      setNode("n_b", "{{ $node['n_a'].value }}"),
      setNode("n_c", "{{ $node['n_b'].value }}"),
    ],
    edges: [
      { id: "e1", source: "n_a", target: "n_b" },
      { id: "e2", source: "n_b", target: "n_c" },
    ],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("ancestorsOf", () => {
  it("returns all transitive ancestors, excluding the node itself", () => {
    const wf = chainWorkflow()
    expect([...ancestorsOf(wf, "n_c")].sort()).toEqual(["n_a", "n_b"])
    expect([...ancestorsOf(wf, "n_b")]).toEqual(["n_a"])
    expect([...ancestorsOf(wf, "n_a")]).toEqual([])
  })

  it("handles a diamond (a node with multiple incoming edges)", () => {
    const wf: VisualWorkflow = {
      ...chainWorkflow(),
      nodes: [setNode("n_a", "a"), setNode("n_b", "b"), setNode("n_c", "c"), setNode("n_d", "d")],
      edges: [
        { id: "e1", source: "n_a", target: "n_b" },
        { id: "e2", source: "n_a", target: "n_c" },
        { id: "e3", source: "n_b", target: "n_d" },
        { id: "e4", source: "n_c", target: "n_d" },
      ],
    }
    expect([...ancestorsOf(wf, "n_d")].sort()).toEqual(["n_a", "n_b", "n_c"])
  })
})

describe("runSingleNode", () => {
  it("executes only the target, seeding ancestors from latest-run outputs", async () => {
    const wf = chainWorkflow()
    const r = await runSingleNode({
      workflow: wf,
      nodeId: "n_c",
      latestOutputs: { n_a: { value: "A1" }, n_b: { value: "B1" } },
    })
    expect(r.status).toBe("succeeded")
    // n_c consumed the seeded n_b value.
    expect((r.output as { value?: string }).value).toBe("B1")

    const events = await listRunEvents(r.runId)
    const completed = new Set(
      events.filter((e) => e.type === "step_completed").map((e) => e.stepId)
    )
    // Only the target executed; seeded ancestors cache-hit (no completion event).
    expect(completed.has("n_c")).toBe(true)
    expect(completed.has("n_a")).toBe(false)
    expect(completed.has("n_b")).toBe(false)
  })

  it("executes ancestors that have no seed data", async () => {
    const wf = chainWorkflow()
    const r = await runSingleNode({ workflow: wf, nodeId: "n_c", latestOutputs: {} })
    expect(r.status).toBe("succeeded")
    // With no seed data, the whole ancestor chain runs and the value propagates.
    expect((r.output as { value?: string }).value).toBe("A")

    const events = await listRunEvents(r.runId)
    const completed = new Set(
      events.filter((e) => e.type === "step_completed").map((e) => e.stepId)
    )
    expect(completed.has("n_a")).toBe(true)
    expect(completed.has("n_b")).toBe(true)
    expect(completed.has("n_c")).toBe(true)
  })

  it("falls back to reading latest-run outputs from the event log", async () => {
    // No `latestOutputs` override → exercises the getLatestRunOutputs path.
    const r = await runSingleNode({ workflow: chainWorkflow(), nodeId: "n_a" })
    expect(r.status).toBe("succeeded")
    // n_a is not a terminal node, so the run output is empty; assert the node
    // itself actually executed via its step_completed event.
    const events = await listRunEvents(r.runId)
    const completed = events.find((e) => e.type === "step_completed" && e.stepId === "n_a")
    expect((completed?.payload as { output?: { value?: string } })?.output?.value).toBe("A")
  })

  it("prefers pinned ancestor data over latest-run outputs", async () => {
    const wf: VisualWorkflow = { ...chainWorkflow(), pinData: { n_b: { value: "PINNED" } } }
    const r = await runSingleNode({
      workflow: wf,
      nodeId: "n_c",
      latestOutputs: { n_b: { value: "FROM_RUN" } },
    })
    expect(r.status).toBe("succeeded")
    expect((r.output as { value?: string }).value).toBe("PINNED")
  })
})
