/**
 * CRUD layer for the `twinProfile` Dexie table.
 *
 * Single-row-per-twin (1:1 with `twinId`); the `id` field is set equal to
 * `twinId` to keep lookups O(1). The distill pipeline (Phase 5) writes here
 * incrementally — `StyleAgent` appends to `styleSamples`, `PlaybookAgent`
 * appends to `playbooks`, etc. The runtime (Phase 6) reads the whole row
 * once per send-time turn and uses it to assemble the system prompt.
 */

import type {
  DecisionRecord,
  Playbook,
  ProfileEntity,
  StyleSample,
  TwinProfile,
} from "@/types/twin"
import { getDb } from "./schema"

function emptyProfile(twinId: string): TwinProfile {
  return {
    id: twinId,
    twinId,
    styleSamples: [],
    playbooks: [],
    entities: [],
    decisions: [],
    voiceSummary: "",
    updatedAt: Date.now(),
  }
}

export async function getTwinProfile(twinId: string): Promise<TwinProfile | undefined> {
  return getDb().twinProfile.get(twinId)
}

/**
 * Read-or-create. The distill pipeline calls this on first run for a twin so
 * downstream agents can append to a guaranteed-existing row.
 */
export async function ensureTwinProfile(twinId: string): Promise<TwinProfile> {
  const db = getDb()
  const existing = await db.twinProfile.get(twinId)
  if (existing) return existing
  const row = emptyProfile(twinId)
  await db.twinProfile.add(row)
  return row
}

export async function setTwinProfile(profile: TwinProfile): Promise<void> {
  const row: TwinProfile = { ...profile, updatedAt: Date.now() }
  await getDb().twinProfile.put(row)
}

export async function setVoiceSummary(twinId: string, voiceSummary: string): Promise<void> {
  const profile = await ensureTwinProfile(twinId)
  await setTwinProfile({ ...profile, voiceSummary })
}

export interface AppendStyleSamplesOptions {
  /**
   * Optional async function that maps a sample's `summary` to an embedding.
   * When provided, every sample's `embedding` is populated before persistence.
   * Failures are swallowed per-sample (the field stays `undefined` and the
   * runtime lazy-backfills next time).
   */
  embeddingFn?: (summary: string) => Promise<number[]>
}

