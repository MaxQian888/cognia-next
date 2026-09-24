"use client"

import { Channel, invoke } from "@tauri-apps/api/core"

import type { AgentWorkerManifestV1 } from "@cognia/agent"

import { installRemoteWorkerRuntime, type RemoteWorkerDescriptor } from "./remote-worker-runtime"
import { WorkerRpcPool } from "./worker-rpc-pool"

/**
 * Desktop worker dispatch.
 *
 * ADR-0113 shipped cross-host dispatch complete except for one link: the only
 * caller of {@link installRemoteWorkerRuntime} lived in the headless `cognia
 * serve` process. A desktop host therefore accepted worker enrollments,
 * authenticated them, listed them online in Fleet — and could not send a single
 * Agent RPC frame, because the ingress only knew how to reach a brain sitting on
 * the other end of a bridge socket. This module is the missing half: it makes
 * the WebView itself the brain, over a Tauri IPC channel instead of a socket.
 */

/** Mirrors `WorkerBrainEnvelope` in `src-tauri/src/companion_api/ws_worker.rs`. */
export type WorkerBrainEnvelope = { seq: number } & (
  | { type: "worker_attach"; connectionId: string; hostRef: string; manifest: unknown }
  | { type: "worker_frame"; connectionId: string; frame: string }
  | { type: "worker_detach"; connectionId: string; hostRef: string; reason: string }
)

export interface TauriWorkerRuntimeOptions {
  /** The active account. Workers are scoped to it on the host side. */
  tenantId: string
  onWorkersChanged?(workers: readonly RemoteWorkerDescriptor[]): void
  /** Seams for tests; production uses the real Tauri IPC surface. */
  invoke?: typeof invoke
  createChannel?: () => Channel<WorkerBrainEnvelope>
}

/**
 * How many envelopes may go unacked before the renderer flushes an ack.
 *
 * Acks are cumulative, so coalescing them is free — and necessary: one invoke
 * per inbound frame would double IPC traffic on the hot path for no benefit.
 * The window is small enough that the host's byte budget never idles waiting.
 */
const ACK_BATCH = 32
const ACK_INTERVAL_MS = 50

export interface TauriWorkerRuntimeHandle {
  pool: WorkerRpcPool
  dispose(): Promise<void>
}

export async function attachTauriWorkerRuntime(
  options: TauriWorkerRuntimeOptions
): Promise<TauriWorkerRuntimeHandle> {
  const call = options.invoke ?? invoke
  const tenantId = options.tenantId

  // Outbound frames must reach the worker in the order the RPC peer wrote
  // them. Separate `invoke` calls carry no ordering guarantee, so they are
  // serialized through one promise chain rather than fired concurrently.
  let outbound: Promise<unknown> = Promise.resolve()

  const pool = new WorkerRpcPool({
    sendFrame(connectionId, frame) {
      outbound = outbound
        .then(() => call("companion_worker_send_frame", { tenantId, connectionId, frame }))
        .catch(() => {
          // A frame that never reached the worker has broken request/response
          // correlation for that connection, and no later frame can repair it.
          // Detaching surfaces the break as a closed connection — which the
          // dispatcher already recovers from — instead of leaving every
          // in-flight call to hang until its own timeout.
          pool.detach(connectionId, "send_failed")
        })
    },
    ...(options.onWorkersChanged ? { onWorkersChanged: options.onWorkersChanged } : {}),
  })

  let pendingAck = 0
  let highestSeq = 0
  let ackTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const flushAck = () => {
    if (ackTimer) {
      clearTimeout(ackTimer)
      ackTimer = undefined
    }
    if (pendingAck === 0 || disposed) return
    const inFlight = pendingAck
    pendingAck = 0
    void call("companion_worker_ack_events", { throughSeq: highestSeq }).catch(() => {
      // The ack never reached the host, so those bytes are still charged
      // against its 32 MiB inbound budget. Dropping the window here would only
      // be repaired by the NEXT envelope — and between turns none arrives, so
      // the budget would stay held. Acks are cumulative, so restoring the
      // window and re-arming simply retries at whatever `highestSeq` is then.
      if (disposed) return
      pendingAck += inFlight
      ackTimer ??= setTimeout(flushAck, ACK_INTERVAL_MS)
    })
  }

  const noteConsumed = (seq: number) => {
    highestSeq = Math.max(highestSeq, seq)
    pendingAck += 1
    if (pendingAck >= ACK_BATCH) {
      flushAck()
      return
    }
    ackTimer ??= setTimeout(flushAck, ACK_INTERVAL_MS)
  }

  const channel = options.createChannel?.() ?? new Channel<WorkerBrainEnvelope>()
  channel.onmessage = (envelope) => {
    switch (envelope.type) {
      case "worker_attach":
        pool.attach({
          connectionId: envelope.connectionId,
          hostRef: envelope.hostRef,
          manifest: envelope.manifest as AgentWorkerManifestV1,
        })
        break
      case "worker_frame":
        pool.receive(envelope.connectionId, envelope.frame)
        break
      case "worker_detach":
        pool.detach(envelope.connectionId, envelope.reason)
        break
    }
    noteConsumed(envelope.seq)
  }

  await call("companion_worker_attach_channel", { tenantId, onEvent: channel })
  const uninstall = installRemoteWorkerRuntime(pool)

  return {
    pool,
    async dispose() {
      uninstall()
      // Set before the timer is cleared: a failed ack's retry lands as a
      // microtask and would otherwise re-arm the timer we just cancelled.
      disposed = true
      if (ackTimer) clearTimeout(ackTimer)
      pool.close()
      await call("companion_worker_detach_channel", {}).catch(() => undefined)
    },
  }
}
