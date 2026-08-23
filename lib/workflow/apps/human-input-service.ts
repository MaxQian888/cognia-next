import { getDb } from "@/lib/db/schema"
import { sniffImageMediaType } from "@/lib/db/session-attachment-uploads"
import {
  getHumanInputRequest,
  isHumanInputAssigned,
  listPendingHumanInputRequests,
  submitHumanInput,
} from "@/lib/db/workflow-human-input"
import { promoteHumanInputFile } from "@/lib/db/workflow-human-input-files"
import { sha256Bytes } from "@/lib/ocr/hash"
import {
  inspectUploadContent,
  UploadContentInspectionError,
} from "@/lib/security/upload-content-inspection"
import type {
  HumanInputActor,
  HumanInputValue,
  WorkflowHumanInputRequest,
} from "@/types/workflow/human-input"
import type { WorkflowAppRequestActor } from "./app-execution"

const DEFAULT_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

export class PortalHumanInputError extends Error {
  constructor(
    readonly code:
      | "request_not_found"
      | "invalid_values"
      | "invalid_action"
      | "already_submitted"
      | "file_not_allowed"
      | "file_rejected",
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "PortalHumanInputError"
  }
}

export interface PortalHumanInputRequest {
  id: string
  title: string
  message?: string
  fields: WorkflowHumanInputRequest["fields"]
  actions: WorkflowHumanInputRequest["actions"]
  completionPolicy: WorkflowHumanInputRequest["completionPolicy"]
  submittedCount: number
  createdAt: number
  expiresAt: number
}

function humanInputActor(
  actor: WorkflowAppRequestActor,
  request: WorkflowHumanInputRequest
): HumanInputActor {
  const id = actor.subjectId ?? actor.externalSubjectKey
  return {
    id,
    ...(actor.groupIds ? { groupIds: actor.groupIds } : {}),
    ...(request.initiatorId === id ? { isInitiator: true } : {}),
  }
}

function appBinding(runPayload: unknown): { appId?: string; appReleaseId?: string } {
  if (!runPayload || typeof runPayload !== "object" || Array.isArray(runPayload)) return {}
  const payload = runPayload as Record<string, unknown>
  return {
    ...(typeof payload.appId === "string" ? { appId: payload.appId } : {}),
    ...(typeof payload.appReleaseId === "string" ? { appReleaseId: payload.appReleaseId } : {}),
  }
}

async function ownedRequest(input: {
  accountId: string
  appId: string
  appReleaseId: string
  actor: WorkflowAppRequestActor
  requestId: string
}): Promise<WorkflowHumanInputRequest> {
  const request = await getHumanInputRequest(input.requestId)
  if (!request || request.accountId !== input.accountId || request.status !== "pending") {
    throw new PortalHumanInputError("request_not_found", 404, "Human Input request was not found")
  }
  const run = await getDb().workflowRuns.get(request.runId)
  const binding = appBinding(run?.triggerPayload)
  if (binding.appId !== input.appId || binding.appReleaseId !== input.appReleaseId) {
    throw new PortalHumanInputError("request_not_found", 404, "Human Input request was not found")
  }
  if (!isHumanInputAssigned(request, humanInputActor(input.actor, request))) {
    throw new PortalHumanInputError("request_not_found", 404, "Human Input request was not found")
  }
  return request
}

async function projectRequest(
  request: WorkflowHumanInputRequest
): Promise<PortalHumanInputRequest> {
  const submittedCount = await getDb()
    .workflowHumanInputSubmissions.where("requestId")
    .equals(request.id)
    .count()
  return {
    id: request.id,
    title: request.title,
    ...(request.message ? { message: request.message } : {}),
    fields: structuredClone(request.fields),
    actions: structuredClone(request.actions),
    completionPolicy: structuredClone(request.completionPolicy),
    submittedCount,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  }
}

async function hasSubmitted(requestId: string, actor: WorkflowAppRequestActor): Promise<boolean> {
  const responderId = actor.subjectId ?? actor.externalSubjectKey
  const submissions = await getDb()
    .workflowHumanInputSubmissions.where("requestId")
    .equals(requestId)
    .toArray()
  return submissions.some((submission) => submission.responderId === responderId)
}

