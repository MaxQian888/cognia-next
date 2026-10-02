/**
 * Runner configuration: one JSON file (see deploy/probe.config.example.json),
 * validated up front so a typo stops the process instead of producing a
 * stream of misleading observations. Only the secret lives elsewhere, in a
 * file the config points at.
 */

import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { PROFILE_IDS, type ProfileId } from "../../../../../lib/status/contract"
import { validateStatusUrl } from "../../../../../lib/status/config"
import {
  base64UrlToBytes,
  isCanonicalSignedPath,
  MIN_PROBE_SECRET_BYTES,
} from "../../../../../lib/status/signing"

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface ProfileConfig {
  id: ProfileId
  /** Exact Origin header, or null for the originless native profile. */
  origin: string | null
  httpCadenceSeconds: number | null
  protocolCadenceSeconds: number | null
}

export interface MirrorConfig {
  enabled: boolean
  /** Where validated snapshot/feed copies are kept (writable). */
  dataDir: string
  /** The exported status-only site (read-only; may be a release symlink). */
  assetsDir: string
  host: string
  port: number
  syncIntervalSeconds: number
  /** Primary API to copy from; defaults to the top-level apiBase. */
  sourceApiBase: string
}

export interface ProbeConfig {
  apiBase: string
  probeId: string
  keyId: string
  secretFile: string
  signalingUrl: string
  registryRevision: number
  profiles: ProfileConfig[]
  statusPageUrl: string
  spoolDir: string
  alertWebhook: string | null
  mirror: MirrorConfig | null
  /** Development only: allow http:// / ws:// on loopback hosts. */
  allowLoopbackHttp: boolean
}

export interface MirrorOnlyConfig {
  apiBase: string
  probeId: string | null
  alertWebhook: string | null
  mirror: MirrorConfig
  allowLoopbackHttp: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

type Raw = Record<string, unknown>

function record(value: unknown, at: string): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${at}: expected an object`)
  }
  return value as Raw
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ConfigError(`${at}: expected a string`)
  return value.trim()
}

function id(value: unknown, at: string): string {
  const text = string(value, at)
  if (!ID_PATTERN.test(text)) throw new ConfigError(`${at}: invalid identifier`)
  return text
}

function absolutePath(value: unknown, at: string): string {
  const text = string(value, at)
  if (!path.isAbsolute(text)) throw new ConfigError(`${at}: must be an absolute path`)
  return path.normalize(text)
}

function httpsUrl(value: unknown, at: string, allowLoopbackHttp: boolean): string {
  const normalized = validateStatusUrl(string(value, at), { allowLoopbackHttp })
  if (!normalized) throw new ConfigError(`${at}: must be an https URL without credentials`)
  return normalized
}

function apiBaseUrl(value: unknown, at: string, allowLoopbackHttp: boolean): string {
  const url = new URL(httpsUrl(value, at, allowLoopbackHttp))
  if (url.search || url.hash) throw new ConfigError(`${at}: must not carry a query or fragment`)
  const base = url.toString().replace(/\/+$/, "")
  // The ingestion signature names the exact request path.
  if (!isCanonicalSignedPath(`${new URL(base).pathname}/observations`)) {
    throw new ConfigError(`${at}: path cannot be signed unambiguously`)
  }
  return base
}

function cadence(value: unknown, at: string): number | null {
  if (value === null || value === undefined) return null
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > 3_600 ||
    value % 60 !== 0
  ) {
    throw new ConfigError(`${at}: cadence must be null or a multiple of 60 between 60 and 3600`)
  }
  return value
}

function origin(value: unknown, at: string, profileId: ProfileId): string | null {
  if (profileId === "native") {
    if (value !== null && value !== undefined)
      throw new ConfigError(`${at}: the native profile sends no Origin`)
    return null
  }
  const text = string(value, at)
  // An Origin is scheme://host[:port] with nothing after it.
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new ConfigError(`${at}: invalid Origin`)
  }
  if (
    parsed.origin !== text &&
    !(parsed.protocol === "capacitor:" && text === "capacitor://localhost")
  ) {
    throw new ConfigError(`${at}: must be an exact origin (scheme://host[:port])`)
  }
  return text
}

function profiles(value: unknown): ProfileConfig[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ConfigError("profiles: expected a non-empty array")
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const at = `profiles[${index}]`
    const raw = record(entry, at)
    const profileId = string(raw.id, `${at}.id`)
    if (!(PROFILE_IDS as readonly string[]).includes(profileId))
      throw new ConfigError(`${at}.id: unknown profile`)
    if (seen.has(profileId)) throw new ConfigError(`${at}.id: duplicate profile`)
    seen.add(profileId)
    const typedId = profileId as ProfileId
    const config: ProfileConfig = {
      id: typedId,
      origin: origin(raw.origin, `${at}.origin`, typedId),
      httpCadenceSeconds: cadence(raw.httpCadenceSeconds, `${at}.httpCadenceSeconds`),
      protocolCadenceSeconds: cadence(raw.protocolCadenceSeconds, `${at}.protocolCadenceSeconds`),
    }
    if (config.httpCadenceSeconds === null && config.protocolCadenceSeconds === null) {
      throw new ConfigError(`${at}: at least one cadence is required`)
    }
    return config
  })
}

