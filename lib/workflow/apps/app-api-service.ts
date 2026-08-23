import { getDb } from "@/lib/db/schema"
import { resolvePublishedWorkflowApp, resolveWorkflowAppRelease } from "@/lib/db/workflow-apps"
import {
  cancelWorkflowApiRun,
  getWorkflowApiRun,
  listWorkflowApiEvents,
} from "@/lib/workflow/api/workflow-api-service"
import {
  authorizeWorkflowAppRequest,
  executePublishedWorkflowApp,
  type WorkflowAppRequestActor,
} from "./app-execution"

export class WorkflowAppApiError extends Error {
  constructor(
    readonly code: "app_not_found" | "run_not_found" | "invalid_idempotency_key",
    message: string
  ) {
    super(message)
    this.name = "WorkflowAppApiError"
  }
}

async function publishedApp(accountId: string, appSlug: string) {
  const resolved = await resolvePublishedWorkflowApp(accountId, appSlug)
  if (!resolved) throw new WorkflowAppApiError("app_not_found", "Published app was not found")
  return resolved
}

export async function admitWorkflowAppRun(input: {
  accountId: string
  appSlug: string
  actor: WorkflowAppRequestActor
  input: unknown
  idempotencyKey: string
  signal?: AbortSignal
}): Promise<{
  runId: string
  releaseId: string
  completion: ReturnType<typeof executePublishedWorkflowApp>
}> {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) {
    throw new WorkflowAppApiError(
      "invalid_idempotency_key",
      "A bounded Idempotency-Key is required"
    )
  }
  const resolved = await publishedApp(input.accountId, input.appSlug)
  let admit!: (runId: string) => void
  const admitted = new Promise<string>((resolve) => {
    admit = resolve
  })
  const completion = executePublishedWorkflowApp({
    resolved,
    actor: input.actor,
    input: input.input,
    idempotencyKey: input.idempotencyKey,
    entrypoint: "http",
    ...(input.signal ? { signal: input.signal } : {}),
    onAdmitted: admit,
  })
  const runId = await Promise.race([admitted, completion.then((result) => result.runId)])
  return { runId, releaseId: resolved.release.id, completion }
}

async function assertOwnedAppRun(input: {
  accountId: string
  appSlug: string
  runId: string
  actor: WorkflowAppRequestActor
}): Promise<{ caller: string }> {
  const resolved = await publishedApp(input.accountId, input.appSlug)
  const invocation = await getDb().workflowInvocations.where("runId").equals(input.runId).first()
  if (!invocation || invocation.accountId !== input.accountId) {
    throw new WorkflowAppApiError("run_not_found", "Application run was not found")
  }
  const marker = `app:${resolved.app.id}:release:`
  if (!invocation.caller.startsWith(marker)) {
    throw new WorkflowAppApiError("run_not_found", "Application run was not found")
  }
  const suffix = invocation.caller.slice(marker.length)
  const separator = suffix.indexOf(":")
  if (separator < 1) throw new WorkflowAppApiError("run_not_found", "Application run was not found")
  const releaseId = suffix.slice(0, separator)
  const release = await resolveWorkflowAppRelease(input.accountId, resolved.app.id, releaseId)
  if (!release) throw new WorkflowAppApiError("run_not_found", "Application run was not found")
  const authorization = authorizeWorkflowAppRequest(release.release, input.actor)
  if (suffix.slice(separator + 1) !== authorization.caller) {
    throw new WorkflowAppApiError("run_not_found", "Application run was not found")
  }
  return { caller: invocation.caller }
}

export async function getWorkflowAppRun(input: Parameters<typeof assertOwnedAppRun>[0]) {
  await assertOwnedAppRun(input)
  return getWorkflowApiRun({
    accountId: input.accountId,
    runId: input.runId,
    scopes: ["workflow:read"],
  })
}

export async function listWorkflowAppRunEvents(
  input: Parameters<typeof assertOwnedAppRun>[0] & { afterSequence: number; limit?: number }
) {
  await assertOwnedAppRun(input)
  return listWorkflowApiEvents({
    accountId: input.accountId,
    runId: input.runId,
    scopes: ["workflow:read"],
    afterSequence: input.afterSequence,
    ...(input.limit ? { limit: input.limit } : {}),
  })
}

export async function cancelWorkflowAppRun(input: Parameters<typeof assertOwnedAppRun>[0]) {
  const owned = await assertOwnedAppRun(input)
  return cancelWorkflowApiRun({
    accountId: input.accountId,
    runId: input.runId,
    scopes: ["workflow:run"],
    caller: owned.caller,
  })
}
