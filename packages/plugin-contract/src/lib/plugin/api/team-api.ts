/**
 * The plugin contract's share of `lib/plugin/api/team-api.ts`, which re-exports these.
 */
import type {
  AgentTaskComment,
  AgentTeam,
  AgentTeamConfig,
  AgentTeamEvent,
  AgentTeamTask,
  AgentTeamTemplate,
  AgentTeammate,
  TaskCommentAttachment,
  TeamExecutionCheckpoint,
  TeamExecutionReport,
  TeamStatus,
  TeamTaskStatus,
} from "../../../types/agent/agent-team"
import type { BestOfNPublicRun } from "../../best-of-n/public-run"
import type { SubAgentPriority } from "../../../types/agent/sub-agent"
import type { TaskMoveError } from "../../ai/agent/team/gates/task-move-guard"

export interface PluginTeamTaskCreateInput {
  teamId: string
  title: string
  description?: string
  priority?: SubAgentPriority
  /** Teammate id — must belong to the team. */
  assignedTo?: string
  tags?: string[]
  /** Upstream task ids that must complete first. */
  dependencies?: string[]
}

/**
 * Input for creating a Squad from scratch.
 *
 * Mirrors the fields the Settings library passes to `createSquad`
 * (`components/settings/squads/squads-section.tsx`), minus the ones a plugin
 * has no business setting: `sessionId` binds a Squad to one conversation, and
 * `metadata` is the store's own bag.
 */
export interface PluginTeamCreateInput {
  name: string
  /** The objective the Squad is created around. */
  task: string
  description?: string
  /** Display name for the auto-created lead. Falls back to "Team Lead". */
  leadName?: string
  leadDescription?: string
  /** Partial config overlay. A runtime named here WINS over the durable default. */
  config?: Partial<AgentTeamConfig>
}

/** Input for copying a Squad. `projectId` omitted means the active workspace. */
export interface PluginTeamDuplicateInput {
  name: string
  /** Target workspace. `AgentTeam.projectId` is a real Dexie boundary since v215. */
  projectId?: string
}

export interface PluginTeamMoveResult {
  ok: boolean
  reason?: TaskMoveError
}

/**
 * Input for adding a teammate to an existing team. Plugins can only add
 * regular `"teammate"` members — the lead is synthesized at team creation
 * and is not a role a plugin may claim.
 */
export interface PluginTeamTeammateCreateInput {
  teamId: string
  name: string
  description?: string
  spawnPrompt?: string
  /** Specialization blurb surfaced on the roster card. */
  specialization?: string
}

/**
 * Whitelisted teammate patch — identity/prompt fields only. Run-owned fields
 * (`status` / `progress` / `currentTaskId` / token usage) are deliberately
 * excluded: those belong to the team runtime, exactly like the run-owned
 * task fields excluded from {@link PluginTeamTaskPatch}.
 */
export interface PluginTeamTeammatePatch {
  name?: string
  description?: string
  spawnPrompt?: string
  specialization?: string
}

/**
 * Whitelisted task patch. Status transitions go through {@link PluginTeamAPI.moveTask}
 * (guarded); run-owned fields (`status` / `result` / `error` / `claimedBy` /
 * timing) are not patchable by plugins.
 */
export interface PluginTeamTaskPatch {
  title?: string
  description?: string
  priority?: SubAgentPriority
  tags?: string[]
  expectedOutput?: string
  estimatedDuration?: number
  /** Upstream task ids that must complete first. */
  dependencies?: string[]
}

/** Run-lifecycle snapshot for a team — status plus the latest execution report. */
export interface PluginTeamRunStatus {
  teamId: string
  status: TeamStatus
  /** Latest unified execution report, or `null` before the first run. */
  report: TeamExecutionReport | null
}

/** Outcome of a plugin-initiated Squad run control call. */
export interface PluginTeamRunControlResult {
  ok: boolean
  /** Present when `ok` is false: `squad_not_found`, `dispatch_error`, ... */
  reason?: string
  /** The run id, when starting produced one. */
  runId?: string
}

