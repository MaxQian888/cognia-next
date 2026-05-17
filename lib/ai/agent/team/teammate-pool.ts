/**
 * Placeholder — real implementation lands in PR 2 Task 2.2.
 * Defined here so team-run-context.ts can import the type contract.
 */

import type { AgentTeammate } from "@/types/agent/agent-team"

export type TeammateFailureKind =
  | "ordinary"
  | "rate_limited"
  | "catastrophic"
  | "empty_output"
  | "refusal"

export interface TeammatePool {
  claim(taskId: string): AgentTeammate | null
  recordSuccess(teammateId: string): void
  recordFailure(teammateId: string, error: unknown): void
  availableCount(): number
  isDisqualified(teammateId: string): boolean
  allUnavailable(): boolean
  onAllUnavailable(cb: () => void): () => void
  onTeammateDisqualified(cb: (teammateId: string, reason: TeammateFailureKind) => void): () => void
  forceUnquarantine(input: { teammateIds?: string[]; resetAll?: boolean }): void
  rejoin(teammateId: string): void
}
