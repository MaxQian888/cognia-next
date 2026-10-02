/**
 * Test helpers for the status Worker suites (vitest-pool-workers).
 */

import { env } from "cloudflare:test"

import {
  STATUS_SCHEMA_VERSION,
  type CheckObservation,
  type ObservationBatch,
  type ProfileId,
} from "../../../../lib/status/contract"
import { base64UrlToBytes, signProbeRequest } from "../../../../lib/status/signing"
import type { Env } from "../src/env"
import { acquireLease, type JobLease } from "../src/platform/lease"

export const testEnv = env as unknown as Env

/** Matches PROBE_SECRETS in vitest.config.ts. */
export const EXT_KEY_ID = "ext-test-k1"
export const EXT_SECRET = base64UrlToBytes("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA")!
export const OTHER_KEY_ID = "ext-test-k2"
export const OTHER_SECRET = base64UrlToBytes("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8")!

const CORE_TABLES = [
  "probe_runs",
  "reference_slots",
  "dirty_hours",
  "hourly_rollups",
  "daily_rollups",
  "snapshots",
  "admin_operations",
  "audit_events",
  "probe_keys",
  "probe_profiles",
  "reference_epochs",
  "probes",
]

/**
 * Reset core tables to an empty registry at revision 0 (the seed migration's
 * `cf-cron` row is removed so each test declares exactly what it needs).
 */
export async function resetCore(db: D1Database = testEnv.DB): Promise<void> {
  await db.batch([
    ...CORE_TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)),
    db.prepare("UPDATE counters SET value = 0"),
    db.prepare("UPDATE leases SET owner = NULL, fence = 0, expires_at = 0"),
  ])
}

export interface SeedProbe {
  id: string
  source?: "external" | "cloudflare"
  enrolledAtMs: number
  profiles?: Array<{ id: ProfileId; http: number | null; protocol: number | null }>
  keyId?: string
  disabled?: boolean
}

/** Insert probes, their keys and reference epochs; bumps the registry revision. */
export async function seedRegistry(
  probes: SeedProbe[],
  epochs: Array<{ probeId: string; effectiveMinute: number }>,
  db: D1Database = testEnv.DB
): Promise<void> {
  const statements: D1PreparedStatement[] = []
  for (const probe of probes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO probes (id, source, label_json, location_json, provider, enrolled_at, disabled, registry_revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .bind(
          probe.id,
          probe.source ?? "external",
          JSON.stringify({ en: `Probe ${probe.id}` }),
          JSON.stringify({ en: "Test location" }),
          "Test provider",
          probe.enrolledAtMs,
          probe.disabled ? 1 : 0,
          probe.enrolledAtMs
        )
    )
    for (const profile of probe.profiles ?? [{ id: "native", http: 60, protocol: 60 }]) {
      statements.push(
        db
          .prepare(
            "INSERT INTO probe_profiles (probe_id, profile_id, http_cadence_seconds, protocol_cadence_seconds) VALUES (?, ?, ?, ?)"
          )
          .bind(probe.id, profile.id, profile.http, profile.protocol)
      )
    }
    if (probe.keyId) {
      statements.push(
        db
          .prepare("INSERT INTO probe_keys (key_id, probe_id, not_before) VALUES (?, ?, 0)")
          .bind(probe.keyId, probe.id)
      )
    }
  }
  epochs.forEach((epoch, index) => {
    statements.push(
      db
        .prepare(
          "INSERT INTO reference_epochs (revision, probe_id, effective_minute, created_at, actor, reason) VALUES (?, ?, ?, 0, 'test', 'test')"
        )
        .bind(index + 1, epoch.probeId, epoch.effectiveMinute)
    )
  })
  statements.push(db.prepare("UPDATE counters SET value = 1 WHERE name = 'registry_revision'"))
  await db.batch(statements)
}

export function check(
  checkId: CheckObservation["checkId"],
  result: CheckObservation["result"],
  overrides: Partial<CheckObservation> = {}
): CheckObservation {
  if (result === "pass") {
    return {
      checkId,
      result,
      durationMs: 120,
      reason: null,
      attempted: true,
      dependsOn: null,
      ...overrides,
    }
  }
  return {
    checkId,
    result,
    durationMs: result === "fail" ? 5_000 : null,
    reason: result === "fail" ? "auth_timeout" : "dependency_failed",
    attempted: result === "fail",
    dependsOn: null,
    ...overrides,
  }
}

export function batch(input: {
  probeId: string
  runId: string
  scheduledAtMs: number
  profileId?: ProfileId
  checks?: CheckObservation[]
  registryRevision?: number
}): ObservationBatch {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    probeId: input.probeId,
    runId: input.runId,
    registryRevision: input.registryRevision ?? 1,
    scheduledAt: new Date(input.scheduledAtMs).toISOString(),
    startedAt: new Date(input.scheduledAtMs + 100).toISOString(),
    finishedAt: new Date(input.scheduledAtMs + 2_000).toISOString(),
    profileId: input.profileId ?? "native",
    checks: input.checks ?? [
      check("signalingHttp", "pass"),
      check("signalingAuth", "pass"),
      check("relayData", "pass"),
    ],
  }
}

/** A signed ingestion request as the external probe would send it. */
export async function signedObservationRequest(
  body: ObservationBatch | string,
  opts: { keyId?: string; secret?: Uint8Array; nowMs?: number; path?: string; runId?: string } = {}
): Promise<Request> {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const bytes = new TextEncoder().encode(text)
  const path = opts.path ?? "/api/status/v1/observations"
  const headers = await signProbeRequest({
    keyId: opts.keyId ?? EXT_KEY_ID,
    secret: opts.secret ?? EXT_SECRET,
    method: "POST",
    path,
    runId: opts.runId ?? (typeof body === "string" ? "run_x" : body.runId),
    body: bytes,
    nowMs: opts.nowMs ?? Date.now(),
  })
  return new Request(`https://status.test${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: text,
  })
}

export async function lease(job = "aggregate", nowMs = Date.now()): Promise<JobLease> {
  const acquired = await acquireLease(testEnv.DB, job, nowMs)
  if (!acquired) throw new Error(`lease ${job} unavailable`)
  return acquired
}

/** Execution context stub that collects waitUntil promises. */
export function executionContext(): ExecutionContext & { settle(): Promise<void> } {
  const pending: Promise<unknown>[] = []
  return {
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise)
    },
    passThroughOnException: () => {},
    props: {},
    settle: async () => {
      await Promise.allSettled(pending)
    },
  } as unknown as ExecutionContext & { settle(): Promise<void> }
}

export const minuteMs = (minute: number) => minute * 60_000
export const currentMinute = (nowMs = Date.now()) => Math.floor(nowMs / 60_000)
