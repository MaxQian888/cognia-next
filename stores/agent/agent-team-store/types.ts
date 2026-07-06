import {
  type AgentTeam,
  type AgentTeammate,
  type AgentTeamTask,
  type AgentTaskComment,
  type TaskCommentAttachment,
  type AddTaskCommentInput,
  type AgentTeamMessage,
  type AgentTeamConfig,
  type AgentTeamTemplate,
  type AgentTeamEvent,
  type TeamCapabilityBundle,
  type TeammateCapabilityOverlay,
  type TeamStatus,
  type TeammateStatus,
  type TeamTaskStatus,
  type TeamDisplayMode,
  type AgentTeamWorkspaceTab,
  type AgentTeamWorkspaceFocus,
  type TeamDelegationRecord,
  type TeamDelegationStatus,
  type TeamExecutionReport,
  type TeamExecutionCheckpoint,
  type ConsensusRequest,
  type SharedMemoryEntry,
  type CreateTeamInput,
  type AddTeammateInput,
  type CreateTaskInput,
  type SendMessageInput,
  type StructuredMessagePayload,
} from "@/types/agent/agent-team"
import type { CapabilityAuditWarning } from "@/lib/ai/agent/team/capability-audit"

export interface AgentTeamState {
  // Data
  teams: Record<string, AgentTeam>
  teammates: Record<string, AgentTeammate>
  tasks: Record<string, AgentTeamTask>
  messages: Record<string, AgentTeamMessage>
  templates: Record<string, AgentTeamTemplate>
  events: AgentTeamEvent[]
  consensus: Record<string, ConsensusRequest>
  sharedMemory: Record<string, Record<string, SharedMemoryEntry>>
  delegations: Record<string, TeamDelegationRecord>
  /**
   * Per-(teamId, adapterId) cursor of the last shared-memory version pulled
   * from a shared-memory adapter. Persisted; advanced by
   * `setAdapterSyncVersion` after each reverse sync.
   */
  lastAdapterSyncVersion: Record<string, Record<string, number>>

  // UI State
  activeTeamId: string | null
  selectedTeammateId: string | null
  displayMode: TeamDisplayMode
  isPanelOpen: boolean
  workspaceTab: AgentTeamWorkspaceTab
  workspaceFocus: AgentTeamWorkspaceFocus
  workspaceDetailOpen: boolean

  // Settings
  defaultConfig: AgentTeamConfig

  // Team CRUD
  createTeam: (input: CreateTeamInput) => AgentTeam
  upsertTeam: (team: AgentTeam) => void
  updateTeam: (teamId: string, updates: Partial<AgentTeam>) => void
  updateTeamConfig: (teamId: string, config: AgentTeamConfig) => void
  /**
   * Patch the team-level plugin-capability default pool. Pass an empty
   * bundle (`{}`) to clear the team default. Capability fields not in
   * the patch are preserved.
   */
  updateTeamCapabilities: (teamId: string, bundle: TeamCapabilityBundle) => void
  /**
   * Strip stale capability ids (those an audit flagged as unresolvable, e.g.
   * after a contributing plugin was disabled) from a team's default bundle or
   * a teammate's overlay. `target` selects the scope; `warnings` is the audit
   * output from `lib/ai/agent/team/capability-audit.ts`.
   */
  clearStaleCapabilityIds: (
    target: { teamId: string } | { teammateId: string },
    warnings: CapabilityAuditWarning[]
  ) => void
  deleteTeam: (teamId: string) => void
  /** Workspace isolation cascade: drop all teams/teammates/tasks for a project (templates kept). */
  purgeProject: (projectId: string) => void
  setTeamStatus: (teamId: string, status: TeamStatus) => void

  // Teammate CRUD
  addTeammate: (input: AddTeammateInput) => AgentTeammate
  upsertTeammate: (teammate: AgentTeammate) => void
  updateTeammate: (teammateId: string, updates: Partial<AgentTeammate>) => void
  /**
   * Patch the per-teammate capability overlay (add/remove/replace lists).
   * Pass `null` or `{}` to clear the overlay and revert to inheriting the
   * team default unchanged.
   */
  updateTeammateCapabilities: (
    teammateId: string,
    overlay: TeammateCapabilityOverlay | null
  ) => void
  removeTeammate: (teammateId: string) => void
  setTeammateStatus: (teammateId: string, status: TeammateStatus) => void
  setTeammateProgress: (teammateId: string, progress: number) => void

