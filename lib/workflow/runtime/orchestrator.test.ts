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

// Run-scoped terminal-session cleanup — the orchestrator must close
// whatever a run opened on EVERY terminal path (success + failure).
const mockCloseRunSessions = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/headless-session-registry", () => ({
  closeRunSessions: (...args: unknown[]) => mockCloseRunSessions(...args),
}))

// LLM client used by the ai.prompt node once a real apiKey is resolved. Capture
// the opts so we can assert the resolved keyring value flowed through.
const createLlmClientMock = jest.fn((_opts: { apiKey?: string }) => ({
  complete: async () => "REAL-COMPLETION",
  getUsageSnapshot: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
}))
jest.mock("@/lib/twin/distill/llm", () => ({
  createLlmClient: (opts: { apiKey?: string }) => createLlmClientMock(opts),
}))

// Stand in for the production keyring-backed default resolver (real branch is
// covered by secret-resolver-keyring.test.ts). Proves the orchestrator now
// falls back to getDefaultSecretResolver() when no resolver is passed.
jest.mock("./secret-resolver-keyring", () => ({
  getDefaultSecretResolver: () => ({
    resolve: async (ref: string) => (ref === "keyring:openai:key" ? "sk-test" : undefined),
  }),
}))

// Chained-trigger fanout (ADR-0081) — the orchestrator must announce every
// REAL terminal state (and suppress partial/catch runs). Mocked so no chained
// dispatch actually runs; behavior is covered in workflow-completion-fanout.test.ts.
const mockEmitCompletionFanout = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./workflow-completion-fanout", () => ({
  emitWorkflowCompletedFanout: (...args: unknown[]) => mockEmitCompletionFanout(...args),
}))

