import type {
  WorkflowConversation,
  WorkflowConversationMessage,
  WorkflowConversationMessageContent,
  WorkflowConversationOwner,
  WorkflowConversationReleaseEvent,
  WorkflowConversationSummary,
} from "@/types/workflow/conversation"
import { getDb } from "./schema"

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const WORKFLOW_CONVERSATION_DELETION_GRACE_MS = 24 * 60 * 60 * 1_000

export class WorkflowConversationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowConversationConflictError"
  }
}

export class WorkflowConversationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowConversationValidationError"
  }
}

function assertOwner(owner: WorkflowConversationOwner): void {
  if (!owner.externalSubjectKey.trim() || owner.externalSubjectKey.length > 256) {
    throw new WorkflowConversationValidationError("A valid external subject key is required")
  }
  if (owner.kind === "member" && !owner.subjectId.trim()) {
    throw new WorkflowConversationValidationError("A verified member subject is required")
  }
}

function assertRevision(conversation: WorkflowConversation, expected: number): void {
  if (conversation.revision !== expected) {
    throw new WorkflowConversationConflictError(
      `Conversation changed from revision ${expected} to ${conversation.revision}`
    )
  }
}

async function ownedActiveConversation(
  conversationId: string,
  accountId: string
): Promise<WorkflowConversation> {
  const conversation = await getDb().workflowConversations.get(conversationId)
  if (!conversation || conversation.accountId !== accountId || conversation.status !== "active") {
    throw new WorkflowConversationValidationError("Workflow conversation was not found")
  }
  return conversation
}

export async function createWorkflowConversation(input: {
  accountId: string
  appId: string
  releaseId: string
  owner: WorkflowConversationOwner
  title?: string
  variables?: Record<string, unknown>
  now?: number
}): Promise<WorkflowConversation> {
  assertOwner(input.owner)
  const db = getDb()
  const [app, release] = await Promise.all([
    db.workflowApps.get(input.appId),
    db.workflowAppReleases.get(input.releaseId),
  ])
  if (!app || app.accountId !== input.accountId || app.kind !== "chatflow") {
    throw new WorkflowConversationValidationError("Chatflow app was not found")
  }
  if (!release || release.accountId !== input.accountId || release.appId !== app.id) {
    throw new WorkflowConversationValidationError("Chatflow release was not found")
  }
  const now = input.now ?? Date.now()
  const conversation: WorkflowConversation = {
    id: `wfc_${crypto.randomUUID()}`,
    accountId: input.accountId,
    appId: app.id,
    appReleaseId: release.id,
    versionId: release.versionId,
    owner: structuredClone(input.owner),
    status: "active",
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    variables: structuredClone(input.variables ?? {}),
    revision: 1,
    nextMessageSequence: 1,
    summaryRevision: 0,
    summarizedThroughSequence: 0,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + DEFAULT_RETENTION_MS,
  }
  await db.workflowConversations.add(conversation)
  return conversation
}

export async function getWorkflowConversation(
  accountId: string,
  conversationId: string
): Promise<WorkflowConversation | undefined> {
  const conversation = await getDb().workflowConversations.get(conversationId)
  return conversation?.accountId === accountId && conversation.status === "active"
    ? conversation
    : undefined
}

function ownerMatches(
  owner: WorkflowConversationOwner,
  expected:
    { kind: "member"; subjectId: string } | { kind: "anonymous"; externalSubjectKey: string }
): boolean {
  return expected.kind === "member"
    ? owner.kind === "member" && owner.subjectId === expected.subjectId
    : owner.kind === "anonymous" && owner.externalSubjectKey === expected.externalSubjectKey
}

export async function listWorkflowConversations(input: {
  accountId: string
  appId: string
  owner: { kind: "member"; subjectId: string } | { kind: "anonymous"; externalSubjectKey: string }
  limit?: number
  beforeUpdatedAt?: number
}): Promise<WorkflowConversation[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100))
  const rows = await getDb()
    .workflowConversations.where("[appId+status]")
    .equals([input.appId, "active"])
    .filter(
      (conversation) =>
        conversation.accountId === input.accountId &&
        conversation.updatedAt < (input.beforeUpdatedAt ?? Number.MAX_SAFE_INTEGER) &&
        ownerMatches(conversation.owner, input.owner)
    )
    .toArray()
  return rows.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
}

