import type { EvalInputPart } from "@/types/eval/eval"
import {
  loadOrCreateEvalArtifactKey,
  encryptEvalArtifact,
  type EvalArtifactKeyDependencies,
} from "./artifact-crypto"
import { markEvalAssetCleared, saveEvalAsset } from "@/lib/db/eval-lab"

const DEFAULT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1_000

export type EvalAssetClearance =
  | { method: "manual"; actorId: string }
  | { method: "scan"; scannerId: string; evidenceDigest: string }

export interface EvalAssetFile {
  name: string
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface IngestEvalAssetInput {
  accountId: string
  file: EvalAssetFile
  clearance?: EvalAssetClearance
  retentionDays?: number
}

export interface IngestEvalAssetDependencies {
  loadKey(accountId: string, dependencies?: EvalArtifactKeyDependencies): Promise<Uint8Array>
  encrypt: typeof encryptEvalArtifact
  save: typeof saveEvalAsset
  clear: typeof markEvalAssetCleared
  now(): number
}

const defaultDependencies: IngestEvalAssetDependencies = {
  loadKey: loadOrCreateEvalArtifactKey,
  encrypt: encryptEvalArtifact,
  save: saveEvalAsset,
  clear: markEvalAssetCleared,
  now: Date.now,
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

async function contentDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  )
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`
}

function validateClearance(clearance: EvalAssetClearance | undefined): void {
  if (clearance?.method === "manual" && !clearance.actorId.trim()) {
    throw new Error("Manual media clearance requires reviewer identity")
  }
  if (
    clearance?.method === "scan" &&
    (!clearance.scannerId.trim() || !clearance.evidenceDigest.trim())
  ) {
    throw new Error("Scanned media clearance requires scanner identity and evidence")
  }
}

export async function ingestEvalAsset(
  input: IngestEvalAssetInput,
  overrides: Partial<IngestEvalAssetDependencies> = {}
): Promise<Extract<EvalInputPart, { type: "asset" }>> {
  if (!input.accountId.trim()) throw new Error("An unlocked account is required")
  if (input.file.size <= 0) throw new Error("Evaluation attachments cannot be empty")
  const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("Evaluation attachment retention must be a positive whole number of days")
  }
  validateClearance(input.clearance)

  const dependencies = { ...defaultDependencies, ...overrides }
  const bytes = new Uint8Array(await input.file.arrayBuffer())
  if (bytes.byteLength !== input.file.size) {
    throw new Error("Evaluation attachment size changed while it was being read")
  }
  const digest = await contentDigest(bytes)
  const mediaType = input.file.type.trim() || "application/octet-stream"
  const key = await dependencies.loadKey(input.accountId)
  const now = dependencies.now()
  await dependencies.save({
    digest,
    mediaType,
    size: bytes.byteLength,
    encryptedBytes: await dependencies.encrypt(key, {
      data: bytesToBase64(bytes),
      mediaType,
    }),
    referenceCount: 0,
    createdAt: now,
    expiresAt: now + retentionDays * DAY_MS,
  })
  if (input.clearance) await dependencies.clear(digest, input.clearance, now)

  return {
    type: "asset",
    assetId: digest,
    mediaType,
    name: input.file.name,
    privacy:
      input.clearance?.method === "scan"
        ? "scanned"
        : input.clearance?.method === "manual"
          ? "manual"
          : "local-only",
  }
}
