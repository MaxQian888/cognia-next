/**
 * `provider probe`: one minimal, billable request per provider (or per
 * gateway candidate for a model), reporting reachability, auth and latency.
 *
 * Attached to a desktop or server that exposes `gateway_probe_upstream`, the
 * probe runs INSIDE the gateway, walking the same pool expansion, cooldowns
 * and header rules a live chat request walks. Otherwise every configured
 * provider is probed locally through the shared `health.probe` operation.
 * Either way a probe spends tokens, so the command requires `--live --yes`.
 */

import type { ProviderOperationFailure, ProviderProbeResult } from "@cognia/provider-types"

import type { ResolvedConfig } from "../config/schema"
import { configuredProviderIds, type CliProviderExecutor } from "./local"
import type { ProviderTransport } from "./transport"

export const GATEWAY_PROBE_COMMAND = "gateway_probe_upstream"

/** One gateway candidate's answer (`cognia_gateway::server::UpstreamProbeResult`). */
export interface GatewayProbeRow {
  providerId: string
  modelId: string
  ok: boolean
  status?: number
  latencyMs: number
  error?: string
}

export interface LocalProbeRow {
  providerId: string
  model?: string
  result?: ProviderProbeResult
  failure?: ProviderOperationFailure
}

export type ProviderProbeReport =
  | { via: "gateway"; transportLabel: string; model: string; rows: GatewayProbeRow[] }
  | {
      via: "local"
      transportLabel: string
      /** Why the gateway leg was not used, when a plane was attached. */
      degraded?: string
      rows: LocalProbeRow[]
    }

export interface ProbeDeps {
  config: ResolvedConfig
  executor: CliProviderExecutor
  transport: ProviderTransport
  providerId?: string
  model?: string
  timeoutMs?: number
  signal?: AbortSignal
}

function toGatewayRow(value: unknown): GatewayProbeRow | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (typeof row.providerId !== "string" || typeof row.modelId !== "string") return null
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    ok: row.ok === true,
    ...(typeof row.status === "number" ? { status: row.status } : {}),
    latencyMs: typeof row.latencyMs === "number" ? row.latencyMs : 0,
    ...(typeof row.error === "string" ? { error: row.error } : {}),
  }
}

async function probeLocally(deps: ProbeDeps, degraded?: string): Promise<ProviderProbeReport> {
  const ids = deps.providerId ? [deps.providerId] : configuredProviderIds(deps.config)
  const rows: LocalProbeRow[] = []
  for (const providerId of ids) {
    const input = {
      ...(deps.model ? { model: deps.model } : {}),
      ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    }
    const result = await deps.executor.execute<ProviderProbeResult>(
      "health.probe",
      providerId,
      input,
      deps.signal ? { signal: deps.signal } : {}
    )
    rows.push(
      result.ok
        ? { providerId, ...(deps.model ? { model: deps.model } : {}), result: result.output }
        : { providerId, ...(deps.model ? { model: deps.model } : {}), failure: result }
    )
  }
  return {
    via: "local",
    transportLabel: deps.transport.label,
    ...(degraded ? { degraded } : {}),
    rows,
  }
}

export async function probeProviders(deps: ProbeDeps): Promise<ProviderProbeReport> {
  const supported = deps.transport.supportsCommand(GATEWAY_PROBE_COMMAND)
  // The gateway probe is keyed by model: without one there is nothing for the
  // route planner to expand, so the local per-provider probe is the answer.
  if (deps.transport.kind === "local" || supported === false || !deps.model) {
    const degraded =
      deps.transport.kind === "local"
        ? undefined
        : !deps.model
          ? "gateway probe needs --model; probing each provider directly instead"
          : `${deps.transport.label} does not expose ${GATEWAY_PROBE_COMMAND}`
    return probeLocally(deps, degraded)
  }
  const outcome = await deps.transport.execute(GATEWAY_PROBE_COMMAND, { model: deps.model })
  if (!outcome.ok) {
    if (outcome.reason === "unavailable") {
      return probeLocally(deps, `${deps.transport.label}: ${outcome.message}`)
    }
    return probeLocally(
      deps,
      `${deps.transport.label} refused the gateway probe: ${outcome.message}`
    )
  }
  const rows = (Array.isArray(outcome.result) ? outcome.result : [])
    .map(toGatewayRow)
    .filter((row): row is GatewayProbeRow => row !== null)
  return { via: "gateway", transportLabel: deps.transport.label, model: deps.model, rows }
}

export function formatGatewayProbeRow(row: GatewayProbeRow): string {
  const mark = row.ok ? "ok  " : "FAIL"
  const status = row.status !== undefined ? ` HTTP ${row.status}` : ""
  const error = row.error ? `  ${row.error}` : ""
  return `${mark} ${row.providerId.padEnd(16)} ${row.modelId.padEnd(28)} ${row.latencyMs}ms${status}${error}`
}

export function formatLocalProbeRow(row: LocalProbeRow): string {
  const name = row.providerId.padEnd(16)
  if (row.failure) {
    return `FAIL ${name} ${row.failure.availability}: ${row.failure.failure.message}`
  }
  const r = row.result!
  const mark = r.reachable && r.authenticated !== false && !r.failure ? "ok  " : "FAIL"
  const auth = r.authenticated === undefined ? "" : r.authenticated ? " auth" : " no-auth"
  const status = r.httpStatus !== undefined ? ` HTTP ${r.httpStatus}` : ""
  const failure = r.failure ? `  ${r.failure.message}` : ""
  return `${mark} ${name} ${r.durationMs}ms${auth}${status}${failure}`
}
