/**
 * Turn a run into the signed ingestion body (`ObservationBatch`, contract v1)
 * and mint run identities. The batch is validated with the same parser the
 * status Worker uses, so a probe can never submit a body the server rejects
 * as malformed.
 */

import {
  STATUS_SCHEMA_VERSION,
  type CheckObservation,
  type ObservationBatch,
  type ProfileId,
} from "../../../../../lib/status/contract"
import { parseObservationBatch } from "../../../../../lib/status/validate"
import { randomBase64Url } from "../../../../signaling-server/worker/tests/synthetic-room.mjs"

import type { ProbeRunResult } from "./types"

export interface BuildObservationBatchInput {
  probeId: string
  runId: string
  registryRevision: number
  scheduledAtMs: number
  profileId: ProfileId
  result: ProbeRunResult
  /** Monitoring-plane checks (`statusPage`, `statusApi`) run alongside. */
  extraChecks?: CheckObservation[]
}

export function buildObservationBatch(input: BuildObservationBatchInput): ObservationBatch {
  const startedAtMs = input.result.startedAtMs
  const finishedAtMs = Math.max(startedAtMs, input.result.finishedAtMs)
  const candidate: ObservationBatch = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    probeId: input.probeId,
    runId: input.runId,
    registryRevision: input.registryRevision,
    scheduledAt: new Date(input.scheduledAtMs).toISOString(),
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    profileId: input.profileId,
    checks: [...input.result.checks, ...(input.extraChecks ?? [])],
  }
  const parsed = parseObservationBatch(candidate)
  if (!parsed.ok) throw new Error(`invalid observation batch: ${parsed.error}`)
  return parsed.value
}

/**
 * Unique per probe: a base36 timestamp plus 72 random bits, so restarts and
 * clock repeats cannot collide. Matches the contract's opaque-ID pattern.
 */
export function newRunId(nowMs: number): string {
  const stamp = Math.max(0, Math.floor(nowMs)).toString(36)
  return `r${stamp}-${randomBase64Url(9)}`
}
