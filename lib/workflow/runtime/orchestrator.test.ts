/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
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
    // Use a kind we know isn't registered yet (action.team.run lands in Phase 6).
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
          id: "n_team",
          type: "action.team.run",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "team", params: { teamId: "team_1", goal: "x" } },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_team" }]
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("failed")
    expect(r.error?.nodeId).toBe("n_team")
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
