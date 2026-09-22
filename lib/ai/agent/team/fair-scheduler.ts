export interface FairTeamJob {
  id: string
  teamId: string
  priority: number
  enqueuedAt: number
  teamConcurrency: number
}

export interface FairTeamSchedulerOptions {
  globalConcurrency: number
  agingIntervalMs: number
}

export function createFairTeamScheduler(options: FairTeamSchedulerOptions) {
  if (
    !Number.isSafeInteger(options.globalConcurrency) ||
    options.globalConcurrency < 1 ||
    !Number.isFinite(options.agingIntervalMs) ||
    options.agingIntervalMs < 1
  ) {
    throw new Error("Fair scheduler concurrency and aging interval must be positive")
  }
  const queued = new Map<string, FairTeamJob>()
  const active = new Map<string, FairTeamJob>()
  const activeByTeam = new Map<string, number>()

  return {
    enqueue(job: FairTeamJob): void {
      if (!Number.isSafeInteger(job.teamConcurrency) || job.teamConcurrency < 1) {
        throw new Error("Team concurrency must be a positive integer")
      }
      if (
        !job.id ||
        !job.teamId ||
        !Number.isFinite(job.priority) ||
        !Number.isFinite(job.enqueuedAt)
      ) {
        throw new Error("Scheduler jobs require stable ids and finite priority and enqueue time")
      }
      if (queued.has(job.id) || active.has(job.id)) return
      queued.set(job.id, { ...job })
    },

    acquire(now: number): FairTeamJob | null {
      if (!Number.isFinite(now)) throw new Error("Scheduler clock must be finite")
      if (active.size >= options.globalConcurrency) return null
      let next: FairTeamJob | undefined
      let bestScore = -Infinity
      for (const job of queued.values()) {
        if ((activeByTeam.get(job.teamId) ?? 0) >= job.teamConcurrency) continue
        const score =
          job.priority + Math.floor(Math.max(0, now - job.enqueuedAt) / options.agingIntervalMs)
        if (
          !next ||
          score > bestScore ||
          (score === bestScore &&
            (job.enqueuedAt < next.enqueuedAt ||
              (job.enqueuedAt === next.enqueuedAt && job.id.localeCompare(next.id) < 0)))
        ) {
          next = job
          bestScore = score
        }
      }
      if (!next) return null
      queued.delete(next.id)
      active.set(next.id, next)
      activeByTeam.set(next.teamId, (activeByTeam.get(next.teamId) ?? 0) + 1)
      return { ...next }
    },

    release(jobId: string): boolean {
      const job = active.get(jobId)
      if (!job) return false
      active.delete(jobId)
      const remaining = (activeByTeam.get(job.teamId) ?? 1) - 1
      if (remaining === 0) activeByTeam.delete(job.teamId)
      else activeByTeam.set(job.teamId, remaining)
      return true
    },

    cancel(jobId: string): boolean {
      return queued.delete(jobId)
    },

    snapshot(): { queued: FairTeamJob[]; active: FairTeamJob[] } {
      return {
        queued: [...queued.values()].map((job) => ({ ...job })),
        active: [...active.values()].map((job) => ({ ...job })),
      }
    },
  }
}

export type FairTeamScheduler = ReturnType<typeof createFairTeamScheduler>
