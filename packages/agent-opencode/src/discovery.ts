/**
 * Locating a local OpenCode V2 service (ADR-0217).
 *
 * Two hosts answer the question differently: the desktop renderer has no
 * process table, so it asks its sidecar (`opencode-v2-discover`), while a host
 * that owns one (the CLI) runs `Service.discover` in-process. Both results pass
 * the same validation here, so the descriptor contract lives in one place.
 */

import type { AgentFetch } from "@cognia/agent-contracts/host"

/** The service the V2 adapter connects to when no endpoint is configured. */
export interface OpenCodeV2Discovery {
  endpoint: string
  version: string
  headers: Record<string, string>
}

/** How a host locates the service; rejects when none is running. */
export type OpenCodeV2ServiceDiscovery = (signal: AbortSignal) => Promise<OpenCodeV2Discovery>

/** The stable OpenCode `/api` contract the adapter speaks. */
export const OPENCODE_V2_CURRENT_VERSION = /^2\.\d+\.\d+(?:\+[\w.-]+)?$/

export function validateOpenCodeV2Discovery(result: unknown): OpenCodeV2Discovery {
  const descriptor =
    result && typeof result === "object" ? (result as Partial<OpenCodeV2Discovery>) : {}
  const endpoint = typeof descriptor.endpoint === "string" ? descriptor.endpoint : ""
  const version = typeof descriptor.version === "string" ? descriptor.version : ""
  if (!endpoint || !version) {
    throw new Error("OpenCode V2 discovery returned an invalid service descriptor")
  }
  if (!/^2\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(version)) {
    throw new Error("OpenCode V2 discovery returned an incompatible service version")
  }
  const url = new URL(endpoint)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenCode V2 discovery returned an invalid endpoint")
  }
  const headers = Object.fromEntries(
    Object.entries(descriptor.headers ?? {}).filter(
      ([name, value]) => name.trim() && typeof value === "string"
    )
  )
  return { endpoint: url.toString().replace(/\/$/, ""), version, headers }
}

/**
 * Discover the service in this process, the way the sidecar does for the
 * desktop: `Service.discover`, then a bounded `/api/info` health probe through
 * the host's fetch.
 */
export async function discoverOpenCodeV2InProcess(
  hostFetch: AgentFetch,
  signal: AbortSignal
): Promise<OpenCodeV2Discovery> {
  const { Service } = await import("@opencode/client/service")
  signal.throwIfAborted()
  const endpoint = await Service.discover({
    version: (version) => OPENCODE_V2_CURRENT_VERSION.test(version),
  })
  signal.throwIfAborted()
  if (!endpoint)
    throw new Error(
      "No compatible OpenCode V2 service was discovered. Start one with `opencode service start`."
    )
  const url = new URL(endpoint.url)
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("OpenCode V2 discovery returned a non-HTTP endpoint")
  const headers = Object.fromEntries(
    Object.entries(Service.headers(endpoint) ?? {}).filter(
      ([name, value]) => name.trim() && typeof value === "string"
    )
  )
  const probe = await hostFetch(new URL("/api/info", url), {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  })
  const status = (await probe.json().catch(() => undefined)) as
    { version?: string; pid?: number } | undefined
  signal.throwIfAborted()
  if (!probe.ok) throw new Error("OpenCode V2 discovery health probe failed")
  if (
    !status?.version ||
    !OPENCODE_V2_CURRENT_VERSION.test(status.version) ||
    typeof status.pid !== "number" ||
    !Number.isInteger(status.pid) ||
    status.pid <= 0
  )
    throw new Error("OpenCode V2 discovery returned an incompatible health contract")
  return validateOpenCodeV2Discovery({
    endpoint: url.toString().replace(/\/$/, ""),
    version: status.version,
    headers,
  })
}
