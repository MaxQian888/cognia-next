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
  if (options.globalConcurrency < 1 || options.agingIntervalMs < 1) {
    throw new Error("Fair scheduler concurrency and aging interval must be positive")
  }
  const queued = new Map<string, FairTeamJob>()
  const active = new Map<string, FairTeamJob>()

  const activeForTeam = (teamId: string): number =>
    [...active.values()].filter((job) => job.teamId === teamId).length

  return {
    enqueue(job: FairTeamJob): void {
      if (job.teamConcurrency < 1) throw new Error("Team concurrency must be positive")
      if (queued.has(job.id) || active.has(job.id)) return
      queued.set(job.id, job)
    },

    acquire(now: number): FairTeamJob | null {
      if (active.size >= options.globalConcurrency) return null
      const eligible = [...queued.values()].filter(
        (job) => activeForTeam(job.teamId) < job.teamConcurrency
      )
      eligible.sort((a, b) => {
        const scoreA =
          a.priority + Math.floor(Math.max(0, now - a.enqueuedAt) / options.agingIntervalMs)
        const scoreB =
          b.priority + Math.floor(Math.max(0, now - b.enqueuedAt) / options.agingIntervalMs)
        return scoreB - scoreA || a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id)
      })
      const next = eligible[0]
      if (!next) return null
      queued.delete(next.id)
      active.set(next.id, next)
      return next
    },

    release(jobId: string): boolean {
      return active.delete(jobId)
    },

    cancel(jobId: string): boolean {
      return queued.delete(jobId)
    },

    snapshot(): { queued: FairTeamJob[]; active: FairTeamJob[] } {
      return { queued: [...queued.values()], active: [...active.values()] }
    },
  }
}

export type FairTeamScheduler = ReturnType<typeof createFairTeamScheduler>
