import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"

import type { AgentWorkerManifestV1 } from "@cognia/agent"
import { WorkerRpcPool } from "@/lib/ai/agent/team/worker-rpc-pool"

import type { UnifiedTurnParams, UnifiedTurnResult } from "../agent/runtime/unified-runtime"
import { DEFAULT_RESOLVED_CONFIG } from "../config/schema"
import { createAgentRuntimeService } from "../agent/rpc/runtime-service"
import { createAgentRpcServer, type AgentRpcServer } from "../agent/rpc/server"

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

/**
 * The pool is shared by both brains, but only the headless one can be driven
 * against a real Agent RPC server in-process, so the end-to-end case lives here
 * rather than beside the pool.
 */
describe("headless worker dispatch over real Agent RPC streams", () => {
  it("runs two single-slot workers over the real Agent RPC v2 streams", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cognia-worker-pool-integration-"))
    const repository = path.join(root, "repository")
    mkdirSync(repository)
    execFileSync("git", ["init", "--quiet", repository])

    const inputs = new Map<string, PassThrough>()
    const servers: AgentRpcServer[] = []
    const services: ReturnType<typeof createAgentRuntimeService>[] = []
    const releases = new Map<string, () => void>()
    const runTurns = new Map<string, jest.Mock>()
    const pool = new WorkerRpcPool({
      sendFrame(connectionId, frame) {
        inputs.get(connectionId)?.write(`${frame}\n`)
      },
    })

    const attachRealWorker = (suffix: string) => {
      const connectionId = `connection-${suffix}`
      const hostRef = `device:${suffix}`
      const input = new PassThrough()
      inputs.set(connectionId, input)
      const runTurn = jest.fn(async (params: UnifiedTurnParams): Promise<UnifiedTurnResult> => {
        const release = new Promise<void>((resolve) => releases.set(suffix, resolve))
        params.onEnvelope?.({
          schemaVersion: 1,
          eventId: `event-${suffix}`,
          sequence: 1,
          sessionId: params.sessionId ?? `session-${suffix}`,
          runId: `run-${suffix}`,
          attemptId: "attempt-1",
          turnId: `turn-${suffix}`,
          timestamp: "2026-08-12T00:00:00.000Z",
          hostRef,
          runtime: "builtin",
          event: { kind: "lifecycle", phase: "started" },
        })
        await release
        return {
          result: {
            schemaVersion: 1,
            type: "result",
            status: "completed",
            sessionId: params.sessionId ?? `session-${suffix}`,
            runId: `run-${suffix}`,
            turnId: `turn-${suffix}`,
            attemptId: "attempt-1",
            text: `done-${suffix}`,
            backend: "builtin",
            model: "test-model",
            capabilities: ["session.resume"],
            session: { persisted: true, turnCount: 1 },
          },
          envelopes: [],
        }
      })
      runTurns.set(suffix, runTurn)
      const service = createAgentRuntimeService({
        config: { ...DEFAULT_RESOLVED_CONFIG, cwd: repository, model: "test-model" },
        home: path.join(root, `home-${suffix}`),
        sessionDirOverride: path.join(root, `sessions-${suffix}`),
        runTurn,
        mintSessionId: () => `session-${suffix}`,
        workerDispatch: {
          manifest,
          resolveHandoffWorkspace: async () => repository,
        },
      })
      services.push(service)
      const output = new Writable({
        write(chunk, _encoding, callback) {
          for (const frame of String(chunk).split("\n").filter(Boolean)) {
            pool.receive(connectionId, frame)
          }
          callback()
        },
      })
      const server = createAgentRpcServer({
        input,
        output,
        diagnostic: new PassThrough(),
        service,
        hostVersion: "test",
        runtimeVersion: "test",
        instanceId: `instance-${suffix}`,
        limits: { maxActiveTurns: 1 },
      })
      servers.push(server)
      void server.serve()
      expect(pool.attach({ connectionId, hostRef, manifest })).toBe(true)
    }

    try {
      attachRealWorker("a")
      attachRealWorker("b")
      const events: string[] = []
      const run = (suffix: string) =>
        pool.run({
          hostRef: `device:${suffix}`,
          commandId: `lease-${suffix}`,
          handoff: {
            envelopeVersion: 1,
            identity: {
              parentRunId: "team-run",
              childRunId: `child-${suffix}`,
              depth: 1,
              parentChain: ["team-run"],
            },
            task: { prompt: `task-${suffix}` },
            execution: { mode: "orchestrated" },
            resources: [{ kind: "repository", ref: "repository:project:repo" }],
            createdAt: "2026-08-12T00:00:00.000Z",
          },
          prompt: `task-${suffix}`,
          onSession: jest.fn(),
          onEvent: async (event) => {
            events.push(event.eventId)
          },
          onControl: jest.fn(),
        })

      const first = run("a")
      const second = run("b")
      await new Promise((resolve) => setImmediate(resolve))
      expect(pool.listWorkers().map((worker) => worker.activeTurns)).toEqual([1, 1])
      releases.get("a")?.()
      releases.get("b")?.()
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({ status: "completed" }),
      ])
      expect(events.sort()).toEqual(["event-a", "event-b"])
      expect(runTurns.get("a")).toHaveBeenCalledTimes(1)
      expect(runTurns.get("b")).toHaveBeenCalledTimes(1)
    } finally {
      pool.close()
      inputs.forEach((input) => input.end())
      await Promise.all(servers.map((server) => server.close()))
      await Promise.all(services.map((service) => service.close()))
      rmSync(root, { recursive: true, force: true })
    }
  })
})
