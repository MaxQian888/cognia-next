import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { markSent } from "@/lib/db/outbound-jobs"
// Importing built-ins triggers their side-effecting registrations.
import "./built-ins"
import { getExecutor } from "./registry"
import { registerSkill, __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import type { Skill } from "@cognia/agent-config-types"
import type {
  StepExecutionContext,
  StepExecutionResult,
  TriggerEvent,
  WorkflowNodeKind,
} from "@/types/workflow/visual"

// Mock only the webhook-delivery hop; keep the rest of the bridge real
// (no-ops in jsdom). The inline jest.fn avoids the const-TDZ hoist trap.
jest.mock("@/lib/workflow/runtime/tauri-bridge", () => ({
  ...jest.requireActual("@/lib/workflow/runtime/tauri-bridge"),
  respondToWebhook: jest.fn(async () => true),
}))
import { respondToWebhook } from "@/lib/workflow/runtime/tauri-bridge"
const respondToWebhookMock = respondToWebhook as jest.Mock

jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: jest.fn(),
}))

// Connector bus — the reaction/delete/waitReply executors reach the live
// adapters through it. Inline jest.fn()s (TDZ-safe) with per-test overrides.
jest.mock("@/lib/connectors/bus", () => ({
  getBus: () => ({
    addReactionOutbound: (...args: unknown[]) => mockAddReaction(...args),
    removeReactionOutbound: (...args: unknown[]) => mockRemoveReaction(...args),
    forwardOutbound: (...args: unknown[]) => mockForward(...args),
    deleteOutbound: (...args: unknown[]) => mockDeleteOutbound(...args),
    subscribeInbound: (observer: (event: unknown) => void) => mockSubscribeInbound(observer),
  }),
}))
type MockOutboundResult = {
  ok: boolean
  error?: { code: string; message: string; retryable: boolean }
  reactionId?: string
  platformMessageId?: string
}
const mockAddReaction = jest.fn(async (..._args: unknown[]): Promise<MockOutboundResult> => ({
  ok: true,
}))
const mockRemoveReaction = jest.fn(async (..._args: unknown[]): Promise<MockOutboundResult> => ({
  ok: true,
}))
const mockForward = jest.fn(async (..._args: unknown[]): Promise<MockOutboundResult> => ({
  ok: true,
}))
const mockDeleteOutbound = jest.fn(async (..._args: unknown[]): Promise<MockOutboundResult> => ({
  ok: true,
}))
const inboundObservers: Array<(event: unknown) => void> = []
const mockSubscribeInbound = jest.fn((observer: (event: unknown) => void) => {
  inboundObservers.push(observer)
  return () => {
    const i = inboundObservers.indexOf(observer)
    if (i >= 0) inboundObservers.splice(i, 1)
  }
})
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
const buildRendererLlmClientMock = buildRendererLlmClient as jest.Mock
import { __resetPlanRuntimeForTesting } from "@/lib/agent/plan/runtime"
import { appendPlanEvent, getPlan as getStoredPlan, updatePlan } from "@/lib/db/plans"
import {
  registerTaskExecutor,
  schedulerDb,
  stopTaskScheduler,
  unregisterTaskExecutor,
} from "@/lib/scheduler"

const trigger: TriggerEvent = {
  workflowId: "wf",
  kind: "trigger.manual",
  payload: { greeting: "hi", n: 7 },
  originAt: 1_700_000_000,
}

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  stopTaskScheduler()
  await schedulerDb.clearAll()
  unregisterTaskExecutor("custom")
  __resetPlanRuntimeForTesting()
  buildRendererLlmClientMock.mockReset()
  mockAddReaction.mockReset()
  mockAddReaction.mockResolvedValue({ ok: true })
  mockDeleteOutbound.mockReset()
  mockDeleteOutbound.mockResolvedValue({ ok: true })
  mockSubscribeInbound.mockClear()
  inboundObservers.length = 0
})
afterAll(dbFixture.dispose)

function makeCtx<T extends Record<string, unknown>>(
  kind: WorkflowNodeKind,
  params: T,
  upstream: Record<string, unknown> = {}
): StepExecutionContext<T> {
  return {
    runId: "run_test",
    workflowId: "wf",
    stepId: "n_test",
    params,
    upstream,
    trigger,
    signal: new AbortController().signal,
    log: () => undefined,
    resolveSecret: async () => undefined,
  } as StepExecutionContext<T>
}

async function exec(
  kind: WorkflowNodeKind,
  ctx: StepExecutionContext<Record<string, unknown>>
): Promise<StepExecutionResult> {
  const reg = getExecutor(kind, 1)
  if (!reg) throw new Error(`No executor for ${kind}`)
  return reg.execute(ctx)
}

async function waitForSchedulerExecutions(taskId: string, count: number) {
  let last = await schedulerDb.getTaskExecutions(taskId, 20)
  for (
    let attempt = 0;
    attempt < 20 &&
    (last.length < count ||
      last
        .slice(0, count)
        .some((execution) => execution.status === "pending" || execution.status === "running"));
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    last = await schedulerDb.getTaskExecutions(taskId, 20)
  }
  return last
}

describe("trigger.manual", () => {
  it("echoes the trigger payload", async () => {
    const r = await exec("trigger.manual", makeCtx("trigger.manual", {}))
    expect(r.output).toEqual({ firedAt: trigger.originAt, payload: trigger.payload })
  })
})

describe("trigger.team", () => {
  it("passes through the trigger payload without side effects", async () => {
    const r = await exec("trigger.team", makeCtx("trigger.team", {}))
    expect(r.output).toEqual({ firedAt: trigger.originAt, payload: trigger.payload })
  })
})

describe("built-in trigger passthrough parity", () => {
  it.each([
    "trigger.cron",
    "trigger.connector.inbound",
    "trigger.chat.message",
    "trigger.goal.completed",
    "trigger.webhook",
    "trigger.integration.event",
    "trigger.workflow.completed",
  ] as const)("passes through %s events", async (kind) => {
    const r = await exec(kind, makeCtx(kind, {}))
    expect(r.output).toEqual({ firedAt: trigger.originAt, payload: trigger.payload })
  })
})

describe("flow.set", () => {
  it("stores the value under the chosen variable name", async () => {
    const r = await exec("flow.set", makeCtx("flow.set", { variable: "name", value: "alex" }))
    expect(r.output).toEqual({ variable: "name", value: "alex" })
    expect(r.logs?.[0].message).toMatch(/Set name/)
  })

  it("rejects an empty variable name", async () => {
    await expect(
      exec("flow.set", makeCtx("flow.set", { variable: "  ", value: 1 }))
    ).rejects.toThrow(/non-empty/)
  })
})

describe("flow.branch", () => {
  it("picks the truthy label when condition is truthy", async () => {
    const r = await exec(
      "flow.branch",
      makeCtx("flow.branch", { condition: true, truthyLabel: "yes", falsyLabel: "no" })
    )
    expect(r.decision).toBe("yes")
  })

  it("picks the falsy label when condition is empty / false / 0", async () => {
    for (const c of [false, "", 0, null, undefined, [], {}]) {
      const r = await exec(
        "flow.branch",
        makeCtx("flow.branch", {
          condition: c as unknown as boolean,
          truthyLabel: "yes",
          falsyLabel: "no",
        })
      )
      expect(r.decision).toBe("no")
    }
  })
})

describe("data.transform", () => {
  it("maps array items via the expression resolver", async () => {
    const r = await exec(
      "data.transform",
      makeCtx(
        "data.transform",
        { operation: "map", expression: "{{ $node['$item'].x }}" },
        { up: [{ x: 1 }, { x: 2 }, { x: 3 }] }
      )
    )
    expect(r.output).toEqual([1, 2, 3])
  })

  it("filters with a truthy expression", async () => {
    const r = await exec(
      "data.transform",
      makeCtx(
        "data.transform",
        { operation: "filter", expression: "{{ $node['$item'].keep }}" },
        {
          up: [
            { keep: true, n: 1 },
            { keep: false, n: 2 },
            { keep: true, n: 3 },
          ],
        }
      )
    )
    expect((r.output as Array<{ n: number }>).map((x) => x.n)).toEqual([1, 3])
  })

  it("flattens nested arrays", async () => {
    const r = await exec(
      "data.transform",
      makeCtx(
        "data.transform",
        { operation: "flatten" },
        {
          up: [
            [1, 2],
            [3, 4],
          ],
        }
      )
    )
    expect(r.output).toEqual([1, 2, 3, 4])
  })

  it("reduces by summing item expression values", async () => {
    const r = await exec(
      "data.transform",
      makeCtx(
        "data.transform",
        { operation: "reduce", expression: "{{ $node['$item'].n }}" },
        { up: [{ n: 2 }, { n: 5 }, { n: 8 }] }
      )
    )
    expect(r.output).toBe(15)
  })

  it("rejects an unknown operation", async () => {
    await expect(
      exec("data.transform", makeCtx("data.transform", { operation: "snork" }, { up: [1, 2] }))
    ).rejects.toThrow(/Unsupported transform/)
  })
})

describe("data.aggregate", () => {
  const agg = (params: Record<string, unknown>, upstream: Record<string, unknown>) =>
    exec("data.aggregate", makeCtx("data.aggregate", params, upstream))

  it("collects an array input into a list", async () => {
    const r = await agg({ operation: "collect" }, { up: [1, 2, 3] })
    expect(r.output).toEqual([1, 2, 3])
  })

  it("aggregates multiple upstreams (fan-in) as the set", async () => {
    const r = await agg({ operation: "collect" }, { a: 1, b: 2, c: 3 })
    expect(r.output).toEqual([1, 2, 3])
  })

  it("concats nested arrays one level", async () => {
    const r = await agg({ operation: "concat" }, { up: [[1, 2], 3, [4]] })
    expect(r.output).toEqual([1, 2, 3, 4])
  })

  it("merges objects (later wins)", async () => {
    const r = await agg({ operation: "merge-objects" }, { up: [{ a: 1 }, { b: 2 }, { a: 9 }] })
    expect(r.output).toEqual({ a: 9, b: 2 })
  })

  it("groups by a key expression", async () => {
    const r = await agg(
      { operation: "group-by", keyExpression: "{{ $node['$item'].cat }}" },
      {
        up: [
          { cat: "x", v: 1 },
          { cat: "y", v: 2 },
          { cat: "x", v: 3 },
        ],
      }
    )
    expect(r.output).toEqual({
      x: [
        { cat: "x", v: 1 },
        { cat: "x", v: 3 },
      ],
      y: [{ cat: "y", v: 2 }],
    })
  })

  it("dedupes by value", async () => {
    const r = await agg({ operation: "dedupe" }, { up: [{ a: 1 }, { a: 1 }, { a: 2 }] })
    expect(r.output).toEqual([{ a: 1 }, { a: 2 }])
  })

  it("dedupes by a key expression", async () => {
    const r = await agg(
      { operation: "dedupe", keyExpression: "{{ $node['$item'].id }}" },
      {
        up: [
          { id: 1, n: "a" },
          { id: 1, n: "b" },
          { id: 2, n: "c" },
        ],
      }
    )
    expect(r.output).toEqual([
      { id: 1, n: "a" },
      { id: 2, n: "c" },
    ])
  })

  it("computes numeric aggregates", async () => {
    const field = "{{ $node['$item'].n }}"
    const input = { up: [{ n: 2 }, { n: 4 }, { n: 6 }] }
    expect(
      (await agg({ operation: "numeric", numericOp: "sum", numericField: field }, input)).output
    ).toBe(12)
    expect(
      (await agg({ operation: "numeric", numericOp: "avg", numericField: field }, input)).output
    ).toBe(4)
    expect(
      (await agg({ operation: "numeric", numericOp: "min", numericField: field }, input)).output
    ).toBe(2)
    expect(
      (await agg({ operation: "numeric", numericOp: "max", numericField: field }, input)).output
    ).toBe(6)
    expect((await agg({ operation: "numeric", numericOp: "count" }, input)).output).toBe(3)
  })

  it("returns null for avg/min/max over an empty list (not NaN)", async () => {
    const r = await agg({ operation: "numeric", numericOp: "avg" }, {})
    expect(r.output).toBeNull()
  })

  it("runs a custom JS reducer with acc/item/index in scope", async () => {
    const r = await agg(
      { operation: "custom", reducerExpression: "acc + item.n", initialValue: 0 },
      { up: [{ n: 2 }, { n: 5 }, { n: 8 }] }
    )
    expect(r.output).toBe(15)
  })

  it("fails (non-retryable) when the custom reducer throws", async () => {
    await expect(
      agg(
        { operation: "custom", reducerExpression: "item.boom.bang", initialValue: 0 },
        { up: [{ n: 1 }] }
      )
    ).rejects.toThrow(/custom reducer failed/)
  })

  it("wraps a single scalar upstream into a one-element list", async () => {
    const r = await agg({ operation: "numeric", numericOp: "sum" }, { up: 7 })
    expect(r.output).toBe(7)
  })
})

describe("data.template", () => {
  it("returns the rendered template (already expanded by step executor)", async () => {
    const r = await exec("data.template", makeCtx("data.template", { template: "Hello, world" }))
    expect(r.output).toEqual({ rendered: "Hello, world" })
  })
})

