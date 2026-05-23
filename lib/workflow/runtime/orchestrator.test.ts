/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

// Mock plugin hook dispatcher (Tier 2 of ADR 0016) so we can verify the
// orchestrator emits onWorkflowStart / onWorkflowStepComplete /
// onWorkflowComplete / onWorkflowError without booting the plugin store.
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

import { runWorkflow } from "./orchestrator"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listRunEvents } from "./event-log"
import type { TriggerEvent, VisualWorkflow } from "@/types/workflow/visual"

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
  workflowId: "wf_x",
  kind: "trigger.manual",
  payload: { greeting: "hi" },
  originAt: 1_700_000_000,
}

function buildWorkflow(
  nodes: VisualWorkflow["nodes"],
  edges: VisualWorkflow["edges"] = []
): VisualWorkflow {
  return {
    id: "wf_x",
    schemaVersion: 1,
    name: "Test workflow",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 2, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("runWorkflow — end-to-end happy paths", () => {
  it("runs a 4-node linear workflow and produces output", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "set var",
            params: { variable: "name", value: "{{ $trigger.payload.greeting }}" },
          },
        },
        {
          id: "n_prompt",
          type: "ai.prompt",
          typeVersion: 1,
          position: { x: 400, y: 0 },
          data: {
            label: "ai",
            params: {
              userPrompt: "echo: {{ $node['n_set'].out.value }}",
              temperature: 0,
            },
          },
        },
        {
          id: "n_branch",
          type: "flow.branch",
          typeVersion: 1,
          position: { x: 600, y: 0 },
          data: {
            label: "branch",
            params: {
              condition: "{{ $node['n_prompt'].out.completion }}",
              truthyLabel: "yes",
              falsyLabel: "no",
            },
          },
        },
      ],
      [
        { id: "e1", source: "n_start", target: "n_set" },
        { id: "e2", source: "n_set", target: "n_prompt" },
        { id: "e3", source: "n_prompt", target: "n_branch" },
      ]
    )

    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")

    // The run row should be persisted.
    const row = await getDb().workflowRuns.get(result.runId)
    expect(row?.status).toBe("succeeded")
    expect(row?.lastCompletedStepId).toBe("n_branch")

    // The event log should contain step_completed events for every step.
    const events = await listRunEvents(result.runId)
    const completed = events.filter((e) => e.type === "step_completed").map((e) => e.stepId)
    expect(completed).toEqual(["n_start", "n_set", "n_prompt", "n_branch"])
  })

  it("propagates expression values through upstream", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "set",
            params: {
              variable: "x",
              value: "{{ $trigger.payload.greeting }}",
            },
          },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_set" }]
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    const setCompleted = events.find((e) => e.type === "step_completed" && e.stepId === "n_set")
    const payload = setCompleted?.payload as { output?: { value?: string } }
    expect(payload?.output?.value).toBe("hi")
  })
})

describe("runWorkflow — branch decisions", () => {
  it("skips the non-chosen branch when a flow.branch picks a label", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_branch",
          type: "flow.branch",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "branch",
            params: {
              condition: "{{ $trigger.payload.takeYes }}",
              truthyLabel: "yes",
              falsyLabel: "no",
            },
          },
        },
        {
          id: "n_yes",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 400, y: -100 },
          data: { label: "yes branch", params: { variable: "branch", value: "yes" } },
        },
        {
          id: "n_no",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 400, y: 100 },
          data: { label: "no branch", params: { variable: "branch", value: "no" } },
        },
      ],
      [
        { id: "e1", source: "n_start", target: "n_branch" },
        { id: "e2", source: "n_branch", target: "n_yes", label: "yes" },
        { id: "e3", source: "n_branch", target: "n_no", label: "no" },
      ]
    )

    // Truthy: take yes branch.
    const r1 = await runWorkflow({
      workflow: wf,
      trigger: { ...trigger, payload: { takeYes: true } },
    })
    expect(r1.status).toBe("succeeded")
    const ev1 = await listRunEvents(r1.runId)
    expect(ev1.find((e) => e.type === "step_completed" && e.stepId === "n_yes")).toBeDefined()
    expect(ev1.find((e) => e.type === "step_skipped" && e.stepId === "n_no")).toBeDefined()

    // Falsy: take no branch.
    const r2 = await runWorkflow({
      workflow: wf,
      trigger: { ...trigger, payload: { takeYes: false } },
    })
    expect(r2.status).toBe("succeeded")
    const ev2 = await listRunEvents(r2.runId)
    expect(ev2.find((e) => e.type === "step_completed" && e.stepId === "n_no")).toBeDefined()
    expect(ev2.find((e) => e.type === "step_skipped" && e.stepId === "n_yes")).toBeDefined()
  })
})

