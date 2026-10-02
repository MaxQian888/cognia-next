/**
 * Registry mutations behind `/admin/probes` (RegistryAdmin in seams.ts).
 *
 * The admin router (owner E) authenticates the operator and records the
 * operation ID; these functions validate the change against the current
 * registry, apply it in one atomic D1 batch with its audit entry and a new
 * registry revision, and return the response to store. A change never
 * rewrites history: enrollment and reference moves take effect at a present
 * or future minute boundary.
 */

import {
  MINUTE_MS,
  type AdminProbeView,
  type ProbeDisableRequest,
  type ProbeEnrollRequest,
  type ProbeSetReferenceRequest,
} from "../../../../../lib/status/contract"
import { minuteOf, toIso } from "../../../../../lib/status/derive"
import { summarizeProbes } from "../aggregate/probes"
import type { Env } from "../env"
import { auditStatement } from "../platform/store"
import type { AdminMutationResult, RegistryAdmin } from "../seams"
import { loadRegistry, probeActive } from "./registry"

function conflict(code: string, detail?: Record<string, unknown>): AdminMutationResult {
  return { status: 409, body: { code: "conflict", reason: code, ...detail } }
}

function badRequest(reason: string): AdminMutationResult {
  return { status: 400, body: { code: "bad_request", reason } }
}

export async function listProbesForAdmin(env: Env, nowMs: number): Promise<AdminProbeView[]> {
  const registry = await loadRegistry(env.DB)
  const summaries = await summarizeProbes(env.DB, registry, nowMs)
  const keys = await env.DB.prepare(
    "SELECT key_id, probe_id FROM probe_keys WHERE revoked_at IS NULL ORDER BY key_id"
  ).all<{ key_id: string; probe_id: string }>()
  return summaries.map((summary) => {
    const record = registry.probes.get(summary.id)!
    return {
      ...summary,
      disabled: record.disabled,
      retiredAt: record.retiredAtMs === null ? null : toIso(record.retiredAtMs),
      keyIds: (keys.results ?? [])
        .filter((key) => key.probe_id === summary.id)
        .map((key) => key.key_id),
    }
  })
}

export async function enrollProbe(
  env: Env,
  request: ProbeEnrollRequest,
  actor: string,
  nowMs: number
): Promise<AdminMutationResult> {
  const enrolledAtMs = Date.parse(request.enrolledAt)
  if (enrolledAtMs < Math.floor(nowMs / MINUTE_MS) * MINUTE_MS) {
    return badRequest("enrollment cannot start in the past")
  }
  if (request.source === "cloudflare" && request.probeId !== env.CLOUDFLARE_PROBE_ID) {
    return badRequest("only the configured Cron observer may use the cloudflare source")
  }
  const registry = await loadRegistry(env.DB)
  if (registry.probes.has(request.probeId)) return conflict("probe_exists")
  const existingKey = await env.DB.prepare("SELECT 1 FROM probe_keys WHERE key_id = ?")
    .bind(request.keyId)
    .first()
  if (existingKey) return conflict("key_exists")

  const db = env.DB
  const revision = registry.revision + 1
  const statements: D1PreparedStatement[] = [
    // Guard the whole batch on the revision we validated against: the next
    // statement runs only if this compare-and-set changed a row
    // (`changes() = 1`), so two concurrent registry edits cannot both apply.
    db
      .prepare("UPDATE counters SET value = ? WHERE name = 'registry_revision' AND value = ?")
      .bind(revision, registry.revision),
    db
      .prepare(
        `INSERT INTO probes (id, source, label_json, location_json, provider, enrolled_at, registry_revision, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`
      )
      .bind(
        request.probeId,
        request.source,
        JSON.stringify(request.label),
        request.location ? JSON.stringify(request.location) : null,
        request.provider,
        enrolledAtMs,
        revision,
        nowMs
      ),
    ...request.profiles.map((profile) =>
      db
        .prepare(
          `INSERT INTO probe_profiles (probe_id, profile_id, http_cadence_seconds, protocol_cadence_seconds)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM probes WHERE id = ? AND registry_revision = ?)`
        )
        .bind(
          request.probeId,
          profile.id,
          profile.httpCadenceSeconds,
          profile.protocolCadenceSeconds,
          request.probeId,
          revision
        )
    ),
    db
      .prepare(
        `INSERT INTO probe_keys (key_id, probe_id, not_before, not_after, revoked_at)
         SELECT ?, ?, ?, NULL, NULL WHERE EXISTS (SELECT 1 FROM probes WHERE id = ? AND registry_revision = ?)`
      )
      .bind(request.keyId, request.probeId, nowMs, request.probeId, revision),
    auditStatement(
      db,
      {
        atMs: nowMs,
        actor,
        action: "probe.enroll",
        targetType: "probe",
        targetId: request.probeId,
        revision,
        detail: {
          source: request.source,
          enrolledAt: request.enrolledAt,
          profiles: request.profiles,
          keyId: request.keyId,
        },
      },
      { onlyIfPreviousChanged: true }
    ),
  ]
  const results = await db.batch(statements)
  if ((results[1]?.meta.changes ?? 0) === 0) return conflict("registry_changed")
  const probes = await listProbesForAdmin(env, nowMs)
  return {
    status: 201,
    body: {
      registryRevision: revision,
      probe: probes.find((probe) => probe.id === request.probeId),
    },
  }
}

