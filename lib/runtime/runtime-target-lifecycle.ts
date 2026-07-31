export type RuntimeTargetSubscriptionStopper = () => void | Promise<void>

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
