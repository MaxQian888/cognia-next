/**
 * Agent Eval — built-in plugin.
 *
 * Exposes the eval engine (`ctx.eval`) as agent tools so the in-chat agent /
 * Agent Team can run datasets and read results:
 *   * `eval_list_datasets`   — dataset summaries (id, capability, case count, latest run)
 *   * `eval_run_dataset`     — run a dataset against one target; returns rates + gate
 *   * `eval_get_run`         — full report + per-case verdicts for one run
 *   * `eval_run_calibration` — calibrate a judge against a human-labeled set;
 *     returns agreement metrics (Cohen's κ, TPR/TNR, …) so the agent can report
 *     how trustworthy a judge is (eval spec §10)
 *   * `eval_project_v2`      — the durable, versioned evaluation-project API
 *
 * Runs spend the user's own tokens, so every tool that can start or extend one
 * requires approval and carries a budget far past the 30 s tool default.
 *
 * Cancellation: `ctx.eval` takes no AbortSignal yet, so a started run cannot be
 * stopped from here. The tools refuse to START when the call is already
 * cancelled; a run that did start keeps going and is persisted, and
 * `eval_list_datasets` / `eval_get_run` read it back.
 */

import {
  definePlugin,
  definePluginManifest,
  definePluginTool,
  type PluginContext,
  type PluginToolContext,
  type PluginToolRegistration,
} from "@cognia/plugin-sdk"
import type {
  PluginEvalProjectArgs,
  PluginRunCalibrationArgs,
  PluginRunDatasetArgs,
} from "@cognia/plugin-sdk/api/eval"
import manifestJson from "../plugin.json"

type EvalAPI = PluginContext["eval"]
type Failure = { ok: false; error: string }

/** A dataset run or a calibration: many model calls, well past 30 s. */
export const EVAL_RUN_TIMEOUT_MS = 600_000
/** Project actions return once the host has queued / updated the experiment. */
export const EVAL_PROJECT_TIMEOUT_MS = 120_000
/** Upper bound on pass^k repetitions — each one re-runs every case. */
export const EVAL_MAX_K = 10

const TARGET_KINDS = ["chat", "team", "workflow"] as const
const PROJECT_ACTIONS = [
  "preflight",
  "start",
  "pause",
  "resume",
  "cancel",
  "status",
  "report",
  "extend-budget",
] as const

