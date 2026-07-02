// The side-effecting orchestration glue: consumes PetEvents from the bus,
// persists the progression (XP/needs/level/stage), drives the visual state +
// one-shot queue in the store, and records newly-unlocked achievements. Events
// are serialized through a promise chain so rapid bursts can't race the
// read-modify-write of the singleton profile.
//
// Bubbles are intentionally NOT handled here — the widget subscribes to the bus
// separately for ephemeral bubble display (it needs the React i18n context).

import type { PetEvent, PetEventKind } from "@/types/pet"
import { effectiveStats } from "@/types/pet"
import {
  appendPetActivity,
  getPetActivityCounters,
  getPetProfile,
  listPetAchievements,
  listPetActivity,
  recordPetAchievement,
  upsertPetProfile,
} from "@/lib/db/pet"
import { generateBones } from "@/lib/pet/bones/generate"
import { reducePetVisualState, restingWithCare } from "@/lib/pet/state/reducer"
import { applyPetEvent, INTERACTION_KINDS } from "@/lib/pet/runtime/apply-event"
import { computeStreakFromLedger } from "@/lib/pet/economy/streak"
import { CHAOS_BURST_COUNT } from "@/lib/pet/stats/growth-table"
import { xpForEvent } from "@/lib/pet/xp/award-table"
import { checkAchievements } from "@/lib/pet/achievements/check"
import { getPetEventBus } from "@/lib/pet/events/pet-event-bus"
import { usePetStore } from "@/stores/pet/pet-store"

/**
 * Event kinds whose resting state should honor a persistent care condition.
 * Only low-signal ambient kinds with no expressive state of their own belong
 * here — kinds that map to an expressive state in `reducePetVisualState`
 * (e.g. `twinBusy` → thinking, `twinMilestone` → happy) must NOT be listed, or
 * `restingWithCare` would suppress those states and make the reducer cases dead.
 */
const PASSIVE_KINDS = new Set<PetEventKind>(["idle", "inboundMessage", "scheduledRun"])

/** Last processed event kind — drives the error→success "recovered" signal. */
let lastEventKind: PetEventKind | null = null

async function process(event: PetEvent): Promise<void> {
  let profile = await getPetProfile()
  if (!profile) return // not initialized yet; init flow seeds the profile

  const now = event.at || Date.now()

  // One-time streak backfill for profiles that predate the economy: derive the
  // cached streak from the interaction ledger. Runs inside the serialized
  // chain, so it can't race the read-modify-write below.
  if (profile.streak === undefined) {
    const ledger = await listPetActivity(2000)
    profile = { ...profile, streak: computeStreakFromLedger(ledger, INTERACTION_KINDS) }
  }

  // Pure signals for the stat-growth step: a flurry of recent XP-bearing events
  // (chaos) and an error→success recovery (debugging).
  const recent = await listPetActivity(CHAOS_BURST_COUNT)
  const recoveredFromError = event.kind === "success" && lastEventKind === "error"
  lastEventKind = event.kind

  const {
    profile: nextProfile,
    oneShots,
    grewStats,
    becameUnwell,
    recovered,
  } = applyPetEvent(profile, event, now, {
    recentEventTs: recent.map((r) => r.ts),
    recoveredFromError,
  })

  // When the pet first becomes unwell, stamp the notify time durably so the
  // care-alert hook fires at most once per episode.
  const persistProfile = becameUnwell
    ? { ...nextProfile, care: { ...nextProfile.care, notifiedAt: now } }
    : nextProfile
  await upsertPetProfile(persistProfile)

  // Record meaningful events (XP-bearing) in the ledger for counters/图鉴.
  const xp = xpForEvent(event.kind, event.xp)
  if (xp > 0) {
    await appendPetActivity({ kind: event.kind, source: event.source, xp, ts: now })
  }

  // Drive the renderer. Passive/idle events honor a persistent unwell condition;
  // interactions and milestones keep their expressive states.
  const store = usePetStore.getState()
  const visual = PASSIVE_KINDS.has(event.kind)
    ? restingWithCare(persistProfile.needs, persistProfile.care.condition)
    : reducePetVisualState(event, persistProfile.needs)
  store.setVisualState(visual)
  for (const shot of oneShots) store.enqueueOneShot(shot)
  if (grewStats.length) store.setLastGrewStats(grewStats)
  if (becameUnwell) {
    store.setCareAlert({ at: now, petName: persistProfile.soul?.name ?? null })
  }
  if (recovered) store.enqueueOneShot("happy")

  // Evaluate achievements against the fresh snapshot.
  const bones = generateBones(persistProfile.accountFingerprint)
  const counters = await getPetActivityCounters()
  const unlocked = (await listPetAchievements()).map((a) => a.id)
  const newly = checkAchievements(
    {
      profile: persistProfile,
      bones,
      activity: [],
      counters,
      effectiveStats: effectiveStats(bones.stats, persistProfile.statProgress),
      care: persistProfile.care,
    },
    unlocked
  )
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

/**
 * Run profile-mutating work serialized after any in-flight event handling.
 * Every profile write OUTSIDE the event path (shop purchases, decor applies)
 * MUST go through this — the controller's read-modify-write `upsertPetProfile`
 * would otherwise silently overwrite a concurrent coin deduction.
 */
export function enqueuePetWork<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(() => fn())
  chain = result.then(
    () => {},
    () => {}
  )
  return result
}

/** Test helper: drain the serialization chain. */
export function whenPetEventsSettled(): Promise<void> {
  return chain
}
