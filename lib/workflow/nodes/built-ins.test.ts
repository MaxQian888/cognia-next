/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
// Importing built-ins triggers their side-effecting registrations.
import "./built-ins"
import { getExecutor } from "./registry"
import { registerSkill, __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import type { Skill } from "@/lib/claude/types"
import type {
  StepExecutionContext,
  StepExecutionResult,
  TriggerEvent,
  WorkflowNodeKind,
} from "@/types/workflow/visual"

const trigger: TriggerEvent = {
  workflowId: "wf",
  kind: "trigger.manual",
  payload: { greeting: "hi", n: 7 },
  originAt: 1_700_000_000,
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

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

  it("treats event mode as a no-op stub", async () => {
    const r = await exec("flow.wait", makeCtx("flow.wait", { mode: "event" }))
    expect((r.output as Record<string, unknown>).skipped).toBeDefined()
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
