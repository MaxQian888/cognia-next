"use client"

// UI hook for the explicit skills.sh update check + one-click update.
// `checkAll` scans every skills.sh-installed skill and records which ones
// drifted; `updateOne` re-runs the idempotent marketplace install (content,
// resources, and hash are replaced in place).

import { useCallback, useState } from "react"
import { listSkills } from "@/lib/db/skills"
import { installMarketplaceItem } from "@/lib/skills/marketplace-install"
import {
  checkSkillsShUpdates,
  marketplaceItemFromSkill,
  type SkillUpdateStatus,
} from "@/lib/skills/skillssh-updates"
import type { Skill } from "@/lib/claude/types"

export interface UseSkillUpdate {
  /** skillId → status, populated by the last `checkAll` run. */
  statuses: Record<string, SkillUpdateStatus>
  /** Re-check every skills.sh install; resolves to the update count. */
  checkAll: () => Promise<number>
  /** Re-install one skill from its marketplace source. */
  updateOne: (skill: Skill) => Promise<void>
  checking: boolean
  /** Skill id currently being updated, if any. */
  updatingId: string | null
  hasUpdate: (skillId: string) => boolean
}

export function useSkillUpdate(): UseSkillUpdate {
  const [statuses, setStatuses] = useState<Record<string, SkillUpdateStatus>>({})
  const [checking, setChecking] = useState(false)
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  const checkAll = useCallback(async () => {
    setChecking(true)
    try {
      const skills = await listSkills()
      const results = await checkSkillsShUpdates(skills)
      setStatuses(Object.fromEntries(results.map((r) => [r.skillId, r])))
      return results.filter((r) => r.hasUpdate).length
    } finally {
      setChecking(false)
    }
  }, [])

  const updateOne = useCallback(async (skill: Skill) => {
    const item = marketplaceItemFromSkill(skill)
    if (!item) {
      throw new Error(`Skill "${skill.name}" was not installed from skills.sh`)
    }
    setUpdatingId(skill.id)
    try {
      await installMarketplaceItem(item)
      // The row now matches the remote snapshot — clear its update flag.
      setStatuses((s) => {
        const prev = s[skill.id]
        if (!prev) return s
        return { ...s, [skill.id]: { ...prev, hasUpdate: false, currentHash: prev.remoteHash } }
      })
    } finally {
      setUpdatingId(null)
    }
  }, [])

  const hasUpdate = useCallback(
    (skillId: string) => statuses[skillId]?.hasUpdate === true,
    [statuses]
  )

  return { statuses, checkAll, updateOne, checking, updatingId, hasUpdate }
}