export async function listWorkflowConversationMessages(input: {
  accountId: string
  conversationId: string
  owner: { kind: "member"; subjectId: string } | { kind: "anonymous"; externalSubjectKey: string }
  afterSequence?: number
  limit?: number
}): Promise<WorkflowConversationMessage[]> {
  const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
  if (!ownerMatches(conversation.owner, input.owner)) {
    throw new WorkflowConversationValidationError("Workflow conversation was not found")
  }
  return getDb()
    .workflowConversationMessages.where("[conversationId+sequence]")
    .between(
      [conversation.id, Math.max(0, input.afterSequence ?? 0)],
      [conversation.id, Number.MAX_SAFE_INTEGER],
      false,
      true
    )
    .limit(Math.max(1, Math.min(input.limit ?? 20, 100)))
    .toArray()
}

export async function renameWorkflowConversation(input: {
  accountId: string
  conversationId: string
  expectedRevision: number
  owner: { kind: "member"; subjectId: string } | { kind: "anonymous"; externalSubjectKey: string }
  title: string
  now?: number
}): Promise<WorkflowConversation> {
  if (!input.title.trim() || input.title.trim().length > 200) {
    throw new WorkflowConversationValidationError("Conversation title is invalid")
  }
  const db = getDb()
  return db.transaction("rw", db.workflowConversations, async () => {
    const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
    if (!ownerMatches(conversation.owner, input.owner)) {
      throw new WorkflowConversationValidationError("Workflow conversation was not found")
    }
    assertRevision(conversation, input.expectedRevision)
    const updated: WorkflowConversation = {
      ...conversation,
      title: input.title.trim(),
      revision: conversation.revision + 1,
      updatedAt: input.now ?? Date.now(),
    }
    await db.workflowConversations.put(updated)
    return updated
  })
}

export async function appendWorkflowConversationMessage(input: {
  conversationId: string
  accountId: string
  expectedRevision: number
  role: WorkflowConversationMessage["role"]
  content: WorkflowConversationMessageContent
  idempotencyKey?: string
  runId?: string
  now?: number
}): Promise<{
  conversation: WorkflowConversation
  message: WorkflowConversationMessage
  reused: boolean
}> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.workflowConversations,
    db.workflowConversationMessages,
    async () => {
      const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
      if (input.idempotencyKey) {
        const existing = await db.workflowConversationMessages
          .where("[conversationId+idempotencyKey]")
          .equals([conversation.id, input.idempotencyKey])
          .first()
        if (existing) return { conversation, message: existing, reused: true }
      }
      assertRevision(conversation, input.expectedRevision)
      const now = input.now ?? Date.now()
      const sequence = conversation.nextMessageSequence
      const message: WorkflowConversationMessage = {
        id: `wfcm_${conversation.id}_${sequence}`,
        accountId: conversation.accountId,
        conversationId: conversation.id,
        sequence,
        role: input.role,
        content: structuredClone(input.content),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        createdAt: now,
        ...(conversation.expiresAt !== undefined ? { expiresAt: conversation.expiresAt } : {}),
      }
      const updated: WorkflowConversation = {
        ...conversation,
        revision: conversation.revision + 1,
        nextMessageSequence: sequence + 1,
        updatedAt: now,
      }
      await db.workflowConversationMessages.add(message)
      await db.workflowConversations.put(updated)
      return { conversation: updated, message, reused: false }
    }
  )
}

export async function getWorkflowConversationMessageByIdempotencyKey(
  accountId: string,
  conversationId: string,
  idempotencyKey: string
): Promise<WorkflowConversationMessage | undefined> {
  const conversation = await getDb().workflowConversations.get(conversationId)
  if (!conversation || conversation.accountId !== accountId || conversation.status !== "active") {
    return undefined
  }
  return getDb()
    .workflowConversationMessages.where("[conversationId+idempotencyKey]")
    .equals([conversationId, idempotencyKey])
    .first()
}

export async function updateWorkflowConversationVariables(input: {
  conversationId: string
  accountId: string
  expectedRevision: number
  variables: Record<string, unknown>
  now?: number
}): Promise<WorkflowConversation> {
  const db = getDb()
  return db.transaction("rw", db.workflowConversations, async () => {
    const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
    assertRevision(conversation, input.expectedRevision)
    const updated: WorkflowConversation = {
      ...conversation,
      variables: structuredClone(input.variables),
      revision: conversation.revision + 1,
      updatedAt: input.now ?? Date.now(),
    }
    await db.workflowConversations.put(updated)
    return updated
  })
}

