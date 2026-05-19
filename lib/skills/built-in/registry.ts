/**
 * Built-in skill registry (ADR-0026).
 *
 * Implementation lives at `lib/skills/built-in/<family>/<skill>.ts`; each
 * file calls `registerBuiltInSkill()` at module load. The barrel
 * `lib/skills/built-in/index.ts` imports every skill module so the
 * registry is fully populated by the time `build-options.ts` consults it.
 *
 * Pattern lifted verbatim from `lib/ocr/registry.ts` so a future reader
 * recognizes the shape — same `createXRegistry()` factory, same
 * `getSharedXRegistry()` / `__resetSharedXRegistry()` helpers.
 */

import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { BuiltInSkill, BuiltInSkillMutation } from "./types"

export interface BuiltInSkillRegistry {
  register(skill: BuiltInSkill): void
  unregister(id: string): boolean
  has(id: string): boolean
  get(id: string): BuiltInSkill | undefined
  list(): BuiltInSkill[]
  listByFamily(family: string): BuiltInSkill[]
  listByPlatform(platform: PlatformKind): BuiltInSkill[]
  listByMutation(mutation: BuiltInSkillMutation): BuiltInSkill[]
  /**
   * Distinct family identifiers known to the registry, in registration
   * order. Settings UI uses this to drive the family-tab list without
   * hardcoding the catalogue.
   */
  families(): string[]
  clear(): void
}

export function createBuiltInSkillRegistry(): BuiltInSkillRegistry {
  const byId = new Map<string, BuiltInSkill>()
  // Preserve insertion order so families() returns a stable list.
  const familyOrder: string[] = []
  const familySet = new Set<string>()

  const registry: BuiltInSkillRegistry = {
    register(skill) {
      if (byId.has(skill.id)) {
        throw new Error(`BuiltInSkillRegistry: duplicate skill id "${skill.id}"`)
      }
      // Defensive: write/destructive skills MUST ship a hitlSurface so the
      // dispatcher has a confirm card to send. Failing fast at registration
      // time prevents a silent IM disaster where a destructive skill fires
      // without HITL just because the author forgot the surface.
      if (skill.mutation !== "read" && !skill.hitlSurface) {
        throw new Error(
          `BuiltInSkillRegistry: skill "${skill.id}" has mutation="${skill.mutation}" but no hitlSurface`
        )
      }
      byId.set(skill.id, skill)
      if (!familySet.has(skill.family)) {
        familySet.add(skill.family)
        familyOrder.push(skill.family)
      }
    },
    unregister(id) {
      const skill = byId.get(id)
      const ok = byId.delete(id)
      if (ok && skill) {
        // Recompute family list lazily — only drop families with zero remaining skills.
        const stillUsed = Array.from(byId.values()).some((s) => s.family === skill.family)
        if (!stillUsed) {
          familySet.delete(skill.family)
          const idx = familyOrder.indexOf(skill.family)
          if (idx >= 0) familyOrder.splice(idx, 1)
        }
      }
      return ok
    },
    has(id) {
      return byId.has(id)
    },
    get(id) {
      return byId.get(id)
    },
    list() {
      return Array.from(byId.values())
    },
    listByFamily(family) {
      return registry.list().filter((s) => s.family === family)
    },
    listByPlatform(platform) {
      return registry.list().filter((s) => platformAllows(s, platform))
    },
    listByMutation(mutation) {
      return registry.list().filter((s) => s.mutation === mutation)
    },
    families() {
      return familyOrder.slice()
    },
    clear() {
      byId.clear()
      familyOrder.length = 0
      familySet.clear()
    },
  }
  return registry
}

export function platformAllows(skill: BuiltInSkill, platform: PlatformKind): boolean {
  if (skill.platforms === "any") return true
  return skill.platforms.includes(platform)
}

// ---- Shared singleton -----------------------------------------------------

const sharedRegistry = createBuiltInSkillRegistry()

/** Module-load registration entry point. Idempotent per-id (throws on duplicate). */
export function registerBuiltInSkill(skill: BuiltInSkill): void {
  sharedRegistry.register(skill)
}

export function getSharedBuiltInSkillRegistry(): BuiltInSkillRegistry {
  return sharedRegistry
}

/** Test helper — wipes the shared registry between tests that touch it. */
export function __resetSharedBuiltInSkillRegistry(): void {
  sharedRegistry.clear()
}
