import { getDb } from "@/lib/db/schema"
import { getWorkflowConversation } from "@/lib/db/workflow-conversations"
import { getWorkflowAppRelease } from "@/lib/db/workflow-apps"
import { listWorkflowAppRunEvents } from "./app-api-service"
import { authenticateWorkflowAppApiKey, WorkflowAppKeyError } from "./api-key-service"
import {
  createDifyChatMessage,
  createDifyWorkflowRun,
  deleteDifyConversation,
  DifyCompatibilityError,
  difyActor,
  formatDifyWorkflowSse,
  listDifyConversationMessages,
  listDifyConversations,
  renameDifyConversation,
  stopDifyWorkflowTask,
  updateDifyConversationVariables,
} from "./dify-compat"
import {
  removeWorkflowFeedback,
  submitWorkflowFeedback,
  WorkflowQualityError,
} from "../quality/quality-service"
import type { WorkflowAppApiKeyScope } from "@/types/workflow/api-key"
import { uploadWorkflowAppFile, WorkflowAppFileError } from "./file-upload-service"

export type DifyBridgeCommand =
  | "dify_workflow_run"
  | "dify_workflow_status"
  | "dify_events_list"
  | "dify_task_stop"
  | "dify_chat_message"
  | "dify_conversations_list"
  | "dify_messages_list"
  | "dify_conversation_rename"
  | "dify_conversation_delete"
  | "dify_conversation_variables"
  | "dify_message_feedback"
  | "dify_file_upload"

export type DifyBridgeResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; status: number; message: string } }

class DifyBridgeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "DifyBridgeError"
  }
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new DifyBridgeError("invalid_param", 400, `${key} is required`)
  }
  return value
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new DifyBridgeError("invalid_param", 400, `${key} must be a non-empty string`)
  }
  return value
}

