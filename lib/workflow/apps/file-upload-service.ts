import { getFilenameExtension } from "@cognia/document/support-matrix"
import {
  AttachmentUploadError,
  appendAttachmentChunk,
  beginAttachmentUpload,
  commitAttachmentUpload,
  resolveAttachmentRef,
  uploadRef,
} from "@/lib/db/session-attachment-uploads"
import { sha256Bytes } from "@/lib/ocr/hash"

const WORKFLOW_APP_MAX_FILE_BYTES = 10 * 1024 * 1024
const WORKFLOW_APP_MAX_STAGED_FILES = 20

export type WorkflowAppFileErrorCode =
  | "unsupported_file_type"
  | "file_too_large"
  | "malicious_file"
  | "unsafe_archive"
  | "file_not_found"
  | "invalid_file"

export class WorkflowAppFileError extends Error {
  constructor(
    readonly code: WorkflowAppFileErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "WorkflowAppFileError"
  }
}

export interface WorkflowAppUploadedFile {
  id: string
  name: string
  size: number
  extension: string | null
  mime_type: string
  created_by: string
  created_at: number
}

export interface ResolvedWorkflowAppFile {
  id: string
  ref: string
  name: string
  size: number
  mimeType: string
  hash: string
}

export interface ResolvedDifyFileInput extends ResolvedWorkflowAppFile {
  type: "document" | "image"
  transfer_method: "local_file"
  upload_file_id: string
  mime_type: string
  extension: string | null
}

function uploadSessionId(accountId: string, appId: string): string {
  return `workflow-app-file:${accountId}:${appId}`
}

function uploadOwnerId(externalSubjectKey: string): string {
  return `workflow-app-subject:${externalSubjectKey}`
}