export async function setProbeDisabled(
  env: Env,
  request: ProbeDisableRequest,
  actor: string,
  nowMs: number
): Promise<AdminMutationResult> {
  const registry = await loadRegistry(env.DB)
  const probe = registry.probes.get(request.probeId)
  if (!probe) return { status: 404, body: { code: "not_found" } }
  if (probe.disabled === request.disabled) {
    return { status: 200, body: { registryRevision: registry.revision, unchanged: true } }
  }
  const db = env.DB
  const revision = registry.revision + 1
  const results = await db.batch([
    db
      .prepare("UPDATE counters SET value = ? WHERE name = 'registry_revision' AND value = ?")
      .bind(revision, registry.revision),
    db
      .prepare(
        `UPDATE probes SET disabled = ?, disabled_reason = ?, registry_revision = ?, updated_at = ?
         WHERE id = ? AND changes() = 1`
      )
      .bind(
        request.disabled ? 1 : 0,
        request.disabled ? request.reason : null,
        revision,
        nowMs,
        request.probeId
      ),
    auditStatement(
      db,
      {
        atMs: nowMs,
        actor,
        action: request.disabled ? "probe.disable" : "probe.enable",
        targetType: "probe",
        targetId: request.probeId,
        revision,
        detail: { reason: request.reason },
      },
      { onlyIfPreviousChanged: true }
    ),
  ])
  if ((results[1]?.meta.changes ?? 0) === 0) return conflict("registry_changed")
  return {
    status: 200,
    body: { registryRevision: revision, probeId: request.probeId, disabled: request.disabled },
  }
}

export async function setReferenceProbe(
  env: Env,
  request: ProbeSetReferenceRequest,
  actor: string,
  nowMs: number
): Promise<AdminMutationResult> {
  const effectiveMinute = minuteOf(Date.parse(request.effectiveAt))
  // A future boundary only: the minute that is being observed right now
  // already has its reference.
  if (effectiveMinute <= minuteOf(nowMs)) return badRequest("effectiveAt must be a future minute")
  const registry = await loadRegistry(env.DB)
  const probe = registry.probes.get(request.probeId)
  if (!probe) return { status: 404, body: { code: "not_found" } }
  if (!probeActive(probe, effectiveMinute * MINUTE_MS))
    return badRequest("probe is not active at effectiveAt")
  const native = probe.profiles.find((profile) => profile.id === "native")
  if (!native || native.httpCadenceSeconds !== 60 || native.protocolCadenceSeconds !== 60) {
    return badRequest("a reference needs a native profile running every check at 60 s")
  }
  const last = registry.epochs[registry.epochs.length - 1]
  if (last && effectiveMinute <= last.effectiveMinute) {
    return conflict("epoch_order", { lastEffectiveAt: toIso(last.effectiveMinute * MINUTE_MS) })
  }
  if (last && last.probeId === request.probeId) {
    return { status: 200, body: { registryRevision: registry.revision, unchanged: true } }
  }
  const db = env.DB
  const revision = registry.revision + 1
  const results = await db.batch([
    db
      .prepare("UPDATE counters SET value = ? WHERE name = 'registry_revision' AND value = ?")
      .bind(revision, registry.revision),
    db
      .prepare(
        `INSERT INTO reference_epochs (revision, probe_id, effective_minute, created_at, actor, reason)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`
      )
      .bind(revision, request.probeId, effectiveMinute, nowMs, actor, request.reason),
    auditStatement(
      db,
      {
        atMs: nowMs,
        actor,
        action: "probe.set_reference",
        targetType: "probe",
        targetId: request.probeId,
        revision,
        detail: { effectiveAt: request.effectiveAt, reason: request.reason },
      },
      { onlyIfPreviousChanged: true }
    ),
  ])
  if ((results[1]?.meta.changes ?? 0) === 0) return conflict("registry_changed")
  return {
    status: 200,
    body: {
      registryRevision: revision,
      probeId: request.probeId,
      effectiveAt: request.effectiveAt,
    },
  }
}

/** Compile-time proof this module satisfies the seam the admin router uses. */
export const registryAdmin: RegistryAdmin = {
  listProbesForAdmin,
  enrollProbe,
  setProbeDisabled,
  setReferenceProbe,
}
