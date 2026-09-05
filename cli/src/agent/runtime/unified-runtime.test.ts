import path from "node:path"

import type {
  AgentEventEnvelope,
  CanonicalAgentEvent,
} from "@cognia/agent-config-types/agent-execution"
import type { RunAndCaptureResult } from "@/lib/claude/run-and-capture"

import type { ResolvedConfig } from "../../config/schema"
import type { AgentSession, AgentSessionParams, SendTurnOptions } from "../session-runner"
import { createSessionStore } from "../session-store/store"
import { createMemoryFs, type MemoryFs } from "../session-store/test-fs"
import { manifestPath } from "../session-store/paths"
import { selectBackend } from "./backend-select"
import { createProviderSessionLease } from "./provider-session"
import { runUnifiedTurn, type UnifiedTurnParams } from "./unified-runtime"

const HOME = path.join(path.sep, "home", "u", ".cognia")
const REPO = path.join(path.sep, "repo")

const config = {
  provider: "anthropic",
  model: "claude-opus-5",
  permissionMode: "default",
  builtinTools: {},
  providers: {},
  cwd: REPO,
} as unknown as ResolvedConfig

/** A fake provider session that records what it was asked and replays a script. */
function fakeSession(
  script: Array<
    | {
        kind: "reply"
        text: string
        events?: Parameters<NonNullable<SendTurnOptions["onEvent"]>>[0][]
        usage?: Record<string, number>
        canonical?: CanonicalAgentEvent[]
      }
    | { kind: "throw"; error: unknown }
  >
) {
  const calls: string[] = []
  let closed = 0
  let index = 0
  const session: AgentSession = {
    sessionId: "fake",
    async send(prompt, opts) {
      calls.push(prompt)
      const step = script[Math.min(index, script.length - 1)]
      index += 1
      if (!step || step.kind === "throw") throw step?.error ?? new Error("no script")
      for (const event of step.events ?? []) opts.onEvent?.(event)
      for (const event of step.canonical ?? [])
        opts.onEnvelope?.({
          schemaVersion: 1,
          eventId: "inner",
          sequence: 0,
          sessionId: "fake",
          runId: "inner",
          turnId: "inner",
          attemptId: "inner",
          hostRef: "cli",
          runtime: "builtin",
          timestamp: new Date(0).toISOString(),
          event,
        })
      return {
        text: step.text,
        ...(step.usage ? { usage: step.usage } : {}),
      } as unknown as RunAndCaptureResult
    },
    async close() {
      closed += 1
    },
  }
  return {
    factory: (_params: AgentSessionParams) => session,
    get calls() {
      return calls
    },
    get closed() {
      return closed
    },
  }
}

function params(fsx: MemoryFs, overrides: Partial<UnifiedTurnParams> = {}): UnifiedTurnParams {
  let clock = 1_700_000_000_000
  return {
    config,
    prompt: "do the thing",
    gate: async () => ({ behavior: "deny", message: "denied" }),
    home: HOME,
    store: createSessionStore({ home: HOME, fsx, now: () => (clock += 1000), heartbeatMs: 0 }),
    now: () => (clock += 1),
    random: () => 0.5,
    retry: { maxRetries: 0 },
    ...overrides,
  } as UnifiedTurnParams
}

