import {
  PACKAGE_ID,
  SEMVER,
  TEMPLATE_PACKAGE_SCHEMA_VERSION,
  TEMPLATE_PACKAGE_MAX_DEFINITIONS,
  TEMPLATE_PACKAGE_MAX_PATH_DEPTH,
  safePath,
  validateTemplatePackageManifest,
} from "./package-manifest"
export {
  TEMPLATE_PACKAGE_SCHEMA_VERSION,
  TEMPLATE_PACKAGE_MAX_DEFINITIONS,
  TEMPLATE_PACKAGE_MAX_PATH_DEPTH,
  validateTemplatePackageManifest,
} from "./package-manifest"
import {
  assertNoUndeclaredFiles,
  openHardenedZip,
  readDeclaredFile,
  verifyEd25519PackageSignature,
  writeDeterministicZip,
  type ArchiveEntry,
  type ArchiveLimits,
  type PackageFileRecord,
  type PackageSignature,
} from "@/lib/packaging/signed-zip"
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

export const TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES = 25 * 1024 * 1024
export const TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES = 100 * 1024 * 1024
export const TEMPLATE_PACKAGE_MAX_FILES = 1024
export const TEMPLATE_PACKAGE_MAX_COMPRESSION_RATIO = 200

const MANIFEST_PATH = "manifest.json"
const LABEL = "Template package"
const LIMITS: ArchiveLimits = {
  maxCompressedBytes: TEMPLATE_PACKAGE_MAX_COMPRESSED_BYTES,
  maxExpandedBytes: TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES,
  maxFiles: TEMPLATE_PACKAGE_MAX_FILES,
  maxCompressionRatio: TEMPLATE_PACKAGE_MAX_COMPRESSION_RATIO,
  maxPathDepth: TEMPLATE_PACKAGE_MAX_PATH_DEPTH,
}

export type TemplatePackageFileRecord = PackageFileRecord

export interface TemplatePackageDefinitionRecord extends TemplatePackageFileRecord {
  id: string
  version: string
}

export type TemplatePackageSignature = PackageSignature

/**
 * What can produce a `TemplatePackageSignature` for a manifest.
 *
 * Declared here, next to the record it fills, so the service and the key store
 * that implements it agree on one shape without the service having to import
 * the key store (which reaches for `window` through the keyring backends and
 * would drag the browser into the node test project).
 */
export interface TemplatePackageSigner {
  /** Display name written into `signature.publisher`. */
  publisher: string
  /** Base64 raw 32-byte Ed25519 public key. */
  publicKey: string
  /** Raw 64-byte Ed25519 signature over `templatePackageSignaturePayload`. */
  sign(payload: Uint8Array): Promise<Uint8Array>
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

async function verifyPackageSignature(manifest: TemplatePackageManifest): Promise<void> {
  if (!manifest.signature) return
  await verifyEd25519PackageSignature(
    manifest.signature,
    templatePackageSignaturePayload(manifest),
    LABEL
  )
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
  const entries: ArchiveEntry[] = []

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
    entries.push({ path, data: body })
  }

  const assetPaths = (input.assets ?? []).map((asset) => safePath(asset.path))
  if (new Set(assetPaths).size !== assetPaths.length) {
    throw new Error("Template package has duplicate asset paths")
  }
  for (const asset of [...(input.assets ?? [])]
    .map((value, sourceIndex) => ({ value, sourceIndex }))
    .sort((a, b) => assetPaths[a.sourceIndex].localeCompare(assetPaths[b.sourceIndex]))) {
    const path = assetPaths[asset.sourceIndex]
    const bytes = asset.value.bytes
    assets.push({ path, sha256: await sha256Bytes(bytes), size: bytes.byteLength })
    entries.push({ path, data: bytes })
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
  entries.push({
    path: MANIFEST_PATH,
    data: canonicalTemplateStringify(manifest as unknown as TemplateJson),
  })
  const bytes = await writeDeterministicZip(entries, LIMITS, LABEL)
  return { bytes, fingerprint: await sha256Bytes(bytes), manifest }
}

export async function inspectTemplatePackage(bytes: Uint8Array): Promise<InspectedTemplatePackage> {
  const archive = await openHardenedZip(bytes, LIMITS, LABEL)
  const { zip } = archive

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
    if (!record || typeof record.id !== "string" || typeof record.version !== "string") {
      throw new Error("Template package definition record is invalid")
    }
    const { path, bytes: content } = await readDeclaredFile(
      archive,
      record,
      knownPaths,
      LIMITS,
      LABEL,
      "definition"
    )
    const body = new TextDecoder().decode(content)
    expandedBytes += content.byteLength
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
    const { path, bytes: content } = await readDeclaredFile(
      archive,
      record,
      knownPaths,
      LIMITS,
      LABEL,
      "asset"
    )
    expandedBytes += content.byteLength
    assets.set(path, content)
  }
  if (expandedBytes > TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES) {
    throw new Error(
      `Template package exceeds ${TEMPLATE_PACKAGE_MAX_EXPANDED_BYTES} expanded bytes`
    )
  }
  assertNoUndeclaredFiles(archive, knownPaths, LABEL)
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