async function stableSubjectId(appId: string, externalSubjectKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${appId}:${externalSubjectKey}`)
    )
  ).slice(0, 16)
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function normalizeUploadError(error: unknown): never {
  if (!(error instanceof AttachmentUploadError)) throw error
  if (error.code === "attachment_too_large") {
    throw new WorkflowAppFileError("file_too_large", 413, "File size exceeded")
  }
  if (error.code === "attachment_malicious_content") {
    throw new WorkflowAppFileError("malicious_file", 415, "File content was rejected")
  }
  if (error.code === "attachment_unsafe_archive") {
    throw new WorkflowAppFileError("unsafe_archive", 415, "Archive safety limits were exceeded")
  }
  if (error.code === "attachment_unsupported_type" || error.code === "attachment_type_mismatch") {
    throw new WorkflowAppFileError("unsupported_file_type", 415, "File type is not supported")
  }
  throw new WorkflowAppFileError("invalid_file", 400, "File upload was invalid")
}

export async function uploadWorkflowAppFile(input: {
  accountId: string
  appId: string
  externalSubjectKey: string
  name: string
  declaredMediaType: string
  bytes: Uint8Array
  now?: number
}): Promise<WorkflowAppUploadedFile> {
  const now = input.now ?? Date.now()
  if (!input.name.trim() || !input.declaredMediaType.trim() || input.bytes.byteLength === 0) {
    throw new WorkflowAppFileError("invalid_file", 400, "File name, type, and content are required")
  }
  try {
    const hash = await sha256Bytes(input.bytes)
    const ownerId = uploadOwnerId(input.externalSubjectKey)
    const begun = await beginAttachmentUpload({
      sessionId: uploadSessionId(input.accountId, input.appId),
      deviceId: ownerId,
      name: input.name,
      mediaType: input.declaredMediaType,
      size: input.bytes.byteLength,
      hash,
      maxBytes: WORKFLOW_APP_MAX_FILE_BYTES,
      maxConcurrent: WORKFLOW_APP_MAX_STAGED_FILES,
      now,
    })
    if (!begun.complete) {
      await appendAttachmentChunk({
        uploadId: begun.uploadId,
        deviceId: ownerId,
        offset: begun.resumeOffset,
        bytes: input.bytes.subarray(begun.resumeOffset),
        now,
      })
    }
    const committed = await commitAttachmentUpload({
      uploadId: begun.uploadId,
      deviceId: ownerId,
      now,
    })
    return {
      id: begun.uploadId,
      name: committed.name,
      size: committed.size,
      extension: getFilenameExtension(committed.name) || null,
      mime_type: committed.mediaType,
      created_by: await stableSubjectId(input.appId, input.externalSubjectKey),
      created_at: Math.floor(now / 1_000),
    }
  } catch (error) {
    normalizeUploadError(error)
  }
}

export async function resolveWorkflowAppFile(input: {
  accountId: string
  appId: string
  externalSubjectKey: string
  uploadFileId: string
}): Promise<ResolvedWorkflowAppFile> {
  if (!/^upl_[0-9a-f-]{36}$/i.test(input.uploadFileId)) {
    throw new WorkflowAppFileError("file_not_found", 404, "Uploaded file was not found")
  }
  const ref = uploadRef(input.uploadFileId)
  const row = await resolveAttachmentRef(ref, {
    sessionId: uploadSessionId(input.accountId, input.appId),
    deviceId: uploadOwnerId(input.externalSubjectKey),
  })
  if (!row) {
    throw new WorkflowAppFileError("file_not_found", 404, "Uploaded file was not found")
  }
  return {
    id: row.uploadId,
    ref,
    name: row.name,
    size: row.size,
    mimeType: row.mediaType,
    hash: row.hash,
  }
}

export async function resolveDifyFileInput(input: {
  accountId: string
  appId: string
  externalSubjectKey: string
  value: unknown
}): Promise<ResolvedDifyFileInput> {
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
    throw new WorkflowAppFileError("invalid_file", 400, "Dify file entry is invalid")
  }
  const value = input.value as Record<string, unknown>
  if (value.transfer_method !== "local_file") {
    throw new WorkflowAppFileError(
      "unsupported_file_type",
      400,
      "Only local_file transfer is supported"
    )
  }
  if (value.type !== "document" && value.type !== "image") {
    throw new WorkflowAppFileError(
      "unsupported_file_type",
      400,
      "Only document and image files are supported"
    )
  }
  if (typeof value.upload_file_id !== "string") {
    throw new WorkflowAppFileError("invalid_file", 400, "upload_file_id is required")
  }
  const resolved = await resolveWorkflowAppFile({
    accountId: input.accountId,
    appId: input.appId,
    externalSubjectKey: input.externalSubjectKey,
    uploadFileId: value.upload_file_id,
  })
  const actualType = resolved.mimeType.startsWith("image/") ? "image" : "document"
  if (actualType !== value.type) {
    throw new WorkflowAppFileError("invalid_file", 400, "Dify file type does not match its content")
  }
  return {
    ...resolved,
    type: actualType,
    transfer_method: "local_file",
    upload_file_id: resolved.id,
    mime_type: resolved.mimeType,
    extension: getFilenameExtension(resolved.name) || null,
  }
}

export async function resolveDifyInputFiles(input: {
  accountId: string
  appId: string
  externalSubjectKey: string
  value: unknown
}): Promise<unknown> {
  let visited = 0
  const walk = async (value: unknown, depth: number): Promise<unknown> => {
    visited++
    if (visited > 1_000 || depth > 20) {
      throw new WorkflowAppFileError("invalid_file", 400, "Dify file input is too deeply nested")
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => walk(entry, depth + 1)))
    }
    if (!value || typeof value !== "object") return value
    const record = value as Record<string, unknown>
    if ("transfer_method" in record || "upload_file_id" in record) {
      return resolveDifyFileInput({ ...input, value: record })
    }
    const entries = await Promise.all(
      Object.entries(record).map(
        async ([key, entry]) => [key, await walk(entry, depth + 1)] as const
      )
    )
    return Object.fromEntries(entries)
  }
  return walk(input.value, 0)
}