describe("backend selection", () => {
  it("fails without spawning anything when the backend is unknown", async () => {
    const fsx = createMemoryFs()
    const provider = fakeSession([{ kind: "reply", text: "never" }])
    const { result } = await runUnifiedTurn(
      params(fsx, {
        config: { ...config, agentBackend: "nope" } as ResolvedConfig,
        createSession: provider.factory,
      })
    )
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("usage_error")
    expect(result.session.persisted).toBe(false)
    expect(provider.calls).toHaveLength(0)
    expect(fsx.files.size).toBe(0)
  })

  it("fails with unsupported_capability rather than dropping the requirement", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        requires: ["subagents.native"],
        selectBackendFn: ((opts) =>
          selectBackend({
            ...opts,
            requested: "fake-external",
            lookupPreset: (() => ({ name: "Fake", protocol: "acp" })) as never,
            listPresets: () => ["fake-external"],
          })) as typeof selectBackend,
        createSession: fakeSession([{ kind: "reply", text: "x" }]).factory,
      })
    )
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("unsupported_capability")
    expect(result.error?.capability).toBe("subagents.native")
  })

  it("reports the selected backend and its capabilities on success", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "ok" }]).factory })
    )
    expect(result.backend).toBe("builtin")
    expect(result.capabilities).toContain("subagents.native")
  })

  it("passes an output contract to the provider session and returns its structured value", async () => {
    const fsx = createMemoryFs()
    const schema = { type: "object", properties: { summary: { type: "string" } } }
    const createSession = jest.fn((_sessionParams: AgentSessionParams): AgentSession => ({
      sessionId: "fake",
      async send() {
        return {
          text: "done",
          messageId: "message-1",
          a2uiSurfaces: {},
          a2uiSurfaceOrder: [],
          structuredOutput: { summary: "shipped" },
        }
      },
      async close() {},
    }))
    const { result } = await runUnifiedTurn(params(fsx, { outputSchema: schema, createSession }))
    expect(createSession.mock.calls[0]?.[0].outputSchema).toEqual(schema)
    expect(result.structuredOutput).toEqual({ summary: "shipped" })
  })

  it("warns about an unmet preference without failing", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        prefers: ["steer"],
        createSession: fakeSession([{ kind: "reply", text: "ok" }]).factory,
      })
    )
    expect(result.status).toBe("completed")
    expect(result.warnings?.[0]).toMatchObject({ code: "capability_unavailable" })
  })

  it("routes an external backend to the external factory, not the built-in one", async () => {
    const fsx = createMemoryFs()
    const builtin = fakeSession([{ kind: "reply", text: "builtin" }])
    const external = fakeSession([{ kind: "reply", text: "external" }])
    const { result } = await runUnifiedTurn(
      params(fsx, {
        selectBackendFn: (() =>
          selectBackend({
            requested: "fake-external",
            lookupPreset: (() => ({ name: "Fake", protocol: "acp" })) as never,
            listPresets: () => ["fake-external"],
          })) as typeof selectBackend,
        createSession: builtin.factory,
        createExternalSession: external.factory as never,
      })
    )
    expect(result.text).toBe("external")
    expect(builtin.calls).toHaveLength(0)
    expect(external.calls).toEqual(["do the thing"])
  })
})

describe("successful turn", () => {
  it("returns a valid completed result with identities and text", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        createSession: fakeSession([
          {
            kind: "reply",
            text: "hello",
            events: [{ type: "text-delta", delta: "hello" }],
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        ]).factory,
      })
    )
    expect(result).toMatchObject({
      schemaVersion: 1,
      type: "result",
      status: "completed",
      text: "hello",
      backend: "builtin",
      model: "claude-opus-5",
      provider: "anthropic",
      usage: { inputTokens: 10, outputTokens: 3 },
    })
    expect(result.error).toBeUndefined()
    expect(result.runId).toMatch(/^run_/)
    expect(result.turnId).toBe(`${result.runId}:t0`)
    expect(result.attemptId).toBe(`${result.turnId}:a0`)
  })

  it("preserves canonical tool progress and summaries without duplicating turn lifecycle", async () => {
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(createMemoryFs(), {
        onEnvelope: (event) => seen.push(event),
        createSession: fakeSession([
          {
            kind: "reply",
            text: "done",
            canonical: [
              { kind: "lifecycle", phase: "started" },
              { kind: "tool-progress", toolCallId: "c1", toolName: "bash", elapsedMs: 10 },
              { kind: "tool-summary", summary: "Tests passed", toolCallIds: ["c1"] },
              { kind: "lifecycle", phase: "ended" },
            ],
          },
        ]).factory,
      })
    )
    expect(seen.filter((item) => item.event.kind === "tool-progress")).toHaveLength(1)
    expect(seen.filter((item) => item.event.kind === "tool-summary")).toHaveLength(1)
    expect(seen.filter((item) => item.event.kind === "lifecycle")).toHaveLength(2)
    expect(seen.every((item) => item.runId !== "inner")).toBe(true)
  })

  it("preserves recovered run and turn identities at the supplied attempt", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    const { result } = await runUnifiedTurn(
      params(fsx, {
        recoveryIdentity: { runId: "run-recovered", turnId: "turn-recovered", attempt: 3 },
        onEnvelope: (envelope) => seen.push(envelope),
        createSession: fakeSession([{ kind: "reply", text: "resumed" }]).factory,
      })
    )

    expect(result).toMatchObject({
      runId: "run-recovered",
      turnId: "turn-recovered",
      attemptId: "turn-recovered:a3",
      text: "resumed",
    })
    expect(seen).not.toHaveLength(0)
    expect(seen.every((envelope) => envelope.runId === "run-recovered")).toBe(true)
    expect(seen.every((envelope) => envelope.turnId === "turn-recovered")).toBe(true)
    expect(seen.every((envelope) => envelope.attemptId === "turn-recovered:a3")).toBe(true)
  })

  it("emits lifecycle, user-input and the streamed events as canonical envelopes", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          {
            kind: "reply",
            text: "hi",
            events: [
              { type: "text-delta", delta: "hi" },
              { type: "tool-call", toolName: "Bash", input: { command: "ls" }, id: "c1" },
            ],
          },
        ]).factory,
      })
    )
    expect(seen.map((e) => e.event.kind)).toEqual([
      "lifecycle",
      "user-input",
      "text-delta",
      "tool-call",
      "lifecycle",
    ])
    expect(seen.every((e) => e.schemaVersion === 1)).toBe(true)
    expect(seen.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4])
  })

  it("records the prompt before calling the provider, so a dead turn still shows the ask", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([{ kind: "throw", error: new Error("dead") }]).factory,
      })
    )
    const input = seen.find((e) => e.event.kind === "user-input")
    expect(input?.event).toEqual({ kind: "user-input", text: "do the thing" })
  })
})

