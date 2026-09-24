import { proxyFetch } from "@/lib/network/proxy-fetch"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"

export const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
export const ACP_REGISTRY_CACHE_MS = 15 * 60_000

export interface AcpRegistryCommandDistribution {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpRegistryBinaryArtifact {
  archive: string
  sha256?: string
  cmd: string
  args?: string[]
  env?: Record<string, string>
}

export interface AcpRegistryAgent {
  id: string
  name: string
  version: string
  description: string
  repository?: string
  website?: string
  authors?: string[]
  license?: string
  icon?: string
  distribution: {
    binary?: Record<string, AcpRegistryBinaryArtifact>
    npx?: AcpRegistryCommandDistribution
    uvx?: AcpRegistryCommandDistribution
  }
}

export interface AcpRegistryCatalog {
  version: string
  agents: AcpRegistryAgent[]
}

export type AcpResolvedDistribution =
  | {
      kind: "binary"
      archive: string
      checksum: string
      executable: string
      args: string[]
      env: Record<string, string>
    }
  | {
      kind: "npx" | "uvx"
      command: "npx" | "uvx"
      args: string[]
      env: Record<string, string>
    }

interface RegistryCache {
  catalog: AcpRegistryCatalog
  etag?: string
  expiresAt: number
}

let cache: RegistryCache | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && !item.includes("\0"))
  ) {
    throw new Error(`ACP Registry ${field} must be a string array`)
  }
}

function validateCommandDistribution(value: unknown, field: string): void {
  if (!isRecord(value) || typeof value.package !== "string") {
    throw new Error(`ACP Registry ${field} distribution is invalid`)
  }
  if (value.args !== undefined) assertStringArray(value.args, `${field}.args`)
  if (
    value.env !== undefined &&
    (!isRecord(value.env) || !Object.values(value.env).every((item) => typeof item === "string"))
  ) {
    throw new Error(`ACP Registry ${field}.env is invalid`)
  }
}

function validateAgent(value: unknown): asserts value is AcpRegistryAgent {
  if (!isRecord(value)) throw new Error("ACP Registry agent must be an object")
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(value.id)) {
    throw new Error("ACP Registry agent id is invalid")
  }
  for (const field of ["name", "version", "description"] as const) {
    if (typeof value[field] !== "string" || !value[field]) {
      throw new Error(`ACP Registry agent ${field} is invalid`)
    }
  }
  if (!isRecord(value.distribution)) throw new Error("ACP Registry distribution is invalid")
  const distribution = value.distribution
  if (distribution.npx !== undefined) validateCommandDistribution(distribution.npx, "npx")
  if (distribution.uvx !== undefined) validateCommandDistribution(distribution.uvx, "uvx")
  if (distribution.binary !== undefined) {
    if (!isRecord(distribution.binary))
      throw new Error("ACP Registry binary distribution is invalid")
    for (const artifact of Object.values(distribution.binary)) {
      if (
        !isRecord(artifact) ||
        typeof artifact.archive !== "string" ||
        typeof artifact.cmd !== "string"
      ) {
        throw new Error("ACP Registry binary artifact is invalid")
      }
      if (artifact.args !== undefined) assertStringArray(artifact.args, "binary.args")
    }
  }
  if (!distribution.binary && !distribution.npx && !distribution.uvx) {
    throw new Error("ACP Registry agent has no distribution")
  }
}

export function validateAcpRegistry(value: unknown): AcpRegistryCatalog {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+/.test(value.version)
  ) {
    throw new Error("ACP Registry version is invalid")
  }
  if (!Array.isArray(value.agents)) throw new Error("ACP Registry agents must be an array")
  for (const agent of value.agents) validateAgent(agent)
  return value as unknown as AcpRegistryCatalog
}

export async function fetchAcpRegistry(
  options: {
    fetcher?: typeof fetch
    fallback?: AcpRegistryCatalog
    now?: () => number
  } = {}
): Promise<AcpRegistryCatalog> {
  const now = options.now?.() ?? Date.now()
  if (cache && now < cache.expiresAt) return cache.catalog
  const fetcher = options.fetcher ?? proxyFetch
  const headers: Record<string, string> = { Accept: "application/json" }
  if (cache?.etag) headers["If-None-Match"] = cache.etag
  try {
    const response = await fetcher(ACP_REGISTRY_URL, {
      headers,
      cache: "no-store",
    })
    if (response.status === 304 && cache) {
      cache.expiresAt = now + ACP_REGISTRY_CACHE_MS
      return cache.catalog
    }
    if (!response.ok) throw new Error(`ACP Registry HTTP ${response.status}`)
    const catalog = validateAcpRegistry(await response.json())
    cache = {
      catalog,
      etag: response.headers.get("etag") ?? undefined,
      expiresAt: now + ACP_REGISTRY_CACHE_MS,
    }
    return catalog
  } catch (error) {
    if (cache) return cache.catalog
    if (options.fallback) return options.fallback
    throw error
  }
}

export function resetAcpRegistryCacheForTests(): void {
  cache = undefined
}

