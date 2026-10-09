"use client"

/**
 * Everything both agents console bodies (desktop and phone) read (ADR-0220):
 * the agents (variants resolved to their effective profile), their live
 * summaries, the catalogs the editor needs, pack-update counts, the agent the
 * URL names, and the "chat with it" action. One hook so the two bodies differ
 * only in layout.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import type { Character } from "@cognia/agent-config-types"
import { listResolvedCharacters } from "@/lib/db/characters"
import { countPendingPackUpdates } from "@/lib/agents/agent-source"
import type { AgentSummary } from "@/lib/agents/agent-activity"
import { useAgentSummaries } from "./use-agent-activity"
import { useAgentCatalogs, type AgentCatalogs } from "./use-agent-catalogs"
import { useStartAgentChat } from "./use-start-agent-chat"
import type { AgentsRouteState } from "./use-agents-route-state"

export interface AgentsConsoleModel {
  /** `undefined` while the first read is in flight. */
  agents: Character[] | undefined
  summaries: ReadonlyMap<string, AgentSummary>
  /** Agents running or waiting on an approval right now. */
  liveCount: number
  catalogs: AgentCatalogs
  /** The agent `?id=` names, `null` when it names none that exists. */
  selected: Character | null | undefined
  /** Pending pack-update clones for the selected agent's pack. */
  selectedSiblingPending: number
  startChat: (agent: Pick<Character, "id" | "name">) => Promise<void>
  startingChat: boolean
}

export function useAgentsConsoleModel(route: AgentsRouteState): AgentsConsoleModel {
  const agents = useLiveQuery(() => listResolvedCharacters(), [])
  const ids = useMemo(() => (agents ?? []).map((agent) => agent.id), [agents])
  const summaries = useAgentSummaries(ids)
  const catalogs = useAgentCatalogs()
  const { start, starting } = useStartAgentChat()
  const selectedId = route.view.kind === "detail" ? route.view.id : undefined
  const selected =
    agents === undefined ? undefined : (agents.find((a) => a.id === selectedId) ?? null)
  const liveCount = useMemo(() => {
    let count = 0
    for (const summary of summaries.values()) if (summary.status !== "idle") count += 1
    return count
  }, [summaries])
  const pending = useMemo(() => countPendingPackUpdates(agents ?? []), [agents])
  const selectedSiblingPending =
    selected?.sourcePluginId && selected.sourcePackId
      ? (pending.get(`${selected.sourcePluginId}:${selected.sourcePackId}`) ?? 0)
      : 0
  return {
    agents,
    summaries,
    liveCount,
    catalogs,
    selected,
    selectedSiblingPending,
    startChat: start,
    startingChat: starting,
  }
}
