import type { AgentId, McpSyncJob } from "@cognia/agent-config-types"

import { syncToAgent, type SyncResult } from "@/lib/claude/sync"
import { getDb } from "@/lib/db/schema"

const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const
const DRAIN_DEBOUNCE_MS = 100

let drainTimer: ReturnType<typeof setTimeout> | null = null

export function mcpSyncRetryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
}

export interface McpSyncDrainOptions {
  now?: () => number
  sync?: (agentId: AgentId, tombstones: ReadonlyArray<string>) => Promise<SyncResult>
}

/** Drain restart-safe, per-Agent projection jobs. Failed writes retain tombstones. */
export async function drainMcpSyncJobs(options: McpSyncDrainOptions = {}): Promise<void> {
  const db = getDb()
  const now = options.now ?? (() => Date.now())
  const sync = options.sync ?? syncToAgent
  const due = await db.mcpSyncJobs
    .filter(
      (job) =>
        (job.status === "pending" || job.status === "retrying" || job.status === "running") &&
        job.nextAttemptAt <= now()
    )
    .toArray()

  await Promise.all(
    due.map(async (job) => {
      const startedAt = now()
      const running: McpSyncJob = {
        ...job,
        status: "running",
        attempts: job.attempts + 1,
        updatedAt: startedAt,
      }
      await db.mcpSyncJobs.put(running)
      try {
        const result = await sync(job.id, job.tombstones)
        if (result.ok || result.skipped) {
          await db.mcpSyncJobs.put({
            ...running,
            status: "succeeded",
            tombstones: [],
            nextAttemptAt: 0,
            updatedAt: now(),
            lastError: undefined,
          })
          return
        }
        await persistRetry(running, result.error, now())
      } catch (error) {
        await persistRetry(running, error instanceof Error ? error.message : String(error), now())
      }
    })
  )
  await scheduleNextPersistedJob(now())
}

async function persistRetry(job: McpSyncJob, error: string, at: number): Promise<void> {
  await getDb().mcpSyncJobs.put({
    ...job,
    status: "retrying",
    nextAttemptAt: at + mcpSyncRetryDelay(job.attempts),
    updatedAt: at,
    lastError: error,
  })
}

/** Coalesce in-process wakeups; the persisted row remains authoritative. */
export function scheduleMcpSyncDrain(): void {
  scheduleMcpSyncDrainAfter(DRAIN_DEBOUNCE_MS)
}

function scheduleMcpSyncDrainAfter(delayMs: number): void {
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = setTimeout(
    () => {
      drainTimer = null
      void drainMcpSyncJobs().catch((error) => {
        console.error("MCP sync coordinator drain failed", error)
      })
    },
    Math.max(0, delayMs)
  )
}

async function scheduleNextPersistedJob(now: number): Promise<void> {
  const jobs = await getDb()
    .mcpSyncJobs.filter(
      (job) => job.status === "pending" || job.status === "retrying" || job.status === "running"
    )
    .toArray()
  if (jobs.length === 0) return
  const nextAttemptAt = Math.min(...jobs.map((job) => job.nextAttemptAt))
  scheduleMcpSyncDrainAfter(nextAttemptAt - now)
}

export function __resetMcpSyncCoordinatorForTesting(): void {
  if (drainTimer) clearTimeout(drainTimer)
  drainTimer = null
}

/** Startup hook: also recovers jobs left in running state after termination. */
export function startMcpSyncCoordinator(): void {
  scheduleMcpSyncDrain()
}

export async function requestMcpSync(agentIds: Iterable<AgentId>): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const desiredRevision = Math.max(
    0,
    ...(await db.mcpServers.toArray()).map((server) => server.revision ?? 1)
  )
  await db.transaction("rw", db.mcpSyncJobs, async () => {
    for (const agentId of agentIds) {
      const prior = await db.mcpSyncJobs.get(agentId)
      const coalescing =
        prior?.status === "pending" || prior?.status === "running" || prior?.status === "retrying"
      await db.mcpSyncJobs.put({
        id: agentId,
        desiredRevision: Math.max(desiredRevision, prior?.desiredRevision ?? 0),
        tombstones: prior?.tombstones ?? [],
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: coalescing ? prior!.createdAt : now,
        updatedAt: now,
      })
    }
  })
  scheduleMcpSyncDrain()
}
