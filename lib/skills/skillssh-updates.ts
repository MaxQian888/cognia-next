// Explicit update detection for skills installed from skills.sh.
//
// Triggered by the user's "Check for updates" action only — never polled in
// the background. For every installed skill whose canonicalId carries the
// `skillssh:` prefix, the current snapshot is re-downloaded and its
// client-computed content hash compared against the `marketplaceHash` stored
// at install time. Hashes are always client-computed over the file set
// (`computeSkillsShFilesHash`), so install-time and check-time values are
// directly comparable regardless of token presence.

import type { Skill } from "@cognia/agent-config-types"
import type { MarketplaceItem } from "./marketplace-types"
import { fetchSkillsShDetail, parseSkillsShTriple } from "./marketplace-skillssh"
import { computeSkillsShFilesHash } from "./skillssh-install"

export const SKILLSSH_CANONICAL_PREFIX = "skillssh:"

export interface SkillUpdateStatus {
  skillId: string
  canonicalId: string
  hasUpdate: boolean
  currentHash?: string
  remoteHash?: string
  /** Set when the remote check failed for this skill (network, 404, …). */
  error?: string
}

/** True for rows the update checker can act on. */
export function isSkillsShInstall(skill: Skill): boolean {
  return Boolean(
    skill.canonicalId?.startsWith(SKILLSSH_CANONICAL_PREFIX) &&
    parseSkillsShTriple(skill.canonicalId.slice(SKILLSSH_CANONICAL_PREFIX.length))
  )
}

/** Rebuild the MarketplaceItem a skills.sh install came from. */
export function marketplaceItemFromSkill(skill: Skill): MarketplaceItem | null {
  if (!skill.canonicalId?.startsWith(SKILLSSH_CANONICAL_PREFIX)) return null
  const triple = skill.canonicalId.slice(SKILLSSH_CANONICAL_PREFIX.length)
  if (!parseSkillsShTriple(triple)) return null
  return {
    id: skill.canonicalId,
    source: "skillssh",
    sourceId: triple,
    name: skill.name,
    repository: triple.split("/").slice(0, 2).join("/"),
  }
}

/**
 * Compare every skills.sh-installed skill against its current remote
 * snapshot. Skills without a stored hash report `hasUpdate: false` with the
 * fresh remote hash attached so the caller may offer a re-install to start
 * tracking. Per-skill failures land in `error` instead of aborting the run.
 */
export async function checkSkillsShUpdates(skills: Skill[]): Promise<SkillUpdateStatus[]> {
  const candidates = skills.filter(isSkillsShInstall)
  const results: SkillUpdateStatus[] = []
  for (const skill of candidates) {
    const item = marketplaceItemFromSkill(skill)
    if (!item) continue
    const base: SkillUpdateStatus = {
      skillId: skill.id,
      canonicalId: skill.canonicalId as string,
      hasUpdate: false,
      currentHash: skill.marketplaceHash,
    }
    try {
      const detail = await fetchSkillsShDetail(item)
      const remoteHash = await computeSkillsShFilesHash(detail.files)
      results.push({
        ...base,
        remoteHash,
        hasUpdate: Boolean(skill.marketplaceHash) && skill.marketplaceHash !== remoteHash,
      })
    } catch (err) {
      results.push({ ...base, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
