/**
 * Current-state evaluation of each component from recent evidence.
 *
 * The reference observer's minute slots give the history and the streaks;
 * every other registered probe/profile that runs the same check class is a
 * witness (corroboration, disagreement, Origin-profile failures). The
 * decision itself is `deriveComponentStatus` from the shared contract, so the
 * Worker and the published semantics cannot drift.
 */

import {
  COMPONENT_IDS,
  HOUR_MS,
  LATENCY_DEGRADED_MIN_SAMPLES,
  LATENCY_DEGRADED_P95_MS,
  LATENCY_DEGRADED_WINDOWS,
  MINUTE_MS,
  REFERENCE_FRESH_MS,
  type CheckResult,
  type ComponentId,
  type EvidenceSummary,
  type ReasonCode,
} from "../../../../../lib/status/contract"
import {
  deriveComponentStatus,
  dueEndMinute,
  histogramPercentile,
  isEvidenceFresh,
  minuteOf,
  slotStreaks,
  toIso,
  type SlotOutcome,
  type WitnessEvidence,
} from "../../../../../lib/status/derive"
import {
  cadenceMinutes,
  freshnessForCadence,
  observationStartMinute,
  probeActive,
  referenceForMinute,
  type Registry,
} from "../registry/registry"
import type { ComponentEvaluation } from "../seams"
import { RECENT_SLOT_MINUTES, type RecentEvidence } from "./evidence"
import type { Rollup } from "./rollup"

const SLOT_COLUMN: Record<ComponentId, "http" | "auth" | "data"> = {
  signalingHttp: "http",
  signalingAuth: "auth",
  relayData: "data",
}

export interface EvaluatedComponent {
  evaluation: ComponentEvaluation
  evidence: EvidenceSummary[]
}

interface SeriesPoint {
  minute: number
  outcome: SlotOutcome
  reason: ReasonCode | null
}

/**
 * Expected points of a series, oldest first. Minutes that are due but empty
 * are `missing`; minutes not yet due appear only when evidence already
 * arrived, so an in-flight run is never counted as a gap.
 */
function series(
  fromMinute: number,
  nowMinute: number,
  dueEnd: number,
  everyMinutes: number,
  lookup: (minute: number) => { result: CheckResult; reason: ReasonCode | null } | undefined
): SeriesPoint[] {
  const points: SeriesPoint[] = []
  const first = Math.ceil(fromMinute / everyMinutes) * everyMinutes
  for (let minute = first; minute <= nowMinute; minute += everyMinutes) {
    const found = lookup(minute)
    if (found) points.push({ minute, outcome: found.result, reason: found.reason })
    else if (minute < dueEnd) points.push({ minute, outcome: "missing", reason: "missing" })
  }
  return points
}

function latestOf(points: readonly SeriesPoint[]) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]
    if (point.outcome !== "missing") {
      return {
        result: point.outcome as CheckResult,
        reason: point.reason,
        checkedAtMs: point.minute * MINUTE_MS,
      }
    }
  }
  return null
}

function evidenceSummary(witness: WitnessEvidence, nowMs: number): EvidenceSummary {
  const fresh = isEvidenceFresh(witness, nowMs)
  const latest = witness.latest
  return {
    probeId: witness.probeId,
    profileId: witness.profileId,
    source: witness.source,
    reference: witness.reference,
    // Stale evidence is not shown as its old verdict: no prolonged green.
    result: latest && fresh ? latest.result : "unknown",
    reason: !latest ? "missing" : fresh ? latest.reason : "stale",
    checkedAt: latest ? toIso(latest.checkedAtMs) : null,
    fresh,
    consecutiveFailures: slotStreaks(witness.recent).failures,
    simulatedOrigin: witness.profileId !== "native",
  }
}

/** Proposed guardrail: three complete hours with p95 above the threshold. */
export function latencyDegraded(
  componentId: ComponentId,
  hourly: ReadonlyMap<number, Rollup>,
  nowMs: number
): boolean {
  const currentHour = Math.floor(nowMs / HOUR_MS)
  for (let offset = 1; offset <= LATENCY_DEGRADED_WINDOWS; offset += 1) {
    const histogram = hourly.get(currentHour - offset)?.c[componentId].h
    if (!histogram) return false
    const samples = histogram.reduce((sum, count) => sum + count, 0)
    if (samples < LATENCY_DEGRADED_MIN_SAMPLES) return false
    const p95 = histogramPercentile(histogram, 0.95)
    if (p95 === null || p95 <= LATENCY_DEGRADED_P95_MS) return false
  }
  return true
}

