/**
 * Which lane answers an addressed turn.
 *
 *  - `@claude` runs on the builtin lane, whatever the conversation is on. No
 *    per-turn provider pin: the model picker stays the one place a model is
 *    chosen, so the answering engine is whatever `deriveBuiltinAdapter` says
 *    for the conversation's provider.
 *  - `@codex` runs on a configured, runnable Codex agent from the runtime
 *    catalog — the conversation's own lane when it already is one, otherwise
 *    the first in catalog order. On web and mobile the catalog already swaps in
 *    the paired Host's lane. Nothing is provisioned on the fly: an agent the
 *    user never set up is a refusal with a reason, not a silent spawn.
 *  - `@<member>` runs as that Squad member (its persona and its model) on the
 *    member's runtime: the builtin lane for `claude`, otherwise that preset's
 *    family, chosen exactly like `@codex` — unless the member pins one exact
 *    config (`TeammateConfig.externalAgentConfigId`), which then answers or
 *    the route is refused.
 *
 * A refusal is never turned into a builtin turn. Routing a turn somewhere and
 * having it quietly answered somewhere else is the one outcome worse than not
 * sending it.
 *
 * Pure: every input is passed in.
 */

import type { AgentRuntimeDescriptor, AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import {
  CODEX_PRESET_FAMILY,
  checkPinnedExternalAgent,
  presetFamilyOf,
} from "@/lib/ai/agent/external/config/agent-binding"
import { isSameRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { resolveTeammateCapabilities } from "@/lib/ai/agent/team/teammate/capability-resolver"
import {
  resolveTeammatePinnedConfigId,
  resolveTeammatePresetId,
} from "@/lib/ai/agent/team/teammate/resolve-external-backing"
import { teammateToCharacter } from "@/lib/ai/agent/team/teammate/teammate-character"
import type { Character } from "@cognia/agent-config-types"
import type { MessageRunRouteStamp } from "@/lib/chat/message-run-metadata"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import type { RouteLane, TurnRoute, TurnRouteTarget } from "./types"

// The preset-family rule lives beside the external-agent config code so the
// team backing, the subagent dispatch and this route read one answer. Re-exported
// for the callers that already import it from here.
export { CODEX_PRESET_FAMILY, presetFamilyOf }

export interface RouteResolutionContext {
  /** The runtime catalog, as the composer's runtime chip lists it. */
  runtimes: readonly AgentRuntimeDescriptor[]
  /** The lane the conversation runs on right now. */
  currentRef: AgentRuntimeRef
  teams: Readonly<Record<string, AgentTeam>>
  teammates: Readonly<Record<string, AgentTeammate>>
  /** The External Agents master switch. */
  externalEnabled: boolean
  /** Preset ids of every configured local agent, regardless of the switch. */
  configuredPresetIds: readonly string[]
}

/** The preset an external-backed member runs on, or null for the builtin lane. */
export function memberPresetId(team: AgentTeam, teammate: AgentTeammate): string | null {
  return resolveTeammatePresetId(teammate, resolveTeammateCapabilities(team, teammate))
}

/**
 * The catalog row for `ref`, when the catalog lists it. Read by the send path
 * to label the answer with the engine that actually ran.
 */
export function descriptorForRef(
  runtimes: readonly AgentRuntimeDescriptor[],
  ref: AgentRuntimeRef
): AgentRuntimeDescriptor | undefined {
  return runtimes.find(
    (row) =>
      isSameRuntimeRef(row.ref, ref) ||
      (row.alternateRef && isSameRuntimeRef(row.alternateRef, ref))
  )
}

function laneForPresetFamily(
  presetId: string,
  ctx: RouteResolutionContext
): Extract<RouteLane, { ok: true }> | Extract<RouteLane, { ok: false }> {
  const family = presetFamilyOf(presetId)
  const candidates = ctx.runtimes.filter(
    (row) => row.group !== "builtin" && row.presetId !== undefined && family.includes(row.presetId)
  )

  // The conversation's own lane first, when it is already this runtime: a
  // follow-up to Codex should reach the same Codex, with its session.
  if (ctx.currentRef.kind !== "builtin") {
    const current = descriptorForRef(candidates, ctx.currentRef)
    if (current && !current.blockedReason) return { ok: true, runtimeRef: current.ref }
  }
  // Then catalog order (local rows by name, then host-only rows): the order the
  // runtime chip lists them in, so the one that answers is the one the user
  // would find first there.
  const runnable = candidates.find((row) => !row.blockedReason)
  if (runnable) return { ok: true, runtimeRef: runnable.ref }

  if (candidates.length > 0) {
    const transient = candidates.find((row) => row.blockTransient)
    const blocked = transient ?? candidates[0]
    return {
      ok: false,
      reason: transient ? "transient" : "blocked",
      ...(blocked.blockedReason ? { detail: blocked.blockedReason } : {}),
      runtime: presetId,
    }
  }
  const configured = ctx.configuredPresetIds.some((id) => family.includes(id))
  return {
    ok: false,
    reason: configured && !ctx.externalEnabled ? "disabled" : "not-configured",
    runtime: presetId,
  }
}

/**
 * The lane of a member pinned to one exact external-agent config. That config
 * answers or the route is refused: a sibling config of the same preset is never
 * substituted (see `lib/ai/agent/external/config/agent-binding.ts`). A config
 * the catalog does not list (deleted, or dropped because it is disabled) is as
 * unavailable as a disabled one.
 */
function laneForPinnedConfig(
  presetId: string,
  configId: string,
  ctx: RouteResolutionContext
): Extract<RouteLane, { ok: true }> | Extract<RouteLane, { ok: false }> {
  const row = ctx.runtimes.find(
    (candidate) => candidate.ref.kind === "external" && candidate.ref.agentId === configId
  )
  const check = checkPinnedExternalAgent(
    row ? { id: configId, presetId: row.presetId, enabled: true, connected: false } : undefined,
    presetId
  )
  if (!row || !check.ok) return { ok: false, reason: "blocked", runtime: presetId }
  if (row.blockedReason) {
    return {
      ok: false,
      reason: row.blockTransient ? "transient" : "blocked",
      detail: row.blockedReason,
      runtime: presetId,
    }
  }
  return { ok: true, runtimeRef: row.ref }
}

/** The lane `target` runs on, or why it cannot run. */
export function resolveRouteLane(target: TurnRouteTarget, ctx: RouteResolutionContext): RouteLane {
  if (target.kind === "runtime") {
    if (target.runtime === "claude") return { ok: true, runtimeRef: { kind: "builtin" } }
    return laneForPresetFamily("codex", ctx)
  }
  const team = ctx.teams[target.squadId]
  const teammate = ctx.teammates[target.teammateId]
  if (!team || !teammate || teammate.teamId !== team.id) {
    return { ok: false, reason: "member-missing" }
  }
  const presetId = memberPresetId(team, teammate)
  if (!presetId) return { ok: true, runtimeRef: { kind: "builtin" }, member: { team, teammate } }
  const pinnedConfigId = resolveTeammatePinnedConfigId(teammate)
  const lane = pinnedConfigId
    ? laneForPinnedConfig(presetId, pinnedConfigId, ctx)
    : laneForPresetFamily(presetId, ctx)
  if (lane.ok) return { ...lane, member: { team, teammate } }
  return {
    ok: false,
    reason: "member-runtime",
    runtime: presetId,
    ...(lane.detail ? { detail: lane.detail } : {}),
  }
}

/**
 * The persona a member turn answers as: the same in-memory character a Squad
 * dispatch synthesizes for that teammate (system prompt, model, skills, MCP
 * servers, twin, sandbox), so `@critic` in a direct chat is the Critic the
 * Squad runs rather than a lookalike. No working directory is pinned — the
 * turn runs in THIS conversation's workspace, like every other turn in it.
 */
export function routeCharacter(member: { team: AgentTeam; teammate: AgentTeammate }): Character {
  return teammateToCharacter({
    team: member.team,
    teammate: member.teammate,
    resolvedCaps: resolveTeammateCapabilities(member.team, member.teammate),
  })
}

/** How the builtin lane is named on an `@claude` answer. A brand, never translated. */
const BUILTIN_ROUTE_LABEL = "Claude"

/**
 * Who answered, for the sealed run metadata.
 *
 * `providerId` is the builtin turn's provider, which is what the glyph should
 * show for `@claude` on a DeepSeek conversation: the engine that ran, not the
 * name that was typed.
 */
export function buildRouteStamp(
  route: TurnRoute,
  lane: Extract<RouteLane, { ok: true }>,
  context: { runtimes: readonly AgentRuntimeDescriptor[]; providerId?: string }
): MessageRunRouteStamp {
  const descriptor =
    lane.runtimeRef.kind === "builtin"
      ? undefined
      : descriptorForRef(context.runtimes, lane.runtimeRef)
  const brandId =
    lane.runtimeRef.kind === "builtin"
      ? (context.providerId ?? "anthropic")
      : (descriptor?.presetId ?? descriptor?.brandId)
  // Brand names, not copy: a runtime route reads as the agent the user
  // configured ("My Codex") and the builtin one as the engine family.
  const label =
    lane.member?.teammate.name ??
    (lane.runtimeRef.kind === "builtin" ? BUILTIN_ROUTE_LABEL : (descriptor?.name ?? route.label))
  return {
    handle: route.handle,
    label,
    runtimeKind: lane.runtimeRef.kind,
    ...(brandId ? { brandId } : {}),
    ...(lane.member ? { teammateId: lane.member.teammate.id, squadId: lane.member.team.id } : {}),
  }
}
