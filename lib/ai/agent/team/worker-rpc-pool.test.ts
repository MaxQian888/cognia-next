import type { AgentWorkerManifestV1, CogniaClient, CogniaClientOptions } from "@cognia/agent"
import type { ResolvedAgentExecutionSpec } from "@cognia/agent-config-types/agent-execution"

import { selectRemoteWorker } from "./remote-worker-runtime"
import { WorkerRpcPool } from "./worker-rpc-pool"

const manifest: AgentWorkerManifestV1 = {
  manifestVersion: 1,
  runtime: "test",
  models: [],
  hardCapabilities: [],
  maxActiveTurns: 1,
  credentialProfileRefs: [],
  workspaceBindingRefs: [],
  taskWorkspace: { enabled: true },
  sandbox: { capabilities: [] },
  platform: { os: "test", arch: "test" },
  executionProfile: {
    profileVersion: 1,
    backendId: "test",
    runtimeAdapter: "external",
    modelBindings: { primary: "inherit" },
    deploymentRefs: ["provider:test"],
    capabilities: [],
  },
}

const executionSpec: ResolvedAgentExecutionSpec = {
  specVersion: 2,
  identity: { sessionId: "session", runId: "run", attemptId: "a1" },
  executionFingerprint: "aexf1-test",
  executionKind: "agent",
  runtimeAdapter: "external",
  runtimePolicySource: "legacy-mapped",
  deploymentRef: "provider:test",
  modelBindings: { primary: "inherit" },
  route: { kind: "direct", routePolicy: "direct" },
  hostRef: "headless-agent-host",
  compatibility: { evidence: "native" },
  capabilities: { effective: ["streaming"], disabledOptional: [] },
  credential: { profileRef: "credential:test", affinity: "sticky-with-failover" },
  fallbackPolicy: "none",
}

