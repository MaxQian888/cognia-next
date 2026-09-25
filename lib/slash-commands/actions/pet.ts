// Action handler for the `/pet` slash command.
//
// Surface (7 subcommands):
//   /pet | /pet status   — push a status card (name, stage, level, needs, care)
//   /pet feed|play|pet|sleep|clean|treat — drive the matching care interaction
//
// The interactions go through the pet's access gate
// (`requestPetInteraction({kind:"user"}, kind)`), the same door the global
// hotkey and the tray use, so availability, the kind whitelist and the burst
// bucket all apply, and XP, needs and achievements stay owned by the
// controller. This used to emit straight onto the bus and always confirm, so
// on the web, on mobile, or with the pet switched off (no controller
// listening) it reported "Fed your pet." while nothing happened. Output is
// chat-facing markdown (English, like the sibling /goal and /status commands).

import { getPetProfile } from "@/lib/db/pet"
import type { PetAccessResult, PetInteractionKind, PetRefusal } from "@/lib/pet/access/gate"
import type { PetAvailability, PetUnavailableReason } from "@/lib/pet/access/availability"
import { normalizeInteractionGate, remainingCooldownMs } from "@/lib/pet/interaction/gate"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { levelProgress } from "@/lib/pet/xp/leveling"

export type PetSubcommand = "status" | "feed" | "play" | "pet" | "sleep" | "clean" | "treat"

const INTERACTION_EVENT_BY_SUB: Partial<Record<PetSubcommand, PetInteractionKind>> = {
  feed: "fed",
  play: "played",
  pet: "petted",
  sleep: "slept",
  clean: "cleaned",
  treat: "treated",
}

const INTERACTION_CONFIRMATION: Partial<Record<PetSubcommand, string>> = {
  feed: "🍪 Fed your pet.",
  play: "🎮 Played with your pet.",
  pet: "💛 Petted your pet.",
  sleep: "🌙 Tucked your pet in for a nap.",
  clean: "🫧 Cleaned your pet.",
  treat: "🎁 Gave your pet a treat.",
}

export interface PetCommandResult {
  /** Markdown pushed into the chat as a system message. */
  system: string
}

/** Injection seams, mirroring `PetAccessDeps`; both default to the live pet. */
export interface PetCommandDeps {
  /** May the pet act in this webview right now, and if not, why. */
  availability?: () => PetAvailability | Promise<PetAvailability>
  /** Drive one interaction through the access gate. */
  interact?: (kind: PetInteractionKind) => Promise<PetAccessResult>
}

// Reached lazily: the gate pulls the settings store and the plugin rate
// limiter, which the parse-only paths of this module never need.
async function liveAvailability(): Promise<PetAvailability> {
  const [{ resolveLivePetAvailability }, { useSettingsStore }, { DEFAULT_PET_SETTINGS }] =
    await Promise.all([
      import("@/lib/pet/access/availability"),
      import("@/stores/settings"),
      import("@/types/pet"),
    ])
  // Read exactly the way the gate's `readEnabled` does, so the two never
  // disagree about an unset setting.
  const pet = useSettingsStore.getState().settings?.petSettings ?? DEFAULT_PET_SETTINGS
  return resolveLivePetAvailability(pet.enabled)
}

async function liveInteract(kind: PetInteractionKind): Promise<PetAccessResult> {
  const { requestPetInteraction } = await import("@/lib/pet/access/gate")
  return requestPetInteraction({ kind: "user" }, kind)
}

const SWITCHED_OFF_INTERACTION =
  "💤 Your pet is switched off. Turn it on in **Settings → Pet** (or summon it from the tray), then try again."

/** Structural refusals: nothing the user can toggle here would change them. */
function structuralRefusal(reason: Exclude<PetUnavailableReason, "disabled">): string {
  switch (reason) {
    case "unsupported-host":
      return "🖥️ The pet lives in the Cognia desktop app. Open the desktop app to check on it or care for it."
    case "secondary-window":
      return "The pet can only be cared for from the main Cognia window."
  }
}

