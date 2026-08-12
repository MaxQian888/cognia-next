import type { AgentWorkerManifestV1, CogniaClient, CogniaClientOptions } from "@cognia/agent"
import { selectRemoteWorker } from "@/lib/ai/agent/team/remote-worker-runtime"
import { BridgeWorkerRpcPool } from "./worker-rpc-pool"

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
}

describe("BridgeWorkerRpcPool", () => {
  it("uses authenticated attach identity and transports RPC frames opaquely", async () => {
    const sent: string[] = []
    let now = 10
    const createClient = jest.fn(
      (_options: CogniaClientOptions) => new Promise<CogniaClient>(() => undefined)
    )
    const pool = new BridgeWorkerRpcPool({
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
    expect(pool.listWorkers()[0]?.lastSeenAt).toBe(20)
    pool.detach("connection-1", "offline")
    expect(pool.listWorkers()).toEqual([])
  })

  it("replaces an older connection for the same authenticated host", () => {
    const pool = new BridgeWorkerRpcPool({
      sendFrame: jest.fn(),
      createClient: (() => new Promise<CogniaClient>(() => undefined)) as never,
    })
    pool.attach({ connectionId: "old", hostRef: "device:a", manifest })
    pool.attach({ connectionId: "new", hostRef: "device:a", manifest })
    expect(pool.listWorkers()).toEqual([expect.objectContaining({ connectionId: "new" })])
  })

  it("rejects malformed worker manifests before placement", () => {
    const pool = new BridgeWorkerRpcPool({ sendFrame: jest.fn() })
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
    const pool = new BridgeWorkerRpcPool({
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
      waitForIdle: jest.fn(),
      snapshot: jest.fn(),
      close: jest.fn(),
    }
    const pool = new BridgeWorkerRpcPool({
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
    }
    const onWorkersChanged = jest.fn()
    const pool = new BridgeWorkerRpcPool({
      sendFrame: jest.fn(),
      createClient,
      onWorkersChanged,
    })
    pool.attach({ connectionId: "connection-b", hostRef: "device:b", manifest: dispatchManifest })
    pool.attach({ connectionId: "connection-a", hostRef: "device:a", manifest: dispatchManifest })
    const requirements = {
      requiredCapabilities: ["tools"],
      credentialProfileRef: "credential:test",
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
})