describe("session persistence", () => {
  it("creates a canonical session and reports where it landed", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "hi" }]).factory })
    )
    expect(result.session.persisted).toBe(true)
    expect(result.session.sessionDir).toContain(result.sessionId)
    expect(result.session.turnCount).toBe(2)
    expect(fsx.files.has(manifestPath(HOME, result.sessionId))).toBe(true)
  })

  it("persists nothing at all under --no-session", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        persist: false,
        createSession: fakeSession([{ kind: "reply", text: "hi" }]).factory,
      })
    )
    expect(result.session).toEqual({ persisted: false })
    expect(fsx.files.size).toBe(0)
  })

  it("resumes an existing session and reports the resume fidelity", async () => {
    const fsx = createMemoryFs()
    const first = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "one" }]).factory })
    )
    const second = await runUnifiedTurn(
      params(fsx, {
        sessionId: first.result.sessionId,
        createSession: fakeSession([{ kind: "reply", text: "two" }]).factory,
      })
    )
    expect(second.result.sessionId).toBe(first.result.sessionId)
    expect(second.result.resume).toMatchObject({ native: false, fidelity: "contextual" })
    expect(second.result.session.turnCount).toBe(4)
  })

  it("reports session_locked without running the turn", async () => {
    const fsx = createMemoryFs()
    const first = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "one" }]).factory })
    )
    // Hold the lease with a live writer on another pid.
    const holder = createSessionStore({
      home: HOME,
      fsx,
      now: () => 1_700_000_100_000,
      host: "host-a",
      pid: 1,
      isProcessAlive: () => true,
      heartbeatMs: 0,
    })
    const held = holder.open(first.result.sessionId, { cwd: REPO })
    expect(held.ok).toBe(true)

    const provider = fakeSession([{ kind: "reply", text: "never" }])
    const { result } = await runUnifiedTurn(
      params(fsx, {
        sessionId: first.result.sessionId,
        createSession: provider.factory,
        store: createSessionStore({
          home: HOME,
          fsx,
          now: () => 1_700_000_100_001,
          host: "host-a",
          pid: 2,
          isProcessAlive: () => true,
          heartbeatMs: 0,
        }),
      })
    )
    expect(result.status).toBe("failed")
    expect(result.error?.code).toBe("session_locked")
    expect(provider.calls).toHaveLength(0)
  })

  it("releases the lease so the next run can open the same session", async () => {
    const fsx = createMemoryFs()
    const first = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "one" }]).factory })
    )
    const second = await runUnifiedTurn(
      params(fsx, {
        sessionId: first.result.sessionId,
        createSession: fakeSession([{ kind: "reply", text: "two" }]).factory,
      })
    )
    expect(second.result.status).toBe("completed")
  })
})

