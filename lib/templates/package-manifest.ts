/** Pure package contract: shared by author SDK validation and archive I/O. */
import { TEMPLATE_API_VERSION } from "./contracts"
import type { TemplatePackageManifest } from "./package"

export const TEMPLATE_PACKAGE_SCHEMA_VERSION = 1 as const

export const TEMPLATE_PACKAGE_MAX_DEFINITIONS = 256

export const TEMPLATE_PACKAGE_MAX_PATH_DEPTH = 16

export const PACKAGE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i

export const DEFINITION_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/i

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const SHA256 = /^[a-f0-9]{64}$/i

export function safePath(input: string): string {
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