/** Flush the orchestrator's fire-and-forget fanout (dynamic import + then). */
async function flushFanout(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

import { runWorkflow } from "./orchestrator"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { listRunEvents } from "./event-log"
import type { TriggerEvent, VisualWorkflow } from "@/types/workflow/visual"

// Cold-opening the full schema ladder on fresh fake-indexeddb regularly
// exceeds Jest's 5 s default on a busy machine (grew again with v95–v98).
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

  it("uses the default keyring resolver so an ai.prompt credentialRef makes a real call (not a stub)", async () => {
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
          id: "n_prompt",
          type: "ai.prompt",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "ai",
            params: {
              provider: "openai",
              model: "gpt-4o-mini",
              userPrompt: "hi",
              temperature: 0,
              // No inline apiKey — must resolve through the keyring credential ref.
              credentialRefs: { apiKey: "keyring:openai:key" },
            },
          },
        },
      ],
      [{ id: "e1", source: "n_start", target: "n_prompt" }]
    )

    // Note: no `secretResolver` passed → orchestrator falls back to
    // getDefaultSecretResolver() (mocked above).
    const result = await runWorkflow({ workflow: wf, trigger })

    expect(result.status).toBe("succeeded")
    const out = result.output as { completion?: string; stub?: boolean }
    expect(out.completion).toBe("REAL-COMPLETION")
    expect(out.stub).toBe(false)
    // The resolved keyring value reached the LLM client.
    expect(createLlmClientMock).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-test" }))
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

  it("routes a v2 branch by sourceHandle even when edges carry custom labels", async () => {
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
          typeVersion: 2,
          position: { x: 200, y: 0 },
          data: {
            label: "branch v2",
            params: {
              conditions: {
                combinator: "all",
                conditions: [{ left: "{{ $trigger.payload.count }}", operator: "gt", right: "5" }],
              },
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
        // Custom display labels must NOT override sourceHandle routing.
        { id: "e2", source: "n_branch", sourceHandle: "true", target: "n_yes", label: "happy" },
        { id: "e3", source: "n_branch", sourceHandle: "false", target: "n_no", label: "sad" },
      ]
    )

    // count=10 > 5 → group passes → "true" handle.
    const r1 = await runWorkflow({
      workflow: wf,
      trigger: { ...trigger, payload: { count: 10 } },
    })
    expect(r1.status).toBe("succeeded")
    const ev1 = await listRunEvents(r1.runId)
    expect(ev1.find((e) => e.type === "step_completed" && e.stepId === "n_yes")).toBeDefined()
    expect(ev1.find((e) => e.type === "step_skipped" && e.stepId === "n_no")).toBeDefined()

    // count=3 → group fails → "false" handle.
    const r2 = await runWorkflow({
      workflow: wf,
      trigger: { ...trigger, payload: { count: 3 } },
    })
    expect(r2.status).toBe("succeeded")
    const ev2 = await listRunEvents(r2.runId)
    expect(ev2.find((e) => e.type === "step_completed" && e.stepId === "n_no")).toBeDefined()
    expect(ev2.find((e) => e.type === "step_skipped" && e.stepId === "n_yes")).toBeDefined()
  })

  it("routes a v2 switch by case id handles with default fall-through", async () => {
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
          id: "n_switch",
          type: "flow.switch",
          typeVersion: 2,
          position: { x: 200, y: 0 },
          data: {
            label: "switch v2",
            params: {
              cases: [
                {
                  id: "c_small",
                  label: "Small",
                  when: {
                    combinator: "all",
                    conditions: [{ left: "{{ $trigger.payload.n }}", operator: "lt", right: "10" }],
                  },
                },
              ],
            },
          },
        },
        {
          id: "n_small",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 400, y: -100 },
          data: { label: "small", params: { variable: "size", value: "small" } },
        },
        {
          id: "n_default",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 400, y: 100 },
          data: { label: "default", params: { variable: "size", value: "other" } },
        },
      ],
      [
        { id: "e1", source: "n_start", target: "n_switch" },
        { id: "e2", source: "n_switch", sourceHandle: "c_small", target: "n_small" },
        { id: "e3", source: "n_switch", sourceHandle: "default", target: "n_default" },
      ]
    )

    const r1 = await runWorkflow({ workflow: wf, trigger: { ...trigger, payload: { n: 3 } } })
    expect(r1.status).toBe("succeeded")
    const ev1 = await listRunEvents(r1.runId)
    expect(ev1.find((e) => e.type === "step_completed" && e.stepId === "n_small")).toBeDefined()
    expect(ev1.find((e) => e.type === "step_skipped" && e.stepId === "n_default")).toBeDefined()

    const r2 = await runWorkflow({ workflow: wf, trigger: { ...trigger, payload: { n: 42 } } })
    expect(r2.status).toBe("succeeded")
    const ev2 = await listRunEvents(r2.runId)
    expect(ev2.find((e) => e.type === "step_completed" && e.stepId === "n_default")).toBeDefined()
    expect(ev2.find((e) => e.type === "step_skipped" && e.stepId === "n_small")).toBeDefined()
  })
})

describe("runWorkflow — loop container (flow.loop v2)", () => {
  it("delegates the container to the loop runtime and never schedules children top-level", async () => {
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
          id: "n_loop",
          type: "flow.loop",
          typeVersion: 2,
          position: { x: 200, y: 0 },
          data: {
            label: "loop",
            params: {
              mode: "forEach",
              source: "{{ $trigger.payload.list }}",
              output: "{{ $node['n_body'].value }}",
            },
          },
        },
        {
          id: "n_body",
          type: "flow.set",
          typeVersion: 1,
          parentId: "n_loop",
          position: { x: 10, y: 10 },
          data: { label: "body", params: { variable: "v", value: "{{ $item }}!" } },
        },
        {
          id: "n_after",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 400, y: 0 },
          data: {
            label: "after",
            params: { variable: "summary", value: "{{ $node['n_loop'].count }}" },
          },
        },
      ],
      [
        { id: "e1", source: "n_start", target: "n_loop" },
        { id: "e2", source: "n_loop", target: "n_after" },
      ]
    )

    const r = await runWorkflow({
      workflow: wf,
      trigger: { ...trigger, payload: { list: ["x", "y"] } },
    })
    expect(r.status).toBe("succeeded")
    // Terminal output is n_after's; the loop's count flowed through.
    expect(r.output).toMatchObject({ variable: "summary", value: 2 })

    const events = await listRunEvents(r.runId)
    const loopCompleted = events.find((e) => e.type === "step_completed" && e.stepId === "n_loop")
    expect(loopCompleted).toBeDefined()
    expect((loopCompleted?.payload as { output: { items: unknown[] } }).output.items).toEqual([
      "x!",
      "y!",
    ])
    // Child completions carry iteration provenance and never appear as
    // top-level scheduled steps outside their loop payloads.
    const bodyEvents = events.filter((e) => e.stepId === "n_body" && e.type === "step_completed")
    expect(bodyEvents).toHaveLength(2)
    for (const e of bodyEvents) {
      expect((e.payload as { loopId?: string }).loopId).toBe("n_loop")
    }
  })
})

