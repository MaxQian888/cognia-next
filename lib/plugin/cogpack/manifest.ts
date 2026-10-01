/**
 * The cogpack manifest contract (ADR-0209): parse and validate an untrusted
 * `manifest.json`, and derive the bytes its signature covers.
 *
 * Validation is strict and total. A cogpack arrives from someone else, so every
 * field is checked for shape before anything reads it, and anything this
 * version does not understand is refused rather than ignored: a member source
 * kind we cannot install would otherwise turn into a silently smaller cogset.
 */

import { canonicalJsonBytes } from "@/lib/plugin/character-pack/canonical-json"
import { isValidPluginId, isValidPluginVersion } from "@/lib/plugin/core/validation"
import { PackageFormatError, safeArchivePath } from "@/lib/packaging/archive-path"
import { PACKAGE_ID, SEMVER } from "@/lib/templates/package-manifest"
import {
  COGPACK_KIND,
  COGPACK_SCHEMA_VERSION,
  type CogpackFileRecord,
  type CogpackManifestV1,
  type CogpackMember,
  type CogpackMemberSource,
  type CogpackSignature,
  type ReproducibleInstallOrigin,
} from "@/types/plugin/plugin-cogset"

export const COGPACK_LABEL = "Cogpack"
export const COGPACK_MANIFEST_PATH = "manifest.json"
export const COGPACK_MAX_MEMBERS = 256
export const COGPACK_MAX_PATH_DEPTH = 32
export const COGPACK_MAX_NAME_LENGTH = 100
export const COGPACK_MAX_DESCRIPTION_LENGTH = 2000

const SHA256_HEX = /^[0-9a-f]{64}$/
const COMMIT_SHA = /^[0-9a-f]{40}$/
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/

class CogpackManifestError extends PackageFormatError {
  constructor(message: string) {
    super("manifest-invalid", `Cogpack manifest is invalid: ${message}`)
    this.name = "CogpackManifestError"
  }
}

function fail(message: string): never {
  throw new CogpackManifestError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function requireString(value: unknown, field: string, max = 2048): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`${field} must be a non-empty string of at most ${max} characters`)
  }
  return value
}

function optionalString(value: unknown, field: string, max = 2048): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, field, max)
}

function requireHttpsUrl(value: unknown, field: string): string {
  const text = requireString(value, field)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail(`${field} is not a URL`)
  }
  if (url.protocol !== "https:") fail(`${field} must use https`)
  return text
}

/** Plain JSON only: config crosses into another user's plugin. */
function requireJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be an object`)
  try {
    const round = JSON.parse(JSON.stringify(value)) as unknown
    if (!isRecord(round)) fail(`${field} must be an object`)
    return round
  } catch {
    fail(`${field} must be plain JSON`)
  }
}

function parseFiles(value: unknown, root: string, field: string): CogpackFileRecord[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must list the embedded files`)
  const seen = new Set<string>()
  const files = value.map((raw, index) => {
    if (!isRecord(raw)) fail(`${field}[${index}] must be an object`)
    const path = safeArchivePath(
      requireString(raw.path, `${field}[${index}].path`),
      COGPACK_MAX_PATH_DEPTH,
      COGPACK_LABEL
    )
    if (!path.startsWith(`${root}/`)) fail(`${field}[${index}].path must be inside ${root}/`)
    if (seen.has(path)) fail(`${field} lists ${path} twice`)
    seen.add(path)
    const sha256 = requireString(raw.sha256, `${field}[${index}].sha256`)
    if (!SHA256_HEX.test(sha256)) fail(`${field}[${index}].sha256 must be lowercase sha256 hex`)
    if (
      raw.size !== undefined &&
      (typeof raw.size !== "number" || !Number.isInteger(raw.size) || raw.size < 0)
    ) {
      fail(`${field}[${index}].size must be a non-negative integer`)
    }
    return { path, sha256, ...(raw.size !== undefined ? { size: raw.size as number } : {}) }
  })
  if (!seen.has(`${root}/plugin.json`)) fail(`${field} must include ${root}/plugin.json`)
  return files
}

function parseSource(value: unknown, memberId: string, field: string): CogpackMemberSource {
  if (!isRecord(value)) fail(`${field} must be an object`)
  if (value.kind === "embedded") {
    const root = `plugins/${memberId}`
    if (value.root !== root) fail(`${field}.root must be ${root}`)
    return { kind: "embedded", root, files: parseFiles(value.files, root, `${field}.files`) }
  }
  return parseReproducibleOrigin(value, field)
}

