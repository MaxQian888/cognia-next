/**
 * Squad (Agent Team) API surface, published as `@cognia/plugin-sdk/api/team`.
 *
 * `ctx.team` had reached authors as types only, through `./context`, while its
 * neighbours name their own subpath in their own headers (see
 * `lib/plugin/api/scheduler-tasks.ts`). ADR-0156 makes the published set an
 * explicit allowlist, so a capability without an entry is one an author has to
 * go find in the host tree.
 *
 * Runtime operations live on `ctx.team`. What ships here is the shape of that
 * surface plus the domain vocabulary an author needs to satisfy it, which is
 * why every export below is a type: the host owns the behaviour.
 */

export type {
  PluginTeamAPI,
  PluginTeamCreateInput,
  PluginTeamDuplicateInput,
  PluginTeamMoveResult,
  PluginTeamRunControlResult,
  PluginTeamRunStatus,
  PluginTeamTaskCreateInput,
  PluginTeamTaskPatch,
  PluginTeamTeammateCreateInput,
  PluginTeamTeammatePatch,
} from "@/lib/plugin/api/team-api"

export type {
  AgentTaskComment,
  AgentTeam,
  AgentTeamConfig,
  AgentTeamEvent,
  AgentTeammate,
  AgentTeamTask,
  AgentTeamTemplate,
  TaskCommentAttachment,
  TeamExecutionCheckpoint,
  TeamExecutionReport,
  TeamStatus,
  TeamTaskStatus,
} from "@/types/agent/agent-team"
