/**
 * The archive half of a signed, content-addressed package.
 *
 * Two formats ship as "a canonical JSON manifest plus hashed files in a zip,
 * signed with the publisher key": template packages (ADR-0100 / ADR-0164) and
 * cogpacks (ADR-0209). What they share is not their manifest but everything
 * around it: deterministic zip output, hardened extraction (path, size, file
 * count and compression-ratio limits), per-file sha256 checks, the
 * undeclared-file rule and Ed25519 verification of the manifest. That lives
 * here once; each format owns its manifest and its label.
 *
 * `label` is the noun used in error messages ("Template package", "Cogpack").
 * The messages are part of each format's tested contract, so they are built
 * from the label rather than re-worded per caller.
 */

import type JSZip from "jszip"

import { sha256Bytes } from "@/lib/ocr/hash"
import { decodeBase64 } from "@/lib/share/encoding"

import { PackageFormatError, safeArchivePath } from "./archive-path"

export { safeArchivePath } from "./archive-path"

/**
 * JSZip is loaded lazily, and must stay that way. The template manifest
 * validator is reachable from the plugin store's import graph, and jszip
 * bundles the `setimmediate` polyfill, whose on-import global patching breaks
 * `fake-indexeddb` in every Jest suite that reaches it. Only the archive
 * functions need it, and all of them are async.
 */
export async function loadJSZip(): Promise<typeof JSZip> {
  return (await import("jszip")).default
}

export interface PackageSignature {
  algorithm: "ed25519"
  /** Display name of the signer. */
  publisher: string
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string
  /** Base64 raw 64-byte Ed25519 signature over the canonical manifest. */
  signature: string
}

export interface PackageFileRecord {
  path: string
  sha256: string
  size?: number
}

export interface ArchiveLimits {
  maxCompressedBytes: number
  maxExpandedBytes: number
  maxFiles: number
  maxCompressionRatio: number
  maxPathDepth: number
}

/** The zip timestamp every entry carries, so identical input gives identical bytes. */
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z")

function decodeSignaturePart(value: string, label: string): Uint8Array {
  try {
    return decodeBase64(value)
  } catch {
    throw new PackageFormatError("signature-invalid", `${label} signature encoding is invalid`)
  }
}

/**
 * Verify `signature` over `payload`. Resolves on success and throws on any
 * failure, including a malformed key or signature, so a caller cannot mistake
 * "could not check" for "checked".
 */
