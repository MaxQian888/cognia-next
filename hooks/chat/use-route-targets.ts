"use client"

/**
 * Reactive `@` route targets for the general chat composer: `@claude`,
 * `@codex` and the members of the Squads this conversation can see, each with
 * the lane it would run on right now.
 *
 * The send path re-resolves the same inputs at the moment it commits
 * (`lib/chat/turn-route/snapshot.ts`); this is the live view the popover rows
 * and the chip overlay paint from, so an unavailable target reads as dimmed
 * with its reason BEFORE the user sends into a refusal.
 *
 * Everything is keyed on the pane's own conversation — its lane, its Squad
 * binding, its workspace — never on the focused one, so a split view routes
 * each pane by what that pane is.
 */

import { useMemo } from "react"

import { buildRouteTargets, type MentionTarget } from "@/lib/agent-team/runtime-targets"
import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/config/preset-identity"
import type { AgentRuntimeDescriptor } from "@/lib/ai/agent/runtime-catalog/types"
import { runtimeRefKey } from "@/lib/ai/agent/runtime-catalog/types"
import { descriptorForRef, resolveRouteLane } from "@/lib/chat/turn-route/resolve"
import { routeForTarget } from "@/lib/chat/turn-route/parse"
import { routeSquadsFor } from "@/lib/chat/turn-route/snapshot"
import type { RouteLane } from "@/lib/chat/turn-route/types"
import { useAgentRuntimeCatalog } from "@/hooks/agent/use-agent-runtime-catalog"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { selectTeammates, selectTeams } from "@/stores/agent/agent-team-store/selectors"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { ChatSession } from "@cognia/agent-config-types"

/** One target and what would happen if a turn were addressed to it now. */
export interface RouteOption {
  target: MentionTarget
  lane: RouteLane
  /** The catalog row that would answer, when the lane resolved to one. */
  descriptor?: AgentRuntimeDescriptor
}

export interface RouteTargetsState {
  /** Every addressable target, virtuals first. Empty when routing is off here. */
  targets: readonly MentionTarget[]
  /** The same targets with their live lanes, in the same order. */
  options: readonly RouteOption[]
}

export interface UseRouteTargetsInput {
  /**
   * Whether this composer routes at all: a direct chat or the new-chat
   * composer. A team room routes `@Name` through its own router and an IM
   * conversation takes no `@` completion.
   */
  enabled: boolean
  session: Pick<ChatSession, "id" | "squadId" | "projectId"> | null | undefined
  /** The provider the builtin lane would use, for the engine it names. */
  providerId?: string
  /** Handles the subagent section already uses; a member never shadows one. */
  reservedHandles: readonly string[]
}

const EMPTY: RouteTargetsState = { targets: [], options: [] }

/**
 * The parts of a catalog row a route cares about. The catalog is rebuilt on
 * every render (it has no memo of its own, by design), so the rows are keyed
 * on this instead of their identity — otherwise every keystroke would hand the
 * popover a new option list.
 */
function runtimeSignature(runtimes: readonly AgentRuntimeDescriptor[]): string {
  return runtimes
    .map((row) =>
      [
        row.key,
        row.presetId ?? "",
        row.name ?? "",
        row.brandId ?? "",
        row.blockedReason ?? "",
        row.blockTransient ? "t" : "",
        row.derivedAdapter ?? "",
        row.descriptionKey ?? "",
        JSON.stringify(row.descriptionValues ?? {}),
      ].join("|")
    )
    .join("\n")
}

export function useRouteTargets({
  enabled,
  session,
  providerId,
  reservedHandles,
}: UseRouteTargetsInput): RouteTargetsState {
  const sessionId = session?.id
  const teams = useAgentTeamStore(selectTeams)
  const teammates = useAgentTeamStore(selectTeammates)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const externalEnabled = useExternalAgentStore((state) => state.enabled)
  const storedAgents = useExternalAgentStore((state) => state.agents)
  const liveRef = useRuntimeRefForSession(sessionId)
  const { runtimes } = useAgentRuntimeCatalog(providerId, sessionId)

  const signature = runtimeSignature(runtimes)
  // Keyed on the signature on purpose — see `runtimeSignature`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableRuntimes = useMemo(() => runtimes, [signature])
  // Same idea for the lane: a host ref is re-read with a fresh object whenever
  // the store writes, and "the same lane" is what `runtimeRefKey` says it is.
  const refKey = runtimeRefKey(liveRef)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const currentRef = useMemo(() => liveRef, [refKey])
  const reservedKey = reservedHandles.join("\n")

  const targets = useMemo(() => {
    if (!enabled) return EMPTY.targets
    return buildRouteTargets({
      squads: routeSquadsFor({
        teams,
        teammates,
        boundSquadId: session?.squadId ?? null,
        workspaceId: session?.projectId ?? activeProjectId ?? null,
      }),
      reservedHandles: reservedKey ? reservedKey.split("\n") : [],
    })
  }, [
    enabled,
    teams,
    teammates,
    session?.squadId,
    session?.projectId,
    activeProjectId,
    reservedKey,
  ])

  const configuredPresetIds = useMemo(
    () =>
      Object.values(storedAgents ?? {})
        .map((agent) => externalAgentPresetIdOf(agent))
        .filter((presetId): presetId is string => !!presetId),
    [storedAgents]
  )

  const options = useMemo<readonly RouteOption[]>(() => {
    if (targets.length === 0) return EMPTY.options
    const context = {
      runtimes: stableRuntimes,
      currentRef,
      teams,
      teammates,
      externalEnabled,
      configuredPresetIds,
    }
    return targets.map((target) => {
      const lane = resolveRouteLane(routeForTarget(target).target, context)
      const descriptor = lane.ok ? descriptorForRef(stableRuntimes, lane.runtimeRef) : undefined
      return descriptor ? { target, lane, descriptor } : { target, lane }
    })
  }, [targets, stableRuntimes, currentRef, teams, teammates, externalEnabled, configuredPresetIds])

  return enabled ? { targets, options } : EMPTY
}
