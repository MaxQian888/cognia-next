"use client"

import { useCallback } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  createSandboxConnectionRow,
  listSandboxConnections,
  putSandboxConnection,
  deleteSandboxConnection,
  getSandboxConnection,
  updateSandboxConnectionState,
  type SandboxConnectionRow,
} from "@/lib/db/sandbox-connections"
import {
  runSandboxConnectionOperation,
  serializeSandboxConnectionOperation,
  type SandboxConnectionOperationResult,
} from "@/lib/sandbox/connection-lifecycle"
import type { SandboxProviderConfig, SandboxWorkspaceMount } from "@/types/sandbox"

const DEFAULT_IMAGE = "ghcr.io/trycua/cua-xfce:latest"

export interface CreateSandboxConnectionInput {
  name: string
  image?: string
  host?: string
  /**
   * Container policy, frozen in when the container is created. Docker fixes
   * all of it at create time, so it cannot be changed later without rebuilding
   * the machine.
   */
  networkMode?: string
  cpus?: string
  memoryMb?: number
  workspaceMount?: SandboxWorkspaceMount
}

/**
 * Dexie-first registry of cua desktop sandboxes (ADR-0020 remote-target) plus
 * the lifecycle action wrappers over the provider adapter. The list is
 * reactive via `useLiveQuery`, and every lifecycle call persists the resulting
 * placement and state back onto the row.
 *
 * Each action writes its transitional state (`creating`, `starting`,
 * `suspending`, `resuming`, `stopping`) before calling the adapter, so a slow
 * Docker operation is visible rather than looking like a frozen button. Writes
 * go through `updateSandboxConnectionState`, which re-reads the row first: a
 * connection deleted while an operation was in flight must not be resurrected
 * by a stale spread of the row we started with.
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
        // The tab only creates local Docker connections today. cua.ai Cloud
        // and Lume connections are created by their own provider adapters.
        driver: "computer-server",
        config: {
          provider: "docker",
          image: input.image?.trim() || DEFAULT_IMAGE,
          host: input.host?.trim() || "127.0.0.1",
          port: 0,
          ...(input.networkMode ? { networkMode: input.networkMode } : {}),
          ...(input.cpus ? { cpus: input.cpus } : {}),
          ...(typeof input.memoryMb === "number" ? { memoryMb: input.memoryMb } : {}),
          ...(input.workspaceMount ? { workspaceMount: input.workspaceMount } : {}),
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
      await updateSandboxConnectionState(id, { state: "deleting", now: Date.now() })
      // Best-effort teardown, then always drop the row. A container that was
      // never created, an unreachable Docker daemon, or a provider with no
      // lifecycle adapter yet must not leave the user with a connection they
      // can never delete from Settings.
      await runSandboxConnectionOperation(row, "delete").catch(() => undefined)
      await deleteSandboxConnection(id)
    })
  }, [])

  /** Provision the machine without starting it. */
  const provision = useCallback(async (id: string): Promise<void> => {
    await runLifecycle(id, "creating", async (row) => {
      const result = await runSandboxConnectionOperation(row, "create")
      return {
        state: "stopped",
        config: withPlacement(row.config, result, { port: 0 }),
        lastHealthStatus: "unknown",
        lastHealthError: null,
      }
    })
  }, [])

  const start = useCallback(async (id: string): Promise<void> => {
    await runLifecycle(id, "starting", async (row) => {
      // Starting an already-running connection is a no-op, not a reason to
      // mark the row broken. The toolbar offers Start unconditionally, and the
      // lifecycle contract refuses `start` while running.
      if (row.state === "running") return null
      const result = await runSandboxConnectionOperation(row, "start")
      if (row.config.provider !== "docker" || result.port === undefined) {
        throw new Error("Docker sandbox start completed without a mapped port.")
      }
      return {
        state: "running",
        config: withPlacement(row.config, result),
        lastHealthStatus: "ok",
        lastHealthError: null,
        lastHealthCheckAt: Date.now(),
      }
    })
  }, [])

  const suspend = useCallback(async (id: string): Promise<void> => {
    await runLifecycle(id, "suspending", async (row) => {
      await runSandboxConnectionOperation(row, "suspend")
      // The port mapping survives a pause, and so does everything in memory.
      // Clearing either would describe a machine that had been stopped.
      return { state: "suspended", lastHealthStatus: "unknown" }
    })
  }, [])

  const resume = useCallback(async (id: string): Promise<void> => {
    await runLifecycle(id, "resuming", async (row) => {
      const result = await runSandboxConnectionOperation(row, "resume")
      return {
        state: "running",
        config: withPlacement(row.config, result),
        lastHealthStatus: "ok",
        lastHealthError: null,
        lastHealthCheckAt: Date.now(),
      }
    })
  }, [])

  const stop = useCallback(async (id: string): Promise<void> => {
    await runLifecycle(id, "stopping", async (row) => {
      // A connection that was never initialized has nothing to stop. The
      // lifecycle contract refuses `stop` in that state and the toolbar still
      // offers the button, so settle the row instead of erroring it.
      if (row.state !== "uninitialized") {
        await runSandboxConnectionOperation(row, "stop")
      }
      return {
        state: "stopped",
        lastHealthStatus: "unknown",
        // The mapped port is gone, because Docker publishes none for a stopped
        // container. The container id stays: the container itself survives a
        // stop now, along with everything written inside it, and dropping the
        // id would orphan a machine the row is still responsible for.
        config: row.config.provider === "docker" ? { ...row.config, port: 0 } : row.config,
      }
    })
  }, [])

  const refreshHealth = useCallback(async (id: string): Promise<void> => {
    await serializeSandboxConnectionOperation(id, async () => {
      const row = await getSandboxConnection(id)
      if (!row) return
      // A probe that cannot complete IS the unreachable answer. It is not a
      // lifecycle failure and it must not reject: `refreshHealth` is the one
      // action a user reaches for when the machine is already broken.
      const probe = await runSandboxConnectionOperation(row, "health")
        .then((result) => ({
          ok: result.health === true,
          report: result.healthReport,
          error: undefined as string | undefined,
        }))
        .catch((error: unknown) => ({
          ok: false,
          report: undefined,
          error: error instanceof Error ? error.message : String(error),
        }))

      await updateSandboxConnectionState(id, {
        lastHealthStatus: probe.ok ? "ok" : "unreachable",
        // Clearing this on success is the point: the machine answered. On
        // failure it must NOT be cleared, because this is the moment the user
        // asked what is wrong and the message a failed start left behind is
        // the one answer they have. Prefer the probe's own reason when it has
        // one.
        lastHealthError: probe.ok ? null : (probe.error ?? probe.report?.error ?? undefined),
        // The probe now reads Docker's own view of the container, so a failed
        // reachability check finally comes with evidence about *why*. Adopt
        // that state. When the probe itself could not run there is no
        // evidence, and `state` is left alone rather than guessed at.
        ...(probe.report ? { state: probe.report.state } : {}),
        lastHealthCheckAt: Date.now(),
        now: Date.now(),
      })
    })
  }, [])

  return {
    connections: connections ?? [],
    create,
    update,
    remove,
    provision,
    start,
    suspend,
    resume,
    stop,
    refreshHealth,
  }
}

