import type { WorkflowApiEventView } from "@/lib/workflow/api/workflow-api-service"
import { getDb } from "@/lib/db/schema"
import { getWorkflowAppBySlug } from "@/lib/db/workflow-apps"
import {
  deleteWorkflowConversation,
  getWorkflowConversation,
  listWorkflowConversationMessages,
  listWorkflowConversations,
  renameWorkflowConversation,
  updateWorkflowConversationVariables,
} from "@/lib/db/workflow-conversations"
import { admitWorkflowAppRun, cancelWorkflowAppRun, getWorkflowAppRun } from "./app-api-service"
import { sendChatflowMessage } from "./chatflow-service"
import type { WorkflowAppRequestActor } from "./app-execution"
import { resolveDifyInputFiles, WorkflowAppFileError } from "./file-upload-service"

export const DIFY_1_16_PROFILE = Object.freeze({
  id: "dify-1.16",
  baseline: "1.16.1",
  supported: [
    "workflow-run",
    "workflow-status",
    "workflow-stop",
    "chat-messages",
    "chat-stop",
    "conversation-list",
    "conversation-messages",
    "conversation-rename",
    "conversation-delete",
    "conversation-variables",
    "file-upload",
    "message-feedback",
    "blocking",
    "sse",
  ],
  unsupported: ["audio", "suggested-questions", "admin-api", "complete-service-api"],
})

export interface DifyWorkflowRunRequest {
  inputs: Record<string, unknown>
  response_mode: "blocking" | "streaming"
  user: string
  files?: unknown[]
}

export interface DifyChatMessageRequest {
  query: string
  response_mode: "blocking" | "streaming"
  user: string
  conversation_id?: string
  inputs?: Record<string, unknown>
  files?: unknown[]
}

export class DifyCompatibilityError extends Error {
  constructor(
    readonly code: "invalid_param" | "unsupported_feature",
    message: string
  ) {
    super(message)
    this.name = "DifyCompatibilityError"
  }
}

export function difyActor(user: string): WorkflowAppRequestActor {
  const bounded = user.trim()
  if (!bounded || bounded.length > 240) {
    throw new DifyCompatibilityError("invalid_param", "Dify user is required")
  }
  return { authenticated: false, externalSubjectKey: `dify:${bounded}` }
}

async function resolveFiles(input: {
  accountId: string
  appId: string
  user: string
  value: unknown
}): Promise<unknown> {
  try {
    return await resolveDifyInputFiles({
      accountId: input.accountId,
      appId: input.appId,
      externalSubjectKey: difyActor(input.user).externalSubjectKey,
      value: input.value,
    })
  } catch (error) {
    if (error instanceof WorkflowAppFileError) {
      const code = error.code === "unsupported_file_type" ? "unsupported_feature" : "invalid_param"
      throw new DifyCompatibilityError(code, error.message)
    }
    throw error
  }
}

export async function createDifyWorkflowRun(input: {
  accountId: string
  appSlug: string
  idempotencyKey: string
  request: DifyWorkflowRunRequest
}) {
  const actor = difyActor(input.request.user)
  const app = await difyApp(input.accountId, input.appSlug)
  const resolvedInputs = (await resolveFiles({
    accountId: input.accountId,
    appId: app.id,
    user: input.request.user,
    value: input.request.inputs,
  })) as Record<string, unknown>
  const resolvedFiles = (await resolveFiles({
    accountId: input.accountId,
    appId: app.id,
    user: input.request.user,
    value: input.request.files ?? [],
  })) as unknown[]
  const admitted = await admitWorkflowAppRun({
    accountId: input.accountId,
    appSlug: input.appSlug,
    actor,
    input: { ...resolvedInputs, ...(resolvedFiles.length ? { files: resolvedFiles } : {}) },
    idempotencyKey: input.idempotencyKey,
  })
  if (input.request.response_mode === "streaming") {
    return { workflow_run_id: admitted.runId, task_id: admitted.runId, stream: true as const }
  }
  await admitted.completion
  const run = await getWorkflowAppRun({
    accountId: input.accountId,
    appSlug: input.appSlug,
    runId: admitted.runId,
    actor,
  })
  return {
    workflow_run_id: run.runId,
    task_id: run.runId,
    data: {
      id: run.runId,
      workflow_id: run.workflowId,
      status: run.status,
      outputs: run.output ?? null,
      error: run.error?.message ?? null,
      elapsed_time: Math.max(0, (run.completedAt ?? run.startedAt) - run.startedAt) / 1_000,
      total_tokens: 0,
      total_steps: 0,
      created_at: Math.floor(run.startedAt / 1_000),
      finished_at: run.completedAt ? Math.floor(run.completedAt / 1_000) : null,
    },
  }
}

