import type {
  McpConfigValue,
  McpServer,
  McpServerConfig,
  McpServerSummary,
  McpTransport,
} from "@cognia/agent-config-types"

const NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

export class McpDefinitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpDefinitionError"
  }
}

export function normalizeMcpNamespace(name: string): string {
  return name.trim().toLocaleLowerCase("en-US")
}

export function assertUniqueMcpNamespace(
  name: string,
  existing: ReadonlyArray<Pick<McpServer, "id" | "name">>,
  excludeId?: string
): void {
  const normalized = normalizeMcpNamespace(name)
  if (
    existing.some((row) => row.id !== excludeId && normalizeMcpNamespace(row.name) === normalized)
  ) {
    throw new McpDefinitionError(`MCP namespace "${name.trim()}" already exists`)
  }
}

function isStringMap(value: unknown): value is Record<string, McpConfigValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" ||
      (entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { secretRef?: unknown }).secretRef === "string")
  )
}

function isConfigValue(value: unknown): value is McpConfigValue {
  return (
    typeof value === "string" ||
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { secretRef?: unknown }).secretRef === "string"
    )
  )
}

export function validateMcpConfig(
  transport: McpTransport,
  config: McpServerConfig
): McpServerConfig {
  const raw = config as unknown as Record<string, unknown>
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new McpDefinitionError("MCP config must be an object")
  }
  if (transport === "stdio") {
    if (typeof raw.command !== "string" || !raw.command.trim()) {
      throw new McpDefinitionError("stdio MCP config requires a non-empty command")
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(isConfigValue))) {
      throw new McpDefinitionError("stdio MCP args must be strings or SecretRef values")
    }
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
      throw new McpDefinitionError("stdio MCP cwd must be a string")
    }
    if (raw.env !== undefined && !isStringMap(raw.env)) {
      throw new McpDefinitionError("stdio MCP env values must be strings or SecretRef values")
    }
    return config
  }

  if (!isConfigValue(raw.url)) {
    throw new McpDefinitionError("remote MCP config requires a URL")
  }
  if (typeof raw.url === "string") {
    if (!raw.url.trim()) throw new McpDefinitionError("remote MCP config requires a URL")
    try {
      new URL(raw.url)
    } catch {
      throw new McpDefinitionError("remote MCP config requires a valid URL")
    }
  }
  if (raw.headers !== undefined && !isStringMap(raw.headers)) {
    throw new McpDefinitionError("remote MCP headers must be strings or SecretRef values")
  }
  if (raw.allowPrivateNetwork !== undefined && typeof raw.allowPrivateNetwork !== "boolean") {
    throw new McpDefinitionError("allowPrivateNetwork must be a boolean")
  }
  return config
}

export function validateMcpDefinition<T extends Pick<McpServer, "name" | "transport" | "config">>(
  server: T
): T {
  const name = server.name.trim()
  if (!NAMESPACE_PATTERN.test(name)) {
    throw new McpDefinitionError(
      "MCP namespace must be 1-128 characters using letters, numbers, underscore, dot, or hyphen"
    )
  }
  validateMcpConfig(server.transport, server.config)
  return server
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    if ("secretRef" in value) return '"<secret-ref>"'
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    )
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** Stable, non-secret-bearing fingerprint for review/cache invalidation. */
export function fingerprintMcpDefinition(
  server: Pick<McpServer, "name" | "transport" | "config" | "disallowedTools">
): string {
  const material = canonical({
    name: normalizeMcpNamespace(server.name),
    transport: server.transport,
    config: server.config,
    disallowedTools: [...(server.disallowedTools ?? [])].map((tool) => tool.trim()).sort(),
  })
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let i = 0; i < material.length; i += 1) {
    const code = material.charCodeAt(i)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`
}

/**
 * Project a server row into the sync mirror a paired client reads.
 *
 * `toolNames` is passed in rather than read here: the names live in the
 * capability cache, this function is sync and runs inside the write
 * transaction, and a summary must never lose the tool list just because the
 * caller had no cache handy — so an omitted argument preserves whatever the
 * previous summary carried (see `projectMcpSummaryTools`).
 */
export function toMcpServerSummary(
  server: McpServer,
  toolNames?: readonly string[]
): McpServerSummary {
  return {
    id: server.id,
    displayName: server.displayName?.trim() || server.name,
    transport: server.transport,
    enabled: server.enabled,
    trustState: server.trust?.state ?? "legacy",
    updatedAt: server.updatedAt,
    ...(server.disallowedTools?.length ? { disallowedTools: [...server.disallowedTools] } : {}),
    ...(server.disallowedToolPatterns?.length
      ? { disallowedToolPatterns: [...server.disallowedToolPatterns] }
      : {}),
    ...(toolNames?.length ? { toolNames: [...toolNames] } : {}),
  }
}