describe("runWorkflow — failure handling", () => {
  it("reports a failed run when an executor is missing for a node kind", async () => {
    // GitHub delivery actions are plugin-contributed and intentionally have
    // no host executor, so this exercises the missing-plugin execution path
    // without trying to route an edge into a display-only annotation.
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
          type: "action.github.openPr",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "open PR",
            params: { repoFullName: "owner/repo", head: "feature", base: "main", title: "PR" },
          },
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
    // Plugin-contributed GitHub action has no host executor — drives the
    // step-failure path while remaining a semantically valid graph target.
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
          type: "action.github.openPr",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: {
            label: "open PR",
            params: { repoFullName: "owner/repo", head: "feature", base: "main", title: "PR" },
          },
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

  it("feeds seeded upstream outputs into the start step even though the ancestor is skipped", async () => {
    // Backs "re-run from this step" in the run-history view: the ancestor cone
    // is skipped (not re-executed) but its prior-run outputs are seeded so the
    // start step receives the same inputs it saw in the original run, instead
    // of `undefined`.
    const captured: Record<string, unknown> = {}
    registerNodeExecutor({
      kind: "test.capture" as never,
      typeVersion: 1,
      execute: async (ctx) => {
        Object.assign(captured, ctx.upstream)
        return { output: { seen: ctx.upstream } }
      },
    })
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
          type: "test.capture" as never,
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "b", params: {} },
        },
      ],
      [{ id: "e1", source: "n_a", target: "n_b" }]
    )

    const result = await runWorkflow({
      workflow: wf,
      trigger,
      startStepId: "n_b",
      seedOutputs: { n_a: { val: 42 } },
    })
    expect(result.status).toBe("succeeded")
    // Without the seed-survives-skip fix this is `{}` (the skipped ancestor is
    // dropped from the upstream map before the cache is consulted).
    expect(captured).toEqual({ n_a: { val: 42 } })

    const events = await listRunEvents(result.runId)
    const completed = events.filter((e) => e.type === "step_completed").map((e) => e.stepId)
    const skipped = events.filter((e) => e.type === "step_skipped").map((e) => e.stepId)
    expect(completed).toEqual(["n_b"])
    expect(skipped).toEqual(["n_a"])
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

  it("absent maxConcurrency backfills to the shared default (4-wide)", async () => {
    let inflight = 0
    let maxInflight = 0
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async () => {
        inflight += 1
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 15))
        inflight -= 1
        return { output: null }
      },
    })

    // No maxConcurrency set → the zod settings schema backfills
    // DEFAULT_MAX_CONCURRENCY (4), so a legacy no-field settings blob runs at
    // the same width as a freshly created workflow. Three independent nodes
    // must all be in flight together (3 < 4).
    const wf: VisualWorkflow = {
      ...buildAsyncWorkflow(["a", "b", "c"], [], 1),
    }
    delete (wf.settings as { maxConcurrency?: number }).maxConcurrency

    const result = await runWorkflow({ workflow: wf, trigger })
    expect(result.status).toBe("succeeded")
    expect(maxInflight).toBe(3)
  })

  it("explicit maxConcurrency=1 still serializes", async () => {
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

    const wf = buildAsyncWorkflow(["a", "b", "c"], [], 1)
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

  it("fails instead of reporting success when the scheduler cannot dispatch pending nodes", async () => {
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
    const result = (await guarded) as Awaited<ReturnType<typeof runWorkflow>>
    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "orchestration_stalled",
          message: expect.stringContaining("a"),
        }),
      })
    )
    const events = await listRunEvents(result.runId)
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_failed",
        payload: expect.objectContaining({ code: "orchestration_stalled" }),
      })
    )
  })

  it("fails an in-flight run when the caller aborts its external signal", async () => {
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    registerNodeExecutor({
      kind: "test.async" as never,
      typeVersion: 1,
      execute: async (ctx) => {
        markStarted()
        return new Promise<{ output: null }>((_, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => reject(ctx.signal.reason ?? new Error("aborted")),
            { once: true }
          )
        })
      },
    })

    const run = runWorkflow({
      workflow: buildAsyncWorkflow(["a"], [], 1),
      trigger,
      signal: controller.signal,
    })
    await started
    controller.abort()

    await expect(run).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ nodeId: "a" }),
      })
    )
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

