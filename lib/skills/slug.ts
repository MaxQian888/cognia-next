import type { Skill } from "@cognia/agent-config-types"

export const MAX_SKILL_SLUG_LENGTH = 64
const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidSkillSlug(value: string | undefined): value is string {
  return Boolean(value && value.length <= MAX_SKILL_SLUG_LENGTH && SKILL_SLUG_PATTERN.test(value))
}

export function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_SLUG_LENGTH)
    .replace(/-+$/g, "")
}

function nativeBasename(path: string | undefined): string | undefined {
  const normalized = path?.replace(/\\/g, "/").replace(/\/+$/g, "")
  return normalized?.split("/").pop()
}

export function deriveSkillSlug(
  skill: Pick<Skill, "id" | "name"> & Partial<Pick<Skill, "slug" | "nativeDirectory">>
): string {
  if (isValidSkillSlug(skill.slug)) return skill.slug
  const native = nativeBasename(skill.nativeDirectory)
  if (isValidSkillSlug(native)) return native
  if (isValidSkillSlug(skill.name)) return skill.name
  const normalized = normalizeSkillSlug(skill.name)
  if (normalized) return normalized
  const suffix = normalizeSkillSlug(skill.id.replace(/^skill[_-]?/i, "")).slice(-12) || "local"
  return `skill-${suffix}`.slice(0, MAX_SKILL_SLUG_LENGTH)
}

/** Migration-only ordering: an already-synced directory is the portable identity of record. */
export function deriveMigratedSkillSlug(
  skill: Pick<Skill, "id" | "name"> & Partial<Pick<Skill, "slug" | "nativeDirectory">>
): string {
  const native = nativeBasename(skill.nativeDirectory)
  return isValidSkillSlug(native) ? native : deriveSkillSlug(skill)
}

export function allocateUniqueSkillSlug(candidate: string, used: Set<string>): string {
  const base = normalizeSkillSlug(candidate) || "skill-local"
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const trimmed = base.slice(0, MAX_SKILL_SLUG_LENGTH - suffix.length).replace(/-+$/g, "")
    const next = `${trimmed}${suffix}`
    if (!used.has(next)) {
      used.add(next)
      return next
    }
  }
}
