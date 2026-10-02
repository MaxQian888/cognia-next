/**
 * Monitoring-plane checks (plan §4): is the primary status page reachable,
 * and does its API answer with a valid live snapshot? These describe the
 * observer path, never the signaling service, and ride along with the
 * native profile's runs as `extraChecks`.
 */

import {
  MAX_SNAPSHOT_BYTES,
  type CheckObservation,
  type ReasonCode,
} from "../../../../../lib/status/contract"
import { parsePublicSnapshot } from "../../../../../lib/status/validate"

import { ProbeTransportError } from "../core/types"
import { getText, type FetchLike } from "./http"

export const MONITORING_TIMEOUT_MS = 6_000
const MAX_HTML_BYTES = 2 * 1024 * 1024

export interface MonitoringInput {
  statusPageUrl: string
  apiBase: string
  signal: AbortSignal
  fetchImpl?: FetchLike
  now?: () => number
  timeoutMs?: number
  userAgent?: string
}

class CheckFailure extends Error {
  constructor(readonly reason: ReasonCode) {
    super(reason)
  }
}

async function measure(
  checkId: "statusPage" | "statusApi",
  now: () => number,
  signal: AbortSignal,
  body: () => Promise<void>
): Promise<CheckObservation> {
  const started = now()
  const duration = () => Math.max(0, Math.round(now() - started))
  try {
    await body()
    return {
      checkId,
      result: "pass",
      durationMs: duration(),
      reason: null,
      attempted: true,
      dependsOn: null,
    }
  } catch (error) {
    if (signal.aborted) {
      return {
        checkId,
        result: "unknown",
        durationMs: null,
        reason: "runner_error",
        attempted: true,
        dependsOn: null,
      }
    }
    if (error instanceof CheckFailure || error instanceof ProbeTransportError) {
      return {
        checkId,
        result: "fail",
        durationMs: duration(),
        reason: error.reason,
        attempted: true,
        dependsOn: null,
      }
    }
    return {
      checkId,
      result: "unknown",
      durationMs: null,
      reason: "runner_error",
      attempted: true,
      dependsOn: null,
    }
  }
}

export async function runMonitoringChecks(input: MonitoringInput): Promise<CheckObservation[]> {
  const now = input.now ?? Date.now
  const timeoutMs = input.timeoutMs ?? MONITORING_TIMEOUT_MS
  const common = {
    timeoutMs,
    signal: input.signal,
    fetchImpl: input.fetchImpl,
    userAgent: input.userAgent,
  }
  const apiBase = input.apiBase.replace(/\/+$/, "")

  const page = measure("statusPage", now, input.signal, async () => {
    const response = await getText(input.statusPageUrl, {
      ...common,
      maxBytes: MAX_HTML_BYTES,
      accept: "text/html",
    })
    if (response.status !== 200) throw new CheckFailure("http_status")
    const isHtml =
      response.contentType.toLowerCase().includes("text/html") &&
      response.text !== null &&
      /<html[\s>]/i.test(response.text)
    if (!isHtml) throw new CheckFailure("schema_mismatch")
  })

  const api = measure("statusApi", now, input.signal, async () => {
    const health = await getText(`${apiBase}/healthz`, {
      ...common,
      maxBytes: 16 * 1024,
      accept: "application/json",
    })
    if (health.status !== 200) throw new CheckFailure("http_status")
    if (health.text === null) throw new CheckFailure("schema_mismatch")
    let healthBody: unknown
    try {
      healthBody = JSON.parse(health.text)
    } catch {
      throw new CheckFailure("schema_mismatch")
    }
    if ((healthBody as { ok?: unknown } | null)?.ok !== true)
      throw new CheckFailure("schema_mismatch")

    const snapshot = await getText(`${apiBase}/snapshot?range=24h`, {
      ...common,
      maxBytes: MAX_SNAPSHOT_BYTES,
      accept: "application/json",
    })
    if (snapshot.status !== 200) throw new CheckFailure("http_status")
    if (snapshot.text === null) throw new CheckFailure("schema_mismatch")
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(snapshot.text)
    } catch {
      throw new CheckFailure("schema_mismatch")
    }
    if (!parsePublicSnapshot(parsedJson).ok) throw new CheckFailure("schema_mismatch")
  })

  return Promise.all([page, api])
}
