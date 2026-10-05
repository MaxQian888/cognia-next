/**
 * Durable local AgentTeam runtime contracts. The run, child, trajectory,
 * checkpoint and steering records are owned by `@cognia/agent-orchestration`
 * (ADR-0217); this module binds the run record to the app's launch authority
 * (`AgentTeamExecutionConstraints`), which references app configuration types
 * the orchestration core never reads.
 */

import type { AgentTeamRunRecord as OrchestrationRunRecord } from "@cognia/agent-orchestration/records"

export * from "@cognia/agent-orchestration/records"

/** Explicit allowlist: never persist provider credentials with launch authority. */
export const AGENT_TEAM_SECURITY_CONFIG_KEYS = [
  "repositories",
  "environmentRef",
  "workingDir",
  "writeMode",
  "workspaceIsolation",
  "allowedTools",
  "disallowedTools",
  "defaultPermissionMode",
  "sandboxEnabled",
  "sandboxPolicy",
  "requirePlanApproval",
  "riskGating",
  "governancePolicy",
  "taskReview",
  "evidencePolicy",
  "githubDeliveryPolicy",
  "resourcePolicy",
  "userConstraints",
] as const satisfies readonly (keyof import("./agent-team").AgentTeamConfig)[]

/** Serializable launch authority. Missing snapshots must never resume with wider defaults. */
export interface AgentTeamExecutionConstraints {
  version: 1
  origin: string
  triggeredFrom: import("@/types/workflow/visual").WorkflowTriggeredFrom
  permissionCeiling?: import("@/types/agent/permission-ceiling").AgentPermissionCeiling
  sessionId?: string
  sessionWorkingDir?: string
  requirePlanApprovalFloor: boolean
  entryPersona?: { id: string; name: string; systemPrompt: string }
  ultracode?: boolean
  teamConfig?: Pick<
    import("./agent-team").AgentTeamConfig,
    (typeof AGENT_TEAM_SECURITY_CONFIG_KEYS)[number]
  >
}

/** One durable team run, with the app's launch authority. */
export type AgentTeamRunRecord = OrchestrationRunRecord<AgentTeamExecutionConstraints>
