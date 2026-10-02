/**
 * Record one probe run: the single write path for both signed external
 * observations and the in-process Cloudflare Cron observer.
 *
 * Rules (plan §7):
 * - A run is immutable. `(probeId, runId)` with the same canonical digest is
 *   an idempotent duplicate; with a different digest it is a 409 conflict.
 * - Only checks the registry assigns to that probe/profile are accepted.
 * - A run is accepted up to 10 minutes after its scheduled time; older runs
 *   are refused rather than replayed as current health.
 * - The reference observer's native run fills the minute slot of its
 *   scheduled UTC minute. The first observation of a minute wins; a later
 *   run for the same minute never replaces it.
 * - The hour containing the slot is marked dirty in the same atomic batch.
 */

import {
  LATE_OBSERVATION_MS,
  MINUTE_MS,
  OBSERVATION_SKEW_MS,
  type CheckId,
  type CheckObservation,
  type ObservationBatch,
  type StatusErrorCode,
} from "../../../../../lib/status/contract"
import { hourOf, minuteOf } from "../../../../../lib/status/derive"
import { sha256Hex } from "../../../../../lib/status/signing"
import { markHoursDirtyStatements } from "../aggregate/dirty"
import { logEvent } from "../platform/http"
import {
  cadenceDue,
  probeActive,
  profileConfig,
  referenceForMinute,
  type ProbeRecord,
  type Registry,
} from "../registry/registry"

export type RecordOutcome =
  | { ok: true; status: "accepted" | "duplicate"; referenceSlot: boolean }
  | { ok: false; code: StatusErrorCode; reason: string }

const PROTOCOL_CHECKS: ReadonlySet<CheckId> = new Set(["signalingAuth", "relayData"])
const MONITORING_CHECKS: ReadonlySet<CheckId> = new Set(["statusPage", "statusApi"])

const encoder = new TextEncoder()

function refuse(code: StatusErrorCode, reason: string): RecordOutcome {
  return { ok: false, code, reason }
}

/** Which checks the registry allows this run to carry. */
function checkAllowed(
  probe: ProbeRecord,
  batch: ObservationBatch,
  check: CheckObservation
): boolean {
  const profile = profileConfig(probe, batch.profileId)
  if (!profile) return false
  if (check.checkId === "signalingHttp") return profile.httpCadenceSeconds !== null
  if (PROTOCOL_CHECKS.has(check.checkId)) return profile.protocolCadenceSeconds !== null
  // Monitoring-plane checks come from an external observer's native run only.
  if (MONITORING_CHECKS.has(check.checkId)) {
    return probe.source === "external" && batch.profileId === "native"
  }
  return false
}

function resultOf(checks: readonly CheckObservation[], id: CheckId): CheckObservation | undefined {
  return checks.find((check) => check.checkId === id)
}

export interface RecordInput {
  db: D1Database
  registry: Registry
  batch: ObservationBatch
  /** The probe the caller proved it speaks for (signature key or in-process). */
  authenticatedProbeId: string
  nowMs: number
}

