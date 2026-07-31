// Skill validation — runs on the client before save and as part of the
// AI "fix-errors" prompt. Returns a structured list so the editor can
// highlight individual fields. Mirrors Cognia's validate flow but keeps the
// implementation library-free (no zod) so it tree-shakes nicely.

import type { Skill, SkillResource, SkillValidationError } from "@cognia/agent-config-types"

const MAX_NAME_LEN = 64
const MAX_DESC_LEN = 1024
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\s_-]*$/

export interface ValidatableSkill {
  name?: string
  description?: string
  content?: string
  resources?: Pick<SkillResource, "id" | "path">[]
}

export function validateSkill(skill: ValidatableSkill): SkillValidationError[] {
  const errors: SkillValidationError[] = []
  const name = (skill.name ?? "").trim()
  if (!name) {
    errors.push({
      code: "missing-name",
      field: "name",
      message: "Name is required.",
    })
  } else {
    if (name.length > MAX_NAME_LEN) {
      errors.push({
        code: "name-too-long",
        field: "name",
        message: `Name must be at most ${MAX_NAME_LEN} characters.`,
      })
    }
    if (!NAME_PATTERN.test(name)) {
      errors.push({
        code: "name-format",
        field: "name",
        message:
          "Name must start with a letter or number and may contain letters, numbers, spaces, underscores, or hyphens.",
      })
    }
  }
  if (skill.description && skill.description.length > MAX_DESC_LEN) {
    errors.push({
      code: "description-too-long",
      field: "description",
      message: `Description must be at most ${MAX_DESC_LEN} characters.`,
    })
  }
  if (!(skill.content ?? "").trim()) {
    errors.push({
      code: "missing-content",
      field: "content",
      message: "Skill content cannot be empty.",
    })
  }
  if (skill.resources) {
    const seen = new Map<string, string>()
    for (const r of skill.resources) {
      if (r.path.includes("..")) {
        errors.push({
          code: "resource-path-traversal",
          field: r.id,
          message: `Resource path "${r.path}" contains '..'.`,
        })
      }
      const lower = r.path.toLowerCase()
      const prev = seen.get(lower)
      if (prev) {
        errors.push({
          code: "duplicate-resource-path",
          field: r.id,
          message: `Two resources share path "${r.path}".`,
        })
      } else {
        seen.set(lower, r.id)
      }
    }
  }
  return errors
}

export function isValidSkill(skill: Skill): boolean {
  return validateSkill(skill).length === 0
}