export async function summarizeWorkflowConversation(input: {
  conversationId: string
  accountId: string
  expectedRevision: number
  throughSequence: number
  content: string
  model?: string
  now?: number
}): Promise<{ conversation: WorkflowConversation; summary: WorkflowConversationSummary }> {
  if (!input.content.trim()) {
    throw new WorkflowConversationValidationError("Conversation summary content is required")
  }
  const db = getDb()
  return db.transaction(
    "rw",
    db.workflowConversations,
    db.workflowConversationSummaries,
    async () => {
      const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
      assertRevision(conversation, input.expectedRevision)
      const lastSequence = conversation.nextMessageSequence - 1
      if (
        !Number.isInteger(input.throughSequence) ||
        input.throughSequence <= conversation.summarizedThroughSequence ||
        input.throughSequence > lastSequence
      ) {
        throw new WorkflowConversationValidationError("Summary message boundary is invalid")
      }
      const now = input.now ?? Date.now()
      const revision = conversation.summaryRevision + 1
      const summary: WorkflowConversationSummary = {
        id: `wfcs_${conversation.id}_${revision}`,
        accountId: conversation.accountId,
        conversationId: conversation.id,
        revision,
        throughSequence: input.throughSequence,
        content: input.content.trim(),
        ...(input.model ? { model: input.model } : {}),
        createdAt: now,
      }
      const updated: WorkflowConversation = {
        ...conversation,
        summaryRevision: revision,
        summarizedThroughSequence: input.throughSequence,
        revision: conversation.revision + 1,
        updatedAt: now,
      }
      await db.workflowConversationSummaries.add(summary)
      await db.workflowConversations.put(updated)
      return { conversation: updated, summary }
    }
  )
}

export async function getWorkflowConversationRuntimeContext(input: {
  conversationId: string
  accountId: string
  recentMessageLimit?: number
}): Promise<{
  conversation: WorkflowConversation
  summary?: WorkflowConversationSummary
  messages: WorkflowConversationMessage[]
}> {
  const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
  const db = getDb()
  const limit = Math.max(1, Math.min(input.recentMessageLimit ?? 20, 100))
  const [summary, descending] = await Promise.all([
    conversation.summaryRevision > 0
      ? db.workflowConversationSummaries.get(
          `wfcs_${conversation.id}_${conversation.summaryRevision}`
        )
      : undefined,
    db.workflowConversationMessages
      .where("[conversationId+sequence]")
      .between(
        [conversation.id, conversation.summarizedThroughSequence],
        [conversation.id, Number.MAX_SAFE_INTEGER],
        false,
        true
      )
      .reverse()
      .limit(limit)
      .toArray(),
  ])
  return {
    conversation,
    ...(summary ? { summary } : {}),
    messages: descending.reverse(),
  }
}

export async function migrateWorkflowConversationRelease(input: {
  conversationId: string
  accountId: string
  expectedRevision: number
  targetReleaseId: string
  operatedBy: string
  reason: string
  now?: number
}): Promise<WorkflowConversation> {
  if (!input.operatedBy.trim() || !input.reason.trim()) {
    throw new WorkflowConversationValidationError("Migration operator and reason are required")
  }
  const db = getDb()
  return db.transaction(
    "rw",
    db.workflowConversations,
    db.workflowAppReleases,
    db.workflowConversationReleaseEvents,
    async () => {
      const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
      assertRevision(conversation, input.expectedRevision)
      const release = await db.workflowAppReleases.get(input.targetReleaseId)
      if (
        !release ||
        release.accountId !== conversation.accountId ||
        release.appId !== conversation.appId
      ) {
        throw new WorkflowConversationValidationError("Target Chatflow release was not found")
      }
      const now = input.now ?? Date.now()
      const event: WorkflowConversationReleaseEvent = {
        id: `wfcre_${conversation.id}_${conversation.revision + 1}`,
        accountId: conversation.accountId,
        conversationId: conversation.id,
        fromReleaseId: conversation.appReleaseId,
        toReleaseId: release.id,
        operatedBy: input.operatedBy,
        reason: input.reason.trim(),
        at: now,
      }
      const updated: WorkflowConversation = {
        ...conversation,
        appReleaseId: release.id,
        versionId: release.versionId,
        revision: conversation.revision + 1,
        updatedAt: now,
      }
      await db.workflowConversationReleaseEvents.add(event)
      await db.workflowConversations.put(updated)
      return updated
    }
  )
}