function refusalMessage(refusal: PetRefusal): string {
  switch (refusal.code) {
    case "unavailable":
      return refusal.reason === "disabled"
        ? SWITCHED_OFF_INTERACTION
        : structuralRefusal(refusal.reason)
    case "rate-limited":
      return "Too many pet actions in a row — give it a moment."
    case "kind-not-allowed":
      return `\`${refusal.kind}\` is not a pet action.`
    case "unknown-item":
    case "item-not-owned":
      return `Your pet doesn't have \`${refusal.itemId}\`.`
  }
}

/** Parse the arg string into a subcommand; empty → status, unknown → error. */
export function parsePetArgs(args: string): { sub: PetSubcommand } | { error: string } {
  const head = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (!head || head === "status") return { sub: "status" }
  if (head in INTERACTION_EVENT_BY_SUB) return { sub: head as PetSubcommand }
  return {
    error: `Unknown subcommand \`${head}\`. Usage: \`/pet <status | feed | play | pet | sleep | clean | treat>\``,
  }
}

async function commandStatus(now: number, switchedOff: boolean): Promise<PetCommandResult> {
  const profile = await getPetProfile()
  if (!profile) {
    return {
      system: "No pet yet — the pet hatches once the widget is enabled (Settings → Pet).",
    }
  }
  if (!profile.soul) {
    return {
      system: "🥚 Your pet is still an egg — open the `/pet` console to hatch it.",
    }
  }
  const view = computePetView(profile, null, now)
  const progress = levelProgress(profile.xp)
  const lines = [
    `### ${profile.soul.name}`,
    "",
    `- **Stage**: ${profile.stage} · **Level** ${progress.level} (${progress.intoLevel}/${progress.span} XP)`,
    `- **Needs**: energy ${Math.round(view.needs.energy)} · mood ${Math.round(view.needs.mood)} · bond ${Math.round(view.needs.bond)}`,
    `- **Condition**: ${view.condition === "unwell" ? "🤒 unwell — needs care" : "✅ well"}`,
  ]
  if (typeof profile.coins === "number") {
    lines.push(`- **Coins**: ${Math.floor(profile.coins)}`)
  }
  if (profile.streak && profile.streak.days > 0) {
    lines.push(`- **Care streak**: ${profile.streak.days} day(s)`)
  }
  if (switchedOff) {
    lines.push(
      "",
      "_The pet is switched off — nothing reacts until you turn it on in **Settings → Pet**._"
    )
  }
  return { system: lines.join("\n") }
}

/**
 * Dispatch a parsed `/pet` invocation.
 *
 * Every answer is one the pet can stand behind: a host that cannot run the pet
 * says so before any profile is read, a switched-off pet shows its record but
 * refuses care, an egg points at the console, and an action still cooling is
 * refused with the wait instead of being confirmed and then dropped by the
 * controller. The cooldown read is advisory (the controller stays the
 * authority, and its refusal bubble covers a tap that races this check).
 */
export async function dispatchPetSubcommand(
  args: string,
  now: number = Date.now(),
  deps: PetCommandDeps = {}
): Promise<PetCommandResult> {
  const parsed = parsePetArgs(args)
  if ("error" in parsed) return { system: parsed.error }

  const availability = await (deps.availability ?? liveAvailability)()
  if (!availability.available && availability.reason !== "disabled") {
    return { system: structuralRefusal(availability.reason) }
  }
  const switchedOff = !availability.available

  if (parsed.sub === "status") return await commandStatus(now, switchedOff)
  if (switchedOff) return { system: SWITCHED_OFF_INTERACTION }

  const profile = await getPetProfile()
  if (!profile?.soul) {
    return { system: "🥚 Your pet hasn't hatched yet — open the `/pet` console to hatch it first." }
  }
  const kind = INTERACTION_EVENT_BY_SUB[parsed.sub]!
  const waitMs = remainingCooldownMs(normalizeInteractionGate(profile.interactionGate), kind, now)
  if (waitMs > 0) {
    return {
      system: `⏳ Your pet is still enjoying the last one — try \`/pet ${parsed.sub}\` again in ${Math.ceil(waitMs / 1000)}s.`,
    }
  }

  const result = await (deps.interact ?? liveInteract)(kind)
  if (!result.ok) return { system: refusalMessage(result.refusal) }
  return { system: INTERACTION_CONFIRMATION[parsed.sub]! }
}
