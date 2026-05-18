/**
 * Skills bridge — merge view across Dexie-stored chat skills and plugin
 * skills (the M1·T3 skill-registry overlay). Returns a uniform
 * `ResolvedSkill[]` for `build-options.ts` to render / forward.
 *
 * Two source flavours are handled here:
 *
 * - **Chat skills** (Dexie). Each row carries its own markdown body in
 *   `Skill.content` — we pass them through unchanged, mirroring the
 *   behaviour of `lib/db/skills.ts:renderSkillsSection`.
 *
 * - **Plugin skills** (overlay). The discriminated `source` union has
 *   three shapes — `inline`, `local-folder`, and `anthropic-managed`:
 *   - `inline` and `local-folder` resolve to a markdown body that
 *     appends to the system prompt like a chat skill (handled by
 *     `resolveSkillMarkdown` in `skills-io.ts`).
 *   - `anthropic-managed` does not produce a body. Instead it carries a
 *     `containerSkillId` that gets forwarded to the sidecar as
 *     `container.skill_id` so the Anthropic API attaches the managed
 *     skill at request time. We surface these via
 *     `extractContainerSkillIds` so `build-options.ts` can populate
 *     `SendOptions.containerSkillIds`.
 *
 * Plugin skills are namespaced by id (e.g. `"anthropic.code-review"`) so
 * collisions with chat skill ids are unlikely, but on collision the
 * plugin entry wins — overlay registries are the single source of truth
 * for plugin-contributed runtime entities.
 *
 * Part of the plugin-first Computer Use plan (M4).
 */

import { listEnabledSkillsByIds } from "@/lib/db/skills"
import { getSkill, getSkillEntry } from "@/lib/plugin/registries/skill-registry"
import type { Skill } from "@/lib/claude/types"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { resolveSkillMarkdown } from "./skills-io"

export interface ResolvedSkill {
  id: string
  name: string
  description: string
  source: "chat" | "plugin"
  /** Owning plugin id when `source === "plugin"`. */
  pluginId?: string
  /** For chat skills, the full Skill row. */
  chatSkill?: Skill
  /** For plugin skills, the underlying def. */
  pluginSkill?: PluginSkillDef
  /** Pre-resolved markdown body for local-folder / inline / chat skills. */
  body?: string
  /** Anthropic container.skill_id (only for `anthropic-managed` plugin skills). */
  containerSkillId?: string
  /** Optional version stamp shipped alongside `containerSkillId`. */
  containerSkillVersion?: string
}

/**
 * Resolve a set of skill ids across chat skills (Dexie) and plugin skills
 * (overlay). Plugin skills win on id collision.
 *
 * - `inline` / `local-folder` plugin skills resolve to a `body` string so
 *   callers can fold them into the system prompt alongside chat skills.
 * - `anthropic-managed` plugin skills resolve to a `containerSkillId` only;
 *   `body` is left undefined.
 *
 * Resolution is fail-soft: a single skill that can't be read produces a
 * placeholder body (see `resolveSkillMarkdown`); it never throws, so a
 * Dexie outage or a missing SKILL.md degrades the prompt rather than
 * blocking the send.
 */
export async function resolveSkillsForCharacter(skillIds: string[]): Promise<ResolvedSkill[]> {
  const resolved: ResolvedSkill[] = []
  const remainingChatIds: string[] = []

  for (const id of skillIds) {
    const pluginDef = getSkill(id)
    if (pluginDef) {
      const entry = getSkillEntry(id)
      let body: string | undefined
      let containerSkillId: string | undefined
      let containerSkillVersion: string | undefined
      if (pluginDef.source.kind === "anthropic-managed") {
        containerSkillId = pluginDef.source.containerSkillId
        containerSkillVersion = pluginDef.source.version
      } else {
        body = await resolveSkillMarkdown(pluginDef)
      }
      resolved.push({
        id: pluginDef.id,
        name: pluginDef.name,
        description: pluginDef.description,
        source: "plugin",
        pluginId: entry?.pluginId,
        pluginSkill: pluginDef,
        body,
        containerSkillId,
        containerSkillVersion,
      })
    } else {
      remainingChatIds.push(id)
    }
  }

  if (remainingChatIds.length > 0) {
    const chatSkills = await listEnabledSkillsByIds(remainingChatIds)
    for (const skill of chatSkills) {
      resolved.push({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? "",
        source: "chat",
        chatSkill: skill,
        body: skill.content,
      })
    }
  }

  return resolved
}

/**
 * Anthropic's `container.skill_id` API caps the request at 8 entries. Any
 * resolved set exceeding the cap is truncated FIFO with a `console.warn`
 * so users notice in dev consoles / log capture.
 */
export const MAX_CONTAINER_SKILLS = 8

/**
 * Extract Anthropic `container.skill_id` entries from a resolved set. Used
 * by `build-options.ts` to populate `SendOptions.containerSkillIds`, which
 * the sidecar forwards to the SDK. Truncates to `MAX_CONTAINER_SKILLS`.
 */
export function extractContainerSkillIds(
  resolved: ResolvedSkill[]
): Array<{ skill_id: string; version?: string }> {
  const all = resolved
    .filter((s): s is ResolvedSkill & { containerSkillId: string } => Boolean(s.containerSkillId))
    .map((s) => ({
      skill_id: s.containerSkillId,
      version: s.containerSkillVersion,
    }))
  if (all.length > MAX_CONTAINER_SKILLS) {
    const dropped = all.slice(MAX_CONTAINER_SKILLS).map((s) => s.skill_id)
    console.warn(
      `[skills-bridge] Anthropic accepts at most ${MAX_CONTAINER_SKILLS} container skills; dropping: ${dropped.join(", ")}`
    )
    return all.slice(0, MAX_CONTAINER_SKILLS)
  }
  return all
}

/**
 * Render every resolved skill that carries a `body` (chat skills, inline
 * plugin skills, local-folder plugin skills) into a single
 * `appendSystemPrompt`-compatible markdown section. Anthropic-managed
 * plugin skills are skipped — they flow via `container.skill_id`.
 */
export function renderResolvedSkillsSection(resolved: ResolvedSkill[]): string {
  const renderable = resolved.filter((s) => s.body && s.body.trim().length > 0)
  if (renderable.length === 0) return ""
  return renderable.map((s) => `## Skill: ${s.name}\n\n${s.body!.trim()}`).join("\n\n---\n\n")
}
