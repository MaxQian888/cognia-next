// Runtime ownership handoff between the proactive speak hook and the generic
// template-bubble subscriber. While proactive speech is enabled, the hook
// claims its milestone kinds so `usePetBubbles` stays silent for them (the
// dynamic analogue of `talked` being statically absent from VARIANTS). With
// proactive OFF — the default — the set is empty and template bubbles behave
// exactly as before.

import type { PetEventKind } from "@/types/pet"

const claimed = new Set<PetEventKind>()

export function claimKinds(kinds: readonly PetEventKind[]): void {
  for (const k of kinds) claimed.add(k)
}

export function releaseKinds(kinds: readonly PetEventKind[]): void {
  for (const k of kinds) claimed.delete(k)
}

export function isClaimed(kind: PetEventKind): boolean {
  return claimed.has(kind)
}

/** Test helper — module-level state must not leak across tests. */
export function __resetProactiveClaims(): void {
  claimed.clear()
}
