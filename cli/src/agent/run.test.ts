/**
 * @jest-environment node
 *
 * `runHeadlessTurn` is now a pure adapter over the unified runtime, so this
 * suite tests exactly that: parameter mapping in, result mapping out, and the
 * throwing contract legacy callers still rely on.
 *
 * The orchestration behaviours this file used to pin — sidecar bootstrap, MCP
 * and skill resolution, twin grounding, plugin-runtime hydration, unconditional
 * dispatcher subscription, db degradation, transcript writes, shutdown-on-throw
 * — moved to `createAgentSession` when the second orchestration was deleted,
 * and are covered by `session-runner.test.ts` / `session-context.test.ts`.
 * Re-asserting them here would test the mock, not the code.
 */
import type { AgentRunResultV1 } from "@cognia/agent-config-types/agent-run-result"

import { mintSessionId, runHeadlessTurn } from "./run"
import { runUnifiedTurn } from "./runtime/unified-runtime"
import type { UnifiedTurnParams } from "./runtime/unified-runtime"

jest.mock("./runtime/unified-runtime", () => ({ runUnifiedTurn: jest.fn() }))

const mockedRun = runUnifiedTurn as jest.MockedFunction<typeof runUnifiedTurn>

function result(overrides: Partial<AgentRunResultV1> = {}): AgentRunResultV1 {
  return {
    schemaVersion: 1,
    type: "result",
    status: "completed",
    sessionId: "s1",
    runId: "run_1",
    turnId: "run_1:t0",
    attemptId: "run_1:t0:a0",
    text: "hello",
    backend: "builtin",
    model: "claude-opus-5",
    capabilities: [],
    session: { persisted: false },
    ...overrides,
  }
}

const config = { cwd: "/repo", provider: "anthropic" } as never
const gate = (async () => ({ behavior: "deny", message: "" })) as never

function lastParams(): UnifiedTurnParams {
  const calls = mockedRun.mock.calls
  return calls[calls.length - 1]?.[0] as UnifiedTurnParams
}

beforeEach(() => {
  mockedRun.mockReset()
  mockedRun.mockResolvedValue({ result: result(), envelopes: [] })
})

describe("mintSessionId", () => {
  it("uses the s_ prefix and is deterministic given inputs", () => {
    expect(mintSessionId(1_700_000_000_000, 0.5)).toBe(mintSessionId(1_700_000_000_000, 0.5))
    expect(mintSessionId(1_700_000_000_000, 0.5)).toMatch(/^s_/)
    expect(mintSessionId(1, 0.5)).not.toBe(mintSessionId(2, 0.5))
  })
})

describe("runHeadlessTurn — parameter mapping", () => {
  it("forwards the required trio unchanged", async () => {
    await runHeadlessTurn({ config, prompt: "do it", gate })
    expect(lastParams()).toMatchObject({ config, prompt: "do it", gate })
  })

  it("omits every optional the caller did not supply", async () => {
    await runHeadlessTurn({ config, prompt: "p", gate })
    const params = lastParams()
    for (const key of [
      "sessionId",
      "signal",
      "timeoutMs",
      "maxSteps",
      "home",
      "resolveOptions",
      "transcriptFs",
      "now",
      "onEnvelope",
    ] as const) {
      expect(params[key]).toBeUndefined()
    }
  })

  it("forwards session id, home, timeout, signal and transcript effects", async () => {
    const signal = new AbortController().signal
    const transcriptFs = { append: jest.fn(), read: jest.fn(), mkdirp: jest.fn() }
    await runHeadlessTurn({
      config,
      prompt: "p",
      gate,
      sessionId: "s-existing",
      home: "/home/u/.cognia",
      timeoutMs: 1234,
      signal,
      transcriptFs,
    })
    expect(lastParams()).toMatchObject({
      sessionId: "s-existing",
      home: "/home/u/.cognia",
      timeoutMs: 1234,
      signal,
      transcriptFs,
    })
  })

  it("maps the deprecated maxTurns onto maxSteps", async () => {
    await runHeadlessTurn({ config, prompt: "p", gate, maxTurns: 9 })
    expect(lastParams().maxSteps).toBe(9)
  })

  it("forwards a narrowing resolveOptions for tool-less text turns", async () => {
    const resolveOptions = jest.fn()
    await runHeadlessTurn({ config, prompt: "p", gate, resolveOptions })
    expect(lastParams().resolveOptions).toBe(resolveOptions)
  })

  it("pins the clock when the caller supplied one", async () => {
    await runHeadlessTurn({ config, prompt: "p", gate, now: 42 })
    expect(lastParams().now?.()).toBe(42)
  })

  it("accepts — and ignores — the collaborators of the deleted orchestration", async () => {
    const subscribePluginTools = jest.fn()
    const loadPluginRuntime = jest.fn()
    await runHeadlessTurn({
      config,
      prompt: "p",
      gate,
      bootstrap: jest.fn(),
      capture: jest.fn(),
      subscribePluginTools,
      loadPluginRuntime,
      resolveMcpServers: jest.fn(),
      resolveSkillIds: jest.fn(),
      ensureDb: jest.fn(),
      onDatabaseError: jest.fn(),
      fetchTwin: jest.fn(),
      devPluginsDir: "/repo/plugins",
    })
    // The session factory owns these now; the adapter must not act on them.
    expect(subscribePluginTools).not.toHaveBeenCalled()
    expect(loadPluginRuntime).not.toHaveBeenCalled()
    const params = lastParams() as unknown as Record<string, unknown>
    expect(params.subscribePluginTools).toBeUndefined()
    expect(params.fetchTwin).toBeUndefined()
  })
})

