/**
 * Which host a command talks to, and why.
 *
 * Precedence, high to low:
 *   1. `--endpoint` / `--host` / `--profile` on the command line
 *   2. environment (`COGNIA_ENDPOINT`, `COGNIA_SERVER_URL`, `COGNIA_SERVICE_TOKEN`,
 *      `COGNIA_LOCAL_DEBUG_TOKEN`, `COGNIA_PROFILE`)
 *   3. `./.cognia/hosts.json` in the working directory
 *   4. `<cli home>/hosts.json`
 *   5. a Cognia desktop discovered on loopback
 *
 * Merging is per key, so a project file can pin the endpoint while the token
 * still comes from the environment. Every resolved value carries the source
 * that won, because `host show` printing "where did this come from" is the
 * thing that turns a confusing 401 into a one-line fix.
 */

import type { HostKind, HostRecord, HostsFile } from "./store"
import {
  normalizeEndpoint,
  readHostsFile,
  hostsPath,
  projectHostsPath,
  type HostsFs,
} from "./store"

export type HostValueSource =
  "flag" | "env" | "project-file" | "user-file" | "desktop-bridge" | "default"

export interface ResolvedValue<T> {
  value: T
  source: HostValueSource
  /** The precise origin, e.g. the env var name or the file path. */
  origin?: string
}

export interface ResolvedHost {
  name?: string
  kind: ResolvedValue<HostKind>
  endpoint: ResolvedValue<string>
  tenantId?: ResolvedValue<string>
  serviceToken?: ResolvedValue<string>
  record?: HostRecord
}

export interface HostResolutionInput {
  /** `--endpoint`. */
  endpoint?: string
  /** `--host` or `--profile`, both naming a saved record. */
  profile?: string
  /** `--tenant`. */
  tenantId?: string
  env?: Record<string, string | undefined>
  home: string
  cwd: string
  fs?: HostsFs
}

export interface HostResolution {
  host?: ResolvedHost
  /** Why nothing resolved, and the legs that were considered. */
  skipped: Array<{ leg: string; reason: string }>
}

export function loadHostsLayers(input: Pick<HostResolutionInput, "home" | "cwd" | "fs">): {
  user: HostsFile
  userPath: string
  project: HostsFile
  projectPath: string
} {
  const userPath = hostsPath(input.home)
  const projectPath = projectHostsPath(input.cwd)
  return {
    user: readHostsFile(userPath, input.fs),
    userPath,
    project: readHostsFile(projectPath, input.fs),
    projectPath,
  }
}

/**
 * Merge the two files. A project record wins over a user record of the same
 * name outright rather than field by field: half a device identity spliced
 * onto another host's endpoint would be a credential sent to the wrong place.
 */
export function mergeHosts(user: HostsFile, project: HostsFile): HostsFile {
  const hosts = { ...user.hosts, ...project.hosts }
  // Take the first active name that a surviving record backs. A project file
  // naming a host it did not define must not silently unset the user's active
  // host, which would turn every later command into "no host configured".
  const active = [project.active, user.active].find((name) => name !== undefined && hosts[name])
  return { version: 1, ...(active ? { active } : {}), hosts }
}

function envEndpoint(
  env: Record<string, string | undefined>
): { value: string; name: string } | undefined {
  for (const name of ["COGNIA_ENDPOINT", "COGNIA_SERVER_URL"]) {
    const value = env[name]?.trim()
    if (value) return { value: normalizeEndpoint(value), name }
  }
  return undefined
}

function envToken(
  env: Record<string, string | undefined>
): { value: string; name: string } | undefined {
  for (const name of ["COGNIA_SERVICE_TOKEN", "COGNIA_LOCAL_DEBUG_TOKEN"]) {
    const value = env[name]?.trim()
    if (value) return { value, name }
  }
  return undefined
}