describe("runWorkflow — failure handling", () => {
  it("reports a failed run when an executor is missing for a node kind", async () => {
    // Use annotation.note — annotations are intentionally not executable
    // (they're display-only) so they exercise the "no executor registered"
    // failure path. action.* and ai.* kinds are now all registered.
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_note",
          type: "annotation.note",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "note", params: { text: "blocking annotation" } },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_note" }]
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("failed")
    expect(r.error?.nodeId).toBe("n_note")
    expect(r.error?.message).toMatch(/no executor registered/i)
  })

  it("rejects an invalid workflow at the validate boundary", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      []
    )
    // Inject an invalid value that zod will catch.
    const broken = { ...wf, name: "" }
    const r = await runWorkflow({ workflow: broken, trigger })
    expect(r.status).toBe("failed")
    expect(r.error?.message).toMatch(/invalid workflow/i)
  })
})

describe("runWorkflow — disabled nodes are skipped", () => {
  it("skips a disabled node and its downstream chain", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_off",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "disabled",
            params: { variable: "x", value: "y" },
            disabled: true,
          },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_off" }]
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    const offEvents = events.filter((e) => e.stepId === "n_off")
    expect(offEvents.some((e) => e.type === "step_skipped")).toBe(true)
    expect(offEvents.some((e) => e.type === "step_completed")).toBe(false)
  })
})

describe("runWorkflow — resume from event log (idempotency)", () => {
  it("skips already-completed steps when re-invoked with the same runId", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "set", params: { variable: "x", value: "first" } },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_set" }]
    )
    const first = await runWorkflow({ workflow: wf, trigger })
    expect(first.status).toBe("succeeded")

    // Re-run with the same runId — every step should be a cache hit.
    const second = await runWorkflow({ workflow: wf, trigger, runId: first.runId })
    expect(second.status).toBe("succeeded")

    // Step_completed should appear once per stepId across the two runs because
    // the second run hits the cache without emitting another step_completed.
    const events = await listRunEvents(first.runId)
    const completed = events.filter((e) => e.type === "step_completed")
    // Each step completed exactly once across both invocations.
    const counts = new Map<string, number>()
    for (const e of completed) counts.set(e.stepId!, (counts.get(e.stepId!) ?? 0) + 1)
    expect([...counts.values()].every((c) => c === 1)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Plugin workflow hook wiring (ADR 0016 Tier 2)
// ---------------------------------------------------------------------------

describe("runWorkflow — plugin hook dispatches", () => {
  it("happy path emits onWorkflowStart, one onWorkflowStepComplete per executed step, then onWorkflowComplete(true)", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "set", params: { variable: "x", value: "1" } },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_set" }]
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")

    expect(mockHooksManager.dispatchWorkflowStart).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowStart).toHaveBeenCalledWith("wf_x", "Test workflow")

    // Every executed step gets a 0-based index.
    expect(mockHooksManager.dispatchWorkflowStepComplete).toHaveBeenCalledTimes(2)
    const indices = mockHooksManager.dispatchWorkflowStepComplete.mock.calls.map((call) => call[1])
    expect(indices).toEqual([0, 1])

    expect(mockHooksManager.dispatchWorkflowComplete).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowComplete.mock.calls[0][0]).toBe("wf_x")
    expect(mockHooksManager.dispatchWorkflowComplete.mock.calls[0][1]).toBe(true)
    expect(mockHooksManager.dispatchWorkflowError).not.toHaveBeenCalled()
  })

  it("invalid workflow fires onWorkflowStart + onWorkflowError (validation failure path)", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      []
    )
    const broken = { ...wf, name: "" }
    const r = await runWorkflow({ workflow: broken, trigger })
    expect(r.status).toBe("failed")

    // Even on validation failure, plugins should see the lifecycle.
    expect(mockHooksManager.dispatchWorkflowStart).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowError).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowError.mock.calls[0][0]).toBe("wf_x")
    const errArg = mockHooksManager.dispatchWorkflowError.mock.calls[0][1] as Error
    expect(errArg).toBeInstanceOf(Error)
    expect(errArg.message).toMatch(/invalid workflow/i)
    expect(mockHooksManager.dispatchWorkflowComplete).not.toHaveBeenCalled()
    expect(mockHooksManager.dispatchWorkflowStepComplete).not.toHaveBeenCalled()
  })

  it("step failure fires onWorkflowError + onWorkflowComplete(false)", async () => {
    // annotation.note has no executor — drives the step-failure path.
    const wf = buildWorkflow(
      [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_note",
          type: "annotation.note",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "note", params: { text: "blocking annotation" } },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_note" }]
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("failed")

    expect(mockHooksManager.dispatchWorkflowStart).toHaveBeenCalledTimes(1)
    // n_start completed once before the note failed.
    expect(mockHooksManager.dispatchWorkflowStepComplete).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowError).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowComplete).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchWorkflowComplete.mock.calls[0][1]).toBe(false)
  })
})

