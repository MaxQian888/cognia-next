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
import type {
  PluginEvalProjectArgs as EvalProjectV2Args,
  PluginRunCalibrationArgs as RunCalibrationArgs,
  PluginRunDatasetArgs as RunDatasetArgs,
} from "@cognia/plugin-sdk/api/eval"

let evalApi: PluginContext["eval"] | undefined

function requireEvalAPI(): PluginContext["eval"] {
  if (!evalApi) throw new Error("Eval plugin context is unavailable")
  return evalApi
}

export const runEvalDatasetTool = (args: RunDatasetArgs) => requireEvalAPI().runDataset(args)
export const runCalibrationTool = (args: RunCalibrationArgs) =>
  requireEvalAPI().runCalibration(args)
export const runEvalProjectV2Tool = (args: EvalProjectV2Args) => requireEvalAPI().runProject(args)

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
    permissions: ["tests:run", "ai:chat", "database:read", "database:write"],
  } as never,
  activate: async (ctx: PluginContext) => {
    ctx.logger?.info("eval plugin activated")
    evalApi = ctx.eval
    ctx.agent?.registerTool?.({
      name: LIST_DEF.name,
      pluginId: ctx.pluginId,
      definition: LIST_DEF as never,
      execute: async () => ctx.eval.listDatasets(),
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
        const detail = await ctx.eval.getRun(runId)
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
  deactivate: async () => {
    evalApi = undefined
  },
}

export default evalPluginDefinition
