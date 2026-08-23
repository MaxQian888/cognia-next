/**
 * Quarantine-to-durable promotion for Human Input files.
 *
 * Companion uploads first land in the resumable session attachment table.
 * This module is the second boundary: it rejects executable/active/archive
 * content, encrypts accepted bytes with the account Human Input key, and only
 * then returns a reference that may be stored in a submission.
 */

import JSZip from "jszip"

import {
  decryptAccountArtifactBytes,
  encryptAccountArtifactBytes,
  loadOrCreateAccountArtifactKey,
} from "@/lib/ai/eval/artifact-crypto"
import { COMPOSER_MAX_ATTACHMENT_BYTES } from "@/lib/chat/attachments/prepare"
import type { WorkflowHumanInputFileRow } from "@/types/workflow/human-input"
import { getDb } from "./schema"

export const HUMAN_INPUT_FILE_REF_PREFIX = "cognia-human-input-file:"
const MAX_ARCHIVE_ENTRIES = 1_000
const MAX_ARCHIVE_DEPTH = 20
const MAX_ARCHIVE_EXPANDED_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_EXPANSION_RATIO = 100

const OFFICE_ARCHIVE_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
])

const DANGEROUS_ARCHIVE_PATH =
  /(^|\/)(vbaProject\.bin|embeddings\/|[^/]+\.(?:exe|dll|com|scr|msi|jar|js|jse|vbs|vbe|cmd|bat|ps1|sh|lnk))$/i

export type HumanInputFilePolicyCode =
  | "empty"
  | "too-large"
  | "size-mismatch"
  | "executable"
  | "active-content"
  | "dangerous-archive"
  | "archive-bomb"
  | "malformed-archive"

export class HumanInputFilePolicyError extends Error {
  constructor(readonly code: HumanInputFilePolicyCode) {
    super(`human-input-file-${code}`)
    this.name = "HumanInputFilePolicyError"
  }
}

export interface HumanInputFileCryptoDeps {
  loadKey?: (accountId: string) => Promise<Uint8Array>
}

export interface PromoteHumanInputFileInput {
  accountId: string
  requestId: string
  responderId: string
  fieldId: string
  name: string
  mediaType: string
  size: number
  hash: string
  bytes: Uint8Array
  expiresAt: number
  now?: number
}

export interface PromotedHumanInputFile {
  id: string
  ref: string
}

export interface OpenedHumanInputFile {
  id: string
  name: string
  mediaType: string
  size: number
  hash: string
  bytes: Uint8Array
  createdAt: number
  expiresAt: number
}

export function humanInputFileRef(id: string): string {
  return `${HUMAN_INPUT_FILE_REF_PREFIX}${id}`
}

export function parseHumanInputFileRef(ref: string): string | null {
  if (!ref.startsWith(HUMAN_INPUT_FILE_REF_PREFIX)) return null
  const id = ref.slice(HUMAN_INPUT_FILE_REF_PREFIX.length)
  return id || null
}

function starts(bytes: Uint8Array, ...signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte)
}

function hasExecutableSignature(bytes: Uint8Array): boolean {
  return (
    starts(bytes, 0x4d, 0x5a) ||
    starts(bytes, 0x7f, 0x45, 0x4c, 0x46) ||
    starts(bytes, 0xfe, 0xed, 0xfa, 0xce) ||
    starts(bytes, 0xfe, 0xed, 0xfa, 0xcf) ||
    starts(bytes, 0xce, 0xfa, 0xed, 0xfe) ||
    starts(bytes, 0xcf, 0xfa, 0xed, 0xfe) ||
    starts(bytes, 0xca, 0xfe, 0xba, 0xbe)
  )
}

function containsActivePdf(bytes: Uint8Array): boolean {
  if (!starts(bytes, 0x25, 0x50, 0x44, 0x46)) return false
  const text = new TextDecoder("latin1").decode(bytes)
  return /\/(?:JavaScript|JS|Launch|RichMedia|EmbeddedFile)\b/i.test(text)
}

function containsActiveSvg(bytes: Uint8Array, mediaType: string, name: string): boolean {
  if (mediaType !== "image/svg+xml" && !name.toLowerCase().endsWith(".svg")) return false
  const text = new TextDecoder().decode(bytes)
  return /<script\b|\bon\w+\s*=|javascript\s*:|<foreignObject\b/i.test(text)
}

