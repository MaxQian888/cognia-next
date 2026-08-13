import type { CogniaDB } from "@/lib/db/schema"
import type { PerfFrame } from "./backend/types"
import { decryptPerformanceArtifact, encryptPerformanceArtifact } from "./capture-crypto"
import type {
  PerformanceCaptureAttachmentRow,
  PerformanceCaptureChunkRow,
  PerformanceCaptureRow,
} from "./capture-types"
import {
  buildCogniaPerfPackage,
  createPerfRawExportConfirmation,
  redactPerformanceValue,
  validateCogniaPerfPackage,
  type PerfPackageRedactionMode,
} from "./package-format"
import { PerformanceQuotaManager } from "./quota"
import { getPerformanceSecurityGeneration } from "./security-generation"

const FRAME_CONTENT_TYPE = "application/vnd.cognia.perf-frames+json" as const
const METADATA_CONTENT_TYPE = "application/vnd.cognia.perf-metadata+json" as const

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value)
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

export async function readPerformanceCaptureFrames(input: {
  db: CogniaDB
  accountId: string
  targetDatabase: string
  captureId: string
  key: Uint8Array
}): Promise<PerfFrame[]> {
  const generation = getPerformanceSecurityGeneration()
  const chunks = await input.db.performanceCaptureChunks
    .where("captureId")
    .equals(input.captureId)
    .sortBy("ordinal")
  const frames: PerfFrame[] = []
  for (const chunk of chunks) {
    const plain = await decryptPerformanceArtifact(
      input.key,
      {
        version: "cognia-account-artifact/v1",
        algorithm: "AES-GCM",
        iv: bytes(chunk.iv),
        ciphertext: bytes(chunk.ciphertext),
      },
      {
        accountId: input.accountId,
        targetDatabase: input.targetDatabase,
        captureId: input.captureId,
        ordinal: chunk.ordinal,
        contentType: chunk.contentType,
      },
      generation
    )
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown
    if (!Array.isArray(parsed) || parsed.some((frame) => !isPortableFrame(frame))) {
      throw new Error("performance-capture-frame-schema-invalid")
    }
    frames.push(...(parsed as PerfFrame[]))
  }
  return frames
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function exportPerformanceCapture(input: {
  db: CogniaDB
  accountId: string
  targetDatabase: string
  captureId: string
  key: Uint8Array
  redactionMode?: Extract<PerfPackageRedactionMode, "redacted" | "raw">
  attachmentIds?: readonly string[]
  rawConfirmation?: string
  producerFingerprint: string
  signingPrivateKeyJwk?: JsonWebKey
  signingPublicKeyJwk?: JsonWebKey
}): Promise<Uint8Array> {
  const capture = await input.db.performanceCaptures.get(input.captureId)
  if (!capture || capture.status !== "ready") throw new Error("performance-capture-not-ready")
  const generation = getPerformanceSecurityGeneration()
  const chunks = await input.db.performanceCaptureChunks
    .where("captureId")
    .equals(capture.id)
    .sortBy("ordinal")
  const attachmentIds = new Set(input.attachmentIds ?? [])
  const attachments = attachmentIds.size
    ? (await input.db.performanceCaptureAttachments.bulkGet([...attachmentIds])).filter(
        (row): row is PerformanceCaptureAttachmentRow => row?.captureId === capture.id
      )
    : []
  const mode = input.redactionMode ?? "redacted"
  const entries: Array<{
    path: string
    contentType: string
    bytes: Uint8Array
    attachment?: boolean
  }> = []
  if (
    capture.metadataContentType === METADATA_CONTENT_TYPE &&
    capture.metadataIv &&
    capture.metadataCiphertext
  ) {
    const metadata = await decryptPerformanceArtifact(
      input.key,
      {
        version: "cognia-account-artifact/v1",
        algorithm: "AES-GCM",
        iv: bytes(capture.metadataIv),
        ciphertext: bytes(capture.metadataCiphertext),
      },
      {
        accountId: input.accountId,
        targetDatabase: input.targetDatabase,
        captureId: capture.id,
        ordinal: -1,
        contentType: METADATA_CONTENT_TYPE,
      },
      generation
    )
    entries.push({
      path: "metadata/capture.json",
      contentType: METADATA_CONTENT_TYPE,
      bytes:
        mode === "redacted"
          ? new TextEncoder().encode(
              JSON.stringify(
                await redactPerformanceValue(
                  JSON.parse(new TextDecoder().decode(metadata)),
                  capture.digest ?? capture.id
                )
              )
            )
          : metadata,
    })
  }
  for (const chunk of chunks) {
    const plain = await decryptPerformanceArtifact(
      input.key,
      {
        version: "cognia-account-artifact/v1",
        algorithm: "AES-GCM",
        iv: bytes(chunk.iv),
        ciphertext: bytes(chunk.ciphertext),
      },
      {
        accountId: input.accountId,
        targetDatabase: input.targetDatabase,
        captureId: capture.id,
        ordinal: chunk.ordinal,
        contentType: chunk.contentType,
      },
      generation
    )
    const output =
      mode === "redacted"
        ? new TextEncoder().encode(
            JSON.stringify(
              await redactPerformanceValue(
                JSON.parse(new TextDecoder().decode(plain)),
                capture.digest ?? capture.id
              )
            )
          )
        : plain
    entries.push({
      path: `samples/${String(chunk.ordinal).padStart(6, "0")}.json`,
      contentType: FRAME_CONTENT_TYPE,
      bytes: output,
    })
  }
  for (const attachment of attachments) {
    const plain = await decryptPerformanceArtifact(
      input.key,
      {
        version: "cognia-account-artifact/v1",
        algorithm: "AES-GCM",
        iv: bytes(attachment.iv),
        ciphertext: bytes(attachment.ciphertext),
      },
      {
        accountId: input.accountId,
        targetDatabase: input.targetDatabase,
        captureId: capture.id,
        ordinal: attachment.ordinal,
        contentType: attachment.contentType,
      },
      generation
    )
    entries.push({
      path: `attachments/${String(attachment.ordinal).padStart(6, "0")}.bin`,
      contentType: attachment.contentType,
      bytes: plain,
      attachment: true,
    })
  }
  const captureDigest =
    capture.digest ??
    (await sha256(
      new TextEncoder().encode(
        [capture.metadataDigest ?? "", ...chunks.map((row) => row.digest)].join("")
      )
    ))
  const expectedRawConfirmation = await createPerfRawExportConfirmation({
    captureIds: [capture.id],
    manifestDigest: captureDigest,
    attachmentPaths: entries.filter((entry) => entry.attachment).map((entry) => entry.path),
  })
  return buildCogniaPerfPackage({
    capture: {
      originalId: capture.originalCaptureId ?? capture.id,
      digest: captureDigest,
      wireVersion: capture.wireVersion,
      metricSchemaVersion: capture.metricSchemaVersion,
      sourceKind: capture.sourceKind,
    },
    redactionMode: mode,
    producerFingerprint: input.producerFingerprint,
    issuedAt: new Date().toISOString(),
    entries,
    signingPrivateKeyJwk: input.signingPrivateKeyJwk,
    signingPublicKeyJwk: input.signingPublicKeyJwk,
    rawConfirmation:
      mode === "raw"
        ? { expected: expectedRawConfirmation, provided: input.rawConfirmation ?? "" }
        : undefined,
  })
}

export async function preparePerformanceRawExport(input: {
  db: CogniaDB
  captureId: string
  attachmentIds?: readonly string[]
}): Promise<{
  confirmation: string
  manifestDigest: string
  attachmentIds: string[]
}> {
  const capture = await input.db.performanceCaptures.get(input.captureId)
  if (!capture || capture.status !== "ready") throw new Error("performance-capture-not-ready")
  const chunks = await input.db.performanceCaptureChunks
    .where("captureId")
    .equals(capture.id)
    .sortBy("ordinal")
  const requestedIds = [...new Set(input.attachmentIds ?? [])]
  const attachments = requestedIds.length
    ? await input.db.performanceCaptureAttachments.bulkGet(requestedIds)
    : []
  if (attachments.some((attachment) => !attachment || attachment.captureId !== capture.id)) {
    throw new Error("performance-capture-attachment-invalid")
  }
  const selected = attachments.filter((attachment): attachment is PerformanceCaptureAttachmentRow =>
    Boolean(attachment)
  )
  const manifestDigest =
    capture.digest ??
    (await sha256(
      new TextEncoder().encode(
        [capture.metadataDigest ?? "", ...chunks.map((row) => row.digest)].join("")
      )
    ))
  const confirmation = await createPerfRawExportConfirmation({
    captureIds: [capture.id],
    manifestDigest,
    attachmentPaths: selected.map(
      (attachment) => `attachments/${String(attachment.ordinal).padStart(6, "0")}.bin`
    ),
  })
  return {
    confirmation,
    manifestDigest,
    attachmentIds: selected.map((attachment) => attachment.id),
  }
}

export async function importPerformanceCapture(input: {
  db: CogniaDB
  quota: PerformanceQuotaManager
  accountId: string
  targetDatabase: string
  targetId: string
  key: Uint8Array
  packageBytes: Uint8Array
  trustedProducerFingerprints?: ReadonlySet<string>
  now?: number
}): Promise<string> {
  const validated = await validateCogniaPerfPackage(
    input.packageBytes,
    input.trustedProducerFingerprints
  )
  const now = input.now ?? Date.now()
  const id = `capture-${crypto.randomUUID()}`
  const generation = getPerformanceSecurityGeneration()
  const sampleEntries = [...validated.entries]
    .filter(([path]) => path.startsWith("samples/"))
    .sort(([left], [right]) => left.localeCompare(right))
  if (sampleEntries.length === 0) throw new Error("cognia-perf-samples-missing")
  const metadataEntries = [...validated.entries].filter(
    ([path]) => path === "metadata/capture.json"
  )
  if (metadataEntries.length > 1) throw new Error("cognia-perf-metadata-duplicate")
  const attachmentEntries = [...validated.entries]
    .filter(([path]) => path.startsWith("attachments/"))
    .sort(([left], [right]) => left.localeCompare(right))
  const semanticBytes = [...metadataEntries, ...sampleEntries, ...attachmentEntries].reduce(
    (total, [, value]) => total + value.byteLength,
    0
  )
  const reservation = await input.quota.reserve({
    accountId: input.accountId,
    targetDatabase: input.targetDatabase,
    captureId: id,
    worstCaseBytes:
      semanticBytes +
      (metadataEntries.length + sampleEntries.length + attachmentEntries.length) * 256,
    now,
  })
  const chunks: PerformanceCaptureChunkRow[] = []
  const attachments: PerformanceCaptureAttachmentRow[] = []
  let frameCount = 0
  let actualBytes = 0
  let metadataEnvelope: Awaited<ReturnType<typeof encryptPerformanceArtifact>> | null = null
  let metadataDigest: string | undefined
  let environmentDigest: string | undefined
  try {
    if (metadataEntries[0]) {
      const metadataPlain = metadataEntries[0][1]
      const parsed = JSON.parse(new TextDecoder().decode(metadataPlain)) as unknown
      if (!parsed || typeof parsed !== "object" || !("source" in parsed)) {
        throw new Error("cognia-perf-metadata-schema-invalid")
      }
      const metadata = parsed as { environment?: unknown }
      metadataEnvelope = await encryptPerformanceArtifact(
        input.key,
        metadataPlain,
        {
          accountId: input.accountId,
          targetDatabase: input.targetDatabase,
          captureId: id,
          ordinal: -1,
          contentType: METADATA_CONTENT_TYPE,
        },
        generation
      )
      metadataDigest = await sha256(metadataPlain)
      environmentDigest = await sha256(
        new TextEncoder().encode(JSON.stringify(metadata.environment ?? null))
      )
      actualBytes += metadataEnvelope.iv.byteLength + metadataEnvelope.ciphertext.byteLength
    }
    for (const [index, [, plain]] of sampleEntries.entries()) {
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown
      if (!Array.isArray(parsed) || parsed.some((frame) => !isPortableFrame(frame))) {
        throw new Error("cognia-perf-frame-schema-invalid")
      }
      const frames = parsed as PerfFrame[]
      const envelope = await encryptPerformanceArtifact(
        input.key,
        plain,
        {
          accountId: input.accountId,
          targetDatabase: input.targetDatabase,
          captureId: id,
          ordinal: index,
          contentType: FRAME_CONTENT_TYPE,
        },
        generation
      )
      const byteCount = envelope.iv.byteLength + envelope.ciphertext.byteLength
      actualBytes += byteCount
      frameCount += frames.length
      chunks.push({
        id: `${id}:chunk:${index}`,
        captureId: id,
        ordinal: index,
        frameCount: frames.length,
        firstSequence: frames[0]?.sequence ?? 0,
        lastSequence: frames.at(-1)?.sequence ?? 0,
        byteCount,
        contentType: FRAME_CONTENT_TYPE,
        iv: ownedBuffer(envelope.iv),
        ciphertext: ownedBuffer(envelope.ciphertext),
        digest: await sha256(plain),
      })
    }
    for (const [offset, [path, plain]] of attachmentEntries.entries()) {
      const descriptor = validated.manifest.entries.find((entry) => entry.path === path)!
      const ordinal = sampleEntries.length + offset
      const envelope = await encryptPerformanceArtifact(
        input.key,
        plain,
        {
          accountId: input.accountId,
          targetDatabase: input.targetDatabase,
          captureId: id,
          ordinal,
          contentType: descriptor.contentType,
        },
        generation
      )
      const byteCount = envelope.iv.byteLength + envelope.ciphertext.byteLength
      actualBytes += byteCount
      attachments.push({
        id: `${id}:attachment:${ordinal}`,
        captureId: id,
        ordinal,
        byteCount,
        contentType: descriptor.contentType,
        iv: ownedBuffer(envelope.iv),
        ciphertext: ownedBuffer(envelope.ciphertext),
        digest: await sha256(plain),
      })
    }
    const firstFrame = JSON.parse(new TextDecoder().decode(sampleEntries[0][1]))[0] as PerfFrame
    const row: PerformanceCaptureRow = {
      id,
      status: "importing",
      purpose: "capture",
      sourceKind: validated.manifest.capture.sourceKind,
      sourceId: firstFrame?.sourceId ?? "imported",
      hostInstanceId: firstFrame?.hostInstanceId ?? "imported",
      targetId: input.targetId,
      routingGeneration: 0,
      wireVersion: validated.manifest.capture.wireVersion,
      metricSchemaVersion: validated.manifest.capture.metricSchemaVersion,
      capabilityBits: "imported",
      startedAt: firstFrame?.wallStartMs ?? now,
      stoppedAt: (JSON.parse(new TextDecoder().decode(sampleEntries.at(-1)![1])) as PerfFrame[]).at(
        -1
      )?.wallEndMs,
      updatedAt: now,
      stopReason: "manual",
      pinned: 0,
      payloadBytes:
        chunks.reduce((sum, chunk) => sum + chunk.byteCount, 0) +
        (metadataEnvelope
          ? metadataEnvelope.iv.byteLength + metadataEnvelope.ciphertext.byteLength
          : 0),
      attachmentBytes: attachments.reduce((sum, attachment) => sum + attachment.byteCount, 0),
      frameCount,
      gapCount: 0,
      environmentDigest,
      metadataContentType: metadataEnvelope ? METADATA_CONTENT_TYPE : undefined,
      metadataByteCount: metadataEnvelope
        ? metadataEnvelope.iv.byteLength + metadataEnvelope.ciphertext.byteLength
        : undefined,
      metadataDigest,
      metadataIv: metadataEnvelope ? ownedBuffer(metadataEnvelope.iv) : undefined,
      metadataCiphertext: metadataEnvelope ? ownedBuffer(metadataEnvelope.ciphertext) : undefined,
      digest: validated.manifest.capture.digest,
      originalCaptureId: validated.manifest.capture.originalId,
      originalDigest: validated.manifest.capture.digest,
      importedAt: now,
      trustState: validated.trustState,
    }
    await input.db.transaction(
      "rw",
      input.db.performanceCaptures,
      input.db.performanceCaptureChunks,
      input.db.performanceCaptureAttachments,
      async () => {
        await input.db.performanceCaptures.add(row)
        await input.db.performanceCaptureChunks.bulkAdd(chunks)
        if (attachments.length) await input.db.performanceCaptureAttachments.bulkAdd(attachments)
        await input.db.performanceCaptures.update(id, { status: "ready", updatedAt: now })
      }
    )
    await input.quota.commit(reservation.id, actualBytes, now)
    return id
  } catch (error) {
    await input.db.transaction(
      "rw",
      input.db.performanceCaptures,
      input.db.performanceCaptureChunks,
      input.db.performanceCaptureAttachments,
      async () => {
        await input.db.performanceCaptureChunks.where("captureId").equals(id).delete()
        await input.db.performanceCaptureAttachments.where("captureId").equals(id).delete()
        await input.db.performanceCaptures.delete(id)
      }
    )
    await input.quota.abandon(reservation.id)
    throw error
  }
}

function isPortableFrame(value: unknown): value is PerfFrame {
  if (!value || typeof value !== "object") return false
  const frame = value as Partial<PerfFrame>
  return (
    frame.wireVersion === 1 &&
    typeof frame.sourceId === "string" &&
    typeof frame.hostInstanceId === "string" &&
    Number.isSafeInteger(frame.sequence) &&
    Number.isFinite(frame.actualIntervalMs) &&
    Number.isFinite(frame.wallStartMs) &&
    Number.isFinite(frame.wallEndMs) &&
    Array.isArray(frame.processes) &&
    Array.isArray(frame.managed)
  )
}
