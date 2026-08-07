import {
  createBackupChunkCipher,
  sha256Hex,
  type BackupChunkCipher,
  type BackupChunkEncryptionConfig,
} from "./crypto"
import { canonicalStringify } from "./migrate"
import type { BackupPersistenceBackend } from "./types"

const FORMAT = "cognia-backup-stream" as const
const VERSION = "4.0" as const
const encoder = new TextEncoder()
const SECTION_NAME = /^[A-Za-z][A-Za-z0-9]*$/
const SHA256_HEX = /^[a-f0-9]{64}$/

export interface BackupStreamManifestV4 {
  traceId: string
  exportedAt: string
  appVersion: string
  backend: BackupPersistenceBackend
  sourceSchemaVersion: number
  device?: { id: string; label?: string; platform?: string }
}

export interface BackupStreamSection {
  section: string
  rows: readonly unknown[]
}

export interface CreateBackupStreamOptions {
  manifest: BackupStreamManifestV4
  sections: AsyncIterable<BackupStreamSection>
  /** Encrypt each chunk independently so no whole-file ciphertext buffer exists. */
  encryption?: { passphrase: string }
  /** Maximum UTF-8 bytes in one decoded `{ section, rows }` payload. */
  maxChunkBytes?: number
}

export interface ReadBackupStreamOptions {
  passphrase?: string
  /** Reject malicious or corrupt NDJSON records before unbounded buffering. */
  maxRecordBytes?: number
}

export type BackupStreamReadEvent =
  | {
      kind: "header"
      format: typeof FORMAT
      version: typeof VERSION
      manifest: BackupStreamManifestV4
      integrity: { algorithm: "SHA-256-CHAIN" }
      encryption: BackupChunkEncryptionConfig | null
    }
  | { kind: "chunk"; sequence: number; section: string; rows: unknown[] }
  | {
      kind: "footer"
      sequence: number
      chunkCount: number
      rowCount: number
      sectionCounts: Record<string, number>
    }

interface StreamHeader {
  kind: "header"
  format: typeof FORMAT
  version: typeof VERSION
  manifest: BackupStreamManifestV4
  integrity: { algorithm: "SHA-256-CHAIN" }
  encryption: BackupChunkEncryptionConfig | null
}

interface StreamChunk {
  kind: "chunk"
  sequence: number
  section: string
  rows: unknown[]
  checksum: string
}

interface StreamFooter {
  kind: "footer"
  sequence: number
  chunkCount: number
  rowCount: number
  sectionCounts: Record<string, number>
  chainHash: string
}

interface SealedRecord {
  kind: "sealed"
  sequence: number
  ciphertext: string
}

function line(value: unknown): Uint8Array {
  return encoder.encode(`${canonicalStringify(value)}\n`)
}

async function advanceChain(chain: string, sequence: number, checksum: string): Promise<string> {
  return sha256Hex(`${chain}:${sequence}:${checksum}`)
}

/**
 * Encode a v4 backup as newline-delimited records. Only the current page is
 * serialized at any point; callers retain control over IndexedDB page size.
 */
export async function* createBackupStream(
  options: CreateBackupStreamOptions
): AsyncIterable<Uint8Array> {
  const maxChunkBytes = Math.floor(options.maxChunkBytes ?? 8 * 1024 * 1024)
  if (maxChunkBytes <= 0) throw new RangeError("maxChunkBytes must be greater than zero")
  const cipher = options.encryption
    ? await createBackupChunkCipher(options.encryption.passphrase)
    : undefined
  const header: StreamHeader = {
    kind: "header",
    format: FORMAT,
    version: VERSION,
    manifest: options.manifest,
    integrity: { algorithm: "SHA-256-CHAIN" },
    encryption: cipher?.config ?? null,
  }
  yield line(header)

  let chain = await sha256Hex(canonicalStringify(header))
  let sequence = 0
  let rowCount = 0
  const sectionCounts: Record<string, number> = {}

  for await (const page of options.sections) {
    if (!SECTION_NAME.test(page.section))
      throw new TypeError("Backup stream section name is invalid")
    for (const rows of splitRows(page.section, page.rows, maxChunkBytes)) {
      const checksum = await sha256Hex(canonicalStringify({ section: page.section, rows }))
      const chunk: StreamChunk = {
        kind: "chunk",
        sequence,
        section: page.section,
        rows,
        checksum,
      }
      yield await encodeRecord(chunk, cipher, options.manifest.traceId)
      chain = await advanceChain(chain, sequence, checksum)
      rowCount += rows.length
      sectionCounts[page.section] = (sectionCounts[page.section] ?? 0) + rows.length
      sequence += 1
    }
  }

  const footer: StreamFooter = {
    kind: "footer",
    sequence,
    chunkCount: sequence,
    rowCount,
    sectionCounts,
    chainHash: chain,
  }
  yield await encodeRecord(footer, cipher, options.manifest.traceId)
}

