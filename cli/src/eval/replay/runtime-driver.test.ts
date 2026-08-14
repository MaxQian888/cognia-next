import {
  REPLAY_PLACEHOLDER_API_KEY,
  createRuntimeDriver,
  createScriptedResponder,
} from "./runtime-driver"
import type { ReplayDriverContext } from "./run-replay"
import type { AgentSession, AgentSessionParams } from "../../agent/session-runner"
import type { ResolvedConfig } from "../../config/schema"
import type { ReplayScenarioV1 } from "@cognia/agent-config-types/model-request-surface"

const CONFIG = { cwd: "/tmp", provider: "anthropic", permissionMode: "default" } as ResolvedConfig

function scenario(overrides: Partial<ReplayScenarioV1> = {}): ReplayScenarioV1 {
  return {
    schemaVersion: 1,
    scenarioId: "sc-1",
    title: "runtime turn",
    level: "runtime",
    platform: "headless",
    actors: [{ actorRef: "root", role: "root" }],
    inputSteps: [{ kind: "prompt", actorRef: "root", text: "hello" }],
    permissionScript: [],
    expectations: { assertConsumed: true, fidelity: "full" },
    ...overrides,
  }
}

function context(scenarioOverrides: Partial<ReplayScenarioV1> = {}): ReplayDriverContext {
  return {
    fixture: { scenario: scenario(scenarioOverrides), tapes: [] },
    server: {
      baseUrlFor: (actorRef: string) => `http://127.0.0.1:9999/a/${actorRef}`,
      baseUrl: "http://127.0.0.1:9999",
      port: 9999,
      handled: [],
      start: async () => undefined,
      stop: async () => undefined,
    },
    ledger: { lease: () => ({}) as never, assertConsumed: () => ({ ok: true, problems: [] }) },
  }
}

interface FakeSession extends AgentSession {
  prompts: string[]
  params?: AgentSessionParams
  closed: boolean
}

function fakeSession(onSend?: (opts: Parameters<AgentSession["send"]>[1]) => Promise<void>): {
  session: FakeSession
  create: (params: AgentSessionParams) => AgentSession
} {
  const session: FakeSession = {
    sessionId: "s1",
    prompts: [],
    closed: false,
    async send(prompt, opts) {
      session.prompts.push(prompt)
      await onSend?.(opts)
      return {} as never
    },
    async close() {
      session.closed = true
    },
  }
  return {
    session,
    create: (params) => {
      session.params = params
      return session
    },
  }
}

describe("createScriptedResponder", () => {
  it("allows a scripted tool once", async () => {
    const { responder, entries } = createScriptedResponder([
      { actorRef: "root", toolName: "Read", decision: "allow" },
    ])
    await expect(responder({ toolName: "Read" } as never)).resolves.toEqual({ decision: "allow" })
    expect(entries[0].consumed).toBe(true)
  })

  it("denies a second request for a single-use entry", async () => {
    const { responder } = createScriptedResponder([
      { actorRef: "root", toolName: "Read", decision: "allow" },
    ])
    await responder({ toolName: "Read" } as never)
    const second = await responder({ toolName: "Read" } as never)
    expect(second.decision).toBe("deny")
  })

  it("honours a scripted denial", async () => {
    const { responder } = createScriptedResponder([
      { actorRef: "root", toolName: "Bash", decision: "deny" },
    ])
    const decision = await responder({ toolName: "Bash" } as never)
    expect(decision).toEqual({ decision: "deny", reason: "replay: scripted denial" })
  })

  it("denies anything the script did not anticipate", async () => {
    // A replay must never grant something the recording did not.
    const { responder } = createScriptedResponder([])
    const decision = await responder({ toolName: "Write" } as never)
    expect(decision.decision).toBe("deny")
    expect((decision as unknown as { reason: string }).reason).toContain("no scripted decision")
  })

  it("does not consume another actor's decision for the same tool", async () => {
    const script = [
      { actorRef: "root", toolName: "Read", decision: "allow" as const },
      { actorRef: "child-1", toolName: "Read", decision: "deny" as const },
    ]
    const root = createScriptedResponder(script, "root")
    const child = createScriptedResponder(script, "child-1", root.entries)

    await expect(child.responder({ toolName: "Read" } as never)).resolves.toMatchObject({
      decision: "deny",
    })
    await expect(root.responder({ toolName: "Read" } as never)).resolves.toEqual({
      decision: "allow",
    })
  })
})

