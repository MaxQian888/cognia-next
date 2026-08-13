import JSZip from "jszip"

import {
  CRASH_LOG_KEY_HINTS,
  CRASH_LOG_TEXT_REDACTION_PATTERNS,
} from "@cognia/logging/redaction-patterns"
import { canonicalJsonBytes } from "@/lib/plugin/character-pack/canonical-json"
import type { PerfSignatureTrustState } from "./capture-types"

export const COGNIA_PERF_FORMAT = "cognia-perf/v1" as const
export const COGNIA_PERF_MAX_COMPRESSED_BYTES = 512 * 1024 * 1024
export const COGNIA_PERF_MAX_DECOMPRESSED_BYTES = 1024 * 1024 * 1024
export const COGNIA_PERF_MAX_SEMANTIC_BYTES = 512 * 1024 * 1024
export const COGNIA_PERF_MAX_ENTRY_BYTES = 256 * 1024 * 1024
export const COGNIA_PERF_MAX_MANIFEST_BYTES = 8 * 1024 * 1024
export const COGNIA_PERF_MAX_ENTRIES = 4096

export type PerfPackageRedactionMode = "redacted" | "raw" | "passphrase"

export interface PerfPackageEntryDescriptor {
  path: string
  contentType: string
  size: number
  sha256: string
  attachment: boolean
}

export interface PerfPackageSignature {
  algorithm: "P-256-SHA-256"
  publicKeyJwk: JsonWebKey
  producerFingerprint: string
  value: string
}

export interface PerfPackageManifest {
  format: typeof COGNIA_PERF_FORMAT
  capture: {
    originalId: string
    digest: string
    wireVersion: number
    metricSchemaVersion: number
    sourceKind: "renderer" | "host"
  }
  redactionMode: PerfPackageRedactionMode
  producerFingerprint: string
  issuedAt: string
  entries: PerfPackageEntryDescriptor[]
  signature?: PerfPackageSignature
}

export interface PerfPackageEntryInput {
  path: string
  contentType: string
  bytes: Uint8Array
  attachment?: boolean
}

function toBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let value = ""
    for (const byte of bytes) value += String.fromCharCode(byte)
    return btoa(value)
  }
  return Buffer.from(bytes).toString("base64")
}

function fromBase64(value: string): Uint8Array {
  if (typeof atob === "function") {
    const decoded = atob(value)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function assertSafePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`cognia-perf-invalid-path:${path}`)
  }
}

function assertContentType(contentType: string): void {
  const allowed =
    contentType === "application/json" ||
    contentType === "application/octet-stream" ||
    contentType === "text/plain" ||
    contentType.startsWith("application/vnd.cognia.perf-")
  if (!allowed) throw new Error(`cognia-perf-invalid-content-type:${contentType}`)
}

function signingPayload(manifest: PerfPackageManifest): Uint8Array {
  return canonicalJsonBytes({
    format: manifest.format,
    capture: manifest.capture,
    redactionMode: manifest.redactionMode,
    producerFingerprint: manifest.producerFingerprint,
    issuedAt: manifest.issuedAt,
    entries: [...manifest.entries].sort((left, right) => left.path.localeCompare(right.path)),
  })
}

export async function derivePerfProducerFingerprint(publicKeyJwk: JsonWebKey): Promise<string> {
  if (
    publicKeyJwk.kty !== "EC" ||
    publicKeyJwk.crv !== "P-256" ||
    typeof publicKeyJwk.x !== "string" ||
    typeof publicKeyJwk.y !== "string"
  ) {
    throw new Error("cognia-perf-signing-key-invalid")
  }
  return `sha256:${await sha256(
    canonicalJsonBytes({
      crv: publicKeyJwk.crv,
      kty: publicKeyJwk.kty,
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
    })
  )}`
}

async function importSigningPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ])
}

async function importSigningPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ])
}