// ── per-node errorHandling.onError (overrides the workflow-level policy) ─────
describe("runWorkflow — per-node errorHandling", () => {
  beforeEach(() => {
    // Kind must belong to a supportsErrorHandling family ("data.*") — the
    // per-node modes are deliberately ignored on triggers/flow/annotations.
    registerNodeExecutor({
      kind: "data.failtest" as never,
      typeVersion: 1,
      execute: async () => {
        throw new Error("boom")
      },
    })
  })

  function buildNodeFailWorkflow(opts: {
    errorHandling: NonNullable<VisualWorkflow["nodes"][number]["data"]["errorHandling"]>
    withErrorEdge?: boolean
    successValue?: string
  }): VisualWorkflow {
    const edges: VisualWorkflow["edges"] = [
      { id: "e1", source: "n_start", target: "n_fail" },
      { id: "e2", source: "n_fail", target: "n_success" },
    ]
    if (opts.withErrorEdge) {
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
        type: "data.failtest" as never,
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "boom", params: {}, errorHandling: opts.errorHandling },
      },
      {
        id: "n_success",
        type: "flow.set",
        typeVersion: 1,
        position: { x: 400, y: 0 },
        data: {
          label: "ok",
          params: { variable: "ok", value: opts.successValue ?? "success_path" },
        },
      },
    ]
    if (opts.withErrorEdge) {
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
      name: "Per-node fail workflow",
      createdAt: 0,
      updatedAt: 0,
      nodes,
      edges,
      // Workflow-level policy stays "stop" — the per-node setting must win.
      settings: {
        errorPolicy: "stop",
        timeoutMs: 60_000,
        concurrency: 1,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    }
  }

  it('"continue" RUNS downstream with an error-shaped output (n8n semantics)', async () => {
    const r = await runWorkflow({
      workflow: buildNodeFailWorkflow({
        errorHandling: { onError: "continue" },
        successValue: "{{ $node['n_fail'].error }}",
      }),
      trigger,
    })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    // Downstream COMPLETED (legacy workflow-level continue would skip it)…
    const success = events.find((e) => e.type === "step_completed" && e.stepId === "n_success")
    expect(success).toBeDefined()
    // …and could read the failed node's error through the expression engine.
    expect((success?.payload as { output?: { value?: unknown } })?.output?.value).toBe("boom")
    // The failure itself is still on record.
    expect(events.find((e) => e.type === "step_failed" && e.stepId === "n_fail")).toBeDefined()
  })

  it('"defaultValue" substitutes the static output and runs downstream', async () => {
    const r = await runWorkflow({
      workflow: buildNodeFailWorkflow({
        errorHandling: { onError: "defaultValue", defaultValue: { completion: "fallback" } },
        successValue: "{{ $node['n_fail'].completion }}",
      }),
      trigger,
    })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    const success = events.find((e) => e.type === "step_completed" && e.stepId === "n_success")
    expect((success?.payload as { output?: { value?: unknown } })?.output?.value).toBe("fallback")
  })

  it('"errorBranch" routes to the error edge even when the workflow policy is stop', async () => {
    const r = await runWorkflow({
      workflow: buildNodeFailWorkflow({
        errorHandling: { onError: "errorBranch" },
        withErrorEdge: true,
      }),
      trigger,
    })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    expect(
      events.find((e) => e.type === "step_completed" && e.stepId === "n_recover")
    ).toBeDefined()
    expect(events.find((e) => e.type === "step_skipped" && e.stepId === "n_success")).toBeDefined()
  })

  it('"errorBranch" without an error edge falls back to the workflow policy (stop)', async () => {
    const r = await runWorkflow({
      workflow: buildNodeFailWorkflow({ errorHandling: { onError: "errorBranch" } }),
      trigger,
    })
    expect(r.status).toBe("failed")
    expect(r.error?.nodeId).toBe("n_fail")
  })

  it('"fail" (explicit) keeps legacy stop semantics', async () => {
    const r = await runWorkflow({
      workflow: buildNodeFailWorkflow({ errorHandling: { onError: "fail" } }),
      trigger,
    })
    expect(r.status).toBe("failed")
  })
})

