/**
 * `runProbeChecks`: one scheduled run for one profile. HTTP and the protocol
 * run are independent questions, so they run concurrently and each yields its
 * own observation; a failure in the runner itself becomes `unknown` +
 * `runner_error`, never a target failure.
 */

import type { CheckObservation } from "../../../../../lib/status/contract"

import { runHttpCheck } from "./http-check"
import { runProtocolChecks } from "./protocol-run"
import { resolveLimits, type ProbeRunResult, type RunProbeChecksInput } from "./types"

export async function runProbeChecks(input: RunProbeChecksInput): Promise<ProbeRunResult> {
  const now = input.now ?? Date.now
  const signal = input.signal ?? new AbortController().signal
  const startedAtMs = now()

  let limits
  try {
    limits = resolveLimits(input.limits)
  } catch {
    return {
      startedAtMs,
      finishedAtMs: Math.max(startedAtMs, now()),
      checks: runnerErrorChecks(input.runHttp, input.runProtocol),
      aborted: false,
    }
  }

  const httpPromise = input.runHttp
    ? runHttpCheck({
        signalingUrl: input.signalingUrl,
        transport: input.transport,
        now,
        signal,
        limits,
      })
    : Promise.resolve(null)
  const protocolPromise = input.runProtocol
    ? runProtocolChecks({
        signalingUrl: input.signalingUrl,
        origin: input.profile.origin,
        transport: input.transport,
        now,
        signal,
        limits,
      })
    : Promise.resolve(null)

  const [http, protocol] = await Promise.all([
    httpPromise.catch(() => ({
      check: runnerError("signalingHttp", true),
      aborted: signal.aborted,
    })),
    protocolPromise.catch(() => ({
      auth: runnerError("signalingAuth", true),
      data: runnerError("relayData", false),
      aborted: signal.aborted,
      relayBytesSent: 0,
    })),
  ])

  const checks: CheckObservation[] = []
  if (http) checks.push(http.check)
  if (protocol) checks.push(protocol.auth, protocol.data)
  return {
    startedAtMs,
    finishedAtMs: Math.max(startedAtMs, now()),
    checks,
    aborted: signal.aborted || Boolean(http?.aborted) || Boolean(protocol?.aborted),
    ...(protocol ? { relayBytesSent: protocol.relayBytesSent } : {}),
  }
}

function runnerError(checkId: CheckObservation["checkId"], attempted: boolean): CheckObservation {
  return {
    checkId,
    result: "unknown",
    durationMs: null,
    reason: "runner_error",
    attempted,
    dependsOn: null,
  }
}

function runnerErrorChecks(runHttp: boolean, runProtocol: boolean): CheckObservation[] {
  const checks: CheckObservation[] = []
  if (runHttp) checks.push(runnerError("signalingHttp", false))
  if (runProtocol) checks.push(runnerError("signalingAuth", false), runnerError("relayData", false))
  return checks
}
