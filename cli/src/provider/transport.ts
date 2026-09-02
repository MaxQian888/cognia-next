/**
 * Where `cognia-agent provider …` gets its answers from (ADR-0163 Phase 6).
 *
 * Three legs, one result shape:
 *   - bridge: the running desktop's loopback CLI bridge (`X-Cognia-Dev-Token`).
 *     Its `/api/dev/provider-operations/manifest` says which admin commands
 *     that desktop exposes, so an older desktop degrades PER VERB instead of
 *     failing the whole command.
 *   - rpc:    a running `cognia-server` (`/internal/_rpc/{name}`, service
 *     token). No manifest route: a command is known to exist only once it has
 *     been tried, and `unknown_command` reports as `unavailable`.
 *   - local:  this process. Every verb has a local path through the operation
 *     executor, so the CLI never needs a desktop to answer.
 *
 * Management credentials never leave this process: the dev token and the
 * service token are only ever sent to the plane that issued them, and no verb
 * forwards them to an agent subprocess.
 */

import type { ProviderOperationDescriptor } from "@cognia/provider-types"

import { DEV_TOKEN_HEADER, detectDesktop } from "../handoff/client"
import { SERVER_URL_ENV, SERVICE_TOKEN_ENV } from "../x/mint-ticket"

export const BRIDGE_MANIFEST_PATH = "/api/dev/provider-operations/manifest"
export const BRIDGE_EXECUTE_PATH = "/api/dev/provider-operations/execute"
export const RPC_PATH_PREFIX = "/internal/_rpc"

export type ProviderTransportKind = "bridge" | "rpc" | "local"
export type ProviderTransportPreference = "auto" | ProviderTransportKind

export const PROVIDER_TRANSPORT_PREFERENCES: readonly ProviderTransportPreference[] = [
  "auto",
  "bridge",
  "rpc",
  "local",
]

/** What `GET /api/dev/provider-operations/manifest` answers. */
export interface ProviderOperationsManifestProjection {
  schemaVersion: number
  operations: ProviderOperationDescriptor[]
  /** Companion command names the desktop's bridge will dispatch. */
  adminCommands: string[]
}

export type ProviderCommandFailureReason =
  /** The plane exists but does not carry this command (older host). */
  | "unavailable"
  /** The host refused or errored. */
  | "rejected"
  /** Transport failure. */
  | "network"
  /** The local leg cannot dispatch companion commands at all. */
  | "no-transport"

export type ProviderCommandOutcome =
  | { ok: true; result: unknown; accepted?: boolean }
  | { ok: false; reason: ProviderCommandFailureReason; message: string }

export interface ProviderTransport {
  kind: ProviderTransportKind
  /** One human line naming the plane, for the report header. */
  label: string
  /** Present on the bridge leg when the desktop serves the manifest route. */
  manifest: ProviderOperationsManifestProjection | null
  /**
   * `true`/`false` when the plane declares its commands (bridge manifest),
   * `null` when it can only be learned by trying (rpc). Local answers `false`.
   */
  supportsCommand(name: string): boolean | null
  /** Dispatch one companion command through the plane. */
  execute(name: string, args?: Record<string, unknown>): Promise<ProviderCommandOutcome>
}

export interface ProviderTransportDeps {
  fetch?: typeof fetch
  detect?: typeof detectDesktop
  env?: Record<string, string | undefined>
  /** `auto` tries bridge, then rpc, then local. A named leg is taken as is. */
  prefer?: ProviderTransportPreference
}

export interface ProviderTransportResolution {
  transport: ProviderTransport
  /** Legs that were tried and passed over, for the human hint. */
  skipped: Array<{ kind: ProviderTransportKind; message: string }>
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await res.json()) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Accept only a well-formed projection. Anything else is "no manifest". */
export function parseManifestProjection(
  body: Record<string, unknown>
): ProviderOperationsManifestProjection | null {
  const operations = body.operations
  const adminCommands = body.adminCommands
  if (!Array.isArray(operations) || !Array.isArray(adminCommands)) return null
  if (typeof body.schemaVersion !== "number") return null
  return {
    schemaVersion: body.schemaVersion,
    operations: operations.filter(
      (op): op is ProviderOperationDescriptor =>
        !!op && typeof op === "object" && typeof (op as { id?: unknown }).id === "string"
    ),
    adminCommands: adminCommands.filter((name): name is string => typeof name === "string"),
  }
}

export function localProviderTransport(): ProviderTransport {
  return {
    kind: "local",
    label: "this process (local operation executor)",
    manifest: null,
    supportsCommand: () => false,
    execute: async (name) => ({
      ok: false,
      reason: "no-transport",
      message: `${name} needs a running Cognia desktop or cognia-server`,
    }),
  }
}