describe("WorkerRpcPool", () => {
  it("uses authenticated attach identity and transports RPC frames opaquely", async () => {
    const sent: string[] = []
    let now = 10
    const createClient = jest.fn(
      (_options: CogniaClientOptions) => new Promise<CogniaClient>(() => undefined)
    )
    const pool = new WorkerRpcPool({
      sendFrame: (_connectionId, frame) => sent.push(frame),
      now: () => now,
      createClient: createClient as never,
    })
    pool.attach({ connectionId: "connection-1", hostRef: "device:trusted", manifest })
    expect(pool.listWorkers()).toEqual([
      expect.objectContaining({ hostRef: "device:trusted", online: true, lastSeenAt: 10 }),
    ])

    const streams = createClient.mock.calls[0]?.[0]?.host
    expect(streams).toMatchObject({ kind: "streams" })
    if (!streams || streams.kind !== "streams") throw new Error("missing streams")
    streams.writable.write('{"jsonrpc":"2.0","id":1}\n')
    await new Promise((resolve) => setImmediate(resolve))
    expect(sent).toEqual(['{"jsonrpc":"2.0","id":1}'])

    now = 20
    pool.receive("connection-1", '{"jsonrpc":"2.0","id":1,"result":{}}')
    pool.receive("missing", "ignored")
    pool.receive("connection-1", "two\nframes")
    expect(pool.listWorkers()[0]?.lastSeenAt).toBe(20)
    pool.detach("connection-1", "offline")
    expect(pool.listWorkers()).toEqual([])
  })

  it("converts host send failures into stream errors", async () => {
    // The peer tears the connection down from the stream's `error` event. If the
    // throw escaped the write instead, only the one call that happened to be
    // writing would reject and every other in-flight request would hang.
    let host: Extract<NonNullable<CogniaClientOptions["host"]>, { kind: "streams" }> | undefined
    const createClient = jest.fn((options: CogniaClientOptions) => {
      if (options.host?.kind === "streams") host = options.host
      return new Promise<CogniaClient>(() => undefined)
    })
    const pool = new WorkerRpcPool({
      sendFrame: () => {
        throw "bridge failed"
      },
      createClient: createClient as never,
    })
    pool.attach({ connectionId: "connection-error", hostRef: "device:error", manifest })
    const streams = host
    if (!streams) throw new Error("missing streams")
    const errors: Error[] = []
    streams.writable.on("error", (error: Error) => errors.push(error))

    expect(streams.writable.write("frame\n")).toBe(false)
    expect(errors).toEqual([expect.objectContaining({ message: "bridge failed" })])
  })

  it("replaces an older connection for the same authenticated host", () => {
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (() => new Promise<CogniaClient>(() => undefined)) as never,
    })
    pool.attach({ connectionId: "old", hostRef: "device:a", manifest })
    pool.attach({ connectionId: "new", hostRef: "device:a", manifest })
    expect(pool.listWorkers()).toEqual([expect.objectContaining({ connectionId: "new" })])
  })

  it("rejects malformed worker manifests before placement", () => {
    const pool = new WorkerRpcPool({ sendFrame: jest.fn() })
    expect(
      pool.attach({
        connectionId: "malformed",
        hostRef: "device:trusted",
        manifest: { ...manifest, maxActiveTurns: 0 },
      })
    ).toBe(false)
    expect(pool.listWorkers()).toEqual([])
  })

  it("fails closed before RPC dispatch when prompt or handoff content leaks PII", async () => {
    const createSession = jest.fn()
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: { create: createSession, open: jest.fn() },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-1", hostRef: "device:trusted", manifest })

    await expect(
      pool.run({
        hostRef: "device:trusted",
        commandId: "lease-pii",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-run",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "Contact alice@example.com" },
          execution: { mode: "orchestrated" },
          resources: [],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: jest.fn(),
      })
    ).rejects.toThrow("PII redaction gate")
    expect(createSession).not.toHaveBeenCalled()
    expect(pool.listWorkers()[0]?.activeTurns).toBe(0)
  })

  it("fails closed before sending a steering message that leaks PII", async () => {
    const steer = jest.fn()
    const run = jest.fn()
    const session = {
      id: "session-1",
      events: async function* () {},
      run,
      steer,
      abort: jest.fn(),
      state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: { create: jest.fn(async () => session), open: jest.fn(async () => session) },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-1", hostRef: "device:trusted", manifest })

    await expect(
      pool.run({
        hostRef: "device:trusted",
        commandId: "lease-steer",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-run",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "safe prompt" },
          execution: { mode: "orchestrated" },
          resources: [],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: async (control) => control.steer("Contact alice@example.com", "steer-1"),
      })
    ).rejects.toThrow("PII redaction gate")
    expect(steer).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it("fills two one-slot workers without creating a second scheduler", async () => {
    const releases: Array<() => void> = []
    let sessionSequence = 0
    const createClient = jest.fn(async (): Promise<CogniaClient> => {
      sessionSequence += 1
      const sessionId = `session-${sessionSequence}`
      const session = {
        id: sessionId,
        events: async function* () {},
        run: jest.fn(
          () =>
            new Promise((resolve) => {
              releases.push(() => resolve({ status: "completed", result: {} }))
            })
        ),
        steer: jest.fn(),
        abort: jest.fn(),
        state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
        waitForIdle: jest.fn(),
        snapshot: jest.fn(),
        close: jest.fn(),
      }
      return {
        sessions: {
          create: jest.fn(async () => session),
          open: jest.fn(async () => session),
        },
        close: jest.fn(),
      } as unknown as CogniaClient
    })
    const dispatchManifest: AgentWorkerManifestV1 = {
      ...manifest,
      hardCapabilities: ["tools"],
      credentialProfileRefs: ["credential:test"],
      workspaceBindingRefs: ["repository:project:repo"],
      sandbox: { capabilities: ["filesystem"] },
      executionProfile: { ...manifest.executionProfile!, capabilities: ["streaming"] },
    }
    const onWorkersChanged = jest.fn()
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient,
      onWorkersChanged,
    })
    pool.attach({ connectionId: "connection-b", hostRef: "device:b", manifest: dispatchManifest })
    pool.attach({ connectionId: "connection-a", hostRef: "device:a", manifest: dispatchManifest })
    const requirements = {
      spec: executionSpec,
      workspaceBindingRef: "repository:project:repo",
      requiredSandboxCapabilities: ["filesystem"],
    }
    const run = (hostRef: string, commandId: string) =>
      pool.run({
        hostRef,
        commandId,
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: commandId,
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: commandId },
          execution: { mode: "orchestrated" },
          resources: [{ kind: "repository", ref: "repository:project:repo" }],
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: commandId,
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: jest.fn(),
      })

    const first = selectRemoteWorker(pool.listWorkers(), { mode: "auto" }, requirements)
    const firstRun = run(first.hostRef, "lease-1")
    await new Promise((resolve) => setImmediate(resolve))
    await expect(run(first.hostRef, "lease-over-capacity")).rejects.toThrow("capacity is exhausted")
    const second = selectRemoteWorker(pool.listWorkers(), { mode: "auto" }, requirements)
    const secondRun = run(second.hostRef, "lease-2")
    await new Promise((resolve) => setImmediate(resolve))

    expect([first.hostRef, second.hostRef]).toEqual(["device:a", "device:b"])
    expect(pool.listWorkers().map((worker) => worker.activeTurns)).toEqual([1, 1])
    expect(onWorkersChanged).toHaveBeenCalledWith([
      expect.objectContaining({ activeTurns: 1 }),
      expect.objectContaining({ activeTurns: 1 }),
    ])
    releases.splice(0).forEach((release) => release())
    await Promise.all([firstRun, secondRun])
    expect(pool.listWorkers().map((worker) => worker.activeTurns)).toEqual([0, 0])
  })

  it("routes recovery, replay, steering, and termination through CogniaSession methods", async () => {
    const steer = jest.fn(async () => undefined)
    const abort = jest.fn(async () => undefined)
    const waitForIdle = jest.fn(async () => undefined)
    const close = jest.fn(async () => undefined)
    const event = {
      schemaVersion: 1 as const,
      eventId: "event-replayed",
      sequence: 2,
      sessionId: "session-recovery",
      runId: "run-recovery",
      attemptId: "attempt-2",
      turnId: "turn-recovery",
      timestamp: "2026-08-12T00:00:00.000Z",
      hostRef: "device:recovery",
      runtime: "builtin",
      event: { kind: "lifecycle" as const, phase: "started" as const },
    }
    const events = jest.fn(async function* () {
      yield event
    })
    const run = jest.fn(async () => ({ status: "completed", result: {} }))
    const session = {
      id: "session-recovery",
      events,
      run,
      steer,
      abort,
      state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
      waitForIdle,
      snapshot: jest.fn(),
      close,
    }
    const create = jest.fn()
    const open = jest.fn(async () => session)
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({ sessions: { create, open }, close: jest.fn() })) as never,
    })
    pool.attach({ connectionId: "connection-recovery", hostRef: "device:recovery", manifest })
    const controller = new AbortController()
    const onEvent = jest.fn()

    await expect(
      pool.run({
        hostRef: "device:recovery",
        recoverySessionId: "session-recovery",
        lastRemoteEventId: "event-before",
        commandId: "lease-recovery",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-recovery",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "safe prompt" },
          execution: { mode: "orchestrated" },
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        maxSteps: 2,
        signal: controller.signal,
        onSession: jest.fn(),
        onEvent,
        onControl: async (control) => {
          await control.steer("safe steering", "steer-1")
          await control.pause("pause-1")
          await control.terminate("terminate-1")
        },
      })
    ).resolves.toEqual({ status: "completed", result: {} })

    expect(create).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith("session-recovery")
    expect(steer).toHaveBeenCalledWith("safe steering", { commandId: "steer-1" })
    expect(abort).toHaveBeenCalledWith({ commandId: "terminate-1" })
    expect(waitForIdle).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalled()
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({ afterEventId: "event-before", signal: expect.any(AbortSignal) })
    )
    expect(onEvent).toHaveBeenCalledWith(event)
    expect(run).toHaveBeenCalledWith(
      "safe prompt",
      expect.objectContaining({
        commandId: "lease-recovery",
        maxSteps: 2,
        signal: controller.signal,
      })
    )
  })

  it("rejects dispatch to an unavailable host", async () => {
    const pool = new WorkerRpcPool({ sendFrame: jest.fn() })
    await expect(
      pool.run({
        hostRef: "device:missing",
        commandId: "lease-missing",
        handoff: {
          envelopeVersion: 1,
          identity: {
            parentRunId: "team-run",
            childRunId: "child-run",
            depth: 1,
            parentChain: ["team-run"],
          },
          task: { prompt: "safe prompt" },
          execution: { mode: "orchestrated" },
          createdAt: "2026-08-12T00:00:00.000Z",
        },
        prompt: "safe prompt",
        onSession: jest.fn(),
        onEvent: jest.fn(),
        onControl: jest.fn(),
      })
    ).rejects.toThrow("Worker is offline")
  })

  it("pauses cooperatively without aborting, snapshotting, or reopening the session", async () => {
    const abort = jest.fn()
    const waitForIdle = jest.fn(async () => undefined)
    const snapshot = jest.fn()
    const open = jest.fn()
    const session = {
      id: "session-pause",
      events: async function* () {},
      run: jest.fn(async () => ({ status: "completed", result: {} })),
      steer: jest.fn(),
      abort,
      state: jest.fn(async () => ({ sessionId: "session-1", status: "idle" })),
      waitForIdle,
      snapshot,
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: { create: jest.fn(async () => session), open },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-pause", hostRef: "device:pause", manifest })

    await pool.run({
      hostRef: "device:pause",
      commandId: "lease-pause",
      handoff: {
        envelopeVersion: 1,
        identity: {
          parentRunId: "team-run",
          childRunId: "child-run",
          depth: 1,
          parentChain: ["team-run"],
        },
        task: { prompt: "safe prompt" },
        execution: { mode: "orchestrated" },
        createdAt: "2026-08-12T00:00:00.000Z",
      },
      prompt: "safe prompt",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: (control) => control.pause("pause-1"),
    })

    expect(waitForIdle).toHaveBeenCalledWith({ timeoutMs: 30_000 })
    expect(abort).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
  it("reports a worker still holding an unresolved request as recovery-required", async () => {
    const session = {
      id: "session-recovery",
      events: async function* () {},
      run: jest.fn(async () => ({ status: "completed", result: { status: "completed" } })),
      steer: jest.fn(),
      state: jest.fn(async () => ({
        sessionId: "session-recovery",
        status: "recovery_required" as const,
      })),
      abort: jest.fn(),
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: {
          create: jest.fn(async () => session),
          open: jest.fn(async () => session),
        },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-recovery-2", hostRef: "device:recovery", manifest })

    const outcome = await pool.run({
      hostRef: "device:recovery",
      commandId: "lease-recovery",
      prompt: "do the thing",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: jest.fn(),
    })

    // The turn itself completed; the worker is still waiting on an operator.
    expect(outcome.status).toBe("completed")
    expect(outcome.recoveryRequired).toBe(true)
  })

  it("leaves the recovery flag off an ordinary completed turn", async () => {
    const session = {
      id: "session-clean",
      events: async function* () {},
      run: jest.fn(async () => ({ status: "completed", result: { status: "completed" } })),
      steer: jest.fn(),
      state: jest.fn(async () => ({ sessionId: "session-clean", status: "idle" as const })),
      abort: jest.fn(),
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new WorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (async () => ({
        sessions: {
          create: jest.fn(async () => session),
          open: jest.fn(async () => session),
        },
        close: jest.fn(),
      })) as never,
    })
    pool.attach({ connectionId: "connection-clean", hostRef: "device:clean", manifest })

    const outcome = await pool.run({
      hostRef: "device:clean",
      commandId: "lease-clean",
      prompt: "do the thing",
      onSession: jest.fn(),
      onEvent: jest.fn(),
      onControl: jest.fn(),
    })
    expect(outcome.recoveryRequired).toBeUndefined()
  })
})
