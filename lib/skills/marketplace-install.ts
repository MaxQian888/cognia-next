// Install a marketplace item into Dexie. The actual content fetch is
// deferred to the source adapter (`marketplace-registry` or
// `marketplace-skillssh`). After the row lands in IndexedDB the user may
// optionally call `pushAllToNative()` to project it onto disk.

import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import { listSkills, upsertSkillByCanonicalId } from "@/lib/db/skills"
import { fetchRegistrySkillContent } from "./marketplace-registry"
import { fetchSkillsShDetail, fetchSkillsShSkillContent } from "./marketplace-skillssh"
import { computeSkillsShFilesHash, filesToBundleResult } from "./skillssh-install"
import { validateSkill } from "./validate"
import type { FetchSkillContent, MarketplaceItem } from "./marketplace-types"
import type { Skill, SkillStatus, SkillValidationError } from "@/lib/claude/types"

export async function fetchMarketplaceContent(item: MarketplaceItem): Promise<FetchSkillContent> {
  switch (item.source) {
    case "registry":
      return fetchRegistrySkillContent(item)
    case "skillssh":
      return fetchSkillsShSkillContent(item)
    default: {
      const exhaustive: never = item.source
      throw new Error(`Unknown marketplace source: ${exhaustive as string}`)
    }
  }
}

/**
 * Multi-file install for skills.sh items: the snapshot's full file set lands
 * as skill + resources (scripts/references/assets), and a client-computed
 * content hash is stored for the explicit "Check for updates" comparison.
 * Idempotent — re-running replaces content, resources, and hash in place.
 */
async function installSkillsShItem(
  item: MarketplaceItem
): Promise<{ skill: Skill; created: boolean; validationErrors: SkillValidationError[] }> {
  const detail = await fetchSkillsShDetail(item)
  const bundled = filesToBundleResult(detail.files, item.name)
  const marketplaceHash = await computeSkillsShFilesHash(detail.files)
  const validationErrors = bundled.nonFatalValidationErrors
  const status: SkillStatus = validationErrors.length > 0 ? "error" : "enabled"
  const canonicalId = `skillssh:${item.sourceId}`
  const { skill, created } = await upsertSkillByCanonicalId({
    draft: {
      ...bundled.draft,
      description: bundled.draft.description ?? item.description,
      tags: bundled.draft.tags ?? item.tags,
      category: bundled.draft.category ?? item.category,
      author: bundled.draft.author ?? item.author,
      license: bundled.draft.license ?? item.license,
      source: "marketplace",
      marketplaceSkillId: item.sourceId,
      marketplaceHash,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      status,
    },
    canonicalId,
  })
  return { skill, created, validationErrors }
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
  // skills.sh installs carry the full file set (multi-file bundle path).
  if (item.source === "skillssh") {
    return installSkillsShItem(item)
  }
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
  // Delegate the find-by-canonicalId + idempotent upsert to the shared
  // helper so the marketplace, the bundle dialog, and the plugin
  // resolution path all stay in lock-step. Marketplace adapters always
  // supply a canonicalId (it's the dedupe key surfaced in the Browse UI);
  // fall back to a synthesised one if a future adapter ever omits it so
  // the row still lands somewhere stable rather than silently going
  // through the no-canonical path.
  const canonicalId = fetched.canonicalId ?? `${item.source}:${item.sourceId ?? item.id}`
  const { skill, created } = await upsertSkillByCanonicalId({
    draft: {
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
      marketplaceSkillId: fetched.marketplaceSkillId,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
      status,
    },
    canonicalId,
  })
  return { skill, created, validationErrors }
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
