/**
 * Skills as Prompt Center resources (ADR-0236 §5.1).
 *
 * A Skill is an on-demand procedure: its body is delivered by the Skill
 * runtime (catalog line, full body, resources) under its own budget, which an
 * edit here never changes. Only the body text is edited, through the Skill
 * owner. A built-in Skill is never edited; its custom copy is made with
 * `duplicateSkill`, which carries the bundle's resources and metadata along.
 */

import { duplicateSkill, getSkill, listSkills, updateSkill } from "@/lib/db/skills"
import {
  parseResourceKey,
  resourceKey,
  type OwnerPromptAdapter,
  type PromptResourceSummary,
} from "../resources"

function idOf(key: string): string {
  const { source, id } = parseResourceKey(key)
  if (source !== "skill" || !id) throw new Error(`not a skill resource: ${key}`)
  return id
}

export const skillPromptAdapter: OwnerPromptAdapter = {
  source: "skill",

  async list() {
    const skills = await listSkills()
    return skills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill): PromptResourceSummary => ({
        key: resourceKey("skill", skill.id),
        source: "skill",
        kind: "procedure",
        operation: "activate-procedure",
        name: skill.name,
        builtIn: Boolean(skill.isBuiltIn),
        modified: false,
        edit: skill.isBuiltIn ? "custom-copy" : "source",
        ownerSection: "skills",
        ...(skill.description ? { detail: skill.description } : {}),
      }))
  },

  async read(key) {
    const skill = await getSkill(idOf(key))
    if (!skill) return undefined
    return {
      key,
      text: skill.content,
      ...(skill.isBuiltIn ? { readOnlyReason: "built-in" as const } : {}),
    }
  },

  async save(key, text) {
    const id = idOf(key)
    const skill = await getSkill(id)
    if (!skill) throw new Error(`Skill ${id} not found`)
    if (skill.isBuiltIn) throw new Error(`Skill ${id} is built in; edit a copy of it instead.`)
    await updateSkill(id, { content: text })
    return (await skillPromptAdapter.read(key, {}))!
  },

  async saveCustom(key, text, _ctx, options = {}) {
    const copy = await duplicateSkill(idOf(key))
    await updateSkill(copy.id, {
      content: text,
      ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    })
    return resourceKey("skill", copy.id)
  },
}
