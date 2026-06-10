/**
 * Agent Eval — built-in plugin.
 *
 * Exposes the eval engine (`lib/ai/eval/service.ts`) as agent tools so the
 * in-chat agent / Agent Team can run datasets and read results:
 *   * `eval_list_datasets`  — dataset summaries (id, capability, case count, latest run)
 *   * `eval_run_dataset`    — run a dataset against one target; returns rates + gate
 *   * `eval_get_run`        — full report + per-case verdicts for one run
 *   * `eval_run_calibration` — calibrate a judge against a human-labeled set;
 *     returns agreement metrics (Cohen's κ, TPR/TNR, …) so the agent can report
 *     how trustworthy a judge is (eval spec §10)
 *
 * Goes through the standard plugin permission gates; no extra permission kind
 * (runs cost the user's own tokens, same trust tier as the ocr tool).
 */

import type { PluginContext, PluginDefinition } from "@/types/plugin"
import { getRunDetail, listDatasetSummaries, runEvalService } from "@/lib/ai/eval/service"
import { runCalibration } from "@/lib/ai/eval/calibration/runner"
import type { TargetSpec } from "@/types/eval/run-config"

export interface RunDatasetArgs {
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
}

function buildTarget(args: RunDatasetArgs): TargetSpec {
  const kind = args.targetKind ?? "chat"
  if (kind === "team") {
    if (!args.teamId) throw new Error("eval_run_dataset: teamId is required for a team target")
    return { kind, label: args.teamId, teamId: args.teamId }
  }
  if (kind === "workflow") {
    if (!args.workflowId) {
      throw new Error("eval_run_dataset: workflowId is required for a workflow target")
    }
    return { kind, label: args.workflowId, workflowId: args.workflowId }
  }
  if (!args.model) throw new Error("eval_run_dataset: model is required for a chat target")
  return {
    kind: "chat",
    label: args.model,
    model: args.model,
    ...(args.characterId ? { characterId: args.characterId } : {}),
  }
}

async function loadAppSettings() {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  return useSettingsStore.getState().settings
}

export async function runEvalDatasetTool(args: RunDatasetArgs) {
  if (!args.datasetId) throw new Error("eval_run_dataset: datasetId is required")
  const result = await runEvalService({
    datasetId: args.datasetId,
    config: {
      targets: [buildTarget(args)],
      scorerIds: args.scorerIds ?? [],
      k: typeof args.k === "number" && args.k >= 1 ? Math.floor(args.k) : 1,
      ...(args.split || args.capabilities?.length
        ? {
            subset: {
              ...(args.split ? { split: args.split } : {}),
              ...(args.capabilities?.length ? { capabilities: args.capabilities } : {}),
            },
          }
        : {}),
    },
    appSettings: await loadAppSettings(),
  })
  const report = result.reports[0]
  if (!report) throw new Error("eval_run_dataset: produced no report")
  return {
    runIds: result.reports.map((r) => r.runId),
    targetLabel: report.targetLabel,
    passAt1: report.passAt1,
    passHatK: report.passHatK,
    totalCostUsd: report.totalCostUsd,
    ...(result.gatePassed !== undefined ? { gatePassed: result.gatePassed } : {}),
    ...(result.gates ? { gates: result.gates } : {}),
    deterministicOnly: result.deterministicOnly,
  }
}

export interface RunCalibrationArgs {
  setId: string
  judgeModel?: string
}

export async function runCalibrationTool(args: RunCalibrationArgs) {
  if (!args.setId) throw new Error("eval_run_calibration: setId is required")
  const row = await runCalibration({
    setId: args.setId,
    appSettings: await loadAppSettings(),
    ...(args.judgeModel ? { judgeModel: args.judgeModel } : {}),
  })
  return {
    runId: row.runId,
    criterion: row.criterion,
    judgeModel: row.judgeModel,
    itemCount: row.itemCount,
    scoredCount: row.scoredCount,
    erroredCount: row.erroredCount,
    metrics: row.metrics,
  }
}

