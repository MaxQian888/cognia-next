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
  await stopper?.()
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
    .sort(
      (left, right) => left.priority - right.priority || left.id.localeCompare(right.id)
    )
  for (const participant of ordered) await participant.run(context)
  if (phase === "release-subscriptions") await stopRuntimeTargetSubscriptions()
}
