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
  type TeamTaskStatus,
  type TeamDisplayMode,
  type AgentTeamWorkspaceTab,
  type AgentTeamEditorSession,
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
} from "@/types/agent/agent-team"
import type { TaskMoveError } from "@/lib/ai/agent/team/task-move-guard"

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
  /**
   * The most recently created team. Written by `createTeam` only — the
   * `setActiveTeam` / `setWorkspaceTeamFromRoute` setters went with the
   * `/agent-teams/workspace` route ADR-0140 retired. Still read as the
   * last-resort fallback for a surface that names no team: by
   * `selectActiveTeamConsensus`, and by `DelegationsPanel`, which resolves
   * `teamId ?? activeTeamId` itself and passes the answer to
   * `selectTeamDelegations`. Not persisted.
   */
  activeTeamId: string | null
  /**
   * INTENTIONALLY INERT (Working Rule 7). Persisted by
   * `partializeAgentTeamState` and read by nothing: the workspace shell that
   * owned the compact/expanded toggle was retired with
   * `/agent-teams/workspace`, and its setter went with it. Kept declared so a
   * blob written by an older build still rehydrates and round-trips instead of
   * being dropped on the next save. Pinned by `store.test.ts`.
   */
  displayMode: TeamDisplayMode
  /** INTENTIONALLY INERT — see `displayMode`. Persisted, read by nothing. */
  workspaceTab: AgentTeamWorkspaceTab
  /** Tasks tab presentation: flat list or kanban board. Persisted. */
  tasksView: "list" | "board"
  /**
   * Per-team project Editor tab session (open files, active file, selected
   * root, layout). Persisted so reopening the tab restores the working set.
   */
  editorSession: Record<string, AgentTeamEditorSession>

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

  // Task CRUD
  createTask: (input: CreateTaskInput) => AgentTeamTask
  upsertTask: (task: AgentTeamTask) => void
  updateTask: (taskId: string, updates: Partial<AgentTeamTask>) => void
  deleteTask: (taskId: string) => void
  setTaskStatus: (taskId: string, status: TeamTaskStatus, result?: string, error?: string) => void
  /**
   * Human-owned board move (drag, action sheet, RPC, plugin API). Validates
   * the transition through `canMoveTask` — the single guard shared with the
   * board UI and remote surfaces — and applies status side-effects (claim
   * release + timestamp resets on `→ pending`, completion stamps on
   * terminal statuses).
   */
  moveTask: (taskId: string, to: TeamTaskStatus) => { ok: boolean; reason?: TaskMoveError }
  /** Same-column reorder: place the task at `targetIndex` and renumber. */
  reorderTask: (taskId: string, targetIndex: number) => void
  assignTask: (taskId: string, teammateId: string) => void
  addTaskComment: (input: AddTaskCommentInput) => AgentTaskComment | null
  attachTaskFile: (taskId: string, attachment: Omit<TaskCommentAttachment, "id">) => void

  // Messages
  addMessage: (input: SendMessageInput) => AgentTeamMessage
  removeMessage: (messageId: string) => void

  // Events
  addEvent: (event: AgentTeamEvent) => void
  clearEvents: (teamId?: string) => void

  // Templates
  addTemplate: (template: AgentTeamTemplate) => void
  deleteTemplate: (templateId: string) => void
  /** Copy a squad into a workspace. See the note on the implementation. */
  duplicateSquad: (teamId: string, input: { name: string; projectId?: string }) => AgentTeam | null
  saveAsTemplate: (
    teamId: string,
    name: string,
    category?: AgentTeamTemplate["category"]
  ) => AgentTeamTemplate | null
  updateTemplate: (templateId: string, updates: Partial<AgentTeamTemplate>) => void

  // UI State
  setTasksView: (view: "list" | "board") => void
  // Selectors
  getTeam: (teamId: string) => AgentTeam | undefined
  getTeammate: (teammateId: string) => AgentTeammate | undefined
  getTeammates: (teamId: string) => AgentTeammate[]
  getTeamTasks: (teamId: string) => AgentTeamTask[]
  getTaskComments: (taskId: string) => AgentTaskComment[]
  getTeamMessages: (teamId: string) => AgentTeamMessage[]
  getActiveTeam: () => AgentTeam | undefined

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
  /**
   * The only writers of `AgentTeam.executionReport`, which
   * `lib/plugin/api/team-api.ts` exposes to plugins (`getRunStatus` /
   * `getExecutionReport` / `getCheckpoints`) and `run-report-tab.tsx` renders.
   * Neither has a production caller yet — the team runtime does not stamp a
   * report — so the readers show nothing until it does. Kept rather than
   * deleted with the rest of the retired workspace surface: dropping the only
   * writers would make three live readers permanently unfillable, and
   * `lib/plugin/api/team-api.test.ts` drives both.
   */
  upsertExecutionReport: (teamId: string, report: TeamExecutionReport) => void
  addExecutionCheckpoint: (teamId: string, checkpoint: TeamExecutionCheckpoint) => void

  // Reset
  reset: () => void
}