describe("failure and retry", () => {
  it("reports a provider failure as a structured error with no retry when disabled", async () => {
    const fsx = createMemoryFs()
    const provider = fakeSession([
      { kind: "throw", error: Object.assign(new Error("503"), { status: 503 }) },
    ])
    const { result } = await runUnifiedTurn(params(fsx, { createSession: provider.factory }))
    expect(result.status).toBe("failed")
    expect(result.error).toMatchObject({ code: "provider_error", message: "503" })
    expect(provider.calls).toHaveLength(1)
  })

  it("retries a transient failure before any output and succeeds", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    const provider = fakeSession([
      { kind: "throw", error: Object.assign(new Error("upstream"), { status: 503 }) },
      { kind: "reply", text: "recovered" },
    ])
    const { result } = await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 2, baseBackoffMs: 0 },
        onEnvelope: (e) => seen.push(e),
        createSession: provider.factory,
      })
    )
    expect(result.status).toBe("completed")
    expect(result.text).toBe("recovered")
    expect(provider.calls).toHaveLength(2)

    const retries = seen.filter((e) => e.event.kind === "retry").map((e) => e.event)
    expect(retries).toEqual([
      expect.objectContaining({ phase: "scheduled", attempt: 1, maxRetries: 2 }),
      expect.objectContaining({ phase: "succeeded", attempt: 1 }),
    ])
  })

  it("gives each attempt its own identity and restarts the sequence", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 0 },
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          { kind: "throw", error: Object.assign(new Error("x"), { status: 500 }) },
          { kind: "reply", text: "ok" },
        ]).factory,
      })
    )
    const attempts = [...new Set(seen.map((e) => e.attemptId))]
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatch(/:a0$/)
    expect(attempts[1]).toMatch(/:a1$/)
    expect(seen.filter((e) => e.attemptId === attempts[1])[0]?.sequence).toBe(0)
  })

  it("never replays a turn that already produced output", async () => {
    const fsx = createMemoryFs()
    // Emit text, then fail: the boundary has been crossed.
    const emitting: (p: AgentSessionParams) => AgentSession = () => ({
      sessionId: "fake",
      async send(_prompt, opts) {
        opts.onEvent?.({ type: "text-delta", delta: "partial answer" })
        throw Object.assign(new Error("died mid-stream"), { status: 503 })
      },
      async close() {},
    })
    const { result } = await runUnifiedTurn(
      params(fsx, { retry: { maxRetries: 2, baseBackoffMs: 0 }, createSession: emitting })
    )
    expect(result.status).toBe("failed")
    expect(result.error?.detail).toMatchObject({ notRetried: expect.stringContaining("text") })
  })

  it("never replays a turn that already ran a tool", async () => {
    const fsx = createMemoryFs()
    const toolRuns: string[] = []
    const running: (params: AgentSessionParams) => AgentSession = () => ({
      sessionId: "fake",
      async send(_prompt, opts) {
        toolRuns.push("Bash")
        opts.onEvent?.({ type: "tool-call", toolName: "Bash", input: {}, id: "c1" })
        throw Object.assign(new Error("died after tool"), { status: 500 })
      },
      async close() {},
    })
    const { result } = await runUnifiedTurn(
      params(fsx, { retry: { maxRetries: 2, baseBackoffMs: 0 }, createSession: running })
    )
    expect(result.status).toBe("failed")
    expect(toolRuns).toEqual(["Bash"])
    expect(result.error?.detail).toMatchObject({ notRetried: expect.stringContaining("Bash") })
  })

  it("emits an exhausted retry event when the budget runs out", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    const { result } = await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 0 },
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          { kind: "throw", error: Object.assign(new Error("down"), { status: 503 }) },
        ]).factory,
      })
    )
    expect(result.status).toBe("failed")
    const phases = seen
      .filter((e) => e.event.kind === "retry")
      .map((e) => (e.event as { phase: string }).phase)
    expect(phases).toEqual(["scheduled", "exhausted"])
    expect(seen.some((e) => e.event.kind === "failure")).toBe(true)
  })

  it("classifies an errno-style transport failure separately from an HTTP one", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        createSession: fakeSession([
          {
            kind: "throw",
            error: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
          },
        ]).factory,
      })
    )
    expect(result.error?.code).toBe("transport_error")
  })

  it("persists the failed attempts alongside the final one", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 0 },
        createSession: fakeSession([
          { kind: "throw", error: Object.assign(new Error("x"), { status: 500 }) },
          { kind: "reply", text: "ok" },
        ]).factory,
      })
    )
    const store = createSessionStore({ home: HOME, fsx, heartbeatMs: 0 })
    const attempts = new Set(store.readEnvelopes(result.sessionId).map((e) => e.attemptId))
    expect(attempts.size).toBe(2)
  })
})

