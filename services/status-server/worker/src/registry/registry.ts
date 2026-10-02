/**
 * Probe registry reads: which observers exist, what they run, which key may
 * speak for which probe, and which observer is the reference for a minute.
 *
 * Location, provider and cadence always come from here, never from an
 * observation payload, so a probe cannot promote itself to another region or
 * to the reference by claiming it.
 */

import {
  MINUTE_MS,
  PROFILE_FRESH_MS,
  REFERENCE_FRESH_MS,
  type LocalizedText,
  type ProbeSource,
  type ProfileId,
} from "../../../../../lib/status/contract"
import { base64UrlToBytes, MIN_PROBE_SECRET_BYTES } from "../../../../../lib/status/signing"
import type { Env } from "../env"

export interface ProfileConfig {
  id: ProfileId
  httpCadenceSeconds: number | null
  protocolCadenceSeconds: number | null
}

export interface ProbeRecord {
  id: string
  source: ProbeSource
  label: LocalizedText
  location: LocalizedText | null
  provider: string | null
  enrolledAtMs: number
  retiredAtMs: number | null
  disabled: boolean
  disabledReason: string | null
  registryRevision: number
  profiles: ProfileConfig[]
}

export interface ReferenceEpoch {
  revision: number
  probeId: string
  effectiveMinute: number
}

export interface Registry {
  revision: number
  probes: Map<string, ProbeRecord>
  /** Sorted by effectiveMinute ascending. */
  epochs: ReferenceEpoch[]
}

interface ProbeRow {
  id: string
  source: ProbeSource
  label_json: string
  location_json: string | null
  provider: string | null
  enrolled_at: number
  retired_at: number | null
  disabled: number
  disabled_reason: string | null
  registry_revision: number
}

interface ProfileRow {
  probe_id: string
  profile_id: ProfileId
  http_cadence_seconds: number | null
  protocol_cadence_seconds: number | null
}

export async function loadRegistry(db: D1Database): Promise<Registry> {
  const [revision, probes, profiles, epochs] = await db.batch([
    db.prepare("SELECT value FROM counters WHERE name = 'registry_revision'"),
    db.prepare(
      `SELECT id, source, label_json, location_json, provider, enrolled_at, retired_at, disabled,
              disabled_reason, registry_revision
       FROM probes ORDER BY id`
    ),
    db.prepare(
      "SELECT probe_id, profile_id, http_cadence_seconds, protocol_cadence_seconds FROM probe_profiles"
    ),
    db.prepare(
      "SELECT revision, probe_id, effective_minute FROM reference_epochs ORDER BY effective_minute"
    ),
  ])
  const byProbe = new Map<string, ProfileConfig[]>()
  for (const row of (profiles.results ?? []) as unknown as ProfileRow[]) {
    const list = byProbe.get(row.probe_id) ?? []
    list.push({
      id: row.profile_id,
      httpCadenceSeconds: row.http_cadence_seconds,
      protocolCadenceSeconds: row.protocol_cadence_seconds,
    })
    byProbe.set(row.probe_id, list)
  }
  const probeMap = new Map<string, ProbeRecord>()
  for (const row of (probes.results ?? []) as unknown as ProbeRow[]) {
    probeMap.set(row.id, {
      id: row.id,
      source: row.source,
      label: JSON.parse(row.label_json) as LocalizedText,
      location: row.location_json ? (JSON.parse(row.location_json) as LocalizedText) : null,
      provider: row.provider,
      enrolledAtMs: row.enrolled_at,
      retiredAtMs: row.retired_at,
      disabled: row.disabled === 1,
      disabledReason: row.disabled_reason,
      registryRevision: row.registry_revision,
      profiles: (byProbe.get(row.id) ?? []).sort(
        (left, right) => PROFILE_ORDER.indexOf(left.id) - PROFILE_ORDER.indexOf(right.id)
      ),
    })
  }
  const revisionRow = (revision.results ?? [])[0] as { value: number } | undefined
  return {
    revision: revisionRow?.value ?? 0,
    probes: probeMap,
    epochs: (
      (epochs.results ?? []) as unknown as Array<{
        revision: number
        probe_id: string
        effective_minute: number
      }>
    ).map((row) => ({
      revision: row.revision,
      probeId: row.probe_id,
      effectiveMinute: row.effective_minute,
    })),
  }
}

