// Skill validation — runs on the client before save and as part of the
// AI "fix-errors" prompt. Returns a structured list so the editor can
// highlight individual fields. Mirrors Cognia's validate flow but keeps the
// implementation library-free (no zod) so it tree-shakes nicely.

import type { Skill, SkillResource, SkillValidationError } from "@cognia/agent-config-types"
import { isValidSkillSlug, MAX_SKILL_SLUG_LENGTH } from "./slug"

const MAX_NAME_LEN = 64
const MAX_DESC_LEN = 1024
const MAX_COMPATIBILITY_LEN = 500
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\s_-]*$/

export interface ValidatableSkill {
  name?: string
  slug?: string
  description?: string
  compatibility?: string
  metadata?: Record<string, unknown>
  content?: string
  directoryName?: string
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
      severity: "portability",
    })
  } else {
    if (name.length > MAX_NAME_LEN) {
      errors.push({
        code: "name-too-long",
        field: "name",
        message: `Name must be at most ${MAX_NAME_LEN} characters.`,
        severity: "warning",
      })
    }
    if (!NAME_PATTERN.test(name)) {
      errors.push({
        code: "name-format",
        field: "name",
        message:
          "Name must start with a letter or number and may contain letters, numbers, spaces, underscores, or hyphens.",
        severity: "warning",
      })
    }
  }
  const slug = skill.slug?.trim() ?? ""
  if (!slug) {
    errors.push({
      code: "missing-slug",
      field: "slug",
      message: "A portable skill slug is required.",
      severity: "portability",
    })
  } else if (slug.length > MAX_SKILL_SLUG_LENGTH) {
    errors.push({
      code: "slug-too-long",
      field: "slug",
      message: `Slug must be at most ${MAX_SKILL_SLUG_LENGTH} characters.`,
      severity: "portability",
    })
  } else if (!isValidSkillSlug(slug)) {
    errors.push({
      code: "slug-format",
      field: "slug",
      message: "Slug must use lowercase letters, numbers, and single hyphens only.",
      severity: "portability",
    })
  }
  const description = skill.description?.trim() ?? ""
  if (!description) {
    errors.push({
      code: "missing-description",
      field: "description",
      message: "Description is required for portable skills.",
      severity: "portability",
    })
  } else if (description.length > MAX_DESC_LEN) {
    errors.push({
      code: "description-too-long",
      field: "description",
      message: `Description must be at most ${MAX_DESC_LEN} characters.`,
      severity: "portability",
    })
  }
  if ((skill.compatibility?.length ?? 0) > MAX_COMPATIBILITY_LEN) {
    errors.push({
      code: "compatibility-too-long",
      field: "compatibility",
      message: `Compatibility must be at most ${MAX_COMPATIBILITY_LEN} characters.`,
      severity: "portability",
    })
  }
  if (
    skill.metadata &&
    Object.entries(skill.metadata).some(([key, value]) => !key.trim() || typeof value !== "string")
  ) {
    errors.push({
      code: "metadata-format",
      field: "metadata",
      message: "Metadata keys must be non-empty and all values must be strings.",
      severity: "portability",
    })
  }
  if (skill.directoryName && slug && skill.directoryName !== slug) {
    errors.push({
      code: "directory-name-mismatch",
      field: "slug",
      message: `Bundle directory "${skill.directoryName}" does not match slug "${slug}".`,
      severity: "portability",
    })
  }
  if (!(skill.content ?? "").trim()) {
    errors.push({
      code: "missing-content",
      field: "content",
      message: "Skill content cannot be empty.",
      severity: "runtime",
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
          severity: "runtime",
        })
      }
      const lower = r.path.toLowerCase()
      const prev = seen.get(lower)
      if (prev) {
        errors.push({
          code: "duplicate-resource-path",
          field: r.id,
          message: `Two resources share path "${r.path}".`,
          severity: "runtime",
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

export function hasRuntimeSkillIssues(errors: readonly SkillValidationError[]): boolean {
  return errors.some((error) => error.severity === "runtime")
}
