// Action handler for the `/pet` slash command.
//
// Surface (7 subcommands):
//   /pet | /pet status   — push a status card (name, stage, level, needs, care)
//   /pet feed|play|pet|sleep|clean|treat — emit the matching care interaction
//
// The interactions reuse the exact same event path as the widget buttons /
// unified commands (`emitPetEvent({source:"user", kind})`), so XP, needs
// restore, cooldown-free spam handling, and achievements all stay owned by the
// pet controller. Output is chat-facing markdown (English, like the sibling
// /goal and /status commands).

import { getPetProfile } from "@/lib/db/pet"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { levelProgress } from "@/lib/pet/xp/leveling"
import type { PetEventKind } from "@/types/pet"

export type PetSubcommand = "status" | "feed" | "play" | "pet" | "sleep" | "clean" | "treat"

const INTERACTION_EVENT_BY_SUB: Partial<Record<PetSubcommand, PetEventKind>> = {
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

/** Parse the arg string into a subcommand; empty → status, unknown → error. */
export function parsePetArgs(args: string): { sub: PetSubcommand } | { error: string } {
  const head = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (!head || head === "status") return { sub: "status" }
  if (head in INTERACTION_EVENT_BY_SUB) return { sub: head as PetSubcommand }
  return {
    error: `Unknown subcommand \`${head}\`. Usage: \`/pet <status | feed | play | pet | sleep | clean | treat>\``,
  }
}

async function commandStatus(now: number): Promise<PetCommandResult> {
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
  return { system: lines.join("\n") }
}

/**
 * Dispatch a parsed `/pet` invocation. Interactions require a hatched pet so
 * users get feedback instead of silently feeding an egg.
 */
export async function dispatchPetSubcommand(
  args: string,
  now: number = Date.now()
): Promise<PetCommandResult> {
  const parsed = parsePetArgs(args)
  if ("error" in parsed) return { system: parsed.error }
  if (parsed.sub === "status") return await commandStatus(now)

  const profile = await getPetProfile()
  if (!profile?.soul) {
    return { system: "🥚 Your pet hasn't hatched yet — open the `/pet` console to hatch it first." }
  }
  const kind = INTERACTION_EVENT_BY_SUB[parsed.sub]!
  emitPetEvent({ source: "user", kind })
  return { system: INTERACTION_CONFIRMATION[parsed.sub]! }
}
