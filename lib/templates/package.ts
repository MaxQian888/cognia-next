import JSZip from "jszip"

import { sha256Bytes } from "@/lib/ocr/hash"
import { sha256Hex } from "@/lib/share/hash"
import {
  TEMPLATE_API_VERSION,
  canonicalTemplateStringify,
  validateTemplateDefinition,
  verifyTemplateDefinitionHash,
  type TemplateDefinitionEnvelope,
  type TemplateJson,
  type TemplatePlatform,
} from "./contracts"

export const TEMPLATE_PACKAGE_SCHEMA_VERSION = 1 as const
export const TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES = 25 * 1024 * 1024
export const TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES = 100 * 1024 * 1024
export const TEMPLATE_PACKAGE_MAX_FILES = 1024
export const TEMPLATE_PACKAGE_MAX_DEFINITIONS = 256
export const TEMPLATE_PACKAGE_MAX_PATH_DEPTH = 16
export const TEMPLATE_PACKAGE_MAX_COMPRESSION_RATIO = 200

const MANIFEST_PATH = "manifest.json"
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z")
const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i
const DEFINITION_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/i
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256 = /^[a-f0-9]{64}$/i

export interface TemplatePackageFileRecord {
  path: string
  sha256: string
  size?: number
}

export interface TemplatePackageDefinitionRecord extends TemplatePackageFileRecord {
  id: string
  version: string
}

export interface TemplatePackageSignature {
  algorithm: "ed25519"
  publisher: string
  publicKey: string
  signature: string
}

export interface TemplatePackageManifest {
  schemaVersion: typeof TEMPLATE_PACKAGE_SCHEMA_VERSION
  apiVersion: typeof TEMPLATE_API_VERSION
  id: string
  version: string
  name: string
  description?: string
  entrypoints: string[]
  definitions: TemplatePackageDefinitionRecord[]
  assets: TemplatePackageFileRecord[]
  compatibility?: {
    platforms?: TemplatePlatform[]
    minHostVersion?: string
    maxHostVersion?: string
  }
  signature?: TemplatePackageSignature
}

export interface TemplatePackageAsset {
  path: string
  bytes: Uint8Array
}

export interface ExportTemplatePackageInput {
  id: string
  version: string
  name: string
  description?: string
  entrypoints: string[]
  definitions: TemplateDefinitionEnvelope[]
  assets?: TemplatePackageAsset[]
  compatibility?: TemplatePackageManifest["compatibility"]
  signature?: TemplatePackageSignature
}

export interface ExportedTemplatePackage {
  bytes: Uint8Array
  fingerprint: string
  manifest: TemplatePackageManifest
}

export interface InspectedTemplatePackage {
  fingerprint: string
  manifest: TemplatePackageManifest
  definitions: TemplateDefinitionEnvelope[]
  assets: Map<string, Uint8Array>
  trust: "signed-unknown" | "unsigned"
}

export function templatePackageSignaturePayload(manifest: TemplatePackageManifest): Uint8Array {
  const { signature: _signature, ...unsigned } = manifest
  return new TextEncoder().encode(canonicalTemplateStringify(unsigned as unknown as TemplateJson))
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new Error("Template package signature encoding is invalid")
  }
}

async function verifyPackageSignature(manifest: TemplatePackageManifest): Promise<void> {
  if (!manifest.signature) return
  const publicKey = decodeBase64(manifest.signature.publicKey)
  const signature = decodeBase64(manifest.signature.signature)
  if (publicKey.byteLength !== 32 || signature.byteLength !== 64) {
    throw new Error("Template package Ed25519 signature shape is invalid")
  }
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey), "Ed25519", false, [
      "verify",
    ])
    const valid = await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature),
      Uint8Array.from(templatePackageSignaturePayload(manifest))
    )
    if (!valid) throw new Error("Template package signature verification failed")
  } catch (error) {
    if (error instanceof Error && /signature/.test(error.message)) throw error
    throw new Error(
      `Template package signature verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

function safePath(input: string): string {
  const normalized = input.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Template package path is unsafe: ${input}`)
  }
  if (normalized !== normalized.normalize("NFC")) {
    throw new Error(`Template package path is not canonical Unicode: ${input}`)
  }
  const parts: string[] = []
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") throw new Error(`Template package path escapes its root: ${input}`)
    parts.push(part)
  }
  if (parts.length === 0 || parts.length > TEMPLATE_PACKAGE_MAX_PATH_DEPTH) {
    throw new Error(`Template package path depth is unsafe: ${input}`)
  }
  return parts.join("/")
}

