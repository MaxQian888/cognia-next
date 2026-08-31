// CRUD for the per-skill resource bundle (scripts / references / assets).
// Resources live in their own Dexie table keyed by id, with a compound index
// on [skillId+path] so the resource manager can detect path collisions before
// writing.

import type { SkillResource, SkillResourceKind } from "@cognia/agent-config-types"
import { getDb } from "./schema"
import { loadBuiltInResourceOverlay } from "@/lib/skills/built-in-resource-overlay"

function newId() {
  return "skres_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type SkillResourceDraft = Pick<
  SkillResource,
  "skillId" | "kind" | "name" | "path" | "content"
> &
  Partial<Pick<SkillResource, "encoding" | "mimeType" | "size" | "inline">>

export async function listResourcesForSkill(skillId: string): Promise<SkillResource[]> {
  const builtIn = await loadBuiltInResourceOverlay(skillId)
  if (builtIn) return builtIn
  return getDb().skillResources.where("skillId").equals(skillId).sortBy("path")
}

export async function listResourcesByKind(
  skillId: string,
  kind: SkillResourceKind
): Promise<SkillResource[]> {
  return getDb().skillResources.where("[skillId+kind]").equals([skillId, kind]).toArray()
}

export async function getResource(id: string): Promise<SkillResource | undefined> {
  return getDb().skillResources.get(id)
}

export async function createResource(draft: SkillResourceDraft): Promise<SkillResource> {
  const now = Date.now()
  // Disallow path traversal up-front; the validator will catch this too but
  // a defensive check keeps obviously-bad inputs out of IndexedDB.
  if (draft.path.includes("..")) {
    throw new Error("Resource path must not contain '..'.")
  }
  // Enforce per-skill path uniqueness CASE-INSENSITIVELY (Dexie's compound
  // index does NOT enforce uniqueness; check explicitly). Matches the
  // validator at `lib/skills/validate.ts:69` so `Scripts/foo.sh` and
  // `scripts/foo.sh` can never coexist regardless of which gate runs first.
  const draftLower = draft.path.toLowerCase()
  const siblings = await getDb().skillResources.where("skillId").equals(draft.skillId).toArray()
  if (siblings.some((r) => r.path.toLowerCase() === draftLower)) {
    throw new Error(`A resource at "${draft.path}" already exists for this skill.`)
  }
  const size =
    draft.size ??
    (draft.encoding === "base64" ? draft.content.length : new Blob([draft.content]).size)
  const row: SkillResource = {
    id: newId(),
    skillId: draft.skillId,
    kind: draft.kind,
    name: draft.name.trim() || draft.path.split("/").pop() || "untitled",
    path: draft.path,
    content: draft.content,
    encoding: draft.encoding ?? "utf-8",
    mimeType: draft.mimeType,
    size,
    inline: draft.inline,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().skillResources.put(row)
  return row
}

export async function updateResource(
  id: string,
  patch: Partial<Omit<SkillResource, "id" | "skillId" | "createdAt">>
): Promise<void> {
  if (patch.path?.includes("..")) {
    throw new Error("Resource path must not contain '..'.")
  }
  // When the path changes, enforce the same case-insensitive uniqueness
  // gate as `createResource` so an "edit" can't bypass dedup.
  if (patch.path !== undefined) {
    const target = await getDb().skillResources.get(id)
    if (target) {
      const patchLower = patch.path.toLowerCase()
      if (target.path.toLowerCase() !== patchLower) {
        const siblings = await getDb()
          .skillResources.where("skillId")
          .equals(target.skillId)
          .toArray()
        if (siblings.some((r) => r.id !== id && r.path.toLowerCase() === patchLower)) {
          throw new Error(`A resource at "${patch.path}" already exists for this skill.`)
        }
      }
    }
  }
  await getDb().skillResources.update(id, {
    ...patch,
    updatedAt: Date.now(),
  })
}

export async function deleteResource(id: string): Promise<void> {
  await getDb().skillResources.delete(id)
}

export async function deleteResourcesForSkill(skillId: string): Promise<void> {
  await getDb().skillResources.where("skillId").equals(skillId).delete()
}

/**
 * Replace the resource set for a skill in-place. Used by sync flows that
 * rebuild the on-disk view from the IndexedDB row. Returns the freshly-stored
 * rows so callers can update fingerprints without an extra read.
 */
export async function replaceResourcesForSkill(
  skillId: string,
  drafts: Array<Omit<SkillResourceDraft, "skillId"> | SkillResourceDraft>
): Promise<SkillResource[]> {
  await deleteResourcesForSkill(skillId)
  const created: SkillResource[] = []
  for (const draft of drafts) {
    // Skill id always comes from the caller; if a fully-shaped draft was
    // passed in, the `skillId` on the draft is overridden so a resource
    // can't accidentally end up under a different skill.
    created.push(await createResource({ ...draft, skillId }))
  }
  return created
}