describe("data.code", () => {
  it("returns the body's return value", async () => {
    const r = await exec(
      "data.code",
      makeCtx("data.code", { code: "return upstream.up * 2" }, { up: 21 })
    )
    expect(r.output).toBe(42)
  })

  it("supports async returns", async () => {
    const r = await exec(
      "data.code",
      makeCtx("data.code", { code: "return Promise.resolve('async')" })
    )
    expect(r.output).toBe("async")
  })

  it("wraps thrown errors as non-retryable", async () => {
    await expect(
      exec("data.code", makeCtx("data.code", { code: "throw new Error('bang')" }))
    ).rejects.toMatchObject({ message: expect.stringContaining("bang"), retryable: false })
  })
})

describe("flow.switch", () => {
  it("picks the matching case label", async () => {
    const r = await exec(
      "flow.switch",
      makeCtx("flow.switch", {
        subject: "urgent",
        cases: [
          { value: "urgent", label: "alert" },
          { value: "normal", label: "queue" },
        ],
        defaultLabel: "default",
      })
    )
    expect(r.decision).toBe("alert")
  })

  it("falls through to default when no case matches", async () => {
    const r = await exec(
      "flow.switch",
      makeCtx("flow.switch", {
        subject: "unknown",
        cases: [{ value: "urgent", label: "alert" }],
        defaultLabel: "fallback",
      })
    )
    expect(r.decision).toBe("fallback")
  })
})

describe("flow.split", () => {
  it("forwards upstream as a single payload", async () => {
    const r = await exec("flow.split", makeCtx("flow.split", {}, { up: 42 }))
    expect((r.output as { upstream: { up: number } }).upstream).toEqual({ up: 42 })
  })
})

describe("flow.join", () => {
  it("freezes upstream into the joinPolicy envelope", async () => {
    const r = await exec("flow.join", makeCtx("flow.join", { joinPolicy: "any" }, { a: 1, b: 2 }))
    const out = r.output as {
      joinPolicy: string
      gathered: Record<string, number>
      upstreamCount: number
    }
    expect(out.joinPolicy).toBe("any")
    expect(out.gathered).toEqual({ a: 1, b: 2 })
    expect(out.upstreamCount).toBe(2)
  })

  it("reduces gathered outputs in one step when aggregate is set", async () => {
    const r = await exec(
      "flow.join",
      makeCtx(
        "flow.join",
        { joinPolicy: "all", aggregate: { operation: "concat" } },
        { a: [1, 2], b: [3] }
      )
    )
    const out = r.output as { aggregated: unknown; gathered: unknown }
    expect(out.aggregated).toEqual([1, 2, 3])
    // The raw gather envelope is preserved alongside the reduced value.
    expect(out.gathered).toEqual({ a: [1, 2], b: [3] })
  })

  it("omits 'aggregated' when no aggregate operation is configured", async () => {
    const r = await exec("flow.join", makeCtx("flow.join", { joinPolicy: "all" }, { a: 1 }))
    expect(r.output).not.toHaveProperty("aggregated")
  })
})

describe("flow.loop", () => {
  it("handles times mode by emitting an index array", async () => {
    const r = await exec("flow.loop", makeCtx("flow.loop", { mode: "times", times: 3 }))
    expect(r.output).toEqual({ iterations: 3, items: [0, 1, 2] })
  })

  it("handles forEach mode over an upstream array", async () => {
    const r = await exec(
      "flow.loop",
      makeCtx(
        "flow.loop",
        { mode: "forEach", bodyExpression: "{{ $node['$item'].n }}" },
        { up: [{ n: 1 }, { n: 2 }, { n: 3 }] }
      )
    )
    expect(r.output).toEqual({ iterations: 3, items: [1, 2, 3] })
  })

  it("returns an empty iteration when input is not an array", async () => {
    const r = await exec("flow.loop", makeCtx("flow.loop", { mode: "forEach" }))
    expect(r.output).toEqual({ iterations: 0, items: [] })
  })
})

describe("flow.wait", () => {
  it("returns immediately for 0 ms", async () => {
    const start = Date.now()
    const r = await exec("flow.wait", makeCtx("flow.wait", { mode: "duration", durationMs: 0 }))
    expect(Date.now() - start).toBeLessThan(50)
    expect(r.output).toEqual({ waitedMs: 0 })
  })

  it("waits roughly the requested duration", async () => {
    const start = Date.now()
    const r = await exec("flow.wait", makeCtx("flow.wait", { mode: "duration", durationMs: 30 }))
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
    expect(r.output).toEqual({ waitedMs: 30 })
  })

  it("aborts on signal", async () => {
    const ac = new AbortController()
    const ctx = {
      ...makeCtx("flow.wait", { mode: "duration", durationMs: 5_000 }),
      signal: ac.signal,
    }
    setTimeout(() => ac.abort(new Error("test abort")), 10)
    await expect(exec("flow.wait", ctx)).rejects.toThrow(/aborted/)
  })

  it("event mode blocks until an external wake fires the custom key", async () => {
    const { emitWake } = await import("@/lib/workflow/runtime/wake-bus")
    const pending = exec(
      "flow.wait",
      makeCtx("flow.wait", { mode: "event", eventKey: "deploy-approved" })
    )
    // Give the executor a tick to subscribe before waking.
    await new Promise((r) => setTimeout(r, 10))
    expect(emitWake("deploy-approved", { source: "test", data: { ok: 1 } })).toBe(true)
    const r = await pending
    const out = r.output as Record<string, unknown>
    expect(out.event).toBe("deploy-approved")
    expect(out.source).toBe("test")
    expect(out.data).toEqual({ ok: 1 })
    expect(typeof out.waitedMs).toBe("number")
  })

  it("event mode defaults its key to runId:stepId", async () => {
    const { emitWake } = await import("@/lib/workflow/runtime/wake-bus")
    const ctx = makeCtx("flow.wait", { mode: "event" })
    const pending = exec("flow.wait", ctx)
    await new Promise((r) => setTimeout(r, 10))
    expect(emitWake(`${ctx.runId}:${ctx.stepId}`, { source: "test" })).toBe(true)
    const r = await pending
    expect((r.output as Record<string, unknown>).event).toBe(`${ctx.runId}:${ctx.stepId}`)
  })

  it("event mode times out with a NON-retryable error", async () => {
    const pending = exec(
      "flow.wait",
      makeCtx("flow.wait", { mode: "event", eventKey: "never", timeoutMs: 20 })
    )
    await expect(pending).rejects.toMatchObject({
      message: expect.stringMatching(/timed out/),
      retryable: false,
    })
  })

  it("event mode unblocks on run abort", async () => {
    const ac = new AbortController()
    const ctx = {
      ...makeCtx("flow.wait", { mode: "event", eventKey: "abort-me" }),
      signal: ac.signal,
    }
    const pending = exec("flow.wait", ctx)
    setTimeout(() => ac.abort(new Error("test abort")), 10)
    await expect(pending).rejects.toThrow(/aborted/)
  })
})

describe("io.http", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  // Tiny stand-in for the global Response class; jsdom's default doesn't
  // expose Response, so we craft an object that satisfies the executor's
  // usage (status, statusText, ok, headers.get, headers.entries, json, text).
  function makeResponse(body: string, init: { status: number; contentType?: string }) {
    const status = init.status
    const headers = new Map<string, string>()
    if (init.contentType) headers.set("content-type", init.contentType)
    return {
      status,
      statusText: status >= 500 ? "Server Error" : status >= 400 ? "Client Error" : "OK",
      ok: status >= 200 && status < 300,
      headers: {
        get: (k: string) => headers.get(k.toLowerCase()) ?? null,
        entries: () => headers.entries(),
      },
      async json() {
        return JSON.parse(body)
      },
      async text() {
        return body
      },
    } as unknown as Response
  }

  it("returns body + status for a 200 JSON response", async () => {
    global.fetch = jest.fn(async () =>
      makeResponse(JSON.stringify({ ok: true }), {
        status: 200,
        contentType: "application/json",
      })
    ) as typeof fetch
    const r = await exec(
      "io.http",
      makeCtx("io.http", { url: "https://api.example/test", method: "GET" })
    )
    const out = r.output as { status: number; body: unknown }
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
  })

  it("flags 5xx as retryable and 4xx as non-retryable", async () => {
    global.fetch = jest.fn(async () => makeResponse("err", { status: 502 })) as typeof fetch
    await expect(
      exec("io.http", makeCtx("io.http", { url: "https://api.example/test" }))
    ).rejects.toMatchObject({ retryable: true })

    global.fetch = jest.fn(async () => makeResponse("err", { status: 404 })) as typeof fetch
    await expect(
      exec("io.http", makeCtx("io.http", { url: "https://api.example/test" }))
    ).rejects.toMatchObject({ retryable: false })
  })

  it("rejects an empty URL", async () => {
    await expect(exec("io.http", makeCtx("io.http", { url: "  " }))).rejects.toThrow(
      /non-empty URL/
    )
  })
})

describe("ai.prompt", () => {
  it("falls back to a clearly-marked stub when provider/model/apiKey are missing", async () => {
    const r = await exec("ai.prompt", makeCtx("ai.prompt", { userPrompt: "hello" }))
    const out = r.output as { stub: boolean; completion: string }
    expect(out.stub).toBe(true)
    expect(out.completion).toContain("hello")
  })

  it("requires every field before attempting a real call", async () => {
    // Has provider but no model → still stub.
    const r1 = await exec(
      "ai.prompt",
      makeCtx("ai.prompt", { provider: "anthropic", userPrompt: "x" })
    )
    expect((r1.output as { stub: boolean }).stub).toBe(true)

    // Has provider + model but no apiKey → still stub.
    const r2 = await exec(
      "ai.prompt",
      makeCtx("ai.prompt", {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        userPrompt: "x",
      })
    )
    expect((r2.output as { stub: boolean }).stub).toBe(true)
  })
})

describe("action.character.create / update", () => {
  it("creates a new character and returns its id", async () => {
    const r = await exec(
      "action.character.create",
      makeCtx("action.character.create", {
        name: "Workflow Char",
        systemPrompt: "Be helpful.",
        avatarEmoji: "🤖",
      })
    )
    const out = r.output as { characterId: string; name: string }
    expect(out.characterId).toMatch(/^char_/)
    expect(out.name).toBe("Workflow Char")
    const stored = await getDb().characters.get(out.characterId)
    expect(stored?.systemPrompt).toBe("Be helpful.")
    expect(stored?.avatarEmoji).toBe("🤖")
  })

  it("rejects empty name and missing systemPrompt", async () => {
    await expect(
      exec("action.character.create", makeCtx("action.character.create", { name: "  " }))
    ).rejects.toThrow(/'name'/)
    await expect(
      exec("action.character.create", makeCtx("action.character.create", { name: "x" }))
    ).rejects.toThrow(/'systemPrompt'/)
  })

  it("updates an existing character via patch", async () => {
    const created = await exec(
      "action.character.create",
      makeCtx("action.character.create", { name: "X", systemPrompt: "old" })
    )
    const id = (created.output as { characterId: string }).characterId
    await exec(
      "action.character.update",
      makeCtx("action.character.update", {
        characterId: id,
        patch: { description: "patched", systemPrompt: "new" },
      })
    )
    const stored = await getDb().characters.get(id)
    expect(stored?.description).toBe("patched")
    expect(stored?.systemPrompt).toBe("new")
  })

  it("update rejects missing id or empty patch", async () => {
    await expect(
      exec("action.character.update", makeCtx("action.character.update", { patch: {} }))
    ).rejects.toThrow(/characterId/)
    await expect(
      exec("action.character.update", makeCtx("action.character.update", { characterId: "char_x" }))
    ).rejects.toThrow(/patch/)
  })
})

describe("action.team.create / update", () => {
  it("creates a team referring to existing character ids", async () => {
    // Pre-seed two characters because team validation requires them.
    const a = await exec(
      "action.character.create",
      makeCtx("action.character.create", { name: "A", systemPrompt: "x" })
    )
    const aId = (a.output as { characterId: string }).characterId
    const r = await exec(
      "action.team.create",
      makeCtx("action.team.create", {
        name: "Squad",
        members: [{ characterId: aId, role: "lead" }],
        orchestration: "round_robin",
      })
    )
    const out = r.output as { teamId: string; name: string }
    expect(out.teamId).toMatch(/^team_/)
    expect(out.name).toBe("Squad")
  })

  it("rejects an empty member list", async () => {
    await expect(
      exec("action.team.create", makeCtx("action.team.create", { name: "Empty", members: [] }))
    ).rejects.toThrow(/at least one member/)
  })

  it("updates a team's description via patch", async () => {
    const c = await exec(
      "action.character.create",
      makeCtx("action.character.create", { name: "C", systemPrompt: "x" })
    )
    const cId = (c.output as { characterId: string }).characterId
    const t = await exec(
      "action.team.create",
      makeCtx("action.team.create", {
        name: "T",
        members: [{ characterId: cId }],
      })
    )
    const tId = (t.output as { teamId: string }).teamId
    await exec(
      "action.team.update",
      makeCtx("action.team.update", {
        teamId: tId,
        patch: { description: "patched" },
      })
    )
    const stored = await getDb().teams.get(tId)
    expect(stored?.description).toBe("patched")
  })
})