export function mergeAcpDiscovery(options: {
  registry: AcpRegistryCatalog
  builtins: Array<{ id: string; name: string; [key: string]: unknown }>
  users: Array<{ id: string; name: string; [key: string]: unknown }>
}): Array<{
  qualifiedId: string
  source: "registry" | "builtin" | "user"
  name: string
  [key: string]: unknown
}> {
  const merged = new Map<
    string,
    {
      qualifiedId: string
      source: "registry" | "builtin" | "user"
      name: string
      [key: string]: unknown
    }
  >()
  for (const entry of options.registry.agents) {
    const qualifiedId = `registry:${entry.id}`
    merged.set(qualifiedId, { ...entry, qualifiedId, source: "registry" })
  }
  for (const entry of options.builtins) {
    const qualifiedId = `builtin:${entry.id}`
    merged.set(qualifiedId, { ...entry, qualifiedId, source: "builtin" })
  }
  for (const entry of options.users) {
    const qualifiedId = entry.id
    merged.set(qualifiedId, { ...entry, qualifiedId, source: "user" })
  }
  return [...merged.values()]
}

function safeArgs(value: string[] | undefined): string[] {
  const args = value ?? []
  assertStringArray(args, "args")
  return [...args]
}

function safeEnv(value: Record<string, string> | undefined): Record<string, string> {
  return { ...(value ?? {}) }
}

function exactNpmPackage(value: string, version: string): string {
  const match = value.match(/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@([^\s]+))?$/i)
  if (!match) throw new Error("ACP Registry npm package is unsafe")
  if (match[2] && match[2] !== version) throw new Error("ACP Registry npm version mismatch")
  return `${match[1]}@${version}`
}

function exactPythonPackage(value: string, version: string): string {
  const match = value.match(/^([a-z0-9][a-z0-9._-]*)(?:==([^\s]+))?$/i)
  if (!match) throw new Error("ACP Registry Python package is unsafe")
  if (match[2] && match[2] !== version) throw new Error("ACP Registry Python version mismatch")
  return `${match[1]}==${version}`
}

export function resolveAcpRegistryDistribution(
  agent: AcpRegistryAgent,
  platform: string
): AcpResolvedDistribution {
  const artifact = agent.distribution.binary?.[platform]
  if (artifact) {
    const archive = new URL(artifact.archive)
    if (archive.protocol !== "https:") throw new Error("ACP Registry binary archive must use HTTPS")
    if (!artifact.sha256 || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      throw new Error("ACP Registry binary checksum is required")
    }
    const executable = artifact.cmd.replace(/\\/g, "/").replace(/^\.\//, "")
    if (!executable || executable.startsWith("/") || executable.split("/").includes("..")) {
      throw new Error("ACP Registry executable traversal is forbidden")
    }
    return {
      kind: "binary",
      archive: archive.href,
      checksum: artifact.sha256.toLowerCase(),
      executable,
      args: safeArgs(artifact.args),
      env: safeEnv(artifact.env),
    }
  }
  if (agent.distribution.npx) {
    return {
      kind: "npx",
      command: "npx",
      args: [
        "-y",
        exactNpmPackage(agent.distribution.npx.package, agent.version),
        ...safeArgs(agent.distribution.npx.args),
      ],
      env: safeEnv(agent.distribution.npx.env),
    }
  }
  if (agent.distribution.uvx) {
    return {
      kind: "uvx",
      command: "uvx",
      args: [
        exactPythonPackage(agent.distribution.uvx.package, agent.version),
        ...safeArgs(agent.distribution.uvx.args),
      ],
      env: safeEnv(agent.distribution.uvx.env),
    }
  }
  throw new Error(`ACP Registry has no distribution for ${platform}`)
}

export async function createConfirmedRegistryAgentConfig(options: {
  agent: AcpRegistryAgent
  platform: string
  configId: string
  confirm: (summary: {
    registryId: string
    version: string
    command: string
    args: string[]
    checksum?: string
  }) => Promise<boolean>
  /** Path produced by the native verified installer for binary distributions. */
  installedBinary?: { path: string; checksum: string }
  now?: () => Date
}): Promise<ExternalAgentConfig> {
  const distribution = resolveAcpRegistryDistribution(options.agent, options.platform)
  const binary = distribution.kind === "binary"
  const approved = await options.confirm({
    registryId: options.agent.id,
    version: options.agent.version,
    command: binary ? distribution.executable : distribution.command,
    args: distribution.args,
    ...(binary ? { checksum: distribution.checksum } : {}),
  })
  if (!approved) throw new Error("ACP Registry execution was not approved")
  if (binary) {
    if (!options.installedBinary) {
      throw new Error("ACP Registry binary must be installed by the verified native installer")
    }
    if (options.installedBinary.checksum.toLowerCase() !== distribution.checksum) {
      throw new Error("ACP Registry installed binary checksum mismatch")
    }
  }
  const command = binary ? options.installedBinary!.path : distribution.command

  const now = options.now?.() ?? new Date()
  return {
    id: options.configId,
    name: options.agent.name,
    description: options.agent.description,
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command, args: distribution.args, env: distribution.env },
    defaultPermissionMode: "default",
    tags: ["acp", "registry"],
    registryProvenance: {
      registryId: options.agent.id,
      version: options.agent.version,
      ...(binary ? { checksum: distribution.checksum } : {}),
      sourceUrl: ACP_REGISTRY_URL,
      installedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  }
}
