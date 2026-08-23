import type { KeyringStore } from "@/lib/credentials/keyring-store"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import type { McpSecretRef, McpServer } from "@cognia/agent-config-types"

const MCP_CREDENTIAL_NAMESPACE = "mcp-credentials/v1"
const SENSITIVE_NAME =
  /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|authorization|credential)(?:$|[_-])/i
const SENSITIVE_ARG = /^--?(?:token|secret|password|api[_-]?key|authorization|credential)(?:=|$)/i
const SENSITIVE_QUERY = /^(?:access_token|token|api[_-]?key|key|secret|password)$/i

function sensitiveArgumentValueIndexes(args: unknown[]): Set<number> {
  const indexes = new Set<number>()
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (typeof value !== "string" || !SENSITIVE_ARG.test(value)) continue
    if (value.includes("=")) {
      indexes.add(index)
      continue
    }
    const next = args[index + 1]
    if (isMcpSecretRef(next) || (typeof next === "string" && !next.startsWith("-"))) {
      indexes.add(index + 1)
    }
  }
  return indexes
}

export function createMcpCredentialStore(): KeyringStore {
  return createKeyringStore(MCP_CREDENTIAL_NAMESPACE)
}

export function isMcpSecretRef(value: unknown): value is McpSecretRef {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { secretRef?: unknown }).secretRef === "string"
  )
}

export function hasMcpSecretRefs(value: unknown): boolean {
  if (isMcpSecretRef(value)) return true
  if (Array.isArray(value)) return value.some(hasMcpSecretRefs)
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).some(hasMcpSecretRefs)
  )
}

function urlContainsCredential(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password) return true
    return [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))
  } catch {
    return false
  }
}

function ref(serverId: string, path: string): McpSecretRef {
  return { secretRef: `mcp/${serverId}/${path}` }
}

async function persistVerified(
  store: KeyringStore,
  target: McpSecretRef,
  value: string
): Promise<void> {
  await store.save(target.secretRef, value)
  if ((await store.load(target.secretRef)) !== value) {
    throw new Error(`MCP credential verification failed for ${target.secretRef}`)
  }
}

export interface McpSecretMigrationResult {
  server: McpServer
  migrated: number
  references: string[]
}

export interface McpExportRedactionResult {
  server: McpServer
  references: string[]
}

/** Build a portable definition plus a manifest of credentials the restore must supply. */
export function redactMcpServerForExport(server: McpServer): McpExportRedactionResult {
  const config = structuredClone(server.config) as Record<string, unknown>
  const references = new Set<string>()
  const redact = (path: string, value: unknown): McpSecretRef | unknown => {
    if (isMcpSecretRef(value)) {
      references.add(value.secretRef)
      return value
    }
    if (typeof value !== "string") return value
    const target = ref(server.id, path)
    references.add(target.secretRef)
    return target
  }

  for (const mapKey of ["env", "headers"] as const) {
    const map = config[mapKey]
    if (!map || typeof map !== "object" || Array.isArray(map)) continue
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (isMcpSecretRef(value) || (typeof value === "string" && SENSITIVE_NAME.test(key))) {
        ;(map as Record<string, unknown>)[key] = redact(
          `${mapKey}/${encodeURIComponent(key)}`,
          value
        )
      }
    }
  }
  if (Array.isArray(config.args)) {
    const sensitiveIndexes = sensitiveArgumentValueIndexes(config.args)
    config.args = config.args.map((value, index) =>
      isMcpSecretRef(value) || sensitiveIndexes.has(index) ? redact(`args/${index}`, value) : value
    )
  }
  if (
    isMcpSecretRef(config.url) ||
    (typeof config.url === "string" && urlContainsCredential(config.url))
  ) {
    config.url = redact("url", config.url)
  }
  return {
    server: { ...server, config: config as never },
    references: [...references].sort(),
  }
}

/**
 * Move sensitive values out of a server definition. The returned row is safe
 * to persist only after every keyring write has been read back successfully.
 */
export async function externalizeMcpSecrets(
  server: McpServer,
  store: KeyringStore = createMcpCredentialStore(),
  options: { ignoredPaths?: ReadonlySet<string> } = {}
): Promise<McpSecretMigrationResult> {
  const config = structuredClone(server.config) as Record<string, unknown>
  const references: string[] = []

  const move = async (path: string, value: string): Promise<McpSecretRef> => {
    const target = ref(server.id, path)
    await persistVerified(store, target, value)
    references.push(target.secretRef)
    return target
  }

  for (const mapKey of ["env", "headers"] as const) {
    const map = config[mapKey]
    if (!map || typeof map !== "object" || Array.isArray(map)) continue
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (
        typeof value === "string" &&
        SENSITIVE_NAME.test(key) &&
        !options.ignoredPaths?.has(`${mapKey}/${key}`)
      ) {
        ;(map as Record<string, unknown>)[key] = await move(
          `${mapKey}/${encodeURIComponent(key)}`,
          value
        )
      }
    }
  }

  if (Array.isArray(config.args)) {
    const sensitiveIndexes = sensitiveArgumentValueIndexes(config.args)
    for (let index = 0; index < config.args.length; index += 1) {
      const value = config.args[index]
      if (
        typeof value === "string" &&
        sensitiveIndexes.has(index) &&
        !options.ignoredPaths?.has(`args/${index}`)
      ) {
        config.args[index] = await move(`args/${index}`, value)
      }
    }
  }

  if (
    typeof config.url === "string" &&
    urlContainsCredential(config.url) &&
    !options.ignoredPaths?.has("url")
  ) {
    config.url = await move("url", config.url)
  }

  if (references.length === 0) return { server, migrated: 0, references }
  const now = Date.now()
  return {
    server: {
      ...server,
      config: config as never,
      credentialVersion: (server.credentialVersion ?? 0) + 1,
      updatedAt: now,
    },
    migrated: references.length,
    references,
  }
}

async function resolveValue(value: unknown, store: KeyringStore): Promise<unknown> {
  if (isMcpSecretRef(value)) {
    const secret = await store.load(value.secretRef)
    if (secret === null) {
      throw new Error(`MCP credential is unavailable: ${value.secretRef}`)
    }
    return secret
  }
  if (Array.isArray(value)) return Promise.all(value.map((entry) => resolveValue(entry, store)))
  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, entry]) => [
        key,
        await resolveValue(entry, store),
      ])
    )
    return Object.fromEntries(entries)
  }
  return value
}

/** Resolve references at the trusted host immediately before connecting/projecting. */
export async function resolveMcpSecrets(
  config: McpServer["config"],
  store: KeyringStore = createMcpCredentialStore()
): Promise<Record<string, unknown>> {
  return (await resolveValue(config, store)) as Record<string, unknown>
}

/** Erase every keyring value referenced by a server before terminal deletion. */
export async function deleteMcpCredentials(
  server: McpServer,
  store: KeyringStore = createMcpCredentialStore()
): Promise<number> {
  const references = redactMcpServerForExport(server).references
  await Promise.all(references.map((reference) => store.delete(reference)))
  return references.length
}