describe("action.goal.*", () => {
  const goalKind = (kind: string) => kind as WorkflowNodeKind

  async function createGoal(params?: Record<string, unknown>) {
    const result = await exec(
      goalKind("action.goal.create"),
      makeCtx(goalKind("action.goal.create"), {
        sessionId: "ses_goal",
        rawObjective: "ship the workflow",
        ...params,
      })
    )
    return (result.output as { goalId: string; goal: Record<string, unknown> }).goalId
  }

  it("creates a goal through GoalRuntime and returns a redaction-safe snapshot", async () => {
    const result = await exec(
      goalKind("action.goal.create"),
      makeCtx(goalKind("action.goal.create"), {
        sessionId: "ses_goal",
        rawObjective: "email alice@example.com when done",
        startPaused: true,
        config: { maxTurns: 5 },
      })
    )
    const out = result.output as { goalId: string; goal: Record<string, unknown> }
    expect(out.goalId).toMatch(/^[0-9a-f]{8}-/)
    expect(out.goal.status).toBe("paused")
    expect(out.goal.safeObjective).toContain("<EMAIL_001>")
    expect(out.goal.hasRedactions).toBe(true)
    expect(out.goal).not.toHaveProperty("rawObjective")
    expect(out.goal).not.toHaveProperty("redactionMapEnc")
    expect((out.goal.config as { maxTurns: number }).maxTurns).toBe(5)
  })

  it("gets, lists, reads events, and computes analytics for existing goals", async () => {
    const firstId = await createGoal({ rawObjective: "first" })
    await createGoal({ rawObjective: "second" })

    const getResult = await exec(
      goalKind("action.goal.get"),
      makeCtx(goalKind("action.goal.get"), { goalId: firstId })
    )
    expect((getResult.output as { goal: { goalId: string } }).goal.goalId).toBe(firstId)

    const listResult = await exec(
      goalKind("action.goal.list"),
      makeCtx(goalKind("action.goal.list"), { mode: "session", sessionId: "ses_goal" })
    )
    const listed = listResult.output as { goals: Array<{ goalId: string }>; count: number }
    expect(listed.count).toBe(2)
    expect(listed.goals.map((g) => g.goalId)).toContain(firstId)

    const eventsResult = await exec(
      goalKind("action.goal.events"),
      makeCtx(goalKind("action.goal.events"), { goalId: firstId, limit: 10 })
    )
    expect((eventsResult.output as { events: unknown[] }).events.length).toBeGreaterThan(0)

    const analyticsResult = await exec(
      goalKind("action.goal.analytics"),
      makeCtx(goalKind("action.goal.analytics"), {
        scope: "session",
        sessionId: "ses_goal",
        windowDays: 7,
      })
    )
    const analytics = analyticsResult.output as { analytics: { total: number; terminal: number } }
    expect(analytics.analytics.total).toBe(2)
    // Creating the second goal auto-stops the first open goal through GoalRuntime.
    expect(analytics.analytics.terminal).toBe(1)
  })

  it("updates objectives and drives pause/resume/stop/preempt lifecycle actions", async () => {
    const goalId = await createGoal()

    const updateResult = await exec(
      goalKind("action.goal.updateObjective"),
      makeCtx(goalKind("action.goal.updateObjective"), {
        goalId,
        rawObjective: "ship the workflow with tests",
      })
    )
    expect((updateResult.output as { changed: boolean }).changed).toBe(true)

    const paused = await exec(
      goalKind("action.goal.pause"),
      makeCtx(goalKind("action.goal.pause"), { goalId })
    )
    expect((paused.output as { goal: { status: string } }).goal.status).toBe("paused")

    const resumed = await exec(
      goalKind("action.goal.resume"),
      makeCtx(goalKind("action.goal.resume"), { goalId })
    )
    expect((resumed.output as { goal: { status: string } }).goal.status).toBe("active")

    const stopped = await exec(
      goalKind("action.goal.stop"),
      makeCtx(goalKind("action.goal.stop"), { goalId })
    )
    expect((stopped.output as { goal: { status: string } }).goal.status).toBe("stopped")

    const preemptId = await createGoal({ rawObjective: "preempt me" })
    const preempted = await exec(
      goalKind("action.goal.preempt"),
      makeCtx(goalKind("action.goal.preempt"), { goalId: preemptId })
    )
    expect((preempted.output as { goal: { status: string } }).goal.status).toBe("preempted")
  })

  it("patches config, decomposes subgoals, toggles and clears them", async () => {
    const goalId = await createGoal()

    const configResult = await exec(
      goalKind("action.goal.updateConfig"),
      makeCtx(goalKind("action.goal.updateConfig"), {
        goalId,
        configJson: '{"maxTurns":9,"manualContinue":true}',
      })
    )
    expect(
      (configResult.output as { goal: { config: { maxTurns: number } } }).goal.config.maxTurns
    ).toBe(9)

    buildRendererLlmClientMock.mockReturnValue({
      complete: jest.fn().mockResolvedValue('{"steps":["Plan","Build"]}'),
    })
    const decomposed = await exec(
      goalKind("action.goal.decomposeSubgoals"),
      makeCtx(goalKind("action.goal.decomposeSubgoals"), { goalId })
    )
    const subgoals = (decomposed.output as { goal: { subgoals: Array<{ id: string }> } }).goal
      .subgoals
    expect(subgoals).toHaveLength(2)

    const toggled = await exec(
      goalKind("action.goal.toggleSubgoal"),
      makeCtx(goalKind("action.goal.toggleSubgoal"), { goalId, subgoalId: subgoals[0].id })
    )
    expect(
      (toggled.output as { goal: { subgoals: Array<{ done: boolean }> } }).goal.subgoals[0].done
    ).toBe(true)

    const cleared = await exec(
      goalKind("action.goal.clearSubgoals"),
      makeCtx(goalKind("action.goal.clearSubgoals"), { goalId })
    )
    expect((cleared.output as { goal: { subgoals: unknown[] } }).goal.subgoals).toEqual([])
  })

  it("deletes goals through the runtime", async () => {
    const goalId = await createGoal()
    const result = await exec(
      goalKind("action.goal.delete"),
      makeCtx(goalKind("action.goal.delete"), { goalId })
    )
    expect(result.output).toEqual({ goalId, deleted: true })
    const { getGoal } = await import("@/lib/db/goals")
    expect(await getGoal(goalId)).toBeUndefined()
  })

  it("creates goals from templates and lists filtered template rows", async () => {
    await getDb().goalTemplates.put({
      id: "gtpl_user_fav",
      title: "Favorite template",
      objectiveText: "ship from template",
      configOverrides: { maxTurns: 4 },
      builtin: false,
      isFavorite: true,
      sortOrder: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    const created = await exec(
      goalKind("action.goal.template.createGoal"),
      makeCtx(goalKind("action.goal.template.createGoal"), {
        templateId: "gtpl_user_fav",
        sessionId: "ses_template",
      })
    )
    const createdOut = created.output as { goalId: string; goal: { config: { maxTurns: number } } }
    expect(createdOut.goalId).toMatch(/^[0-9a-f]{8}-/)
    expect(createdOut.goal.config.maxTurns).toBe(4)

    const listed = await exec(
      goalKind("action.goal.template.list"),
      makeCtx(goalKind("action.goal.template.list"), {
        includeBuiltIn: false,
        favoriteOnly: true,
        query: "favorite",
      })
    )
    const listedOut = listed.output as {
      count: number
      templates: Array<{ templateId: string; title: string }>
      template: { templateId: string } | null
    }
    expect(listedOut.count).toBe(1)
    expect(listedOut.templates[0]).toEqual(
      expect.objectContaining({ templateId: "gtpl_user_fav", title: "Favorite template" })
    )
    expect(listedOut.template?.templateId).toBe("gtpl_user_fav")
  })

  it("upserts, favorites, and deletes user goal templates while protecting built-ins", async () => {
    const upserted = await exec(
      goalKind("action.goal.template.upsert"),
      makeCtx(goalKind("action.goal.template.upsert"), {
        title: "Workflow template",
        objectiveText: "Run this objective",
        configJson: '{"maxTurns":6}',
        isFavorite: true,
        sortOrder: 7,
      })
    )
    const upsertOut = upserted.output as {
      templateId: string
      template: { configOverrides: { maxTurns: number } }
    }
    expect(upsertOut.templateId).toMatch(/^gtpl_/)
    expect(upsertOut.template.configOverrides.maxTurns).toBe(6)

    const favorite = await exec(
      goalKind("action.goal.template.favorite"),
      makeCtx(goalKind("action.goal.template.favorite"), {
        templateId: upsertOut.templateId,
        isFavorite: false,
      })
    )
    expect((favorite.output as { template: { isFavorite: boolean } }).template.isFavorite).toBe(
      false
    )

    const deleted = await exec(
      goalKind("action.goal.template.delete"),
      makeCtx(goalKind("action.goal.template.delete"), { templateId: upsertOut.templateId })
    )
    expect(deleted.output).toEqual({ templateId: upsertOut.templateId, deleted: true })
    expect(await getDb().goalTemplates.get(upsertOut.templateId)).toBeUndefined()

    const builtin = (await getDb().goalTemplates.toArray()).find((template) => template.builtin)
    expect(builtin).toBeTruthy()
    await expect(
      exec(
        goalKind("action.goal.template.delete"),
        makeCtx(goalKind("action.goal.template.delete"), { templateId: builtin!.id })
      )
    ).rejects.toThrow(/cannot delete built-in goal template/)
  })
})

describe("action.plan.*", () => {
  it("creates, reads, lists, and returns plan events", async () => {
    const created = await exec(
      "action.plan.create" as WorkflowNodeKind,
      makeCtx("action.plan.create" as WorkflowNodeKind, {
        sessionId: "ses_plan",
        title: "Workflow-authored plan",
        executionMode: "auto",
        stepsJson:
          '[{"title":"Collect context","kind":"agent_turn"},{"title":"Implement","kind":"agent_turn","dependsOn":[0]}]',
        configJson: '{"requireApproval":false,"maxStepRetries":2}',
      })
    )
    const createdOut = created.output as {
      planId: string
      plan: {
        title: string
        status: string
        totalSteps: number
        config: { maxStepRetries: number }
      }
    }
    expect(createdOut.planId).toMatch(/^[0-9a-f]{8}-/)
    expect(createdOut.plan.title).toBe("Workflow-authored plan")
    expect(createdOut.plan.status).toBe("approved")
    expect(createdOut.plan.totalSteps).toBe(2)
    expect(createdOut.plan.config.maxStepRetries).toBe(2)

    await appendPlanEvent({
      planId: createdOut.planId,
      kind: "approved",
      payload: { kind: "approved" },
    })

    const got = await exec(
      "action.plan.get" as WorkflowNodeKind,
      makeCtx("action.plan.get" as WorkflowNodeKind, { planId: createdOut.planId })
    )
    expect((got.output as { plan: { planId: string } }).plan.planId).toBe(createdOut.planId)

    const listed = await exec(
      "action.plan.list" as WorkflowNodeKind,
      makeCtx("action.plan.list" as WorkflowNodeKind, {
        mode: "session",
        sessionId: "ses_plan",
        status: "approved",
      })
    )
    const listedOut = listed.output as {
      count: number
      plans: Array<{ planId: string }>
      plan: { planId: string } | null
    }
    expect(listedOut.count).toBe(1)
    expect(listedOut.plans[0].planId).toBe(createdOut.planId)
    expect(listedOut.plan?.planId).toBe(createdOut.planId)

    const events = await exec(
      "action.plan.events" as WorkflowNodeKind,
      makeCtx("action.plan.events" as WorkflowNodeKind, { planId: createdOut.planId, limit: 10 })
    )
    const eventKinds = (events.output as { events: Array<{ kind: string }> }).events.map(
      (event) => event.kind
    )
    expect(eventKinds).toEqual(expect.arrayContaining(["plan_created", "approved"]))
  })

  it("updates drafts, controls lifecycle, sets step status, and deletes plans", async () => {
    const created = await exec(
      "action.plan.create" as WorkflowNodeKind,
      makeCtx("action.plan.create" as WorkflowNodeKind, {
        sessionId: "ses_lifecycle",
        title: "Lifecycle plan",
        stepsJson: '[{"title":"First","kind":"agent_turn"}]',
      })
    )
    const planId = (created.output as { planId: string }).planId

    const updated = await exec(
      "action.plan.updateDraft" as WorkflowNodeKind,
      makeCtx("action.plan.updateDraft" as WorkflowNodeKind, {
        planId,
        title: "Updated lifecycle plan",
        stepsJson: JSON.stringify((await getStoredPlan(planId))!.steps),
      })
    )
    expect((updated.output as { plan: { title: string } }).plan.title).toBe(
      "Updated lifecycle plan"
    )

    const approved = await exec(
      "action.plan.approve" as WorkflowNodeKind,
      makeCtx("action.plan.approve" as WorkflowNodeKind, { planId })
    )
    expect((approved.output as { plan: { status: string } }).plan.status).toBe("approved")

    const stepId = (await getStoredPlan(planId))!.steps[0].id
    const stepStatus = await exec(
      "action.plan.setStepStatus" as WorkflowNodeKind,
      makeCtx("action.plan.setStepStatus" as WorkflowNodeKind, {
        planId,
        stepId,
        status: "completed",
        result: "done",
        outputJson: '{"ok":true}',
        attempts: 1,
      })
    )
    const stepOut = stepStatus.output as {
      plan: { completedSteps: number; steps: Array<{ status: string; output: { ok: boolean } }> }
    }
    expect(stepOut.plan.completedSteps).toBe(1)
    expect(stepOut.plan.steps[0].status).toBe("completed")
    expect(stepOut.plan.steps[0].output.ok).toBe(true)

    await updatePlan(planId, { status: "executing" })
    const paused = await exec(
      "action.plan.pause" as WorkflowNodeKind,
      makeCtx("action.plan.pause" as WorkflowNodeKind, { planId })
    )
    expect((paused.output as { plan: { status: string } }).plan.status).toBe("paused")

    const resumed = await exec(
      "action.plan.resume" as WorkflowNodeKind,
      makeCtx("action.plan.resume" as WorkflowNodeKind, { planId })
    )
    expect((resumed.output as { plan: { status: string } }).plan.status).toBe("executing")

    const cancelled = await exec(
      "action.plan.cancel" as WorkflowNodeKind,
      makeCtx("action.plan.cancel" as WorkflowNodeKind, { planId })
    )
    expect((cancelled.output as { plan: { status: string } }).plan.status).toBe("cancelled")

    const rejectedPlan = await exec(
      "action.plan.create" as WorkflowNodeKind,
      makeCtx("action.plan.create" as WorkflowNodeKind, {
        sessionId: "ses_reject",
        title: "Reject plan",
        stepsJson: '[{"title":"First","kind":"agent_turn"}]',
      })
    )
    const rejectedPlanId = (rejectedPlan.output as { planId: string }).planId
    const rejected = await exec(
      "action.plan.reject" as WorkflowNodeKind,
      makeCtx("action.plan.reject" as WorkflowNodeKind, {
        planId: rejectedPlanId,
        feedback: "Needs a smaller scope",
      })
    )
    expect((rejected.output as { plan: { status: string } }).plan.status).toBe("cancelled")

    const deleted = await exec(
      "action.plan.delete" as WorkflowNodeKind,
      makeCtx("action.plan.delete" as WorkflowNodeKind, { planId: rejectedPlanId })
    )
    expect(deleted.output).toEqual({ planId: rejectedPlanId, deleted: true })
    expect(await getStoredPlan(rejectedPlanId)).toBeUndefined()
  })

  it("refines a plan through the renderer LLM client and PlanRuntime", async () => {
    const created = await exec(
      "action.plan.create" as WorkflowNodeKind,
      makeCtx("action.plan.create" as WorkflowNodeKind, {
        sessionId: "ses_refine",
        title: "Refine plan",
        stepsJson: '[{"title":"First","kind":"agent_turn"},{"title":"Second","kind":"agent_turn"}]',
      })
    )
    const planId = (created.output as { planId: string }).planId
    const complete = jest
      .fn()
      .mockResolvedValue('{"steps":["Audit","Patch","Verify"],"reasoning":"clearer"}')
    buildRendererLlmClientMock.mockReturnValue({ complete })

    const refined = await exec(
      "action.plan.refine" as WorkflowNodeKind,
      makeCtx("action.plan.refine" as WorkflowNodeKind, {
        planId,
        refinementType: "expand",
        trigger: "manual",
        customInstructions: "Preserve validation steps",
      })
    )

    const refinedOut = refined.output as {
      changed: boolean
      plan: { status: string; refinementCount: number; steps: Array<{ title: string }> }
    }
    expect(complete).toHaveBeenCalled()
    expect(refinedOut.changed).toBe(true)
    expect(refinedOut.plan.status).toBe("awaiting_approval")
    expect(refinedOut.plan.refinementCount).toBe(1)
    expect(refinedOut.plan.steps.map((step) => step.title)).toEqual(["Audit", "Patch", "Verify"])
  })
})

describe("action.scheduler.task.*", () => {
  it("creates, reads, lists, updates, pauses, resumes, and deletes scheduled tasks", async () => {
    const created = await exec(
      "action.scheduler.task.create" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.create" as WorkflowNodeKind, {
        name: "Workflow scheduler task",
        description: "Created from a workflow",
        type: "custom",
        triggerType: "cron",
        cronExpression: "0 1 * * *",
        timezone: "UTC",
        payloadJson: '{"prompt":"run nightly"}',
        configJson: '{"maxRetries":1,"timeout":10000}',
        notificationJson: '{"onComplete":false}',
        tagsRaw: "workflow, nightly",
      })
    )
    const createdOut = created.output as {
      taskId: string
      task: {
        taskId: string
        name: string
        type: string
        trigger: { type: string; cronExpression: string }
        payload: { prompt: string }
        tags: string[]
        config: { maxRetries: number }
        notification: { onComplete: boolean }
      }
    }
    expect(createdOut.taskId).toBe(createdOut.task.taskId)
    expect(createdOut.task.name).toBe("Workflow scheduler task")
    expect(createdOut.task.trigger).toEqual(
      expect.objectContaining({ type: "cron", cronExpression: "0 1 * * *" })
    )
    expect(createdOut.task.payload.prompt).toBe("run nightly")
    expect(createdOut.task.tags).toEqual(["workflow", "nightly"])
    expect(createdOut.task.config.maxRetries).toBe(1)
    expect(createdOut.task.notification.onComplete).toBe(false)

    const got = await exec(
      "action.scheduler.task.get" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.get" as WorkflowNodeKind, { taskId: createdOut.taskId })
    )
    expect((got.output as { task: { taskId: string } }).task.taskId).toBe(createdOut.taskId)

    const listed = await exec(
      "action.scheduler.task.list" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.list" as WorkflowNodeKind, {
        statuses: ["active"],
        types: ["custom"],
        tags: ["nightly"],
        search: "scheduler",
        limit: 10,
      })
    )
    const listedOut = listed.output as {
      count: number
      tasks: Array<{ taskId: string }>
      task: { taskId: string } | null
    }
    expect(listedOut.count).toBe(1)
    expect(listedOut.tasks[0].taskId).toBe(createdOut.taskId)
    expect(listedOut.task?.taskId).toBe(createdOut.taskId)

    const updated = await exec(
      "action.scheduler.task.update" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.update" as WorkflowNodeKind, {
        taskId: createdOut.taskId,
        name: "Updated scheduler task",
        status: "paused",
        payloadJson: '{"prompt":"updated"}',
      })
    )
    expect((updated.output as { changed: boolean; task: { name: string } }).changed).toBe(true)
    expect((updated.output as { task: { name: string } }).task.name).toBe("Updated scheduler task")

    const paused = await exec(
      "action.scheduler.task.pause" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.pause" as WorkflowNodeKind, { taskId: createdOut.taskId })
    )
    expect(paused.output).toEqual(
      expect.objectContaining({ taskId: createdOut.taskId, changed: true })
    )

    const resumed = await exec(
      "action.scheduler.task.resume" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.resume" as WorkflowNodeKind, { taskId: createdOut.taskId })
    )
    expect(resumed.output).toEqual(
      expect.objectContaining({ taskId: createdOut.taskId, changed: true })
    )

    const deleted = await exec(
      "action.scheduler.task.delete" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.delete" as WorkflowNodeKind, { taskId: createdOut.taskId })
    )
    expect(deleted.output).toEqual({ taskId: createdOut.taskId, deleted: true })
    expect(await schedulerDb.getTask(createdOut.taskId)).toBeNull()
  })

  it("runs a task immediately and exposes execution history", async () => {
    registerTaskExecutor("custom", async (task) => ({
      success: true,
      output: { echoed: task.payload?.prompt },
    }))
    const created = await exec(
      "action.scheduler.task.create" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.create" as WorkflowNodeKind, {
        name: "Run now task",
        type: "custom",
        triggerType: "once",
        runAt: "2099-01-01T00:00:00.000Z",
        payloadJson: '{"prompt":"execute"}',
      })
    )
    const taskId = (created.output as { taskId: string }).taskId

    const run = await exec(
      "action.scheduler.task.runNow" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.runNow" as WorkflowNodeKind, { taskId })
    )
    const runOut = run.output as {
      taskId: string
      executionId: string
      execution: { id: string; status: string; triggerSource: string; output: { echoed: string } }
    }
    expect(runOut.taskId).toBe(taskId)
    expect(runOut.executionId).toBe(runOut.execution.id)
    expect(runOut.execution.status).toBe("completed")
    expect(runOut.execution.triggerSource).toBe("run-now")
    expect(runOut.execution.output.echoed).toBe("execute")

    const executions = await exec(
      "action.scheduler.task.executions" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.executions" as WorkflowNodeKind, { taskId, limit: 5 })
    )
    const execOut = executions.output as {
      count: number
      executions: Array<{ executionId: string }>
      execution: { executionId: string } | null
    }
    expect(execOut.count).toBe(1)
    expect(execOut.executions[0].executionId).toBe(runOut.executionId)
    expect(execOut.execution?.executionId).toBe(runOut.executionId)

    const fetched = await exec(
      "action.scheduler.execution.get" as WorkflowNodeKind,
      makeCtx("action.scheduler.execution.get" as WorkflowNodeKind, {
        executionId: runOut.executionId,
      })
    )
    expect((fetched.output as { execution: { executionId: string } }).execution.executionId).toBe(
      runOut.executionId
    )

    const recent = await exec(
      "action.scheduler.executions.recent" as WorkflowNodeKind,
      makeCtx("action.scheduler.executions.recent" as WorkflowNodeKind, { limit: 5 })
    )
    const recentOut = recent.output as {
      count: number
      executions: Array<{ executionId: string }>
      execution: { executionId: string } | null
    }
    expect(recentOut.count).toBe(1)
    expect(recentOut.executions[0].executionId).toBe(runOut.executionId)
    expect(recentOut.execution?.executionId).toBe(runOut.executionId)
  })

  it("backfills interval tasks and exposes generated executions", async () => {
    registerTaskExecutor("custom", async (task, execution) => ({
      success: true,
      output: {
        prompt: task.payload?.prompt,
        scheduledFor: execution.scheduledFor?.toISOString(),
      },
    }))
    const created = await exec(
      "action.scheduler.task.create" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.create" as WorkflowNodeKind, {
        name: "Backfill task",
        type: "custom",
        triggerType: "interval",
        intervalMs: 1000,
        payloadJson: '{"prompt":"backfill"}',
      })
    )
    const task = (created.output as { taskId: string; task: { createdAt: Date } }).task
    const taskId = (created.output as { taskId: string }).taskId
    const start = new Date(task.createdAt.getTime() + 1000)
    const end = new Date(task.createdAt.getTime() + 3000)

    const backfilled = await exec(
      "action.scheduler.task.backfill" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.backfill" as WorkflowNodeKind, {
        taskId,
        start: start.toISOString(),
        end: end.toISOString(),
      })
    )
    const backfillOut = backfilled.output as {
      taskId: string
      count: number
      executions: Array<{
        executionId: string
        triggerSource: string
        status: string
        output: { prompt: string }
      }>
      execution: { executionId: string } | null
    }
    expect(backfillOut.taskId).toBe(taskId)
    expect(backfillOut.count).toBe(3)
    expect(backfillOut.executions).toHaveLength(3)
    expect(backfillOut.executions.map((execution) => execution.triggerSource)).toEqual([
      "backfill",
      "backfill",
      "backfill",
    ])
    expect(backfillOut.executions.every((execution) => execution.status === "completed")).toBe(true)
    expect(backfillOut.executions[0].output.prompt).toBe("backfill")
    expect(backfillOut.execution?.executionId).toBe(backfillOut.executions[0].executionId)
  })

  it("exports and imports scheduler task definitions", async () => {
    const created = await exec(
      "action.scheduler.task.create" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.create" as WorkflowNodeKind, {
        name: "Portable task",
        type: "custom",
        triggerType: "once",
        runAt: "2099-01-01T00:00:00.000Z",
        payloadJson: '{"prompt":"portable"}',
      })
    )
    const taskId = (created.output as { taskId: string }).taskId

    const exported = await exec(
      "action.scheduler.task.export" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.export" as WorkflowNodeKind, { taskIdsRaw: taskId })
    )
    const exportOut = exported.output as {
      version: number
      exportedAt: string
      count: number
      data: unknown
      tasks: Array<{ taskId: string; name: string }>
      task: { taskId: string } | null
    }
    expect(exportOut.version).toBe(1)
    expect(exportOut.exportedAt).toEqual(expect.any(String))
    expect(exportOut.count).toBe(1)
    expect(exportOut.tasks).toEqual([expect.objectContaining({ taskId, name: "Portable task" })])
    expect(exportOut.task?.taskId).toBe(taskId)

    await exec(
      "action.scheduler.task.delete" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.delete" as WorkflowNodeKind, { taskId })
    )
    expect(await schedulerDb.getTask(taskId)).toBeNull()

    const imported = await exec(
      "action.scheduler.task.import" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.import" as WorkflowNodeKind, {
        dataJson: JSON.stringify(exportOut.data),
        mode: "merge",
      })
    )
    expect(imported.output).toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
    })
    expect((await schedulerDb.getTask(taskId))?.name).toBe("Portable task")
  })

  it("reads scheduler status, statistics, and upcoming tasks", async () => {
    const created = await exec(
      "action.scheduler.task.create" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.create" as WorkflowNodeKind, {
        name: "Upcoming task",
        type: "custom",
        triggerType: "interval",
        intervalMs: 60_000,
      })
    )
    const taskId = (created.output as { taskId: string }).taskId

    const status = await exec(
      "action.scheduler.status" as WorkflowNodeKind,
      makeCtx("action.scheduler.status" as WorkflowNodeKind, {})
    )
    // Creating an active task lazily boots the scheduler and arms it through the
    // timing driver (see `scheduleTask` in lib/scheduler/task-scheduler.ts), so the
    // status node reports one armed task and nothing running.
    expect(status.output).toEqual({
      initialized: true,
      runningCount: 0,
      scheduledCount: 1,
    })

    const statistics = await exec(
      "action.scheduler.statistics" as WorkflowNodeKind,
      makeCtx("action.scheduler.statistics" as WorkflowNodeKind, {})
    )
    expect(statistics.output).toEqual(
      expect.objectContaining({
        totalTasks: 1,
        activeTasks: 1,
        totalExecutions: 0,
        upcomingExecutions: 1,
      })
    )

    const upcoming = await exec(
      "action.scheduler.upcoming" as WorkflowNodeKind,
      makeCtx("action.scheduler.upcoming" as WorkflowNodeKind, { limit: 5 })
    )
    const upcomingOut = upcoming.output as {
      count: number
      tasks: Array<{ taskId: string }>
      task: { taskId: string } | null
    }
    expect(upcomingOut.count).toBe(1)
    expect(upcomingOut.tasks[0].taskId).toBe(taskId)
    expect(upcomingOut.task?.taskId).toBe(taskId)
  })

  it("triggers event scheduler tasks with structured payloads", async () => {
    registerTaskExecutor("custom", async (task) => ({
      success: true,
      output: {
        base: task.payload?.base,
        event: task.payload?.event,
      },
    }))
    const created = await exec(
      "action.scheduler.task.create" as WorkflowNodeKind,
      makeCtx("action.scheduler.task.create" as WorkflowNodeKind, {
        name: "Event task",
        type: "custom",
        triggerType: "event",
        eventType: "external.updated",
        eventSource: "bridge",
        payloadJson: '{"base":true}',
      })
    )
    const taskId = (created.output as { taskId: string }).taskId

    const triggered = await exec(
      "action.scheduler.event.trigger" as WorkflowNodeKind,
      makeCtx("action.scheduler.event.trigger" as WorkflowNodeKind, {
        eventType: "external.updated",
        eventSource: "bridge",
        payloadJson: '{"recordId":"rec_1"}',
      })
    )
    expect(triggered.output).toEqual({
      eventType: "external.updated",
      eventSource: "bridge",
      triggered: true,
      payload: { recordId: "rec_1" },
    })

    const executions = await waitForSchedulerExecutions(taskId, 1)
    expect(executions).toHaveLength(1)
    expect(executions[0]).toEqual(
      expect.objectContaining({
        taskId,
        triggerSource: "event",
        status: "completed",
        output: {
          base: true,
          event: {
            type: "external.updated",
            source: "bridge",
            data: { recordId: "rec_1" },
          },
        },
      })
    )
  })
})