  // Task CRUD
  createTask: (input: CreateTaskInput) => AgentTeamTask
  upsertTask: (task: AgentTeamTask) => void
  updateTask: (taskId: string, updates: Partial<AgentTeamTask>) => void
  deleteTask: (taskId: string) => void
  setTaskStatus: (taskId: string, status: TeamTaskStatus, result?: string, error?: string) => void
  claimTask: (taskId: string, teammateId: string) => void
  assignTask: (taskId: string, teammateId: string) => void
  addTaskComment: (input: AddTaskCommentInput) => AgentTaskComment | null
  attachTaskFile: (taskId: string, attachment: Omit<TaskCommentAttachment, "id">) => void

  // Messages
  addMessage: (input: SendMessageInput) => AgentTeamMessage
  upsertMessage: (message: AgentTeamMessage) => void
  removeMessage: (messageId: string) => void
  markMessageRead: (messageId: string) => void
  markAllMessagesRead: (teammateId: string) => void
  markTeamMessagesRead: (teamId: string) => void

  // Events
  addEvent: (event: AgentTeamEvent) => void
  clearEvents: (teamId?: string) => void

  // Templates
  addTemplate: (template: AgentTeamTemplate) => void
  deleteTemplate: (templateId: string) => void
  saveAsTemplate: (
    teamId: string,
    name: string,
    category?: AgentTeamTemplate["category"]
  ) => AgentTeamTemplate | null
  updateTemplate: (templateId: string, updates: Partial<AgentTeamTemplate>) => void
  importTemplates: (templates: AgentTeamTemplate[]) => number
  exportTemplates: () => AgentTeamTemplate[]

  // UI State
  setActiveTeam: (teamId: string | null) => void
  setSelectedTeammate: (teammateId: string | null) => void
  setDisplayMode: (mode: TeamDisplayMode) => void
  setIsPanelOpen: (open: boolean) => void
  setWorkspaceTab: (tab: AgentTeamWorkspaceTab) => void
  setWorkspaceFocus: (focus: Partial<AgentTeamWorkspaceFocus>) => void
  setWorkspaceTeamFromRoute: (teamId: string | null | undefined) => void
  closeAgentTeamWorkspaceDetail: () => void

  // Selectors
  getTeam: (teamId: string) => AgentTeam | undefined
  getTeammate: (teammateId: string) => AgentTeammate | undefined
  getTeammates: (teamId: string) => AgentTeammate[]
  getTeamTasks: (teamId: string) => AgentTeamTask[]
  getTaskComments: (taskId: string) => AgentTaskComment[]
  getTeamMessages: (teamId: string) => AgentTeamMessage[]
  getUnreadMessages: (teammateId: string) => AgentTeamMessage[]
  getActiveTeam: () => AgentTeam | undefined

  // Batch operations
  cancelAllTasks: (teamId: string) => void
  shutdownAllTeammates: (teamId: string) => void
  cleanupTeam: (teamId: string) => void

  // Consensus
  upsertConsensus: (consensus: ConsensusRequest) => void
  deleteConsensus: (consensusId: string) => void
  clearTeamConsensus: (teamId: string) => void

  // Shared Memory
  writeSharedMemory: (teamId: string, key: string, entry: SharedMemoryEntry) => void
  deleteSharedMemory: (teamId: string, key: string) => void
  clearTeamSharedMemory: (teamId: string) => void
  /** Persist the last shared-memory version pulled from `adapterId` for `teamId`. */
  setAdapterSyncVersion: (teamId: string, adapterId: string, version: number) => void

  // Delegations
  upsertDelegation: (delegation: TeamDelegationRecord) => void
  updateDelegationStatus: (
    delegationId: string,
    status: TeamDelegationStatus,
    result?: string
  ) => void
  clearTeamDelegations: (teamId: string) => void

  // Execution Reports
  upsertExecutionReport: (teamId: string, report: TeamExecutionReport) => void
  addExecutionCheckpoint: (teamId: string, checkpoint: TeamExecutionCheckpoint) => void

  // Structured Messages
  addStructuredMessage: (
    input: SendMessageInput & { structuredPayload: StructuredMessagePayload }
  ) => AgentTeamMessage

  // Lifecycle
  requestTeammateShutdown: (teammateId: string, reason?: string) => void

  // Settings
  updateDefaultConfig: (config: Partial<AgentTeamConfig>) => void

  // Reset
  reset: () => void
}
