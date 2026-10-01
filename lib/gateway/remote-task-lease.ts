import {
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import { activeHostFeatureManifest } from "@/stores/remote-host/remote-host-store"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import { isLoopbackHostname } from "@/lib/connectivity/loopback-hostname"
import { isPrivateIpv4 } from "@/lib/connectivity/local-ip"
import type { GatewayRoutingSnapshot } from "@/types/gateway"

type Provider = GatewayRoutingSnapshot["providers"][number]
const preparing = new Set<string>()
const leases = new Map<string, { target: Transport; secret: string; assertCurrent: () => void }>()

export function captureRemoteGatewayTarget() {
  const target = getActiveRemoteTransport()
  const endpoint = getActiveRemoteEndpoint()
  if (!target || !endpoint?.deviceId)
    throw new Error("A paired Host is required for the task gateway")
  if (
    !supportsHostFeatureOperation(
      activeHostFeatureManifest(),
      "external-agent.process-plane",
      "agent_gateway_lease_prepare"
    )
  )
    throw new Error("This Host does not support task gateway leases; update the Host")
  const identity = JSON.stringify([
    endpoint.deviceId,
    endpoint.deviceKeyThumbprint,
    endpoint.serverFingerprint,
    endpoint.baseUrl,
  ])
  return {
    target,
    assertCurrent() {
      const current = getActiveRemoteEndpoint()
      if (
        getActiveRemoteTransport() !== target ||
        JSON.stringify([
          current?.deviceId,
          current?.deviceKeyThumbprint,
          current?.serverFingerprint,
          current?.baseUrl,
        ]) !== identity
      )
        throw new Error("Task gateway Host changed")
    },
  }
}

export function assertRemoteGatewayTask(env: Record<string, string>, target: Transport): void {
  let task: { taskId?: string }
  try {
    task = JSON.parse(env.COGNIA_GATEWAY_TASK_CONFIG)
  } catch {
    throw new Error("Remote gateway task lease is missing")
  }
  const lease = task.taskId ? leases.get(task.taskId) : undefined
  if (!lease || lease.target !== target || lease.secret !== env.COGNIA_GATEWAY_TOKEN)
    throw new Error("Remote gateway task lease is missing or belongs to another Host")
  lease.assertCurrent()
}

export async function acquireRemoteTaskLease(input: {
  scope: ReturnType<typeof captureRemoteGatewayTarget>
  taskId: string
  provider: Provider
  model: string
  ingressProtocol: string
  assertCurrent: () => void
  signal?: AbortSignal
  subscribeAuthority?: (listener: () => void) => () => void
  onDisposed?: () => void
}) {
  const url = new URL(input.provider.baseUrl)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    isLoopbackHostname(url.hostname) ||
    isPrivateIpv4(url.hostname) ||
    url.hostname.includes(":") ||
    !url.hostname.includes(".") ||
    /\.(local|internal|localhost)\.?$/i.test(url.hostname)
  )
    throw new Error(
      "Remote task gateways require a public HTTPS provider; local providers need a service bridge"
    )
  let hostChanged = false
  const assertCurrent = () => {
    if (hostChanged) throw new Error("Task gateway Host changed")
    input.signal?.throwIfAborted()
    input.scope.assertCurrent()
    input.assertCurrent()
  }
  assertCurrent()
  if (preparing.has(input.taskId) || leases.has(input.taskId))
    throw new Error("This task already owns an active gateway lease")
  preparing.add(input.taskId)
  const stopPreparingWatch = subscribeActiveRemoteTransport((next) => {
    if (next !== input.scope.target) hostChanged = true
  })
  try {
    const lease = await input.scope.target.call<{
      ticketId: string
      secret: string
      endpoint: string
      accountGeneration: number
      ownerAccountId: string | null
      expiresAtMs: number
    }>("agent_gateway_lease_prepare", {
      request: {
        taskId: input.taskId,
        provider: input.provider,
        model: input.model,
        ingressProtocol: input.ingressProtocol,
      },
    })
    const control = {
      taskId: input.taskId,
      ticketId: lease.ticketId,
      accountGeneration: lease.accountGeneration,
    }
    let disposed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let stopWatching: (() => void) | undefined
    let stopAuthority: (() => void) | undefined
    const registration = { target: input.scope.target, secret: lease.secret, assertCurrent }
    const controller = new AbortController()
    const revoke = async () => {
      if (disposed) return
      disposed = true
      if (heartbeat) clearInterval(heartbeat)
      stopWatching?.()
      stopAuthority?.()
      input.onDisposed?.()
      input.signal?.removeEventListener("abort", invalidate)
      if (leases.get(input.taskId) === registration) leases.delete(input.taskId)
      // The captured connection is intentional: never revoke against the new Host.
      await input.scope.target.call("agent_gateway_lease_revoke", control)
    }
    function invalidate() {
      controller.abort(new Error("Task gateway authority changed"))
      void revoke().catch(() => undefined) // The server also expires unrenewed leases after two minutes.
    }
    try {
      assertCurrent()
      const endpoint = new URL(lease.endpoint)
      if (
        endpoint.protocol !== "http:" ||
        endpoint.hostname !== "127.0.0.1" ||
        endpoint.pathname !== "/v1" ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        !endpoint.port ||
        Number(endpoint.port) < 1 ||
        typeof lease.secret !== "string" ||
        !lease.secret ||
        typeof lease.ticketId !== "string" ||
        !Number.isSafeInteger(lease.expiresAtMs) ||
        lease.expiresAtMs <= Date.now() ||
        lease.expiresAtMs > Date.now() + 180_000 ||
        !(lease.ownerAccountId === null || typeof lease.ownerAccountId === "string") ||
        !lease.ticketId ||
        !Number.isSafeInteger(lease.accountGeneration) ||
        lease.accountGeneration < 0
      )
        throw new Error("Host returned an invalid task gateway lease")
      leases.set(input.taskId, registration)
      let renewing = false
      heartbeat = setInterval(() => {
        if (renewing || disposed) return
        renewing = true
        void (async () => {
          assertCurrent()
          if (!(await input.scope.target.call<boolean>("agent_gateway_lease_renew", control)))
            throw new Error("Task gateway lease expired")
          assertCurrent()
        })()
          .catch(invalidate)
          .finally(() => {
            renewing = false
          })
      }, 30_000)
      stopWatching = subscribeActiveRemoteTransport((next) => {
        if (next !== input.scope.target) invalidate()
      })
      stopAuthority = input.subscribeAuthority?.(invalidate)
      input.signal?.addEventListener("abort", invalidate, { once: true })
      assertCurrent()
      return { ...lease, revoke, signal: controller.signal, assertCurrent }
    } catch (error) {
      await revoke().catch(() => undefined)
      throw error
    }
  } finally {
    preparing.delete(input.taskId)
    stopPreparingWatch()
  }
}
