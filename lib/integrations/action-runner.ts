import type {
  ExecuteIntegrationActionInput,
  IntegrationActionHandler,
  IntegrationActionHandlerContext,
  IntegrationActionJob,
} from "@/types/plugin/plugin-integration"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import {
  appendIntegrationAudit,
  enqueueIntegrationActionJob,
  getIntegrationAccount,
  getIntegrationActionJob,
  listRunnableIntegrationActionJobs,
  updateIntegrationAccount,
  updateIntegrationActionJob,
} from "@/lib/db/integrations"
import { getProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { getIntegrationActionHandler, getRegisteredIntegration } from "@/lib/integrations/registry"
import { runGithubIssueLoop } from "@/lib/integrations/github-issue-loop"
import { isTauri } from "@/lib/tauri"

type AuthenticatedRequestExecutor = <T>(
  pluginId: string,
  accountId: string,
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }
) => Promise<{ status: number; headers: Record<string, string>; data: T }>

const runningControllers = new Map<string, AbortController>()
const runningPerAccount = new Map<string, number>()
const MAX_ACCOUNT_CONCURRENCY = 4
let requestOverride: AuthenticatedRequestExecutor | undefined
let githubIssueLoopExecutor: IntegrationActionHandler = runGithubIssueLoop
let githubIssueLoopDesktopHostOverride: boolean | undefined

export interface IntegrationActionAvailability {
  available: boolean
  reason?: string
}

export function resolveIntegrationActionAvailability(
  pluginId: string,
  integrationId: string,
  actionId: string
): IntegrationActionAvailability {
  if (
    pluginId === "github-delivery" &&
    integrationId === "github" &&
    actionId === "runIssueLoop" &&
    !(githubIssueLoopDesktopHostOverride ?? isTauri())
  ) {
    return {
      available: false,
      reason: "GitHub Issue Loop requires a desktop host.",
    }
  }
  return { available: true }
}

function retryDelayMs(error: unknown, attempts: number): number {
  if (error && typeof error === "object") {
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs
    if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)) {
      return Math.max(0, Math.min(24 * 60 * 60 * 1000, retryAfterMs))
    }
    const retryAfter = (error as { retryAfter?: unknown }).retryAfter
    if (typeof retryAfter === "string") {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
      const at = Date.parse(retryAfter)
      if (Number.isFinite(at)) return Math.max(0, at - Date.now())
    }
  }
  return Math.min(60_000, 1000 * 2 ** (attempts - 1))
}

function assertActionInput(schema: Record<string, unknown>, value: unknown): void {
  const validation = validateAgainstJsonSchema(schema, value)
  if (!validation.ok) {
    throw new Error(`Integration action input is invalid: ${validation.errors.join("; ")}`)
  }
}

function integrationErrorDetail(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {}
  const candidate = error as Record<string, unknown>
  return {
    requestId: candidate.requestId,
    status: candidate.status,
    statusClass: candidate.category,
    retryAfter: candidate.retryAfter,
    rateLimitReset: candidate.rateLimitReset,
  }
}

async function defaultAuthenticatedRequest<T>(
  pluginId: string,
  accountId: string,
  input: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  const account = await getIntegrationAccount(pluginId, accountId)
  if (!account || !account.enabled)
    throw new Error(`Integration account "${accountId}" is disabled`)
  const registered = getRegisteredIntegration(pluginId, account.integrationId)
  if (!registered) throw new Error(`Integration "${account.integrationId}" is not registered`)
  const url = new URL(input)
  const allowed = [
    ...(registered.definition.allowedOrigins ?? []),
    ...(account.approvedOrigins ?? []),
  ]
  if (!allowed.includes(url.origin)) {
    throw new Error(`Integration request origin "${url.origin}" is not allowlisted`)
  }
  const provider = getProvider(account.providerId)
  if (!provider) throw new Error(`Auth provider "${account.providerId}" is not registered`)
  const sessions = await provider.getSessions(undefined, { silent: true })
  const session = sessions.find((candidate) => candidate.id === account.authSessionId)
  if (!session) {
    await updateIntegrationAccount(pluginId, accountId, { health: "revoked" })
    throw new Error(`Credential handle for account "${accountId}" is unavailable`)
  }

  const strategy = registered.definition.authStrategies.find(
    (candidate) => candidate.providerId === account.providerId
  )
  if (!strategy) {
    throw new Error(`Auth strategy for provider "${account.providerId}" is not registered`)
  }
  const headers = new Headers(init.headers)
  const requestAuth = strategy.requestAuth ?? { type: "bearer" as const }
  const credential = provider.resolveRequestCredential
    ? await provider.resolveRequestCredential(session.id, {
        accountId,
        origin: url.origin,
      })
    : { accessToken: session.accessToken }
  if (requestAuth.type === "bearer") {
    headers.set("authorization", `Bearer ${credential.accessToken}`)
  } else {
    headers.set(requestAuth.name, `${requestAuth.prefix ?? ""}${credential.accessToken}`)
  }
  const response = await fetch(url, {
    method: init.method,
    headers,
    body: init.body,
  })
  const responseHeaders = Object.fromEntries(response.headers.entries())
  await updateIntegrationAccount(pluginId, accountId, {
    health: response.status === 401 || response.status === 403 ? "degraded" : "healthy",
  })
  const contentType = response.headers.get("content-type") ?? ""
  const data = contentType.includes("application/json")
    ? ((await response.json()) as T)
    : ((await response.text()) as T)
  return { status: response.status, headers: responseHeaders, data }
}

