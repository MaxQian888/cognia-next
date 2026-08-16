/**
 * Provenance for a generated Skill: which recording it came from, what the user
 * decided during review, and which model wrote it.
 *
 * **The row deliberately does not hold the capture.** The trace and every frame
 * live in the native bundle, addressed by `bundleId`; this row holds the
 * user's *edits over* that capture plus counts. Three consequences, all wanted:
 *
 * - A saved source version is immutable. Re-opening it replays `edits` over an
 *   untouched bundle, so nothing can silently rewrite what was captured, and
 *   "duplicate as a new editable version" is just a second row over the same
 *   bundle.
 * - IndexedDB stays small. A 400-step recording is hundreds of megabytes of
 *   PNG; putting that in Dexie would make the database unopenable long before
 *   it made the feature useful.
 * - Deleting the bundle is a separate, explicit act from deleting the row —
 *   which is what lets the skill-delete dialog ask.
 *
 * **Device-local by construction.** This table appears in none of the
 * backup/sync/export allow-lists, and `skill-recordings.test.ts` asserts that
 * rather than leaving it to be noticed. A recording is a video of the user's
 * screen in all but name; it does not leave the machine it was made on.
 */

import { getDb } from "./schema"
import type { InputVariable } from "@/lib/skills/recording/input-variables"
import type { StepEdits } from "@/lib/skills/recording/step-model"
import type { AssetId, InterruptReason, RecordingId } from "@/lib/skills/recording/types"

export type SkillRecordingStatus =
  "recording" | "captured" | "drafting" | "saved" | "interrupted" | "discarded"

export interface SkillRecordingGeneration {
  provider: string
  /** Model *reference*, never a key or an endpoint. */
  model: string
  locale: string
  redacted: boolean
  generatedAt: number
  /** Ties this draft to the exact payload that produced it. */
  promptHash: string
}

export type SkillRecordingSource =
  { kind: "session"; sessionId: string } | { kind: "run"; runId: string; sessionId?: string }

export interface SkillRecordingRow {
  id: RecordingId
  /** Set once the recording is promoted to a Skill. Indexed for the detail tab. */
  skillId?: string
  status: SkillRecordingStatus
  /** The native bundle. Same value as `id` for a first-generation recording. */
  bundleId: RecordingId
  /** Conversation/run provenance. Content is stored only as a redacted edit timeline. */
  source?: SkillRecordingSource
  /** The user's review edits, replayable over the bundle's captured steps. */
  edits: StepEdits
  inputVariables: InputVariable[]
  /** Frames the user chose to attach, by opaque asset id. */
  selectedAssetIds: AssetId[]
  draft?: {
    name: string
    description: string
    content: string
    tags: string[]
    category: string
    allowedTools: string[]
  }
  generation?: SkillRecordingGeneration
  /** Counts, so the versions list renders without loading the bundle. */
  stepCount: number
  includedCount: number
  bundleBytes: number
  interrupt?: { reason: InterruptReason; from: string; at: number }
  /** Monotonic per skill. Drives "Version 3" in the versions list. */
  versionNumber: number
  createdAt: number
  updatedAt: number
}

function now(): number {
  return Date.now()
}

export interface SkillRecordingDraftInput {
  id: RecordingId
  bundleId?: RecordingId
  skillId?: string
  status?: SkillRecordingStatus
  edits?: StepEdits
  inputVariables?: InputVariable[]
  selectedAssetIds?: AssetId[]
  versionNumber?: number
  source?: SkillRecordingSource
}

export async function createRecording(input: SkillRecordingDraftInput): Promise<SkillRecordingRow> {
  const ts = now()
  const row: SkillRecordingRow = {
    id: input.id,
    bundleId: input.bundleId ?? input.id,
    skillId: input.skillId,
    status: input.status ?? "recording",
    edits: input.edits ?? { bySeq: {}, manual: [] },
    inputVariables: input.inputVariables ?? [],
    selectedAssetIds: input.selectedAssetIds ?? [],
    stepCount: 0,
    includedCount: 0,
    bundleBytes: 0,
    versionNumber: input.versionNumber ?? 1,
    ...(input.source ? { source: input.source } : {}),
    createdAt: ts,
    updatedAt: ts,
  }
  await getDb().skillRecordings.put(row)
  return row
}

