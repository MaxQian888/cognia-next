/**
 * Eval workflow nodes.
 *
 * `eval.run` — runs one eval dataset against ONE target (chat model / team /
 * workflow; compose multiple nodes for a matrix) via the shared
 * `runEvalService` facade, outputting `{ runIds, passAt1, passHatK,
 * totalCostUsd, gatePassed? }` for downstream branching.
 *
 * `eval.gate` — pure pass/fail verdict on a previous run (wire
 * `{{ $node['<runStep>'].out.runIds[0] }}` into `runId`): param thresholds
 * override, else the dataset's stored gate. Emits decision "pass" / "fail" so
 * it can drive a branch directly.
 *
 * Recursion note: `eval.run` on a workflow target behaves like
 * `flow.subworkflow` — a self-referencing workflow is the author's
 * responsibility.
 */

import { registerNodeExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { TargetSpec } from "@/types/eval/run-config"
import type { GateThresholds } from "@/types/eval/gate"
import { runEvalService } from "@/lib/ai/eval/service"
import { evaluateGate } from "@cognia/eval-core"

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function strList(params: Record<string, unknown>, key: string): string[] | undefined {
  const v = params[key]
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0)
  return out.length > 0 ? out : undefined
}

async function loadAppSettings() {
  const { useSettingsStore } = await import("@/stores/settings/settings-store")
  return useSettingsStore.getState().settings
}

export function buildTargetSpec(params: Record<string, unknown>): TargetSpec {
  const kind = (str(params, "targetKind") ?? "chat") as TargetSpec["kind"]
  const label = str(params, "label")
  if (kind === "team") {
    const teamId = str(params, "teamId")
    if (!teamId) throw new Error("eval.run: teamId is required for a team target")
    return { kind, label: label ?? teamId, teamId }
  }
  if (kind === "workflow") {
    const workflowId = str(params, "workflowId")
    if (!workflowId) throw new Error("eval.run: workflowId is required for a workflow target")
    return { kind, label: label ?? workflowId, workflowId }
  }
  const model = str(params, "model")
  if (!model) throw new Error("eval.run: model is required for a chat target")
  const characterId = str(params, "characterId")
  return { kind: "chat", label: label ?? model, model, ...(characterId ? { characterId } : {}) }
}

registerNodeExecutor({
  kind: "eval.run",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const datasetId = str(ctx.params, "datasetId")
    if (!datasetId) throw new Error("eval.run: datasetId is required")
    const split = str(ctx.params, "split")
    const capabilities = strList(ctx.params, "capabilities")
    const kRaw = ctx.params.k
    const result = await runEvalService({
      datasetId,
      config: {
        targets: [buildTargetSpec(ctx.params)],
        scorerIds: strList(ctx.params, "scorerIds") ?? [],
        k: typeof kRaw === "number" && kRaw >= 1 ? Math.floor(kRaw) : 1,
        ...(split || capabilities
          ? { subset: { ...(split ? { split } : {}), ...(capabilities ? { capabilities } : {}) } }
          : {}),
      },
      appSettings: await loadAppSettings(),
      signal: ctx.signal,
    })
    const report = result.reports[0]
    if (!report) throw new Error("eval.run: produced no report")
    ctx.log("info", `eval.run: ${report.runId} pass@1=${report.passAt1.toFixed(3)}`)
    return {
      output: {
        runIds: result.reports.map((r) => r.runId),
        passAt1: report.passAt1,
        passHatK: report.passHatK,
        totalCostUsd: report.totalCostUsd,
        ...(result.gatePassed !== undefined ? { gatePassed: result.gatePassed } : {}),
      },
    }
  },
})

function paramThresholds(params: Record<string, unknown>): GateThresholds {
  const out: GateThresholds = {}
  for (const key of [
    "minPassAt1",
    "minPassHatK",
    "minScorerPassRate",
    "maxTotalCostUsd",
  ] as const) {
    const v = params[key]
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v
  }
  return out
}

registerNodeExecutor({
  kind: "eval.gate",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const runId = str(ctx.params, "runId")
    if (!runId) throw new Error("eval.gate: runId is required")
    const { getRun } = await import("@/lib/db/eval-runs")
    const report = await getRun(runId)
    if (!report) throw new Error(`eval.gate: run "${runId}" not found`)

    let thresholds = paramThresholds(ctx.params)
    if (Object.keys(thresholds).length === 0) {
      const { getDataset } = await import("@/lib/db/eval-datasets")
      const dataset = await getDataset(report.datasetId)
      if (!dataset?.gate) throw new Error("eval.gate: no thresholds (set params or a dataset gate)")
      thresholds = dataset.gate
    }
    const result = evaluateGate(report, thresholds)
    ctx.log(result.passed ? "info" : "warn", `eval.gate: ${result.verdict}`, result)
    // The gate itself is tri-state, but this node keeps TWO branches on
    // purpose: an `inconclusive` run routes to `fail` so a workflow never
    // proceeds on evidence it does not have. The distinction is not lost —
    // `output.verdict` and `output.inconclusiveReasons` carry it, and the log
    // line names the real verdict. A third branch handle is a separate change:
    // adding a decision value without declaring its handle silently skips
    // every downstream node.
    return { output: result, decision: result.passed ? "pass" : "fail" }
  },
})
