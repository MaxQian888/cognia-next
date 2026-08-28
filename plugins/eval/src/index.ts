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

import type { PluginContext, PluginDefinition } from "@cognia/plugin-sdk"
import {
  createBrowserEvalOrchestrator,
  deterministicScorers,
  EvalProjectService,
  getRunDetail,
  listDatasetSummaries,
  loadEvalAppSettings,
  loadEvalRuntimeContext,
  loadOrCreateEvalArtifactKey,
  runCalibration,
  runEvalService,
  SCORING_VERSION,
  type TargetSpec,
} from "@cognia/plugin-sdk/api/eval"
import { APP_VERSION } from "@cognia/plugin-sdk/api/host-environment"
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
  return loadEvalAppSettings()
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

export interface EvalProjectV2Args {
  action:
    "preflight" | "start" | "pause" | "resume" | "cancel" | "status" | "report" | "extend-budget"
  projectId?: string
  experimentId?: string
  budgetCap?: number
}

async function loadEvalRuntime() {
  const runtime = await loadEvalRuntimeContext()
  if (!runtime) throw new Error("eval_project_v2: an unlocked account and settings are required")
  return runtime
}

export async function runEvalProjectV2Tool(args: EvalProjectV2Args) {
  const service = new EvalProjectService()
  if (args.action === "preflight") {
    if (!args.projectId) throw new Error("eval_project_v2: projectId is required")
    return service.verifiedPreflight(args.projectId)
  }
  if (args.action === "start") {
    if (!args.projectId) throw new Error("eval_project_v2: projectId is required")
    const { settings, accountId } = await loadEvalRuntime()
    const verified = await service.verifiedPreflight(args.projectId)
    if (!verified.result.ok) return verified
    const experiment = await service.start(args.projectId, {
      appVersion: APP_VERSION,
      scorerVersions: Object.fromEntries(
        deterministicScorers().map((scorer) => [scorer.id, String(SCORING_VERSION)])
      ),
      randomSeed: crypto.getRandomValues(new Uint32Array(1))[0],
      environmentCompatibility: verified.environmentCompatibility,
    })
    const orchestrator = createBrowserEvalOrchestrator({
      appSettings: settings,
      artifactKey: await loadOrCreateEvalArtifactKey(accountId),
    })
    void orchestrator.run(experiment.id)
    return { experimentId: experiment.id, state: experiment.state }
  }
  if (!args.experimentId) throw new Error("eval_project_v2: experimentId is required")
  if (args.action === "pause") await service.pause(args.experimentId)
  if (args.action === "cancel") await service.cancel(args.experimentId)
  if (args.action === "extend-budget") {
    if (typeof args.budgetCap !== "number") {
      throw new Error("eval_project_v2: budgetCap is required for extend-budget")
    }
    await service.extendBudget(args.experimentId, args.budgetCap)
  }
  if (args.action === "resume") {
    const { settings, accountId } = await loadEvalRuntime()
    await service.resume(args.experimentId)
    void createBrowserEvalOrchestrator({
      appSettings: settings,
      artifactKey: await loadOrCreateEvalArtifactKey(accountId),
    }).run(args.experimentId)
  }
  return args.action === "report"
    ? service.report(args.experimentId)
    : service.status(args.experimentId)
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

const PROJECT_V2_DEF = {
  name: "eval_project_v2",
  description:
    "Versioned durable evaluation project API: preflight, start, pause, resume, cancel, status, report, and budget extension.",
  parametersSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "preflight",
          "start",
          "pause",
          "resume",
          "cancel",
          "status",
          "report",
          "extend-budget",
        ],
      },
      projectId: { type: "string" },
      experimentId: { type: "string" },
      budgetCap: { type: "number" },
    },
    required: ["action"],
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
      name: PROJECT_V2_DEF.name,
      pluginId: ctx.pluginId,
      definition: PROJECT_V2_DEF as never,
      execute: async (args: Record<string, unknown>) =>
        runEvalProjectV2Tool(args as unknown as EvalProjectV2Args),
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
