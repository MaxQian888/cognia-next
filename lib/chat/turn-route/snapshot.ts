/**
 * Everything the route resolver reads, gathered once, outside React.
 *
 * The composer's `@` panel shows a live view of the same inputs
 * (`hooks/chat/use-route-targets.ts`); the send path re-reads them here at the
 * moment it commits, because a Codex agent disabled or a Squad member removed
 * between the pick and the send must refuse THIS send, not the next one.
 *
 * Everything is keyed on the conversation being sent into, never on focus: in
 * split view the unfocused pane routes by its own session's lane, binding and
 * workspace.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import { collectSquadPresence } from "@/lib/agent/squad-presence"
import { buildRouteTargets, type MentionTarget } from "@/lib/agent-team/runtime-targets"
import type { RouteTargetSquad } from "@/lib/agent-team/runtime-targets"
import { listAgentRuntimes } from "@/lib/ai/agent/runtime-catalog/catalog"
import { externalAgentPresetIdOf } from "@/lib/ai/agent/external/config/preset-identity"
import {
  HOST_CONFIG_COMMANDS,
  hostConfigsAvailability,
  listRemoteHostConfigs,
} from "@/lib/ai/agent/external/runtimes/remote/remote-host-configs"
import { buildChatMentionTargets } from "@/lib/claude/agents/chat-mention-targets"
import { getSession } from "@/lib/db/sessions"
import { catalogInputFromState } from "@/hooks/agent/use-agent-runtime-catalog"
import { ensureBootCapability } from "@/lib/boot/capabilities"
import { whenAgentTeamDexieBridgeHydrated } from "@/stores/agent/agent-team-store/dexie-bridge"
import { runtimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { ExternalAgentConfigRecord } from "@/types/agent/external-agent-config-store"
import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import type { RouteResolutionContext } from "./resolve"

export interface RouteSquadsInput {
  teams: Readonly<Record<string, AgentTeam>>
  teammates: Readonly<Record<string, AgentTeammate>>
  /** The Squad this conversation is bound to; listed first. */
  boundSquadId?: string | null
  /** Scope to this workspace (a Squad with no workspace is shared). */
  workspaceId?: string | null
}

/**
 * The Squads whose members a conversation can address, in display order.
 *
 * The same Squads the composer's executor picker offers (`collectSquadPresence`
 * is that picker's derivation), with the conversation's own Squad moved to the
 * front: it is the one a person in that conversation means first. A bound
 * Squad from another workspace is still listed — the binding says it belongs.
 */
export function routeSquadsFor({
  teams,
  teammates,
  boundSquadId,
  workspaceId,
}: RouteSquadsInput): RouteTargetSquad[] {
  const rows = collectSquadPresence({ teams, teammates, workspaceId: workspaceId ?? null })
  const ids = rows.map((row) => row.id)
  const bound = boundSquadId && teams[boundSquadId] ? boundSquadId : null
  const ordered = bound ? [bound, ...ids.filter((id) => id !== bound)] : ids
  return ordered.flatMap((id) => {
    const team = teams[id]
    if (!team) return []
    const members = (team.teammateIds ?? [])
      .map((teammateId) => teammates[teammateId])
      .filter((teammate): teammate is AgentTeammate => !!teammate && teammate.teamId === id)
    return members.length > 0 ? [{ team, teammates: members }] : []
  })
}

type RouteSession = Pick<ChatSession, "squadId" | "projectId"> | null | undefined

/**
 * The route targets for a conversation, from the stores as they are now.
 * Synchronous: every input is in memory. The subagent handles are reserved so
 * a member never shadows one.
 */
export function routeTargetsFromStores(
  session: RouteSession,
  reservedHandles: Iterable<string> = buildChatMentionTargets().map((target) => target.handle)
): MentionTarget[] {
  const { teams, teammates } = useAgentTeamStore.getState()
  return buildRouteTargets({
    squads: routeSquadsFor({
      teams,
      teammates,
      boundSquadId: session?.squadId ?? null,
      workspaceId: session?.projectId ?? useProjectStore.getState().activeProjectId ?? null,
    }),
    reservedHandles,
  })
}