describe("action.skill.invoke (plugin overlay fallback)", () => {
  afterEach(() => __resetSkillsForTesting())

  it("resolves a plugin-contributed skill the Dexie table doesn't have", async () => {
    registerSkill(
      "p:brand-voice",
      {
        id: "p:brand-voice",
        name: "Brand voice",
        description: "tone",
        source: { kind: "inline", markdown: "Stay concise." },
        scope: "global",
      } as never,
      { pluginId: "p" }
    )
    const r = await exec(
      "action.skill.invoke",
      makeCtx("action.skill.invoke", { skillIds: "p:brand-voice" })
    )
    const out = r.output as { skills: Array<{ id: string }>; markdown: string }
    expect(out.skills).toEqual([{ id: "p:brand-voice", name: "Brand voice" }])
    expect(out.markdown).toContain("Stay concise.")
  })
})

describe("action.skill.upsert", () => {
  it("creates when no skillId is provided", async () => {
    const r = await exec(
      "action.skill.upsert",
      makeCtx("action.skill.upsert", {
        name: "Brand voice",
        content: "Stay formal.",
      })
    )
    const out = r.output as { skillId: string; action: string }
    expect(out.action).toBe("created")
    expect(out.skillId).toMatch(/^skill_/)
  })

  it("updates when skillId points to an existing row", async () => {
    const created = await exec(
      "action.skill.upsert",
      makeCtx("action.skill.upsert", { name: "Voice", content: "old" })
    )
    const id = (created.output as { skillId: string }).skillId
    const updated = await exec(
      "action.skill.upsert",
      makeCtx("action.skill.upsert", {
        skillId: id,
        content: "new content",
        description: "updated desc",
      })
    )
    expect((updated.output as { action: string }).action).toBe("updated")
    const stored = await getDb().skills.get(id)
    expect(stored?.content).toBe("new content")
    expect(stored?.description).toBe("updated desc")
  })

  it("rejects update against a missing id", async () => {
    await expect(
      exec(
        "action.skill.upsert",
        makeCtx("action.skill.upsert", { skillId: "skill_does_not_exist" })
      )
    ).rejects.toThrow(/not found/)
  })

  it("rejects creation without name + content", async () => {
    await expect(
      exec("action.skill.upsert", makeCtx("action.skill.upsert", { name: "Only name" }))
    ).rejects.toThrow(/'name' and 'content'/)
  })
})