function object(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key] ?? {}
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DifyBridgeError("invalid_param", 400, `${key} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredBase64Bytes(payload: Record<string, unknown>, key: string): Uint8Array {
  const value = requiredString(payload, key)
  if (value.length > 14 * 1024 * 1024) {
    throw new DifyBridgeError("file_too_large", 413, "File size exceeded")
  }
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new DifyBridgeError("invalid_param", 400, `${key} must be valid base64`)
  }
}

function boundedLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new DifyBridgeError("invalid_param", 400, "limit must be between 1 and 100")
  }
  return value
}

function scope(command: DifyBridgeCommand): WorkflowAppApiKeyScope {
  if (command === "dify_file_upload") return "file:write"
  if (
    command === "dify_workflow_run" ||
    command === "dify_workflow_status" ||
    command === "dify_events_list" ||
    command === "dify_task_stop"
  ) {
    return "workflow:run"
  }
  if (command === "dify_chat_message") return "chat:write"
  if (command === "dify_message_feedback") return "feedback:write"
  if (
    command === "dify_conversation_rename" ||
    command === "dify_conversation_delete" ||
    command === "dify_conversation_variables"
  ) {
    return "conversation:write"
  }
  return "conversation:read"
}

async function dispatch(command: DifyBridgeCommand, payload: Record<string, unknown>) {
  const authenticated = await authenticateWorkflowAppApiKey(
    requiredString(payload, "apiKey"),
    scope(command)
  )
  const base = { accountId: authenticated.accountId, appSlug: authenticated.appSlug }
  switch (command) {
    case "dify_file_upload": {
      const user = requiredString(payload, "user")
      return uploadWorkflowAppFile({
        accountId: authenticated.accountId,
        appId: authenticated.appId,
        externalSubjectKey: difyActor(user).externalSubjectKey,
        name: requiredString(payload, "name"),
        declaredMediaType: requiredString(payload, "mediaType"),
        bytes: requiredBase64Bytes(payload, "dataBase64"),
      })
    }
    case "dify_workflow_run": {
      const request = object(payload, "request")
      return createDifyWorkflowRun({
        ...base,
        idempotencyKey: requiredString(payload, "idempotencyKey"),
        request: request as never,
      })
    }
    case "dify_workflow_status": {
      const runId = requiredString(payload, "runId")
      const user = requiredString(payload, "user")
      const { getWorkflowAppRun } = await import("./app-api-service")
      return getWorkflowAppRun({
        ...base,
        runId,
        actor: difyActor(user),
      })
    }
    case "dify_events_list": {
      const runId = requiredString(payload, "runId")
      const user = requiredString(payload, "user")
      const afterSequence = payload.afterSequence ?? 0
      if (
        typeof afterSequence !== "number" ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0
      ) {
        throw new DifyBridgeError("invalid_param", 400, "afterSequence is invalid")
      }
      const page = await listWorkflowAppRunEvents({
        ...base,
        runId,
        actor: difyActor(user),
        afterSequence,
      })
      return { ...page, frames: page.events.map(formatDifyWorkflowSse) }
    }
    case "dify_task_stop":
      return stopDifyWorkflowTask({
        ...base,
        taskId: requiredString(payload, "taskId"),
        user: requiredString(payload, "user"),
      })
    case "dify_chat_message":
      return createDifyChatMessage({
        ...base,
        idempotencyKey: requiredString(payload, "idempotencyKey"),
        request: object(payload, "request") as never,
      })
    case "dify_conversations_list": {
      const limit = boundedLimit(payload.limit)
      const lastId = optionalString(payload, "lastId")
      return listDifyConversations({
        ...base,
        user: requiredString(payload, "user"),
        ...(limit ? { limit } : {}),
        ...(lastId ? { lastId } : {}),
      })
    }
    case "dify_messages_list": {
      const limit = boundedLimit(payload.limit)
      const firstId = optionalString(payload, "firstId")
      return listDifyConversationMessages({
        accountId: authenticated.accountId,
        conversationId: requiredString(payload, "conversationId"),
        user: requiredString(payload, "user"),
        ...(limit ? { limit } : {}),
        ...(firstId ? { firstId } : {}),
      })
    }
    case "dify_conversation_rename":
      return renameDifyConversation({
        accountId: authenticated.accountId,
        conversationId: requiredString(payload, "conversationId"),
        user: requiredString(payload, "user"),
        name: requiredString(payload, "name"),
      })
    case "dify_conversation_delete":
      return deleteDifyConversation({
        accountId: authenticated.accountId,
        conversationId: requiredString(payload, "conversationId"),
        user: requiredString(payload, "user"),
      })
    case "dify_conversation_variables":
      return updateDifyConversationVariables({
        accountId: authenticated.accountId,
        conversationId: requiredString(payload, "conversationId"),
        user: requiredString(payload, "user"),
        variables: object(payload, "variables"),
      })
    case "dify_message_feedback": {
      const user = requiredString(payload, "user")
      const messageId = requiredString(payload, "messageId")
      const rating = payload.rating
      if (rating !== "like" && rating !== "dislike" && rating !== null) {
        throw new DifyBridgeError("invalid_param", 400, "rating must be like, dislike, or null")
      }
      const actor = difyActor(user)
      const assistant = await getDb()
        .workflowConversationMessages.where("runId")
        .equals(messageId)
        .first()
      const conversation = assistant
        ? await getWorkflowConversation(authenticated.accountId, assistant.conversationId)
        : undefined
      if (
        !assistant ||
        assistant.accountId !== authenticated.accountId ||
        !conversation ||
        conversation.appId !== authenticated.appId ||
        conversation.owner.kind !== "anonymous" ||
        conversation.owner.externalSubjectKey !== actor.externalSubjectKey
      ) {
        throw new DifyBridgeError("invalid_param", 404, "Message was not found")
      }
      const existing = await getDb()
        .workflowFeedbackCandidates.where("appId")
        .equals(authenticated.appId)
        .filter(
          (candidate) =>
            candidate.messageId === messageId &&
            candidate.externalSubjectKey === actor.externalSubjectKey &&
            candidate.status === "candidate"
        )
        .first()
      if (rating === null) {
        if (existing) {
          await removeWorkflowFeedback({
            accountId: authenticated.accountId,
            feedbackId: existing.id,
            externalSubjectKey: actor.externalSubjectKey,
          })
        }
        return { result: "success" }
      }
      const priorUser = await getDb()
        .workflowConversationMessages.where("[conversationId+sequence]")
        .equals([assistant.conversationId, assistant.sequence - 1])
        .first()
      const release = await getWorkflowAppRelease(conversation.appReleaseId)
      if (!release) throw new DifyBridgeError("invalid_param", 404, "Message release was not found")
      const answer = assistant.content.answer
      const correction = optionalString(payload, "content")
      const candidate = await submitWorkflowFeedback({
        accountId: authenticated.accountId,
        appId: authenticated.appId,
        appReleaseId: release.id,
        externalSubjectKey: actor.externalSubjectKey,
        rating,
        payload: {
          input: priorUser?.content.text ?? "Unknown input",
          output: answer?.text ?? JSON.stringify(answer?.content ?? null),
          ...(correction ? { correction } : {}),
          tags: ["dify-1.16"],
        },
        runId: messageId,
        conversationId: conversation.id,
        messageId,
      })
      return { result: "success", feedback_id: candidate.id }
    }
  }
}

function normalizeError(error: unknown): DifyBridgeResponse {
  if (error instanceof DifyBridgeError) {
    return { ok: false, error: { code: error.code, status: error.status, message: error.message } }
  }
  if (error instanceof WorkflowAppKeyError) {
    const status = error.code === "scope_denied" ? 403 : 401
    return { ok: false, error: { code: error.code, status, message: error.message } }
  }
  if (error instanceof DifyCompatibilityError || error instanceof WorkflowQualityError) {
    return { ok: false, error: { code: error.code, status: 400, message: error.message } }
  }
  if (error instanceof WorkflowAppFileError) {
    return {
      ok: false,
      error: { code: error.code, status: error.status, message: error.message },
    }
  }
  return {
    ok: false,
    error: {
      code: "internal_server_error",
      status: 500,
      message: "Dify-compatible request failed",
    },
  }
}

export async function dispatchDifyBridgeCommand(
  command: DifyBridgeCommand,
  payload: Record<string, unknown>
): Promise<DifyBridgeResponse> {
  try {
    return { ok: true, data: await dispatch(command, payload) }
  } catch (error) {
    return normalizeError(error)
  }
}
