/**
 * Headless runtime bootstrap (ADR-0059 W2 / T-A1).
 *
 * Starts every registered runtime applicable to the host, with per-runtime
 * failure isolation (one broken runtime must not take the brain down — it is
 * reported in `failed` and the rest keep starting) and reverse-order teardown
 * (later runtimes may depend on earlier ones).
 *
 * Each runtime keeps a record afterwards, so an operator can see which ones
 * are running and restart one without restarting the brain: a failed runtime
 * is started again, and a running one is torn down first. A running runtime
 * that returned no teardown cannot be restarted, because starting it a second
 * time would leave its first instance running beside the new one.
 */
import { installVectorRuntimeAdapters } from "@/lib/vector/runtime-adapters"
import { listHeadlessRuntimes } from "./registry"
import type {
  HeadlessRuntime,
  HeadlessRuntimeContext,
  HeadlessRuntimeCriticality,
  HeadlessTeardown,
} from "./types"

/** Where one runtime is now. */
export type HeadlessRuntimeState = "running" | "failed" | "restarting"

/** One runtime as an operator sees it. */
export interface HeadlessRuntimeStatus {
  name: string
  criticality: HeadlessRuntimeCriticality
  state: HeadlessRuntimeState
  /** Why its last start (or the teardown of a restart) failed. */
  error?: string
  /**
   * Whether {@link BootstrapResult.restart} can act on it now: a failed one,
   * or a running one that can be torn down.
   */
  restartable: boolean
  /** Restarts asked for since the brain started. */
  restarts: number
  /** When it last started successfully (epoch ms). */
  startedAt?: number
}

export type HeadlessRuntimeControlCode =
  "runtime_not_found" | "runtime_not_restartable" | "runtimes_stopped"

/** A restart the bootstrap refused, with a code a caller can act on. */
export class HeadlessRuntimeControlError extends Error {
  constructor(
    readonly code: HeadlessRuntimeControlCode,
    message: string
  ) {
    super(message)
    this.name = "HeadlessRuntimeControlError"
  }
}

export interface BootstrapResult {
  /** Names of runtimes that started successfully at boot, in start order. */
  started: string[]
  /** Runtimes whose `start` threw/rejected at boot, with the error. */
  failed: Array<{ name: string; error: unknown }>
  /** Every runtime this host started, in start order, as it is now. */
  status(): HeadlessRuntimeStatus[]
  /**
   * Restart one runtime by name. A restart already under way for it is
   * joined, not repeated. Resolves with the runtime's state afterwards, which
   * is `failed` when it could not start again; rejects with a
   * {@link HeadlessRuntimeControlError} when it cannot be restarted at all.
   */
  restart(name: string): Promise<HeadlessRuntimeStatus>
  /** Stop everything that started, in reverse start order. Idempotent. */
  stop(): Promise<void>
}

interface RuntimeRecord {
  runtime: HeadlessRuntime
  state: HeadlessRuntimeState
  teardown?: HeadlessTeardown
  error?: string
  restarts: number
  startedAt?: number
  restarting?: Promise<HeadlessRuntimeStatus>
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function snapshot(record: RuntimeRecord): HeadlessRuntimeStatus {
  const status: HeadlessRuntimeStatus = {
    name: record.runtime.name,
    criticality: record.runtime.criticality,
    state: record.state,
    restartable:
      record.state === "failed" || (record.state === "running" && Boolean(record.teardown)),
    restarts: record.restarts,
  }
  if (record.error !== undefined) status.error = record.error
  if (record.startedAt !== undefined) status.startedAt = record.startedAt
  return status
}

export async function bootstrapHeadlessRuntimes(
  ctx: HeadlessRuntimeContext,
  now: () => number = Date.now,
  onStatusChange?: (statuses: HeadlessRuntimeStatus[]) => void
): Promise<BootstrapResult> {
  installVectorRuntimeAdapters()
  const started: string[] = []
  const failed: Array<{ name: string; error: unknown }> = []
  const records = new Map<string, RuntimeRecord>()

  function notifyStatusChange(): void {
    try {
      onStatusChange?.(Array.from(records.values(), snapshot))
    } catch (error) {
      ctx.log("warn", `headless runtime status notification failed: ${describe(error)}`)
    }
  }

  async function start(record: RuntimeRecord): Promise<unknown> {
    const { name } = record.runtime
    try {
      const teardown = await record.runtime.start(ctx)
      record.teardown = typeof teardown === "function" ? teardown : undefined
      record.state = "running"
      record.error = undefined
      record.startedAt = now()
      ctx.log("info", `headless runtime started: ${name}`)
      return undefined
    } catch (error) {
      record.teardown = undefined
      record.state = "failed"
      record.error = describe(error)
      ctx.log("error", `headless runtime failed to start: ${name}: ${describe(error)}`)
      return error
    }
  }

  for (const runtime of listHeadlessRuntimes()) {
    if (!runtime.hosts.includes(ctx.host)) continue
    const record: RuntimeRecord = { runtime, state: "restarting", restarts: 0 }
    records.set(runtime.name, record)
    const error = await start(record)
    if (record.state === "running") started.push(runtime.name)
    else failed.push({ name: runtime.name, error })
  }

  let stopped = false

  function restart(name: string): Promise<HeadlessRuntimeStatus> {
    if (stopped) {
      return Promise.reject(
        new HeadlessRuntimeControlError("runtimes_stopped", "the brain is shutting down")
      )
    }
    const record = records.get(name)
    if (!record) {
      return Promise.reject(
        new HeadlessRuntimeControlError(
          "runtime_not_found",
          `no headless runtime named "${name}" runs on this host`
        )
      )
    }
    if (record.restarting) return record.restarting
    if (record.state === "running" && !record.teardown) {
      return Promise.reject(
        new HeadlessRuntimeControlError(
          "runtime_not_restartable",
          `"${name}" is running and has no teardown, so starting it again would run it twice`
        )
      )
    }
    record.restarting = (async () => {
      record.restarts += 1
      record.state = "restarting"
      notifyStatusChange()
      if (record.teardown) {
        try {
          await record.teardown()
          ctx.log("info", `headless runtime stopped for a restart: ${name}`)
        } catch (error) {
          // Half stopped: starting it again could run it twice. Keep the
          // teardown so the next restart tries it again.
          record.state = "failed"
          record.error = `teardown failed: ${describe(error)}`
          ctx.log("warn", `headless runtime restart aborted: ${name}: ${describe(error)}`)
          return snapshot(record)
        }
        record.teardown = undefined
      }
      ctx.log("info", `headless runtime restarting: ${name}`)
      await start(record)
      return snapshot(record)
    })().finally(() => {
      record.restarting = undefined
      notifyStatusChange()
    })
    return record.restarting
  }

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    // A restart in flight finishes first, so its fresh teardown is the one run.
    await Promise.allSettled(
      Array.from(records.values(), (record) => record.restarting).filter(Boolean)
    )
    for (const record of Array.from(records.values()).reverse()) {
      const { teardown } = record
      if (!teardown) continue
      record.teardown = undefined
      try {
        await teardown()
        ctx.log("info", `headless runtime stopped: ${record.runtime.name}`)
      } catch (error) {
        ctx.log(
          "warn",
          `headless runtime teardown failed: ${record.runtime.name}: ${describe(error)}`
        )
      }
    }
  }

  return {
    started,
    failed,
    status: () => Array.from(records.values(), snapshot),
    restart,
    stop,
  }
}