describe("action.connector.send", () => {
  it("enqueues an outbound row in the queue", async () => {
    const r = await exec(
      "action.connector.send",
      makeCtx("action.connector.send", {
        adapterId: "telegram_main",
        conversationKey: "tg:chat:42",
        content: "Hello!",
      })
    )
    const out = r.output as {
      jobId: string
      adapterId: string
      idempotencyKey: string
    }
    expect(out.jobId).toMatch(/^oqj_/)
    expect(out.adapterId).toBe("telegram_main")
    // Default idempotency key derives from runId+stepId so retries dedupe.
    expect(out.idempotencyKey).toContain("run_test:n_test")

    const queued = await getDb().outboundQueue.get(out.jobId)
    expect(queued?.status).toBe("pending")
    expect(queued?.conversationKey).toBe("tg:chat:42")
    // The ref is derived from the composite key so adapters can resolve
    // the platform recipient (they read channelId, not the key).
    const ref = queued?.request.conversationRef as unknown as {
      platform: string
      channelId: string
    }
    expect(ref.platform).toBe("tg")
    expect(ref.channelId).toBe("42")
  })

  it("honours replyToMessageId / threadId / explicit idempotencyKey", async () => {
    const r = await exec(
      "action.connector.send",
      makeCtx("action.connector.send", {
        adapterId: "lark_main",
        conversationKey: "lark:lark_main:oc_chat_1",
        content: "threaded reply",
        replyToMessageId: "om_parent",
        threadId: "thr_9",
        idempotencyKey: "custom-key-1",
      })
    )
    const out = r.output as { jobId: string; conversationKey: string; idempotencyKey: string }
    // Thread id extends the FIFO lane key so threads get their own lane.
    expect(out.conversationKey).toBe("lark:lark_main:oc_chat_1:thr_9")
    expect(out.idempotencyKey).toBe("custom-key-1")
    const queued = await getDb().outboundQueue.get(out.jobId)
    expect(queued?.request.replyTo?.messageId).toBe("om_parent")
    const ref = queued?.request.conversationRef as unknown as {
      channelId: string
      threadTs?: string
    }
    expect(ref.channelId).toBe("oc_chat_1")
    expect(ref.threadTs).toBe("thr_9")
  })

  it("rejects a malformed conversationKey", async () => {
    await expect(
      exec(
        "action.connector.send",
        makeCtx("action.connector.send", {
          adapterId: "x",
          conversationKey: "not-a-composite-key",
          content: "y",
        })
      )
    ).rejects.toThrow(/malformed conversationKey/)
  })

  it("rejects empty adapter / conversation / content", async () => {
    await expect(
      exec(
        "action.connector.send",
        makeCtx("action.connector.send", { conversationKey: "x", content: "y" })
      )
    ).rejects.toThrow(/adapterId/)
    await expect(
      exec(
        "action.connector.send",
        makeCtx("action.connector.send", { adapterId: "x", content: "y" })
      )
    ).rejects.toThrow(/conversationKey/)
    await expect(
      exec(
        "action.connector.send",
        makeCtx("action.connector.send", { adapterId: "x", conversationKey: "y" })
      )
    ).rejects.toThrow(/content/)
  })

  it("threads editTargetMessageId into the queued request (edit-in-place)", async () => {
    const r = await exec(
      "action.connector.send",
      makeCtx("action.connector.send", {
        adapterId: "lark_main",
        conversationKey: "lark:lark_main:oc_chat_1",
        content: "updated body",
        editTargetMessageId: "om_existing_1",
      })
    )
    const out = r.output as { jobId: string }
    const queued = await getDb().outboundQueue.get(out.jobId)
    expect(queued?.request.editTargetMessageId).toBe("om_existing_1")
  })

  it("waitForDelivery resolves with the terminal state when the job settles", async () => {
    const execPromise = exec(
      "action.connector.send",
      makeCtx("action.connector.send", {
        adapterId: "tg_wait",
        conversationKey: "tg:tg_wait:chat_1",
        content: "await me",
        idempotencyKey: "wait-key-1",
        waitForDelivery: true,
        waitTimeoutMs: 10_000,
      })
    )
    // Settle the job from the outside once it appears (the runner would do
    // this in production) so the liveQuery wait resolves with `sent`.
    let jobId: string | undefined
    for (let i = 0; i < 100 && !jobId; i++) {
      const rows = await getDb().outboundQueue.toArray()
      jobId = rows.find((row) => row.idempotencyKey === "wait-key-1")?.id
      if (!jobId) await new Promise<void>((res) => setTimeout(res, 20))
    }
    expect(jobId).toBeDefined()
    await markSent(jobId!, "pm_settled_1")

    const r = await execPromise
    const out = r.output as {
      delivered: boolean
      status: string
      platformMessageId?: string
    }
    expect(out.delivered).toBe(true)
    expect(out.status).toBe("sent")
    expect(out.platformMessageId).toBe("pm_settled_1")
  })

  it("waitForDelivery times out with the latest snapshot (still pending)", async () => {
    const r = await exec(
      "action.connector.send",
      makeCtx("action.connector.send", {
        adapterId: "tg_wait2",
        conversationKey: "tg:tg_wait2:chat_1",
        content: "nobody delivers me",
        waitForDelivery: true,
        waitTimeoutMs: 100,
      })
    )
    const out = r.output as { delivered: boolean; status: string; platformMessageId?: string }
    expect(out.delivered).toBe(false)
    expect(out.status).toBe("pending")
    expect(out.platformMessageId).toBeUndefined()
  })

  it("sends an A2UI card segment when cardJson is set (content = plain-text mirror)", async () => {
    const surface = {
      components: { root: { id: "root", component: "Card", title: "Hi" } },
      dataModel: {},
      rootId: "root",
    }
    const r = await exec(
      "action.connector.send",
      makeCtx("action.connector.send", {
        adapterId: "lark_main",
        conversationKey: "lark:lark_main:oc_chat_1",
        content: "Hi (fallback)",
        cardJson: JSON.stringify(surface),
      })
    )
    const out = r.output as { jobId: string }
    const queued = await getDb().outboundQueue.get(out.jobId)
    const seg = queued?.request.segments[0] as unknown as {
      type: string
      surfaceId: string
      content: { rootId: string }
      plainTextMirror: string
    }
    expect(seg.type).toBe("a2ui")
    expect(seg.surfaceId).toBe("wf:run_test:n_test")
    expect(seg.content.rootId).toBe("root")
    expect(seg.plainTextMirror).toBe("Hi (fallback)")
  })

  it("rejects a cardJson that is not valid JSON or not an A2UI surface", async () => {
    await expect(
      exec(
        "action.connector.send",
        makeCtx("action.connector.send", {
          adapterId: "x",
          conversationKey: "tg:x:1",
          content: "y",
          cardJson: "{not json",
        })
      )
    ).rejects.toThrow(/not valid JSON/)
    await expect(
      exec(
        "action.connector.send",
        makeCtx("action.connector.send", {
          adapterId: "x",
          conversationKey: "tg:x:1",
          content: "y",
          cardJson: JSON.stringify({ nope: true }),
        })
      )
    ).rejects.toThrow(/components/)
  })
})

describe("action.connector.reaction", () => {
  it("adds a reaction through bus.addReactionOutbound", async () => {
    const r = await exec(
      "action.connector.reaction",
      makeCtx("action.connector.reaction", {
        adapterId: "lark_main",
        messageId: "om_1",
        emoji: "THUMBSUP",
      })
    )
    expect(mockAddReaction).toHaveBeenCalledWith("lark_main", "om_1", "THUMBSUP")
    expect((r.output as { reacted: boolean }).reacted).toBe(true)
  })

  it("fails non-retryably on unsupported adapters", async () => {
    mockAddReaction.mockResolvedValue({
      ok: false,
      error: { code: "unsupported", message: "no reactions", retryable: false },
    })
    await expect(
      exec(
        "action.connector.reaction",
        makeCtx("action.connector.reaction", { adapterId: "a", messageId: "m", emoji: "OK" })
      )
    ).rejects.toThrow(/unsupported/)
  })

  it("rejects missing params", async () => {
    await expect(
      exec(
        "action.connector.reaction",
        makeCtx("action.connector.reaction", { adapterId: "a", messageId: "m" })
      )
    ).rejects.toThrow(/emoji/)
  })

  it("surfaces the platform reactionId from add on the output", async () => {
    mockAddReaction.mockResolvedValue({ ok: true, reactionId: "rx_9" })
    const r = await exec(
      "action.connector.reaction",
      makeCtx("action.connector.reaction", {
        adapterId: "lark_main",
        messageId: "om_1",
        emoji: "OK",
      })
    )
    expect((r.output as { reactionId?: string }).reactionId).toBe("rx_9")
  })

  it("removes a reaction through bus.removeReactionOutbound when op=remove", async () => {
    const r = await exec(
      "action.connector.reaction",
      makeCtx("action.connector.reaction", {
        adapterId: "lark_main",
        messageId: "om_1",
        op: "remove",
        reactionId: "rx_9",
      })
    )
    expect(mockRemoveReaction).toHaveBeenCalledWith("lark_main", "om_1", "rx_9")
    expect((r.output as { reacted: boolean }).reacted).toBe(false)
  })

  it("rejects op=remove without a reactionId", async () => {
    await expect(
      exec(
        "action.connector.reaction",
        makeCtx("action.connector.reaction", {
          adapterId: "a",
          messageId: "m",
          op: "remove",
        })
      )
    ).rejects.toThrow(/reactionId/)
  })
})