function definitionKey(definition: Pick<TemplateDefinitionEnvelope, "id" | "version">): string {
  if (!definition.version) throw new Error(`Definition ${definition.id} is not a published release`)
  return `${definition.id}@${definition.version}`
}

function validateDependencyGraph(definitions: TemplateDefinitionEnvelope[]): void {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(id: string, trail: string[]): void {
    if (visiting.has(id)) {
      throw new Error(`Template dependency cycle detected: ${[...trail, id].join(" -> ")}`)
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (dependency.kind === "template" && byId.has(dependency.id)) {
        visit(dependency.id, [...trail, id])
      }
    }
    visiting.delete(id)
    visited.add(id)
  }

  for (const definition of definitions) visit(definition.id, [])
}

async function validateExportInput(input: ExportTemplatePackageInput): Promise<void> {
  if (!PACKAGE_ID.test(input.id)) throw new Error("Template package id is invalid")
  if (!SEMVER.test(input.version)) throw new Error("Template package version must be valid SemVer")
  if (!input.name.trim()) throw new Error("Template package name is required")
  if (input.definitions.length === 0) throw new Error("Template package has no definitions")
  if (input.definitions.length > TEMPLATE_PACKAGE_MAX_DEFINITIONS) {
    throw new Error(`Template package exceeds ${TEMPLATE_PACKAGE_MAX_DEFINITIONS} definitions`)
  }
  const keys = input.definitions.map(definitionKey)
  if (new Set(keys).size !== keys.length)
    throw new Error("Template package has duplicate definitions")
  const definitionIds = new Set(input.definitions.map((definition) => definition.id))
  for (const entrypoint of input.entrypoints) {
    if (!definitionIds.has(entrypoint)) {
      throw new Error(`Template package entrypoint ${entrypoint} is missing`)
    }
  }
  validateDependencyGraph(input.definitions)
  for (const definition of input.definitions) {
    const result = validateTemplateDefinition(definition)
    if (!result.ok) {
      throw new Error(
        `Template definition ${definition.id} is invalid: ${result.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`
      )
    }
    if (!(await verifyTemplateDefinitionHash(definition))) {
      throw new Error(`Template definition ${definition.id} has a forged content hash`)
    }
  }
}

