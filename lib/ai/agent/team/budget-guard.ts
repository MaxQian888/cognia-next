/**
 * Placeholder — real implementation lands in PR 2 Task 2.3.
 * Defined here so team-run-context.ts can import the type contract.
 */

import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"

export type BudgetEventName =
  | "warning_crossed"
  | "critical_crossed"
  | "pause_for_review"
  | "entered_background_mode"

export interface BudgetGuard {
  add(usage: SubAgentTokenUsage): void
  status(): { used: number; limit: number; level: "ok" | "warning" | "critical" }
  extendLimit(extraTokens: number): void
  on(event: BudgetEventName, cb: (payload: { runId: string }) => void): () => void
}
