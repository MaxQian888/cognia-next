import { createBrowserEvalOrchestrator } from "@/lib/ai/eval/browser-execution"
import { runCalibration as runCalibrationService } from "@/lib/ai/eval/calibration/runner"
import { loadOrCreateEvalArtifactKey } from "@/lib/ai/eval/artifact-crypto"
import { EvalProjectService } from "@/lib/ai/eval/project-service"
import { SCORING_VERSION } from "@cognia/eval-core"
import { loadEvalAppSettings, loadEvalRuntimeContext } from "@/lib/ai/eval/runtime-context"
import { deterministicScorers } from "@cognia/eval-core"
import { getRunDetail, listDatasetSummaries, runEvalService } from "@/lib/ai/eval/service"
import { APP_VERSION } from "@/lib/app-version"
import type { TargetSpec } from "@/types/eval/run-config"
import { allRootPaths } from "@/lib/workspace/roots"
import { useProjectStore } from "@/stores/project/project-store"
import type {
  PluginEvalAPI,
  PluginRunDatasetArgs,
} from "@cognia/plugin-contract/lib/plugin/api/eval-api"
export type {
  PluginEvalAPI,
  PluginEvalProjectArgs,
  PluginRunCalibrationArgs,
  PluginRunDatasetArgs,
} from "@cognia/plugin-contract/lib/plugin/api/eval-api"

function knownWorkspaceRoot(cwd: string): boolean {
  const normalized = cwd.replace(/[\\/]+$/, "")
  return useProjectStore
    .getState()
    .projects.some((project) =>
      allRootPaths(project).some((root) => root.replace(/[\\/]+$/, "") === normalized)
    )
}

function buildTarget(args: PluginRunDatasetArgs): TargetSpec {
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
  if (args.cwd !== undefined && !knownWorkspaceRoot(args.cwd)) {
    throw new Error("eval_run_dataset: cwd must be a root of one of your workspaces")
  }
  return {
    kind: "chat",
    label: args.model,
    model: args.model,
    ...(args.characterId ? { characterId: args.characterId } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  }
}

export function createEvalAPI(): PluginEvalAPI {
  return {
    listDatasets: listDatasetSummaries,
    getRun: getRunDetail,
    runDataset: async (args) => {
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
        appSettings: await loadEvalAppSettings(),
      })
      const report = result.reports[0]
      if (!report) throw new Error("eval_run_dataset: produced no report")
      return {
        runIds: result.reports.map((row) => row.runId),
        targetLabel: report.targetLabel,
        passAt1: report.passAt1,
        passHatK: report.passHatK,
        totalCostUsd: report.totalCostUsd,
        ...(result.gatePassed !== undefined ? { gatePassed: result.gatePassed } : {}),
        ...(result.gates ? { gates: result.gates } : {}),
        deterministicOnly: result.deterministicOnly,
      }
    },
    runCalibration: async (args) => {
      if (!args.setId) throw new Error("eval_run_calibration: setId is required")
      const row = await runCalibrationService({
        setId: args.setId,
        appSettings: await loadEvalAppSettings(),
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
    },
    runProject: async (args) => {
      const service = new EvalProjectService()
      if (args.action === "preflight") {
        if (!args.projectId) throw new Error("eval_project_v2: projectId is required")
        return service.verifiedPreflight(args.projectId)
      }
      if (args.action === "start") {
        if (!args.projectId) throw new Error("eval_project_v2: projectId is required")
        const runtime = await loadEvalRuntimeContext()
        if (!runtime)
          throw new Error("eval_project_v2: an unlocked account and settings are required")
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
        void createBrowserEvalOrchestrator({
          appSettings: runtime.settings,
          artifactKey: await loadOrCreateEvalArtifactKey(runtime.localAccountId),
        }).run(experiment.id)
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
        const runtime = await loadEvalRuntimeContext()
        if (!runtime)
          throw new Error("eval_project_v2: an unlocked account and settings are required")
        await service.resume(args.experimentId)
        void createBrowserEvalOrchestrator({
          appSettings: runtime.settings,
          artifactKey: await loadOrCreateEvalArtifactKey(runtime.localAccountId),
        }).run(args.experimentId)
      }
      return args.action === "report"
        ? service.report(args.experimentId)
        : service.status(args.experimentId)
    },
  }
}
