import { evaluateGate } from "@/lib/ai/eval/gate"
import { getDb } from "@/lib/db/schema"
import type { WorkflowAppDraft, WorkflowAppRelease } from "@/types/workflow/app"

type QualityGate = WorkflowAppDraft["qualityGate"]
type Evidence = NonNullable<WorkflowAppRelease["qualityGateEvidence"]>

export interface WorkflowQualityGateOverride {
  actorSubjectId: string
  isAdmin: boolean
  reason: string
}

export class WorkflowDeploymentQualityError extends Error {
  constructor(
    readonly code: "quality_gate_failed" | "quality_override_denied",
    readonly failures: string[],
    message: string
  ) {
    super(message)
    this.name = "WorkflowDeploymentQualityError"
  }
}

function validOverride(
  override: WorkflowQualityGateOverride | undefined
): override is WorkflowQualityGateOverride {
  return Boolean(
    override?.isAdmin &&
    override.actorSubjectId.trim() &&
    override.reason.trim().length >= 10 &&
    override.reason.trim().length <= 500
  )
}

export async function assertWorkflowDeploymentQuality(input: {
  workflowId: string
  versionId: string
  policy: QualityGate
  now?: number
  override?: WorkflowQualityGateOverride
}): Promise<Evidence | undefined> {
  if (!input.policy.enabled) return undefined
  const now = input.now ?? Date.now()
  const datasetId = input.policy.datasetId?.trim()
  const dataset = datasetId ? await getDb().evalDatasets.get(datasetId) : undefined
  const candidates = datasetId
    ? await getDb().evalRuns.where("datasetId").equals(datasetId).toArray()
    : []
  const report = candidates
    .filter(
      (candidate) =>
        candidate.status === "completed" &&
        candidate.scoringVersion === 2 &&
        candidate.config?.targetKind === "workflow" &&
        candidate.config.targetId === input.workflowId &&
        candidate.config.targetVersionId === input.versionId
    )
    .sort((left, right) => right.createdAt - left.createdAt)[0]
  const failures: string[] = []
  if (!datasetId || !dataset) failures.push("The configured Eval dataset was not found")
  if (!report) failures.push("No completed Eval run targets this immutable workflow version")
  if (dataset && report && report.datasetVersion !== dataset.version) {
    failures.push("The Eval run does not use the current dataset version")
  }
  if (report && now - report.createdAt > input.policy.maxRunAgeMs) {
    failures.push("The Eval run is older than the configured freshness window")
  }
  if (report) {
    failures.push(...evaluateGate(report, input.policy.thresholds).failures)
    if (
      input.policy.maxAvgLatencyMs !== undefined &&
      report.avgLatencyMs > input.policy.maxAvgLatencyMs
    ) {
      failures.push(
        `Average latency ${report.avgLatencyMs}ms exceeds ${input.policy.maxAvgLatencyMs}ms`
      )
    }
  }
  if (failures.length === 0 && report && dataset) {
    return {
      runId: report.runId,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      evaluatedAt: now,
      failures: [],
    }
  }
  if (input.override) {
    if (!validOverride(input.override)) {
      throw new WorkflowDeploymentQualityError(
        "quality_override_denied",
        failures,
        "Quality gate overrides require a verified administrator and an audit reason"
      )
    }
    return {
      ...(report ? { runId: report.runId } : {}),
      datasetId: datasetId ?? "missing",
      datasetVersion: dataset?.version ?? 0,
      evaluatedAt: now,
      failures,
      override: {
        actorSubjectId: input.override.actorSubjectId,
        reason: input.override.reason.trim(),
        at: now,
      },
    }
  }
  throw new WorkflowDeploymentQualityError(
    "quality_gate_failed",
    failures,
    `Workflow deployment quality gate failed: ${failures.join("; ")}`
  )
}
