import {
  createCogniaClient,
  isAgentWorkerManifestV1,
  RpcFrameSink,
  RpcStreamSource,
  type CogniaClient,
} from "@cognia/agent"
import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"

import type {
  RemoteWorkerDescriptor,
  RemoteWorkerOutcome,
  RemoteWorkerRunInput,
  RemoteWorkerRuntime,
} from "./remote-worker-runtime"

interface WorkerConnection {
  descriptor: RemoteWorkerDescriptor
  readable: RpcStreamSource
  writable: RpcFrameSink
  clientPromise: Promise<CogniaClient>
}

export interface WorkerRpcPoolOptions {
  sendFrame(connectionId: string, frame: string): void
  onWorkersChanged?(workers: readonly RemoteWorkerDescriptor[]): void
  now?: () => number
  createClient?: typeof createCogniaClient
}

/**
 * Agent RPC stays the runtime protocol; the host only multiplexes frames.
 *
 * One pool serves both brains. The headless brain pushes frames over the bridge
 * socket and the desktop brain pushes them over a Tauri IPC channel, but
 * everything above the wire — session lifecycle, event replay, steering,
 * capacity accounting — is identical, so it lives here exactly once. The
 * transport differences are confined to the injected `sendFrame` and to
 * whichever caller feeds {@link WorkerRpcPool.receive}.
 */
export class WorkerRpcPool implements RemoteWorkerRuntime {
  private readonly workers = new Map<string, WorkerConnection>()
  private readonly now: () => number
  private readonly createClient: typeof createCogniaClient

  constructor(private readonly options: WorkerRpcPoolOptions) {
    this.now = options.now ?? Date.now
    this.createClient = options.createClient ?? createCogniaClient
  }

  attach(input: { connectionId: string; hostRef: string; manifest: unknown }): boolean {
    if (!isAgentWorkerManifestV1(input.manifest)) return false
    this.detach(input.connectionId, "replaced")
    for (const [connectionId, worker] of this.workers) {
      if (worker.descriptor.hostRef === input.hostRef) this.detach(connectionId, "replaced")
    }
    const readable = new RpcStreamSource()
    const writable = new RpcFrameSink((frame) => this.options.sendFrame(input.connectionId, frame))
    const descriptor: RemoteWorkerDescriptor = {
      connectionId: input.connectionId,
      hostRef: input.hostRef,
      manifest: input.manifest,
      online: true,
      activeTurns: 0,
      lastSeenAt: this.now(),
    }
    const clientPromise = this.createClient({
      host: { kind: "streams", readable, writable },
      requestTimeoutMs: 30_000,
      client: { name: "cognia-worker-pool" },
    })
    clientPromise.catch(() => this.detach(input.connectionId, "rpc_initialize_failed"))
    this.workers.set(input.connectionId, { descriptor, readable, writable, clientPromise })
    this.notifyWorkersChanged()
    return true
  }

  receive(connectionId: string, frame: string): void {
    const worker = this.workers.get(connectionId)
    if (!worker || frame.includes("\n")) return
    worker.descriptor.lastSeenAt = this.now()
    worker.readable.push(`${frame}\n`)
  }

  detach(connectionId: string, _reason: string): void {
    const worker = this.workers.get(connectionId)
    if (!worker) return
    this.workers.delete(connectionId)
    worker.descriptor.online = false
    worker.readable.end()
    worker.writable.end()
    void worker.clientPromise.then((client) => client.close()).catch(() => undefined)
    this.notifyWorkersChanged()
  }

  listWorkers(): readonly RemoteWorkerDescriptor[] {
    return [...this.workers.values()].map(({ descriptor }) => ({
      ...descriptor,
      manifest: { ...descriptor.manifest },
    }))
  }

  async run(input: RemoteWorkerRunInput) {
    if (!hasNoLeakingPiiDeep({ prompt: input.prompt, handoff: input.handoff })) {
      throw new Error("Remote worker dispatch blocked by the PII redaction gate")
    }
    const worker = [...this.workers.values()].find(
      (candidate) => candidate.descriptor.hostRef === input.hostRef
    )
    if (!worker || !worker.descriptor.online) throw new Error(`Worker is offline: ${input.hostRef}`)
    if (worker.descriptor.activeTurns >= worker.descriptor.manifest.maxActiveTurns) {
      throw new Error(`Worker capacity is exhausted: ${input.hostRef}`)
    }
    worker.descriptor.activeTurns += 1
    this.notifyWorkersChanged()
    try {
      const client = await worker.clientPromise
      const session = input.recoverySessionId
        ? await client.sessions.open(input.recoverySessionId)
        : await client.sessions.create({ commandId: input.commandId, handoff: input.handoff })
      await input.onSession(session.id)
      await input.onControl({
        async steer(message, commandId) {
          if (!hasNoLeakingPii(message)) {
            throw new Error("Remote worker steering blocked by the PII redaction gate")
          }
          await session.steer(message, { commandId })
        },
        async pause(_commandId) {
          await session.waitForIdle({ timeoutMs: 30_000 })
        },
        async terminate(commandId) {
          await session.abort({ commandId })
          await session.waitForIdle({ timeoutMs: 30_000 })
          await session.close()
        },
      })
      const eventAbort = new AbortController()
      const consumeEvents = (async () => {
        for await (const event of session.events({
          ...(input.lastRemoteEventId ? { afterEventId: input.lastRemoteEventId } : {}),
          signal: eventAbort.signal,
        })) {
          await input.onEvent(event)
        }
      })()
      try {
        const outcome = await session.run(input.prompt, {
          commandId: input.commandId,
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
        // The turn is over, but the worker may still be holding an unresolved
        // permission or elicitation. That is a session property, not a turn
        // status, so it has to be read from the session.
        const recoveryRequired = await session
          .state()
          .then((state) => state.status === "recovery_required")
          .catch(() => false)
        return {
          ...outcome,
          ...(recoveryRequired ? { recoveryRequired: true } : {}),
        } satisfies RemoteWorkerOutcome
      } finally {
        eventAbort.abort()
        await consumeEvents.catch(() => undefined)
      }
    } finally {
      worker.descriptor.activeTurns = Math.max(0, worker.descriptor.activeTurns - 1)
      worker.descriptor.lastSeenAt = this.now()
      this.notifyWorkersChanged()
    }
  }

  close(): void {
    for (const connectionId of [...this.workers.keys()]) this.detach(connectionId, "shutdown")
  }

  private notifyWorkersChanged(): void {
    this.options.onWorkersChanged?.(this.listWorkers())
  }
}