/** Decode and authenticate a v4 stream without assembling a v3-style payload. */
export async function* readBackupStream(
  source: AsyncIterable<Uint8Array>,
  options: ReadBackupStreamOptions = {}
): AsyncIterable<BackupStreamReadEvent> {
  let header: StreamHeader | undefined
  let chain = ""
  let expectedSequence = 0
  let rowCount = 0
  const sectionCounts: Record<string, number> = {}
  let sawFooter = false
  let cipher: BackupChunkCipher | undefined

  const maxRecordBytes = Math.floor(options.maxRecordBytes ?? 16 * 1024 * 1024)
  if (maxRecordBytes <= 0) throw new RangeError("maxRecordBytes must be greater than zero")
  for await (const rawLine of decodeLines(source, maxRecordBytes)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLine)
    } catch {
      throw new TypeError("Backup stream contains invalid JSON")
    }
    if (!header) {
      header = parseHeader(parsed)
      chain = await sha256Hex(canonicalStringify(header))
      if (header.encryption) {
        if (!options.passphrase) throw new Error("Backup stream requires a passphrase")
        cipher = await createBackupChunkCipher(options.passphrase, header.encryption)
      }
      yield header
      continue
    }
    if (sawFooter) throw new TypeError("Backup stream contains records after its footer")

    const record = await decodeRecord(parsed, cipher, header.manifest.traceId, expectedSequence)
    if (record.kind === "chunk") {
      const chunk = parseChunk(record, expectedSequence)
      const actual = await sha256Hex(
        canonicalStringify({ section: chunk.section, rows: chunk.rows })
      )
      if (actual !== chunk.checksum) throw new Error("Backup stream chunk checksum mismatch")
      chain = await advanceChain(chain, chunk.sequence, chunk.checksum)
      expectedSequence += 1
      rowCount += chunk.rows.length
      sectionCounts[chunk.section] = (sectionCounts[chunk.section] ?? 0) + chunk.rows.length
      yield {
        kind: "chunk",
        sequence: chunk.sequence,
        section: chunk.section,
        rows: chunk.rows,
      }
      continue
    }
    if (record.kind === "footer") {
      const footer = parseFooter(record, expectedSequence)
      if (
        footer.chainHash !== chain ||
        footer.rowCount !== rowCount ||
        canonicalStringify(footer.sectionCounts) !== canonicalStringify(sectionCounts)
      ) {
        throw new Error("Backup stream footer integrity mismatch")
      }
      sawFooter = true
      yield {
        kind: "footer",
        sequence: footer.sequence,
        chunkCount: footer.chunkCount,
        rowCount: footer.rowCount,
        sectionCounts: footer.sectionCounts,
      }
      continue
    }
    throw new TypeError("Backup stream contains an unknown record")
  }

  if (!header) throw new TypeError("Backup stream is empty")
  if (!sawFooter) throw new Error("Backup stream is incomplete: footer is missing")
}

async function encodeRecord(
  record: StreamChunk | StreamFooter,
  cipher: BackupChunkCipher | undefined,
  traceId: string
): Promise<Uint8Array> {
  if (!cipher) return line(record)
  const sealed: SealedRecord = {
    kind: "sealed",
    sequence: record.sequence,
    ciphertext: await cipher.seal(
      record.sequence,
      canonicalStringify(record),
      recordAdditionalData(traceId, record.sequence)
    ),
  }
  return line(sealed)
}

async function decodeRecord(
  value: unknown,
  cipher: BackupChunkCipher | undefined,
  traceId: string,
  expectedSequence: number
): Promise<Partial<StreamChunk> | Partial<StreamFooter>> {
  if (!cipher) return value as Partial<StreamChunk> | Partial<StreamFooter>
  if (!value || typeof value !== "object") throw new TypeError("Encrypted backup record is invalid")
  const sealed = value as Partial<SealedRecord>
  if (
    sealed.kind !== "sealed" ||
    sealed.sequence !== expectedSequence ||
    typeof sealed.ciphertext !== "string"
  ) {
    throw new TypeError("Encrypted backup record is invalid or out of order")
  }
  const plainText = await cipher.open(
    expectedSequence,
    sealed.ciphertext,
    recordAdditionalData(traceId, expectedSequence)
  )
  try {
    return JSON.parse(plainText) as Partial<StreamChunk> | Partial<StreamFooter>
  } catch {
    throw new TypeError("Encrypted backup record contains invalid JSON")
  }
}

function recordAdditionalData(traceId: string, sequence: number): string {
  return `${FORMAT}:${VERSION}:${traceId}:${sequence}`
}

