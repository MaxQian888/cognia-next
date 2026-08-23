import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { pruneTerminalHostDispatch } from "@/lib/db/host-dispatch-queue"
import { createHostDispatchRunner, type HostDispatchRunner } from "./host-dispatch-runner"
import { registerMobileStepHostDelivery } from "@/lib/workflow/runtime/mobile-step-delivery"

export interface InstallHostDispatchRuntimeOptions {
  accountId: string
  emit?: (event: string, payload: unknown) => Promise<void>
  now?: () => number
  scheduleWake?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancelWake?: (timer: ReturnType<typeof setTimeout>) => void
  runner?: HostDispatchRunner
}

export interface InstalledHostDispatchRuntime {
  kick(): Promise<void>
  stop(): Promise<void>
}

const HOST_DISPATCH_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60_000

/**
 * Install exactly one Host→target drain lifecycle after all additional domain
 * handlers (for example schedule-handoff) have been registered.
 */
export function installHostDispatchRuntime(
  options: InstallHostDispatchRuntimeOptions
): InstalledHostDispatchRuntime {
  const unregisterMobile = registerMobileStepHostDelivery({ emit: options.emit })
  const now = options.now ?? Date.now
  const scheduleWake = options.scheduleWake ?? setTimeout
  const cancelWake = options.cancelWake ?? clearTimeout
  const runner = options.runner ?? createHostDispatchRunner({ accountId: options.accountId, now })
  let stopped = false
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  let retentionSweep: Promise<void> | null = null
  const sweepRetention = (): Promise<void> => {
    if (retentionSweep) return retentionSweep
    retentionSweep = pruneTerminalHostDispatch(now())
      .then(() => undefined)
      .catch((error) => {
        console.warn("host-dispatch-runtime: retention sweep failed", error)
      })
      .finally(() => {
        retentionSweep = null
      })
    return retentionSweep
  }
  void sweepRetention()
  const retentionTimer = setInterval(() => {
    void sweepRetention()
  }, HOST_DISPATCH_RETENTION_SWEEP_INTERVAL_MS)
  const retryAfterFailureMs = 2_000
  const safeKick = async (): Promise<void> => {
    try {
      await runner.kick()
    } catch (error) {
      if (stopped) return
      console.warn("host-dispatch-runtime: queue drain failed", error)
      armWake(now() + retryAfterFailureMs)
    }
  }
  const armWake = (nextAttemptAt: number | undefined) => {
    if (wakeTimer !== undefined) cancelWake(wakeTimer)
    wakeTimer = undefined
    if (stopped || nextAttemptAt === undefined) return
    const delay = Math.max(0, nextAttemptAt - now())
    if (delay === 0) {
      void safeKick()
      return
    }
    wakeTimer = scheduleWake(() => {
      wakeTimer = undefined
      if (!stopped) void safeKick()
    }, delay)
  }
  const subscription = Dexie.liveQuery(async () => {
    const db = getDb()
    const [pending, inflight] = await Promise.all([
      db.hostDispatchQueue
        .where("[accountId+status]")
        .equals([options.accountId, "pending"])
        .toArray(),
      db.hostDispatchQueue
        .where("[accountId+status]")
        .equals([options.accountId, "inflight"])
        .toArray(),
    ])
    const wakeAt = [
      ...pending.map((row) => row.nextAttemptAt),
      ...inflight.flatMap((row) => (row.leaseExpiresAt === undefined ? [] : [row.leaseExpiresAt])),
    ]
    return wakeAt.length === 0 ? undefined : Math.min(...wakeAt)
  }).subscribe({
    next(nextAttemptAt) {
      armWake(nextAttemptAt)
    },
    error(error) {
      console.warn("host-dispatch-runtime: queue subscription failed", error)
    },
  })
  void safeKick()

  return {
    kick: safeKick,
    async stop() {
      if (stopped) return
      stopped = true
      if (wakeTimer !== undefined) cancelWake(wakeTimer)
      clearInterval(retentionTimer)
      subscription.unsubscribe()
      await runner.stop()
      await retentionSweep
      unregisterMobile()
    },
  }
}