/** Starting best-of-N attempts from a plugin. Always onto a new result branch. */
export interface PluginBestOfNStartInput {
  /** A direct agent conversation; its repository, commit and agent are the base. */
  sessionId: string
  prompt: string
  /** 2–4. Defaults to the number of `agents`, else 2. */
  n?: number
  /** One per attempt: `session`, an external agent configuration id, or a preset id. */
  agents?: string[]
}

export interface PluginBestOfNStartResult {
  ok: boolean
  /** Present when `ok` is false: `host_unavailable`, `invalid_count`, or the refusal. */
  reason?: string
  run?: BestOfNPublicRun
}

/** Agent-Team board API exposed to plugins. */
export interface PluginTeamAPI {
  // --------------------------------------------------------------- reads
  /** Every team (workspace-scoped store contents). */
  listTeams(): Promise<AgentTeam[]>
  /** One team by id, or `null`. */
  getTeam(teamId: string): Promise<AgentTeam | null>
  /** The team's roster. */
  listTeammates(teamId: string): Promise<AgentTeammate[]>
  /** One teammate by id, or `null`. */
  getTeammate(teammateId: string): Promise<AgentTeammate | null>
  /** The team's task board (unsorted; `order` is the column ordering). */
  listTasks(teamId: string): Promise<AgentTeamTask[]>
  /**
   * Observe a team's board. Fires on any change to the team row, its
   * roster, or its tasks; returns an unsubscribe. Gated by `team:read`
   * at subscription time.
   */
  subscribe(teamId: string, listener: () => void): () => void

  // ------------------------------------------------ run observation (read)
  /**
   * Run-lifecycle snapshot: the team's `status` plus its latest execution
   * report. `null` when the team doesn't exist. Pull-style complement to the
   * `onTeam*` plugin hooks — usable by plugins that only hold `ctx.team`.
   */
  getRunStatus(teamId: string): Promise<PluginTeamRunStatus | null>
  /**
   * The in-store run event ring buffer (last ~100 events, oldest first)
   * filtered to one team — task claims, completions, teammate lifecycle.
   */
  listEvents(teamId: string): Promise<AgentTeamEvent[]>
  /** The latest unified execution report, or `null` before the first run. */
  getExecutionReport(teamId: string): Promise<TeamExecutionReport | null>
  /** Progress-ledger checkpoints of the latest execution report (`[]` when none). */
  listCheckpoints(teamId: string): Promise<TeamExecutionCheckpoint[]>

  // ----------------------------------------------------------- mutations
  /** Create a pending task on the board. */
  createTask(input: PluginTeamTaskCreateInput): Promise<AgentTeamTask>
  /**
   * Patch a task's plan-owned fields (title / description / priority / tags /
   * expected output / estimate / dependencies). Run-owned fields are not
   * patchable — status goes through {@link moveTask}.
   */
  updateTask(taskId: string, patch: PluginTeamTaskPatch): Promise<AgentTeamTask>
  /** Same-column reorder: place the task at `targetIndex` and renumber. */
  reorderTask(taskId: string, targetIndex: number): Promise<void>
  /** Assign (or reassign) a task to a teammate on the same team. */
  assignTask(taskId: string, teammateId: string): Promise<void>
  /** Append a comment to a task's board thread (author = the plugin). */
  addComment(taskId: string, text: string): Promise<AgentTaskComment | null>
  /** Attach an artifact / file / link reference to a task. */
  attachTaskFile(taskId: string, attachment: Omit<TaskCommentAttachment, "id">): Promise<void>
  /**
   * Move a task through the guarded board transitions (same `canMoveTask`
   * rules as the kanban drag). Never throws for a denial.
   */
  moveTask(taskId: string, to: TeamTaskStatus): Promise<PluginTeamMoveResult>
  /** Add a regular teammate to the roster (never the lead). */
  addTeammate(input: PluginTeamTeammateCreateInput): Promise<AgentTeammate>
  /** Patch a teammate's identity/prompt fields (whitelisted; never run state). */
  updateTeammate(teammateId: string, patch: PluginTeamTeammatePatch): Promise<AgentTeammate>
  /**
   * Remove a teammate from the roster. Returns `false` (no-op) for the lead
   * or an unknown id — mirroring the store guard.
   */
  removeTeammate(teammateId: string): Promise<boolean>
  /**
   * Replace the team's configuration (budget / governance / execution
   * pattern). Full-replace semantics, matching the store action; read the
   * current config via {@link getTeam} and patch client-side.
   */
  updateTeamConfig(teamId: string, config: AgentTeamConfig): Promise<void>
  /**
   * Turn a registered Squad template into a real Squad, with its roster and
   * pre-seeded tasks. `null` when no template carries that id.
   *
   * A plugin could already CONTRIBUTE a template through the
   * `agent-team-template` capability, and nothing could turn one into a Squad
   * except a person clicking the library. A blueprint that only a human can
   * build is not an automation surface.
   */
  instantiateTemplate(templateId: string): Promise<AgentTeam | null>