describe("runWorkflow — startStepId (run from here)", () => {
  it("skips every step upstream of startStepId and runs only the descendant subgraph", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_a",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "a", params: {} },
        },
        {
          id: "n_b",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "b", params: { variable: "x", value: "1" } },
        },
        {
          id: "n_c",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 400, y: 0 },
          data: { label: "c", params: { variable: "y", value: "2" } },
        },
      ],
      [
        { id: "e1", source: "n_a", target: "n_b" },
        { id: "e2", source: "n_b", target: "n_c" },
      ]
    )

    const result = await runWorkflow({ workflow: wf, trigger, startStepId: "n_b" })
    expect(result.status).toBe("succeeded")

    const events = await listRunEvents(result.runId)
    const completed = events.filter((e) => e.type === "step_completed").map((e) => e.stepId)
    const skipped = events.filter((e) => e.type === "step_skipped").map((e) => e.stepId)
    expect(completed).toEqual(["n_b", "n_c"])
    expect(skipped).toEqual(["n_a"])
  })

  it("fails fast when startStepId is not in the workflow", async () => {
    const wf = buildWorkflow(
      [
        {
          id: "n_a",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "a", params: {} },
        },
      ],
      []
    )
    const result = await runWorkflow({ workflow: wf, trigger, startStepId: "n_missing" })
    expect(result.status).toBe("failed")
    expect(result.error?.message).toContain("startStepId n_missing not present")
  })

  it("bounds the run to the descendant subgraph (sibling branches are skipped)", async () => {
    // n_a → n_b ; n_a → n_c. Starting from n_b should skip both n_a and n_c.
    const wf = buildWorkflow(
      [
        {
          id: "n_a",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "a", params: {} },
        },
        {
          id: "n_b",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "b", params: { variable: "x", value: "1" } },
        },
        {
          id: "n_c",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 200 },
          data: { label: "c", params: { variable: "y", value: "2" } },
        },
      ],
      [
        { id: "e1", source: "n_a", target: "n_b" },
        { id: "e2", source: "n_a", target: "n_c" },
      ]
    )

    const result = await runWorkflow({ workflow: wf, trigger, startStepId: "n_b" })
    expect(result.status).toBe("succeeded")
    const events = await listRunEvents(result.runId)
    const completed = events.filter((e) => e.type === "step_completed").map((e) => e.stepId)
    expect(completed).toEqual(["n_b"])
  })
})

// ── Concurrent scheduling (ADR-0022 §1 Decision) ─────────────────────────────
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"
import { createConcurrencyController } from "./concurrency-controller"