export function evaluateComponents(input: {
  registry: Registry
  evidence: RecentEvidence
  hourly: ReadonlyMap<number, Rollup>
  maintenanceComponents: ReadonlySet<ComponentId>
  nowMs: number
}): EvaluatedComponent[] {
  const { registry, evidence, hourly, maintenanceComponents, nowMs } = input
  const nowMinute = minuteOf(nowMs)
  const dueEnd = dueEndMinute(nowMs)
  const startMinute = observationStartMinute(registry)
  const epoch = referenceForMinute(registry, nowMinute)
  const referenceProbe = epoch ? (registry.probes.get(epoch.probeId) ?? null) : null

  // Index runs: probe -> profile -> scheduledMinute -> checks
  const runIndex = new Map<string, Map<string, Map<number, (typeof evidence.runs)[number]>>>()
  for (const run of evidence.runs) {
    const byProfile = runIndex.get(run.probeId) ?? new Map()
    const byMinute = byProfile.get(run.profileId) ?? new Map()
    // First run of a minute wins, matching the slot rule.
    if (!byMinute.has(run.scheduledMinute)) byMinute.set(run.scheduledMinute, run)
    byProfile.set(run.profileId, byMinute)
    runIndex.set(run.probeId, byProfile)
  }

  return COMPONENT_IDS.map((componentId) => {
    const column = SLOT_COLUMN[componentId]
    let reference: WitnessEvidence | null = null
    if (epoch && referenceProbe && startMinute !== null) {
      const from = Math.max(
        nowMinute - RECENT_SLOT_MINUTES,
        startMinute,
        minuteOf(referenceProbe.enrolledAtMs)
      )
      const points = series(from, nowMinute, dueEnd, 1, (minute) => {
        const slot = evidence.slots.get(minute)
        return slot ? slot.results[column] : undefined
      })
      reference = {
        probeId: referenceProbe.id,
        profileId: "native",
        source: referenceProbe.source,
        reference: true,
        freshMs: REFERENCE_FRESH_MS,
        latest: latestOf(points),
        recent: points.map((point) => point.outcome),
      }
    }

    const witnesses: WitnessEvidence[] = []
    for (const probe of registry.probes.values()) {
      if (!probeActive(probe, nowMs)) continue
      for (const profile of probe.profiles) {
        if (reference && probe.id === reference.probeId && profile.id === "native") continue
        const cadence =
          componentId === "signalingHttp"
            ? profile.httpCadenceSeconds
            : profile.protocolCadenceSeconds
        if (cadence === null) continue
        const every = cadenceMinutes(cadence)
        const byMinute = runIndex.get(probe.id)?.get(profile.id)
        const from = Math.max(nowMinute - 4 * every, minuteOf(probe.enrolledAtMs))
        const points = series(from, nowMinute, dueEnd, every, (minute) => {
          const check = byMinute?.get(minute)?.checks.find((item) => item.checkId === componentId)
          return check ? { result: check.result, reason: check.reason } : undefined
        })
        witnesses.push({
          probeId: probe.id,
          profileId: profile.id,
          source: probe.source,
          reference: false,
          freshMs: freshnessForCadence(cadence),
          latest: latestOf(points),
          recent: points.map((point) => point.outcome),
        })
      }
    }

    const inMaintenance = maintenanceComponents.has(componentId)
    const decided = deriveComponentStatus({ reference, witnesses, inMaintenance, nowMs })
    const freshWitnesses = witnesses.filter(
      (witness) => isEvidenceFresh(witness, nowMs) && witness.latest
    )
    const recentReference = reference
      ? series(
          Math.max(nowMinute - RECENT_SLOT_MINUTES, startMinute ?? nowMinute),
          nowMinute,
          dueEnd,
          1,
          (minute) => evidence.slots.get(minute)?.results[column]
        ).map((point) => ({ minute: point.minute, result: point.outcome, reason: point.reason }))
      : []
    const slow = latencyDegraded(componentId, hourly, nowMs)
    // The latency guardrail can only lower an operational verdict to
    // degraded; it never opens an incident by itself (plan §9).
    const status = decided.status === "operational" && slow ? "degraded" : decided.status
    const evaluation: ComponentEvaluation = {
      componentId,
      evaluatedAtMs: nowMs,
      status,
      confidence: decided.confidence,
      inMaintenance,
      referenceFresh:
        reference !== null &&
        isEvidenceFresh(reference, nowMs) &&
        reference.latest?.result !== "unknown",
      referenceProbeId: reference?.probeId ?? null,
      referenceRecent: recentReference,
      referenceStreaks: decided.referenceStreaks,
      latestEvidenceAtMs: decided.latestEvidenceAtMs,
      witnesses: freshWitnesses.map((witness) => ({
        probeId: witness.probeId,
        profileId: witness.profileId,
        source: witness.source,
        result: witness.latest!.result,
        consecutiveFailures: slotStreaks(witness.recent).failures,
      })),
      latencyDegraded: slow,
    }
    const evidenceList = [...(reference ? [reference] : []), ...witnesses].map((witness) =>
      evidenceSummary(witness, nowMs)
    )
    return { evaluation, evidence: evidenceList }
  })
}