describe("runHeadlessTurn — event bridging", () => {
  function envelopeWith(event: Record<string, unknown>) {
    return {
      schemaVersion: 1 as const,
      eventId: "e0",
      sequence: 0,
      sessionId: "s1",
      runId: "run_1",
      turnId: "t0",
      attemptId: "a0",
      hostRef: "h",
      runtime: "r",
      timestamp: "2026-01-01T00:00:00.000Z",
      event,
    } as Parameters<NonNullable<UnifiedTurnParams["onEnvelope"]>>[0]
  }

  it("projects canonical envelopes back onto the legacy capture union", async () => {
    mockedRun.mockImplementation(async (params) => {
      params.onEnvelope?.(envelopeWith({ kind: "text-delta", delta: "hi" }))
      return { result: result(), envelopes: [] }
    })

    const seen: unknown[] = []
    await runHeadlessTurn({ config, prompt: "p", gate, onEvent: (e) => seen.push(e) })
    expect(seen).toEqual([{ type: "text-delta", delta: "hi" }])
  })

  it("drops envelope-only kinds that have no capture representation", async () => {
    mockedRun.mockImplementation(async (params) => {
      params.onEnvelope?.(envelopeWith({ kind: "lifecycle", phase: "started" }))
      params.onEnvelope?.(envelopeWith({ kind: "text-delta", delta: "kept" }))
      return { result: result(), envelopes: [] }
    })

    const seen: unknown[] = []
    await runHeadlessTurn({ config, prompt: "p", gate, onEvent: (e) => seen.push(e) })
    expect(seen).toEqual([{ type: "text-delta", delta: "kept" }])
  })

  // `retry` used to be envelope-only, and this suite listed it among the kinds
  // that get dropped. It has a capture representation now, and a dropped retry
  // is a turn that streams nothing for the length of the provider's backoff
  // ladder without saying why, so the projection has to carry it.
  it("projects a retry, which is the only signal during a provider backoff", async () => {
    mockedRun.mockImplementation(async (params) => {
      params.onEnvelope?.(
        envelopeWith({
          kind: "retry",
          phase: "scheduled",
          attempt: 1,
          maxRetries: 2,
          code: "provider_error",
        })
      )
      return { result: result(), envelopes: [] }
    })

    const seen: unknown[] = []
    await runHeadlessTurn({ config, prompt: "p", gate, onEvent: (e) => seen.push(e) })
    expect(seen).toEqual([
      { type: "retry", phase: "scheduled", attempt: 1, maxRetries: 2, code: "provider_error" },
    ])
  })

  it("subscribes nothing when the caller passed no onEvent", async () => {
    await runHeadlessTurn({ config, prompt: "p", gate })
    expect(lastParams().onEnvelope).toBeUndefined()
  })
})

describe("runHeadlessTurn — result mapping", () => {
  it("returns the session id, text, usage and native session handle", async () => {
    mockedRun.mockResolvedValue({
      result: result({
        sessionId: "s-out",
        text: "the answer",
        usage: { inputTokens: 7, outputTokens: 2 },
        nativeSessionId: "sdk-9",
      }),
      envelopes: [],
    })
    await expect(runHeadlessTurn({ config, prompt: "p", gate })).resolves.toEqual({
      sessionId: "s-out",
      text: "the answer",
      usage: { inputTokens: 7, outputTokens: 2 },
      sdkSessionId: "sdk-9",
    })
  })

  it("omits usage and sdkSessionId when the run reported neither", async () => {
    await expect(runHeadlessTurn({ config, prompt: "p", gate })).resolves.toEqual({
      sessionId: "s1",
      text: "hello",
    })
  })

  it("preserves the throwing contract, carrying the error code as the name", async () => {
    mockedRun.mockResolvedValue({
      result: result({
        status: "failed",
        error: { code: "session_locked", message: "held by pid 12" },
      }),
      envelopes: [],
    })
    await expect(runHeadlessTurn({ config, prompt: "p", gate })).rejects.toMatchObject({
      name: "session_locked",
      message: "held by pid 12",
    })
  })

  it("throws for a cancelled run too, rather than returning empty text", async () => {
    mockedRun.mockResolvedValue({
      result: result({
        status: "cancelled",
        text: "",
        error: { code: "cancelled", message: "the turn was cancelled" },
      }),
      envelopes: [],
    })
    await expect(runHeadlessTurn({ config, prompt: "p", gate })).rejects.toMatchObject({
      name: "cancelled",
    })
  })
})
