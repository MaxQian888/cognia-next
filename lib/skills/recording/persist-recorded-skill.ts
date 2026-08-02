/**
 * Save a recorded skill, all of it or none of it.
 *
 * Four writes have to land together — the skill row, its screenshot resources,
 * the recording row's link back to it, and the recording's status — and a
 * partial success is the worst outcome available: a skill with no images and no
 * provenance, or a recording marked saved that points at nothing.
 *
 * `createSkill()` cannot be reused for this. It does `skills.put()` and then
 * `replaceResourcesForSkill()` as two separate writes with no transaction
 * around them, so a failure between the two leaves exactly the half-saved state
 * this module exists to prevent. It also runs a per-resource collision scan,
 * which with 24 assets inside one transaction is 24 full table scans; the rows
 * are built here and `bulkPut`-ed instead, after one case-insensitive check.
 *
 * The skill is saved **disabled**. A generated procedure that nobody has run is
 * not something to switch on for the user; enabling happens only after they
 * confirm the controlled trial worked.
 */

import type { Skill, SkillResource } from "@cognia/agent-config-types"

import { getDb } from "@/lib/db/schema"
import type { SkillResourceDraft } from "@/lib/db/skill-resources"

import type { GeneratedDraft, GenerationProvenance } from "./state-machine"
import type { InputVariable } from "./input-variables"
import type { StepEdits } from "./step-model"
import type { AssetId, RecordingId } from "./types"

function newSkillId(): string {
  return `sk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function newResourceId(): string {
  return `skres_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface SaveRecordedSkillInput {
  recordingId: RecordingId
  bundleId: RecordingId
  draft: GeneratedDraft
  resources: readonly Omit<SkillResourceDraft, "skillId">[]
  edits: StepEdits
  inputVariables: readonly InputVariable[]
  selectedAssetIds: readonly AssetId[]
  generation: GenerationProvenance | null
  stepCount: number
  includedCount: number
  bundleBytes: number
}

export interface SaveRecordedSkillResult {
  skillId: string
  resourceCount: number
}

/**
 * One transaction over `skills`, `skillResources` and `skillRecordings`.
 *
 * Dexie rolls the whole transaction back if any write throws, so a failure
 * leaves zero skill rows — and the draft and the native bundle both survive, so
 * the user can simply try again.
 */
export async function saveRecordedSkill(
  input: SaveRecordedSkillInput
): Promise<SaveRecordedSkillResult> {
  const db = getDb()
  const now = Date.now()
  const skillId = newSkillId()

  const paths = new Set<string>()
  const resourceRows: SkillResource[] = []
  for (const draft of input.resources) {
    // One collision check up front, over the batch we are about to write —
    // rather than a table scan per resource inside the transaction.
    const key = draft.path.toLowerCase()
    if (paths.has(key)) continue
    paths.add(key)
    resourceRows.push({
      id: newResourceId(),
      skillId,
      kind: draft.kind,
      name: draft.name,
      path: draft.path,
      content: draft.content,
      encoding: draft.encoding,
      mimeType: draft.mimeType,
      size: draft.size ?? draft.content.length,
      inline: draft.inline,
      createdAt: now,
      updatedAt: now,
    } as SkillResource)
  }

  const skill: Skill = {
    id: skillId,
    name: input.draft.name,
    description: input.draft.description,
    content: input.draft.content,
    allowedTools: input.draft.allowedTools,
    tags: input.draft.tags,
    isBuiltIn: false,
    source: "generated",
    // Disabled on purpose. See the module docs.
    status: "disabled",
    category: input.draft.category as Skill["category"],
    usageCount: 0,
    createdAt: now,
    updatedAt: now,
  } as Skill

  await db.transaction("rw", db.skills, db.skillResources, db.skillRecordings, async () => {
    await db.skills.put(skill)
    if (resourceRows.length > 0) await db.skillResources.bulkPut(resourceRows)
    await db.skillRecordings.update(input.recordingId, {
      skillId,
      status: "saved",
      bundleId: input.bundleId,
      edits: input.edits,
      inputVariables: [...input.inputVariables],
      selectedAssetIds: [...input.selectedAssetIds],
      draft: input.draft,
      generation: input.generation ?? undefined,
      stepCount: input.stepCount,
      includedCount: input.includedCount,
      bundleBytes: input.bundleBytes,
      updatedAt: now,
    })
  })

  return { skillId, resourceCount: resourceRows.length }
}
