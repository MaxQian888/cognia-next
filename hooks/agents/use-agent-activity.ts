"use client"

/**
 * Live activity for the agents console (ADR-0220): one agent's full picture
 * for its detail page, and a summary per agent for the list. Rows come from
 * Dexie live queries; the run status comes from the chat store, so a
 * conversation that starts streaming flips the agent to "running" without a
 * reload.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSessionRunStatusMap } from "@/hooks/chat/use-session-run-status-map"
import { listAgentTasks } from "@/lib/db/agent-tasks"
import {
  listAgentIssues,
  listAgentSessions,
  listAgentsSummaryInputs,
  listAgentUsageSince,
} from "@/lib/db/agent-activity"
import {
  ACTIVITY_WINDOW_MS,
  deriveAgentActivity,
  summarizeAgents,
  type AgentActivity,
  type AgentSummary,
} from "@/lib/agents/agent-activity"

const DETAIL_FEED_LIMIT = 50

export function useAgentActivity(agentId: string | undefined): AgentActivity | undefined {
  const runStatus = useSessionRunStatusMap()
  const rows = useLiveQuery(async () => {
    if (!agentId) return undefined
    const now = Date.now()
    const [sessions, tasks, issues, usage] = await Promise.all([
      listAgentSessions(agentId),
      listAgentTasks(agentId),
      listAgentIssues(agentId),
      listAgentUsageSince(agentId, now - ACTIVITY_WINDOW_MS),
    ])
    return { sessions, tasks, issues, usage, now }
  }, [agentId])
  return useMemo(
    // The detail's feed folds to a few rows and expands in place, so it
    // keeps a longer tail than the default.
    () =>
      rows
        ? deriveAgentActivity({ ...rows, runStatus, recentLimit: DETAIL_FEED_LIMIT })
        : undefined,
    [rows, runStatus]
  )
}

export function useAgentSummaries(agentIds: readonly string[]): ReadonlyMap<string, AgentSummary> {
  const runStatus = useSessionRunStatusMap()
  const inputs = useLiveQuery(async () => {
    const now = Date.now()
    return { ...(await listAgentsSummaryInputs(now - ACTIVITY_WINDOW_MS)), now }
  }, [])
  const key = agentIds.join("\u0000")
  return useMemo(
    () =>
      inputs
        ? summarizeAgents(
            key ? key.split("\u0000") : [],
            inputs.sessions,
            inputs.usage,
            runStatus,
            inputs.now
          )
        : new Map(),
    [inputs, key, runStatus]
  )
}
