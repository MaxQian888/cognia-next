// The live snapshot a paired device reads with `pet_get` (ADR-0219).
//
// The phone also mirrors the pet tables through companion sync, but a mirror
// is only as fresh as its last pull, and three things a care UI needs are not
// in any table: whether the host would accept an action at all (the pet may
// be off, or the desktop still booting), how long each action is still cooling
// down on the HOST clock, and the presentation flags that live in settings.
// This is the one place those are answered.
//
// Built on `projectPetSummary`, the same PII-safe projection plugins and the
// agent see: the account fingerprint, raw bones and the soul's personality
// never leave the host through this path.

import type { PetProfile, PetSettings } from "@/types/pet"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS, normalizeStreak } from "@/types/pet"
import type { Platform } from "@/lib/platform/detect"
import { detectPlatform } from "@/lib/platform/detect"
import type { PetWindowRole } from "@/lib/pet/window-role"
import { resolveLivePetAvailability } from "@/lib/pet/access/availability"
import { PET_INTERACTION_KINDS } from "@/lib/pet/access/limits"
import { projectPetSummary } from "@/lib/pet/access/summary"
import { coinMultiplier } from "@/lib/pet/economy/streak"
import { normalizeInteractionGate, remainingCooldownMs } from "@/lib/pet/interaction/gate"
import { isPetControllerPresent } from "@/lib/pet/runtime/controller-presence"
import { getPetProfile } from "@/lib/db/pet"
import { useSettingsStore } from "@/stores/settings"
import type {
  PetRemotePresentation,
  PetRemoteSnapshot,
  PetRemoteSummary,
  PetRemoteUnavailableReason,
} from "./types"

export interface PetHostSnapshotDeps {
  now?: () => number
  platform?: Platform
  role?: PetWindowRole
  getProfile?: () => Promise<PetProfile | undefined>
  getPetSettings?: () => PetSettings
  isControllerPresent?: () => boolean
}

/** The host's pet settings, from the live store the renderer already holds. */
export function readHostPetSettings(): PetSettings {
  return useSettingsStore.getState().settings?.petSettings ?? DEFAULT_PET_SETTINGS
}

/**
 * Whether the host would run a care action right now, and if not, why.
 *
 * The availability predicate is the one `PetMount` and the access gate use,
 * so the phone is told exactly what a hotkey on the desktop would be told.
 * A pet that is available but has no controller subscribed yet is
 * `host-starting`: an event emitted now would reach nobody.
 */
export function resolveHostPetAvailability(
  deps: PetHostSnapshotDeps = {}
): PetRemoteSnapshot["availability"] {
  const platform = deps.platform ?? detectPlatform()
  if (platform === "headless") return { available: false, reason: "headless-host" }
  const settings = (deps.getPetSettings ?? readHostPetSettings)()
  const availability = resolveLivePetAvailability(settings.enabled, {
    platform,
    ...(deps.role ? { role: deps.role } : {}),
  })
  if (!availability.available) return availability
  if (!(deps.isControllerPresent ?? isPetControllerPresent)()) {
    return { available: false, reason: "host-starting" satisfies PetRemoteUnavailableReason }
  }
  return { available: true }
}

/** The outside-facing summary plus the care-loop fields a remote UI needs. */
export function projectRemotePetSummary(profile: PetProfile, now: number): PetRemoteSummary {
  const gate = normalizeInteractionGate(profile.interactionGate)
  const streak = normalizeStreak(profile.streak)
  const cooldowns: Record<string, number> = {}
  for (const kind of PET_INTERACTION_KINDS) {
    cooldowns[kind] = remainingCooldownMs(gate, kind, now)
  }
  return {
    ...projectPetSummary(profile, now),
    streak: { days: streak.days, lastDay: streak.lastDay, multiplier: coinMultiplier(streak.days) },
    cooldowns,
  }
}

export function projectPetPresentation(
  settings: PetSettings,
  hatched: boolean
): PetRemotePresentation {
  const llmSpeakEnabled = settings.llmSpeak?.enabled === true
  return {
    requestedSkinId: settings.skinId ?? "svg",
    desktopVisible: (settings.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY).enabled === true,
    llmSpeakEnabled,
    // `respondAsPet` degrades to `disabled` without both, so a phone that
    // offered the composer anyway would only ever collect that degrade.
    chatEnabled: llmSpeakEnabled && hatched,
  }
}

export async function buildPetRemoteSnapshot(
  deps: PetHostSnapshotDeps = {}
): Promise<PetRemoteSnapshot> {
  const now = (deps.now ?? Date.now)()
  const platform = deps.platform ?? detectPlatform()
  if (platform === "headless") {
    // A headless brain installs the same desktop-write source, and the
    // companion bridge prefers it when connected. It has no pet, no pet
    // settings and no controller, so it answers this and nothing more.
    return {
      availability: { available: false, reason: "headless-host" },
      summary: null,
      presentation: null,
      hostTime: now,
    }
  }
  const settings = (deps.getPetSettings ?? readHostPetSettings)()
  const availability = resolveHostPetAvailability({
    ...deps,
    platform,
    getPetSettings: () => settings,
  })
  const profile = await (deps.getProfile ?? getPetProfile)()
  return {
    availability,
    summary: profile ? projectRemotePetSummary(profile, now) : null,
    presentation: projectPetPresentation(settings, Boolean(profile?.soul)),
    hostTime: now,
  }
}