describe("failure classification", () => {
  async function failWith(fsx: MemoryFs, error: unknown, extra: Partial<UnifiedTurnParams> = {}) {
    const { result } = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "throw", error }]).factory, ...extra })
    )
    return result
  }

  it("reads a statusCode as well as a status", async () => {
    const result = await failWith(
      createMemoryFs(),
      Object.assign(new Error("x"), { statusCode: 500 })
    )
    expect(result.error?.code).toBe("provider_error")
  })

  it("reads the httpStatus a RunAndCaptureError carries", async () => {
    // `RunAndCaptureError` has a `code` — but it is a capture label
    // (`session_error`), not an errno, so the transport branch used to swallow
    // every provider failure. The status the sidecar forwarded decides it.
    const result = await failWith(
      createMemoryFs(),
      Object.assign(new Error("HTTP 404: model not found"), {
        code: "session_error",
        httpStatus: 404,
      })
    )
    expect(result.error).toMatchObject({
      code: "provider_error",
      message: "HTTP 404: model not found",
    })
  })

  it("converts the sidecar's retryAfterMs into Retry-After seconds", async () => {
    // `parseRetryAfter` reads a bare number as SECONDS. Forwarding the
    // sidecar's 1500ms unconverted would ask for a 1500-SECOND wait, so the
    // scheduled delay is what proves the unit.
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 60_000 },
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          {
            kind: "throw",
            error: Object.assign(new Error("slow down"), {
              code: "session_error",
              httpStatus: 429,
              retryAfterMs: 1500,
            }),
          },
          { kind: "reply", text: "ok" },
        ]).factory,
      })
    )
    const scheduled = seen.find(
      (e) => e.event.kind === "retry" && (e.event as { phase: string }).phase === "scheduled"
    )
    expect(scheduled?.event).toMatchObject({ retryAfterMs: 1500, delayMs: 1500 })
  })

  it("honours a Retry-After response header", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 60_000 },
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          {
            kind: "throw",
            error: Object.assign(new Error("slow down"), {
              status: 429,
              headers: { get: (name: string) => (name === "retry-after" ? "0" : null) },
            }),
          },
          { kind: "reply", text: "ok" },
        ]).factory,
      })
    )
    const scheduled = seen.find(
      (e) => e.event.kind === "retry" && (e.event as { phase: string }).phase === "scheduled"
    )
    expect(scheduled?.event).toMatchObject({ retryAfterMs: 0, delayMs: 0 })
  })

  it("prefers an explicit retryAfter property over the header", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 0 },
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          {
            kind: "throw",
            error: Object.assign(new Error("slow"), {
              status: 429,
              retryAfter: 0,
              headers: { get: () => "30" },
            }),
          },
          { kind: "reply", text: "ok" },
        ]).factory,
      })
    )
    const scheduled = seen.find(
      (e) => e.event.kind === "retry" && (e.event as { phase: string }).phase === "scheduled"
    )
    expect(scheduled?.event).toMatchObject({ retryAfterMs: 0 })
  })

  it("stringifies a thrown non-Error and a message-less object", async () => {
    expect((await failWith(createMemoryFs(), "just a string")).error).toMatchObject({
      code: "provider_error",
      message: "just a string",
    })
    expect((await failWith(createMemoryFs(), { nope: true })).error?.code).toBe("provider_error")
  })
})