/** Desktop leg. `null` when no live bridge endpoint answers the health check. */
export async function bridgeProviderTransport(
  deps: ProviderTransportDeps = {}
): Promise<ProviderTransport | null> {
  const detect = deps.detect ?? detectDesktop
  const endpoint = await detect(deps.fetch ? { fetch: deps.fetch } : {})
  if (!endpoint) return null
  const doFetch = deps.fetch ?? fetch
  const headers = { [DEV_TOKEN_HEADER]: endpoint.devToken }

  let manifest: ProviderOperationsManifestProjection | null = null
  try {
    const res = await doFetch(`${endpoint.baseUrl}${BRIDGE_MANIFEST_PATH}`, { headers })
    if (res.ok) manifest = parseManifestProjection(await readBody(res))
  } catch {
    // An older desktop without the provider plane: every verb degrades to local.
    manifest = null
  }
  const admin = new Set(manifest?.adminCommands ?? [])

  return {
    kind: "bridge",
    label: `Cognia desktop bridge (${endpoint.baseUrl})`,
    manifest,
    supportsCommand: (name) => admin.has(name),
    async execute(name, args = {}) {
      if (!admin.has(name)) {
        return {
          ok: false,
          reason: "unavailable",
          message: manifest
            ? `this desktop does not expose ${name} on its CLI bridge`
            : `this desktop predates the provider operation plane (no manifest route)`,
        }
      }
      let res: Response
      try {
        res = await doFetch(`${endpoint.baseUrl}${BRIDGE_EXECUTE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ name, args }),
        })
      } catch (error) {
        return { ok: false, reason: "network", message: (error as Error).message }
      }
      const body = await readBody(res)
      if (!res.ok) {
        const code = typeof body.error === "string" ? body.error : undefined
        const reason: ProviderCommandFailureReason =
          res.status === 404 || code === "command_not_exposed" ? "unavailable" : "rejected"
        return {
          ok: false,
          reason,
          message: code ?? `bridge answered HTTP ${res.status}`,
        }
      }
      if (res.status === 202) {
        return { ok: true, accepted: true, result: { operationId: body.operationId } }
      }
      return { ok: true, result: body.result }
    },
  }
}

/** Headless leg. `null` without `COGNIA_SERVER_URL` + `COGNIA_SERVICE_TOKEN`. */
export function rpcProviderTransport(deps: ProviderTransportDeps = {}): ProviderTransport | null {
  const env = deps.env ?? process.env
  const serverUrl = env[SERVER_URL_ENV]
  const serviceToken = env[SERVICE_TOKEN_ENV]
  if (!serverUrl || !serviceToken) return null
  const base = serverUrl.replace(/\/$/, "")
  const doFetch = deps.fetch ?? fetch
  return {
    kind: "rpc",
    label: `cognia-server (${base})`,
    manifest: null,
    supportsCommand: () => null,
    async execute(name, args = {}) {
      let res: Response
      try {
        res = await doFetch(`${base}${RPC_PATH_PREFIX}/${encodeURIComponent(name)}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceToken}`,
          },
          body: JSON.stringify(args),
        })
      } catch (error) {
        return { ok: false, reason: "network", message: (error as Error).message }
      }
      const body = await readBody(res)
      if (!res.ok) {
        const code = typeof body.code === "string" ? body.code : undefined
        const message =
          typeof body.message === "string" ? body.message : `server answered HTTP ${res.status}`
        const reason: ProviderCommandFailureReason =
          res.status === 404 || code === "unknown_command" ? "unavailable" : "rejected"
        return { ok: false, reason, message }
      }
      return { ok: true, result: body }
    },
  }
}

/**
 * Bridge, then rpc, then local. The first leg that answers wins. A named
 * preference short-circuits: `--transport local` never touches the network,
 * and `--transport bridge` with no desktop falls through to local with the
 * reason recorded in `skipped`.
 */
export async function resolveProviderTransport(
  deps: ProviderTransportDeps = {}
): Promise<ProviderTransportResolution> {
  const prefer = deps.prefer ?? "auto"
  const skipped: ProviderTransportResolution["skipped"] = []

  if (prefer === "local") return { transport: localProviderTransport(), skipped }

  if (prefer === "auto" || prefer === "bridge") {
    const bridge = await bridgeProviderTransport(deps)
    if (bridge) return { transport: bridge, skipped }
    skipped.push({
      kind: "bridge",
      message: "the Cognia desktop app is not running (no live CLI bridge endpoint)",
    })
  }

  if (prefer === "auto" || prefer === "rpc") {
    const rpc = rpcProviderTransport(deps)
    if (rpc) return { transport: rpc, skipped }
    skipped.push({
      kind: "rpc",
      message: `no headless server configured (${SERVER_URL_ENV} and ${SERVICE_TOKEN_ENV})`,
    })
  }

  return { transport: localProviderTransport(), skipped }
}