describe("createRuntimeDriver", () => {
  it("points the session at the tape server with a placeholder credential", async () => {
    const { session, create } = fakeSession()
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    await driver(context())

    const resolved = await session.params?.resolveOptions?.({} as never)
    expect(resolved?.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999/a/root")
    expect(resolved?.env?.ANTHROPIC_API_KEY).toBe(REPLAY_PLACEHOLDER_API_KEY)
  })

  it("sanitizes inherited provider credentials and routes each child actor to its lease", async () => {
    const configured = {
      ...CONFIG,
      providers: {
        anthropic: {
          apiKey: "sk-real-secret",
          authToken: "oauth-real-secret",
          baseURL: "https://api.anthropic.com",
        },
      },
    } as ResolvedConfig
    const { session, create } = fakeSession()
    const driver = createRuntimeDriver({ config: configured, createSession: create })
    await driver(context())

    expect(session.params?.config.providers.anthropic).toEqual({
      apiKey: REPLAY_PLACEHOLDER_API_KEY,
      baseURL: "http://127.0.0.1:9999/a/root",
    })
    const child = await session.params?.resolveSubagentOptions?.("child-1", {} as never)
    expect(child?.env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999/a/child-1")
    expect(child?.env?.ANTHROPIC_API_KEY).toBe(REPLAY_PLACEHOLDER_API_KEY)
    expect(configured.providers.anthropic.apiKey).toBe("sk-real-secret")
  })

  it("never injects anything that looks like a real key", () => {
    // If this string reaches a provider log, the run escaped the tape server.
    expect(REPLAY_PLACEHOLDER_API_KEY).not.toMatch(/^sk-/)
    expect(REPLAY_PLACEHOLDER_API_KEY).toContain("no-credential")
  })

  it("sends every prompt step in order and closes the session", async () => {
    const { session, create } = fakeSession()
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    await driver(
      context({
        inputSteps: [
          { kind: "prompt", actorRef: "root", text: "first" },
          { kind: "prompt", actorRef: "root", text: "second" },
        ],
      })
    )
    expect(session.prompts).toEqual(["first", "second"])
    expect(session.closed).toBe(true)
  })

  it("rejects unsupported non-prompt steps instead of silently skipping them", async () => {
    const { session, create } = fakeSession()
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    await expect(
      driver(
        context({
          inputSteps: [
            { kind: "cancel", actorRef: "root" },
            { kind: "prompt", actorRef: "root", text: "only" },
          ],
        })
      )
    ).rejects.toThrow("runtime replay does not support cancel input steps")
    expect(session.prompts).toEqual([])
  })

  it("rejects direct prompt steps for child actors", async () => {
    const { create } = fakeSession()
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    await expect(
      driver(
        context({
          actors: [
            { actorRef: "root", role: "root" },
            { actorRef: "child-1", role: "child", parentActorRef: "root" },
          ],
          inputSteps: [{ kind: "prompt", actorRef: "child-1", text: "child prompt" }],
        })
      )
    ).rejects.toThrow("runtime replay cannot directly drive child actor child-1")
  })

  it("provides actor-scoped gates to dispatched children", async () => {
    const { session, create } = fakeSession()
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    await driver(
      context({
        actors: [
          { actorRef: "root", role: "root" },
          { actorRef: "child-1", role: "child", parentActorRef: "root" },
        ],
        permissionScript: [
          { actorRef: "root", toolName: "Read", decision: "allow" },
          { actorRef: "child-1", toolName: "Read", decision: "deny" },
        ],
      })
    )
    const childGate = session.params?.resolveSubagentGate?.("child-1")
    await expect(childGate?.({ toolName: "Read" } as never)).resolves.toMatchObject({
      decision: "deny",
    })
  })

  it("closes the session even when a turn throws", async () => {
    const { session, create } = fakeSession(async () => {
      throw new Error("turn failed")
    })
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    await expect(driver(context())).rejects.toThrow("turn failed")
    expect(session.closed).toBe(true)
  })

  it("reports a scripted permission the run never asked for", async () => {
    const { create } = fakeSession()
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    const looseEnds = await driver(
      context({ permissionScript: [{ actorRef: "root", toolName: "Read", decision: "allow" }] })
    )
    expect(looseEnds.unconsumedPermissions).toEqual([
      "Read (allow) was scripted but never requested",
    ])
  })

  it("reports nothing when every scripted permission was used", async () => {
    const { create } = fakeSession(async (opts) => {
      await opts.gate({ toolName: "Read" } as never)
    })
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    const looseEnds = await driver(
      context({ permissionScript: [{ actorRef: "root", toolName: "Read", decision: "allow" }] })
    )
    expect(looseEnds.unconsumedPermissions).toEqual([])
  })

  it("flags a child that never reported completion", async () => {
    const { create } = fakeSession(async (opts) => {
      opts.onEnvelope?.({
        schemaVersion: 1,
        eventId: "e1",
        sequence: 1,
        sessionId: "s1",
        runId: "r1",
        turnId: "t1",
        attemptId: "a1",
        hostRef: "h",
        runtime: "claude-agent-sdk",
        timestamp: "2026-08-14T00:00:00.000Z",
        event: { kind: "subagent", agentId: "child-1", phase: "started" } as never,
      })
    })
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    const looseEnds = await driver(context())
    expect(looseEnds.unfinishedChildren).toEqual(["child-1 never reported completion"])
  })

  it("does not flag a child that completed", async () => {
    const { create } = fakeSession(async (opts) => {
      for (const phase of ["started", "completed"]) {
        opts.onEnvelope?.({
          schemaVersion: 1,
          eventId: `e-${phase}`,
          sequence: 1,
          sessionId: "s1",
          runId: "r1",
          turnId: "t1",
          attemptId: "a1",
          hostRef: "h",
          runtime: "claude-agent-sdk",
          timestamp: "2026-08-14T00:00:00.000Z",
          event: { kind: "subagent", agentId: "child-1", phase } as never,
        })
      }
    })
    const driver = createRuntimeDriver({ config: CONFIG, createSession: create })
    const looseEnds = await driver(context())
    expect(looseEnds.unfinishedChildren).toEqual([])
  })
})