const LIST_DEF = {
  name: "eval_list_datasets",
  description:
    "List agent eval datasets: id, name, capability, version, case count, and the latest run's pass@1.",
  parametersSchema: { type: "object", properties: {}, additionalProperties: false },
} as const

const RUN_DEF = {
  name: "eval_run_dataset",
  description:
    "Run an eval dataset against a target (chat model, team, or workflow) and return pass@1 / pass^k, cost, and the gate verdict. Runs consume LLM tokens.",
  parametersSchema: {
    type: "object",
    properties: {
      datasetId: { type: "string", description: "Dataset id from eval_list_datasets." },
      targetKind: {
        type: "string",
        enum: ["chat", "team", "workflow"],
        description: "Default: chat.",
      },
      model: { type: "string", description: "Chat target model id (required for chat)." },
      characterId: { type: "string" },
      teamId: { type: "string", description: "Required for targetKind=team." },
      workflowId: { type: "string", description: "Required for targetKind=workflow." },
      scorerIds: {
        type: "array",
        items: { type: "string" },
        description: "Empty = all scorers.",
      },
      k: { type: "number", description: "Repetitions per case (pass^k). Default 1." },
      split: { type: "string" },
      capabilities: { type: "array", items: { type: "string" } },
    },
    required: ["datasetId"],
    additionalProperties: false,
  },
} as const

const GET_DEF = {
  name: "eval_get_run",
  description: "Fetch one eval run: the aggregated report plus per-case scorer verdicts.",
  parametersSchema: {
    type: "object",
    properties: { runId: { type: "string" } },
    required: ["runId"],
    additionalProperties: false,
  },
} as const

const CALIBRATE_DEF = {
  name: "eval_run_calibration",
  description:
    "Calibrate an LLM-judge against a human-labeled set and return agreement metrics (Cohen's κ, TPR/TNR, precision, F1, accuracy). Use to report how trustworthy a judge+rubric is. Consumes LLM tokens.",
  parametersSchema: {
    type: "object",
    properties: {
      setId: { type: "string", description: "Calibration set id." },
      judgeModel: {
        type: "string",
        description: "Override the judge model (cross-model). Default: resolver's choice.",
      },
    },
    required: ["setId"],
    additionalProperties: false,
  },
} as const

export const evalPluginDefinition: PluginDefinition = {
  manifest: {
    id: "cognia-eval",
    name: "Agent Eval",
    version: "0.1.0",
    type: "frontend",
    capabilities: ["tools"],
    main: "src/index.ts",
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("eval plugin activated")
    ctx.agent?.registerTool?.({
      name: LIST_DEF.name,
      pluginId: ctx.pluginId,
      definition: LIST_DEF as never,
      execute: async () => listDatasetSummaries(),
    })
    ctx.agent?.registerTool?.({
      name: RUN_DEF.name,
      pluginId: ctx.pluginId,
      definition: RUN_DEF as never,
      execute: async (args: Record<string, unknown>) =>
        runEvalDatasetTool(args as unknown as RunDatasetArgs),
    })
    ctx.agent?.registerTool?.({
      name: GET_DEF.name,
      pluginId: ctx.pluginId,
      definition: GET_DEF as never,
      execute: async (args: Record<string, unknown>) => {
        const runId = typeof args.runId === "string" ? args.runId : ""
        const detail = await getRunDetail(runId)
        if (!detail) throw new Error(`eval_get_run: run "${runId}" not found`)
        return detail
      },
    })
    ctx.agent?.registerTool?.({
      name: CALIBRATE_DEF.name,
      pluginId: ctx.pluginId,
      definition: CALIBRATE_DEF as never,
      execute: async (args: Record<string, unknown>) =>
        runCalibrationTool(args as unknown as RunCalibrationArgs),
    })
  },
  deactivate: async () => {},
}

export default evalPluginDefinition
