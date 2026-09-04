"use client"

/**
 * Skill updates.
 *
 * The pre-existing check compared a freshly downloaded content hash against
 * the stored one, which answers "did the bytes change" but not "should these
 * bytes be trusted". A skill is prompt content the agent executes, so it gets
 * the same gate a plugin does: a catalog revocation check before the update is
 * offered, a provenance label, and explicit consent before it is applied
 * (enforced by the coordinator, which treats every `skill` candidate as
 * consent-required).
 */

import type { UpdateCandidate } from "@cognia/agent-config-types"

import type {
  UpdateAdapter,
  UpdateApplyContext,
  UpdateApplyResult,
  UpdateCheckContext,
} from "../adapter"
import { isRevokedRelease, releaseProvenance } from "../catalog-lookup"

export interface SkillUpdateRow {
  skillId: string
  canonicalId: string
  name: string
  hasUpdate: boolean
  currentHash?: string
  remoteHash?: string
  error?: string
}

export interface SkillAdapterDeps {
  /** Re-check every remotely installed skill. */
  checkAll?: () => Promise<SkillUpdateRow[]>
  /** Re-install one skill from its source. */
  updateOne?: (skillId: string) => Promise<void>
  isSupported?: () => boolean
}

/**
 * A content hash is not a version number, but the Update Center needs one to
 * display and to key skip and defer on. The first 12 hex characters are stable
 * and readable, and they change exactly when the content does.
 */
export function skillVersionLabel(hash: string | undefined): string {
  if (!hash) return "unknown"
  return hash.slice(0, 12)
}

export function createSkillAdapter(deps: SkillAdapterDeps = {}): UpdateAdapter {
  return {
    kind: "skill",
    executor: "skill-runtime",
    isSupported: () => deps.isSupported?.() ?? Boolean(deps.checkAll),

    async check(context: UpdateCheckContext): Promise<UpdateCandidate[]> {
      const rows = (await deps.checkAll?.()) ?? []
      const candidates: UpdateCandidate[] = []
      for (const row of rows) {
        if (!row.hasUpdate || row.error) continue
        const target = skillVersionLabel(row.remoteHash)
        if (isRevokedRelease(context.catalog, "skill", row.canonicalId, target)) continue
        candidates.push({
          assetId: row.skillId,
          kind: "skill",
          executor: "skill-runtime",
          currentVersion: skillVersionLabel(row.currentHash),
          targetVersion: target,
          channel: context.channel,
          criticality: "routine",
          source: "marketplace",
          provenance: releaseProvenance(context.catalog, "skill", row.canonicalId, target),
          // Skill content is what the agent runs. Changing it always needs a
          // look, so the diff is never applied without an explicit yes.
          permissionsExpanded: true,
        })
      }
      return candidates
    },

    async apply(
      candidate: UpdateCandidate,
      context: UpdateApplyContext
    ): Promise<UpdateApplyResult> {
      if (!context.consented) return { state: "awaiting-consent" }
      if (!deps.updateOne) {
        return { state: "failed", failure: { kind: "unsupported", code: "no_skill_installer" } }
      }
      await deps.updateOne(candidate.assetId)
      return { state: "verified" }
    },
  }
}
