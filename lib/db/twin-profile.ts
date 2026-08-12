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
import { recordTwinDecisionsGovernance } from "@/lib/governance/producers/twin"

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

async function enrichSamplesWithEmbeddings(
  samples: StyleSample[],
  embeddingFn?: (summary: string) => Promise<number[]>
): Promise<StyleSample[]> {
  if (!embeddingFn) return samples
  return Promise.all(
    samples.map(async (s) => {
      try {
        return { ...s, embedding: await embeddingFn(s.summary) }
      } catch {
        return s
      }
    })
  )
}

/** Stable content key for de-duping style samples across re-distill runs. */
function styleSampleKey(s: StyleSample): string {
  return `${s.sourceChunkId}::${s.summary.trim().toLowerCase()}`
}

export async function appendStyleSamples(
  twinId: string,
  samples: StyleSample[],
  options: AppendStyleSamplesOptions = {}
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const enriched = await enrichSamplesWithEmbeddings(samples, options.embeddingFn)
  const merged: TwinProfile = {
    ...profile,
    styleSamples: [...profile.styleSamples, ...enriched],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

/**
 * Re-distill–safe style-sample writer. Unlike {@link appendStyleSamples} this
 * de-dupes by content key (`sourceChunkId` + normalized `summary`) so repeated
 * distills don't multiply the array, and it preserves any existing **pinned**
 * sample (the incoming distill sample with the same content is dropped so the
 * user's pin / edit survives). Mirrors {@link upsertEntities}.
 */
export async function upsertStyleSamples(
  twinId: string,
  samples: StyleSample[],
  options: AppendStyleSamplesOptions = {}
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const enriched = await enrichSamplesWithEmbeddings(samples, options.embeddingFn)
  const byKey = new Map(profile.styleSamples.map((s) => [styleSampleKey(s), s]))
  for (const sample of enriched) {
    const key = styleSampleKey(sample)
    if (byKey.get(key)?.pinned) continue
    byKey.set(key, sample)
  }
  const merged: TwinProfile = {
    ...profile,
    styleSamples: Array.from(byKey.values()),
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
    // An empty/whitespace summary can't be embedded meaningfully and would
    // fail on every backfill pass — skip it so it can't spin forever. The
    // per-sample few-shot scorer just leaves it on the token-overlap path.
    if (!sample.summary.trim()) {
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

/** Stable content key for de-duping playbooks across re-distill runs. */
function playbookKey(p: Playbook): string {
  return `${p.title.trim().toLowerCase()}::${p.trigger.trim().toLowerCase()}`
}

/**
 * Re-distill–safe playbook writer. De-dupes by content key (normalized
 * `title` + `trigger`) and preserves existing **pinned** playbooks, so repeated
 * distills refresh content without multiplying rows or clobbering user pins.
 * Mirrors {@link upsertEntities}.
 */
export async function upsertPlaybooks(twinId: string, playbooks: Playbook[]): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const byKey = new Map(profile.playbooks.map((p) => [playbookKey(p), p]))
  for (const pb of playbooks) {
    const key = playbookKey(pb)
    if (byKey.get(key)?.pinned) continue
    byKey.set(key, pb)
  }
  const merged: TwinProfile = {
    ...profile,
    playbooks: Array.from(byKey.values()),
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
  // Key by name AND role: a person and a project sharing a name are distinct
  // entities and must not overwrite each other (the previous name-only key
  // silently dropped one of them).
  const keyOf = (e: ProfileEntity): string => `${e.name.toLowerCase()}::${e.role}`
  const byName = new Map(profile.entities.map((e) => [keyOf(e), e]))
  for (const entity of entities) {
    const key = keyOf(entity)
    const existing = byName.get(key)
    // A pinned existing entity is preserved across re-distill — distill output
    // for the same name+role is dropped so user edits / manual additions survive.
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
  const updatedAt = Date.now()
  const merged: TwinProfile = {
    ...profile,
    decisions: [...profile.decisions, ...decisions],
    updatedAt,
  }
  await getDb().twinProfile.put(merged)
  await recordTwinDecisionsGovernance({
    twinId,
    decisions: merged.decisions,
    recordedAt: updatedAt,
  }).catch(() => undefined)
  return merged
}

function decisionKey(decision: Pick<DecisionRecord, "context" | "choice">): string {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ")
  return `${normalize(decision.context)}::${normalize(decision.choice)}`
}

/** Re-distill-safe Decision writer keyed by normalized context + choice. */
export async function upsertDecisions(
  twinId: string,
  decisions: DecisionRecord[]
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const byKey = new Map(profile.decisions.map((decision) => [decisionKey(decision), decision]))
  for (const decision of decisions) {
    const key = decisionKey(decision)
    const existing = byKey.get(key)
    if (existing?.pinned) continue
    byKey.set(
      key,
      existing
        ? {
            ...decision,
            id: existing.id,
            sourceChunkIds: [...new Set([...existing.sourceChunkIds, ...decision.sourceChunkIds])],
          }
        : decision
    )
  }
  const updatedAt = Date.now()
  const merged: TwinProfile = {
    ...profile,
    decisions: Array.from(byKey.values()),
    updatedAt,
  }
  await getDb().twinProfile.put(merged)
  await recordTwinDecisionsGovernance({
    twinId,
    decisions: merged.decisions,
    recordedAt: updatedAt,
  }).catch(() => undefined)
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

export async function addDecision(twinId: string, decision: DecisionRecord): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const remaining = profile.decisions.filter((item) => item.id !== decision.id)
  const merged: TwinProfile = {
    ...profile,
    decisions: [...remaining, decision],
    updatedAt: Date.now(),
  }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function updateDecision(
  twinId: string,
  decisionId: string,
  next: DecisionRecord
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let replaced = false
  const decisions = profile.decisions.map((decision) => {
    if (decision.id !== decisionId) return decision
    replaced = true
    return next
  })
  if (!replaced) decisions.push(next)
  const merged: TwinProfile = { ...profile, decisions, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function removeDecision(twinId: string, decisionId: string): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  const decisions = profile.decisions.filter((decision) => decision.id !== decisionId)
  if (decisions.length === profile.decisions.length) return profile
  const merged: TwinProfile = { ...profile, decisions, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}

export async function setDecisionPinned(
  twinId: string,
  decisionId: string,
  pinned: boolean
): Promise<TwinProfile> {
  const profile = await ensureTwinProfile(twinId)
  let changed = false
  const decisions = profile.decisions.map((decision) => {
    if (decision.id === decisionId && (decision.pinned ?? false) !== pinned) {
      changed = true
      return { ...decision, pinned }
    }
    return decision
  })
  if (!changed) return profile
  const merged: TwinProfile = { ...profile, decisions, updatedAt: Date.now() }
  await getDb().twinProfile.put(merged)
  return merged
}
