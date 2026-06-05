// The side-effecting orchestration glue: consumes PetEvents from the bus,
// persists the progression (XP/needs/level/stage), drives the visual state +
// one-shot queue in the store, and records newly-unlocked achievements. Events
// are serialized through a promise chain so rapid bursts can't race the
// read-modify-write of the singleton profile.
//
// Bubbles are intentionally NOT handled here — the widget subscribes to the bus
// separately for ephemeral bubble display (it needs the React i18n context).

import type { PetEvent } from "@/types/pet"
import {
  appendPetActivity,
  getPetActivityCounters,
  getPetProfile,
  listPetAchievements,
  recordPetAchievement,
  upsertPetProfile,
} from "@/lib/db/pet"
import { generateBones } from "@/lib/pet/bones/generate"
import { reducePetVisualState } from "@/lib/pet/state/reducer"
import { applyPetEvent } from "@/lib/pet/runtime/apply-event"
import { xpForEvent } from "@/lib/pet/xp/award-table"
import { checkAchievements } from "@/lib/pet/achievements/check"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"

async function process(event: PetEvent): Promise<void> {
  const profile = await getPetProfile()
  if (!profile) return // not initialized yet; init flow seeds the profile

  const now = event.at || Date.now()
  const { profile: nextProfile, oneShots } = applyPetEvent(profile, event, now)
  await upsertPetProfile(nextProfile)

  // Record meaningful events (XP-bearing) in the ledger for counters/图鉴.
  const xp = xpForEvent(event.kind, event.xp)
  if (xp > 0) {
    await appendPetActivity({ kind: event.kind, source: event.source, xp, ts: now })
  }

  // Drive the renderer.
  const store = usePetStore.getState()
  store.setVisualState(reducePetVisualState(event, nextProfile.needs))
  for (const shot of oneShots) store.enqueueOneShot(shot)

  // Evaluate achievements against the fresh snapshot.
  const bones = generateBones(nextProfile.accountFingerprint)
  const counters = await getPetActivityCounters()
  const unlocked = (await listPetAchievements()).map((a) => a.id)
  const newly = checkAchievements({ profile: nextProfile, bones, activity: [], counters }, unlocked)
  for (const id of newly) await recordPetAchievement(id, now)

  // Announce unlocks on the bus so bubble/proactive subscribers can celebrate.
  // Guarded against feedback: achievementUnlocked itself never unlocks anything
  // new, awards no XP, and the serialized chain absorbs the re-entrant handling.
  if (event.kind !== "achievementUnlocked") {
    const bus = getPetEventBus()
    for (const id of newly) {
      bus.emit({
        source: "system",
        kind: "achievementUnlocked",
        at: now,
        meta: { achievementId: id },
      })
    }
  }
}

let chain: Promise<void> = Promise.resolve()

/** Handle one event, serialized after any in-flight handling. */
export function handlePetEvent(event: PetEvent): Promise<void> {
  chain = chain.then(() => process(event)).catch(() => {})
  return chain
}

/** Test helper: drain the serialization chain. */
export function whenPetEventsSettled(): Promise<void> {
  return chain
}
