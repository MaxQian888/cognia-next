import type { CheckRun, WorkflowRun } from "./types"

export const failedConclusion = (value: string | null) =>
  ["failure", "timed_out", "action_required", "startup_failure"].includes(value ?? "")

/** A newer execution supersedes every older state for the same check/workflow. */
export function currentCiExecutions(workflows: WorkflowRun[], checks: CheckRun[], sha: string) {
  const latestWorkflows = new Map<string | number, WorkflowRun>()
  for (const run of workflows
    .filter((run) => run.head_sha === sha)
    .sort((a, b) => b.id - a.id || (b.run_attempt ?? 1) - (a.run_attempt ?? 1))) {
    const key = run.workflow_id ?? run.name ?? run.id
    if (!latestWorkflows.has(key)) latestWorkflows.set(key, run)
  }
  const latestChecks = new Map<string, CheckRun>()
  for (const check of checks
    .filter((check) => check.head_sha === sha)
    .sort((a, b) => b.id - a.id)) {
    const key = `${check.app?.id ?? "unknown"}:${check.name}`
    if (!latestChecks.has(key)) latestChecks.set(key, check)
  }
  return { workflows: [...latestWorkflows.values()], checks: [...latestChecks.values()] }
}

export function currentCiFailures(workflows: WorkflowRun[], checks: CheckRun[], sha: string) {
  const latest = currentCiExecutions(workflows, checks, sha)
  return {
    workflows: latest.workflows.filter(
      (run) => run.status === "completed" && failedConclusion(run.conclusion)
    ),
    checks: latest.checks.filter(
      (check) => check.status === "completed" && failedConclusion(check.conclusion)
    ),
  }
}