describe("action.connector.forward", () => {
  it("forwards a single message through bus.forwardOutbound", async () => {
    mockForward.mockResolvedValue({ ok: true, platformMessageId: "om_fwd" })
    const r = await exec(
      "action.connector.forward",
      makeCtx("action.connector.forward", {
        adapterId: "lark_main",
        messageId: "om_1",
        targetConversationKey: "lark:lark_main:oc_dest",
      })
    )
    expect(mockForward).toHaveBeenCalledWith("lark_main", {
      messageId: "om_1",
      target: "lark:lark_main:oc_dest",
    })
    expect((r.output as { forwarded: boolean; platformMessageId?: string }).forwarded).toBe(true)
    expect((r.output as { platformMessageId?: string }).platformMessageId).toBe("om_fwd")
  })

  it("merge-forwards multiple message ids", async () => {
    mockForward.mockResolvedValue({ ok: true })
    await exec(
      "action.connector.forward",
      makeCtx("action.connector.forward", {
        adapterId: "lark_main",
        messageIds: ["om_1", "om_2"],
        targetConversationKey: "oc_dest",
      })
    )
    expect(mockForward).toHaveBeenCalledWith("lark_main", {
      messageIds: ["om_1", "om_2"],
      target: "oc_dest",
    })
  })

  it("rejects when neither messageId nor messageIds is provided", async () => {
    await expect(
      exec(
        "action.connector.forward",
        makeCtx("action.connector.forward", {
          adapterId: "a",
          targetConversationKey: "oc_dest",
        })
      )
    ).rejects.toThrow(/messageId/)
  })

  it("fails non-retryably on unsupported adapters", async () => {
    mockForward.mockResolvedValue({
      ok: false,
      error: { code: "unsupported", message: "no forward", retryable: false },
    })
    await expect(
      exec(
        "action.connector.forward",
        makeCtx("action.connector.forward", {
          adapterId: "a",
          messageId: "m",
          targetConversationKey: "oc_dest",
        })
      )
    ).rejects.toThrow(/unsupported/)
  })
})

describe("action.connector.delete", () => {
  it("deletes through bus.deleteOutbound", async () => {
    const r = await exec(
      "action.connector.delete",
      makeCtx("action.connector.delete", { adapterId: "lark_main", messageId: "om_2" })
    )
    expect(mockDeleteOutbound).toHaveBeenCalledWith("lark_main", "om_2")
    expect((r.output as { deleted: boolean }).deleted).toBe(true)
  })

  it("fails non-retryably when the adapter is not registered", async () => {
    mockDeleteOutbound.mockResolvedValue({
      ok: false,
      error: { code: "adapter_not_found", message: "gone", retryable: false },
    })
    await expect(
      exec(
        "action.connector.delete",
        makeCtx("action.connector.delete", { adapterId: "gone", messageId: "om_x" })
      )
    ).rejects.toThrow(/adapter_not_found/)
  })
})

describe("action.connector.waitReply", () => {
  const makeInbound = (overrides: Record<string, unknown> = {}) => ({
    conversationKey: "lark:lark_main:oc_chat_1",
    messageId: "om_reply_1",
    plainText: "approve please",
    sender: { id: "lark:u1", remoteUserId: "ou_u1" },
    mentions: { selfMentioned: false, users: [] },
    ...overrides,
  })

  it("resolves with the first matching inbound reply", async () => {
    const p = exec(
      "action.connector.waitReply",
      makeCtx("action.connector.waitReply", {
        conversationKey: "lark:lark_main:oc_chat_1",
        keywords: ["approve"],
        timeoutMs: 5_000,
      })
    )
    // Wait for the subscription, then fire a non-matching + a matching event.
    for (let i = 0; i < 50 && inboundObservers.length === 0; i++) {
      await new Promise<void>((res) => setTimeout(res, 10))
    }
    expect(inboundObservers.length).toBeGreaterThan(0)
    inboundObservers[0](makeInbound({ conversationKey: "lark:other:oc_x" })) // wrong convo
    inboundObservers[0](makeInbound({ plainText: "nothing relevant" })) // no keyword
    inboundObservers[0](makeInbound()) // matches
    const r = await p
    const out = r.output as { replied: boolean; messageId: string; senderId: string; text: string }
    expect(out.replied).toBe(true)
    expect(out.messageId).toBe("om_reply_1")
    expect(out.senderId).toBe("ou_u1")
    expect(out.text).toBe("approve please")
  })

  it("filters by senderIds and requireMention", async () => {
    const p = exec(
      "action.connector.waitReply",
      makeCtx("action.connector.waitReply", {
        conversationKey: "lark:lark_main:oc_chat_1",
        senderIds: ["ou_boss"],
        requireMention: true,
        timeoutMs: 5_000,
      })
    )
    for (let i = 0; i < 50 && inboundObservers.length === 0; i++) {
      await new Promise<void>((res) => setTimeout(res, 10))
    }
    inboundObservers[0](makeInbound()) // wrong sender
    inboundObservers[0](makeInbound({ sender: { id: "lark:boss", remoteUserId: "ou_boss" } })) // right sender, no mention
    inboundObservers[0](
      makeInbound({
        sender: { id: "lark:boss", remoteUserId: "ou_boss" },
        mentions: { selfMentioned: true, users: [] },
        messageId: "om_boss_ok",
      })
    )
    const r = await p
    expect((r.output as { messageId: string }).messageId).toBe("om_boss_ok")
  })

  it("resolves replied=false on timeout (not an error) and unsubscribes", async () => {
    const r = await exec(
      "action.connector.waitReply",
      makeCtx("action.connector.waitReply", {
        conversationKey: "lark:lark_main:oc_quiet",
        timeoutMs: 1_000,
      })
    )
    const out = r.output as { replied: boolean; timedOut: boolean }
    expect(out.replied).toBe(false)
    expect(out.timedOut).toBe(true)
    expect(inboundObservers).toHaveLength(0) // disposer ran
  })
})

describe("action.connector.draft", () => {
  it("creates a draft row in the connectorDrafts table", async () => {
    const r = await exec(
      "action.connector.draft",
      makeCtx("action.connector.draft", {
        conversationKey: "tg:chat:7",
        sessionId: "ses_x",
        content: "Draft reply",
      })
    )
    const out = r.output as { draftId: string }
    expect(out.draftId).toMatch(/^cdr_/)
    const stored = await getDb().connectorDrafts.get(out.draftId)
    expect(stored?.status).toBe("pending")
    expect(stored?.conversationKey).toBe("tg:chat:7")
  })

  it("respects ttlMs by setting expiresAt", async () => {
    const before = Date.now()
    const r = await exec(
      "action.connector.draft",
      makeCtx("action.connector.draft", {
        conversationKey: "k",
        sessionId: "s",
        content: "x",
        ttlMs: 5000,
      })
    )
    const out = r.output as { draftId: string }
    const stored = await getDb().connectorDrafts.get(out.draftId)
    expect(stored?.expiresAt).toBeDefined()
    expect((stored?.expiresAt as number) - before).toBeGreaterThanOrEqual(5000 - 50)
  })
})

describe("ai.classify", () => {
  it("returns one of the provided labels (using stub ai.prompt)", async () => {
    // Without provider/model/key the underlying ai.prompt falls back to a
    // stub that echoes the input, so the classifier can still pick a label
    // (the first one, since the stub completion contains the user input).
    const r = await exec(
      "ai.classify",
      makeCtx("ai.classify", {
        input: "urgent! my server is down",
        labels: ["urgent", "normal"],
      })
    )
    const out = r.output as { label: string; completion: string }
    expect(["urgent", "normal"]).toContain(out.label)
  })

  it("throws when labels list is empty", async () => {
    await expect(
      exec("ai.classify", makeCtx("ai.classify", { input: "x", labels: [] }))
    ).rejects.toThrow(/labels/)
  })

  it("throws when input is empty", async () => {
    await expect(
      exec("ai.classify", makeCtx("ai.classify", { input: "", labels: ["a"] }))
    ).rejects.toThrow(/input/)
  })
})

describe("ai.extract", () => {
  it("returns parseError when the stub completion isn't valid JSON", async () => {
    // Stub ai.prompt returns the user prompt unchanged → extract can't find
    // a JSON object → parseError surfaces.
    const r = await exec(
      "ai.extract",
      makeCtx("ai.extract", {
        input: "Order ID is ABC123 with total $42.50",
        schema: { orderId: "string", total: "number" },
      })
    )
    const out = r.output as { extracted: unknown; parseError?: string }
    expect(out.extracted).toBeNull()
    expect(out.parseError).toBeDefined()
  })

  it("rejects empty input", async () => {
    await expect(
      exec("ai.extract", makeCtx("ai.extract", { input: "", schema: {} }))
    ).rejects.toThrow(/input/)
  })
})

describe("ai.embed", () => {
  it("returns a normalized vector of the requested dimension", async () => {
    const r = await exec("ai.embed", makeCtx("ai.embed", { input: "embed me", dimension: 64 }))
    const out = r.output as { vector: number[]; dimension: number; kind: string }
    expect(out.dimension).toBe(64)
    expect(out.vector).toHaveLength(64)
    // Normalized — magnitude ≈ 1.
    const mag = Math.sqrt(out.vector.reduce((acc, v) => acc + v * v, 0))
    expect(mag).toBeCloseTo(1, 5)
    expect(out.kind).toBe("deterministic-hash")
  })

  it("falls back to default dimension when not specified", async () => {
    const r = await exec("ai.embed", makeCtx("ai.embed", { input: "x" }))
    const out = r.output as { dimension: number }
    expect(out.dimension).toBe(384)
  })

  it("rejects empty input", async () => {
    await expect(exec("ai.embed", makeCtx("ai.embed", { input: "" }))).rejects.toThrow(/input/)
  })
})

describe("flow.subworkflow", () => {
  it("invokes another workflow and returns its output", async () => {
    // Seed a small subworkflow.
    const { createWorkflow } = await import("@/lib/db/workflows")
    const { publishWorkflow } = await import("@/lib/workflow/publish/publish-workflow")
    const sub = await createWorkflow({
      name: "Sub",
      nodes: [
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
          data: { label: "set", params: { variable: "result", value: "hello" } },
        },
      ],
      edges: [{ id: "e1", source: "n_start", target: "n_set" }],
    })
    await publishWorkflow(sub.id, 1)
    const r = await exec("flow.subworkflow", makeCtx("flow.subworkflow", { workflowId: sub.id }))
    const out = r.output as { runId: string; status: string }
    expect(out.runId).toMatch(/^run_/)
    expect(out.status).toBe("succeeded")
  })

  it("rejects a missing workflowId", async () => {
    await expect(exec("flow.subworkflow", makeCtx("flow.subworkflow", {}))).rejects.toThrow(
      /workflowId/
    )
  })

  it("surfaces a non-existent workflow as a non-retryable error", async () => {
    await expect(
      exec("flow.subworkflow", makeCtx("flow.subworkflow", { workflowId: "wf_does_not_exist" }))
    ).rejects.toMatchObject({ retryable: false })
  })

  it("validates input against the target's declared interface (D5)", async () => {
    const { createWorkflow } = await import("@/lib/db/workflows")
    const { publishWorkflow } = await import("@/lib/workflow/publish/publish-workflow")
    const sub = await createWorkflow({
      name: "TypedSub",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: {
            label: "start",
            params: {
              inputSchema: {
                type: "object",
                properties: { topic: { type: "string" } },
                required: ["topic"],
              },
            },
          },
        },
      ],
      edges: [],
    })
    await publishWorkflow(sub.id, 1)
    // Missing required `topic` → rejected before the run starts.
    await expect(
      exec("flow.subworkflow", makeCtx("flow.subworkflow", { workflowId: sub.id, input: {} }))
    ).rejects.toThrow(/input violates the target's schema/)
    // Conforming input runs.
    const ok = await exec(
      "flow.subworkflow",
      makeCtx("flow.subworkflow", { workflowId: sub.id, input: { topic: "ai" } })
    )
    expect((ok.output as { status: string }).status).toBe("succeeded")
  })
})