function eventName(type: string): string {
  if (type.includes("started")) return type.startsWith("step") ? "node_started" : "workflow_started"
  if (type.includes("completed") || type.includes("succeeded")) {
    return type.startsWith("step") ? "node_finished" : "workflow_finished"
  }
  if (type.includes("failed")) return type.startsWith("step") ? "node_finished" : "error"
  return "workflow_event"
}

export function formatDifyWorkflowSse(event: WorkflowApiEventView): string {
  const name = eventName(event.type)
  const data = {
    event: name,
    task_id: event.runId,
    workflow_run_id: event.runId,
    data: {
      ...(event.stepId ? { id: event.stepId } : {}),
      ...(name === "node_finished"
        ? { status: event.type.includes("failed") ? "failed" : "succeeded" }
        : {}),
      ...(event.payload !== undefined ? { outputs: event.payload } : {}),
    },
  }
  return `id: ${event.sequence}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function createDifyChatMessage(input: {
  accountId: string
  appSlug: string
  idempotencyKey: string
  request: DifyChatMessageRequest
}) {
  if (!input.request.query.trim()) {
    throw new DifyCompatibilityError("invalid_param", "Chat query is required")
  }
  const actor = difyActor(input.request.user)
  const app = await difyApp(input.accountId, input.appSlug)
  const resolvedInputs = (await resolveFiles({
    accountId: input.accountId,
    appId: app.id,
    user: input.request.user,
    value: input.request.inputs ?? {},
  })) as Record<string, unknown>
  const resolvedFiles = (await resolveFiles({
    accountId: input.accountId,
    appId: app.id,
    user: input.request.user,
    value: input.request.files ?? [],
  })) as unknown[]
  const existing = input.request.conversation_id
    ? await ownedDifyConversation({
        accountId: input.accountId,
        conversationId: input.request.conversation_id,
        user: input.request.user,
      })
    : undefined
  const result = await sendChatflowMessage({
    accountId: input.accountId,
    appSlug: input.appSlug,
    ...(input.request.conversation_id ? { conversationId: input.request.conversation_id } : {}),
    ...(existing ? { expectedRevision: existing.conversation.revision } : {}),
    actor,
    idempotencyKey: input.idempotencyKey,
    content: {
      text: input.request.query,
      ...(Object.keys(resolvedInputs).length || resolvedFiles.length
        ? { data: { inputs: resolvedInputs, files: resolvedFiles } }
        : {}),
    },
  })
  return {
    event: "message",
    task_id: result.runId,
    id: result.runId,
    message_id: result.runId,
    conversation_id: result.conversation.id,
    mode: "chat",
    answer: result.answer.text ?? JSON.stringify(result.answer.content ?? null),
    metadata: { citations: result.answer.citations },
    created_at: Math.floor(Date.now() / 1_000),
  }
}

export async function stopDifyWorkflowTask(input: {
  accountId: string
  appSlug: string
  taskId: string
  user: string
}) {
  const result = await cancelWorkflowAppRun({
    accountId: input.accountId,
    appSlug: input.appSlug,
    runId: input.taskId,
    actor: difyActor(input.user),
  })
  return { result: result.cancelled ? "success" : "already_finished" }
}

function difyOwner(user: string) {
  return { kind: "anonymous" as const, externalSubjectKey: difyActor(user).externalSubjectKey }
}

async function difyApp(accountId: string, appSlug: string) {
  const app = await getWorkflowAppBySlug(accountId, appSlug)
  if (!app) throw new DifyCompatibilityError("invalid_param", "Application was not found")
  return app
}

async function ownedDifyConversation(input: {
  accountId: string
  conversationId: string
  user: string
}) {
  const conversation = await getWorkflowConversation(input.accountId, input.conversationId)
  const owner = difyOwner(input.user)
  if (
    !conversation ||
    conversation.owner.kind !== "anonymous" ||
    conversation.owner.externalSubjectKey !== owner.externalSubjectKey
  ) {
    throw new DifyCompatibilityError("invalid_param", "Conversation was not found")
  }
  return { conversation, owner }
}

export async function listDifyConversations(input: {
  accountId: string
  appSlug: string
  user: string
  limit?: number
  lastId?: string
}) {
  const app = await difyApp(input.accountId, input.appSlug)
  const cursorConversation = input.lastId
    ? await ownedDifyConversation({
        accountId: input.accountId,
        conversationId: input.lastId,
        user: input.user,
      })
    : undefined
  if (cursorConversation && cursorConversation.conversation.appId !== app.id) {
    throw new DifyCompatibilityError("invalid_param", "Conversation cursor was not found")
  }
  const cursor = cursorConversation?.conversation.updatedAt
  const rows = await listWorkflowConversations({
    accountId: input.accountId,
    appId: app.id,
    owner: difyOwner(input.user),
    ...(input.limit ? { limit: input.limit } : {}),
    ...(cursor !== undefined ? { beforeUpdatedAt: cursor } : {}),
  })
  return {
    limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
    has_more: rows.length === Math.max(1, Math.min(input.limit ?? 20, 100)),
    data: rows.map((conversation) => ({
      id: conversation.id,
      name: conversation.title ?? "New conversation",
      inputs: conversation.variables,
      status: "normal",
      created_at: Math.floor(conversation.createdAt / 1_000),
      updated_at: Math.floor(conversation.updatedAt / 1_000),
    })),
  }
}

export async function listDifyConversationMessages(input: {
  accountId: string
  conversationId: string
  user: string
  limit?: number
  firstId?: string
}) {
  const { owner } = await ownedDifyConversation(input)
  const cursorMessage = input.firstId
    ? await getDb().workflowConversationMessages.get(input.firstId)
    : undefined
  if (
    input.firstId &&
    (!cursorMessage ||
      cursorMessage.accountId !== input.accountId ||
      cursorMessage.conversationId !== input.conversationId)
  ) {
    throw new DifyCompatibilityError("invalid_param", "Message cursor was not found")
  }
  const after = cursorMessage?.sequence
  const messages = await listWorkflowConversationMessages({
    accountId: input.accountId,
    conversationId: input.conversationId,
    owner,
    ...(after !== undefined ? { afterSequence: after } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  })
  return {
    limit: Math.max(1, Math.min(input.limit ?? 20, 100)),
    has_more: messages.length === Math.max(1, Math.min(input.limit ?? 20, 100)),
    data: messages.map((message) => ({
      id: message.id,
      conversation_id: message.conversationId,
      query: message.role === "user" ? (message.content.text ?? "") : "",
      answer:
        message.role === "assistant" && message.content.answer
          ? (message.content.answer.text ?? JSON.stringify(message.content.answer.content ?? null))
          : "",
      created_at: Math.floor(message.createdAt / 1_000),
    })),
  }
}

export async function renameDifyConversation(input: {
  accountId: string
  conversationId: string
  user: string
  name: string
}) {
  const { conversation, owner } = await ownedDifyConversation(input)
  const updated = await renameWorkflowConversation({
    accountId: input.accountId,
    conversationId: conversation.id,
    expectedRevision: conversation.revision,
    owner,
    title: input.name,
  })
  return { id: updated.id, name: updated.title }
}

export async function deleteDifyConversation(input: {
  accountId: string
  conversationId: string
  user: string
}) {
  const { conversation } = await ownedDifyConversation(input)
  await deleteWorkflowConversation({
    accountId: input.accountId,
    conversationId: conversation.id,
    expectedRevision: conversation.revision,
  })
  return { result: "success" }
}

export async function updateDifyConversationVariables(input: {
  accountId: string
  conversationId: string
  user: string
  variables: Record<string, unknown>
}) {
  const { conversation } = await ownedDifyConversation(input)
  const updated = await updateWorkflowConversationVariables({
    accountId: input.accountId,
    conversationId: conversation.id,
    expectedRevision: conversation.revision,
    variables: input.variables,
  })
  return { conversation_id: updated.id, variables: updated.variables }
}
