import { transport } from "@/lib/tauri"
import type { FleetStatus } from "@/lib/fleet/types"

export interface ManagedFleetSessionProjection {
  sessionId: string
  hostRef: string
  status: FleetStatus
  agentTeamId: string
  agentTeamRunId: string
  agentTeamChildRunId: string
  executionRunId: string
  reviewEvidenceRef?: string
  model?: string
  projectName?: string
  startedAt?: number
}

/**
 * Publish a disposable read model through the existing Fleet surface. Durable
 * AgentTeam and ExecutionRun records remain the only recovery authorities.
 */
export async function projectManagedFleetSession(
  input: ManagedFleetSessionProjection
): Promise<void> {
  await transport.call<void>("fleet_project_managed_session", { input })
}

export async function removeManagedFleetSession(sessionId: string): Promise<boolean> {
  return (await transport.call<boolean>("fleet_remove_managed_session", { sessionId })) ?? false
}