export async function verifyEd25519PackageSignature(
  signature: PackageSignature,
  payload: Uint8Array,
  label: string
): Promise<void> {
  const publicKey = decodeSignaturePart(signature.publicKey, label)
  const signatureBytes = decodeSignaturePart(signature.signature, label)
  if (publicKey.byteLength !== 32 || signatureBytes.byteLength !== 64) {
    throw new PackageFormatError("signature-invalid", `${label} Ed25519 signature shape is invalid`)
  }
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey), "Ed25519", false, [
      "verify",
    ])
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signatureBytes),
      Uint8Array.from(payload)
    )
    if (!valid) {
      throw new PackageFormatError("signature-invalid", `${label} signature verification failed`)
    }
  } catch (error) {
    if (error instanceof PackageFormatError) throw error
    throw new PackageFormatError(
      "signature-invalid",
      `${label} signature verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

export interface ArchiveEntry {
  path: string
  data: string | Uint8Array
}

/**
 * Write entries into a deterministic zip. Entries are written in the order
 * given; callers sort them so the same package always has the same bytes.
 */
export async function writeDeterministicZip(
  entries: readonly ArchiveEntry[],
  limits: Pick<ArchiveLimits, "maxCompressedBytes">,
  label: string
): Promise<Uint8Array> {
  const JSZipCtor = await loadJSZip()
  const zip = new JSZipCtor()
  for (const entry of entries) {
    zip.file(entry.path, entry.data, { date: FIXED_ZIP_DATE, createFolders: false })
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  })
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new PackageFormatError(
      "too-large",
      `${label} exceeds ${limits.maxCompressedBytes} compressed bytes`
    )
  }
  return bytes
}

export interface OpenedArchive {
  zip: JSZip
  /** Every entry, directories included, as JSZip lists them. */
  files: JSZip.JSZipObject[]
}

/**
 * Open a package zip with every structural limit enforced before any entry is
 * inflated: compressed size, file count, path safety of both the stored and
 * the sanitized name, and the declared per-file and total expansion.
 */
export async function openHardenedZip(
  bytes: Uint8Array,
  limits: ArchiveLimits,
  label: string
): Promise<OpenedArchive> {
  if (bytes.byteLength > limits.maxCompressedBytes) {
    throw new PackageFormatError(
      "too-large",
      `${label} exceeds ${limits.maxCompressedBytes} compressed bytes`
    )
  }
  const JSZipCtor = await loadJSZip()
  let zip: JSZip
  try {
    zip = await JSZipCtor.loadAsync(bytes)
  } catch (error) {
    throw new PackageFormatError(
      "unreadable",
      `Failed to read ${label.toLowerCase()}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const files = Object.values(zip.files)
  if (files.length > limits.maxFiles) {
    throw new PackageFormatError("too-many-files", `${label} exceeds ${limits.maxFiles} files`)
  }
  for (const file of files) {
    if (file.dir) continue
    const original = (file as JSZip.JSZipObject & { unsafeOriginalName?: string })
      .unsafeOriginalName
    safeArchivePath(original ?? file.name, limits.maxPathDepth, label)
    safeArchivePath(file.name, limits.maxPathDepth, label)
  }
  const declaredExpandedBytes = files.reduce((total, file) => {
    if (file.dir) return total
    const sizes = (
      file as JSZip.JSZipObject & {
        _data?: { compressedSize?: number; uncompressedSize?: number }
      }
    )._data
    const expanded = sizes?.uncompressedSize ?? 0
    const compressed = sizes?.compressedSize ?? 0
    if (
      expanded > limits.maxExpandedBytes ||
      (compressed > 0 && expanded / compressed > limits.maxCompressionRatio)
    ) {
      throw new PackageFormatError(
        "unsafe-expansion",
        `${label} file has unsafe archive expansion: ${file.name}`
      )
    }
    return total + expanded
  }, 0)
  if (declaredExpandedBytes > limits.maxExpandedBytes) {
    throw new PackageFormatError(
      "too-large",
      `${label} exceeds ${limits.maxExpandedBytes} expanded bytes`
    )
  }
  return { zip, files }
}

/**
 * Read one declared file and check it against its record. `knownPaths`
 * collects every declared path so {@link assertNoUndeclaredFiles} can refuse
 * extras; a path declared twice is refused here.
 */
export async function readDeclaredFile(
  archive: OpenedArchive,
  record: PackageFileRecord,
  knownPaths: Set<string>,
  limits: Pick<ArchiveLimits, "maxPathDepth">,
  label: string,
  kind: string
): Promise<{ path: string; bytes: Uint8Array }> {
  if (!record || typeof record.path !== "string" || typeof record.sha256 !== "string") {
    throw new PackageFormatError("record-invalid", `${label} ${kind} record is invalid`)
  }
  const path = safeArchivePath(record.path, limits.maxPathDepth, label)
  if (knownPaths.has(path)) {
    throw new PackageFormatError("duplicate-path", `${label} has duplicate path ${path}`)
  }
  knownPaths.add(path)
  const file = archive.zip.file(path)
  if (!file || file.dir) {
    throw new PackageFormatError("file-missing", `${label} ${kind} is missing: ${path}`)
  }
  const bytes = await file.async("uint8array")
  if ((await sha256Bytes(bytes)) !== record.sha256) {
    throw new PackageFormatError("checksum-mismatch", `${label} ${kind} checksum mismatch: ${path}`)
  }
  return { path, bytes }
}

/** Refuse any entry the manifest did not declare. */
export function assertNoUndeclaredFiles(
  archive: OpenedArchive,
  knownPaths: ReadonlySet<string>,
  label: string
): void {
  for (const file of archive.files) {
    if (!file.dir && !knownPaths.has(file.name)) {
      throw new PackageFormatError(
        "undeclared-path",
        `${label} contains undeclared path ${file.name}`
      )
    }
  }
}
