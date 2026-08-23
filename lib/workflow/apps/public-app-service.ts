import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  resolvePublishedWorkflowApp,
  resolvePublishedWorkflowAppByDomain,
  resolveWorkflowAppRelease,
} from "@/lib/db/workflow-apps"
import type { WorkflowAppRequestActor } from "./app-execution"
import { authorizeWorkflowAppRequest } from "./app-execution"
import {
  admitWorkflowAppRun,
  cancelWorkflowAppRun,
  getWorkflowAppRun,
  listWorkflowAppRunEvents,
  WorkflowAppApiError,
} from "./app-api-service"
import { WorkflowAppAccessError } from "./app-execution"
import { sendChatflowMessage, WorkflowChatflowError } from "./chatflow-service"
import { submitWorkflowFeedback, WorkflowQualityError } from "../quality/quality-service"
import {
  handleWorkflowAppMcpRequest,
  WorkflowAppKeyError,
  WorkflowAppMcpError,
} from "./mcp-service"
import {
  authorizeWorkflowBatch,
  cancelWorkflowBatch,
  createWorkflowBatch,
  exportWorkflowBatchCsv,
  getWorkflowBatchPage,
  getWorkflowBatchTemplate,
  pauseWorkflowBatch,
  resumeWorkflowBatch,
  runWorkflowBatch,
  WorkflowBatchError,
} from "./batch-service"
import {
  listPortalHumanInputRequests,
  PortalHumanInputError,
  submitPortalHumanInput,
  uploadPortalHumanInputFile,
} from "./human-input-service"
import type { HumanInputValue } from "@/types/workflow/human-input"
import { WorkflowAppQuotaError } from "./quota-service"
import {
  createWorkflowResultShare,
  revokeWorkflowResultShare,
  WorkflowResultSharingError,
} from "./result-sharing-service"

export type PublicWorkflowAppBridgeCommand =
  | "workflow_app_bootstrap"
  | "workflow_app_domain_resolve"
  | "workflow_app_run_create"
  | "workflow_app_run_get"
  | "workflow_app_events_list"
  | "workflow_app_run_cancel"
  | "workflow_app_chat_message"
  | "workflow_app_feedback_submit"
  | "workflow_app_result_share_create"
  | "workflow_app_result_share_revoke"
  | "workflow_app_mcp"
  | "workflow_app_batch_template"
  | "workflow_app_batch_create"
  | "workflow_app_batch_get"
  | "workflow_app_batch_pause"
  | "workflow_app_batch_resume"
  | "workflow_app_batch_cancel"
  | "workflow_app_batch_export"
  | "workflow_app_human_input_list"
  | "workflow_app_human_input_submit"
  | "workflow_app_human_input_file_upload"

export type PublicWorkflowAppBridgeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; status: number; message: string } }

class PublicWorkflowAppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "PublicWorkflowAppError"
  }
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicWorkflowAppError("invalid_request", 400, `${key} is required`)
  }
  return value
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new PublicWorkflowAppError("invalid_request", 400, `${key} must be a string`)
  }
  return value
}

function stringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key] ?? []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new PublicWorkflowAppError("invalid_request", 400, `${key} must be a string array`)
  }
  return value
}

