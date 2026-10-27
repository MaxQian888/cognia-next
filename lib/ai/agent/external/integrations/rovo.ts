/** App-owned bearer-authenticated Rovo service; wire types remain in its package. */
import type { ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AgentFetch, AgentProcessHost } from "@cognia/agent-contracts/host"
import { RovoDevAdapter, type RovoDevServiceLauncher } from "@cognia/agent-rovo/client"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { platformStreamingFetch } from "@/lib/network/platform-streaming-fetch"
import { redactCredentialText } from "@/lib/security/redact-credentials"
import { spawnPlacementFor } from "@/lib/sandbox/spawn-placement-registry"
import { runsExternalAgentProcessesLocally } from "../agent-transport"
import { buildAgentEnv } from "../config/env-builder"
import { createAgentTransportProcessHost } from "../host/process-host"
import { configuredApprovalPolicy, isToolPreApproved } from "../policy/tool-preapproval"

function requireLocal(id: string): void {
  if (!runsExternalAgentProcessesLocally() || spawnPlacementFor(id))
    throw new Error(
      "Rovo service launch requires this local process host without a selected runtime environment"
    )
}
export class RovoOwnershipError extends Error {
  readonly code = "rovo_ownership_unproven"
}
async function proveRovoOwnership(
  fetch: AgentFetch,
  endpoint: string,
  token: string,
  signal?: AbortSignal
): Promise<void> {
  const url = endpoint + "/v3/sessions/list"
  for (const headers of [
    new Headers(),
    new Headers({ Authorization: `Bearer ${crypto.randomUUID()}` }),
  ]) {
    const denied = await fetch(url, { headers, signal, timeout: 1000, redirect: "error" })
    await denied.body?.cancel()
    if (![401, 403].includes(denied.status))
      throw new RovoOwnershipError(
        "Rovo listener did not reject a missing or incorrect bearer token"
      )
  }
  const allowed = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
    timeout: 1000,
    redirect: "error",
  })
  const result: unknown = allowed.status === 200 ? await allowed.json() : undefined
  if (
    allowed.status !== 200 ||
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as { sessions?: unknown }).sessions)
  )
    throw new RovoOwnershipError("Rovo listener did not accept its owned bearer token")
}
export function createRovoDevServiceLauncher(
  processHost: AgentProcessHost,
  fetch: AgentFetch
): RovoDevServiceLauncher {
  return async (config, cwd, signal) => {
    if (config.network?.endpoint) {
      throw new Error(
        "Rovo app integration requires its owned local service; external endpoints are not supported"
      )
    }
    requireLocal(config.id)
    const command = config.process?.command,
      args = config.process?.args ?? []
    if (
      !processHost.available ||
      !command ||
      command.split(/[\\/]/).pop() !== "acli" ||
      args.length !== 2 ||
      args[0] !== "rovodev" ||
      args[1] !== "serve"
    )
      throw new Error("Rovo native service requires the fixed acli rovodev serve command")
    const token = crypto.randomUUID(),
      random = crypto.getRandomValues(new Uint32Array(1))[0],
      port = 40000 + (random % 1001)
    const endpoint = `http://127.0.0.1:${port}`,
      headers = { Authorization: `Bearer ${token}` },
      id = `${config.id}:rovo-native:${crypto.randomUUID()}`
    const env = await buildAgentEnv(config, config.process?.env ?? {})
    let exited = false,
      failure: Error | undefined,
      closed = false,
      off: (() => void) | undefined
    const close = async () => {
      if (closed) return
      closed = true
      try {
        if (!exited) await processHost.kill(id)
      } finally {
        off?.()
      }
    }
    try {
      off = await processHost.onExit((event) => {
        if (event.processId === id) {
          exited = true
          failure = new Error(`Rovo service exited with code ${event.code}`)
        }
      })
      requireLocal(config.id)
      signal?.throwIfAborted()
      const registered = await processHost.spawn({
        id,
        command,
        args: ["rovodev", "serve", String(port), "--respect-configured-permissions"],
        cwd,
        env: { ...env, ROVODEV_SERVE_SESSION_TOKEN: token },
        sandboxPolicy: config.sandboxPolicy,
      })
      if (registered !== id) {
        await processHost.kill(registered)
        throw new Error("Rovo service process identity mismatch")
      }
      const deadline = Date.now() + (config.process?.startupTimeout ?? 15_000)
      for (;;) {
        signal?.throwIfAborted()
        if (failure) throw failure
        try {
          const response = await fetch(endpoint + "/healthcheck", {
            headers,
            signal,
            timeout: 500,
            redirect: "error",
          })
          if (
            response.ok &&
            ((await response.json()) as { status?: string }).status === "healthy"
          ) {
            await proveRovoOwnership(fetch, endpoint, token, signal)
            if (failure) throw failure
            return { endpoint, headers, close }
          }
        } catch (error) {
          if (error instanceof RovoOwnershipError) throw error
          if (failure) throw failure
        }
        if (Date.now() >= deadline)
          throw new Error(
            "Rovo service did not prove ownership with its private bearer token before startup timed out"
          )
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    } catch (error) {
      await close()
      throw error
    }
  }
}
export function createRovoDevAdapter(
  processHost = createAgentTransportProcessHost("local"),
  fetch: AgentFetch = platformStreamingFetch
): RovoDevAdapter {
  return new RovoDevAdapter({
    fetch,
    launch: createRovoDevServiceLauncher(processHost, fetch),
    outboundGate: hasNoLeakingPiiDeep,
    redactDiagnostic: redactCredentialText,
    approvalPolicy: configuredApprovalPolicy,
    isToolPreApproved,
  })
}
export function createRovoDevAdapterFactory(
  processHost = createAgentTransportProcessHost("local"),
  fetch: AgentFetch = platformStreamingFetch
): ProtocolAdapterFactory {
  return () => createRovoDevAdapter(processHost, fetch)
}
