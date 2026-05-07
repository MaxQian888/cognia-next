/**
 * Build the list of mentionable targets for a team's workspace chat.
 *
 * The list contains:
 *   - Two reserved virtual targets: `@claude` (Anthropic API) and `@codex`
 *     (OpenAI Codex CLI). These are always present so the demo path works
 *     even when no teammate has been added yet.
 *   - Every real teammate in the team, with their configured runtime.
 *
 * Real teammates whose name collides with a reserved name (case-insensitive)
 * are kept under their original id but flagged with `nameCollision: true`
 * so the UI can warn the user. The first match in `parseLeadingMention`
 * still resolves to the virtual entry because virtuals are appended first.
 */

import type { AgentTeammate, TeammateRuntime } from "@/types/agent/agent-team"
import {
  DEFAULT_TEAMMATE_RUNTIME,
  RESERVED_MENTION_NAMES,
  VIRTUAL_AGENT_IDS,
  type VirtualAgentId,
} from "@/types/agent/agent-team"

export type MentionTarget =
  | {
      kind: "teammate"
      id: string
      name: string
      runtime: TeammateRuntime
      teammate: AgentTeammate
      description: string
      nameCollision: boolean
    }
  | {
      kind: "virtual"
      id: VirtualAgentId
      name: string
      runtime: TeammateRuntime
      description: string
    }

const VIRTUAL_TARGETS: ReadonlyArray<Extract<MentionTarget, { kind: "virtual" }>> = [
  {
    kind: "virtual",
    id: VIRTUAL_AGENT_IDS.CLAUDE,
    name: "claude",
    runtime: "claude",
    description: "Anthropic Claude API",
  },
  {
    kind: "virtual",
    id: VIRTUAL_AGENT_IDS.CODEX,
    name: "codex",
    runtime: "codex",
    description: "OpenAI Codex CLI",
  },
]

/**
 * Construct the ordered mentionable list. Virtuals come first so the picker
 * surfaces them prominently and so name collisions resolve to the virtual
 * (whose id is stable and globally meaningful).
 */
export function buildMentionableTargets(teammates: readonly AgentTeammate[]): MentionTarget[] {
  const reserved = new Set<string>(RESERVED_MENTION_NAMES)
  const out: MentionTarget[] = [...VIRTUAL_TARGETS]
  for (const tm of teammates) {
    out.push({
      kind: "teammate",
      id: tm.id,
      name: tm.name,
      runtime: tm.config.runtime ?? DEFAULT_TEAMMATE_RUNTIME,
      teammate: tm,
      description: tm.description,
      nameCollision: reserved.has(tm.name.toLowerCase()),
    })
  }
  return out
}

/** Derived helper for the parser. */
export function targetsToCandidates(
  targets: readonly MentionTarget[]
): Array<{ id: string; name: string }> {
  return targets.map((t) => ({ id: t.id, name: t.name }))
}

/** Lookup by id (matches what the parser returned). */
export function findTargetById(
  targets: readonly MentionTarget[],
  id: string | null
): MentionTarget | null {
  if (!id) return null
  return targets.find((t) => t.id === id) ?? null
}

export { VIRTUAL_AGENT_IDS, RESERVED_MENTION_NAMES, DEFAULT_TEAMMATE_RUNTIME }
