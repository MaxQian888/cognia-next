// Default XP weights per event kind. Used when an event doesn't carry its own
// `xp` (sources usually set it explicitly; this is the fallback + the canonical
// reference for "how much is each activity worth"). Finishing a goal is the
// richest reward; passive radar states grant nothing.

import type { PetEventKind } from "@/types/pet"

export const XP_AWARD: Partial<Record<PetEventKind, number>> = {
  // radar / passive
  thinking: 0,
  waiting: 0,
  review: 2,
  success: 3,
  error: 0,
  idle: 0,
  // milestones
  goalProgress: 5,
  goalComplete: 25,
  teamRun: 8,
  workflowRun: 4,
  inboundMessage: 1,
  scheduledRun: 2,
  // interactions
  fed: 3,
  played: 4,
  petted: 2,
  talked: 2,
  slept: 2,
  cleaned: 2,
  treated: 3,
  // lifecycle
  hatched: 0,
  greeting: 0,
  levelUp: 0,
  evolved: 0,
  achievementUnlocked: 0, // celebration only; the unlocking event already paid XP
}

/** Resolve XP for an event: explicit value wins, else the table, else 0. */
export function xpForEvent(kind: PetEventKind, explicit?: number): number {
  if (typeof explicit === "number") return explicit
  return XP_AWARD[kind] ?? 0
}