export async function getRecording(id: RecordingId): Promise<SkillRecordingRow | undefined> {
  return getDb().skillRecordings.get(id)
}

/** Every version of one skill, newest first. */
export async function listRecordingsForSkill(skillId: string): Promise<SkillRecordingRow[]> {
  const rows = await getDb()
    .skillRecordings.where("[skillId+createdAt]")
    .between([skillId, 0], [skillId, Infinity])
    .toArray()
  return rows.reverse()
}

/** Recordings not yet promoted to a skill — what startup recovery offers. */
export async function listUnfinishedRecordings(): Promise<SkillRecordingRow[]> {
  const rows = await getDb()
    .skillRecordings.where("status")
    .anyOf("recording", "captured", "drafting", "interrupted")
    .toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Merge a patch into a row.
 *
 * `updatedAt` is stamped here rather than by callers so the recovery ordering
 * ("most recently touched first") cannot drift depending on which code path
 * wrote last.
 */
export async function checkpointRecording(
  id: RecordingId,
  patch: Partial<Omit<SkillRecordingRow, "id" | "createdAt">>
): Promise<void> {
  await getDb().skillRecordings.update(id, { ...patch, updatedAt: now() })
}

export async function setRecordingStatus(
  id: RecordingId,
  status: SkillRecordingStatus
): Promise<void> {
  await checkpointRecording(id, { status })
}

export async function linkRecordingToSkill(id: RecordingId, skillId: string): Promise<void> {
  await checkpointRecording(id, { skillId, status: "saved" })
}

/**
 * Delete a row, and optionally the bundle behind it.
 *
 * Two separate decisions on purpose: a user removing a skill may well want to
 * keep the recording to make another one from, and destroying the only copy of
 * a capture is not something to infer.
 */
export async function deleteRecording(
  id: RecordingId,
  options: { deleteBundle?: boolean } = {}
): Promise<void> {
  const row = await getRecording(id)
  await getDb().skillRecordings.delete(id)
  if (!options.deleteBundle || !row) return
  if (row.source) return
  // Other rows may reference the same bundle (a duplicated version). Only the
  // last reference may destroy it.
  const remaining = await getDb()
    .skillRecordings.filter((other) => other.bundleId === row.bundleId)
    .count()
  if (remaining > 0) return
  const { recordDeleteBundle } = await import("@/lib/skills/recording/recorder-client")
  await recordDeleteBundle(row.bundleId).catch(() => undefined)
}

/**
 * Fork an existing version into a new editable one over the same bundle.
 *
 * This is what makes saved source versions immutable: editing never rewrites the
 * row that produced a saved skill, it creates a successor.
 */
export async function duplicateRecording(id: RecordingId): Promise<SkillRecordingRow | null> {
  const source = await getRecording(id)
  if (!source) return null
  const siblings = source.skillId ? await listRecordingsForSkill(source.skillId) : [source]
  const versionNumber = siblings.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1
  const ts = now()
  const row: SkillRecordingRow = {
    ...source,
    id: crypto.randomUUID(),
    // Same bundle: the capture is shared, only the edits over it diverge.
    bundleId: source.bundleId,
    status: "drafting",
    versionNumber,
    createdAt: ts,
    updatedAt: ts,
  }
  await getDb().skillRecordings.put(row)
  return row
}

/** Rows whose bundle has vanished — only good for tidying up. */
export async function listRecordingsMissingBundles(
  presentBundleIds: readonly RecordingId[]
): Promise<SkillRecordingRow[]> {
  const present = new Set(presentBundleIds)
  const rows = await getDb().skillRecordings.toArray()
  return rows.filter((row) => !row.source && row.status !== "saved" && !present.has(row.bundleId))
}

/**
 * How many recorded versions a skill has.
 *
 * A count rather than a list because the detail panel only needs to decide
 * whether to offer the Recordings tab — loading every row (each carrying its
 * edits and draft) on every skill selection would be pure waste.
 */
export async function countRecordingsForSkill(skillId: string): Promise<number> {
  return getDb()
    .skillRecordings.where("[skillId+createdAt]")
    .between([skillId, 0], [skillId, Infinity])
    .count()
}
