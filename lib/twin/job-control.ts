export type TwinJobInterruptKind = "pause" | "cancel" | "stop"

export class TwinJobInterruptedError extends Error {
  constructor(
    readonly jobId: string,
    readonly kind: TwinJobInterruptKind
  ) {
    super(`Twin job ${jobId} interrupted: ${kind}`)
    this.name = "TwinJobInterruptedError"
  }
}

const activeJobs = new Map<string, AbortController>()

export function registerActiveTwinJob(jobId: string): {
  signal: AbortSignal
  release: () => void
} {
  const existing = activeJobs.get(jobId)
  existing?.abort(new TwinJobInterruptedError(jobId, "stop"))
  const controller = new AbortController()
  activeJobs.set(jobId, controller)
  return {
    signal: controller.signal,
    release: () => {
      if (activeJobs.get(jobId) === controller) activeJobs.delete(jobId)
    },
  }
}

export function interruptActiveTwinJob(jobId: string, kind: TwinJobInterruptKind): boolean {
  const controller = activeJobs.get(jobId)
  if (!controller || controller.signal.aborted) return false
  controller.abort(new TwinJobInterruptedError(jobId, kind))
  return true
}

export function throwIfTwinJobInterrupted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new TwinJobInterruptedError("unknown", "stop")
}

export function isTwinJobInterrupted(error: unknown): error is TwinJobInterruptedError {
  return error instanceof TwinJobInterruptedError
}

export function __resetActiveTwinJobsForTesting(): void {
  for (const controller of activeJobs.values()) {
    controller.abort(new TwinJobInterruptedError("test", "stop"))
  }
  activeJobs.clear()
}
