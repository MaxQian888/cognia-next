/**
 * The plugin contract's share of `lib/plugin/api/eval-api.ts`, which re-exports these.
 */
import type { EvalDatasetSummary, EvalRunDetail } from "../../ai/eval/service"

export interface PluginRunDatasetArgs {
  datasetId: string
  targetKind?: "chat" | "team" | "workflow"
  model?: string
  characterId?: string
  teamId?: string
  workflowId?: string
  scorerIds?: string[]
  k?: number
  split?: string
  capabilities?: string[]
  /**
   * Working directory of a chat target: which repository's instruction files,
   * agent files and project settings the run loads. Must be a root of one of
   * the user's workspaces, so a run against a candidate configuration and one
   * against the current configuration differ in nothing else.
   */
  cwd?: string
}

export interface PluginRunCalibrationArgs {
  setId: string
  judgeModel?: string
}

export interface PluginEvalProjectArgs {
  action:
    "preflight" | "start" | "pause" | "resume" | "cancel" | "status" | "report" | "extend-budget"
  projectId?: string
  experimentId?: string
  budgetCap?: number
}

export interface PluginEvalAPI {
  listDatasets(): Promise<EvalDatasetSummary[]>
  getRun(runId: string): Promise<EvalRunDetail | undefined>
  runDataset(args: PluginRunDatasetArgs): Promise<unknown>
  runCalibration(args: PluginRunCalibrationArgs): Promise<unknown>
  runProject(args: PluginEvalProjectArgs): Promise<unknown>
}