function failure(error: string): Failure {
  return { ok: false, error }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined | null {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null
  return value as string[]
}

/** Parse `eval_run_dataset` args, or say exactly what is wrong. */
export function parseRunDatasetArgs(args: Record<string, unknown>): PluginRunDatasetArgs | Failure {
  const datasetId = optionalString(args.datasetId)
  if (!datasetId) return failure("eval_run_dataset: datasetId is required")
  const targetKind = args.targetKind ?? "chat"
  if (!TARGET_KINDS.includes(targetKind as (typeof TARGET_KINDS)[number])) {
    return failure(`eval_run_dataset: targetKind must be one of ${TARGET_KINDS.join(", ")}`)
  }
  let k: number | undefined
  if (args.k !== undefined) {
    if (
      typeof args.k !== "number" ||
      !Number.isInteger(args.k) ||
      args.k < 1 ||
      args.k > EVAL_MAX_K
    ) {
      return failure(`eval_run_dataset: k must be an integer from 1 to ${EVAL_MAX_K}`)
    }
    k = args.k
  }
  const scorerIds = stringList(args.scorerIds)
  if (scorerIds === null) return failure("eval_run_dataset: scorerIds must be an array of strings")
  const capabilities = stringList(args.capabilities)
  if (capabilities === null) {
    return failure("eval_run_dataset: capabilities must be an array of strings")
  }
  const model = optionalString(args.model)
  const characterId = optionalString(args.characterId)
  const teamId = optionalString(args.teamId)
  const workflowId = optionalString(args.workflowId)
  const split = optionalString(args.split)
  return {
    datasetId,
    targetKind: targetKind as PluginRunDatasetArgs["targetKind"],
    ...(model ? { model } : {}),
    ...(characterId ? { characterId } : {}),
    ...(teamId ? { teamId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(scorerIds ? { scorerIds } : {}),
    ...(k !== undefined ? { k } : {}),
    ...(split ? { split } : {}),
    ...(capabilities ? { capabilities } : {}),
  }
}

/** Parse `eval_project_v2` args, or say exactly what is wrong. */
export function parseProjectArgs(args: Record<string, unknown>): PluginEvalProjectArgs | Failure {
  const action = args.action
  if (!PROJECT_ACTIONS.includes(action as (typeof PROJECT_ACTIONS)[number])) {
    return failure(`eval_project_v2: action must be one of ${PROJECT_ACTIONS.join(", ")}`)
  }
  const projectId = optionalString(args.projectId)
  const experimentId = optionalString(args.experimentId)
  if ((action === "preflight" || action === "start") && !projectId) {
    return failure(`eval_project_v2: projectId is required for ${String(action)}`)
  }
  if (action !== "preflight" && action !== "start" && !experimentId) {
    return failure(`eval_project_v2: experimentId is required for ${String(action)}`)
  }
  let budgetCap: number | undefined
  if (action === "extend-budget") {
    if (
      typeof args.budgetCap !== "number" ||
      !Number.isFinite(args.budgetCap) ||
      args.budgetCap <= 0
    ) {
      return failure("eval_project_v2: budgetCap must be a positive number for extend-budget")
    }
    budgetCap = args.budgetCap
  }
  return {
    action: action as PluginEvalProjectArgs["action"],
    ...(projectId ? { projectId } : {}),
    ...(experimentId ? { experimentId } : {}),
    ...(budgetCap !== undefined ? { budgetCap } : {}),
  }
}

/**
 * Run `work` unless the caller already cancelled, collapsing a host rejection
 * into the `{ ok: false }` envelope the model can act on.
 */
async function guarded(
  tool: string,
  callCtx: PluginToolContext,
  work: () => Promise<unknown>
): Promise<unknown> {
  if (callCtx.signal?.aborted) return failure(`${tool}: the call was cancelled before it started`)
  try {
    return await work()
  } catch (err) {
    const message = errorMessage(err)
    return failure(message.startsWith(`${tool}:`) ? message : `${tool}: ${message}`)
  }
}

const LIST_SCHEMA = { type: "object", properties: {}, additionalProperties: false }

const RUN_DATASET_SCHEMA = {
  type: "object",
  properties: {
    datasetId: { type: "string", description: "Dataset id from eval_list_datasets." },
    targetKind: {
      type: "string",
      enum: [...TARGET_KINDS],
      description: "What the dataset runs against. Default: chat.",
    },
    model: { type: "string", description: "Chat target model id (required for chat)." },
    characterId: { type: "string", description: "Optional character for a chat target." },
    teamId: { type: "string", description: "Required for targetKind=team." },
    workflowId: { type: "string", description: "Required for targetKind=workflow." },
    scorerIds: {
      type: "array",
      items: { type: "string" },
      description: "Scorers to apply. Empty or omitted = all scorers.",
    },
    k: {
      type: "integer",
      minimum: 1,
      maximum: EVAL_MAX_K,
      description: `Repetitions per case (pass^k), 1–${EVAL_MAX_K}. Default 1. Cost scales with k.`,
    },
    split: { type: "string", description: "Run only the cases in this dataset split." },
    capabilities: {
      type: "array",
      items: { type: "string" },
      description: "Run only the cases tagged with these capabilities.",
    },
  },
  required: ["datasetId"],
  additionalProperties: false,
}

const GET_RUN_SCHEMA = {
  type: "object",
  properties: { runId: { type: "string", description: "Run id from eval_run_dataset." } },
  required: ["runId"],
  additionalProperties: false,
}

const CALIBRATION_SCHEMA = {
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
}

const PROJECT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...PROJECT_ACTIONS],
      description:
        "preflight: verify a project can run (projectId). start: verify, then start a new experiment in the background and return its experimentId (projectId). pause / resume / cancel: control a running experiment (experimentId). status: progress and spend so far (experimentId). report: the finished report (experimentId). extend-budget: raise the experiment's spend cap to budgetCap (experimentId).",
    },
    projectId: {
      type: "string",
      description: "Evaluation project id. Required for preflight and start.",
    },
    experimentId: {
      type: "string",
      description:
        "Experiment id returned by start. Required for every action except preflight and start.",
    },
    budgetCap: {
      type: "number",
      exclusiveMinimum: 0,
      description:
        "extend-budget only: the new hard spend cap, in the project's budget currency (usually USD). Must exceed the current cap.",
    },
  },
  required: ["action"],
  additionalProperties: false,
}