// ── flow.join fan-in policies: any / race (P3) ───────────────────────────────
describe("runWorkflow — flow.join any/race", () => {
  /** Two parallel branches into a join: fast (immediate) vs slow (gated). */
  function buildRaceWorkflow(joinPolicy: "all" | "any" | "race"): {
    workflow: VisualWorkflow
    releaseSlow: () => void
    slowStarted: () => boolean
    slowFinished: () => boolean
  } {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started = false
    let finished = false
    registerNodeExecutor({
      kind: "data.slowstep" as never,
      typeVersion: 1,
      execute: async (ctx) => {
        started = true
        await Promise.race([
          gate,
          new Promise((_, reject) => {
            ctx.signal.addEventListener(
              "abort",
              () => reject(ctx.signal.reason ?? new Error("aborted")),
              { once: true }
            )
            if (ctx.signal.aborted) reject(ctx.signal.reason ?? new Error("aborted"))
          }),
        ])
        finished = true
        return { output: { slow: true } }
      },
    })
    const workflow: VisualWorkflow = {
      id: "wf_race",
      schemaVersion: 1,
      name: "race",
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_fast",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "fast", params: { variable: "f", value: "fast" } },
        },
        {
          id: "n_slow",
          type: "data.slowstep" as never,
          typeVersion: 1,
          position: { x: 200, y: 120 },
          data: { label: "slow", params: {} },
        },
        {
          id: "n_join",
          type: "flow.join",
          typeVersion: 1,
          position: { x: 400, y: 60 },
          data: { label: "join", params: { joinPolicy } },
        },
        {
          id: "n_after",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 600, y: 60 },
          data: { label: "after", params: { variable: "a", value: "done" } },
        },
      ],
      edges: [
        { id: "e1", source: "n_start", target: "n_fast" },
        { id: "e2", source: "n_start", target: "n_slow" },
        { id: "e3", source: "n_fast", target: "n_join" },
        { id: "e4", source: "n_slow", target: "n_join" },
        { id: "e5", source: "n_join", target: "n_after" },
      ],
      settings: {
        errorPolicy: "stop",
        timeoutMs: 60_000,
        concurrency: 1,
        // Both branches must run concurrently for the race to be real.
        maxConcurrency: 4,
        retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
      },
    }
    return {
      workflow,
      releaseSlow: release,
      slowStarted: () => started,
      slowFinished: () => finished,
    }
  }

  it('"all" waits for every branch (slow branch must finish)', async () => {
    const { workflow, releaseSlow } = buildRaceWorkflow("all")
    const runPromise = runWorkflow({ workflow, trigger })
    // The join cannot proceed until the slow branch is released.
    releaseSlow()
    const r = await runPromise
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_slow")).toBeDefined()
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_join")).toBeDefined()
  })

  it('"any" proceeds on the first arrival and drains the slow branch', async () => {
    const { workflow, releaseSlow, slowStarted } = buildRaceWorkflow("any")
    const runPromise = runWorkflow({ workflow, trigger })
    // Give the run a beat, then release the slow branch so the run can drain.
    await new Promise((r) => setTimeout(r, 50))
    releaseSlow()
    const r = await runPromise
    expect(r.status).toBe("succeeded")
    expect(slowStarted()).toBe(true)
    const events = await listRunEvents(r.runId)
    // The join + downstream completed.
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_join")).toBeDefined()
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_after")).toBeDefined()
  })

  it('"race" cancels the slow branch and marks it skipped (never failed)', async () => {
    const { workflow, slowFinished } = buildRaceWorkflow("race")
    // Never release the slow branch — the race cancellation must unblock it.
    const r = await runWorkflow({ workflow, trigger })
    expect(r.status).toBe("succeeded")
    expect(slowFinished()).toBe(false)
    const events = await listRunEvents(r.runId)
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_join")).toBeDefined()
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_after")).toBeDefined()
    // Cancelled branch: skipped, and the run did NOT fail because of it.
    expect(events.find((e) => e.type === "step_skipped" && e.stepId === "n_slow")).toBeDefined()
    // Shared ancestor untouched.
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_start")).toBeDefined()
  })

  it('"race" never caches the cancelled step (resume would re-run it)', async () => {
    const { workflow } = buildRaceWorkflow("race")
    const r = await runWorkflow({ workflow, trigger })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    // No step_completed for the cancelled branch — the idempotency cache only
    // persists completions, so a resume cannot replay a cancelled result.
    expect(events.find((e) => e.type === "step_completed" && e.stepId === "n_slow")).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Editor debugging options: seedOutputs / restrictToStepIds / honorPinData.
// ───────────────────────────────────────────────────────────────────────────

function setNode(id: string, value: unknown): VisualWorkflow["nodes"][number] {
  return {
    id,
    type: "flow.set",
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: { variable: id, value } },
  }
}

describe("runWorkflow — debugging options", () => {
  it("seedOutputs makes a seeded node cache-hit (no execution) and feeds downstream", async () => {
    const wf = buildWorkflow(
      [setNode("n_a", "ORIGINAL"), setNode("n_b", "{{ $node['n_a'].value }}")],
      [{ id: "e1", source: "n_a", target: "n_b" }]
    )
    const r = await runWorkflow({
      workflow: wf,
      trigger,
      seedOutputs: { n_a: { variable: "n_a", value: "SEEDED" } },
    })
    expect(r.status).toBe("succeeded")
    // n_b saw the seeded value, not n_a's would-be "ORIGINAL".
    expect((r.output as { value?: string }).value).toBe("SEEDED")
    // The seeded node did not execute → no step_completed event for it.
    const events = await listRunEvents(r.runId)
    expect(events.some((e) => e.type === "step_completed" && e.stepId === "n_a")).toBe(false)
    expect(events.some((e) => e.type === "step_completed" && e.stepId === "n_b")).toBe(true)
  })

  it("restrictToStepIds skips every node not in the allow-list", async () => {
    const wf = buildWorkflow(
      [setNode("n_a", "a"), setNode("n_b", "b"), setNode("n_c", "c")],
      [
        { id: "e1", source: "n_a", target: "n_b" },
        { id: "e2", source: "n_b", target: "n_c" },
      ]
    )
    const r = await runWorkflow({ workflow: wf, trigger, restrictToStepIds: ["n_a", "n_b"] })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    expect(events.some((e) => e.type === "step_completed" && e.stepId === "n_b")).toBe(true)
    expect(events.some((e) => e.type === "step_skipped" && e.stepId === "n_c")).toBe(true)
  })

  it("honorPinData returns the pinned value for a pinned node", async () => {
    const wf: VisualWorkflow = {
      ...buildWorkflow([setNode("n_a", "ORIGINAL")]),
      pinData: { n_a: { variable: "n_a", value: "PINNED" } },
    }
    const r = await runWorkflow({ workflow: wf, trigger, honorPinData: true })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    const completed = events.find((e) => e.type === "step_completed" && e.stepId === "n_a")
    expect((completed?.payload as { output?: { value?: string } })?.output?.value).toBe("PINNED")
  })

  it("ignores pinData when honorPinData is not set", async () => {
    const wf: VisualWorkflow = {
      ...buildWorkflow([setNode("n_a", "ORIGINAL")]),
      pinData: { n_a: { variable: "n_a", value: "PINNED" } },
    }
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
    const events = await listRunEvents(r.runId)
    const completed = events.find((e) => e.type === "step_completed" && e.stepId === "n_a")
    expect((completed?.payload as { output?: { value?: string } })?.output?.value).toBe("ORIGINAL")
  })
})

describe("run-scoped terminal-session cleanup", () => {
  it("closes run sessions after a successful run", async () => {
    const r = await runWorkflow({ workflow: buildWorkflow([setNode("n_a", "v")]), trigger })
    expect(r.status).toBe("succeeded")
    expect(mockCloseRunSessions).toHaveBeenCalledWith(r.runId)
  })

  it("closes run sessions after a failed run", async () => {
    // `action.system.terminal` with no command throws a non-retryable error.
    const wf = buildWorkflow([
      {
        id: "n_term",
        type: "action.system.terminal",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "term", params: {} },
      },
    ])
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("failed")
    expect(mockCloseRunSessions).toHaveBeenCalledWith(r.runId)
  })

  it("a cleanup failure never masks the run result", async () => {
    mockCloseRunSessions.mockRejectedValueOnce(new Error("backend gone"))
    const r = await runWorkflow({ workflow: buildWorkflow([setNode("n_a", "v")]), trigger })
    expect(r.status).toBe("succeeded")
  })
})