describe("io.output", () => {
  const outSchema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  }

  it("returns the first upstream when no value is set", async () => {
    const r = await exec("io.output", makeCtx("io.output", {}, { up: { answer: "hi" } }))
    expect(r.output).toEqual({ value: { answer: "hi" } })
  })

  it("prefers an explicit value param over upstream", async () => {
    const r = await exec(
      "io.output",
      makeCtx("io.output", { value: { answer: "explicit" } }, { up: { answer: "upstream" } })
    )
    expect((r.output as { value: unknown }).value).toEqual({ answer: "explicit" })
  })

  it("validates the value against the output schema", async () => {
    const r = await exec(
      "io.output",
      makeCtx("io.output", { value: { answer: "ok" }, outputSchema: outSchema }, {})
    )
    expect(r.output).toEqual({ value: { answer: "ok" }, schemaValid: true })
  })

  it("throws (non-retryable) on a schema violation in fail mode", async () => {
    await expect(
      exec("io.output", makeCtx("io.output", { value: {}, outputSchema: outSchema }, {}))
    ).rejects.toMatchObject({ retryable: false })
  })

  it("passes through with schemaValid:false in soft mode", async () => {
    const r = await exec(
      "io.output",
      makeCtx("io.output", { value: {}, outputSchema: outSchema, onSchemaViolation: "soft" }, {})
    )
    const out = r.output as { schemaValid: boolean; schemaErrors: string[] }
    expect(out.schemaValid).toBe(false)
    expect(out.schemaErrors.join("\n")).toMatch(/answer/)
  })
})

describe("io.webhook.respond", () => {
  it("returns the supplied status / body / headers with deferred flag", async () => {
    const r = await exec(
      "io.webhook.respond",
      makeCtx("io.webhook.respond", {
        status: 201,
        body: { ok: true },
        headers: { "x-trace": "abc" },
      })
    )
    const out = r.output as {
      status: number
      body: unknown
      headers: Record<string, string>
      deliveryDeferred: boolean
    }
    expect(out.status).toBe(201)
    expect(out.body).toEqual({ ok: true })
    expect(out.headers["x-trace"]).toBe("abc")
    expect(out.deliveryDeferred).toBe(true)
  })

  it("defaults status to 200 and body to null when omitted", async () => {
    const r = await exec("io.webhook.respond", makeCtx("io.webhook.respond", {}))
    const out = r.output as { status: number; body: unknown }
    expect(out.status).toBe(200)
    expect(out.body).toBeNull()
  })

  it("delivers the response through the bridge when the trigger carries a correlation id", async () => {
    respondToWebhookMock.mockClear()
    respondToWebhookMock.mockResolvedValueOnce(true)
    const ctx = makeCtx("io.webhook.respond", {
      status: 201,
      body: { ok: true },
      headers: { "x-trace": "abc" },
    })
    ctx.trigger = {
      workflowId: "wf",
      kind: "trigger.webhook",
      payload: { correlationId: "whr_42", body: {} },
      originAt: 1,
    }

    const r = await exec("io.webhook.respond", ctx)
    const out = r.output as { status: number; delivered: boolean; deliveryDeferred?: boolean }

    expect(respondToWebhookMock).toHaveBeenCalledTimes(1)
    expect(respondToWebhookMock).toHaveBeenCalledWith("whr_42", {
      status: 201,
      // Non-string body is JSON-serialized for the wire.
      body: JSON.stringify({ ok: true }),
      headers: { "x-trace": "abc" },
    })
    expect(out.delivered).toBe(true)
    expect(out.deliveryDeferred).toBeUndefined()
  })

  it("passes a string body to the bridge verbatim", async () => {
    respondToWebhookMock.mockClear()
    respondToWebhookMock.mockResolvedValueOnce(false)
    const ctx = makeCtx("io.webhook.respond", { status: 200, body: "plain text" })
    ctx.trigger = {
      workflowId: "wf",
      kind: "trigger.webhook",
      payload: { correlationId: "whr_7" },
      originAt: 1,
    }
    const r = await exec("io.webhook.respond", ctx)
    expect(respondToWebhookMock).toHaveBeenCalledWith("whr_7", {
      status: 200,
      body: "plain text",
      headers: {},
    })
    // Delivery returns false when the request already timed out.
    expect((r.output as { delivered: boolean }).delivered).toBe(false)
  })

  it("does not call the bridge and defers when there is no correlation id", async () => {
    respondToWebhookMock.mockClear()
    const r = await exec(
      "io.webhook.respond",
      makeCtx("io.webhook.respond", { status: 200, body: { a: 1 } })
    )
    expect(respondToWebhookMock).not.toHaveBeenCalled()
    expect((r.output as { deliveryDeferred: boolean }).deliveryDeferred).toBe(true)
  })
})

describe("action.skill.invoke", () => {
  it("returns concatenated markdown for the listed skill ids", async () => {
    // Seed a couple of skills.
    await getDb().skills.bulkPut([
      {
        id: "skill_a",
        name: "Alpha",
        description: "alpha desc",
        systemPrompt: "Alpha body",
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as Skill,
      {
        id: "skill_b",
        name: "Beta",
        description: "beta desc",
        systemPrompt: "Beta body",
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
      } as unknown as Skill,
    ])
    const r = await exec(
      "action.skill.invoke",
      makeCtx("action.skill.invoke", { skillIds: "skill_a, skill_b" })
    )
    const out = r.output as { skills: Array<{ id: string }>; markdown: string }
    expect(out.skills.map((s) => s.id).sort()).toEqual(["skill_a", "skill_b"])
    expect(out.markdown).toContain("Alpha body")
    expect(out.markdown).toContain("Beta body")
  })

  it("returns empty result when no skill ids are configured", async () => {
    const r = await exec("action.skill.invoke", makeCtx("action.skill.invoke", { skillIds: "" }))
    expect(r.output).toEqual({ skills: [], markdown: "" })
  })
})

// ── action.team.task.dispatch (ADR-0022 §3.6) ────────────────────────────
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: jest.fn(),
}))

describe("action.team.task.dispatch", () => {
  const setupTeamCtx = async (params: {
    runId: string
    workers: { id: string; name: string }[]
  }) => {
    const { registerTeamRunContext, __resetTeamRunContextForTesting } =
      await import("@/lib/ai/agent/team/team-run-context")
    const { createTeammatePool } = await import("@/lib/ai/agent/team/teammate-pool")
    const { createBudgetGuard } = await import("@/lib/ai/agent/team/budget-guard")
    const { createTeamNotifier } = await import("@/lib/ai/agent/team/team-notifier")
    const { createConcurrencyController } =
      await import("@/lib/workflow/runtime/concurrency-controller")
    const { createModelPreferenceController } =
      await import("@/lib/workflow/runtime/model-preference-controller")
    __resetTeamRunContextForTesting()
    const teammates = params.workers.map((w) => ({
      id: w.id,
      name: w.name,
      teamId: "team-1",
      description: "",
      role: "teammate" as const,
      status: "idle" as const,
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    }))
    const notifier = createTeamNotifier({ runId: params.runId, teamId: "team-1" })
    const messages: Array<Record<string, unknown>> = []
    const taskStatuses: Array<Record<string, unknown>> = []
    const concurrency = createConcurrencyController(3)
    const modelPref = createModelPreferenceController()
    const pool = createTeammatePool({ teammates })
    const budget = createBudgetGuard({
      runId: params.runId,
      limit: 0,
      onCritical: "notify",
      notifier,
      concurrencyCtrl: concurrency,
      modelCtrl: modelPref,
    })
    const ctx = {
      runId: params.runId,
      teamId: "team-1",
      team: {
        id: "team-1",
        name: "Test",
        config: { defaultTimeout: 1_000 },
      } as never,
      pool,
      budget,
      notifier,
      concurrency,
      modelPref,
      storeWriter: {
        addMessage: (m: Record<string, unknown>) => messages.push(m),
        setTaskStatus: (id: string, status: string, result?: string, error?: string) =>
          taskStatuses.push({ id, status, result, error }),
        updateTeammate: () => {},
      },
      resolvedCapabilities: new Map(),
    }
    registerTeamRunContext(ctx as never)
    return { messages, taskStatuses, ctx }
  }

  beforeEach(async () => {
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockReset()
  })

  it("dispatches via executeAgent and returns text + teammateId", async () => {
    await setupTeamCtx({ runId: "run_dispatch_ok", workers: [{ id: "w1", name: "W1" }] })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    })
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_dispatch_ok"
    const r = await exec("action.team.task.dispatch", ctx)
    expect((r.output as { text: string }).text).toBe("result")
    expect((r.output as { teammateId: string }).teammateId).toBe("w1")
    // ADR-0090 Phase 6: this test host has no sidecar, so the tool-capable
    // claude dispatch degrades to text — the reason rides the node output.
    expect((r.output as { degradedReason?: string }).degradedReason).toBe("sidecar-unavailable")
  })

  it("honors params.assignedTo as the preferred teammate (skill-aware claim)", async () => {
    await setupTeamCtx({
      runId: "run_dispatch_assigned",
      workers: [
        { id: "w1", name: "W1" },
        { id: "w2", name: "W2" },
      ],
    })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "result",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
      assignedTo: "w2", // round-robin would pick w1 first; preference jumps to w2
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_dispatch_assigned"
    const r = await exec("action.team.task.dispatch", ctx)
    expect((r.output as { teammateId: string }).teammateId).toBe("w2")
  })

  it("throws nonRetryable when TeamRunContext is missing", async () => {
    const { __resetTeamRunContextForTesting } = await import("@/lib/ai/agent/team/team-run-context")
    __resetTeamRunContextForTesting()
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_no_ctx"
    await expect(exec("action.team.task.dispatch", ctx)).rejects.toThrow(/no TeamRunContext/)
  })

  it("throws retryable when pool has no available teammate", async () => {
    const { ctx: teamCtx } = await setupTeamCtx({
      runId: "run_no_team",
      workers: [{ id: "w1", name: "W1" }],
    })
    teamCtx.pool.recordFailure("w1", new Error("e1"))
    teamCtx.pool.recordFailure("w1", new Error("e2"))
    expect(teamCtx.pool.claim("anything")).toBeNull()
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_no_team"
    await expect(exec("action.team.task.dispatch", ctx)).rejects.toThrow(/no available teammate/)
  })

  it("records success in pool and accumulates budget on completion", async () => {
    const { ctx: teamCtx } = await setupTeamCtx({
      runId: "run_records",
      workers: [{ id: "w1", name: "W1" }],
    })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    })
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_records"
    await exec("action.team.task.dispatch", ctx)
    expect(teamCtx.budget.status().used).toBe(8)
  })

  it("records failure and rethrows when executeAgent throws", async () => {
    await setupTeamCtx({ runId: "run_fail", workers: [{ id: "w1", name: "W1" }] })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockRejectedValue(new Error("LLM down"))
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_fail"
    await expect(exec("action.team.task.dispatch", ctx)).rejects.toThrow(/LLM down/)
  })

  it("publishes the task result to the shared-memory blackboard after success", async () => {
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    useAgentTeamStore.getState().reset()
    await setupTeamCtx({ runId: "run_bb_write", workers: [{ id: "w1", name: "W1" }] })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "Deliverable done.",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "Title",
      description: "Desc",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_bb_write"
    await exec("action.team.task.dispatch", ctx)
    const entry = useAgentTeamStore.getState().sharedMemory["team-1"]?.["task:t1"]
    expect(entry?.value).toBe("Deliverable done.")
    expect(entry?.tags).toContain("task:t1")
  })

  it("injects upstream dependency results into the teammate prompt (blackboard read)", async () => {
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    useAgentTeamStore.getState().reset()
    const { autoPublishTaskResult } = await import("@/lib/ai/agent/team/shared-memory-orchestrator")
    autoPublishTaskResult({ id: "team-1" }, { id: "dep1", title: "Recon" }, "Recon found X.", {
      id: "w0",
      name: "Scout",
    })
    await setupTeamCtx({ runId: "run_bb_read", workers: [{ id: "w1", name: "W1" }] })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    const ctx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t2",
      title: "Build",
      description: "Desc",
      dependencies: ["dep1"],
    }) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = "run_bb_read"
    await exec("action.team.task.dispatch", ctx)
    const promptArg = (executeAgent as jest.Mock).mock.calls[0][0] as string
    expect(promptArg).toContain("Upstream results")
    expect(promptArg).toContain("Recon found X.")
  })
})

