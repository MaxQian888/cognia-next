import type { AgentTeamState } from "./types"
import type {
  AgentTeammate,
  AgentTeamTask,
  AgentTeamMessage,
  ResolvedCapabilities,
  TeamGovernanceSummary,
  TeamTaskStatus,
  TeammateStatus,
  TeamMessageType,
  ConsensusRequest,
  SharedMemoryEntry,
  TeamDelegationRecord,
} from "@/types/agent/agent-team"
import { resolveTeammateCapabilities } from "@/lib/ai/agent/team/capability-resolver"

// ============================================================================
// Base Selectors
// ============================================================================

export const selectTeams = (state: AgentTeamState) => state.teams
export const selectTeammates = (state: AgentTeamState) => state.teammates
export const selectTasks = (state: AgentTeamState) => state.tasks
export const selectMessages = (state: AgentTeamState) => state.messages
export const selectActiveTeamId = (state: AgentTeamState) => state.activeTeamId
export const selectSelectedTeammateId = (state: AgentTeamState) => state.selectedTeammateId
export const selectDisplayMode = (state: AgentTeamState) => state.displayMode
export const selectIsPanelOpen = (state: AgentTeamState) => state.isPanelOpen
export const selectWorkspaceTab = (state: AgentTeamState) => state.workspaceTab
export const selectWorkspaceFocus = (state: AgentTeamState) => state.workspaceFocus
export const selectWorkspaceDetailOpen = (state: AgentTeamState) => state.workspaceDetailOpen
export const selectTemplates = (state: AgentTeamState) => state.templates
export const selectDefaultConfig = (state: AgentTeamState) => state.defaultConfig
export const selectConsensus = (state: AgentTeamState) => state.consensus
export const selectSharedMemory = (state: AgentTeamState) => state.sharedMemory
export const selectDelegations = (state: AgentTeamState) => state.delegations
export const selectEvents = (state: AgentTeamState) => state.events

// ============================================================================
// Derived: Team
// ============================================================================

export const selectTeamCount = (state: AgentTeamState) => Object.keys(state.teams).length

export const selectActiveTeam = (state: AgentTeamState) =>
  state.activeTeamId ? state.teams[state.activeTeamId] : undefined

export const selectActiveTeamRoutingAssessment = (state: AgentTeamState) =>
  selectActiveTeam(state)?.routingAssessment

export const selectActiveTeamSelectedExecutionPattern = (state: AgentTeamState) =>
  selectActiveTeam(state)?.selectedExecutionPattern

export const selectActiveTeamExecutionReport = (state: AgentTeamState) =>
  selectActiveTeam(state)?.executionReport

export const selectActiveTeamGovernanceSummary = (state: AgentTeamState): TeamGovernanceSummary => {
  const team = selectActiveTeam(state)
  const report = selectActiveTeamExecutionReport(state)

  return {
    recommendedPattern:
      team?.routingAssessment?.recommendedPattern ?? report?.routingAssessment?.recommendedPattern,
    activeExecutionPattern: report?.activeExecutionPattern,
    selectedExecutionPattern: team?.selectedExecutionPattern,
    routingReason: team?.routingAssessment?.reason ?? report?.routingAssessment?.reason,
    confidence: team?.routingAssessment?.confidence ?? report?.routingAssessment?.confidence,
    nextActions: report?.summary?.nextActions ?? [],
    traceSessionId: report?.traceSessionId,
    checkpointCount: report?.checkpoints.length ?? 0,
    approvalsRequested: report?.summary?.approvalsRequested ?? 0,
    delegatedTasks: report?.summary?.delegatedTasks ?? 0,
    blockedTasks: report?.summary?.blockedTasks ?? 0,
    completedTasks: report?.summary?.completedTasks ?? 0,
    failedTasks: report?.summary?.failedTasks ?? 0,
  }
}

// ============================================================================
// Derived: Teammates
// ============================================================================

export const selectActiveTeammates = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return []
  return team.teammateIds
    .map((id) => state.teammates[id])
    .filter((tm): tm is AgentTeammate => tm !== undefined)
}

export const selectActiveTeamTeammatesByStatus =
  (status: TeammateStatus) => (state: AgentTeamState) =>
    selectActiveTeammates(state).filter((tm) => tm.status === status)

export const selectActiveTeamIdleTeammates = (state: AgentTeamState) =>
  selectActiveTeammates(state).filter((tm) => tm.status === "idle")

export const selectActiveTeamExecutingTeammates = (state: AgentTeamState) =>
  selectActiveTeammates(state).filter((tm) => tm.status === "executing")

// ============================================================================
// Derived: Tasks
// ============================================================================

export const selectActiveTeamTasks = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return []
  return team.taskIds
    .map((id) => state.tasks[id])
    .filter((t): t is AgentTeamTask => t !== undefined)
    .sort((a, b) => a.order - b.order)
}

