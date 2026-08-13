export type PerformanceSecurityBarrierReason = "account-locked" | "account-switched"

export interface PerformanceSecurityBarrierEvent {
  generation: number
  accountId: string
  reason: PerformanceSecurityBarrierReason
  at: number
}

let generation = 0
const listeners = new Set<(event: PerformanceSecurityBarrierEvent) => void>()

export function getPerformanceSecurityGeneration(): number {
  return generation
}

export function assertPerformanceSecurityGeneration(expected: number): void {
  if (generation !== expected) throw new Error("performance-security-generation-changed")
}

export function bumpPerformanceSecurityGeneration(
  accountId: string,
  reason: PerformanceSecurityBarrierReason,
  now = Date.now()
): PerformanceSecurityBarrierEvent {
  generation += 1
  const event = { generation, accountId, reason, at: now }
  // The marker contains no secrets and is synchronous, so a process crash
  // between lock and the next IndexedDB turn can still be recovered safely.
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(`cognia-perf-recovery:${accountId}`, JSON.stringify(event))
    } catch {
      // Storage denial is explicit to active captures through the event below.
    }
  }
  for (const listener of listeners) listener(event)
  return event
}

export function subscribePerformanceSecurityBarrier(
  listener: (event: PerformanceSecurityBarrierEvent) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetPerformanceSecurityGenerationForTests(): void {
  generation = 0
  listeners.clear()
}
