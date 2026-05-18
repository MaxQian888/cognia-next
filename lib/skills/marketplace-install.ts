// Install a marketplace item into Dexie. The actual SKILL.md fetch is
// deferred to the source adapter (`marketplace-registry` or
// `marketplace-skillsmp`). After the row lands in IndexedDB the user may
// optionally call `pushAllToNative()` to project it onto disk.

import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import { createSkill, listSkills, updateSkill } from "@/lib/db/skills"
import { fetchRegistrySkillContent } from "./marketplace-registry"
import { fetchSkillsMpSkillContent } from "./marketplace-skillsmp"
import { validateSkill } from "./validate"
import type { FetchSkillContent, MarketplaceItem } from "./marketplace-types"
import type { Skill, SkillStatus, SkillValidationError } from "@/lib/claude/types"

export async function fetchMarketplaceContent(item: MarketplaceItem): Promise<FetchSkillContent> {
  switch (item.source) {
    case "registry":
      return fetchRegistrySkillContent(item)
    case "skillsmp":
      return fetchSkillsMpSkillContent(item)
    default: {
      const exhaustive: never = item.source
      throw new Error(`Unknown marketplace source: ${exhaustive as string}`)
    }
  }
}

/**
 * Install or update a marketplace skill. Idempotent: if the canonicalId is
 * already present locally, the existing row is updated in place.
 *
 * Validation: the parsed draft is run through `validateSkill` and any
 * issues land on the row's `validationErrors` field. Hard failures
 * (missing name, empty content) cause the install to refuse — those
 * already throw at parse time, but we double-check on the validator path
 * so any silent skip is impossible.
 */
export async function installMarketplaceItem(
  item: MarketplaceItem
): Promise<{ skill: Skill; created: boolean; validationErrors: SkillValidationError[] }> {
  const fetched = await fetchMarketplaceContent(item)
  const { draft } = parseSkillMarkdown(fetched.content, {
    fallbackName: item.name,
  })
  const validationErrors = validateSkill({
    name: draft.name,
    description: draft.description ?? item.description,
    content: draft.content,
  })
  // Promote unrecoverable validation errors to a thrown error so the
  // marketplace UI surfaces them instead of silently storing a bad row.
  const fatalCodes = new Set(["missing-name", "missing-content"])
  const fatal = validationErrors.find((e) => fatalCodes.has(e.code))
  if (fatal) {
    throw new Error(`Marketplace install refused: ${fatal.message}`)
  }
  // Non-fatal errors (long name, format issues) are stored on the row so
  // the editor flags them in-place. The row goes in with status "error"
  // to keep it out of the send-time enabled-skills query until the user
  // fixes it.
  const status: SkillStatus = validationErrors.length > 0 ? "error" : "enabled"
  const existing = (await listSkills()).find((s) => s.canonicalId === fetched.canonicalId)
  if (existing) {
    await updateSkill(existing.id, {
      name: draft.name,
      description: draft.description ?? item.description,
      content: draft.content,
      allowedTools: draft.allowedTools,
      tags: draft.tags ?? item.tags,
      category: draft.category ?? item.category,
      version: draft.version,
      author: draft.author ?? item.author,
      license: draft.license ?? item.license,
      source: "marketplace",
      canonicalId: fetched.canonicalId,
      marketplaceSkillId: fetched.marketplaceSkillId,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      status,
    })
    const refreshed = (await listSkills()).find((s) => s.id === existing.id)
    return { skill: refreshed ?? existing, created: false, validationErrors }
  }
  const created = await createSkill({
    name: draft.name,
    description: draft.description ?? item.description,
    content: draft.content,
    allowedTools: draft.allowedTools,
    tags: draft.tags ?? item.tags,
    category: draft.category ?? item.category,
    version: draft.version,
    author: draft.author ?? item.author,
    license: draft.license ?? item.license,
    source: "marketplace",
    canonicalId: fetched.canonicalId,
    marketplaceSkillId: fetched.marketplaceSkillId,
    validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
    status,
  })
  return { skill: created, created: true, validationErrors }
}

/**
 * Mark this marketplace item as not-yet-installed (delete the matching
 * Dexie row). Built-ins never end up here — they don't carry canonicalId
 * tags, so the find returns nothing.
 */
export async function uninstallMarketplaceItem(item: MarketplaceItem): Promise<boolean> {
  const all = await listSkills()
  const match = all.find((s) => s.canonicalId === `${item.source}:${item.sourceId}`)
  if (!match) return false
  // Re-use the standard delete which cascades resources.
  const { deleteSkill } = await import("@/lib/db/skills")
  await deleteSkill(match.id)
  return true
}

/** Returns the set of canonicalIds currently installed locally. */
export async function listInstalledCanonicalIds(): Promise<Set<string>> {
  const all = await listSkills()
  const out = new Set<string>()
  for (const s of all) {
    if (s.canonicalId) out.add(s.canonicalId)
  }
  return out
}