  // ------------------------------------------------------------- lifecycle
  /**
   * Create a Squad, roster lead included.
   *
   * Goes through `createSquad` (`lib/agent-team/create-squad.ts`), not the
   * store action directly. That wrapper is async precisely because resolving
   * the repository and environment bindings needs two Dexie reads and a host
   * preflight, and a plugin-created Squad deserves the same bindings a
   * hand-created one gets. A workspace with no candidates still yields a
   * Squad, reported as not ready until it is bound (ADR-0169).
   *
   * `team:write`, not `agent:dispatch`: creating spends nothing. {@link start}
   * is where tokens begin.
   */
  createTeam(input: PluginTeamCreateInput): Promise<AgentTeam>
  /**
   * Delete a Squad and its roster and board.
   *
   * `false` for an unknown id rather than a throw, the same never-throw
   * contract {@link moveTask} and {@link removeTeammate} use.
   */
  deleteTeam(teamId: string): Promise<boolean>
  /**
   * Copy a Squad, optionally into another workspace. The copy starts `idle`
   * with the lead, roster and task assignees repointed at the new ids.
   *
   * `null` when the source id is unknown.
   */
  duplicateTeam(teamId: string, input: PluginTeamDuplicateInput): Promise<AgentTeam | null>
  /**
   * Save a Squad's shape as a reusable template, and mirror it into the
   * unified template platform at write time (ADR-0100) rather than only at
   * boot. `null` when the source id is unknown.
   */
  saveAsTemplate(
    teamId: string,
    name: string,
    category?: AgentTeamTemplate["category"]
  ): Promise<AgentTeamTemplate | null>

  // ------------------------------------------------- run control (dispatch)
  /**
   * Start a run. Fire-and-forget: resolves once the run is launched, not when
   * it settles. Progress is observed through {@link getRunStatus} /
   * {@link listEvents} or the `onTeam*` hooks.
   *
   * Requires `agent:dispatch`, the same permission `ctx.agent.runTeam` takes.
   */
  start(teamId: string, options?: { goal?: string }): Promise<PluginTeamRunControlResult>
  /** Pause a live run. Requires `agent:control`. */
  pause(teamId: string): Promise<PluginTeamRunControlResult>
  /** Resume a paused run over its not-yet-done tasks. Requires `agent:control`. */
  resume(teamId: string): Promise<PluginTeamRunControlResult>
  /** Stop a run for good. Requires `agent:control`. */
  stop(teamId: string): Promise<PluginTeamRunControlResult>

  // ------------------------------------------------------------ best-of-N
  // Start and observe only. Choosing and publishing a winner is a person's
  // decision (ADR-0230): there is no select or publish here, and none may be
  // added. Reads come from the synced projection, so they work on every
  // platform; start and cancel need the executing desktop Host.
  /**
   * Start independent attempts on a new result branch. Spends tokens, so it
   * takes `agent:dispatch`, like {@link start}. Never moves an existing branch.
   */
  startBestOfN(input: PluginBestOfNStartInput): Promise<PluginBestOfNStartResult>
  /** One run, or `null`. Requires `team:read`. */
  getBestOfN(groupId: string): Promise<BestOfNPublicRun | null>
  /** Every run this device knows, newest first. Requires `team:read`. */
  listBestOfN(): Promise<BestOfNPublicRun[]>
  /** Stop every attempt of a run. Requires `agent:control`. */
  cancelBestOfN(groupId: string): Promise<PluginTeamRunControlResult>
}