export async function exportTemplatePackage(
  input: ExportTemplatePackageInput
): Promise<ExportedTemplatePackage> {
  await validateExportInput(input)
  const definitions: TemplatePackageDefinitionRecord[] = []
  const assets: TemplatePackageFileRecord[] = []
  const zip = new JSZip()

  for (const definition of [...input.definitions].sort((a, b) =>
    definitionKey(a).localeCompare(definitionKey(b))
  )) {
    const key = definitionKey(definition)
    const path = safePath(`definitions/${key}.json`)
    const body = canonicalTemplateStringify(definition as unknown as TemplateJson)
    definitions.push({
      id: definition.id,
      version: definition.version!,
      path,
      sha256: await sha256Hex(body),
      size: new TextEncoder().encode(body).byteLength,
    })
    zip.file(path, body, { date: FIXED_ZIP_DATE, createFolders: false })
  }

  const assetPaths = (input.assets ?? []).map((asset) => safePath(asset.path))
  if (new Set(assetPaths).size !== assetPaths.length) {
    throw new Error("Template package has duplicate asset paths")
  }
  for (const [index, asset] of [...(input.assets ?? [])]
    .map((value, sourceIndex) => ({ value, sourceIndex }))
    .sort((a, b) => assetPaths[a.sourceIndex].localeCompare(assetPaths[b.sourceIndex]))
    .entries()) {
    const path = assetPaths[asset.sourceIndex]
    const bytes = asset.value.bytes
    assets.push({ path, sha256: await sha256Bytes(bytes), size: bytes.byteLength })
    zip.file(path, bytes, { date: FIXED_ZIP_DATE, createFolders: false })
    void index
  }

  const versionById = new Map(
    input.definitions.map((definition) => [definition.id, definition.version])
  )
  const manifest: TemplatePackageManifest = {
    schemaVersion: TEMPLATE_PACKAGE_SCHEMA_VERSION,
    apiVersion: TEMPLATE_API_VERSION,
    id: input.id,
    version: input.version,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    entrypoints: input.entrypoints.map((id) => `${id}@${versionById.get(id)}`),
    definitions,
    assets,
    ...(input.compatibility ? { compatibility: input.compatibility } : {}),
    ...(input.signature ? { signature: input.signature } : {}),
  }
  zip.file(MANIFEST_PATH, canonicalTemplateStringify(manifest as unknown as TemplateJson), {
    date: FIXED_ZIP_DATE,
    createFolders: false,
  })
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  })
  if (bytes.byteLength > TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Template package exceeds ${TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES} compressed bytes`
    )
  }
  return { bytes, fingerprint: await sha256Bytes(bytes), manifest }
}

function parseManifest(raw: unknown): TemplatePackageManifest {
  if (!raw || typeof raw !== "object") throw new Error("Template package manifest is invalid")
  const manifest = raw as Partial<TemplatePackageManifest>
  if (manifest.schemaVersion !== TEMPLATE_PACKAGE_SCHEMA_VERSION) {
    throw new Error(
      typeof manifest.schemaVersion === "number" &&
        manifest.schemaVersion > TEMPLATE_PACKAGE_SCHEMA_VERSION
        ? `Unsupported future template package schema ${manifest.schemaVersion}`
        : `Unsupported template package schema ${String(manifest.schemaVersion)}`
    )
  }
  if (
    manifest.apiVersion !== TEMPLATE_API_VERSION ||
    typeof manifest.id !== "string" ||
    !PACKAGE_ID.test(manifest.id) ||
    typeof manifest.version !== "string" ||
    !SEMVER.test(manifest.version) ||
    typeof manifest.name !== "string" ||
    !Array.isArray(manifest.entrypoints) ||
    !Array.isArray(manifest.definitions) ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error("Template package manifest is invalid")
  }
  if (manifest.definitions.length > TEMPLATE_PACKAGE_MAX_DEFINITIONS) {
    throw new Error(`Template package exceeds ${TEMPLATE_PACKAGE_MAX_DEFINITIONS} definitions`)
  }
  return manifest as TemplatePackageManifest
}

/**
 * Validate an author-supplied manifest without reading or persisting a package.
 * The plugin SDK and archive inspector share this path so declarative
 * contributions cannot bypass the package contract.
 */
export function validateTemplatePackageManifest(raw: unknown): TemplatePackageManifest {
  const manifest = parseManifest(raw)
  if (!manifest.name.trim()) throw new Error("Template package name is required")
  if (manifest.definitions.length === 0) throw new Error("Template package has no definitions")

  const paths = new Set<string>()
  const definitions = new Set<string>()
  for (const record of [...manifest.definitions, ...manifest.assets]) {
    if (!record || typeof record.path !== "string" || typeof record.sha256 !== "string") {
      throw new Error("Template package file record is invalid")
    }
    const path = safePath(record.path)
    if (paths.has(path)) throw new Error(`Template package has duplicate path: ${path}`)
    paths.add(path)
    if (!SHA256.test(record.sha256)) {
      throw new Error(`Template package checksum is invalid: ${path}`)
    }
    if (record.size !== undefined && (!Number.isSafeInteger(record.size) || record.size < 0)) {
      throw new Error(`Template package size is invalid: ${path}`)
    }
  }
  for (const record of manifest.definitions) {
    if (
      typeof record.id !== "string" ||
      !DEFINITION_ID.test(record.id) ||
      typeof record.version !== "string" ||
      !SEMVER.test(record.version)
    ) {
      throw new Error(`Template package definition identity is invalid: ${String(record.id)}`)
    }
    const identity = `${record.id}@${record.version}`
    if (definitions.has(identity)) {
      throw new Error(`Template package has duplicate definition: ${identity}`)
    }
    definitions.add(identity)
  }
  if (new Set(manifest.entrypoints).size !== manifest.entrypoints.length) {
    throw new Error("Template package has duplicate entrypoints")
  }
  for (const entrypoint of manifest.entrypoints) {
    if (typeof entrypoint !== "string" || !definitions.has(entrypoint)) {
      throw new Error(`Template package entrypoint is missing: ${String(entrypoint)}`)
    }
  }
  if (
    manifest.compatibility?.platforms?.some(
      (platform) => !["desktop", "web", "mobile"].includes(platform)
    )
  ) {
    throw new Error("Template package platform compatibility is invalid")
  }
  if (
    manifest.signature &&
    (manifest.signature.algorithm !== "ed25519" ||
      !manifest.signature.publisher.trim() ||
      !manifest.signature.publicKey.trim() ||
      !manifest.signature.signature.trim())
  ) {
    throw new Error("Template package signature metadata is invalid")
  }
  return manifest
}

export async function inspectTemplatePackage(bytes: Uint8Array): Promise<InspectedTemplatePackage> {
  if (bytes.byteLength > TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES) {
    throw new Error(
      `Template package exceeds ${TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES} compressed bytes`
    )
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (error) {
    throw new Error(
      `Failed to read template package: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const files = Object.values(zip.files)
  if (files.length > TEMPLATE_PACKAGE_MAX_FILES) {
    throw new Error(`Template package exceeds ${TEMPLATE_PACKAGE_MAX_FILES} files`)
  }
  for (const file of files) {
    if (file.dir) continue
    const original = (file as JSZip.JSZipObject & { unsafeOriginalName?: string })
      .unsafeOriginalName
    safePath(original ?? file.name)
    safePath(file.name)
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
      expanded > TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES ||
      (compressed > 0 && expanded / compressed > TEMPLATE_PACKAGE_MAX_COMPRESSION_RATIO)
    ) {
      throw new Error(`Template package file has unsafe archive expansion: ${file.name}`)
    }
    return total + expanded
  }, 0)
  if (declaredExpandedBytes > TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES) {
    throw new Error(
      `Template package exceeds ${TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES} expanded bytes`
    )
  }

  const manifestBody = await zip.file(MANIFEST_PATH)?.async("string")
  if (!manifestBody) throw new Error("Template package manifest is missing")
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestBody)
  } catch {
    throw new Error("Template package manifest is not valid JSON")
  }
  const manifest = validateTemplatePackageManifest(parsed)
  await verifyPackageSignature(manifest)
  const knownPaths = new Set<string>([MANIFEST_PATH])
  let expandedBytes = new TextEncoder().encode(manifestBody).byteLength
  const definitions: TemplateDefinitionEnvelope[] = []
  const definitionKeys = new Set<string>()

  for (const record of manifest.definitions) {
    if (
      !record ||
      typeof record.id !== "string" ||
      typeof record.version !== "string" ||
      typeof record.path !== "string" ||
      typeof record.sha256 !== "string"
    ) {
      throw new Error("Template package definition record is invalid")
    }
    const path = safePath(record.path)
    if (knownPaths.has(path)) throw new Error(`Template package has duplicate path ${path}`)
    knownPaths.add(path)
    const file = zip.file(path)
    if (!file || file.dir) throw new Error(`Template package definition is missing: ${path}`)
    const body = await file.async("string")
    expandedBytes += new TextEncoder().encode(body).byteLength
    if ((await sha256Hex(body)) !== record.sha256) {
      throw new Error(`Template package definition checksum mismatch: ${path}`)
    }
    let definition: TemplateDefinitionEnvelope
    try {
      definition = JSON.parse(body) as TemplateDefinitionEnvelope
    } catch {
      throw new Error(`Template package definition is invalid JSON: ${path}`)
    }
    if (definition.id !== record.id || definition.version !== record.version) {
      throw new Error(`Template package definition identity mismatch: ${path}`)
    }
    const key = definitionKey(definition)
    if (definitionKeys.has(key)) throw new Error(`Template package has duplicate definition ${key}`)
    definitionKeys.add(key)
    const validation = validateTemplateDefinition(definition)
    if (!validation.ok) {
      throw new Error(
        `Template package definition ${key} is invalid: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join("; ")}`
      )
    }
    if (!(await verifyTemplateDefinitionHash(definition))) {
      throw new Error(`Template package definition ${key} has a forged content hash`)
    }
    definitions.push(definition)
  }

  const assets = new Map<string, Uint8Array>()
  for (const record of manifest.assets) {
    if (!record || typeof record.path !== "string" || typeof record.sha256 !== "string") {
      throw new Error("Template package asset record is invalid")
    }
    const path = safePath(record.path)
    if (knownPaths.has(path)) throw new Error(`Template package has duplicate path ${path}`)
    knownPaths.add(path)
    const file = zip.file(path)
    if (!file || file.dir) throw new Error(`Template package asset is missing: ${path}`)
    const content = await file.async("uint8array")
    expandedBytes += content.byteLength
    if ((await sha256Bytes(content)) !== record.sha256) {
      throw new Error(`Template package asset checksum mismatch: ${path}`)
    }
    assets.set(path, content)
  }
  if (expandedBytes > TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES) {
    throw new Error(
      `Template package exceeds ${TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES} expanded bytes`
    )
  }
  for (const file of files) {
    if (!file.dir && !knownPaths.has(file.name)) {
      throw new Error(`Template package contains undeclared path ${file.name}`)
    }
  }
  const keys = new Set(definitions.map(definitionKey))
  for (const entrypoint of manifest.entrypoints) {
    if (!keys.has(entrypoint)) {
      throw new Error(`Template package entrypoint is missing: ${entrypoint}`)
    }
  }
  validateDependencyGraph(definitions)
  return {
    fingerprint: await sha256Bytes(bytes),
    manifest,
    definitions,
    assets,
    trust: manifest.signature ? "signed-unknown" : "unsigned",
  }
}