type LifecycleSettlement = Parameters<typeof updateSandboxConnectionState>[1] extends infer P
  ? P extends { now: number }
    ? Omit<P, "now">
    : never
  : never

/**
 * Run one lifecycle transition: stamp the transitional state, call the
 * adapter, then settle. A thrown adapter error settles the row as `error` with
 * the reason attached, and is re-thrown so the caller can surface it.
 */
async function runLifecycle(
  id: string,
  transitional: SandboxConnectionRow["state"],
  action: (row: SandboxConnectionRow) => Promise<LifecycleSettlement | null>
): Promise<void> {
  await serializeSandboxConnectionOperation(id, async () => {
    const row = await getSandboxConnection(id)
    if (!row) return
    await updateSandboxConnectionState(id, {
      state: transitional,
      ...(transitional === "starting" ? { lastHealthStatus: "starting" as const } : {}),
      now: Date.now(),
    })
    try {
      const settlement = await action(row)
      // `null` means the action decided there was nothing to do. Put the row
      // back where it was rather than leaving it stuck mid-transition.
      await updateSandboxConnectionState(id, {
        ...(settlement ?? { state: row.state, lastHealthStatus: row.lastHealthStatus }),
        now: Date.now(),
      })
    } catch (error) {
      await updateSandboxConnectionState(id, {
        state: "error",
        lastHealthStatus: "error",
        lastHealthError: error instanceof Error ? error.message : String(error),
        lastHealthCheckAt: Date.now(),
        now: Date.now(),
      })
      throw error
    }
  })
}

/** Fold a placement the adapter reported back into the row's config. */
function withPlacement(
  config: SandboxProviderConfig,
  result: SandboxConnectionOperationResult,
  overrides: { port?: number } = {}
): SandboxProviderConfig {
  if (config.provider !== "docker") return config
  return {
    ...config,
    ...(result.containerId !== undefined ? { containerId: result.containerId } : {}),
    ...(overrides.port !== undefined
      ? { port: overrides.port }
      : result.port !== undefined
        ? { port: result.port }
        : {}),
  }
}
