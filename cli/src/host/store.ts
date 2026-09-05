/**
 * Where the CLI remembers the hosts it can talk to.
 *
 * A host record is everything needed to reach one Cognia Host and prove who
 * is calling: the endpoint, which wire it answers on, and the credential.
 * Records live in `hosts.json` at 0600 beside `credentials.json`, because a
 * device private key and a service token are secrets of the same weight as an
 * API key.
 *
 * Two files are read, in the same layered way the rest of the CLI config
 * works: the user file under the CLI home, and a project file under
 * `./.cognia/`. A project file lets a repository pin the staging host it is
 * meant to be driven against without anyone editing their home directory.
 */

import fs from "node:fs"
import path from "node:path"

export const HOSTS_FILE_NAME = "hosts.json"
export const PROJECT_HOSTS_DIR = ".cognia"
/** Owner read/write only. The device private key lives in here. */
export const HOSTS_MODE = 0o600

/**
 * Which wire a host answers on.
 *
 * `headless` is `POST /internal/_rpc/{name}` with a loopback service token.
 * `device` is `POST /api/_rpc/{name}` with a DPoP device session.
 */
export type HostKind = "headless" | "device"

export interface HostRecord {
  kind: HostKind
  /** Origin, no trailing slash. */
  endpoint: string
  tenantId?: string
  /** `headless` only. Loopback service or local-debug token. */
  serviceToken?: string
  /** `device` only. Minted at pair time and never sent anywhere. */
  deviceId?: string
  devicePrivateKeyJwk?: Record<string, unknown>
  deviceKeyThumbprint?: string
  /**
   * SHA-256 of the host's TLS SubjectPublicKeyInfo, captured at pair time.
   * The transport pins it, so a host that presents a different key is refused
   * rather than trusted because the URL still matches.
   */
  serverFingerprint?: string
  /** Diagnostics only. */
  serverVersion?: string
  label?: string
}

export interface HostsFile {
  version: 1
  /** Name of the host used when no `--host` or `--profile` is given. */
  active?: string
  hosts: Record<string, HostRecord>
}

export const EMPTY_HOSTS: HostsFile = { version: 1, hosts: {} }

export interface HostsFs {
  read: (absPath: string) => string | null
  write: (absPath: string, content: string, mode: number) => void
  mkdirp: (dir: string) => void
  dirname: (absPath: string) => string
}

export const realHostsFs: HostsFs = {
  read: (target) => {
    try {
      return fs.readFileSync(target, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  },
  write: (target, content, mode) => {
    fs.writeFileSync(target, content, { mode })
    // writeFileSync applies `mode` only when it creates the file, so an
    // existing file keeps whatever permissions it had. Set them again.
    try {
      fs.chmodSync(target, mode)
    } catch {
      // Best effort. Windows ignores chmod and does not enforce these bits.
    }
  },
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true })
  },
  dirname: (target) => path.dirname(target),
}

export function hostsPath(home: string): string {
  return path.join(home, HOSTS_FILE_NAME)
}

export function projectHostsPath(cwd: string): string {
  return path.join(cwd, PROJECT_HOSTS_DIR, HOSTS_FILE_NAME)
}

/** Strip a trailing slash so `endpoint + path` never doubles the separator. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, "")
}

function coerceHost(value: unknown): HostRecord | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const endpoint = typeof record.endpoint === "string" ? normalizeEndpoint(record.endpoint) : ""
  if (endpoint.length === 0) return null
  const kind = record.kind === "device" ? "device" : "headless"
  const host: HostRecord = { kind, endpoint }
  for (const key of [
    "tenantId",
    "serviceToken",
    "deviceId",
    "deviceKeyThumbprint",
    "serverFingerprint",
    "serverVersion",
    "label",
  ] as const) {
    const entry = record[key]
    if (typeof entry === "string" && entry.length > 0) host[key] = entry
  }
  if (typeof record.devicePrivateKeyJwk === "object" && record.devicePrivateKeyJwk !== null) {
    host.devicePrivateKeyJwk = record.devicePrivateKeyJwk as Record<string, unknown>
  }
  return host
}

/**
 * Parse one hosts file. A malformed or partly malformed file degrades to the
 * records that do parse rather than throwing, because losing every host over
 * one bad entry would leave the operator with no way to reach anything.
 */
export function parseHostsFile(raw: string | null): HostsFile {
  if (raw === null) return { ...EMPTY_HOSTS, hosts: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...EMPTY_HOSTS, hosts: {} }
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_HOSTS, hosts: {} }
  const source = parsed as Record<string, unknown>
  const hosts: Record<string, HostRecord> = {}
  if (typeof source.hosts === "object" && source.hosts !== null) {
    for (const [name, value] of Object.entries(source.hosts as Record<string, unknown>)) {
      const host = coerceHost(value)
      if (host) hosts[name] = host
    }
  }
  const active =
    typeof source.active === "string" && hosts[source.active] ? source.active : undefined
  return { version: 1, ...(active ? { active } : {}), hosts }
}

export function readHostsFile(target: string, fsx: HostsFs = realHostsFs): HostsFile {
  return parseHostsFile(fsx.read(target))
}

export function writeHostsFile(target: string, file: HostsFile, fsx: HostsFs = realHostsFs): void {
  fsx.mkdirp(fsx.dirname(target))
  fsx.write(target, `${JSON.stringify(file, null, 2)}\n`, HOSTS_MODE)
}

export interface MutateResult {
  file: HostsFile
  error?: string
}

export function addHost(
  file: HostsFile,
  name: string,
  record: HostRecord,
  { activate = false }: { activate?: boolean } = {}
): HostsFile {
  const hosts = {
    ...file.hosts,
    [name]: { ...record, endpoint: normalizeEndpoint(record.endpoint) },
  }
  // The first host added becomes active, so a single-host setup never needs a
  // separate `host use`.
  const active = activate || !file.active ? name : file.active
  return { version: 1, active, hosts }
}

export function removeHost(file: HostsFile, name: string): MutateResult {
  if (!file.hosts[name]) return { file, error: `no host named "${name}"` }
  const hosts = { ...file.hosts }
  delete hosts[name]
  const active = file.active === name ? Object.keys(hosts)[0] : file.active
  return { file: { version: 1, ...(active ? { active } : {}), hosts } }
}

export function activateHost(file: HostsFile, name: string): MutateResult {
  if (!file.hosts[name]) return { file, error: `no host named "${name}"` }
  return { file: { ...file, active: name } }
}

/** Everything except the secrets, for `host list` and `host show`. */
export function redactHost(record: HostRecord): Record<string, unknown> {
  const { serviceToken, devicePrivateKeyJwk, ...rest } = record
  return {
    ...rest,
    ...(serviceToken ? { serviceToken: "(set)" } : {}),
    ...(devicePrivateKeyJwk ? { devicePrivateKey: "(set)" } : {}),
  }
}
