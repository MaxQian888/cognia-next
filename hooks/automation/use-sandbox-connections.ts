"use client"

import { useCallback } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  createSandboxConnectionRow,
  listSandboxConnections,
  putSandboxConnection,
  deleteSandboxConnection,
  getSandboxConnection,
  type SandboxConnectionRow,
} from "@/lib/db/sandbox-connections"
import {
  runSandboxConnectionOperation,
  serializeSandboxConnectionOperation,
} from "@/lib/sandbox/connection-lifecycle"

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
    await putSandboxConnection(
      createSandboxConnectionRow({
        id,
        name: input.name,
        // The tab only creates local Docker connections today; cua.ai Cloud
        // and Lume connections are created by their own provider adapters.
        driver: "computer-server",
        config: {
          provider: "docker",
          image: input.image?.trim() || DEFAULT_IMAGE,
          host: input.host?.trim() || "127.0.0.1",
          port: 0,
        },
        now,
      })
    )
    return id
  }, [])

  const update = useCallback(async (row: SandboxConnectionRow): Promise<void> => {
    await putSandboxConnection({ ...row, updatedAt: Date.now() })
  }, [])

  const remove = useCallback(async (id: string): Promise<void> => {
    await serializeSandboxConnectionOperation(id, async () => {
      const row = await getSandboxConnection(id)
      if (!row) return
      try {
        await runSandboxConnectionOperation(row, "delete")
        await deleteSandboxConnection(id)
      } catch (error) {
        await persistLifecycleError(row, error)
        throw error
      }
    })
  }, [])

  const start = useCallback(async (id: string): Promise<void> => {
    await serializeSandboxConnectionOperation(id, async () => {
      const row = await getSandboxConnection(id)
      if (!row) return
      await putSandboxConnection({
        ...row,
        state: "starting",
        lastHealthStatus: "starting",
        updatedAt: Date.now(),
      })
      try {
        const result = await runSandboxConnectionOperation(row, "start")
        if (row.config.provider !== "docker" || result.port === undefined) {
          throw new Error("Docker sandbox start completed without a mapped port.")
        }
        await putSandboxConnection({
          ...row,
          config: { ...row.config, port: result.port },
          state: "running",
          lastHealthStatus: "ok",
          lastHealthError: undefined,
          lastHealthCheckAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (error) {
        await persistLifecycleError(row, error)
        throw error
      }
    })
  }, [])

  const stop = useCallback(async (id: string): Promise<void> => {
    await serializeSandboxConnectionOperation(id, async () => {
      const row = await getSandboxConnection(id)
      if (!row) return
      try {
        await runSandboxConnectionOperation(row, "stop")
        await putSandboxConnection({
          ...row,
          state: "stopped",
          lastHealthStatus: "unknown",
          // Clear both the mapped port and the container id: the container is
          // gone, and a stale id would make the next start() adopt a ghost.
          config:
            row.config.provider === "docker"
              ? { provider: "docker", image: row.config.image, host: row.config.host, port: 0 }
              : row.config,
          updatedAt: Date.now(),
        })
      } catch (error) {
        await persistLifecycleError(row, error)
        throw error
      }
    })
  }, [])

  const refreshHealth = useCallback(async (id: string): Promise<void> => {
    await serializeSandboxConnectionOperation(id, async () => {
      const row = await getSandboxConnection(id)
      if (!row) return
      try {
        const { health } = await runSandboxConnectionOperation(row, "health")
        await putSandboxConnection({
          ...row,
          lastHealthStatus: health ? "ok" : "unreachable",
          lastHealthError: undefined,
          // A failed probe is not proof the machine is stopped, so `state` is left
          // alone; only an explicit stop/start transition moves it.
          lastHealthCheckAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (error) {
        await persistLifecycleError(row, error, false)
        throw error
      }
    })
  }, [])

  return { connections: connections ?? [], create, update, remove, start, stop, refreshHealth }
}

async function persistLifecycleError(
  row: SandboxConnectionRow,
  error: unknown,
  markStateError = true
): Promise<void> {
  await putSandboxConnection({
    ...row,
    ...(markStateError ? { state: "error" as const } : {}),
    lastHealthStatus: "error",
    lastHealthError: error instanceof Error ? error.message : String(error),
    lastHealthCheckAt: Date.now(),
    updatedAt: Date.now(),
  })
}