export async function recordObservation(input: RecordInput): Promise<RecordOutcome> {
  const { db, registry, batch, nowMs } = input
  if (batch.probeId !== input.authenticatedProbeId) {
    return refuse("forbidden", "probe_mismatch")
  }
  const probe = registry.probes.get(batch.probeId)
  if (!probe) return refuse("forbidden", "unknown_probe")
  if (batch.registryRevision > registry.revision)
    return refuse("bad_request", "future_registry_revision")

  const scheduledAtMs = Date.parse(batch.scheduledAt)
  const startedAtMs = Date.parse(batch.startedAt)
  const finishedAtMs = Date.parse(batch.finishedAt)
  if (scheduledAtMs % MINUTE_MS !== 0) return refuse("bad_request", "scheduled_not_minute_aligned")
  if (scheduledAtMs > nowMs + OBSERVATION_SKEW_MS || finishedAtMs > nowMs + OBSERVATION_SKEW_MS) {
    return refuse("bad_request", "future_observation")
  }
  if (Math.abs(startedAtMs - scheduledAtMs) > OBSERVATION_SKEW_MS) {
    return refuse("bad_request", "start_outside_skew")
  }
  if (nowMs - scheduledAtMs > LATE_OBSERVATION_MS) return refuse("too_late", "late_observation")
  if (!probeActive(probe, scheduledAtMs)) return refuse("forbidden", "probe_inactive")

  const minute = minuteOf(scheduledAtMs)
  const profile = profileConfig(probe, batch.profileId)
  if (!profile) return refuse("forbidden", "profile_not_registered")
  for (const check of batch.checks) {
    if (!checkAllowed(probe, batch, check)) return refuse("forbidden", "check_not_registered")
  }
  // A dependency may only point at a check of the same run.
  for (const check of batch.checks) {
    if (check.dependsOn && !resultOf(batch.checks, check.dependsOn)) {
      return refuse("bad_request", "dangling_dependency")
    }
  }

  const canonical = JSON.stringify(batch)
  const digest = await sha256Hex(encoder.encode(canonical))
  const existing = await db
    .prepare("SELECT body_digest FROM probe_runs WHERE probe_id = ? AND run_id = ?")
    .bind(batch.probeId, batch.runId)
    .first<{ body_digest: string }>()
  if (existing) {
    if (existing.body_digest === digest)
      return { ok: true, status: "duplicate", referenceSlot: false }
    logEvent("ingest.conflicting_replay", { probeId: batch.probeId })
    return refuse("conflict", "conflicting_replay")
  }

  const epoch = referenceForMinute(registry, minute)
  const isReference =
    epoch !== null && epoch.probeId === batch.probeId && batch.profileId === "native"
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO probe_runs (probe_id, run_id, profile_id, registry_revision, scheduled_at,
           scheduled_minute, started_at, finished_at, received_at, body_digest, checks_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (probe_id, run_id) DO NOTHING`
      )
      .bind(
        batch.probeId,
        batch.runId,
        batch.profileId,
        batch.registryRevision,
        scheduledAtMs,
        minute,
        startedAtMs,
        finishedAtMs,
        nowMs,
        digest,
        JSON.stringify(batch.checks)
      ),
  ]
  if (isReference) {
    // A reference minute must hold all three results; a check that is not
    // due or absent from the run is unknown, never a pass.
    const slotValue = (id: CheckId) => {
      const check = resultOf(batch.checks, id)
      return {
        result: check?.result ?? "unknown",
        ms: check?.result === "pass" ? Math.round(check.durationMs ?? 0) : null,
        reason: check?.reason ?? (check ? null : "missing"),
      }
    }
    const http = slotValue("signalingHttp")
    const auth = slotValue("signalingAuth")
    const data = slotValue("relayData")
    statements.push(
      db
        .prepare(
          `INSERT INTO reference_slots (minute, reference_revision, probe_id, run_id, http, auth, data,
             http_ms, auth_ms, data_ms, http_reason, auth_reason, data_reason, received_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM probe_runs WHERE probe_id = ? AND run_id = ? AND body_digest = ?)
           ON CONFLICT (minute) DO NOTHING`
        )
        .bind(
          minute,
          epoch.revision,
          batch.probeId,
          batch.runId,
          http.result,
          auth.result,
          data.result,
          http.ms,
          auth.ms,
          data.ms,
          http.reason,
          auth.reason,
          data.reason,
          nowMs,
          batch.probeId,
          batch.runId,
          digest
        ),
      ...markHoursDirtyStatements(db, [hourOf(scheduledAtMs)])
    )
  }
  const results = await db.batch(statements)
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // Lost a race with an identical or conflicting concurrent insert.
    const row = await db
      .prepare("SELECT body_digest FROM probe_runs WHERE probe_id = ? AND run_id = ?")
      .bind(batch.probeId, batch.runId)
      .first<{ body_digest: string }>()
    if (row?.body_digest === digest) return { ok: true, status: "duplicate", referenceSlot: false }
    return refuse("conflict", "conflicting_replay")
  }
  const slotWritten = isReference && (results[1]?.meta.changes ?? 0) > 0
  if (isReference && !slotWritten) {
    logEvent("ingest.slot_already_filled", { probeId: batch.probeId, minute })
  }
  // The cadence check is informational: a probe running an undue check is
  // still recorded (its evidence is real), but the operator should know.
  const dueHttp = cadenceDue(profile.httpCadenceSeconds, minute)
  const dueProtocol = cadenceDue(profile.protocolCadenceSeconds, minute)
  if (
    (resultOf(batch.checks, "signalingHttp") && !dueHttp) ||
    (resultOf(batch.checks, "signalingAuth") && !dueProtocol)
  ) {
    logEvent("ingest.off_cadence", { probeId: batch.probeId, profileId: batch.profileId, minute })
  }
  return { ok: true, status: "accepted", referenceSlot: slotWritten }
}