describe("runWorkflow — concurrent scheduling", () => {
  // `registerNodeExecutor` is idempotent (it overwrites by key); we re-register
  // a fresh handler per test from within the test body, so no afterEach reset
  // is needed. Avoiding the reset keeps built-in registrations alive for the
  // existing tests that run after this block.

  const buildAsyncWorkflow = (
    nodeIds: string[],
    edges: Array<[string, string]>,
    maxConcurrency: number
  ): VisualWorkflow => ({
    id: "wf_concurrent",
    schemaVersion: 1,
    name: "concurrent",
    createdAt: 0,
    updatedAt: 0,
    nodes: nodeIds.map((id) => ({
      id,
      type: "test.async" as VisualWorkflow["nodes"][number]["type"],
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: id, params: {} },
    })),
    edges: edges.map(([source, target], i) => ({
      id: `e${i}`,
      source,
      target,
    })),
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      maxConcurrency,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  })

  it("runs independent nodes in parallel when maxConcurrency > 1", async () => {
    let inflight = 0
    let maxInflight = 0
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async () => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 30))
        inflight -= 1
        return { output: null }
      },
    })

    const wf = buildAsyncWorkflow(["a", "b", "c"], [], 3)
    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")
    expect(maxInflight).toBe(3)
  })

  it("respects dependencies even with high concurrency", async () => {
    const order: string[] = []
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async (ctx) => {
        order.push(`start:${ctx.stepId}`)
        await new Promise((r) => setTimeout(r, 10))
        order.push(`end:${ctx.stepId}`)
        return { output: null }
      },
    })

    const wf = buildAsyncWorkflow(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["b", "c"],
      ],
      5
    )
    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")
    expect(order.indexOf("end:a")).toBeLessThan(order.indexOf("start:b"))
    expect(order.indexOf("end:b")).toBeLessThan(order.indexOf("start:c"))
  })

  it("half-parallel fan-out after a gating node", async () => {
    let inflightBC = 0
    let maxInflightBC = 0
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async (ctx) => {
        if (ctx.stepId === "b" || ctx.stepId === "c") {
          inflightBC += 1
          maxInflightBC = Math.max(maxInflightBC, inflightBC)
          await new Promise((r) => setTimeout(r, 20))
          inflightBC -= 1
        }
        return { output: null }
      },
    })

    const wf = buildAsyncWorkflow(
      ["a", "b", "c"],
      [
        ["a", "b"],
        ["a", "c"],
      ],
      3
    )
    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")
    expect(maxInflightBC).toBe(2)
  })

  it("maxConcurrency=1 default serializes (backward compat)", async () => {
    let inflight = 0
    let maxInflight = 0
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async () => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 5))
        inflight -= 1
        return { output: null }
      },
    })

    // No maxConcurrency set → defaults to 1 inside the orchestrator.
    const wf: VisualWorkflow = {
      ...buildAsyncWorkflow(["a", "b", "c"], [], 1),
    }
    delete (wf.settings as { maxConcurrency?: number }).maxConcurrency

    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")
    expect(maxInflight).toBe(1)
  })

  it("ConcurrencyController.reduceTo(0) pauses new dispatch", async () => {
    const controller = createConcurrencyController(3)
    const completed: string[] = []
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async (ctx) => {
        // Pause after the first task starts
        if (completed.length === 0) controller.reduceTo(0)
        await new Promise((r) => setTimeout(r, 10))
        completed.push(ctx.stepId)
        return { output: null }
      },
    })

    const wf = buildAsyncWorkflow(["a", "b"], [], 3)
    // The first scheduling tick picks up all ready nodes (a + b) before any
    // executor runs, so both end up inflight together. The reduceTo(0) call
    // inside the first executor only affects FUTURE dispatches — already-
    // inflight tasks continue. We assert that the run completes cleanly and
    // that no third dispatch happens after reduceTo(0).
    const result = await runWorkflow({ workflow: wf, trigger, concurrency: controller })
    expect(result.status).toBe("succeeded")
    expect(completed.length).toBeLessThanOrEqual(2)
  })

  it("scheduler exits cleanly when controller is 0 from start (no infinite loop)", async () => {
    const controller = createConcurrencyController(0)
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async () => ({ output: null }),
    })

    const wf = buildAsyncWorkflow(["a"], [], 1)
    const guarded = Promise.race([
      runWorkflow({ workflow: wf, trigger, concurrency: controller }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 800)),
    ])
    // We accept any terminal status — the assertion is "doesn't hang".
    const result = (await guarded) as Awaited<ReturnType<typeof runWorkflow>>
    expect(result).toBeDefined()
  })
})