function record(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicWorkflowAppError("invalid_request", 400, `${key} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredBase64Bytes(payload: Record<string, unknown>, key: string): Uint8Array {
  const encoded = requiredString(payload, key)
  if (encoded.length > 14 * 1024 * 1024) {
    throw new PublicWorkflowAppError("file_too_large", 413, "File size exceeded")
  }
  try {
    const binary = atob(encoded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new PublicWorkflowAppError("invalid_request", 400, `${key} must be valid base64`)
  }
}

function optionalBoundedInteger(
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number
): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new PublicWorkflowAppError(
      "invalid_request",
      400,
      `${key} must be between ${minimum} and ${maximum}`
    )
  }
  return value as number
}

function actorFrom(payload: Record<string, unknown>): WorkflowAppRequestActor {
  const value = payload.actor
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicWorkflowAppError("invalid_session", 401, "Application session is required")
  }
  const actor = value as Record<string, unknown>
  const authenticated = actor.authenticated
  const externalSubjectKey = actor.externalSubjectKey
  if (typeof authenticated !== "boolean" || typeof externalSubjectKey !== "string") {
    throw new PublicWorkflowAppError("invalid_session", 401, "Application session is invalid")
  }
  const subjectId = actor.subjectId
  const groupIds = actor.groupIds
  const embedOrigin = actor.embedOrigin
  if (subjectId !== undefined && typeof subjectId !== "string") {
    throw new PublicWorkflowAppError("invalid_session", 401, "Application session is invalid")
  }
  if (
    groupIds !== undefined &&
    (!Array.isArray(groupIds) || !groupIds.every((id) => typeof id === "string"))
  ) {
    throw new PublicWorkflowAppError("invalid_session", 401, "Application session is invalid")
  }
  if (embedOrigin !== undefined && typeof embedOrigin !== "string") {
    throw new PublicWorkflowAppError("invalid_session", 401, "Application session is invalid")
  }
  return {
    authenticated,
    externalSubjectKey,
    ...(subjectId ? { subjectId } : {}),
    ...(groupIds ? { groupIds } : {}),
    ...(embedOrigin ? { embedOrigin } : {}),
    legalConsentGranted: actor.legalConsentGranted === true,
  }
}

function safeLogoUrl(logoRef: string | undefined): string | undefined {
  if (!logoRef) return undefined
  if (logoRef.startsWith("/") && !logoRef.startsWith("//")) return logoRef
  try {
    const url = new URL(logoRef)
    return url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

async function bootstrap(payload: Record<string, unknown>) {
  const accountId = getActiveAccountId()
  const appSlug = requiredString(payload, "appSlug")
  const resolved = await resolvePublishedWorkflowApp(accountId, appSlug)
  if (!resolved) {
    throw new PublicWorkflowAppError("app_not_found", 404, "Published app was not found")
  }
  const embedOrigin = optionalString(payload, "embedOrigin")
  const bootstrapActor = payload.actor
    ? actorFrom(payload)
    : {
        authenticated: false,
        externalSubjectKey: "anonymous:bootstrap",
        ...(embedOrigin ? { embedOrigin } : {}),
      }
  try {
    authorizeWorkflowAppRequest(
      {
        ...resolved.release,
        snapshot: {
          ...resolved.release.snapshot,
          // Bootstrap must expose the consent text before consent can be
          // granted; every execution mutation enforces the frozen legal gate.
          legal: { ...resolved.release.snapshot.legal, requireConsent: false },
        },
      },
      bootstrapActor
    )
  } catch (error) {
    if (error instanceof WorkflowAppAccessError) {
      throw new PublicWorkflowAppError(
        error.code,
        error.code === "authentication_required" ? 401 : 403,
        error.message
      )
    }
    throw error
  }
  const snapshot = resolved.release.snapshot
  return {
    session: {
      accountId,
      appId: resolved.app.id,
      appSlug: resolved.app.slug,
      releaseId: resolved.release.id,
    },
    app: {
      slug: resolved.app.slug,
      kind: resolved.app.kind,
      releaseId: resolved.release.id,
      blocks: snapshot.blocks,
      localized: snapshot.localized,
      theme: {
        primaryColor: snapshot.theme.primaryColor,
        ...(safeLogoUrl(snapshot.theme.logoRef)
          ? { logoUrl: safeLogoUrl(snapshot.theme.logoRef) }
          : {}),
      },
      ...(resolved.release.workflowInterface.inputSchema
        ? { inputSchema: resolved.release.workflowInterface.inputSchema }
        : {}),
      legal: snapshot.legal,
      resultSharing: {
        enabled: snapshot.resultSharing.enabled,
        ...(snapshot.resultSharing.defaultTtlSeconds
          ? { defaultTtlSeconds: snapshot.resultSharing.defaultTtlSeconds }
          : {}),
      },
    },
  }
}

function assertSessionApp(payload: Record<string, unknown>): {
  accountId: string
  appSlug: string
  actor: WorkflowAppRequestActor
} {
  const accountId = requiredString(payload, "accountId")
  if (accountId !== getActiveAccountId()) {
    throw new PublicWorkflowAppError("app_not_found", 404, "Published app was not found")
  }
  return {
    accountId,
    appSlug: requiredString(payload, "appSlug"),
    actor: actorFrom(payload),
  }
}

function humanInputScope(payload: Record<string, unknown>) {
  return {
    ...assertSessionApp(payload),
    appId: requiredString(payload, "appId"),
    appReleaseId: requiredString(payload, "appReleaseId"),
  }
}

async function dispatch(command: PublicWorkflowAppBridgeCommand, payload: Record<string, unknown>) {
  if (command === "workflow_app_bootstrap") return bootstrap(payload)
  if (command === "workflow_app_domain_resolve") {
    const hostname = requiredString(payload, "hostname").toLowerCase()
    const resolved = await resolvePublishedWorkflowAppByDomain(getActiveAccountId(), hostname)
    if (!resolved) {
      throw new PublicWorkflowAppError("app_not_found", 404, "Published app was not found")
    }
    return { appSlug: resolved.app.slug }
  }
  if (command === "workflow_app_mcp") {
    return handleWorkflowAppMcpRequest({
      apiKey: requiredString(payload, "apiKey"),
      appSlug: requiredString(payload, "appSlug"),
      request: payload.request,
    })
  }
  if (command === "workflow_app_human_input_list") {
    return listPortalHumanInputRequests(humanInputScope(payload))
  }
  if (command === "workflow_app_human_input_submit") {
    return submitPortalHumanInput({
      ...humanInputScope(payload),
      requestId: requiredString(payload, "requestId"),
      actionId: requiredString(payload, "actionId"),
      values: record(payload, "values") as Record<string, HumanInputValue>,
    })
  }
  if (command === "workflow_app_human_input_file_upload") {
    return uploadPortalHumanInputFile({
      ...humanInputScope(payload),
      requestId: requiredString(payload, "requestId"),
      fieldId: requiredString(payload, "fieldId"),
      name: requiredString(payload, "name"),
      declaredMediaType: requiredString(payload, "mediaType"),
      bytes: requiredBase64Bytes(payload, "dataBase64"),
    })
  }
  const session = assertSessionApp(payload)
  switch (command) {
    case "workflow_app_batch_template":
      return getWorkflowBatchTemplate(session)
    case "workflow_app_batch_create": {
      const concurrency = optionalBoundedInteger(payload, "concurrency", 1, 16)
      const deadlineMs = optionalBoundedInteger(payload, "deadlineMs", 60_000, 2_592_000_000)
      const job = await createWorkflowBatch({
        ...session,
        csv: requiredString(payload, "csv"),
        idempotencyKey: requiredString(payload, "idempotencyKey"),
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      })
      if (job.status === "queued") void runWorkflowBatch(session.accountId, job.id).catch(() => {})
      return job
    }
    case "workflow_app_batch_get":
      return getWorkflowBatchPage({
        ...session,
        jobId: requiredString(payload, "jobId"),
        afterRowNumber: optionalBoundedInteger(
          payload,
          "afterRowNumber",
          0,
          Number.MAX_SAFE_INTEGER
        ),
        limit: optionalBoundedInteger(payload, "limit", 1, 200),
      })
    case "workflow_app_batch_pause": {
      const jobId = requiredString(payload, "jobId")
      await authorizeWorkflowBatch({ ...session, jobId })
      return pauseWorkflowBatch(session.accountId, jobId)
    }
    case "workflow_app_batch_resume": {
      const jobId = requiredString(payload, "jobId")
      const job = await authorizeWorkflowBatch({ ...session, jobId })
      void resumeWorkflowBatch(session.accountId, jobId).catch(() => {})
      return job
    }
    case "workflow_app_batch_cancel": {
      const jobId = requiredString(payload, "jobId")
      await authorizeWorkflowBatch({ ...session, jobId })
      return cancelWorkflowBatch(session.accountId, jobId)
    }
    case "workflow_app_batch_export": {
      const jobId = requiredString(payload, "jobId")
      await authorizeWorkflowBatch({ ...session, jobId })
      return exportWorkflowBatchCsv(session.accountId, jobId)
    }
    case "workflow_app_run_create": {
      const admitted = await admitWorkflowAppRun({
        ...session,
        input: payload.input ?? {},
        idempotencyKey: requiredString(payload, "idempotencyKey"),
      })
      const blocking = payload.responseMode !== "streaming"
      if (!blocking) {
        return { runId: admitted.runId, releaseId: admitted.releaseId, status: "accepted" }
      }
      await admitted.completion
      return getWorkflowAppRun({ ...session, runId: admitted.runId })
    }
    case "workflow_app_run_get":
      return getWorkflowAppRun({ ...session, runId: requiredString(payload, "runId") })
    case "workflow_app_events_list": {
      const afterSequence = payload.afterSequence ?? 0
      if (
        typeof afterSequence !== "number" ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0
      ) {
        throw new PublicWorkflowAppError(
          "invalid_event_cursor",
          400,
          "Last-Event-ID must be a non-negative safe integer"
        )
      }
      return listWorkflowAppRunEvents({
        ...session,
        runId: requiredString(payload, "runId"),
        afterSequence,
      })
    }
    case "workflow_app_run_cancel":
      return cancelWorkflowAppRun({ ...session, runId: requiredString(payload, "runId") })
    case "workflow_app_result_share_create":
      return createWorkflowResultShare({
        ...session,
        runId: requiredString(payload, "runId"),
        ttlSeconds: optionalBoundedInteger(payload, "ttlSeconds", 60, 2_592_000),
      })
    case "workflow_app_result_share_revoke":
      await revokeWorkflowResultShare({
        ...session,
        code: requiredString(payload, "code"),
      })
      return { revoked: true }
    case "workflow_app_chat_message": {
      const query = requiredString(payload, "query")
      const conversationId = optionalString(payload, "conversationId")
      const result = await sendChatflowMessage({
        ...session,
        idempotencyKey: requiredString(payload, "idempotencyKey"),
        ...(conversationId ? { conversationId } : {}),
        ...(typeof payload.expectedRevision === "number"
          ? { expectedRevision: payload.expectedRevision }
          : {}),
        content: { text: query },
      })
      return {
        conversationId: result.conversation.id,
        conversationRevision: result.conversation.revision,
        messageId: result.runId,
        runId: result.runId,
        answer: result.answer,
        reused: result.reused,
      }
    }
    case "workflow_app_feedback_submit": {
      const appId = requiredString(payload, "appId")
      const appReleaseId = requiredString(payload, "appReleaseId")
      const resolved = await resolveWorkflowAppRelease(session.accountId, appId, appReleaseId)
      if (!resolved || resolved.app.slug !== session.appSlug) {
        throw new PublicWorkflowAppError("app_not_found", 404, "Published app was not found")
      }
      authorizeWorkflowAppRequest(resolved.release, session.actor)
      const rating = requiredString(payload, "rating")
      if (rating !== "like" && rating !== "dislike") {
        throw new PublicWorkflowAppError("invalid_request", 400, "rating must be like or dislike")
      }
      const correction = optionalString(payload, "correction")
      const runId = optionalString(payload, "runId")
      const conversationId = optionalString(payload, "conversationId")
      const messageId = optionalString(payload, "messageId")
      const candidate = await submitWorkflowFeedback({
        accountId: session.accountId,
        appId,
        appReleaseId,
        externalSubjectKey: session.actor.externalSubjectKey,
        rating,
        payload: {
          input: requiredString(payload, "input"),
          output: requiredString(payload, "output"),
          ...(correction ? { correction } : {}),
          tags: stringArray(payload, "tags"),
        },
        ...(runId ? { runId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(messageId ? { messageId } : {}),
      })
      return { id: candidate.id, status: candidate.status }
    }
  }
}

function normalizeError(error: unknown): PublicWorkflowAppBridgeResponse {
  if (error instanceof PublicWorkflowAppError) {
    return { ok: false, error: { code: error.code, status: error.status, message: error.message } }
  }
  if (error instanceof WorkflowAppAccessError) {
    const status = error.code === "authentication_required" ? 401 : 403
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof WorkflowAppQuotaError) {
    return {
      ok: false,
      error: { code: error.code, status: 429, message: error.message },
    }
  }
  if (error instanceof WorkflowResultSharingError) {
    const status =
      error.code === "app_not_found" || error.code === "share_not_found"
        ? 404
        : error.code === "result_sharing_disabled"
          ? 403
          : error.code === "share_service_unavailable"
            ? 503
            : error.code === "share_payload_too_large"
              ? 413
              : 400
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof WorkflowAppApiError || error instanceof WorkflowChatflowError) {
    const status = error.code.endsWith("not_found") ? 404 : 400
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof WorkflowQualityError) {
    const status = error.code.endsWith("not_found") ? 404 : 400
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof WorkflowBatchError) {
    const status =
      error.code === "app_not_found" || error.code === "job_not_found"
        ? 404
        : error.code === "access_denied"
          ? 404
          : 400
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof PortalHumanInputError) {
    return {
      ok: false,
      error: { code: error.code, status: error.status, message: error.message },
    }
  }
  if (error instanceof WorkflowAppKeyError) {
    const status = error.code === "app_not_found" ? 404 : error.code === "scope_denied" ? 403 : 401
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof WorkflowAppMcpError) {
    const status = error.code === "app_not_found" ? 404 : error.code === "mcp_disabled" ? 404 : 401
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  return {
    ok: false,
    error: { code: "internal_error", status: 500, message: "The application request failed" },
  }
}

/** Stable JSON bridge shared by Tauri and Headless public application routes. */
export async function dispatchPublicWorkflowAppBridgeCommand(
  command: PublicWorkflowAppBridgeCommand,
  payload: Record<string, unknown>
): Promise<PublicWorkflowAppBridgeResponse> {
  try {
    return { ok: true, data: await dispatch(command, payload) }
  } catch (error) {
    return normalizeError(error)
  }
}