async function authenticatedRequest<T>(
  pluginId: string,
  accountId: string,
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  if (
    !hasNoLeakingPiiDeep({
      url: input,
      headers: init?.headers,
      body: init?.body,
    })
  ) {
    throw new Error(
      "Integration authenticated request blocked by the PII gate; redact identifiers and retry."
    )
  }
  return (requestOverride ?? defaultAuthenticatedRequest)<T>(pluginId, accountId, input, init)
}

/** Host-owned authenticated fetch boundary used by `ctx.integrations`. */
export async function authenticatedIntegrationRequest<T>(
  pluginId: string,
  accountId: string,
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  }
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  return authenticatedRequest<T>(pluginId, accountId, input, init)
}

export async function executeIntegrationAction(
  pluginId: string,
  input: ExecuteIntegrationActionInput
): Promise<IntegrationActionJob> {
  const registered = getRegisteredIntegration(pluginId, input.integrationId)
  if (!registered) throw new Error(`Integration "${input.integrationId}" is not registered`)
  const action = registered.definition.actions.find((candidate) => candidate.id === input.actionId)
  if (!action) throw new Error(`Integration action "${input.actionId}" is not registered`)
  const account = await getIntegrationAccount(pluginId, input.accountId)
  if (!account || account.integrationId !== input.integrationId) {
    throw new Error(`Integration account "${input.accountId}" does not belong to this integration`)
  }
  if (!account.enabled) throw new Error(`Integration account "${input.accountId}" is disabled`)
  if (action.idempotency === "required" && !input.idempotencyKey) {
    throw new Error(`Integration action "${input.actionId}" requires an idempotency key`)
  }
  assertActionInput(action.inputSchema, input.input)

  const job = await enqueueIntegrationActionJob({
    pluginId,
    integrationId: input.integrationId,
    accountId: input.accountId,
    actionId: input.actionId,
    input: input.input,
    status: action.risk === "read" ? "queued" : "awaiting_approval",
    risk: action.risk,
    idempotencyKey: input.idempotencyKey,
    attempts: 0,
    maxAttempts: action.idempotency === "none" ? 1 : 5,
    source: input.source ?? "manual",
  })
  if (job.status !== "queued") return job
  await appendIntegrationAudit({
    pluginId,
    integrationId: input.integrationId,
    accountId: input.accountId,
    kind: `action.${input.actionId}.queued`,
    outcome: "allowed",
  })
  return runIntegrationActionJob(job.id)
}

export async function approveIntegrationActionJob(jobId: string): Promise<IntegrationActionJob> {
  const job = await getIntegrationActionJob(jobId)
  if (!job) throw new Error(`Integration action job "${jobId}" was not found`)
  if (job.status !== "awaiting_approval") return job
  await appendIntegrationAudit({
    pluginId: job.pluginId,
    integrationId: job.integrationId,
    accountId: job.accountId,
    kind: `action.${job.actionId}.approved`,
    outcome: "allowed",
  })
  await updateIntegrationActionJob(jobId, { status: "queued" })
  return runIntegrationActionJob(jobId)
}