describe("configuration plumbing", () => {
  it("threads --max-steps onto the session config", async () => {
    const fsx = createMemoryFs()
    let seen: AgentSessionParams | null = null
    await runUnifiedTurn(
      params(fsx, {
        maxSteps: 7,
        createSession: ((p: AgentSessionParams) => {
          seen = p
          return {
            sessionId: "fake",
            async send() {
              return { text: "ok" } as unknown as RunAndCaptureResult
            },
            async close() {},
          }
        }) as (p: AgentSessionParams) => AgentSession,
      })
    )
    expect((seen as unknown as AgentSessionParams).config.aiSdkMaxSteps).toBe(7)
  })

  it("leaves the config untouched when --max-steps is absent", async () => {
    const fsx = createMemoryFs()
    let seen: AgentSessionParams | null = null
    await runUnifiedTurn(
      params(fsx, {
        createSession: ((p: AgentSessionParams) => {
          seen = p
          return {
            sessionId: "fake",
            async send() {
              return { text: "ok" } as unknown as RunAndCaptureResult
            },
            async close() {},
          }
        }) as (p: AgentSessionParams) => AgentSession,
      })
    )
    expect((seen as unknown as AgentSessionParams).config.aiSdkMaxSteps).toBeUndefined()
  })

  it("falls back to the config's stream-idle deadline when no flag was given", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        config: { ...config, streamIdleTimeoutMs: 5 } as ResolvedConfig,
        createSession: (() => ({
          sessionId: "fake",
          async send(_prompt: string, opts: SendTurnOptions) {
            await new Promise((resolve) => setTimeout(resolve, 60))
            if (opts.signal?.aborted) throw Object.assign(new Error("t"), { name: "AbortError" })
            return { text: "too late" } as unknown as RunAndCaptureResult
          },
          async close() {},
        })) as (p: AgentSessionParams) => AgentSession,
      })
    )
    expect(result.status).toBe("timeout")
    expect(result.error?.code).toBe("idle_timeout")
  })

  it("honours an explicit --idle-timeout over the config value", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        idleTimeoutMs: 5,
        config: { ...config, streamIdleTimeoutMs: 60_000 } as ResolvedConfig,
        createSession: (() => ({
          sessionId: "fake",
          async send(_prompt: string, opts: SendTurnOptions) {
            await new Promise((resolve) => setTimeout(resolve, 60))
            if (opts.signal?.aborted) throw Object.assign(new Error("t"), { name: "AbortError" })
            return { text: "too late" } as unknown as RunAndCaptureResult
          },
          async close() {},
        })) as (p: AgentSessionParams) => AgentSession,
      })
    )
    expect(result.error?.code).toBe("idle_timeout")
  })

  it("builds its own store when none is injected, honouring --session-dir", async () => {
    const { result } = await runUnifiedTurn({
      config,
      prompt: "hi",
      gate: (async () => ({ behavior: "deny", message: "" })) as never,
      home: HOME,
      persist: false,
      sessionDirOverride: path.join(path.sep, "tmp", "store"),
      retry: { maxRetries: 0 },
      createSession: fakeSession([{ kind: "reply", text: "ok" }]).factory,
    })
    expect(result.status).toBe("completed")
    expect(result.session.persisted).toBe(false)
  })

  it("carries custom backoff bounds into the retry policy", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        retry: { maxRetries: 1, baseBackoffMs: 8, maxBackoffMs: 8 },
        random: () => 1,
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          { kind: "throw", error: Object.assign(new Error("x"), { status: 500 }) },
          { kind: "reply", text: "ok" },
        ]).factory,
      })
    )
    const scheduled = seen.find(
      (e) => e.event.kind === "retry" && (e.event as { phase: string }).phase === "scheduled"
    )
    expect(scheduled?.event).toMatchObject({ delayMs: 8 })
  })
})

