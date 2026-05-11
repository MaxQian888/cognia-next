"use client"

import { useMemo } from "react"
import { validateSkill, type ValidatableSkill } from "@/lib/skills/validate"
import { SkillValidationSection } from "../skill-validation-section"
import type { SkillResource } from "@/lib/claude/types"

interface Props {
  draft: ValidatableSkill
  resources: SkillResource[]
}

export function SkillValidationPanel({ draft, resources }: Props) {
  const errors = useMemo(
    () =>
      validateSkill({
        ...draft,
        resources: resources.map((r) => ({ id: r.id, path: r.path })),
      }),
    [draft, resources]
  )
  return (
    <div className="h-full overflow-y-auto px-3 py-3">
      <SkillValidationSection errors={errors} />
    </div>
  )
}