async function scanOfficeArchive(bytes: Uint8Array, mediaType: string): Promise<void> {
  if (!starts(bytes, 0x50, 0x4b)) return
  if (!OFFICE_ARCHIVE_MEDIA_TYPES.has(mediaType)) {
    throw new HumanInputFilePolicyError("dangerous-archive")
  }

  let archive: JSZip
  try {
    archive = await JSZip.loadAsync(bytes)
  } catch {
    throw new HumanInputFilePolicyError("malformed-archive")
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir)
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new HumanInputFilePolicyError("archive-bomb")
  }

  let expandedBytes = 0
  for (const entry of entries) {
    const normalized = entry.name.replace(/\\/g, "/")
    if (normalized.split("/").length > MAX_ARCHIVE_DEPTH) {
      throw new HumanInputFilePolicyError("archive-bomb")
    }
    if (DANGEROUS_ARCHIVE_PATH.test(normalized)) {
      throw new HumanInputFilePolicyError("dangerous-archive")
    }
    const content = await entry.async("uint8array")
    expandedBytes += content.byteLength
    if (
      expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES ||
      expandedBytes > Math.max(bytes.byteLength * MAX_ARCHIVE_EXPANSION_RATIO, 1_000_000)
    ) {
      throw new HumanInputFilePolicyError("archive-bomb")
    }
  }
}

export async function scanHumanInputFile(
  bytes: Uint8Array,
  metadata: { name: string; mediaType: string }
): Promise<void> {
  if (bytes.byteLength === 0) throw new HumanInputFilePolicyError("empty")
  if (bytes.byteLength > COMPOSER_MAX_ATTACHMENT_BYTES) {
    throw new HumanInputFilePolicyError("too-large")
  }
  if (hasExecutableSignature(bytes)) throw new HumanInputFilePolicyError("executable")
  if (containsActivePdf(bytes) || containsActiveSvg(bytes, metadata.mediaType, metadata.name)) {
    throw new HumanInputFilePolicyError("active-content")
  }
  await scanOfficeArchive(bytes, metadata.mediaType)
}

function fileAad(
  row: Pick<WorkflowHumanInputFileRow, "id" | "accountId" | "requestId" | "responderId" | "fieldId">
): Uint8Array {
  return new TextEncoder().encode(
    `human-input-file-v1:${row.accountId}:${row.requestId}:${row.responderId}:${row.fieldId}:${row.id}`
  )
}

async function loadKey(accountId: string, deps: HumanInputFileCryptoDeps): Promise<Uint8Array> {
  return deps.loadKey
    ? deps.loadKey(accountId)
    : loadOrCreateAccountArtifactKey(accountId, "human-input")
}

export async function promoteHumanInputFile(
  input: PromoteHumanInputFileInput,
  deps: HumanInputFileCryptoDeps = {}
): Promise<PromotedHumanInputFile> {
  if (input.size !== input.bytes.byteLength) {
    throw new HumanInputFilePolicyError("size-mismatch")
  }
  await scanHumanInputFile(input.bytes, input)

  const now = input.now ?? Date.now()
  const id = `hif_${crypto.randomUUID()}`
  const identity = {
    id,
    accountId: input.accountId,
    requestId: input.requestId,
    responderId: input.responderId,
    fieldId: input.fieldId,
  }
  const envelope = await encryptAccountArtifactBytes(
    await loadKey(input.accountId, deps),
    input.bytes,
    fileAad(identity)
  )
  await getDb().workflowHumanInputFiles.add({
    ...identity,
    name: input.name,
    mediaType: input.mediaType,
    size: input.size,
    hash: input.hash,
    envelope,
    createdAt: now,
    expiresAt: input.expiresAt,
  })
  return { id, ref: humanInputFileRef(id) }
}

export async function getHumanInputFile(
  ref: string,
  scope: { accountId: string; requestId: string; now?: number },
  deps: HumanInputFileCryptoDeps = {}
): Promise<OpenedHumanInputFile | null> {
  const id = parseHumanInputFileRef(ref)
  if (!id) return null
  const row = await getDb().workflowHumanInputFiles.get(id)
  if (!row || row.accountId !== scope.accountId || row.requestId !== scope.requestId) return null
  if (row.expiresAt <= (scope.now ?? Date.now())) {
    await getDb().workflowHumanInputFiles.delete(id)
    return null
  }
  const bytes = await decryptAccountArtifactBytes(
    await loadKey(row.accountId, deps),
    row.envelope,
    fileAad(row)
  )
  return {
    id: row.id,
    name: row.name,
    mediaType: row.mediaType,
    size: row.size,
    hash: row.hash,
    bytes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

export async function deleteHumanInputFiles(ids: readonly string[]): Promise<void> {
  if (ids.length > 0) await getDb().workflowHumanInputFiles.bulkDelete([...ids])
}

export async function pruneExpiredHumanInputFiles(now = Date.now()): Promise<number> {
  const ids = (await getDb()
    .workflowHumanInputFiles.where("expiresAt")
    .belowOrEqual(now)
    .primaryKeys()) as string[]
  if (ids.length > 0) await getDb().workflowHumanInputFiles.bulkDelete(ids)
  return ids.length
}
