"use client"

// Shared "what does each external agent look like right now" state.
// Loads on first use, caches per process, exposes a `refresh()` for
// post-mutation invalidation. Both the per-server chip group and the
// top-level status bar subscribe.
//
// We keep three numbers per agent:
//   - inFileCount: how many entries the agent's file currently holds
//   - projectedCount: how many of OUR servers have appsEnabled[agent] = true
//   - parseError: surfaces a "we can't parse the file, fix it by hand" hint

import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { MCP_AGENT_ADAPTERS, type McpAgentAdapter } from "@/lib/claude/agents"
import { readAgentConfig } from "@/lib/claude/ipc"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { isTauri } from "@/lib/tauri"
import type { AgentId, McpServer } from "@cognia/agent-config-types"

export interface AgentStatus {
  agent: McpAgentAdapter
  /** Resolved path on this OS, or null when the agent isn't supported here. */
  path: string | null
  exists: boolean
  parseError?: string
  /** Servers currently in the agent's file (parsed via the adapter). */
  inFileCount: number
  /** Names currently sitting in the agent's file. Used for drift detection. */
  inFileNames: ReadonlySet<string>
}

interface FileSnapshot {
  path: string | null
  exists: boolean
  parseError?: string
  inFileCount: number
  inFileNames: ReadonlySet<string>
}

let snapshotPromise: Promise<Record<AgentId, FileSnapshot>> | null = null
const subscribers = new Set<() => void>()

function loadSnapshots(): Promise<Record<AgentId, FileSnapshot>> {
  if (snapshotPromise) return snapshotPromise
  if (!isTauri()) {
    const empty: Record<string, FileSnapshot> = {}
    for (const a of MCP_AGENT_ADAPTERS) {
      empty[a.id] = {
        path: null,
        exists: false,
        inFileCount: 0,
        inFileNames: new Set(),
      }
    }
    snapshotPromise = Promise.resolve(empty as Record<AgentId, FileSnapshot>)
    return snapshotPromise
  }
  snapshotPromise = Promise.all(
    MCP_AGENT_ADAPTERS.map(async (a) => {
      try {
        const cfg = await readAgentConfig(a.id)
        const drafts = cfg.parsed != null ? a.parse(cfg.parsed) : []
        return [
          a.id,
          {
            path: cfg.path,
            exists: cfg.exists,
            parseError: cfg.parseError,
            inFileCount: drafts.length,
            inFileNames: new Set(drafts.map((d) => d.name)),
          },
        ] as const
      } catch (err) {
        return [
          a.id,
          {
            path: null,
            exists: false,
            parseError: err instanceof Error ? err.message : String(err),
            inFileCount: 0,
            inFileNames: new Set<string>(),
          },
        ] as const
      }
    })
  ).then((entries) => {
    const out: Record<string, FileSnapshot> = {}
    for (const [id, st] of entries) out[id] = st
    return out as Record<AgentId, FileSnapshot>
  })
  return snapshotPromise
}

/** Drop the cached file snapshots; the next subscriber re-reads. */
export function refreshAgentStatuses(): void {
  snapshotPromise = null
  for (const fn of subscribers) fn()
}

export interface DriftInfo {
  /** Names cognia *thinks* should be in the file but aren't. */
  missing: string[]
  /** Names in the file that we *don't* have a record of. Could be hand-edits. */
  unmanaged: string[]
}

export interface UseAgentStatusesResult {
  statuses: AgentStatus[]
  loading: boolean
  /** Server count actually projected to each agent right now. */
  projectedCount: Partial<Record<AgentId, number>>
  /** Names cognia projects to each agent (empty when none). */
  projectedNames: Partial<Record<AgentId, ReadonlySet<string>>>
  /**
   * Per-agent drift summary: names we project that aren't in the file
   * (someone removed them externally). Only populated for writable agents
   * with an existing readable file.
   */
  drift: Partial<Record<AgentId, DriftInfo>>
  refresh: () => void
}

export function useAgentStatuses(serverSnapshot?: McpServer[]): UseAgentStatusesResult {
  const [snapshots, setSnapshots] = useState<Record<AgentId, FileSnapshot> | null>(null)
  const liveServers = useLiveQuery(
    () => serverSnapshot ?? listMcpServers(),
    serverSnapshot ? [serverSnapshot] : []
  )
  const servers = serverSnapshot ?? liveServers ?? []

  useEffect(() => {
    let cancelled = false
    const run = () => {
      void loadSnapshots().then((s) => {
        if (!cancelled) setSnapshots(s)
      })
    }
    run()
    subscribers.add(run)
    return () => {
      cancelled = true
      subscribers.delete(run)
    }
  }, [])

  const projectedCount: Partial<Record<AgentId, number>> = {}
  const projectedNames: Partial<Record<AgentId, Set<string>>> = {}
  for (const s of servers) {
    const apps = s.appsEnabled ?? {}
    for (const [id, on] of Object.entries(apps)) {
      if (!on) continue
      const key = id as AgentId
      projectedCount[key] = (projectedCount[key] ?? 0) + 1
      const set = projectedNames[key] ?? new Set<string>()
      set.add(s.name)
      projectedNames[key] = set
    }
  }

  const statuses: AgentStatus[] = MCP_AGENT_ADAPTERS.map((agent) => {
    const snap = snapshots?.[agent.id]
    return {
      agent,
      path: snap?.path ?? null,
      exists: snap?.exists ?? false,
      parseError: snap?.parseError,
      inFileCount: snap?.inFileCount ?? 0,
      inFileNames: snap?.inFileNames ?? new Set<string>(),
    }
  })

  // Compute drift: only for writable agents with a readable file. Missing =
  // names we project but aren't in the file. Unmanaged = names in the file
  // that no Cognia row has appsEnabled for (could be hand-rolled — we don't
  // alert on these aggressively but expose them so the UI can show counts).
  const drift: Partial<Record<AgentId, DriftInfo>> = {}
  if (snapshots) {
    for (const agent of MCP_AGENT_ADAPTERS) {
      if (!agent.writable) continue
      const snap = snapshots[agent.id]
      if (!snap.exists || snap.parseError) continue
      const projected = projectedNames[agent.id] ?? new Set<string>()
      const inFile = snap.inFileNames
      const missing: string[] = []
      for (const name of projected) {
        if (!inFile.has(name)) missing.push(name)
      }
      const unmanaged: string[] = []
      for (const name of inFile) {
        if (!projected.has(name)) unmanaged.push(name)
      }
      drift[agent.id] = { missing, unmanaged }
    }
  }

  return {
    statuses,
    loading: snapshots == null,
    projectedCount,
    projectedNames,
    drift,
    refresh: refreshAgentStatuses,
  }
}

/**
 * Returns AgentIds that are writable AND have a config file present on this
 * machine. Used to default `appsEnabled` when the user adds a new server,
 * so it lands in every detected agent automatically.
 */
export async function getDetectedWritableAgents(): Promise<AgentId[]> {
  const snaps = await loadSnapshots()
  const out: AgentId[] = []
  for (const a of MCP_AGENT_ADAPTERS) {
    if (!a.writable) continue
    if (snaps[a.id]?.exists) out.push(a.id)
  }
  return out
}