export const EVAL_TOOL_NAMES = [
  "eval_list_datasets",
  "eval_run_dataset",
  "eval_get_run",
  "eval_run_calibration",
  "eval_project_v2",
] as const

export function buildEvalTools(evalApi: EvalAPI): PluginToolRegistration[] {
  return [
    definePluginTool({
      name: "eval_list_datasets",
      definition: {
        name: "eval_list_datasets",
        description:
          "List agent eval datasets: id, name, capability, version, case count, and the latest run's pass@1.",
        parametersSchema: LIST_SCHEMA,
      },
      execute: (_args, callCtx) =>
        guarded("eval_list_datasets", callCtx, () => evalApi.listDatasets()),
    }),
    definePluginTool({
      name: "eval_run_dataset",
      definition: {
        name: "eval_run_dataset",
        description:
          "Run an eval dataset against a target (chat model, team, or workflow) and return pass@1 / pass^k, cost, and the gate verdict. Runs consume LLM tokens and can take minutes.",
        requiresApproval: true,
        timeoutMs: EVAL_RUN_TIMEOUT_MS,
        parametersSchema: RUN_DATASET_SCHEMA,
      },
      execute: (args, callCtx) =>
        guarded("eval_run_dataset", callCtx, async () => {
          const parsed = parseRunDatasetArgs(args)
          if ("ok" in parsed) return parsed
          return evalApi.runDataset(parsed)
        }),
    }),
    definePluginTool({
      name: "eval_get_run",
      definition: {
        name: "eval_get_run",
        description: "Fetch one eval run: the aggregated report plus per-case scorer verdicts.",
        parametersSchema: GET_RUN_SCHEMA,
      },
      execute: (args, callCtx) =>
        guarded("eval_get_run", callCtx, async () => {
          const runId = optionalString(args.runId)
          if (!runId) return failure("eval_get_run: runId is required")
          const detail = await evalApi.getRun(runId)
          if (!detail) {
            return failure(
              `eval_get_run: no run "${runId}" — take a run id from eval_run_dataset or eval_list_datasets`
            )
          }
          return detail
        }),
    }),
    definePluginTool({
      name: "eval_run_calibration",
      definition: {
        name: "eval_run_calibration",
        description:
          "Calibrate an LLM-judge against a human-labeled set and return agreement metrics (Cohen's κ, TPR/TNR, precision, F1, accuracy). Use to report how trustworthy a judge+rubric is. Consumes LLM tokens.",
        requiresApproval: true,
        timeoutMs: EVAL_RUN_TIMEOUT_MS,
        parametersSchema: CALIBRATION_SCHEMA,
      },
      execute: (args, callCtx) =>
        guarded("eval_run_calibration", callCtx, async () => {
          const setId = optionalString(args.setId)
          if (!setId) return failure("eval_run_calibration: setId is required")
          const judgeModel = optionalString(args.judgeModel)
          const request: PluginRunCalibrationArgs = { setId, ...(judgeModel ? { judgeModel } : {}) }
          return evalApi.runCalibration(request)
        }),
    }),
    definePluginTool({
      name: "eval_project_v2",
      definition: {
        name: "eval_project_v2",
        description:
          "Durable, versioned evaluation projects: preflight, start, pause, resume, cancel, status, report, and extend-budget. start / resume run experiments in the background and spend tokens against the project's budget.",
        requiresApproval: true,
        timeoutMs: EVAL_PROJECT_TIMEOUT_MS,
        parametersSchema: PROJECT_SCHEMA,
      },
      execute: (args, callCtx) =>
        guarded("eval_project_v2", callCtx, async () => {
          const parsed = parseProjectArgs(args)
          if ("ok" in parsed) return parsed
          return evalApi.runProject(parsed)
        }),
    }),
  ]
}

// plugin.json is the manifest source of truth; the tools register
// imperatively in `activate`.
export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate: (ctx) => {
    for (const tool of buildEvalTools(ctx.eval)) ctx.agent.registerTool(tool)
    ctx.logger.info("eval plugin activated")
  },
})
