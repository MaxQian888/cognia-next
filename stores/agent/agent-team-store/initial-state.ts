import {
  DEFAULT_TEAM_CONFIG,
  BUILT_IN_TEAM_TEMPLATES,
  type AgentTeam,
  type AgentTeammate,
  type AgentTeamTask,
  type AgentTeamMessage,
  type AgentTeamTemplate,
  type AgentTeamEvent,
  type TeamDisplayMode,
  type AgentTeamWorkspaceFocus,
  type ConsensusRequest,
  type SharedMemoryEntry,
  type TeamDelegationRecord,
} from "@/types/agent/agent-team"

export const builtInTemplatesMap = BUILT_IN_TEAM_TEMPLATES.reduce(
  (acc: Record<string, AgentTeamTemplate>, template: AgentTeamTemplate) => ({
    ...acc,
    [template.id]: template,
  }),
  {} as Record<string, AgentTeamTemplate>
)

export const initialState = {
  teams: {} as Record<string, AgentTeam>,
  teammates: {} as Record<string, AgentTeammate>,
  tasks: {} as Record<string, AgentTeamTask>,
  messages: {} as Record<string, AgentTeamMessage>,
  templates: builtInTemplatesMap,
  events: [] as AgentTeamEvent[],
  consensus: {} as Record<string, ConsensusRequest>,
  sharedMemory: {} as Record<string, Record<string, SharedMemoryEntry>>,
  delegations: {} as Record<string, TeamDelegationRecord>,
  activeTeamId: null as string | null,
  selectedTeammateId: null as string | null,
  displayMode: "expanded" as TeamDisplayMode,
  isPanelOpen: false,
  workspaceTab: "overview" as const,
  tasksView: "list" as const,
  workspaceFocus: {
    teammateId: null,
    taskId: null,
    messageId: null,
  } as AgentTeamWorkspaceFocus,
  workspaceDetailOpen: true,
  defaultConfig: { ...DEFAULT_TEAM_CONFIG },
  // Per-(teamId, adapterId) cursor of the last shared-memory version pulled
  // from a shared-memory adapter. Persisted so reverse sync resumes
  // incrementally across reloads.
  lastAdapterSyncVersion: {} as Record<string, Record<string, number>>,
}