export function resolveHost(input: HostResolutionInput): HostResolution {
  const env = input.env ?? process.env
  const skipped: HostResolution["skipped"] = []
  const layers = loadHostsLayers(input)
  const merged = mergeHosts(layers.user, layers.project)

  const requestedName = input.profile ?? env.COGNIA_PROFILE?.trim()

  let record: HostRecord | undefined
  let name: string | undefined
  if (requestedName) {
    record = merged.hosts[requestedName]
    if (!record) {
      const known = Object.keys(merged.hosts)
      skipped.push({
        leg: "named host",
        reason:
          known.length > 0
            ? `no host named "${requestedName}" (known: ${known.join(", ")})`
            : `no host named "${requestedName}" and no hosts are saved`,
      })
    } else {
      name = requestedName
    }
  } else if (merged.active) {
    record = merged.hosts[merged.active]
    name = merged.active
  }

  const recordSource: HostValueSource =
    name && layers.project.hosts[name] ? "project-file" : "user-file"
  const recordOrigin = recordSource === "project-file" ? layers.projectPath : layers.userPath

  const flagEndpoint = input.endpoint ? normalizeEndpoint(input.endpoint) : undefined
  const fromEnv = envEndpoint(env)

  let endpoint: ResolvedValue<string> | undefined
  if (flagEndpoint) endpoint = { value: flagEndpoint, source: "flag", origin: "--endpoint" }
  else if (fromEnv) endpoint = { value: fromEnv.value, source: "env", origin: fromEnv.name }
  else if (record) endpoint = { value: record.endpoint, source: recordSource, origin: recordOrigin }

  if (!endpoint) {
    if (!requestedName && !merged.active) {
      skipped.push({
        leg: "saved host",
        reason: "no active host is configured",
      })
    }
    skipped.push({
      leg: "environment",
      reason: "neither COGNIA_ENDPOINT nor COGNIA_SERVER_URL is set",
    })
    return { skipped }
  }

  const tokenFromEnv = envToken(env)
  // An explicit `--endpoint` points somewhere the saved record may not
  // describe, so its token is only reused when the endpoints agree. Sending a
  // host's token to a different host would be the worst kind of convenience.
  const recordMatchesEndpoint = record && record.endpoint === endpoint.value
  let serviceToken: ResolvedValue<string> | undefined
  if (tokenFromEnv) {
    serviceToken = { value: tokenFromEnv.value, source: "env", origin: tokenFromEnv.name }
  } else if (recordMatchesEndpoint && record?.serviceToken) {
    serviceToken = { value: record.serviceToken, source: recordSource, origin: recordOrigin }
  }

  const kindValue: HostKind = recordMatchesEndpoint && record ? record.kind : "headless"
  const kind: ResolvedValue<HostKind> = recordMatchesEndpoint
    ? { value: kindValue, source: recordSource, origin: recordOrigin }
    : { value: "headless", source: "default", origin: "no saved host matches this endpoint" }

  const tenantValue =
    input.tenantId ??
    env.COGNIA_TENANT_ID?.trim() ??
    (recordMatchesEndpoint ? record?.tenantId : undefined)
  const tenantId: ResolvedValue<string> | undefined = tenantValue
    ? {
        value: tenantValue,
        source: input.tenantId ? "flag" : env.COGNIA_TENANT_ID?.trim() ? "env" : recordSource,
        origin: input.tenantId
          ? "--tenant"
          : env.COGNIA_TENANT_ID?.trim()
            ? "COGNIA_TENANT_ID"
            : recordOrigin,
      }
    : undefined

  return {
    host: {
      ...(name ? { name } : {}),
      kind,
      endpoint,
      ...(tenantId ? { tenantId } : {}),
      ...(serviceToken ? { serviceToken } : {}),
      ...(recordMatchesEndpoint && record ? { record } : {}),
    },
    skipped,
  }
}

/** Flat rows for `host show`, one per resolved value with its source. */
export function describeResolution(host: ResolvedHost): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = []
  const push = (key: string, resolved?: ResolvedValue<string>) => {
    if (!resolved) return
    rows.push({
      key,
      value: resolved.value,
      source: resolved.source,
      origin: resolved.origin ?? "",
    })
  }
  if (host.name) rows.push({ key: "host", value: host.name, source: "user-file", origin: "" })
  rows.push({
    key: "kind",
    value: host.kind.value,
    source: host.kind.source,
    origin: host.kind.origin ?? "",
  })
  push("endpoint", host.endpoint)
  push("tenantId", host.tenantId)
  if (host.serviceToken) {
    rows.push({
      key: "serviceToken",
      value: "(set)",
      source: host.serviceToken.source,
      origin: host.serviceToken.origin ?? "",
    })
  }
  return rows
}
