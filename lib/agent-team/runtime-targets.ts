/**
 * The `@` route targets of the general chat composer.
 *
 * A turn that STARTS with `@<handle>` runs on the runtime that handle names
 * (see `lib/chat/turn-route/`). The list contains:
 *   - Two reserved virtual targets: `@claude` (Cognia's own builtin lane) and
 *     `@codex` (a configured Codex agent). Always present, and always first, so
 *     they win every handle collision.
 *   - One entry per member of the Squads this conversation can see, each with
 *     the runtime its teammate config names.
 *
 * Every target carries a `handle`: the exact no-whitespace token the picker
 * inserts and the send path matches back, case-insensitively. Handles are
 * unique across the list AND against the subagent handles the same `@` panel
 * offers, because one token must never mean two things:
 *   1. the reserved names win outright;
 *   2. a member prefers its slugified name;
 *   3. on a collision (a reserved name, a subagent, another member) it becomes
 *      `<squad-slug>-<member-slug>`;
 *   4. and if even that collides, the teammate id, which is unique by
 *      construction.
 */

import type { AgentTeam, AgentTeammate, TeammateRuntime } from "@/types/agent/agent-team"
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
      /** The member's display name, as the Squad spells it. */
      name: string
      /** Token inserted as `@<handle>` and matched back at send time. */
      handle: string
      /** The Squad this member belongs to. */
      squadId: string
      squadName: string
      runtime: TeammateRuntime
      teammate: AgentTeammate
      description: string
      /**
       * The member's name is one of the reserved runtime names, so the
       * preferred handle went to the virtual target instead.
       */
      nameCollision: boolean
    }
  | {
      kind: "virtual"
      id: VirtualAgentId
      name: string
      handle: string
      runtime: TeammateRuntime
      /**
       * Search text only. The picker row renders a translated line naming the
       * engine that will actually answer, never this string.
       */
      description: string
    }

export type VirtualMentionTarget = Extract<MentionTarget, { kind: "virtual" }>
export type TeammateMentionTarget = Extract<MentionTarget, { kind: "teammate" }>

const VIRTUAL_TARGETS: ReadonlyArray<VirtualMentionTarget> = [
  {
    kind: "virtual",
    id: VIRTUAL_AGENT_IDS.CLAUDE,
    name: "claude",
    handle: "claude",
    runtime: "claude",
    description: "Cognia builtin agent Claude",
  },
  {
    kind: "virtual",
    id: VIRTUAL_AGENT_IDS.CODEX,
    name: "codex",
    handle: "codex",
    runtime: "codex",
    description: "OpenAI Codex CLI",
  },
]

/** One Squad and the members it offers, in the order they should be listed. */
export interface RouteTargetSquad {
  team: Pick<AgentTeam, "id" | "name">
  teammates: readonly AgentTeammate[]
}

export interface BuildRouteTargetsInput {
  /** Squads in display order — the conversation's bound Squad first. */
  squads: readonly RouteTargetSquad[]
  /**
   * Handles already taken by something else in the same `@` panel (the
   * subagents). A member never shadows one of them.
   */
  reservedHandles?: Iterable<string>
}

/**
 * A handle for a display name. Unicode-aware, unlike the subagent slug: a
 * Squad member called 研究员 must keep a readable handle rather than collapse
 * into a placeholder that collides with every other CJK name.
 */
export function routeHandleSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * The ordered route-target list: the two virtual runtimes, then every member of
 * every Squad in `squads`.
 */
export function buildRouteTargets({
  squads,
  reservedHandles = [],
}: BuildRouteTargetsInput): MentionTarget[] {
  const reservedNames = new Set<string>(RESERVED_MENTION_NAMES)
  const taken = new Set<string>([...reservedNames])
  for (const handle of reservedHandles) taken.add(handle.toLowerCase())

  const members = squads.flatMap(({ team, teammates }) =>
    teammates.map((teammate) => {
      const memberSlug = routeHandleSlug(teammate.name)
      return {
        team,
        teammate,
        preferred: memberSlug,
        qualified: [routeHandleSlug(team.name), memberSlug].filter(Boolean).join("-"),
      }
    })
  )

  // Counted before any member claims a handle, so two members with the same
  // name BOTH fall back instead of the first one keeping the short handle and
  // the order of the Squad list deciding who gets addressed by it.
  const preferredCounts = countBy(members.map((m) => m.preferred))
  const firstPass = members.map((member) => {
    const clean =
      member.preferred.length > 0 &&
      !taken.has(member.preferred) &&
      (preferredCounts.get(member.preferred) ?? 0) === 1
    return { ...member, handle: clean ? member.preferred : null }
  })
  for (const entry of firstPass) if (entry.handle) taken.add(entry.handle)

  const qualifiedCounts = countBy(firstPass.filter((m) => !m.handle).map((m) => m.qualified))
  const out: MentionTarget[] = [...VIRTUAL_TARGETS]
  for (const entry of firstPass) {
    let handle = entry.handle
    if (!handle) {
      const qualifiedClean =
        entry.qualified.length > 0 &&
        !taken.has(entry.qualified) &&
        (qualifiedCounts.get(entry.qualified) ?? 0) === 1
      handle = qualifiedClean ? entry.qualified : entry.teammate.id
      taken.add(handle)
    }
    out.push({
      kind: "teammate",
      id: entry.teammate.id,
      name: entry.teammate.name,
      handle,
      squadId: entry.team.id,
      squadName: entry.team.name,
      runtime: entry.teammate.config?.runtime ?? DEFAULT_TEAMMATE_RUNTIME,
      teammate: entry.teammate,
      description: entry.teammate.description,
      nameCollision: reservedNames.has(entry.preferred),
    })
  }
  return out
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

/** Lookup by handle, case-insensitively (what the send path matches). */
export function findTargetByHandle(
  targets: readonly MentionTarget[],
  handle: string | null | undefined
): MentionTarget | null {
  if (!handle) return null
  const wanted = handle.toLowerCase()
  return targets.find((t) => t.handle.toLowerCase() === wanted) ?? null
}

export { VIRTUAL_AGENT_IDS, RESERVED_MENTION_NAMES, DEFAULT_TEAMMATE_RUNTIME }