describe("sparse and defaulted inputs", () => {
  it("reports unknown model and omits provider when the config names neither", async () => {
    const fsx = createMemoryFs()
    const bare = { ...config, model: undefined, provider: undefined } as unknown as ResolvedConfig
    const { result } = await runUnifiedTurn(
      params(fsx, {
        config: bare,
        createSession: fakeSession([{ kind: "reply", text: "" }]).factory,
      })
    )
    expect(result.model).toBe("unknown")
    expect(result.provider).toBeUndefined()
  })

  it("counts one appended turn when the model produced no text", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "" }]).factory })
    )
    expect(result.session.turnsAppended).toBe(1)
    expect(result.text).toBe("")
  })

  it("names a newly created session and can open one from another workspace", async () => {
    const fsx = createMemoryFs()
    const first = await runUnifiedTurn(
      params(fsx, {
        sessionName: "my run",
        createSession: fakeSession([{ kind: "reply", text: "one" }]).factory,
      })
    )
    expect(first.result.status).toBe("completed")

    const elsewhere = await runUnifiedTurn(
      params(fsx, {
        sessionId: first.result.sessionId,
        allowForeignWorkspace: true,
        sessionName: "renamed",
        config: { ...config, cwd: path.join(path.sep, "other") } as ResolvedConfig,
        createSession: fakeSession([{ kind: "reply", text: "two" }]).factory,
      })
    )
    expect(elsewhere.result.status).toBe("completed")
  })

  it("refuses a foreign workspace without the trust re-evaluation flag", async () => {
    const fsx = createMemoryFs()
    const first = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "one" }]).factory })
    )
    const { result } = await runUnifiedTurn(
      params(fsx, {
        sessionId: first.result.sessionId,
        config: { ...config, cwd: path.join(path.sep, "other") } as ResolvedConfig,
        createSession: fakeSession([{ kind: "reply", text: "two" }]).factory,
      })
    )
    expect(result.error?.code).toBe("resource_untrusted")
  })

  it("passes --include-diagnostics through to the emitter", async () => {
    const fsx = createMemoryFs()
    const seen: AgentEventEnvelope[] = []
    await runUnifiedTurn(
      params(fsx, {
        includeDiagnostics: true,
        onEnvelope: (e) => seen.push(e),
        createSession: fakeSession([
          {
            kind: "reply",
            text: "ok",
            events: [{ type: "mystery" } as never],
          },
        ]).factory,
      })
    )
    expect(seen.some((e) => e.event.kind === "diagnostic")).toBe(true)
  })

  it("normalizes cache and cost usage counters", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        createSession: fakeSession([
          {
            kind: "reply",
            text: "ok",
            usage: {
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
              total_cost_usd: 0.01,
            },
          },
        ]).factory,
      })
    )
    expect(result.usage).toEqual({
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      costUsd: 0.01,
    })
  })

  it("reports a branched session's lineage in the result", async () => {
    const fsx = createMemoryFs()
    const first = await runUnifiedTurn(
      params(fsx, { createSession: fakeSession([{ kind: "reply", text: "one" }]).factory })
    )
    const store = createSessionStore({ home: HOME, fsx, heartbeatMs: 0 })
    const branched = store.branch(first.result.sessionId, "forked", "clone")
    if (!branched.ok) throw new Error("expected branch")
    branched.value.close()

    const { result } = await runUnifiedTurn(
      params(fsx, {
        sessionId: "forked",
        createSession: fakeSession([{ kind: "reply", text: "two" }]).factory,
      })
    )
    expect(result.session.lineage).toEqual({
      parentSessionId: first.result.sessionId,
      kind: "clone",
    })
  })

  it("runs with no injected clock, randomness or home", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn({
      config,
      prompt: "hi",
      gate: (async () => ({ behavior: "deny", message: "" })) as never,
      persist: false,
      store: createSessionStore({ home: HOME, fsx, heartbeatMs: 0 }),
      retry: { maxRetries: 0 },
      createSession: fakeSession([{ kind: "reply", text: "ok" }]).factory,
    })
    expect(result.status).toBe("completed")
    expect(result.sessionId).toMatch(/^s_/)
  })
})

describe("cancellation", () => {
  it("reports a cancelled run when the caller's signal aborts", async () => {
    const fsx = createMemoryFs()
    const controller = new AbortController()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        signal: controller.signal,
        createSession: (() => ({
          sessionId: "fake",
          async send() {
            controller.abort()
            throw Object.assign(new Error("aborted"), { name: "AbortError" })
          },
          async close() {},
        })) as (p: AgentSessionParams) => AgentSession,
      })
    )
    expect(result.status).toBe("cancelled")
    expect(result.error?.code).toBe("cancelled")
  })

  it("reports a timeout distinctly from a cancellation", async () => {
    const fsx = createMemoryFs()
    const { result } = await runUnifiedTurn(
      params(fsx, {
        timeoutMs: 5,
        createSession: (() => ({
          sessionId: "fake",
          async send(_prompt, opts) {
            await new Promise((resolve) => setTimeout(resolve, 60))
            if (opts.signal?.aborted) throw Object.assign(new Error("t"), { name: "AbortError" })
            return { text: "too late" } as unknown as RunAndCaptureResult
          },
          async close() {},
        })) as (p: AgentSessionParams) => AgentSession,
      })
    )
    expect(result.status).toBe("timeout")
    expect(result.error?.code).toBe("timeout")
  })

  it("closes the provider session and releases the lease on every exit path", async () => {
    const scripts = [
      [{ kind: "reply" as const, text: "ok" }],
      [{ kind: "throw" as const, error: new Error("boom") }],
    ]
    for (const [index, script] of scripts.entries()) {
      // A fresh store per case: the deterministic clock+random would otherwise
      // mint the same session id twice and the second run would fail as
      // "already exists" before ever building a provider session.
      const fsx = createMemoryFs()
      const provider = fakeSession(script)
      const { result } = await runUnifiedTurn(
        params(fsx, { createSession: provider.factory, random: () => 0.25 * (index + 1) })
      )
      expect(result.status).toBe(index === 0 ? "completed" : "failed")
      expect(provider.closed).toBe(1)
      // The lease must be gone, so the session reopens cleanly.
      const store = createSessionStore({ home: HOME, fsx, heartbeatMs: 0 })
      const reopened = store.open(result.sessionId, { cwd: REPO })
      expect(reopened.ok).toBe(true)
      if (reopened.ok) reopened.value.close()
    }
  })
})