// ── ADR-0070 Phase 3 — engine-level risk gate ────────────────────────────
describe("runWorkflow — risk gate", () => {
  // `action.connector.send` declares no platform capability, so the ADR-0060
  // preflight (which runs at t=0, before any step) lets it through and the risk
  // gate is what we actually exercise. Desktop/terminal kinds are already
  // preflight-failed off-desktop, so they cannot reach this path here.
  const riskyNode = (id: string) =>
    ({
      id,
      type: "action.connector.send",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "send", params: { adapterId: "a1", conversationKey: "c1", text: "hi" } },
    }) as unknown as VisualWorkflow["nodes"][number]

  it("leaves a pre-ADR-0070 workflow (no riskGating field) completely ungated", async () => {
    // The migration property: shipping this must not pause automations that
    // already run. buildWorkflow omits riskGating, so this is the real default.
    const wf = buildWorkflow([setNode("n_a", "v")])
    expect(wf.settings.riskGating).toBeUndefined()
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
  })

  it("fails a headless run that hits a risky node, naming the surfaces", async () => {
    const base = buildWorkflow([riskyNode("n_sh")])
    const wf = { ...base, settings: { ...base.settings, riskGating: true } }
    const r = await runWorkflow({
      workflow: wf,
      trigger,
      triggeredBy: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(r.status).toBe("failed")
    expect(JSON.stringify(r.error ?? "")).toMatch(/external-send/)
  })

  it("does not gate a low-risk node even when gating is on", async () => {
    const base = buildWorkflow([setNode("n_a", "v")])
    const wf = { ...base, settings: { ...base.settings, riskGating: true } }
    const r = await runWorkflow({
      workflow: wf,
      trigger,
      triggeredBy: { source: "im", adapterId: "a1", conversationKey: "c1" },
    })
    expect(r.status).toBe("succeeded")
  })
})

describe("runWorkflow — workflow-completed chain fanout (ADR-0081)", () => {
  it("announces a succeeded run with its final output and the run's trigger", async () => {
    const wf = buildWorkflow([setNode("n_a", "v")])
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")

    await flushFanout()
    expect(mockEmitCompletionFanout).toHaveBeenCalledTimes(1)
    expect(mockEmitCompletionFanout).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: { id: "wf_x", name: "Test workflow" },
        runId: r.runId,
        status: "succeeded",
        output: r.output,
        trigger,
      })
    )
  })

  it("announces a failed run with the error envelope", async () => {
    registerNodeExecutor({
      kind: "test.fanout-fail" as never,
      typeVersion: 1,
      execute: async () => {
        const err = new Error("kaboom") as Error & { retryable?: boolean }
        err.retryable = false
        throw err
      },
    })
    const wf = buildWorkflow([
      {
        id: "n_boom",
        type: "test.fanout-fail" as VisualWorkflow["nodes"][number]["type"],
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "boom", params: {} },
      },
    ])

    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("failed")

    await flushFanout()
    expect(mockEmitCompletionFanout).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ message: "kaboom", nodeId: "n_boom" }),
      })
    )
  })

  it("announces a validation failure as a failed completion", async () => {
    const wf = buildWorkflow([setNode("n_a", "v")])
    wf.edges = [{ id: "e_ghost", source: "n_a", target: "n_missing" }]

    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("failed")

    await flushFanout()
    expect(mockEmitCompletionFanout).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" })
    )
  })

  it("stays silent for catch sub-runs (suppressCatch)", async () => {
    const wf = buildWorkflow([setNode("n_a", "v")])
    const r = await runWorkflow({ workflow: wf, trigger, suppressCatch: true })
    expect(r.status).toBe("succeeded")

    await flushFanout()
    expect(mockEmitCompletionFanout).not.toHaveBeenCalled()
  })

  it('stays silent for partial "run this step" runs (restrictToStepIds)', async () => {
    const wf = buildWorkflow([setNode("n_a", "v"), setNode("n_b", "w")])
    const r = await runWorkflow({ workflow: wf, trigger, restrictToStepIds: ["n_a"] })
    expect(r.status).toBe("succeeded")

    await flushFanout()
    expect(mockEmitCompletionFanout).not.toHaveBeenCalled()
  })
})