export async function listPortalHumanInputRequests(input: {
  accountId: string
  appId: string
  appReleaseId: string
  actor: WorkflowAppRequestActor
}): Promise<PortalHumanInputRequest[]> {
  const pending = await listPendingHumanInputRequests()
  const visible: PortalHumanInputRequest[] = []
  for (const candidate of pending) {
    try {
      const request = await ownedRequest({ ...input, requestId: candidate.id })
      if (await hasSubmitted(request.id, input.actor)) continue
      visible.push(await projectRequest(request))
    } catch (error) {
      if (!(error instanceof PortalHumanInputError) || error.code !== "request_not_found") {
        throw error
      }
    }
  }
  return visible
}

export async function submitPortalHumanInput(input: {
  accountId: string
  appId: string
  appReleaseId: string
  actor: WorkflowAppRequestActor
  requestId: string
  actionId: string
  values: Record<string, HumanInputValue>
}) {
  const request = await ownedRequest(input)
  const result = await submitHumanInput({
    requestId: request.id,
    actor: humanInputActor(input.actor, request),
    actionId: input.actionId,
    values: input.values,
  })
  if (result.ok) {
    return {
      requestId: request.id,
      completed: result.completed,
      submittedAt: result.submission.submittedAt,
    }
  }
  if (result.reason === "already-submitted") {
    throw new PortalHumanInputError("already_submitted", 409, "This request was already answered")
  }
  if (result.reason === "invalid-action") {
    throw new PortalHumanInputError("invalid_action", 400, "Human Input action is invalid")
  }
  if (result.reason === "invalid-values") {
    throw new PortalHumanInputError("invalid_values", 400, result.message ?? "Values are invalid")
  }
  throw new PortalHumanInputError("request_not_found", 404, "Human Input request was not found")
}

function accepts(
  field: WorkflowHumanInputRequest["fields"][number],
  name: string,
  mediaType: string
) {
  if (!field.accept?.length) return true
  const lowerName = name.toLowerCase()
  const lowerType = mediaType.toLowerCase()
  return field.accept.some((raw) => {
    const token = raw.trim().toLowerCase()
    if (token.startsWith(".")) return lowerName.endsWith(token)
    if (token.endsWith("/*")) return lowerType.startsWith(token.slice(0, -1))
    return lowerType === token
  })
}

export async function uploadPortalHumanInputFile(input: {
  accountId: string
  appId: string
  appReleaseId: string
  actor: WorkflowAppRequestActor
  requestId: string
  fieldId: string
  name: string
  declaredMediaType: string
  bytes: Uint8Array
  now?: number
}) {
  const request = await ownedRequest(input)
  const field = request.fields.find((candidate) => candidate.id === input.fieldId)
  if (!field || (field.type !== "file" && field.type !== "file-list")) {
    throw new PortalHumanInputError(
      "file_not_allowed",
      400,
      "Human Input field does not accept files"
    )
  }
  let mediaType: string
  try {
    const sniffedImageType = sniffImageMediaType(input.bytes)
    if (input.declaredMediaType.startsWith("image/") && !sniffedImageType) {
      throw new UploadContentInspectionError("type_mismatch")
    }
    mediaType = inspectUploadContent({
      name: input.name,
      declaredMediaType: sniffedImageType ?? input.declaredMediaType,
      bytes: input.bytes,
    }).mediaType
  } catch (error) {
    if (error instanceof UploadContentInspectionError) {
      throw new PortalHumanInputError("file_rejected", 415, "Human Input file was rejected")
    }
    throw error
  }
  if (!accepts(field, input.name, mediaType)) {
    throw new PortalHumanInputError("file_not_allowed", 415, "Human Input file type is not allowed")
  }
  const now = input.now ?? Date.now()
  const responderId = input.actor.subjectId ?? input.actor.externalSubjectKey
  const retentionDays = field.sensitive ? (request.sensitiveRetentionDays ?? 30) : 30
  const promoted = await promoteHumanInputFile({
    accountId: input.accountId,
    requestId: request.id,
    responderId,
    fieldId: field.id,
    name: input.name,
    mediaType,
    size: input.bytes.byteLength,
    hash: await sha256Bytes(input.bytes),
    bytes: input.bytes,
    expiresAt: now + Math.min(DEFAULT_FILE_RETENTION_MS, retentionDays * 24 * 60 * 60 * 1_000),
    now,
  })
  return { ref: promoted.ref, name: input.name, mediaType, size: input.bytes.byteLength }
}