// ── action.team.task.review (ADR-0071) ───────────────────────────────────
describe("action.team.task.review", () => {
  type Verdict = { verdict: "approved" | "changes_requested"; feedback: string }

  const setupReviewCtx = async (params: {
    runId: string
    verdicts: Verdict[] | (() => Promise<Verdict>)
    workers?: { id: string; name: string }[]
    requireResultReview?: boolean
    workingDir?: string
    omitReviewer?: boolean
    omitLead?: boolean
  }) => {
    const { registerTeamRunContext, __resetTeamRunContextForTesting } =
      await import("@/lib/ai/agent/team/team-run-context")
    const { createTeammatePool } = await import("@/lib/ai/agent/team/teammate-pool")
    const { createBudgetGuard } = await import("@/lib/ai/agent/team/budget-guard")
    const { createTeamNotifier } = await import("@/lib/ai/agent/team/team-notifier")
    const { createConcurrencyController } =
      await import("@/lib/workflow/runtime/concurrency-controller")
    const { createModelPreferenceController } =
      await import("@/lib/workflow/runtime/model-preference-controller")
    __resetTeamRunContextForTesting()

    const member = (id: string, name: string, role: "lead" | "teammate") => ({
      id,
      name,
      teamId: "team-1",
      description: "",
      role,
      status: "idle" as const,
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    })
    const workers = (params.workers ?? [{ id: "w1", name: "W1" }]).map((w) =>
      member(w.id, w.name, "teammate")
    )
    const lead = member("lead-1", "Lead", "lead")

    const notifier = createTeamNotifier({ runId: params.runId, teamId: "team-1" })
    const messages: Array<Record<string, unknown>> = []
    const taskStatuses: Array<Record<string, unknown>> = []
    const events: Array<Record<string, unknown>> = []
    const concurrency = createConcurrencyController(3)
    const modelPref = createModelPreferenceController()
    const pool = createTeammatePool({ teammates: workers })
    const budget = createBudgetGuard({
      runId: params.runId,
      limit: 0,
      onCritical: "notify",
      notifier,
      concurrencyCtrl: concurrency,
      modelCtrl: modelPref,
    })

    const reviewCalls: Array<Record<string, unknown>> = []
    const queue = Array.isArray(params.verdicts) ? [...params.verdicts] : null
    const runLeadReview = jest.fn(async (args: Record<string, unknown>) => {
      reviewCalls.push(args)
      if (!queue) return (params.verdicts as () => Promise<Verdict>)()
      const next = queue.shift()
      if (!next) throw new Error("test: ran out of verdicts")
      return next
    })

    const ctx = {
      runId: params.runId,
      teamId: "team-1",
      team: {
        id: "team-1",
        name: "Test",
        config: {
          defaultTimeout: 1_000,
          taskReview: { enabled: true },
          ...(params.workingDir ? { workingDir: params.workingDir } : {}),
          ...(params.requireResultReview
            ? { governancePolicy: { approval: { requireResultReview: true } } }
            : {}),
        },
      } as never,
      pool,
      budget,
      notifier,
      concurrency,
      modelPref,
      ...(params.omitLead ? {} : { lead }),
      ...(params.omitReviewer ? {} : { runLeadReview }),
      storeWriter: {
        addMessage: (m: Record<string, unknown>) => messages.push(m),
        setTaskStatus: (id: string, status: string, result?: string, error?: string) =>
          taskStatuses.push({ id, status, result, error }),
        updateTeammate: () => {},
        addEvent: (e: Record<string, unknown>) => events.push(e),
      },
      resolvedCapabilities: new Map(),
    }
    registerTeamRunContext(ctx as never)
    return { messages, taskStatuses, events, runLeadReview, reviewCalls }
  }

  /** `upstream: null` = the dispatch node published nothing. */
  const reviewCtx = (runId: string, upstream?: Record<string, unknown> | null) => {
    const dispatchOutput =
      upstream === undefined ? { text: "the work", teammateId: "w1", teammateName: "W1" } : upstream
    const ctx = makeCtx(
      "action.team.task.review",
      {
        teamId: "team-1",
        taskId: "t1",
        title: "Title",
        description: "Desc",
        dispatchNodeId: "t1",
        maxRevisions: 2,
      },
      dispatchOutput === null ? {} : { t1: dispatchOutput }
    ) as StepExecutionContext<Record<string, unknown>>
    ;(ctx as { runId: string }).runId = runId
    return ctx
  }

  beforeEach(async () => {
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockReset()
  })

  it("approves on the first round and completes the task", async () => {
    const { taskStatuses, reviewCalls } = await setupReviewCtx({
      runId: "rv_ok",
      verdicts: [{ verdict: "approved", feedback: "looks good" }],
    })

    const r = await exec("action.team.task.review", reviewCtx("rv_ok"))

    expect((r.output as { verdict: string }).verdict).toBe("approved")
    expect((r.output as { revisions: number }).revisions).toBe(0)
    expect(taskStatuses).toContainEqual(
      expect.objectContaining({ id: "t1", status: "completed", result: "the work" })
    )
    // The lead judges the worker's actual deliverable, not just the task text.
    expect(reviewCalls[0]).toMatchObject({ workerOutput: "the work", revision: 0 })
  })

  it("leaves the card in human review when a human also wants the last word", async () => {
    const { taskStatuses } = await setupReviewCtx({
      runId: "rv_human",
      verdicts: [{ verdict: "approved", feedback: "ok" }],
      requireResultReview: true,
    })

    await exec("action.team.task.review", reviewCtx("rv_human"))

    expect(taskStatuses).toContainEqual(expect.objectContaining({ id: "t1", status: "review" }))
    expect(taskStatuses).not.toContainEqual(expect.objectContaining({ status: "completed" }))
  })

  it("re-dispatches the SAME worker with the lead's feedback, then approves", async () => {
    const { taskStatuses, reviewCalls } = await setupReviewCtx({
      runId: "rv_revise",
      verdicts: [
        { verdict: "changes_requested", feedback: "handle the empty case" },
        { verdict: "approved", feedback: "fixed" },
      ],
    })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({ text: "revised work" })

    const r = await exec("action.team.task.review", reviewCtx("rv_revise"))

    // The worker was actually asked to revise, with the feedback verbatim.
    const prompt = (executeAgent as jest.Mock).mock.calls[0][0] as string
    expect(prompt).toContain("handle the empty case")
    // The second review judges the REVISED output and replays its own feedback.
    expect(reviewCalls[1]).toMatchObject({
      workerOutput: "revised work",
      revision: 1,
      previousFeedback: "handle the empty case",
    })
    expect((r.output as { revisions: number }).revisions).toBe(1)
    expect(taskStatuses).toContainEqual(
      expect.objectContaining({ id: "t1", status: "completed", result: "revised work" })
    )
  })

  it("fails the task when the revision budget is exhausted", async () => {
    // A gate that gives up and approves is not a gate.
    const { taskStatuses } = await setupReviewCtx({
      runId: "rv_exhaust",
      verdicts: [
        { verdict: "changes_requested", feedback: "no" },
        { verdict: "changes_requested", feedback: "still no" },
        { verdict: "changes_requested", feedback: "final no" },
      ],
    })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({ text: "attempt" })

    await expect(exec("action.team.task.review", reviewCtx("rv_exhaust"))).rejects.toThrow(
      /still requested changes after 2 revision/
    )
    expect(taskStatuses).toContainEqual(expect.objectContaining({ id: "t1", status: "failed" }))
  })

  it("reviews once and never revises when the budget is zero", async () => {
    const { taskStatuses } = await setupReviewCtx({
      runId: "rv_zero",
      verdicts: [{ verdict: "changes_requested", feedback: "no" }],
    })
    const ctx = reviewCtx("rv_zero")
    ;(ctx.params as { maxRevisions: number }).maxRevisions = 0

    await expect(exec("action.team.task.review", ctx)).rejects.toThrow(/after 0 revision/)
    expect(taskStatuses).toContainEqual(expect.objectContaining({ status: "failed" }))
  })

  it("fails the task when the original worker is gone", async () => {
    const { taskStatuses } = await setupReviewCtx({
      runId: "rv_gone",
      verdicts: [{ verdict: "changes_requested", feedback: "fix it" }],
    })
    // Upstream names a worker that is not in this run's pool.
    const ctx = reviewCtx("rv_gone", { text: "work", teammateId: "ghost", teammateName: "Ghost" })

    await expect(exec("action.team.task.review", ctx)).rejects.toThrow(/no longer available/)
    expect(taskStatuses).toContainEqual(expect.objectContaining({ status: "failed" }))
  })

  it("fails the task when the reviewer itself fails — never silently approves", async () => {
    const { taskStatuses } = await setupReviewCtx({
      runId: "rv_boom",
      verdicts: async () => {
        throw new Error("No candidate providers were available.")
      },
    })

    await expect(exec("action.team.task.review", reviewCtx("rv_boom"))).rejects.toThrow(
      /could not review this task/
    )
    expect(taskStatuses).toContainEqual(expect.objectContaining({ status: "failed" }))
  })

  it("fails closed when review is enabled but no reviewer is wired", async () => {
    await setupReviewCtx({
      runId: "rv_nodep",
      verdicts: [{ verdict: "approved", feedback: "ok" }],
      omitReviewer: true,
    })
    await expect(exec("action.team.task.review", reviewCtx("rv_nodep"))).rejects.toThrow(
      /no lead\/reviewer is wired/
    )
  })

  it("fails closed when the team has no lead", async () => {
    await setupReviewCtx({
      runId: "rv_nolead",
      verdicts: [{ verdict: "approved", feedback: "ok" }],
      omitLead: true,
    })
    await expect(exec("action.team.task.review", reviewCtx("rv_nolead"))).rejects.toThrow(
      /no lead\/reviewer is wired/
    )
  })

  it("fails when the dispatch node produced no output to review", async () => {
    await setupReviewCtx({ runId: "rv_noout", verdicts: [{ verdict: "approved", feedback: "" }] })
    await expect(exec("action.team.task.review", reviewCtx("rv_noout", null))).rejects.toThrow(
      /no output from dispatch node/
    )
  })

  it("records the verdict in the team's messages and activity", async () => {
    const { messages, events } = await setupReviewCtx({
      runId: "rv_record",
      verdicts: [{ verdict: "approved", feedback: "ship it" }],
    })

    await exec("action.team.task.review", reviewCtx("rv_record"))

    expect(messages).toContainEqual(
      expect.objectContaining({
        senderId: "lead-1",
        recipientId: "w1",
        taskId: "t1",
        content: expect.stringContaining("ship it"),
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({ type: "plan_approved", taskId: "t1", teammateId: "lead-1" })
    )
  })

  it("records a rejection in the activity surface too", async () => {
    const { events } = await setupReviewCtx({
      runId: "rv_reject_evt",
      verdicts: [
        { verdict: "changes_requested", feedback: "nope" },
        { verdict: "approved", feedback: "ok" },
      ],
    })
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({ text: "revised" })

    await exec("action.team.task.review", reviewCtx("rv_reject_evt"))

    expect(events).toContainEqual(expect.objectContaining({ type: "plan_rejected", taskId: "t1" }))
  })

  it("reviews the deliverable text when there is no repo to diff", async () => {
    const { reviewCalls } = await setupReviewCtx({
      runId: "rv_text",
      verdicts: [{ verdict: "approved", feedback: "ok" }],
    })

    await exec("action.team.task.review", reviewCtx("rv_text"))

    expect(reviewCalls[0]).toMatchObject({ evidence: { kind: "text", files: [] } })
  })

  it("fails without a TeamRunContext", async () => {
    const { __resetTeamRunContextForTesting } = await import("@/lib/ai/agent/team/team-run-context")
    __resetTeamRunContextForTesting()
    await expect(exec("action.team.task.review", reviewCtx("rv_missing"))).rejects.toThrow(
      /no TeamRunContext/
    )
  })
})

// ── action.team.task.dispatch output validation (PR 6) ────────────────────
describe("action.team.task.dispatch output validation", () => {
  beforeEach(async () => {
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockReset()
  })

  it("empty output triggers EMPTY_OUTPUT retry path", async () => {
    const { ctx: teamCtx } = await (async () => {
      const { registerTeamRunContext, __resetTeamRunContextForTesting } =
        await import("@/lib/ai/agent/team/team-run-context")
      __resetTeamRunContextForTesting()
      const { createTeammatePool } = await import("@/lib/ai/agent/team/teammate-pool")
      const { createBudgetGuard } = await import("@/lib/ai/agent/team/budget-guard")
      const { createTeamNotifier } = await import("@/lib/ai/agent/team/team-notifier")
      const { createConcurrencyController } =
        await import("@/lib/workflow/runtime/concurrency-controller")
      const { createModelPreferenceController } =
        await import("@/lib/workflow/runtime/model-preference-controller")
      const teammates = [
        {
          id: "w1",
          name: "W1",
          teamId: "team-1",
          description: "",
          role: "teammate" as const,
          status: "idle" as const,
          config: {},
          completedTaskIds: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          progress: 0,
          createdAt: new Date(),
        },
      ]
      const notifier = createTeamNotifier({ runId: "run_empty", teamId: "team-1" })
      const concurrency = createConcurrencyController(3)
      const modelPref = createModelPreferenceController()
      const pool = createTeammatePool({ teammates })
      const budget = createBudgetGuard({
        runId: "run_empty",
        limit: 0,
        onCritical: "notify",
        notifier,
        concurrencyCtrl: concurrency,
        modelCtrl: modelPref,
      })
      const ctx = {
        runId: "run_empty",
        teamId: "team-1",
        team: { id: "team-1", name: "Test", config: { defaultTimeout: 1_000 } } as never,
        pool,
        budget,
        notifier,
        concurrency,
        modelPref,
        storeWriter: {
          addMessage: () => {},
          setTaskStatus: () => {},
          updateTeammate: () => {},
        },
        resolvedCapabilities: new Map(),
      }
      registerTeamRunContext(ctx as never)
      return { ctx }
    })()
    const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
    ;(executeAgent as jest.Mock).mockResolvedValue({
      text: "   \n  \t  ",
      usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
    })
    const stepCtx = makeCtx("action.team.task.dispatch", {
      teamId: "team-1",
      taskId: "t1",
      title: "T",
      description: "D",
    }) as StepExecutionContext<Record<string, unknown>>
    ;(stepCtx as { runId: string }).runId = "run_empty"
    await expect(exec("action.team.task.dispatch", stepCtx)).rejects.toThrow(/EMPTY_OUTPUT/)
    // Verify pool recorded the failure
    expect(teamCtx.pool.availableCount()).toBe(1) // single teammate still available (1 failure, no quarantine yet)
  })
})