export async function createPerfRawExportConfirmation(input: {
  captureIds: readonly string[]
  manifestDigest: string
  attachmentPaths: readonly string[]
}): Promise<string> {
  return sha256(
    canonicalJsonBytes({
      captureIds: [...input.captureIds].sort(),
      manifestDigest: input.manifestDigest,
      attachmentPaths: [...input.attachmentPaths].sort(),
      confirmation: "raw-performance-export",
    })
  )
}

export async function buildCogniaPerfPackage(input: {
  capture: PerfPackageManifest["capture"]
  redactionMode: PerfPackageRedactionMode
  producerFingerprint: string
  issuedAt: string
  entries: readonly PerfPackageEntryInput[]
  signingPrivateKeyJwk?: JsonWebKey
  signingPublicKeyJwk?: JsonWebKey
  rawConfirmation?: { expected: string; provided: string }
}): Promise<Uint8Array> {
  if (
    input.redactionMode === "raw" &&
    (!input.rawConfirmation || input.rawConfirmation.expected !== input.rawConfirmation.provided)
  ) {
    throw new Error("cognia-perf-raw-confirmation-required")
  }
  if (input.entries.length === 0 || input.entries.length > COGNIA_PERF_MAX_ENTRIES) {
    throw new Error("cognia-perf-entry-count-invalid")
  }
  const seen = new Set<string>(["manifest.json"])
  let semanticBytes = 0
  const descriptors: PerfPackageEntryDescriptor[] = []
  for (const entry of input.entries) {
    assertSafePath(entry.path)
    assertContentType(entry.contentType)
    if (seen.has(entry.path)) throw new Error(`cognia-perf-duplicate-path:${entry.path}`)
    seen.add(entry.path)
    if (entry.bytes.byteLength > COGNIA_PERF_MAX_ENTRY_BYTES) {
      throw new Error(`cognia-perf-entry-too-large:${entry.path}`)
    }
    semanticBytes += entry.bytes.byteLength
    if (semanticBytes > COGNIA_PERF_MAX_SEMANTIC_BYTES) {
      throw new Error("cognia-perf-semantic-size-exceeded")
    }
    descriptors.push({
      path: entry.path,
      contentType: entry.contentType,
      size: entry.bytes.byteLength,
      sha256: await sha256(entry.bytes),
      attachment: entry.attachment === true,
    })
  }
  descriptors.sort((left, right) => left.path.localeCompare(right.path))
  const manifest: PerfPackageManifest = {
    format: COGNIA_PERF_FORMAT,
    capture: input.capture,
    redactionMode: input.redactionMode,
    producerFingerprint: input.producerFingerprint,
    issuedAt: input.issuedAt,
    entries: descriptors,
  }
  if (Boolean(input.signingPrivateKeyJwk) !== Boolean(input.signingPublicKeyJwk)) {
    throw new Error("cognia-perf-signing-key-pair-required")
  }
  if (input.signingPrivateKeyJwk && input.signingPublicKeyJwk) {
    if (
      (await derivePerfProducerFingerprint(input.signingPublicKeyJwk)) !== input.producerFingerprint
    ) {
      throw new Error("cognia-perf-producer-key-mismatch")
    }
    const privateKey = await importSigningPrivateKey(input.signingPrivateKeyJwk)
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      signingPayload(manifest)
    )
    manifest.signature = {
      algorithm: "P-256-SHA-256",
      publicKeyJwk: input.signingPublicKeyJwk,
      producerFingerprint: input.producerFingerprint,
      value: toBase64(new Uint8Array(signature)),
    }
  }
  const zip = new JSZip()
  zip.file("manifest.json", canonicalJsonBytes(manifest))
  for (const entry of input.entries) zip.file(entry.path, entry.bytes)
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  if (bytes.byteLength > COGNIA_PERF_MAX_COMPRESSED_BYTES) {
    throw new Error("cognia-perf-compressed-size-exceeded")
  }
  return bytes
}

