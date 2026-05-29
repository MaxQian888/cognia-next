"use client"

import { useCallback } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  listSandboxConnections,
  putSandboxConnection,
  deleteSandboxConnection,
  getSandboxConnection,
  type SandboxConnectionRow,
} from "@/lib/db/sandbox-connections"
import { sandboxClient } from "@/lib/automation/sandbox-client"

const DEFAULT_IMAGE = "ghcr.io/trycua/cua-xfce:latest"

export interface CreateSandboxConnectionInput {
  name: string
  image?: string
  host?: string
}

/**
 * Dexie-first registry of cua desktop sandboxes (ADR-0020 remote-target) plus
 * the lifecycle action wrappers over `sandboxClient`. The list is reactive via
 * `useLiveQuery`; lifecycle calls persist the resulting port / health back into
 * the row so the Settings tab reflects live state.
 */
export function useSandboxConnections() {
  const connections = useLiveQuery(() => listSandboxConnections(), [], [] as SandboxConnectionRow[])

  const create = useCallback(async (input: CreateSandboxConnectionInput): Promise<string> => {
    const now = Date.now()
    const id = crypto.randomUUID()
    await putSandboxConnection({
      id,
      name: input.name,
      provider: "docker",
      image: input.image?.trim() || DEFAULT_IMAGE,
      host: input.host?.trim() || "127.0.0.1",
      port: 0,
      lastHealthStatus: "unknown",
      createdAt: now,
      updatedAt: now,
    })
    return id
  }, [])

  const update = useCallback(async (row: SandboxConnectionRow): Promise<void> => {
    await putSandboxConnection({ ...row, updatedAt: Date.now() })
  }, [])

  const remove = useCallback(async (id: string): Promise<void> => {
    // Best-effort stop before dropping the row so we don't orphan a container.
    try {
      await sandboxClient.stop(id)
    } catch {
      // ignore — container may not be running
    }
    await deleteSandboxConnection(id)
  }, [])

  const start = useCallback(async (id: string): Promise<void> => {
    const row = await getSandboxConnection(id)
    if (!row) return
    await putSandboxConnection({ ...row, lastHealthStatus: "starting", updatedAt: Date.now() })
    try {
      const port = await sandboxClient.start(id, row.image)
      await putSandboxConnection({
        ...row,
        port,
        lastHealthStatus: "ok",
        lastHealthError: undefined,
        lastHealthCheckAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch (err) {
      await putSandboxConnection({
        ...row,
        lastHealthStatus: "error",
        lastHealthError: err instanceof Error ? err.message : String(err),
        lastHealthCheckAt: Date.now(),
        updatedAt: Date.now(),
      })
      throw err
    }
  }, [])

  const stop = useCallback(async (id: string): Promise<void> => {
    const row = await getSandboxConnection(id)
    await sandboxClient.stop(id)
    if (row) {
      await putSandboxConnection({
        ...row,
        lastHealthStatus: "unknown",
        port: 0,
        updatedAt: Date.now(),
      })
    }
  }, [])

  const refreshHealth = useCallback(async (id: string): Promise<void> => {
    const row = await getSandboxConnection(id)
    if (!row) return
    const ok = await sandboxClient.health(id).catch(() => false)
    await putSandboxConnection({
      ...row,
      lastHealthStatus: ok ? "ok" : "unreachable",
      lastHealthCheckAt: Date.now(),
      updatedAt: Date.now(),
    })
  }, [])

  return { connections: connections ?? [], create, update, remove, start, stop, refreshHealth }
}