export async function appendStyleSamples(
  twinId: string,
  samples: StyleSample[],
  options: AppendStyleSamplesOptions = {}
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let enriched = samples
  if (options.embeddingFn) {
    const fn = options.embeddingFn
    enriched = await Promise.all(
      samples.map(async (s) => {
        try {
          return { ...s, embedding: await fn(s.summary) }
        } catch {
          return s
        }
      })
    )
  }
  const merged: TwinProfile = {
    ...profile,
    styleSamples: [...profile.styleSamples, ...enriched],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

/**
 * Backfill `StyleSample.embedding` for any sample that doesn't yet have
 * one. Distill writes embeddings inline starting in M4, but profiles
 * distilled earlier (or with `embeddingFn` omitted) carry samples whose
 * `embedding` field is absent — the runtime degrades to a token-overlap
 * heuristic in that case. Calling this once over the profile lifts every
 * eligible sample into the cosine-similarity fast path.
 *
 * Failures are swallowed per-sample (the field stays `undefined` and the
 * next backfill attempt can retry).
 */
export async function backfillStyleSampleEmbeddings(
  twinId: string,
  embeddingFn: (summary: string) => Promise<number[]>
): Promise<{ filled: number; skipped: number; failed: number }> {
  const profile = await ensureTwinProfile(twinId)
  let filled = 0
  let skipped = 0
  let failed = 0
  const next: StyleSample[] = []
  for (const sample of profile.styleSamples) {
    if (Array.isArray(sample.embedding) && sample.embedding.length > 0) {
      next.push(sample)
      skipped += 1
      continue
    }
    try {
      const embedding = await embeddingFn(sample.summary)
      next.push({ ...sample, embedding })
      filled += 1
    } catch {
      next.push(sample)
      failed += 1
    }
  }
  if (filled === 0) return { filled, skipped, failed }
  const merged: TwinProfile = {
    ...profile,
    styleSamples: next,
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return { filled, skipped, failed }
}

export async function appendPlaybooks(twinId: string, playbooks: Playbook[]): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const merged: TwinProfile = {
    ...profile,
    playbooks: [...profile.playbooks, ...playbooks],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function upsertEntities(
  twinId: string,
  entities: ProfileEntity[]
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const byName = new Map(profile.entities.map((e) => [e.name.toLowerCase(), e]))
  for (const entity of entities) {
    const key = entity.name.toLowerCase()
    const existing = byName.get(key)
    // A pinned existing entity is preserved across re-distill — distill output
    // for the same name is dropped so user edits / manual additions survive.
    if (existing?.pinned) continue
    byName.set(key, entity)
  }
  const merged: TwinProfile = {
    ...profile,
    entities: Array.from(byName.values()),
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function appendDecisions(
  twinId: string,
  decisions: DecisionRecord[]
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const merged: TwinProfile = {
    ...profile,
    decisions: [...profile.decisions, ...decisions],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function deleteTwinProfile(twinId: string): Promise<void> {
  await getDb().twinProfile.delete(twinId)
}

/** Wipe the profile back to its empty shape — used by manual "re-distill". */
export async function resetTwinProfile(twinId: string): Promise<TwinProfile> {
  const row = emptyProfile(twinId)
  await getDb().twinProfile.put(row)
  return row
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-item CRUD + pin helpers — back the Persona browser (ADR-0003 follow-up).
// All follow the existing load-modify-put pattern. ProfileEntity keys by
// `name` (case-insensitive) so updates can rename the entity in place; the
// other three kinds key by their stable `id`.
// ─────────────────────────────────────────────────────────────────────────────

function lowerEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export async function addEntity(twinId: string, entity: ProfileEntity): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const remaining = profile.entities.filter((e) => !lowerEq(e.name, entity.name))
  const merged: TwinProfile = {
    ...profile,
    entities: [...remaining, entity],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function updateEntity(
  twinId: string,
  originalName: string,
  next: ProfileEntity
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let replaced = false
  const entities = profile.entities.map((e) => {
    if (lowerEq(e.name, originalName)) {
      replaced = true
      return next
    }
    return e
  })
  if (!replaced) entities.push(next)
  const merged: TwinProfile = { ...profile, entities, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function removeEntity(twinId: string, name: string): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const entities = profile.entities.filter((e) => !lowerEq(e.name, name))
  if (entities.length === profile.entities.length) return profile
  const merged: TwinProfile = { ...profile, entities, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function setEntityPinned(
  twinId: string,
  name: string,
  pinned: boolean
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let changed = false
  const entities = profile.entities.map((e) => {
    if (lowerEq(e.name, name) && (e.pinned ?? false) !== pinned) {
      changed = true
      return { ...e, pinned }
    }
    return e
  })
  if (!changed) return profile
  const merged: TwinProfile = { ...profile, entities, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function addPlaybook(twinId: string, playbook: Playbook): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const remaining = profile.playbooks.filter((p) => p.id !== playbook.id)
  const merged: TwinProfile = {
    ...profile,
    playbooks: [...remaining, playbook],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function updatePlaybook(
  twinId: string,
  playbookId: string,
  next: Playbook
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let replaced = false
  const playbooks = profile.playbooks.map((p) => {
    if (p.id === playbookId) {
      replaced = true
      return next
    }
    return p
  })
  if (!replaced) playbooks.push(next)
  const merged: TwinProfile = { ...profile, playbooks, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function removePlaybook(twinId: string, playbookId: string): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const playbooks = profile.playbooks.filter((p) => p.id !== playbookId)
  if (playbooks.length === profile.playbooks.length) return profile
  const merged: TwinProfile = { ...profile, playbooks, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function setPlaybookPinned(
  twinId: string,
  playbookId: string,
  pinned: boolean
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let changed = false
  const playbooks = profile.playbooks.map((p) => {
    if (p.id === playbookId && (p.pinned ?? false) !== pinned) {
      changed = true
      return { ...p, pinned }
    }
    return p
  })
  if (!changed) return profile
  const merged: TwinProfile = { ...profile, playbooks, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function addStyleSample(twinId: string, sample: StyleSample): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const remaining = profile.styleSamples.filter((s) => s.id !== sample.id)
  const merged: TwinProfile = {
    ...profile,
    styleSamples: [...remaining, sample],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function updateStyleSample(
  twinId: string,
  sampleId: string,
  next: StyleSample
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let replaced = false
  const styleSamples = profile.styleSamples.map((s) => {
    if (s.id === sampleId) {
      replaced = true
      return next
    }
    return s
  })
  if (!replaced) styleSamples.push(next)
  const merged: TwinProfile = { ...profile, styleSamples, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function removeStyleSample(twinId: string, sampleId: string): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const styleSamples = profile.styleSamples.filter((s) => s.id !== sampleId)
  if (styleSamples.length === profile.styleSamples.length) return profile
  const merged: TwinProfile = { ...profile, styleSamples, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function setStyleSamplePinned(
  twinId: string,
  sampleId: string,
  pinned: boolean
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let changed = false
  const styleSamples = profile.styleSamples.map((s) => {
    if (s.id === sampleId && (s.pinned ?? false) !== pinned) {
      changed = true
      return { ...s, pinned }
    }
    return s
  })
  if (!changed) return profile
  const merged: TwinProfile = { ...profile, styleSamples, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}
