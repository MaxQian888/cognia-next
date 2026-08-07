import type { KeyringStore } from "@/lib/credentials/keyring-store"

import { getDb } from "@/lib/db/schema"
import { externalizeMcpSecrets } from "./credentials"
import { toMcpServerSummary } from "./server-definition"

export interface McpCredentialMigrationItem {
  serverId: string
  status: "migrated" | "unchanged" | "failed"
  migrated: number
  error?: string
}

export interface McpCredentialMigrationReport {
  startedAt: number
  completedAt: number
  items: McpCredentialMigrationItem[]
}

export interface McpCredentialMigratorOptions {
  store?: KeyringStore
  /** Host/UI-reviewed false positives. Paths use `env/KEY`, `headers/KEY`, `args/N`, or `url`. */
  ignoredPaths?: ReadonlyMap<string, ReadonlySet<string>>
  now?: () => number
}

/**
 * Resumable host migration. Each verified server is committed independently;
 * a failed keyring write leaves its original compatible row untouched.
 */
export async function migrateMcpCredentials(
  options: McpCredentialMigratorOptions = {}
): Promise<McpCredentialMigrationReport> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const db = getDb()
  const rows = await db.mcpServers.toArray()
  const items: McpCredentialMigrationItem[] = []

  for (const row of rows) {
    try {
      const result = await externalizeMcpSecrets(row, options.store, {
        ignoredPaths: options.ignoredPaths?.get(row.id),
      })
      if (result.migrated === 0) {
        items.push({ serverId: row.id, status: "unchanged", migrated: 0 })
        continue
      }
      await db.transaction("rw", db.mcpServers, db.mcpServerSummaries, async () => {
        await db.mcpServers.put(result.server)
        await db.mcpServerSummaries.put(toMcpServerSummary(result.server))
      })
      items.push({ serverId: row.id, status: "migrated", migrated: result.migrated })
    } catch (error) {
      items.push({
        serverId: row.id,
        status: "failed",
        migrated: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { startedAt, completedAt: now(), items }
}
