// Pure mapping from a pet event (+ current needs) to the resting visual state the
// renderer should settle into. One-shot flourishes are enqueued separately by the
// wiring layer; this reducer only decides the looping state. Kept pure so the
// whole expression policy is exhaustively unit-tested.

import type { PetEvent, PetMood, PetNeeds, PetVisualState } from "@/types/pet"

/** Coarse mood derived from needs — drives idle flavour + bubble tone. */
export function deriveMood(needs: PetNeeds): PetMood {
  if (needs.energy <= 20) return "tired"
  if (needs.mood <= 25) return "grumpy"
  if (needs.bond <= 5) return "lonely"
  if (needs.mood >= 80 && needs.energy >= 60) return "happy"
  return "content"
}

/** Resting state when nothing is happening, chosen from needs. */
export function restingFromNeeds(needs: PetNeeds): PetVisualState {
  const mood = deriveMood(needs)
  if (mood === "tired") return "sleeping"
  if (mood === "grumpy") return "sad"
  return "idle"
}

/** States that should auto-revert to the needs-derived resting state. */
export function isTransientState(state: PetVisualState): boolean {
  return state === "happy" || state === "greeting" || state === "interacting" || state === "review"
}

/** Map the latest event to a resting visual state. */
export function reducePetVisualState(event: PetEvent, needs: PetNeeds): PetVisualState {
  switch (event.kind) {
    case "thinking":
      return "thinking"
    case "waiting":
      return "waiting"
    case "review":
      return "review"
    case "error":
      return "error"
    case "success":
    case "goalComplete":
    case "levelUp":
    case "evolved":
    case "achievementUnlocked":
      return "happy"
    case "greeting":
    case "hatched":
      return "greeting"
    case "fed":
    case "played":
    case "petted":
    case "talked":
      return "interacting"
    case "goalProgress":
    case "teamRun":
    case "workflowRun":
      return "thinking"
    case "inboundMessage":
    case "scheduledRun":
      return restingFromNeeds(needs)
    case "idle":
      return restingFromNeeds(needs)
  }
}
