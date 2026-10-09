// Hatch the egg from a UI surface, exactly once.
//
// `hatchPet` is idempotent against storage, but only after its LLM call: it
// reads the profile, waits on soul generation, then writes. A double click, or
// the console and a second window both asking, used to start two generations
// that each saw `soul === null` and each wrote their own name and personality,
// the second silently replacing the first the user had already read. A
// module-level in-flight promise makes every caller share one run, and the
// result is a value instead of a throw so the console can show feedback.

import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import type { PetProfile } from "@/types/pet"
import { buildUtilityLlmClient } from "@/lib/ai/generation/utility-client"
import { getPetProfile } from "@/lib/db/pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { hatchPet } from "./init-pet"

export type HatchPetOutcome =
  /** This call (or the run it joined) gave the egg its soul. */
  | { status: "hatched"; profile: PetProfile }
  /** The pet already had a soul; nothing was generated. */
  | { status: "already-hatched"; profile: PetProfile }
  /** No profile exists on this device yet. */
  | { status: "no-profile" }
  | { status: "failed"; error: unknown }

export interface HatchPetDeps {
  getProfile?: () => Promise<PetProfile | undefined>
  buildClient?: (appSettings: AppSettings | null | undefined) => LlmClient | null
  hatch?: typeof hatchPet
  emit?: typeof emitPetEvent
}

let inFlight: Promise<HatchPetOutcome> | null = null

function buildSoulClient(appSettings: AppSettings | null | undefined): LlmClient | null {
  return buildUtilityLlmClient({ session: null, appSettings, featureId: "pet-soul" })
}

async function runHatch(
  appSettings: AppSettings | null | undefined,
  deps: HatchPetDeps
): Promise<HatchPetOutcome> {
  try {
    // Checked before a client is built, so an already-hatched pet (another
    // window won the race) costs neither a model call nor a second `hatched`.
    const current = await (deps.getProfile ?? getPetProfile)()
    if (!current) return { status: "no-profile" }
    if (current.soul) return { status: "already-hatched", profile: current }

    const client = (deps.buildClient ?? buildSoulClient)(appSettings)
    const profile = await (deps.hatch ?? hatchPet)(client)
    if (!profile?.soul) return { status: "no-profile" }
    ;(deps.emit ?? emitPetEvent)({ source: "system", kind: "hatched" })
    return { status: "hatched", profile }
  } catch (error) {
    return { status: "failed", error }
  }
}

/**
 * Generate the pet's soul once, then announce `hatched` on the bus. Concurrent
 * callers receive the same promise; a finished run releases the slot so a
 * failed attempt can be retried.
 */
export function hatchPetOnce(
  appSettings: AppSettings | null | undefined,
  deps: HatchPetDeps = {}
): Promise<HatchPetOutcome> {
  if (inFlight) return inFlight
  const run = runHatch(appSettings, deps).finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

/** Test helper: forget a run a test left in flight. */
export function __resetHatchPetForTesting(): void {
  inFlight = null
}