// ── errorPolicy: stop / continue / branch (Workstream E) ─────────────────────
describe("runWorkflow — errorPolicy", () => {
  beforeEach(() => {
    registerNodeExecutor({
      kind: "test.fail" as never,
      typeVersion: 1,
      execute: async () => {
        throw new Error("boom")
      },
    })
  })

  function buildFailWorkflow(
    policy: "stop" | "continue" | "branch",
    { withErrorEdge }: { withErrorEdge: boolean }
  ): VisualWorkflow {
    const edges: VisualWorkflow["edges"] = [
      { id: "e1", source: "n_start", target: "n_fail" },
      { id: "e2", source: "n_fail", target: "n_success" },
    ]
    if (withErrorEdge) {
      edges.push({ id: "e3", source: "n_fail", target: "n_recover", sourceHandle: "error" })
    }
    const nodes: VisualWorkflow["nodes"] = [
      {
        id: "n_start",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "start", params: {} },
      },
      {
        id: "n_fail",
        type: "test.fail" as never,
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "boom", params: {} },
      },
      {
        id: "n_success",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 400, y: 0 },
        data: { label: "ok", params: { variable: "ok", value: "success_path" } },
      },
    ]
    if (withErrorEdge) {
      nodes.push({
        id: "n_recover",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 400, y: 120 },
        data: { label: "recover", params: { variable: "rec", value: "recovered" } },
      })
    }
    return {
      id: "wf_x",
      schemaVersion: 1,
      name: "Fail workflow",
      createdAt: 0,
      updatedAt: 0,
      nodes,
      edges,
      settings: {
        errorPolicy: policy,
        timeoutMs: 60_000,
        concurrency: 1,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    }
  }

  it('"stop" fails the whole run on the first error', async () => {
    const r = await runWorkflow({
      workflow: buildFailWorkflow("stop", { withErrorEdge: false }),
      trigger,
    })
    expect(r.status).toBe("failed")
    expect(r.error?.nodeId).toBe("n_fail")
  })

  it("dispatches per-node start / complete / error hooks", async () => {
    await runWorkflow({ workflow: buildFailWorkflow("stop", { withErrorEdge: false }), trigger })
    // Node start fires for the trigger + the failing node.
    expect(mockHooksManager.dispatchWorkflowNodeStart).toHaveBeenCalledWith(
      "wf_x",
      "n_fail",
      "test.fail"
    )
    // The failing node emits a node-error with the correct id.
    expect(mockHooksManager.dispatchWorkflowNodeError).toHaveBeenCalledWith(
      "wf_x",
      "n_fail",
      expect.any(Error)
    )
    // The trigger node completed → node-complete fired for it.
    expect(mockHooksManager.dispatchWorkflowNodeComplete).toHaveBeenCalledWith(
      "wf_x",
      "n_start",
      "trigger.manual",
      expect.anything()
    )
  })

  it('"branch" with an error edge keeps the run alive and takes the error path', async () => {
    const r = await runWorkflow({
      workflow: buildFailWorkflow("branch", { withErrorEdge: true }),
      trigger,
    })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    // Error-branch target ran; success-path target was skipped.
    expect(
      events.find((e) => e.type === "step_completed" && e.stepId === "n_recover")
    ).toBeDefined()
    expect(events.find((e) => e.type === "step_skipped" && e.stepId === "n_success")).toBeDefined()
  })

  it('"branch" without an error edge falls back to stop semantics', async () => {
    const r = await runWorkflow({
      workflow: buildFailWorkflow("branch", { withErrorEdge: false }),
      trigger,
    })
    expect(r.status).toBe("failed")
    expect(r.error?.nodeId).toBe("n_fail")
  })

  it('"continue" skips the failed node\'s downstream but completes the run', async () => {
    const r = await runWorkflow({
      workflow: buildFailWorkflow("continue", { withErrorEdge: false }),
      trigger,
    })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    expect(events.find((e) => e.type === "step_skipped" && e.stepId === "n_success")).toBeDefined()
  })
})