describe("provider-session lifetime", () => {
  it("closes its own session after a one-shot turn", async () => {
    const fsx = createMemoryFs()
    const provider = fakeSession([{ kind: "reply", text: "done" }])
    const { result } = await runUnifiedTurn(params(fsx, { createSession: provider.factory }))

    expect(result.status).toBe("completed")
    // Nobody else owns it, so the sidecar must not outlive the turn.
    expect(provider.closed).toBe(1)
  })

  it("leaves a BORROWED session open, so the conversation survives to the next turn", async () => {
    const fsx = createMemoryFs()
    const provider = fakeSession([{ kind: "reply", text: "done" }])
    const lease = createProviderSessionLease()

    const { result } = await runUnifiedTurn(
      params(fsx, { createSession: provider.factory, providerSession: lease })
    )

    expect(result.status).toBe("completed")
    expect(provider.closed).toBe(0)
    expect(lease.openKey).not.toBeNull()
    lease.close()
    expect(provider.closed).toBe(1)
  })

  it("reuses the borrowed session across turns instead of rebuilding context", async () => {
    const fsx = createMemoryFs()
    let builds = 0
    const provider = fakeSession([
      { kind: "reply", text: "first" },
      { kind: "reply", text: "second" },
    ])
    const lease = createProviderSessionLease()
    const createSession = (p: AgentSessionParams) => {
      builds += 1
      return provider.factory(p)
    }

    const first = await runUnifiedTurn(params(fsx, { createSession, providerSession: lease }))
    const second = await runUnifiedTurn(
      params(fsx, {
        createSession,
        providerSession: lease,
        sessionId: first.result.sessionId,
        prompt: "and again",
      })
    )

    expect(second.result.status).toBe("completed")
    expect(builds).toBe(1)
    expect(provider.calls).toEqual(["do the thing", "and again"])
    lease.close()
  })

  it("closes a borrowed session on cancellation — a cancelled turn strands nothing", async () => {
    const fsx = createMemoryFs()
    const provider = fakeSession([{ kind: "throw", error: new Error("aborted") }])
    const lease = createProviderSessionLease()
    const controller = new AbortController()
    controller.abort()

    const { result } = await runUnifiedTurn(
      params(fsx, {
        createSession: provider.factory,
        providerSession: lease,
        signal: controller.signal,
      })
    )

    expect(result.status).toBe("cancelled")
    expect(provider.closed).toBe(1)
    // The lease has let go, so the caller's next prompt builds a fresh session.
    expect(lease.openKey).toBeNull()
  })

  it("does not let a borrowed session answer for a backend the caller switched away from", async () => {
    const fsx = createMemoryFs()
    const built: string[] = []
    const provider = fakeSession([
      { kind: "reply", text: "a" },
      { kind: "reply", text: "b" },
    ])
    const lease = createProviderSessionLease()
    const createSession = (p: AgentSessionParams) => {
      built.push("build")
      return provider.factory(p)
    }

    const first = await runUnifiedTurn(params(fsx, { createSession, providerSession: lease }))
    await runUnifiedTurn(
      params(fsx, {
        createSession,
        providerSession: lease,
        sessionId: first.result.sessionId,
        config: { ...config, model: "claude-sonnet-5" } as ResolvedConfig,
      })
    )

    // Different model ⇒ different session, and the old one closed.
    expect(built).toHaveLength(2)
    expect(provider.closed).toBe(1)
    lease.close()
  })
})
