/**
 * The Cloudflare Cron observer (`cf-cron`).
 *
 * Each minute it runs every registered profile whose cadence is due, through
 * the same portable protocol core the external Node probe uses, and records
 * the result through the same ingestion path (in-process, so no HMAC). It
 * fetches the relay's PUBLIC route. If the runner itself breaks, every check
 * is recorded as `unknown` / `runner_error`: observer failure, not an outage.
 */

import { OFFICIAL_SIGNALING_HOST } from "../../../../../lib/status/config"
import type { CheckObservation, ProfileId } from "../../../../../lib/status/contract"
import { minuteOf } from "../../../../../lib/status/derive"
import {
  buildObservationBatch,
  newRunId,
  runProbeChecks,
  type ProbeRunResult,
  type ProbeTransport,
} from "../../../probe/src/core/index"
import type { Env } from "../env"
import { recordObservation, type RecordOutcome } from "../ingest/record"
import { logEvent } from "../platform/http"
import { cadenceDue, probeActive, type Registry } from "../registry/registry"
import { createWorkerTransport } from "./worker-transport"

export interface CronProbeRun {
  profileId: ProfileId
  outcome: RecordOutcome | { ok: false; code: "skipped"; reason: string }
}

function parseOrigins(raw: string): Partial<Record<ProfileId, string>> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Partial<Record<ProfileId, string>> = {}
    for (const id of ["web", "ios", "android"] as const) {
      if (typeof parsed[id] === "string" && parsed[id]) out[id] = parsed[id] as string
    }
    return out
  } catch {
    return {}
  }
}

/** Every planned check recorded as an observer failure. */
export function runnerErrorResult(
  startedAtMs: number,
  finishedAtMs: number,
  runHttp: boolean,
  runProtocol: boolean
): ProbeRunResult {
  const failed = (checkId: CheckObservation["checkId"]): CheckObservation => ({
    checkId,
    result: "unknown",
    durationMs: null,
    reason: "runner_error",
    attempted: true,
    dependsOn: null,
  })
  const checks: CheckObservation[] = []
  if (runHttp) checks.push(failed("signalingHttp"))
  if (runProtocol) checks.push(failed("signalingAuth"), failed("relayData"))
  return { startedAtMs, finishedAtMs, checks }
}

/**
 * Only the production status deployment may probe the official production
 * relay. A staging or development Worker pointed at it would add synthetic
 * rooms (Durable Objects, alarms, requests) to the production relay's shared
 * account usage for evidence nobody publishes, so it probes nothing and its
 * page shows the minutes as unobserved instead.
 */
export function probeTargetAllowed(env: Pick<Env, "STATUS_ENV" | "SIGNALING_URL">): boolean {
  let host: string
  try {
    host = new URL(env.SIGNALING_URL).hostname.toLowerCase()
  } catch {
    return false
  }
  return host !== OFFICIAL_SIGNALING_HOST || env.STATUS_ENV === "production"
}

export async function runCloudflareProbe(input: {
  env: Env
  registry: Registry
  scheduledTimeMs: number
  transport?: ProbeTransport
  now?: () => number
}): Promise<CronProbeRun[]> {
  const { env, registry } = input
  const now = input.now ?? (() => Date.now())
  const probe = registry.probes.get(env.CLOUDFLARE_PROBE_ID)
  const minute = minuteOf(input.scheduledTimeMs)
  const scheduledAtMs = minute * 60_000
  if (!probe || !probeActive(probe, scheduledAtMs)) return []
  if (!probeTargetAllowed(env)) {
    logEvent("cron_probe.production_target_refused", { statusEnv: env.STATUS_ENV })
    return []
  }
  const transport = input.transport ?? createWorkerTransport()
  const origins = parseOrigins(env.PROBE_ORIGIN_PROFILES)

  const due = probe.profiles
    .map((profile) => ({
      profile,
      runHttp: cadenceDue(profile.httpCadenceSeconds, minute),
      runProtocol: cadenceDue(profile.protocolCadenceSeconds, minute),
    }))
    .filter((entry) => entry.runHttp || entry.runProtocol)

  // Profiles run concurrently: four sequential 20 s protocol runs could
  // outlast the minute and overlap the next invocation.
  return Promise.all(
    due.map(async ({ profile, runHttp, runProtocol }): Promise<CronProbeRun> => {
      const origin = profile.id === "native" ? null : (origins[profile.id] ?? null)
      if (profile.id !== "native" && origin === null) {
        logEvent("cron_probe.origin_unconfigured", { profileId: profile.id })
        return {
          profileId: profile.id,
          outcome: { ok: false, code: "skipped", reason: "origin_unconfigured" },
        }
      }
      const startedAtMs = now()
      let result: ProbeRunResult
      try {
        result = await runProbeChecks({
          signalingUrl: env.SIGNALING_URL,
          profile: { id: profile.id, origin },
          runHttp,
          runProtocol,
          transport,
          now,
        })
      } catch (error) {
        logEvent("cron_probe.runner_error", {
          profileId: profile.id,
          error: error instanceof Error ? error.name : "unknown",
        })
        result = runnerErrorResult(startedAtMs, now(), runHttp, runProtocol)
      }
      const batch = buildObservationBatch({
        probeId: probe.id,
        runId: newRunId(startedAtMs),
        registryRevision: registry.revision,
        scheduledAtMs,
        profileId: profile.id,
        result,
      })
      const outcome = await recordObservation({
        db: env.DB,
        registry,
        batch,
        authenticatedProbeId: probe.id,
        nowMs: now(),
      })
      if (!outcome.ok)
        logEvent("cron_probe.refused", { profileId: profile.id, reason: outcome.reason })
      return { profileId: profile.id, outcome }
    })
  )
}
