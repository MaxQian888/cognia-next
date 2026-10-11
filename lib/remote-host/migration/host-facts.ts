/**
 * What a paired host has, read over the management channel for a migration
 * preflight (ADR-0224).
 *
 * Every read is lazy and memoised per preflight: checking ten scheduled tasks
 * that all name the same workflow pulls the host's workflow table once, and a
 * preflight that names no workflow never pulls it. All of it goes through
 * commands a paired owner device can already call, with no approval:
 * `sync_pull` for the host's own tables, `bot_console_read` for its Bot
 * catalog and credential candidates, `scheduled_task_get` for an id.
 */

import {
  parseHostFeatureManifest,
  type HostFeatureManifest,
} from "@/lib/platform/host-feature-manifest"
import type { Transport } from "@/lib/tauri/transport-types"

/** `sync_pull` tables a preflight reads ids from. */
export type HostFactTable =
  | "workflows"
  | "characters"
  | "skills"
  | "agentTeams"
  | "plans"
  | "sessions"
  | "mcpServers"
  | "projects"
  | "adapterInstances"
  | "plugins"

interface SyncDeltaLike {
  rows?: Array<Record<string, unknown>>
}

export interface HostBotCatalogEntry {
  definitionId: string
  version: string
  pluginId?: string
}

export interface HostFacts {
  manifest(): Promise<HostFeatureManifest | null>
  /** Ids of one of the host's tables. */
  ids(table: HostFactTable): Promise<ReadonlySet<string>>
  /** Installed plugins on the host, by id, with their version. */
  plugins(): Promise<ReadonlyMap<string, string>>
  botCatalog(): Promise<ReadonlyMap<string, HostBotCatalogEntry>>
  /** Integration accounts and connector instances a Bot can bind on the host. */
  botCredentialIds(): Promise<ReadonlySet<string>>
  /** External agents configured on the host (ADR-0216 host configs). */
  externalAgentIds(): Promise<ReadonlySet<string>>
  /** True when the host already holds a scheduled task with this id. */
  hasScheduledTask(id: string): Promise<boolean>
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => {
    pending ??= load().catch((error: unknown) => {
      // A failed read is not cached: the next preflight asks again.
      pending = null
      throw error
    })
    return pending
  }
}

/** One preflight's view of one host, over its management channel. */
export function readHostFacts(transport: Pick<Transport, "call">): HostFacts {
  const pull = async (table: HostFactTable): Promise<Array<Record<string, unknown>>> => {
    const delta = await transport.call<SyncDeltaLike>("sync_pull", {
      table,
      since: 0,
      content_protocol_version: 1,
    })
    return Array.isArray(delta?.rows) ? delta.rows : []
  }
  const tables = new Map<HostFactTable, () => Promise<ReadonlySet<string>>>()
  const ids = (table: HostFactTable) => {
    let load = tables.get(table)
    if (!load) {
      load = memo(async () => {
        const rows = await pull(table)
        return new Set(
          rows.map((row) => row.id).filter((id): id is string => typeof id === "string")
        )
      })
      tables.set(table, load)
    }
    return load()
  }

  const plugins = memo(async () => {
    const rows = await pull("plugins")
    const out = new Map<string, string>()
    for (const row of rows) {
      if (typeof row.id !== "string") continue
      out.set(row.id, typeof row.version === "string" ? row.version : "")
    }
    return out as ReadonlyMap<string, string>
  })

  const botCatalog = memo(async () => {
    const answer = await transport.call<{ entries?: Array<Record<string, unknown>> }>(
      "bot_console_read",
      { view: "catalog" }
    )
    const out = new Map<string, HostBotCatalogEntry>()
    for (const entry of answer?.entries ?? []) {
      if (typeof entry.definitionId !== "string" || typeof entry.version !== "string") continue
      out.set(entry.definitionId, {
        definitionId: entry.definitionId,
        version: entry.version,
        ...(typeof entry.pluginId === "string" ? { pluginId: entry.pluginId } : {}),
      })
    }
    return out as ReadonlyMap<string, HostBotCatalogEntry>
  })

  const botCredentialIds = memo(async () => {
    const answer = await transport.call<{
      groups?: Record<string, Array<{ value?: unknown }>>
    }>("bot_console_read", { view: "credentials" })
    const out = new Set<string>()
    for (const candidates of Object.values(answer?.groups ?? {})) {
      for (const candidate of candidates) {
        if (typeof candidate.value === "string") out.add(candidate.value)
      }
    }
    return out as ReadonlySet<string>
  })

  const manifest = memo(async () =>
    parseHostFeatureManifest(await transport.call("host_feature_manifest", {}))
  )

  const externalAgentIds = memo(async () => {
    const answer = await transport.call<{ configs?: Array<Record<string, unknown>> }>(
      "external_agent_config_list",
      {}
    )
    const out = new Set<string>()
    for (const config of answer?.configs ?? []) {
      const id = typeof config.id === "string" ? config.id : config.configId
      if (typeof id === "string") out.add(id)
    }
    return out as ReadonlySet<string>
  })

  return {
    manifest,
    ids,
    externalAgentIds,
    plugins,
    botCatalog,
    botCredentialIds,
    async hasScheduledTask(id) {
      const task = await transport.call<unknown>("scheduled_task_get", { taskId: id })
      return task !== null && task !== undefined
    },
  }
}