const PROFILE_ORDER: ProfileId[] = ["native", "web", "ios", "android"]

/** The reference epoch in force for `minute`, or null before the first one. */
export function referenceForMinute(registry: Registry, minute: number): ReferenceEpoch | null {
  let current: ReferenceEpoch | null = null
  for (const epoch of registry.epochs) {
    if (epoch.effectiveMinute <= minute) current = epoch
    else break
  }
  return current
}

/** First expected reference minute (observation start), or null. */
export function observationStartMinute(registry: Registry): number | null {
  return registry.epochs[0]?.effectiveMinute ?? null
}

/** The probe is accepting observations at `atMs`. */
export function probeActive(probe: ProbeRecord, atMs: number): boolean {
  if (probe.disabled) return false
  if (atMs < probe.enrolledAtMs) return false
  return probe.retiredAtMs === null || atMs < probe.retiredAtMs
}

export function profileConfig(probe: ProbeRecord, profileId: ProfileId): ProfileConfig | null {
  return probe.profiles.find((profile) => profile.id === profileId) ?? null
}

/** Whether a check class is due for a profile at a scheduled minute. */
export function cadenceDue(cadenceSeconds: number | null, minute: number): boolean {
  if (cadenceSeconds === null) return false
  const everyMinutes = Math.max(1, Math.round(cadenceSeconds / 60))
  return minute % everyMinutes === 0
}

/** Freshness budget for a cadence: 60 s checks 180 s, slower ones 900 s. */
export function freshnessForCadence(cadenceSeconds: number | null): number {
  if (cadenceSeconds === null) return REFERENCE_FRESH_MS
  return cadenceSeconds <= 60
    ? REFERENCE_FRESH_MS
    : Math.max(PROFILE_FRESH_MS, 3 * cadenceSeconds * 1_000)
}

export function cadenceMinutes(cadenceSeconds: number): number {
  return Math.max(1, Math.round((cadenceSeconds * 1_000) / MINUTE_MS))
}

let cachedSecrets: { raw: string; map: Map<string, Uint8Array> } | null = null

function probeSecrets(env: Env): Map<string, Uint8Array> {
  const raw = env.PROBE_SECRETS ?? ""
  if (cachedSecrets && cachedSecrets.raw === raw) return cachedSecrets.map
  const map = new Map<string, Uint8Array>()
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === "object") {
      for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") continue
        const bytes = base64UrlToBytes(value)
        if (bytes && bytes.byteLength >= MIN_PROBE_SECRET_BYTES) map.set(keyId, bytes)
      }
    }
  }
  cachedSecrets = { raw, map }
  return map
}

/**
 * Resolve a signing key to its probe and secret. The key must be registered,
 * inside its validity window and not revoked, and its secret must be present
 * in `PROBE_SECRETS`; otherwise the request is unauthenticated.
 */
export async function resolveProbeKey(
  env: Env,
  keyId: string,
  nowMs: number
): Promise<{ probeId: string; secret: Uint8Array } | null> {
  const secret = probeSecrets(env).get(keyId)
  if (!secret) return null
  const row = await env.DB.prepare(
    "SELECT probe_id, not_before, not_after, revoked_at FROM probe_keys WHERE key_id = ?"
  )
    .bind(keyId)
    .first<{
      probe_id: string
      not_before: number
      not_after: number | null
      revoked_at: number | null
    }>()
  if (!row) return null
  if (row.revoked_at !== null && row.revoked_at <= nowMs) return null
  if (nowMs < row.not_before) return null
  if (row.not_after !== null && nowMs >= row.not_after) return null
  return { probeId: row.probe_id, secret }
}

export function registeredKeyIds(env: Env): string[] {
  return [...probeSecrets(env).keys()]
}