describe("runWorkflow — $nodes global expression scope", () => {
  it("lets a node read a NON-adjacent completed node's output", async () => {
    // n_a → n_b → n_c; n_c references n_a via $nodes (no direct edge a→c).
    const wf = buildWorkflow(
      [
        setNode("n_a", "from-a"),
        setNode("n_b", "from-b"),
        {
          id: "n_c",
          type: "data.template",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: {
            label: "render",
            params: { template: "far={{ $nodes['n_a'].value }} near={{ $node['n_b'].value }}" },
          },
        },
      ],
      [
        { id: "e1", source: "n_a", target: "n_b" },
        { id: "e2", source: "n_b", target: "n_c" },
      ]
    )

    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
    expect((r.output as { rendered: string }).rendered).toBe("far=from-a near=from-b")
  })

  it("a $nodes reference to a not-yet-run node renders empty (best-effort)", async () => {
    // n_c runs parallel to n_a (no ordering path) — the read must not crash.
    const wf = buildWorkflow(
      [
        setNode("n_a", "from-a"),
        {
          id: "n_c",
          type: "data.template",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: {
            label: "render",
            params: { template: "got=[{{ $nodes['n_zzz'].value }}]" },
          },
        },
      ],
      []
    )
    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
    const outputs = r.output as Record<string, { rendered?: string } | { value?: unknown }>
    const rendered = Object.values(outputs).find(
      (o): o is { rendered: string } => typeof (o as { rendered?: unknown }).rendered === "string"
    )
    expect(rendered?.rendered).toBe("got=[]")
  })
})

