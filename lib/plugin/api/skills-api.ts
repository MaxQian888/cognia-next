import "@/lib/skills/built-in"

import { resolveBuiltInSkillContext } from "@/lib/skills/built-in/context"
import { runBuiltInSkill } from "@/lib/skills/built-in/dispatcher"
import { getSharedBuiltInSkillRegistry } from "@/lib/skills/built-in/registry"
import type { PluginSkillsAPI } from "@/types/plugin"
import { createApiGuardedAPI } from "./api-permission-gate"

function matchesAllowlist(skillId: string, family: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    if (entry === skillId || entry === family) return true
    if (!entry.endsWith(".*")) return false
    const prefix = entry.slice(0, -2)
    return family === prefix || skillId.startsWith(`${prefix}.`)
  })
}

export function createSkillsAPI(
  pluginId: string,
  allowlist: readonly string[] = []
): PluginSkillsAPI {
  const registry = getSharedBuiltInSkillRegistry()
  const api: PluginSkillsAPI = {
    listBuiltIns: (family) =>
      registry
        .list()
        .filter(
          (skill) =>
            (!family || skill.family === family) &&
            matchesAllowlist(skill.id, skill.family, allowlist)
        )
        .map((skill) => ({
          id: skill.id,
          family: skill.family,
          mutation: skill.mutation,
          label: skill.label,
        })),
    invokeBuiltIn: async (skillId, args, options) => {
      const skill = registry.get(skillId)
      if (!skill || !matchesAllowlist(skill.id, skill.family, allowlist)) {
        throw new Error(`built-in skill is not allowlisted for plugin ${pluginId}: ${skillId}`)
      }
      if (!options.sessionId) throw new Error("skills.invokeBuiltIn requires sessionId")
      if (options.signal?.aborted)
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError")
      const ctx = await resolveBuiltInSkillContext(options.sessionId)
      const result = await runBuiltInSkill(skillId, args, ctx)
      if (options.signal?.aborted)
        throw options.signal.reason ?? new DOMException("Aborted", "AbortError")
      return result
    },
  }

  return createApiGuardedAPI(
    pluginId,
    api,
    { listBuiltIns: "builtin-skills:invoke", invokeBuiltIn: "builtin-skills:invoke" },
    { unguarded: [] }
  )
}