/**
 * Validate an origin a plugin can be fetched again from. Shared by the
 * cogpack's member sources and by install-origin records that arrive from
 * another device or a backup, which later exports pin.
 */
export function parseReproducibleOrigin(value: unknown, field: string): ReproducibleInstallOrigin {
  if (!isRecord(value)) fail(`${field} must be an object`)
  switch (value.kind) {
    case "builtin":
      return { kind: "builtin" }
    case "github": {
      const owner = requireString(value.owner, `${field}.owner`, 100)
      const repo = requireString(value.repo, `${field}.repo`, 100)
      if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo))
        fail(`${field} names an invalid repo`)
      const commit = requireString(value.commit, `${field}.commit`, 40)
      if (!COMMIT_SHA.test(commit)) fail(`${field}.commit must be a full lowercase commit id`)
      const subdir =
        value.subdir === undefined
          ? undefined
          : safeArchivePath(
              requireString(value.subdir, `${field}.subdir`),
              COGPACK_MAX_PATH_DEPTH,
              COGPACK_LABEL
            )
      return { kind: "github", owner, repo, ...(subdir ? { subdir } : {}), commit }
    }
    case "git": {
      const url = requireHttpsUrl(value.url, `${field}.url`)
      const commit = requireString(value.commit, `${field}.commit`, 40)
      if (!COMMIT_SHA.test(commit)) fail(`${field}.commit must be a full lowercase commit id`)
      return { kind: "git", url, commit }
    }
    case "registry": {
      const registryUrl = requireHttpsUrl(value.registryUrl, `${field}.registryUrl`)
      const version = requireString(value.version, `${field}.version`, 64)
      if (!isValidPluginVersion(version)) fail(`${field}.version is not a plugin version`)
      const checksum = optionalString(value.checksum, `${field}.checksum`, 256)
      return { kind: "registry", registryUrl, version, ...(checksum ? { checksum } : {}) }
    }
    case "url": {
      const bundleUrl = requireHttpsUrl(value.bundleUrl, `${field}.bundleUrl`)
      const sha256 = requireString(value.sha256, `${field}.sha256`, 64)
      if (!SHA256_HEX.test(sha256)) fail(`${field}.sha256 must be lowercase sha256 hex`)
      const signatureUrl =
        value.signatureUrl === undefined
          ? undefined
          : requireHttpsUrl(value.signatureUrl, `${field}.signatureUrl`)
      const publicKey = optionalString(value.publicKey, `${field}.publicKey`, 256)
      return {
        kind: "url",
        bundleUrl,
        sha256,
        ...(signatureUrl ? { signatureUrl } : {}),
        ...(publicKey ? { publicKey } : {}),
      }
    }
    case "openvsx": {
      const namespace = requireString(value.namespace, `${field}.namespace`, 128)
      const name = requireString(value.name, `${field}.name`, 128)
      const version = requireString(value.version, `${field}.version`, 64)
      const sha256 = requireString(value.sha256, `${field}.sha256`, 64)
      if (!SHA256_HEX.test(sha256)) fail(`${field}.sha256 must be lowercase sha256 hex`)
      const targetPlatform = optionalString(value.targetPlatform, `${field}.targetPlatform`, 64)
      return {
        kind: "openvsx",
        namespace,
        name,
        version,
        sha256,
        ...(targetPlatform ? { targetPlatform } : {}),
      }
    }
    default:
      fail(`${field}.kind ${JSON.stringify(value.kind)} is not supported`)
  }
}

