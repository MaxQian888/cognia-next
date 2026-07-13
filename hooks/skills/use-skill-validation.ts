"use client"

import { useEffect, useRef } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getSkill, updateSkill } from "@/lib/db/skills"
import { listResourcesForSkill } from "@/lib/db/skill-resources"
import { validateSkill } from "@/lib/skills/validate"
import type { SkillValidationError } from "@cognia/agent-config-types"

/**
 * Recompute `Skill.validationErrors` whenever the persisted skill or its
 * resources change, and write the new errors back to Dexie only when they
 * differ from what's already there. The diff check avoids the
 * read-after-write feedback loop where `updatedAt` bumps would otherwise
 * re-trigger the same write.
 */
export function useSkillValidation(skillId: string | undefined): void {
  const lastWrittenRef = useRef<string>("")

  const skill = useLiveQuery(
    () => (skillId ? getSkill(skillId) : Promise.resolve(undefined)),
    [skillId]
  )
  const resources = useLiveQuery(
    () => (skillId ? listResourcesForSkill(skillId) : Promise.resolve([])),
    [skillId]
  )

  useEffect(() => {
    if (!skill || !skillId) return
    const errors = validateSkill({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      resources: (resources ?? []).map((r) => ({ id: r.id, path: r.path })),
    })
    const computedKey = stableKey(errors)
    const persistedKey = stableKey(skill.validationErrors ?? [])
    if (computedKey === persistedKey) return
    if (computedKey === lastWrittenRef.current) return
    lastWrittenRef.current = computedKey
    void updateSkill(skillId, { validationErrors: errors })
  }, [skill, resources, skillId])
}

function stableKey(errors: SkillValidationError[]): string {
  const tuples: Array<[string, string, string]> = errors.map((e) => [
    e.code,
    e.field ?? "",
    e.message,
  ])
  tuples.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  return JSON.stringify(tuples)
}