function signalingUrl(value: unknown, allowLoopbackHttp: boolean): string {
  const text = string(value, "signalingUrl")
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new ConfigError("signalingUrl: invalid URL")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && allowLoopbackHttp && loopback)) {
    throw new ConfigError("signalingUrl: must be a wss:// URL")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError("signalingUrl: no credentials, query or fragment")
  }
  return url.toString()
}

function mirror(value: unknown, apiBase: string, allowLoopbackHttp: boolean): MirrorConfig | null {
  if (value === null || value === undefined) return null
  const raw = record(value, "mirror")
  const port = raw.port ?? 8080
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("mirror.port: invalid port")
  }
  const interval = raw.syncIntervalSeconds ?? 300
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 30 ||
    interval > 3_600
  ) {
    throw new ConfigError("mirror.syncIntervalSeconds: must be an integer between 30 and 3600")
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new ConfigError("mirror.enabled: expected a boolean")
  }
  return {
    enabled: raw.enabled === undefined ? true : raw.enabled,
    dataDir: absolutePath(raw.dataDir, "mirror.dataDir"),
    assetsDir: absolutePath(raw.assetsDir, "mirror.assetsDir"),
    host: raw.host === undefined ? "127.0.0.1" : string(raw.host, "mirror.host"),
    port,
    syncIntervalSeconds: interval,
    sourceApiBase:
      raw.sourceApiBase === undefined
        ? apiBase
        : apiBaseUrl(raw.sourceApiBase, "mirror.sourceApiBase", allowLoopbackHttp),
  }
}

function loopbackFlag(raw: Raw): boolean {
  if (raw.allowLoopbackHttp === undefined) return false
  if (typeof raw.allowLoopbackHttp !== "boolean")
    throw new ConfigError("allowLoopbackHttp: expected a boolean")
  return raw.allowLoopbackHttp
}

function optionalWebhook(value: unknown, allowLoopbackHttp: boolean): string | null {
  return value === null || value === undefined
    ? null
    : httpsUrl(value, "alertWebhook", allowLoopbackHttp)
}

export function parseProbeConfig(value: unknown): ProbeConfig {
  const raw = record(value, "config")
  const allowLoopbackHttp = loopbackFlag(raw)
  const apiBase = apiBaseUrl(raw.apiBase, "apiBase", allowLoopbackHttp)
  const registryRevision = raw.registryRevision
  if (
    typeof registryRevision !== "number" ||
    !Number.isInteger(registryRevision) ||
    registryRevision < 0
  ) {
    throw new ConfigError("registryRevision: expected a non-negative integer")
  }
  return {
    apiBase,
    probeId: id(raw.probeId, "probeId"),
    keyId: id(raw.keyId, "keyId"),
    secretFile: absolutePath(raw.secretFile, "secretFile"),
    signalingUrl: signalingUrl(raw.signalingUrl, allowLoopbackHttp),
    registryRevision,
    profiles: profiles(raw.profiles),
    statusPageUrl: httpsUrl(raw.statusPageUrl, "statusPageUrl", allowLoopbackHttp),
    spoolDir: absolutePath(raw.spoolDir, "spoolDir"),
    alertWebhook: optionalWebhook(raw.alertWebhook, allowLoopbackHttp),
    mirror: mirror(raw.mirror, apiBase, allowLoopbackHttp),
    allowLoopbackHttp,
  }
}

/** The `mirror` command needs only the primary API and the mirror block. */
export function parseMirrorOnlyConfig(value: unknown): MirrorOnlyConfig {
  const raw = record(value, "config")
  const allowLoopbackHttp = loopbackFlag(raw)
  const apiBase = apiBaseUrl(raw.apiBase, "apiBase", allowLoopbackHttp)
  const mirrorConfig = mirror(raw.mirror, apiBase, allowLoopbackHttp)
  if (!mirrorConfig) throw new ConfigError("mirror: required for the mirror command")
  return {
    apiBase,
    probeId: raw.probeId === undefined ? null : id(raw.probeId, "probeId"),
    alertWebhook: optionalWebhook(raw.alertWebhook, allowLoopbackHttp),
    mirror: mirrorConfig,
    allowLoopbackHttp,
  }
}

export async function readConfigFile(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, "utf8")
  } catch (error) {
    throw new ConfigError(
      `cannot read config file: ${(error as NodeJS.ErrnoException).code ?? "error"}`
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ConfigError("config file is not valid JSON")
  }
}

export interface LoadedSecret {
  secret: Uint8Array
  /** The file is readable by group/others; worth a warning, not a refusal. */
  permissive: boolean
}

/** Read the base64url probe secret (≥32 bytes). The value is never logged. */
export async function loadProbeSecret(file: string): Promise<LoadedSecret> {
  let text: string
  let mode: number
  try {
    ;[text, mode] = await Promise.all([
      readFile(file, "utf8"),
      stat(file).then((info) => info.mode),
    ])
  } catch (error) {
    throw new ConfigError(
      `cannot read secret file: ${(error as NodeJS.ErrnoException).code ?? "error"}`
    )
  }
  const bytes = base64UrlToBytes(text.trim())
  if (!bytes || bytes.byteLength < MIN_PROBE_SECRET_BYTES) {
    throw new ConfigError(
      `secret file must hold base64url of at least ${MIN_PROBE_SECRET_BYTES} bytes`
    )
  }
  return { secret: bytes, permissive: (mode & 0o077) !== 0 }
}