/**
 * The paired Host's ready configurations, or none when this client cannot
 * reach a Host that stores them. A failed read is "no host rows", which makes
 * a host-only Codex read as unavailable — the truthful answer to "can this
 * send reach it right now".
 */
export async function loadHostRuntimeConfigs(): Promise<ExternalAgentConfigRecord[]> {
  if (!hostConfigsAvailability(HOST_CONFIG_COMMANDS.list).ok) return []
  try {
    return await listRemoteHostConfigs()
  } catch {
    return []
  }
}

/** Longest a send waits for the route stores before resolving against what memory holds. */
export const ROUTE_STORES_WAIT_MS = 4_000

/**
 * Ask for the stores a route reads — the Squad mirror and the external-agent
 * runtime — to be booted, without waiting. Both belong to the
 * `knowledge-agents` boot capability, which the chat route does not request by
 * itself in the development `main` profile. The composer calls this when a
 * leading `@` opens its panel, so the Squad members section fills in while the
 * user is still choosing.
 */
export function requestRouteStores(): void {
  void ensureBootCapability("knowledge-agents").catch(() => undefined)
}

/**
 * Wait, bounded, until the route stores hold what they persisted.
 *
 * Without this a send can beat them: right after launch (any profile) or on a
 * chat route that never booted them (the `main` profile), the Squad mirror is
 * still empty, and `@<member>` would be refused as a member that no longer
 * exists. The capability resolving means its initializers have mounted — so the
 * Squad bootstrap has started its bridge — and then the bridge's first hydrate
 * is awaited. Bounded because a bridge that never hydrates (a locked account,
 * a failed boot) must not hold the send forever; past the bound the route
 * resolves against memory as it is, and the send path says why it refused.
 */
export async function ensureRouteStoresReady(timeoutMs = ROUTE_STORES_WAIT_MS): Promise<void> {
  const ready = ensureBootCapability("knowledge-agents").then(() =>
    whenAgentTeamDexieBridgeHydrated()
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([ready.catch(() => undefined), bound])
  } finally {
    clearTimeout(timer)
  }
}

export interface RouteContextSnapshot extends RouteResolutionContext {
  targets: MentionTarget[]
}

/**
 * Everything `parseLeadingRoute` and `resolveRouteLane` need for one send.
 *
 * `session` may be passed when the caller already holds the row; otherwise it
 * is read by id. A null id is the new-chat composer, which resolves against
 * the app defaults exactly as its first turn will.
 */
export async function snapshotRouteContext(
  sessionId: string | null | undefined,
  options: { providerId?: string; session?: ChatSession | null } = {}
): Promise<RouteContextSnapshot> {
  const [session, hostConfigs] = await Promise.all([
    options.session !== undefined
      ? options.session
      : sessionId
        ? getSession(sessionId).then((row) => row ?? null)
        : null,
    loadHostRuntimeConfigs(),
    // Read below, synchronously — so they must be hydrated first.
    ensureRouteStoresReady(),
  ])
  const external = useExternalAgentStore.getState()
  const { teams, teammates } = useAgentTeamStore.getState()
  return {
    targets: routeTargetsFromStores(session),
    runtimes: listAgentRuntimes(
      catalogInputFromState({
        providerId: options.providerId ?? session?.providerOverride,
        external,
        hostConfigs,
      })
    ),
    currentRef: runtimeRefForSession(sessionId ?? undefined),
    teams,
    teammates,
    externalEnabled: external.enabled,
    configuredPresetIds: Object.values(external.agents ?? {})
      .map((agent) => externalAgentPresetIdOf(agent))
      .filter((presetId): presetId is string => !!presetId),
  }
}