export async function setWorkflowConversationFavorite(input: {
  conversationId: string
  accountId: string
  expectedRevision: number
  favorite: boolean
  now?: number
}): Promise<WorkflowConversation> {
  const db = getDb()
  return db.transaction(
    "rw",
    db.workflowConversations,
    db.workflowConversationMessages,
    async () => {
      const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
      assertRevision(conversation, input.expectedRevision)
      const now = input.now ?? Date.now()
      const expiresAt = input.favorite ? undefined : now + DEFAULT_RETENTION_MS
      const updated: WorkflowConversation = {
        ...conversation,
        favorite: input.favorite,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        revision: conversation.revision + 1,
        updatedAt: now,
      }
      if (expiresAt === undefined) delete updated.expiresAt
      await db.workflowConversations.put(updated)
      await db.workflowConversationMessages
        .where("conversationId")
        .equals(conversation.id)
        .modify((message) => {
          if (expiresAt === undefined) delete message.expiresAt
          else message.expiresAt = expiresAt
        })
      return updated
    }
  )
}

export async function exportWorkflowConversation(
  accountId: string,
  conversationId: string
): Promise<
  | {
      conversation: WorkflowConversation
      messages: WorkflowConversationMessage[]
      summaries: WorkflowConversationSummary[]
      releaseEvents: WorkflowConversationReleaseEvent[]
    }
  | undefined
> {
  const conversation = await getDb().workflowConversations.get(conversationId)
  if (!conversation || conversation.accountId !== accountId || conversation.status !== "active") {
    return undefined
  }
  const [messages, summaries, releaseEvents] = await Promise.all([
    getDb()
      .workflowConversationMessages.where("conversationId")
      .equals(conversationId)
      .sortBy("sequence"),
    getDb()
      .workflowConversationSummaries.where("conversationId")
      .equals(conversationId)
      .sortBy("revision"),
    getDb()
      .workflowConversationReleaseEvents.where("conversationId")
      .equals(conversationId)
      .sortBy("at"),
  ])
  return { conversation, messages, summaries, releaseEvents }
}

export async function deleteWorkflowConversation(input: {
  conversationId: string
  accountId: string
  expectedRevision: number
  now?: number
}): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    db.workflowConversations,
    db.workflowConversationMessages,
    db.workflowConversationSummaries,
    db.workflowConversationReleaseEvents,
    async () => {
      const conversation = await ownedActiveConversation(input.conversationId, input.accountId)
      assertRevision(conversation, input.expectedRevision)
      const now = input.now ?? Date.now()
      await Promise.all([
        db.workflowConversationMessages.where("conversationId").equals(conversation.id).delete(),
        db.workflowConversationSummaries.where("conversationId").equals(conversation.id).delete(),
        db.workflowConversationReleaseEvents
          .where("conversationId")
          .equals(conversation.id)
          .delete(),
      ])
      await db.workflowConversations.put({
        ...conversation,
        status: "deleted",
        variables: {},
        title: undefined,
        revision: conversation.revision + 1,
        updatedAt: now,
        deletedAt: now,
        deletionRequestedAt: now,
      })
    }
  )
}

/**
 * Physically removes expired conversation content and deletion markers whose
 * 24-hour recovery window has elapsed. Favorites never carry `expiresAt` and
 * therefore remain until the owner explicitly deletes them.
 */
export async function pruneExpiredWorkflowConversations(now = Date.now()): Promise<number> {
  const db = getDb()
  const expiredActive = await db.workflowConversations
    .where("expiresAt")
    .belowOrEqual(now)
    .filter((conversation) => conversation.status === "active" && !conversation.favorite)
    .toArray()
  const deleted = await db.workflowConversations
    .where("status")
    .equals("deleted")
    .filter(
      (conversation) =>
        conversation.deletionRequestedAt !== undefined &&
        conversation.deletionRequestedAt <= now - WORKFLOW_CONVERSATION_DELETION_GRACE_MS
    )
    .toArray()
  const ids = [...new Set([...expiredActive, ...deleted].map((conversation) => conversation.id))]
  if (!ids.length) return 0
  await db.transaction(
    "rw",
    db.workflowConversations,
    db.workflowConversationMessages,
    db.workflowConversationSummaries,
    db.workflowConversationReleaseEvents,
    async () => {
      for (const id of ids) {
        await Promise.all([
          db.workflowConversationMessages.where("conversationId").equals(id).delete(),
          db.workflowConversationSummaries.where("conversationId").equals(id).delete(),
          db.workflowConversationReleaseEvents.where("conversationId").equals(id).delete(),
        ])
      }
      await db.workflowConversations.bulkDelete(ids)
    }
  )
  return ids.length
}