function splitRows(section: string, input: readonly unknown[], maxBytes: number): unknown[][] {
  const emptyBytes = encoder.encode(canonicalStringify({ section, rows: [] })).byteLength
  if (emptyBytes > maxBytes) {
    throw new RangeError(`Backup stream section "${section}" exceeds maxChunkBytes`)
  }
  if (input.length === 0) return [[]]
  const result: unknown[][] = []
  let current: unknown[] = []
  let currentBytes = emptyBytes

  for (const row of input) {
    const serialized = canonicalStringify(row)
    if (typeof serialized !== "string") {
      throw new TypeError(`Backup stream section "${section}" contains a non-serializable row`)
    }
    const rowBytes = encoder.encode(serialized).byteLength
    const addedBytes = rowBytes + (current.length === 0 ? 0 : 1)
    if (currentBytes + addedBytes > maxBytes && current.length > 0) {
      result.push(current)
      current = []
      currentBytes = emptyBytes
    }
    if (currentBytes + rowBytes > maxBytes) {
      throw new RangeError(`Backup stream row in section "${section}" exceeds maxChunkBytes`)
    }
    current.push(row)
    currentBytes += rowBytes + (current.length === 1 ? 0 : 1)
  }
  if (current.length > 0) result.push(current)
  return result
}

async function* decodeLines(
  source: AsyncIterable<Uint8Array>,
  maxRecordBytes: number
): AsyncIterable<string> {
  const decoder = new TextDecoder(undefined, { fatal: true })
  let parts: Uint8Array[] = []
  let size = 0

  const append = (part: Uint8Array) => {
    if (part.byteLength === 0) return
    size += part.byteLength
    if (size > maxRecordBytes) throw new RangeError("Backup stream record exceeds maxRecordBytes")
    parts.push(part)
  }
  const take = (): string => {
    const record = new Uint8Array(size)
    let offset = 0
    for (const part of parts) {
      record.set(part, offset)
      offset += part.byteLength
    }
    parts = []
    size = 0
    return decoder.decode(record)
  }

  for await (const bytes of source) {
    let start = 0
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue
      append(bytes.subarray(start, index))
      if (size > 0) yield take()
      start = index + 1
    }
    append(bytes.subarray(start))
  }
  if (size > 0) yield take()
}

function parseHeader(value: unknown): StreamHeader {
  if (!value || typeof value !== "object") throw new TypeError("Backup stream header is invalid")
  const header = value as Partial<StreamHeader>
  if (
    header.kind !== "header" ||
    header.format !== FORMAT ||
    header.version !== VERSION ||
    !isManifest(header.manifest) ||
    header.integrity?.algorithm !== "SHA-256-CHAIN" ||
    !isSupportedEncryption(header.encryption)
  ) {
    throw new TypeError("Unsupported backup stream header")
  }
  return header as StreamHeader
}

function isManifest(value: unknown): value is BackupStreamManifestV4 {
  if (!value || typeof value !== "object") return false
  const manifest = value as Partial<BackupStreamManifestV4>
  return (
    typeof manifest.traceId === "string" &&
    manifest.traceId.length > 0 &&
    typeof manifest.exportedAt === "string" &&
    Number.isFinite(Date.parse(manifest.exportedAt)) &&
    typeof manifest.appVersion === "string" &&
    (manifest.backend === "web-dexie" || manifest.backend === "tauri-dexie") &&
    typeof manifest.sourceSchemaVersion === "number" &&
    Number.isFinite(manifest.sourceSchemaVersion) &&
    manifest.sourceSchemaVersion >= 0
  )
}

function isSupportedEncryption(value: unknown): value is BackupChunkEncryptionConfig | null {
  if (value === null) return true
  if (!value || typeof value !== "object") return false
  const config = value as Partial<BackupChunkEncryptionConfig>
  return (
    config.enabled === true &&
    config.format === "aes-gcm-chunks-v1" &&
    config.algorithm === "AES-GCM" &&
    config.kdf?.algorithm === "PBKDF2" &&
    config.kdf.hash === "SHA-256" &&
    Number.isSafeInteger(config.kdf.iterations) &&
    Number(config.kdf.iterations) >= 100_000 &&
    Number(config.kdf.iterations) <= 2_000_000 &&
    typeof config.kdf.salt === "string" &&
    typeof config.noncePrefix === "string"
  )
}

function parseChunk(value: Partial<StreamChunk>, expectedSequence: number): StreamChunk {
  if (
    value.sequence !== expectedSequence ||
    typeof value.section !== "string" ||
    !SECTION_NAME.test(value.section) ||
    !Array.isArray(value.rows) ||
    typeof value.checksum !== "string" ||
    !SHA256_HEX.test(value.checksum)
  ) {
    throw new TypeError("Backup stream chunk is invalid or out of order")
  }
  return value as StreamChunk
}

function parseFooter(value: Partial<StreamFooter>, expectedSequence: number): StreamFooter {
  if (
    value.sequence !== expectedSequence ||
    value.chunkCount !== expectedSequence ||
    !Number.isSafeInteger(value.rowCount) ||
    Number(value.rowCount) < 0 ||
    !value.sectionCounts ||
    typeof value.sectionCounts !== "object" ||
    typeof value.chainHash !== "string" ||
    !SHA256_HEX.test(value.chainHash) ||
    !Object.entries(value.sectionCounts).every(
      ([section, count]) => SECTION_NAME.test(section) && Number.isSafeInteger(count) && count >= 0
    )
  ) {
    throw new TypeError("Backup stream footer is invalid")
  }
  return value as StreamFooter
}