function parseMember(value: unknown, index: number): CogpackMember {
  const field = `members[${index}]`
  if (!isRecord(value)) fail(`${field} must be an object`)
  const id = requireString(value.id, `${field}.id`, 128)
  if (!isValidPluginId(id)) fail(`${field}.id is not a valid plugin id`)
  const version = requireString(value.version, `${field}.version`, 64)
  if (!isValidPluginVersion(version)) fail(`${field}.version is not a plugin version`)
  const name = requireString(value.name, `${field}.name`, 200)
  if (typeof value.optional !== "boolean") fail(`${field}.optional must be a boolean`)
  const config =
    value.config === undefined ? undefined : requireJsonObject(value.config, `${field}.config`)
  let secretFields: string[] | undefined
  if (value.secretFields !== undefined) {
    if (!Array.isArray(value.secretFields)) fail(`${field}.secretFields must be an array`)
    secretFields = value.secretFields.map((entry, i) =>
      requireString(entry, `${field}.secretFields[${i}]`, 128)
    )
    if (new Set(secretFields).size !== secretFields.length)
      fail(`${field}.secretFields repeats a field`)
    for (const key of secretFields) {
      if (config && Object.prototype.hasOwnProperty.call(config, key)) {
        fail(`${field}.config carries the secret field ${key}`)
      }
    }
  }
  return {
    id,
    name,
    version,
    optional: value.optional,
    source: parseSource(value.source, id, `${field}.source`),
    ...(config ? { config } : {}),
    ...(secretFields && secretFields.length > 0 ? { secretFields } : {}),
  }
}

function parseSignature(value: unknown): CogpackSignature | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.algorithm !== "ed25519") fail("signature.algorithm must be ed25519")
  return {
    algorithm: "ed25519",
    publisher: requireString(value.publisher, "signature.publisher", 200),
    publicKey: requireString(value.publicKey, "signature.publicKey", 256),
    signature: requireString(value.signature, "signature.signature", 512),
  }
}

/** Parse an untrusted manifest. Throws a `Cogpack manifest is invalid: …` error. */
export function validateCogpackManifest(raw: unknown): CogpackManifestV1 {
  if (!isRecord(raw)) fail("it must be an object")
  if (raw.schemaVersion !== COGPACK_SCHEMA_VERSION) {
    fail(`schemaVersion ${JSON.stringify(raw.schemaVersion)} is not supported`)
  }
  if (raw.kind !== COGPACK_KIND) fail(`kind must be ${COGPACK_KIND}`)
  const id = requireString(raw.id, "id", 128)
  if (!PACKAGE_ID.test(id)) fail("id must be letters, digits, dots, dashes or underscores")
  const version = requireString(raw.version, "version", 64)
  if (!SEMVER.test(version)) fail("version must be SemVer")
  const name = requireString(raw.name, "name", COGPACK_MAX_NAME_LENGTH)
  const description = optionalString(raw.description, "description", COGPACK_MAX_DESCRIPTION_LENGTH)
  if (!isRecord(raw.compatibility)) fail("compatibility must be an object")
  const minHostVersion = requireString(
    raw.compatibility.minHostVersion,
    "compatibility.minHostVersion",
    64
  )
  if (!SEMVER.test(minHostVersion)) fail("compatibility.minHostVersion must be SemVer")
  if (!Array.isArray(raw.members) || raw.members.length === 0) fail("members must not be empty")
  if (raw.members.length > COGPACK_MAX_MEMBERS) fail(`members exceeds ${COGPACK_MAX_MEMBERS}`)
  const members = raw.members.map(parseMember)
  const ids = new Set<string>()
  for (const member of members) {
    if (ids.has(member.id)) fail(`members lists ${member.id} twice`)
    ids.add(member.id)
  }
  const signature = parseSignature(raw.signature)
  return {
    schemaVersion: COGPACK_SCHEMA_VERSION,
    kind: COGPACK_KIND,
    id,
    version,
    name,
    ...(description ? { description } : {}),
    compatibility: { minHostVersion },
    members,
    ...(signature ? { signature } : {}),
  }
}

/**
 * The bytes the signature covers: RFC 8785 canonical JSON of the manifest
 * without `signature`, the same canonicalization character packs sign.
 */
export function cogpackSignaturePayload(manifest: CogpackManifestV1): Uint8Array {
  const { signature: _signature, ...unsigned } = manifest
  return canonicalJsonBytes(unsigned)
}

/** `<id>-<version>.cogpack`, safe on every file system. */
export function cogpackFilename(manifest: Pick<CogpackManifestV1, "id" | "version">): string {
  const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "_")
  return `${safe(manifest.id)}-${safe(manifest.version)}.cogpack`
}

/** Path of an embedded file relative to its plugin root. */
export function embeddedRelativePath(root: string, path: string): string {
  if (!path.startsWith(`${root}/`)) throw new Error(`${path} is not inside ${root}`)
  return path.slice(root.length + 1)
}
