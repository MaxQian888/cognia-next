import {
  decryptContentEnvelope,
  encryptContentEnvelope,
  type ContentEnvelopeCryptoInput,
  type EncryptedContentEnvelopeV1,
  type EncryptContentEnvelopeInput,
} from "./control-plane"
import { BM25Index, type BM25SnapshotV1 } from "./hybrid-search"

const MAGIC = "COGNIA_BM25_SEGMENT_V1\n"

export interface BM25SegmentIdentity {
  corpusId: string
  generationId: string
  profileFingerprint: string
  ordinal: number
}

export interface EncryptedBM25SegmentV1 {
  version: 1
  identity: BM25SegmentIdentity
  documentCount: number
  envelope: EncryptedContentEnvelopeV1
}

function additionalData(identity: BM25SegmentIdentity): string {
  if (
    !identity.corpusId ||
    !identity.generationId ||
    !identity.profileFingerprint ||
    !Number.isInteger(identity.ordinal) ||
    identity.ordinal < 0
  ) {
    throw new Error("A complete BM25 segment identity is required")
  }
  return [
    "bm25-segment-v1",
    identity.corpusId,
    identity.generationId,
    identity.profileFingerprint,
    identity.ordinal,
  ].join(":")
}

function encodeSnapshot(snapshot: BM25SnapshotV1): string {
  return MAGIC + JSON.stringify(snapshot)
}

function decodeSnapshot(payload: string): BM25SnapshotV1 {
  if (!payload.startsWith(MAGIC)) throw new Error("Invalid BM25 segment header")
  const parsed: unknown = JSON.parse(payload.slice(MAGIC.length))
  if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
    throw new Error("Invalid BM25 segment payload")
  }
  return parsed as BM25SnapshotV1
}

export async function encryptBM25Segment(
  index: BM25Index,
  identity: BM25SegmentIdentity,
  cryptoInput: Omit<EncryptContentEnvelopeInput, "additionalData">
): Promise<EncryptedBM25SegmentV1> {
  const snapshot = index.exportSnapshot()
  return {
    version: 1,
    identity,
    documentCount: snapshot.documents.length,
    envelope: await encryptContentEnvelope(encodeSnapshot(snapshot), {
      ...cryptoInput,
      additionalData: additionalData(identity),
    }),
  }
}

export async function decryptBM25Segment(
  segment: EncryptedBM25SegmentV1,
  cryptoInput: Omit<ContentEnvelopeCryptoInput, "additionalData">
): Promise<BM25Index> {
  if (segment.version !== 1) throw new Error("Unsupported BM25 segment version")
  const payload = await decryptContentEnvelope(segment.envelope, {
    ...cryptoInput,
    additionalData: additionalData(segment.identity),
  })
  const index = BM25Index.fromSnapshot(decodeSnapshot(payload))
  if (index.size() !== segment.documentCount) throw new Error("BM25 segment count mismatch")
  return index
}
