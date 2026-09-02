import type { AgentTeamState } from "./types"
import type {
  AgentTeammate,
  ResolvedCapabilities,
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

// ============================================================================
// Derived: Teammates
// ============================================================================

/**
 * Roster of a NAMED team, in the team's own roster order (its lead first).
 *
 * The `selectActiveTeam*` family read `activeTeamId`, which only `createTeam`
 * writes, so a surface opened against some other squad saw the roster of
 * whichever squad was created last in this browser session — and nothing at
 * all after a reload, because `activeTeamId` is not persisted. Every consumer
 * of a roster already knows which team it is showing, so it names it.
 */
export const selectTeamTeammates = (
  state: AgentTeamState,
  teamId: string | undefined
): AgentTeammate[] => {
  const team = teamId ? state.teams[teamId] : undefined
  if (!team) return []
  return team.teammateIds
    .map((id) => state.teammates[id])
    .filter((tm): tm is AgentTeammate => tm !== undefined)
}

// ============================================================================
// Derived: Consensus
// ============================================================================

/**
 * Consensus for a NAMED team.
 *
 * The `selectActiveTeam*` family reads whatever the store last selected, which
 * is correct while the only consumer is a workspace the user navigated into.
 * The run cockpit shows one run at a time and never selects a team, so a panel
 * built on the active-team selector there shows whatever the retired workspace
 * last looked at. Every caller outside that workspace has to name its team.
 */
export const selectTeamConsensus = (state: AgentTeamState, teamId: string | undefined) => {
  const team = teamId ? state.teams[teamId] : undefined
  if (!team) return []
  return (team.consensusIds || [])
    .map((id) => state.consensus[id])
    .filter((c): c is ConsensusRequest => c !== undefined)
}

/**
 * Last-resort fallback for a surface that names no team. Only `createTeam`
 * writes `activeTeamId`, so this is "the squad created most recently in this
 * session" and nothing after a reload — which is why every real caller passes
 * a team id to `selectTeamConsensus` instead.
 */
export const selectActiveTeamConsensus = (state: AgentTeamState) =>
  selectTeamConsensus(state, state.activeTeamId ?? undefined)

// ============================================================================
// Derived: Shared Memory
// ============================================================================

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

/**
 * Delegations a NAMED team is the source of. See `selectTeamConsensus`.
 *
 * There is no active-team twin of this selector any more: its only caller was
 * the delegations panel, which now resolves `teamId ?? activeTeamId` itself and
 * names the result here, so the "whatever was created last in this session"
 * fallback lives at exactly one call site instead of being a second selector.
 */
export const selectTeamDelegations = (state: AgentTeamState, teamId: string | undefined) => {
  const team = teamId ? state.teams[teamId] : undefined
  if (!team) return []
  return Object.values(state.delegations).filter(
    (d): d is TeamDelegationRecord => d.sourceTeamId === team.id
  )
}

export const selectActiveDelegations = (state: AgentTeamState) =>
  Object.values(state.delegations).filter((d) => d.status === "active")
