import { getDb } from "@/lib/db/schema"
import type { WorkflowAppRelease } from "@/types/workflow/app"

export class WorkflowAppQuotaError extends Error {
  constructor(
    readonly code:
      | "request_rate_exhausted"
      | "concurrency_exhausted"
      | "token_budget_exhausted"
      | "cost_budget_exhausted"
      | "cost_budget_unknown",
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = "WorkflowAppQuotaError"
  }
}

export async function assertWorkflowAppAdmissionQuota(input: {
  appId: string
  accountId: string
  release: WorkflowAppRelease
  now: number
}): Promise<void> {
  const quota = input.release.snapshot.quota
  if (Object.values(quota).every((value) => value === undefined)) return
  const prefix = `app:${input.appId}:release:`
  const invocations = await getDb()
    .workflowInvocations.filter(
      (invocation) =>
        invocation.accountId === input.accountId && invocation.caller.startsWith(prefix)
    )
    .toArray()

  if (quota.requestsPerMinute !== undefined) {
    const cutoff = input.now - 60_000
    const recent = invocations.filter((invocation) => invocation.createdAt > cutoff)
    if (recent.length >= quota.requestsPerMinute) {
      const oldest = Math.min(...recent.map((invocation) => invocation.createdAt))
      throw new WorkflowAppQuotaError(
        "request_rate_exhausted",
        "The application request rate is exhausted",
        Math.max(1, Math.ceil((oldest + 60_000 - input.now) / 1_000))
      )
    }
  }

  if (quota.concurrentRuns !== undefined) {
    const active = invocations.filter(
      (invocation) => invocation.status === "admitted" || invocation.status === "running"
    )
    if (active.length >= quota.concurrentRuns) {
      throw new WorkflowAppQuotaError(
        "concurrency_exhausted",
        "The application concurrency quota is exhausted",
        1
      )
    }
  }

  if (quota.dailyTokenBudget === undefined && quota.dailyCostBudgetUsd === undefined) return
  const dayStart = Math.floor(input.now / 86_400_000) * 86_400_000
  const runIds = invocations.flatMap((invocation) =>
    invocation.createdAt >= dayStart && invocation.runId ? [invocation.runId] : []
  )
  const usage = runIds.length
    ? await getDb()
        .sessionUsage.where("runId")
        .anyOf([...new Set(runIds)])
        .toArray()
    : []
  if (quota.dailyTokenBudget !== undefined) {
    const tokens = usage.reduce(
      (total, row) =>
        total + row.inputTokens + row.outputTokens + row.cacheCreationTokens + row.cacheReadTokens,
      0
    )
    if (tokens >= quota.dailyTokenBudget) {
      throw new WorkflowAppQuotaError(
        "token_budget_exhausted",
        "The application daily token budget is exhausted",
        Math.max(1, Math.ceil((dayStart + 86_400_000 - input.now) / 1_000))
      )
    }
  }
  if (quota.dailyCostBudgetUsd !== undefined) {
    if (usage.some((row) => row.costKnown === false)) {
      throw new WorkflowAppQuotaError(
        "cost_budget_unknown",
        "The application cost budget cannot admit work while recorded cost is unknown"
      )
    }
    const cost = usage.reduce((total, row) => total + row.costUsd, 0)
    if (cost >= quota.dailyCostBudgetUsd) {
      throw new WorkflowAppQuotaError(
        "cost_budget_exhausted",
        "The application daily cost budget is exhausted",
        Math.max(1, Math.ceil((dayStart + 86_400_000 - input.now) / 1_000))
      )
    }
  }
}
