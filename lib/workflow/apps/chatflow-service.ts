import {
  appendWorkflowConversationMessage,
  createWorkflowConversation,
  getWorkflowConversation,
  getWorkflowConversationMessageByIdempotencyKey,
  getWorkflowConversationRuntimeContext,
} from "@/lib/db/workflow-conversations"
import {
  getWorkflowAppBySlug,
  resolvePublishedWorkflowApp,
  resolveWorkflowAppRelease,
} from "@/lib/db/workflow-apps"
import type { WorkflowAnswer } from "@/types/workflow/answer"
import type {
  WorkflowConversation,
  WorkflowConversationMessageContent,
} from "@/types/workflow/conversation"
import { executePublishedWorkflowApp, type WorkflowAppRequestActor } from "./app-execution"
import { matchWorkflowAnnotation } from "@/lib/workflow/quality/quality-service"

export class WorkflowChatflowError extends Error {
  constructor(
    readonly code:
      | "app_not_found"
      | "not_chatflow"
      | "conversation_not_found"
      | "revision_required"
      | "invalid_idempotency_key"
      | "answer_missing",
    message: string
  ) {
    super(message)
    this.name = "WorkflowChatflowError"
  }
}

function ownsConversation(
  conversation: WorkflowConversation,
  actor: WorkflowAppRequestActor
): boolean {
  if (conversation.owner.kind === "member") {
    return actor.authenticated && actor.subjectId === conversation.owner.subjectId
  }
  return actor.externalSubjectKey === conversation.owner.externalSubjectKey
}

function asAnswer(value: unknown): WorkflowAnswer | undefined {
  if (!value || typeof value !== "object") return undefined
  const answer = (value as { answer?: unknown }).answer
  if (!answer || typeof answer !== "object") return undefined
  const candidate = answer as Partial<WorkflowAnswer>
  if (candidate.text === undefined && candidate.content === undefined) return undefined
  if (candidate.text !== undefined && typeof candidate.text !== "string") return undefined
  if (
    !Array.isArray(candidate.citations) ||
    !Array.isArray(candidate.files) ||
    !Array.isArray(candidate.suggestions)
  ) {
    return undefined
  }
  return candidate as WorkflowAnswer
}

export async function sendChatflowMessage(input: {
  accountId: string
  appSlug: string
  conversationId?: string
  expectedRevision?: number
  actor: WorkflowAppRequestActor
  idempotencyKey: string
  content: WorkflowConversationMessageContent
  now?: number
}): Promise<{
  conversation: WorkflowConversation
  answer: WorkflowAnswer
  runId: string
  reused: boolean
}> {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 256) {
    throw new WorkflowChatflowError(
      "invalid_idempotency_key",
      "A bounded idempotency key is required"
    )
  }
  const app = await getWorkflowAppBySlug(input.accountId, input.appSlug)
  if (!app) throw new WorkflowChatflowError("app_not_found", "Workflow app was not found")
  if (app.kind !== "chatflow") {
    throw new WorkflowChatflowError("not_chatflow", "Workflow app is not a Chatflow")
  }

  let conversation: WorkflowConversation
  let resolved
  if (input.conversationId) {
    const existing = await getWorkflowConversation(input.accountId, input.conversationId)
    if (!existing || existing.appId !== app.id || !ownsConversation(existing, input.actor)) {
      throw new WorkflowChatflowError(
        "conversation_not_found",
        "Chatflow conversation was not found"
      )
    }
    conversation = existing
    const priorAssistant = await getWorkflowConversationMessageByIdempotencyKey(
      input.accountId,
      conversation.id,
      `${input.idempotencyKey}:assistant`
    )
    const priorAnswer = priorAssistant ? asAnswer(priorAssistant.content) : undefined
    if (priorAssistant && priorAnswer && priorAssistant.runId) {
      return {
        conversation,
        answer: priorAnswer,
        runId: priorAssistant.runId,
        reused: true,
      }
    }
    if (input.expectedRevision === undefined) {
      throw new WorkflowChatflowError(
        "revision_required",
        "Existing Chatflow messages require the current conversation revision"
      )
    }
    resolved = await resolveWorkflowAppRelease(
      input.accountId,
      conversation.appId,
      conversation.appReleaseId
    )
  } else {
    resolved = await resolvePublishedWorkflowApp(input.accountId, input.appSlug)
    if (!resolved) throw new WorkflowChatflowError("app_not_found", "Published app was not found")
    conversation = await createWorkflowConversation({
      accountId: input.accountId,
      appId: app.id,
      releaseId: resolved.release.id,
      owner:
        input.actor.authenticated && input.actor.subjectId
          ? {
              kind: "member",
              subjectId: input.actor.subjectId,
              externalSubjectKey: input.actor.externalSubjectKey,
            }
          : { kind: "anonymous", externalSubjectKey: input.actor.externalSubjectKey },
      now: input.now,
    })
  }
  if (!resolved || resolved.release.appKind !== "chatflow") {
    throw new WorkflowChatflowError("app_not_found", "Pinned Chatflow release was not found")
  }

  const user = await appendWorkflowConversationMessage({
    conversationId: conversation.id,
    accountId: input.accountId,
    expectedRevision: input.expectedRevision ?? conversation.revision,
    idempotencyKey: `${input.idempotencyKey}:user`,
    role: "user",
    content: input.content,
    now: input.now,
  })
  if (
    resolved.release.annotationRevisionId &&
    resolved.release.snapshot.annotationReply.enabled &&
    input.content.text?.trim()
  ) {
    const match = await matchWorkflowAnnotation({
      accountId: input.accountId,
      revisionId: resolved.release.annotationRevisionId,
      query: input.content.text,
      threshold: resolved.release.snapshot.annotationReply.threshold,
    })
    if (match) {
      const runId = `annotation:${match.revisionId}:${match.entryId}`
      const answer: WorkflowAnswer = {
        text: match.answer,
        citations: [
          {
            sourceId: `annotation-set:${match.setId}`,
            documentId: match.entryId,
            revisionId: match.revisionId,
            chunkId: match.entryId,
            label: "Reviewed annotation",
          },
        ],
        files: [],
        suggestions: [],
      }
      const assistant = await appendWorkflowConversationMessage({
        conversationId: conversation.id,
        accountId: input.accountId,
        expectedRevision: user.conversation.revision,
        idempotencyKey: `${input.idempotencyKey}:assistant`,
        role: "assistant",
        content: { answer },
        runId,
        now: input.now,
      })
      return {
        conversation: assistant.conversation,
        answer,
        runId,
        reused: assistant.reused,
      }
    }
  }
  const context = await getWorkflowConversationRuntimeContext({
    conversationId: conversation.id,
    accountId: input.accountId,
  })
  const execution = await executePublishedWorkflowApp({
    resolved,
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    input: {
      message: input.content,
      conversation: {
        id: conversation.id,
        variables: context.conversation.variables,
        ...(context.summary ? { summary: context.summary } : {}),
        messages: context.messages,
      },
    },
  })
  const answer = asAnswer(execution.result.output)
  if (!answer) {
    throw new WorkflowChatflowError(
      "answer_missing",
      "Chatflow completed without an io.answer output"
    )
  }
  const assistant = await appendWorkflowConversationMessage({
    conversationId: conversation.id,
    accountId: input.accountId,
    expectedRevision: user.conversation.revision,
    idempotencyKey: `${input.idempotencyKey}:assistant`,
    role: "assistant",
    content: { answer },
    runId: execution.runId,
    now: input.now,
  })
  return {
    conversation: assistant.conversation,
    answer,
    runId: execution.runId,
    reused: assistant.reused,
  }
}
