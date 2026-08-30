/**
 * Eval run configuration — the target matrix × scorer subset × repetitions ×
 * case subset that `lib/ai/eval/run-config.ts:runConfiguredEval` expands into
 * one pinned {@link import("./eval").EvalReport} per target variant.
 */

export type TargetKind = "chat" | "team" | "workflow" | "twin"

export interface ChatTargetSpec {
  kind: "chat"
  label: string
  providerId?: string
  model: string
  characterId?: string
  cwd?: string
  timeoutMs?: number
}

export interface TeamTargetSpec {
  kind: "team"
  label: string
  teamId: string
  timeoutMs?: number
}

export interface WorkflowTargetSpec {
  kind: "workflow"
  label: string
  workflowId: string
  /** Immutable workflow version used by deployment-quality evidence. */
  versionId?: string
  timeoutMs?: number
}

export interface TwinTargetSpec {
  kind: "twin"
  label: string
  twinId: string
  providerId?: string
  model: string
  timeoutMs?: number
}

export type TargetSpec = ChatTargetSpec | TeamTargetSpec | WorkflowTargetSpec | TwinTargetSpec

/** Case-subset selector applied before a run. All fields are AND-combined. */
export interface CaseSubset {
  split?: string
  capabilities?: string[]
  failureModes?: string[]
  caseIds?: string[]
}

export interface EvalRunConfig {
  targets: TargetSpec[]
  /** Scorer ids to apply; empty = all available. */
  scorerIds: string[]
  k: number
  subset?: CaseSubset
}

/** Compact echo of the variant stored on a produced report. */
export interface EvalRunConfigSummary {
  targetKind: TargetKind
  targetId?: string
  targetVersionId?: string
  scorerIds: string[]
  k: number
  subset?: CaseSubset
}