function assertManifest(value: unknown): asserts value is PerfPackageManifest {
  if (!value || typeof value !== "object") throw new Error("cognia-perf-manifest-invalid")
  const manifest = value as Partial<PerfPackageManifest>
  if (manifest.format !== COGNIA_PERF_FORMAT) throw new Error("cognia-perf-format-unsupported")
  if (!manifest.capture || !Array.isArray(manifest.entries))
    throw new Error("cognia-perf-manifest-invalid")
  if (!manifest.entries.length || manifest.entries.length > COGNIA_PERF_MAX_ENTRIES) {
    throw new Error("cognia-perf-entry-count-invalid")
  }
  if (!new Set(["redacted", "raw", "passphrase"]).has(manifest.redactionMode ?? "")) {
    throw new Error("cognia-perf-redaction-mode-invalid")
  }
}

export async function validateCogniaPerfPackage(
  bytes: Uint8Array,
  trustedProducerFingerprints: ReadonlySet<string> = new Set()
): Promise<{
  manifest: PerfPackageManifest
  entries: Map<string, Uint8Array>
  trustState: PerfSignatureTrustState
}> {
  if (bytes.byteLength > COGNIA_PERF_MAX_COMPRESSED_BYTES) {
    throw new Error("cognia-perf-compressed-size-exceeded")
  }
  // Descriptor SHA-256 checks below supersede ZIP CRC32. Enabling JSZip's CRC
  // check would inflate every entry before these declared-size limits run.
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false })
  const archiveEntries = Object.values(zip.files)
  const archiveFiles = archiveEntries.filter((entry) => !entry.dir)
  if (archiveFiles.length > COGNIA_PERF_MAX_ENTRIES + 1) {
    throw new Error("cognia-perf-entry-count-invalid")
  }
  let declaredDecompressedBytes = 0
  for (const entry of archiveFiles) {
    const metadata = entry as typeof entry & {
      unsafeOriginalName?: string
      _data?: { uncompressedSize?: number }
    }
    assertSafePath(metadata.unsafeOriginalName ?? entry.name)
    assertSafePath(entry.name)
    const declaredSize = metadata._data?.uncompressedSize
    if (declaredSize !== undefined) {
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new Error(`cognia-perf-entry-size-invalid:${entry.name}`)
      }
      if (entry.name === "manifest.json" && declaredSize > COGNIA_PERF_MAX_MANIFEST_BYTES) {
        throw new Error("cognia-perf-manifest-too-large")
      }
      if (entry.name !== "manifest.json" && declaredSize > COGNIA_PERF_MAX_ENTRY_BYTES) {
        throw new Error(`cognia-perf-entry-size-invalid:${entry.name}`)
      }
      declaredDecompressedBytes += declaredSize
      if (declaredDecompressedBytes > COGNIA_PERF_MAX_DECOMPRESSED_BYTES) {
        throw new Error("cognia-perf-decompression-limit-exceeded")
      }
    }
  }
  const manifestEntry = zip.file("manifest.json")
  if (!manifestEntry) throw new Error("cognia-perf-manifest-missing")
  const manifestBytes = await manifestEntry.async("uint8array")
  if (manifestBytes.byteLength > COGNIA_PERF_MAX_MANIFEST_BYTES) {
    throw new Error("cognia-perf-manifest-too-large")
  }
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown
  assertManifest(manifest)
  const descriptors = [...manifest.entries].sort((left, right) =>
    left.path.localeCompare(right.path)
  )
  const descriptorPaths = new Set<string>()
  let total = manifestBytes.byteLength
  let semanticTotal = 0
  const entries = new Map<string, Uint8Array>()
  for (const descriptor of descriptors) {
    assertSafePath(descriptor.path)
    assertContentType(descriptor.contentType)
    if (descriptorPaths.has(descriptor.path)) {
      throw new Error(`cognia-perf-duplicate-path:${descriptor.path}`)
    }
    descriptorPaths.add(descriptor.path)
    if (
      !Number.isSafeInteger(descriptor.size) ||
      descriptor.size < 0 ||
      descriptor.size > COGNIA_PERF_MAX_ENTRY_BYTES
    ) {
      throw new Error(`cognia-perf-entry-size-invalid:${descriptor.path}`)
    }
    const entry = zip.file(descriptor.path)
    if (!entry) throw new Error(`cognia-perf-entry-missing:${descriptor.path}`)
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string })
      .unsafeOriginalName
    if (originalName && originalName !== descriptor.path) assertSafePath(originalName)
    const content = await entry.async("uint8array")
    total += content.byteLength
    semanticTotal += content.byteLength
    if (
      total > COGNIA_PERF_MAX_DECOMPRESSED_BYTES ||
      semanticTotal > COGNIA_PERF_MAX_SEMANTIC_BYTES
    ) {
      throw new Error("cognia-perf-decompression-limit-exceeded")
    }
    if (content.byteLength !== descriptor.size || (await sha256(content)) !== descriptor.sha256) {
      throw new Error(`cognia-perf-entry-integrity-failed:${descriptor.path}`)
    }
    entries.set(descriptor.path, content)
  }
  const unexpected = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name !== "manifest.json" && !descriptorPaths.has(entry.name)
  )
  if (unexpected.length > 0) throw new Error(`cognia-perf-unexpected-entry:${unexpected[0].name}`)

  let trustState: PerfSignatureTrustState = "origin-unverified"
  if (manifest.signature) {
    if (
      manifest.signature.algorithm !== "P-256-SHA-256" ||
      manifest.signature.producerFingerprint !== manifest.producerFingerprint
    ) {
      throw new Error("cognia-perf-signature-invalid")
    }
    if (
      (await derivePerfProducerFingerprint(manifest.signature.publicKeyJwk)) !==
      manifest.producerFingerprint
    ) {
      throw new Error("cognia-perf-producer-key-mismatch")
    }
    const publicKey = await importSigningPublicKey(manifest.signature.publicKeyJwk)
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64(manifest.signature.value),
      signingPayload({ ...manifest, signature: undefined })
    )
    if (!verified) throw new Error("cognia-perf-signature-invalid")
    trustState = trustedProducerFingerprints.has(manifest.producerFingerprint)
      ? "verified"
      : "valid-untrusted"
  }
  return { manifest, entries, trustState }
}

