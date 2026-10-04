/**
 * Host-run Cognia gateway tasks on the headless brain (ADR-0090, 2026-10-02).
 *
 * A desktop Host prepares a gateway task from its renderer: it reads provider
 * settings and the vault, publishes a snapshot and mints a ticket carrying a
 * private provider override (`prepareExternalAgentGatewayRoute`'s local
 * branch). The headless brain has neither — its providers live in the Rust
 * Provider Profile Store, whose credential references resolve only inside
 * `cognia-server` — so it asks the server for the same lease instead:
 * `agent_gateway_host_task_prepare` copies one provider out of the snapshot the
 * server's gateway already serves into a ticket-private deployment, with the
 * same ticket shape the device lease uses (one model, `gateway-required`,
 * inference/models/count-tokens only, two-minute TTL). No key crosses the RPC
 * in either direction: the brain receives the task's bearer secret and the
 * loopback endpoint, nothing more.
 *
 * The lease is renewed while the task runs and revoked when it ends; a missed
 * renewal aborts the task through `signal`, and the server expires an
 * unrenewed lease on its own.
 */

import { transport } from "@/lib/tauri"
import type { GatewayModelMetadata } from "@/types/gateway"

/** Renewal cadence; the server-side TTL is four of these. */
export const HOST_TASK_LEASE_RENEW_MS = 30_000

export interface HostTaskLeaseInput {
  taskId: string
  /** The Host snapshot provider id (a profile deployment id on `cognia-server`). */
  providerId: string
  modelId: string
  ingressProtocol: "openai-chat" | "openai-responses" | "anthropic"
  /** The paired device the turn runs for; part of the lease scope. */
  originDeviceId?: string | null
  signal?: AbortSignal
}

export interface HostTaskLease {
  ticketId: string
  secret: string
  endpoint: string
  accountGeneration: number
  ownerAccountId: string | null
  expiresAtMs: number
  modelMetadata: GatewayModelMetadata
  revoke: () => Promise<void>
  /** Aborts when the lease can no longer be renewed. */
  signal: AbortSignal
  assertCurrent: () => void
}

interface PreparedHostTaskLease {
  ticketId: string
  secret: string
  endpoint: string
  accountGeneration: number
  ownerAccountId: string | null
  expiresAtMs: number
  modelMetadata?: { id: string } & Record<string, unknown>
}

const METADATA_NUMBERS = ["contextLength", "maxInputTokens", "maxOutputTokens"] as const
const METADATA_FLAGS = [
  "supportsTools",
  "supportsReasoning",
  "supportsVision",
  "supportsAudio",
  "supportsVideo",
  "supportsStreaming",
  "supportsStructuredOutput",
] as const

/**
 * The model facts the server's snapshot carries, copied by name. Unknown stays
 * absent, which the launch adapters already read as "not known to lack it".
 */
export function hostTaskModelMetadata(
  modelId: string,
  raw: PreparedHostTaskLease["modelMetadata"]
): GatewayModelMetadata {
  const metadata: GatewayModelMetadata = { id: modelId }
  if (!raw || raw.id !== modelId) return metadata
  if (typeof raw.name === "string" && raw.name) metadata.name = raw.name
  for (const key of METADATA_NUMBERS) {
    const value = raw[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) metadata[key] = value
  }
  for (const key of METADATA_FLAGS) {
    const value = raw[key]
    if (typeof value === "boolean") metadata[key] = value
  }
  return metadata
}

function assertLeaseShape(lease: PreparedHostTaskLease): void {
  let endpoint: URL
  try {
    endpoint = new URL(lease.endpoint)
  } catch {
    throw new Error("Host returned an invalid task gateway lease")
  }
  const now = Date.now()
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.port ||
    typeof lease.secret !== "string" ||
    !lease.secret ||
    typeof lease.ticketId !== "string" ||
    !lease.ticketId ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.expiresAtMs <= now ||
    lease.expiresAtMs > now + 180_000 ||
    !(lease.ownerAccountId === null || typeof lease.ownerAccountId === "string") ||
    !Number.isSafeInteger(lease.accountGeneration) ||
    lease.accountGeneration < 0
  )
    throw new Error("Host returned an invalid task gateway lease")
}

/**
 * Lease one Host provider/model for one task. Throws — never degrades to an
 * ungated route — when the Host cannot serve the selection; the server's
 * refusal names what the operator can fix and never carries a secret.
 */
export async function acquireHostTaskLease(input: HostTaskLeaseInput): Promise<HostTaskLease> {
  input.signal?.throwIfAborted()
  const lease = await transport.call<PreparedHostTaskLease>("agent_gateway_host_task_prepare", {
    request: {
      taskId: input.taskId,
      providerId: input.providerId,
      model: input.modelId,
      ingressProtocol: input.ingressProtocol,
      originDeviceId: input.originDeviceId ?? null,
    },
  })
  const control = {
    taskId: input.taskId,
    ticketId: lease.ticketId,
    accountGeneration: lease.accountGeneration,
    originDeviceId: input.originDeviceId ?? null,
  }
  const controller = new AbortController()
  let disposed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const revoke = async () => {
    if (disposed) return
    disposed = true
    if (heartbeat) clearInterval(heartbeat)
    input.signal?.removeEventListener("abort", invalidate)
    await transport.call<boolean>("agent_gateway_host_task_revoke", control)
  }
  function invalidate() {
    controller.abort(new Error("Task gateway lease ended"))
    // The server also expires an unrenewed lease after two minutes.
    void revoke().catch(() => undefined)
  }
  const assertCurrent = () => {
    input.signal?.throwIfAborted()
    if (controller.signal.aborted) throw new Error("Task gateway lease ended")
  }
  try {
    assertLeaseShape(lease)
    assertCurrent()
    let renewing = false
    heartbeat = setInterval(() => {
      if (renewing || disposed) return
      renewing = true
      void transport
        .call<boolean>("agent_gateway_host_task_renew", control)
        .then((renewed) => {
          if (!renewed) throw new Error("Task gateway lease expired")
        })
        .catch(invalidate)
        .finally(() => {
          renewing = false
        })
    }, HOST_TASK_LEASE_RENEW_MS)
    input.signal?.addEventListener("abort", invalidate, { once: true })
    return {
      ticketId: lease.ticketId,
      secret: lease.secret,
      endpoint: lease.endpoint,
      accountGeneration: lease.accountGeneration,
      ownerAccountId: lease.ownerAccountId,
      expiresAtMs: lease.expiresAtMs,
      modelMetadata: hostTaskModelMetadata(input.modelId, lease.modelMetadata),
      revoke,
      signal: controller.signal,
      assertCurrent,
    }
  } catch (error) {
    await revoke().catch(() => undefined)
    throw error
  }
}
