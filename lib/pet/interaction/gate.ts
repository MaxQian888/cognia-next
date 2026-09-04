// The authoritative interaction cooldown.
//
// The access gate (`lib/pet/access/gate.ts`) answers who may ask. This answers
// how often, and it lives here because it is the only question that cannot be
// answered at a call site: the overlay's body-tap and the cross-window bridge
// reach the controller without passing through any API, so a check in front of
// the API would simply be walked around. The controller is the single
// serialized writer and sees every path, which makes it the only honest place
// for a rate decision.
//
// Pure, with the clock and the persisted state injected, exactly like
// `lib/pet/llm/proactive/gate.ts`.

import type { PetEventKind, PetEventSource, PetInteractionGateState } from "@/types/pet"

/**
 * How long each nurture is on cooldown, in ms.
 *
 * These moved here from `components/pet/pet-action-grid.tsx`, which is the
 * wrong owner: a UI file holding the enforcement constants is how the button
 * ended up correctly greyed out while the hotkey farmed the same action freely.
 *
 * `talked` is deliberately absent. Talking runs a model call governed by the
 * speak limiter (`lib/pet/bubbles/speak-limiter.ts`), and a nurture cooldown
 * on top of that would throttle a conversation, not an exploit.
 */
export const INTERACTION_COOLDOWN_MS: Readonly<Record<string, number>> = {
  fed: 1500,
  played: 1500,
  petted: 1500,
  slept: 5000,
  cleaned: 4000,
  treated: 10000,
}

/**
 * Sources whose events are DRIVEN: somebody deliberately asked for this
 * interaction right now.
 *
 * Every other source is ambient. `chat`, `goal`, `scheduler`, `workflow` and
 * the rest report that the user did something else entirely, and they are
 * already paced by whatever produced them. Cooling those down would drop the
 * pet's reactions to real work, which is the behavior the subsystem exists for.
 */
const DRIVEN_SOURCES: ReadonlySet<PetEventSource> = new Set<PetEventSource>([
  "user",
  "plugin",
  "system",
])

export type PetInteractionRefusal = "cooldown" | "not-hatched"

export interface CanInteractInput {
  nowMs: number
  kind: PetEventKind
  source: PetEventSource
  state: PetInteractionGateState
  /** `profile.soul !== null`. */
  hatched: boolean
}

export type CanInteractResult =
  | { ok: true; nextState: PetInteractionGateState }
  | { ok: false; reason: PetInteractionRefusal; readyAtMs?: number }

/** Coerce a legacy or malformed row into a usable gate state. */
export function normalizeInteractionGate(
  value: PetInteractionGateState | undefined
): PetInteractionGateState {
  const raw = value?.lastAtByKind
  if (!raw || typeof raw !== "object") return { lastAtByKind: {} }
  const lastAtByKind: Record<string, number> = {}
  for (const [kind, at] of Object.entries(raw)) {
    if (typeof at === "number" && Number.isFinite(at) && at > 0) lastAtByKind[kind] = at
  }
  return { lastAtByKind }
}

/**
 * Decide whether this event may drive the pet, and return the advanced state
 * rather than mutating, the same contract as `advanceStreak` and `applySpoke`.
 *
 * An event that is not a driven nurture passes through untouched, so the
 * sixteen ambient event sources are unaffected.
 */
export function canInteract(input: CanInteractInput): CanInteractResult {
  const cooldownMs = INTERACTION_COOLDOWN_MS[input.kind]
  if (cooldownMs === undefined || !DRIVEN_SOURCES.has(input.source)) {
    return { ok: true, nextState: input.state }
  }

  // Nurturing an egg is meaningless: `applyPetEvent` pins the stage at "egg",
  // so the XP quietly accrued and nothing visible happened. The console's
  // hatch button is the real next step, and a refusal can say so.
  if (!input.hatched) return { ok: false, reason: "not-hatched" }

  const lastAt = input.state.lastAtByKind[input.kind]
  if (typeof lastAt === "number") {
    const readyAtMs = lastAt + cooldownMs
    if (input.nowMs < readyAtMs) return { ok: false, reason: "cooldown", readyAtMs }
  }

  return {
    ok: true,
    nextState: { lastAtByKind: { ...input.state.lastAtByKind, [input.kind]: input.nowMs } },
  }
}

/** Ms until `kind` is available again, or 0 when it is ready now. */
export function remainingCooldownMs(
  state: PetInteractionGateState,
  kind: string,
  nowMs: number
): number {
  const cooldownMs = INTERACTION_COOLDOWN_MS[kind]
  const lastAt = state.lastAtByKind[kind]
  if (cooldownMs === undefined || typeof lastAt !== "number") return 0
  return Math.max(0, lastAt + cooldownMs - nowMs)
}