export async function runIntegrationActionJob(jobId: string): Promise<IntegrationActionJob> {
  const job = await getIntegrationActionJob(jobId)
  if (!job) throw new Error(`Integration action job "${jobId}" was not found`)
  if (!["queued", "retry_wait"].includes(job.status)) return job
  const running = runningPerAccount.get(job.accountId) ?? 0
  if (running >= MAX_ACCOUNT_CONCURRENCY) return job

  const registered = getRegisteredIntegration(job.pluginId, job.integrationId)
  const action = registered?.definition.actions.find((candidate) => candidate.id === job.actionId)
  const isGithubIssueLoop =
    job.pluginId === "github-delivery" &&
    job.integrationId === "github" &&
    job.actionId === "runIssueLoop"
  const handler = isGithubIssueLoop
    ? githubIssueLoopExecutor
    : getIntegrationActionHandler(job.pluginId, job.integrationId, job.actionId)
  if (!action || !handler) {
    return updateIntegrationActionJob(jobId, {
      status: "failed",
      error: `Integration action "${job.actionId}" is unavailable`,
    })
  }
  const availability = resolveIntegrationActionAvailability(
    job.pluginId,
    job.integrationId,
    job.actionId
  )
  if (!availability.available) {
    return updateIntegrationActionJob(jobId, {
      status: "failed",
      error: availability.reason,
    })
  }

  const controller = new AbortController()
  runningControllers.set(jobId, controller)
  runningPerAccount.set(job.accountId, running + 1)
  const attempts = job.attempts + 1
  await updateIntegrationActionJob(jobId, { status: "running", attempts, error: undefined })
  const timeout = setTimeout(() => controller.abort(), action.timeoutMs ?? 30_000)

  try {
    const context: IntegrationActionHandlerContext = {
      pluginId: job.pluginId,
      integrationId: job.integrationId,
      accountId: job.accountId,
      jobId,
      signal: controller.signal,
      authenticatedRequest: (input, init) =>
        authenticatedRequest(job.pluginId, job.accountId, input, init),
    }
    const output = await handler(job.input, context)
    const outputValidation = action.outputSchema
      ? validateAgainstJsonSchema(action.outputSchema, output)
      : { ok: true as const }
    if (!outputValidation.ok) {
      throw new Error(`Integration action output is invalid: ${outputValidation.errors.join("; ")}`)
    }
    const completed = await updateIntegrationActionJob(jobId, {
      status: "succeeded",
      output,
      error: undefined,
      nextAttemptAt: undefined,
    })
    await appendIntegrationAudit({
      pluginId: job.pluginId,
      integrationId: job.integrationId,
      accountId: job.accountId,
      kind: `action.${job.actionId}`,
      outcome: "succeeded",
      detail: { jobId, attempts },
    })
    return completed
  } catch (error) {
    if (controller.signal.aborted) {
      return updateIntegrationActionJob(jobId, {
        status: "cancelled",
        error: "Action cancelled or timed out",
      })
    }
    const message = error instanceof Error ? error.message : String(error)
    const retryable = action.idempotency !== "none" && attempts < job.maxAttempts
    const nextAttemptAt = retryable
      ? new Date(Date.now() + retryDelayMs(error, attempts)).toISOString()
      : undefined
    const failed = await updateIntegrationActionJob(jobId, {
      status: retryable ? "retry_wait" : attempts >= job.maxAttempts ? "deadlettered" : "failed",
      error: message,
      nextAttemptAt,
    })
    await appendIntegrationAudit({
      pluginId: job.pluginId,
      integrationId: job.integrationId,
      accountId: job.accountId,
      kind: `action.${job.actionId}`,
      outcome: "failed",
      detail: {
        jobId,
        attempts,
        retryable,
        error: message,
        nextRetryAt: nextAttemptAt,
        ...integrationErrorDetail(error),
      },
    })
    return failed
  } finally {
    clearTimeout(timeout)
    runningControllers.delete(jobId)
    runningPerAccount.set(
      job.accountId,
      Math.max(0, (runningPerAccount.get(job.accountId) ?? 1) - 1)
    )
  }
}

export async function drainIntegrationActionJobs(): Promise<IntegrationActionJob[]> {
  const jobs = await listRunnableIntegrationActionJobs()
  return Promise.all(jobs.map((job) => runIntegrationActionJob(job.id)))
}

export async function cancelIntegrationActionJob(jobId: string): Promise<IntegrationActionJob> {
  const job = await getIntegrationActionJob(jobId)
  if (!job) throw new Error(`Integration action job "${jobId}" was not found`)
  if (["succeeded", "failed", "deadlettered", "cancelled"].includes(job.status)) return job
  runningControllers.get(jobId)?.abort()
  const cancelled = await updateIntegrationActionJob(jobId, {
    status: "cancelled",
    error: "Cancelled by user",
    nextAttemptAt: undefined,
  })
  await appendIntegrationAudit({
    pluginId: job.pluginId,
    integrationId: job.integrationId,
    accountId: job.accountId,
    kind: `action.${job.actionId}.cancelled`,
    outcome: "denied",
    detail: { jobId },
  })
  return cancelled
}

export function setIntegrationAuthenticatedRequestExecutorForTesting(
  executor?: AuthenticatedRequestExecutor
): void {
  requestOverride = executor
}

export function setGithubIssueLoopExecutorForTesting(
  executor: IntegrationActionHandler = runGithubIssueLoop
): void {
  githubIssueLoopExecutor = executor
}

export function setGithubIssueLoopDesktopHostAvailableForTesting(available?: boolean): void {
  githubIssueLoopDesktopHostOverride = available
}
