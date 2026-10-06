export type RuntimeTargetSubscriptionStopper = () => void | Promise<void>

export type RuntimeTargetTransitionPhase = "finalize-captures" | "release-subscriptions"

export interface RuntimeTargetTransitionContext {
  accountId: string
  fromTargetId: string | null
  toTargetId: string
}

export interface RuntimeTargetTransitionParticipant {
  id: string
  phase: RuntimeTargetTransitionPhase
  priority: number
  run(context: RuntimeTargetTransitionContext): void | Promise<void>
}

const participants = new Map<string, RuntimeTargetTransitionParticipant>()

let activeStopper: RuntimeTargetSubscriptionStopper | null = null
const cleanups = new Set<{ run: RuntimeTargetSubscriptionStopper }>()

/** Register a scope owner without replacing the Companion subscription slot. */
export function registerRuntimeTargetCleanup(
  cleanup: RuntimeTargetSubscriptionStopper
): () => void {
  const entry = { run: cleanup }
  cleanups.add(entry)
  return () => {
    cleanups.delete(entry)
  }
}

export function registerRuntimeTargetSubscriptionStopper(
  stopper: RuntimeTargetSubscriptionStopper
): () => void {
  activeStopper = stopper
  return () => {
    if (activeStopper === stopper) activeStopper = null
  }
}

export async function stopRuntimeTargetSubscriptions(): Promise<void> {
  const stopper = activeStopper
  activeStopper = null
  const pending = [...cleanups].map((entry) => entry.run)
  cleanups.clear()
  if (stopper) pending.push(stopper)
  // Release all owners before allowing database/cipher replacement. A failed
  // owner must not prevent the others from aborting their in-flight work.
  const results = await Promise.allSettled(
    pending.map((cleanup) => Promise.resolve().then(cleanup))
  )
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  )
  if (failures.length === 1) throw failures[0].reason
  if (failures.length > 1)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Runtime target cleanup failed"
    )
}

export function registerRuntimeTargetTransitionParticipant(
  participant: RuntimeTargetTransitionParticipant
): () => void {
  const key = `${participant.phase}:${participant.id}`
  if (participants.has(key)) {
    throw new Error(`Runtime target transition participant already registered: ${key}`)
  }
  participants.set(key, participant)
  return () => {
    if (participants.get(key) === participant) participants.delete(key)
  }
}

export async function runRuntimeTargetTransitionPhase(
  phase: RuntimeTargetTransitionPhase,
  context: RuntimeTargetTransitionContext
): Promise<void> {
  const ordered = [...participants.values()]
    .filter((participant) => participant.phase === phase)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
  for (const participant of ordered) await participant.run(context)
  if (phase === "release-subscriptions") await stopRuntimeTargetSubscriptions()
}