const sensitiveKeys = new Set([
  ...CRASH_LOG_KEY_HINTS.map((key) => key.toLowerCase()),
  "name",
  "process",
  "span",
  "trace",
  "error",
  "hostname",
  "url",
  "path",
  "project",
])
const PERFORMANCE_STRUCTURED_REDACTION_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
]

async function pseudonym(value: string, salt: string): Promise<string> {
  return `perf_${(await sha256(new TextEncoder().encode(`${salt}\u001f${value}`))).slice(0, 16)}`
}

export async function redactPerformanceValue(
  value: unknown,
  salt: string,
  key = ""
): Promise<unknown> {
  if (typeof value === "string") {
    if (sensitiveKeys.has(key.toLowerCase())) return pseudonym(value, salt)
    const crashRedacted = CRASH_LOG_TEXT_REDACTION_PATTERNS.reduce((current, pattern) => {
      try {
        return current.replace(new RegExp(pattern, "gi"), "[REDACTED]")
      } catch {
        return current
      }
    }, value)
    return PERFORMANCE_STRUCTURED_REDACTION_PATTERNS.reduce(
      (current, pattern) => current.replace(pattern, "[REDACTED]"),
      crashRedacted
    )
  }
  if (Array.isArray(value))
    return Promise.all(value.map((item) => redactPerformanceValue(item, salt, key)))
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = await redactPerformanceValue(child, salt, childKey)
    }
    return result
  }
  return value
}