export const selectActiveTeamTasksByStatus = (status: TeamTaskStatus) => (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter((t) => t.status === status)

export const selectActiveTeamPendingTasks = (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter((t) => t.status === "pending")

export const selectActiveTeamBlockedTasks = (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter((t) => t.status === "blocked")

export const selectActiveTeamCompletedTasks = (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter((t) => t.status === "completed")

export const selectActiveTeamInProgressTasks = (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter((t) => t.status === "in_progress")

export const selectActiveTeamTasksByAssignee = (teammateId: string) => (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter(
    (t) => t.assignedTo === teammateId || t.claimedBy === teammateId
  )

export const selectActiveTeamUnassignedTasks = (state: AgentTeamState) =>
  selectActiveTeamTasks(state).filter(
    (t) => !t.assignedTo && !t.claimedBy && t.status === "pending"
  )

// ============================================================================
// Derived: Messages
// ============================================================================

export const selectActiveTeamMessages = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return []
  return team.messageIds
    .map((id) => state.messages[id])
    .filter((m): m is AgentTeamMessage => m !== undefined)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
}

export const selectActiveTeamUnreadMessages = (state: AgentTeamState) =>
  selectActiveTeamMessages(state).filter((m) => !m.read)

export const selectTeamUnreadCount =
  (teamId: string) =>
  (state: AgentTeamState): number => {
    const team = state.teams?.[teamId]
    const messageIds = team?.messageIds
    if (!messageIds) return 0
    const messages = state.messages
    if (!messages) return 0
    let count = 0
    for (const id of messageIds) {
      const msg = messages[id]
      if (msg && !msg.read) count++
    }
    return count
  }

export const selectTotalUnreadCount = (state: AgentTeamState): number => {
  const teams = state.teams
  const messages = state.messages
  if (!teams || !messages) return 0
  let total = 0
  for (const team of Object.values(teams)) {
    const messageIds = team?.messageIds
    if (!messageIds) continue
    for (const id of messageIds) {
      const msg = messages[id]
      if (msg && !msg.read) total++
    }
  }
  return total
}

export const selectActiveTeamMessagesByType = (type: TeamMessageType) => (state: AgentTeamState) =>
  selectActiveTeamMessages(state).filter((m) => m.type === type)

export const selectActiveTeamStructuredMessages = (state: AgentTeamState) =>
  selectActiveTeamMessages(state).filter((m) => m.structuredPayload !== undefined)

// ============================================================================
// Derived: Consensus
// ============================================================================

export const selectActiveTeamConsensus = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return []
  return (team.consensusIds || [])
    .map((id) => state.consensus[id])
    .filter((c): c is ConsensusRequest => c !== undefined)
}

export const selectActiveTeamPendingConsensus = (state: AgentTeamState) =>
  selectActiveTeamConsensus(state).filter((c) => c.status === "open")

// ============================================================================
// Derived: Shared Memory
// ============================================================================

export const selectActiveTeamSharedMemory = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return {} as Record<string, SharedMemoryEntry>
  return state.sharedMemory[team.id] || {}
}

export const selectActiveTeamSharedMemoryEntries = (state: AgentTeamState) =>
  Object.values(selectActiveTeamSharedMemory(state))

/**
 * Synthetic reader id representing the human operator. The operator sees
 * every entry regardless of an entry's `readableBy` allow-list.
 */
export const OPERATOR_READER_ID = "operator"

/**
 * Read-ACL predicate. An entry is readable by `readerId` when:
 *   - the reader is the operator (sees everything), OR
 *   - the entry has no `readableBy` allow-list (empty/missing = all-can-read), OR
 *   - the reader wrote the entry, OR
 *   - the reader is on the allow-list.
 */
export function isEntryReadableBy(entry: SharedMemoryEntry, readerId: string): boolean {
  if (readerId === OPERATOR_READER_ID) return true
  if (!entry.readableBy || entry.readableBy.length === 0) return true
  if (entry.writtenBy === readerId) return true
  return entry.readableBy.includes(readerId)
}

/**
 * ACL-aware projection of a team's shared-memory entries for a specific
 * reader. Use `OPERATOR_READER_ID` for the operator view.
 */
export const selectSharedMemoryEntriesForReader =
  (teamId: string, readerId: string) =>
  (state: AgentTeamState): SharedMemoryEntry[] =>
    Object.values(state.sharedMemory[teamId] ?? {}).filter((entry) =>
      isEntryReadableBy(entry, readerId)
    )

// ============================================================================
// Derived: Capabilities
// ============================================================================

/**
 * Resolve the effective capability bundle for a specific teammate inside a
 * team. Merges the team-level default with the teammate-level overlay using
 * the same semantics as the runtime `capability-resolver`. Returns the
 * empty bundle when the team or teammate is missing.
 */
export const selectResolvedCapabilities =
  (teamId: string, teammateId: string) =>
  (state: AgentTeamState): ResolvedCapabilities => {
    const team = state.teams[teamId]
    const teammate = state.teammates[teammateId]
    if (!team || !teammate) {
      return {
        mcpServerIds: [],
        skillIds: [],
        nativeAnthropicToolIds: [],
        characterPackIds: [],
        externalAgentPresetIds: [],
        subagentIds: [],
        a2uiTemplateIds: [],
      }
    }
    return resolveTeammateCapabilities(team, teammate)
  }

// ============================================================================
// Derived: Delegations
// ============================================================================

export const selectActiveTeamDelegations = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return []
  return Object.values(state.delegations).filter(
    (d): d is TeamDelegationRecord => d.sourceTeamId === team.id
  )
}

export const selectActiveDelegations = (state: AgentTeamState) =>
  Object.values(state.delegations).filter((d) => d.status === "active")

// ============================================================================
// Derived: Events
// ============================================================================

export const selectActiveTeamEvents = (state: AgentTeamState) => {
  const team = selectActiveTeam(state)
  if (!team) return []
  return state.events.filter((e) => e.teamId === team.id)
}