describe("runWorkflow — $nodes reaches loop-body steps", () => {
  it("a loop-body template reads a top-level completed node via $nodes", async () => {
    const wf: VisualWorkflow = {
      ...buildWorkflow([], []),
      schemaVersion: 2,
      nodes: [
        setNode("n_top", "top-value"),
        {
          id: "n_loop",
          type: "flow.loop",
          typeVersion: 2,
          position: { x: 200, y: 0 },
          data: { label: "loop", params: { mode: "times", times: 1 } },
        },
        {
          id: "n_body",
          type: "data.template",
          typeVersion: 1,
          parentId: "n_loop",
          position: { x: 10, y: 10 },
          data: {
            label: "body",
            params: { template: "saw={{ $nodes['n_top'].value }}" },
          },
        },
      ],
      edges: [{ id: "e1", source: "n_top", target: "n_loop" }],
    }

    const r = await runWorkflow({ workflow: wf, trigger })
    expect(r.status).toBe("succeeded")
    // The body's rendered output lives in its step_completed event (loop items
    // default to the iteration index in times mode).
    const events = await listRunEvents(r.runId)
    const bodyDone = events.find((e) => e.stepId === "n_body" && e.type === "step_completed")
    expect(JSON.stringify(bodyDone?.payload ?? {})).toContain("saw=top-value")
  })
})
