/**
 * The `signalingHttp` check: public DNS/TLS/HTTP to `GET /healthz`, with the
 * body judged by the shared pure parser (`lib/signaling/relay-health.ts`), so
 * the probe, the status Worker and the app's Connectivity settings agree on
 * what "a ready Cognia rendezvous" means.
 */

import type { CheckObservation, ReasonCode } from "../../../../../lib/status/contract"
import {
  classifyHealthz,
  relayHealthUrl,
  relayProtocolMatches,
} from "../../../../../lib/signaling/relay-health"

import { DeadlineError, ProbeAbortedError, withDeadline } from "./deadline"
import { ProbeTransportError, type ProbeLimits, type ProbeTransport } from "./types"

/** Transport reasons an HTTP attempt may legitimately report. */
const HTTP_TRANSPORT_REASONS: ReadonlySet<ReasonCode> = new Set([
  "timeout",
  "dns_error",
  "tls_error",
  "connect_error",
  "http_status",
  "schema_mismatch",
])

export interface HttpCheckInput {
  signalingUrl: string
  transport: ProbeTransport
  now: () => number
  signal: AbortSignal
  limits: ProbeLimits
}

export interface HttpCheckOutcome {
  check: CheckObservation
  aborted: boolean
}

export async function runHttpCheck(input: HttpCheckInput): Promise<HttpCheckOutcome> {
  const { now, signal, limits } = input
  const url = relayHealthUrl(input.signalingUrl)
  if (!url) return { check: unknownCheck(true), aborted: false }
  const startedAt = now()
  const failed = (reason: ReasonCode): HttpCheckOutcome => ({
    check: {
      checkId: "signalingHttp",
      result: "fail",
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      reason,
      attempted: true,
      dependsOn: null,
    },
    aborted: false,
  })
  try {
    const response = await withDeadline(
      input.transport.getJson(url, { timeoutMs: limits.httpTimeoutMs, signal }),
      limits.httpTimeoutMs + 50,
      signal
    )
    const durationMs = Math.max(0, Math.round(now() - startedAt))
    if (response.status !== 200) return failed("http_status")
    if (response.parseError || response.body === undefined) return failed("schema_mismatch")
    const health = classifyHealthz(response.body)
    if (health.state === "not-a-relay") return failed("schema_mismatch")
    if (health.capabilities && !relayProtocolMatches(health.capabilities)) {
      return failed("protocol_mismatch")
    }
    // A Cognia relay without the data lane (or without a capabilities block)
    // is not the service this status page describes.
    if (health.state !== "ready") return failed("schema_mismatch")
    return {
      check: {
        checkId: "signalingHttp",
        result: "pass",
        durationMs,
        reason: null,
        attempted: true,
        dependsOn: null,
      },
      aborted: false,
    }
  } catch (error) {
    if (signal.aborted || error instanceof ProbeAbortedError) {
      return { check: unknownCheck(true), aborted: true }
    }
    if (error instanceof DeadlineError) return failed("timeout")
    if (error instanceof ProbeTransportError) {
      return failed(HTTP_TRANSPORT_REASONS.has(error.reason) ? error.reason : "connect_error")
    }
    return { check: unknownCheck(true), aborted: false }
  }
}

function unknownCheck(attempted: boolean): CheckObservation {
  return {
    checkId: "signalingHttp",
    result: "unknown",
    durationMs: null,
    reason: "runner_error",
    attempted,
    dependsOn: null,
  }
}
