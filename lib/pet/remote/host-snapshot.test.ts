jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: null }) },
}))
jest.mock("@/lib/db/pet", () => ({ getPetProfile: jest.fn(async () => undefined) }))

import { createDefaultProfile } from "@/lib/pet/defaults"
import { DEFAULT_PET_SETTINGS, type PetProfile, type PetSettings } from "@/types/pet"
import {
  buildPetRemoteSnapshot,
  projectPetPresentation,
  projectRemotePetSummary,
  readHostPetSettings,
  resolveHostPetAvailability,
} from "./host-snapshot"

const NOW = Date.UTC(2026, 9, 9, 12)

function hatchedProfile(overrides: Partial<PetProfile> = {}): PetProfile {
  return {
    ...createDefaultProfile("acct-1", NOW - 60_000),
    soul: { name: "Mochi", personality: "curious", hatchDate: new Date(NOW).toISOString() },
    ...overrides,
  } as PetProfile
}

const enabled: PetSettings = { ...DEFAULT_PET_SETTINGS, enabled: true }

describe("resolveHostPetAvailability", () => {
  it("answers headless-host on a headless brain, whatever the settings say", () => {
    expect(
      resolveHostPetAvailability({ platform: "headless", getPetSettings: () => enabled })
    ).toEqual({ available: false, reason: "headless-host" })
  })

  it("reports the access predicate's reason when the pet may not act", () => {
    expect(
      resolveHostPetAvailability({
        platform: "tauri",
        role: "main",
        getPetSettings: () => ({ ...enabled, enabled: false }),
        isControllerPresent: () => true,
      })
    ).toEqual({ available: false, reason: "disabled" })
  })

  it("is host-starting until the controller subscribes", () => {
    const deps = {
      platform: "tauri" as const,
      role: "main" as const,
      getPetSettings: () => enabled,
    }
    expect(resolveHostPetAvailability({ ...deps, isControllerPresent: () => false })).toEqual({
      available: false,
      reason: "host-starting",
    })
    expect(resolveHostPetAvailability({ ...deps, isControllerPresent: () => true })).toEqual({
      available: true,
    })
  })
})

describe("projectRemotePetSummary", () => {
  it("adds the streak multiplier and per-action cooldowns on the host clock", () => {
    const summary = projectRemotePetSummary(
      hatchedProfile({
        coins: 7,
        streak: { days: 7, lastDay: "2026-10-09" },
        interactionGate: { lastAtByKind: { fed: NOW - 500, slept: NOW - 10_000 } },
      }),
      NOW
    )
    expect(summary.name).toBe("Mochi")
    expect(summary.coins).toBe(7)
    expect(summary.streak).toEqual({ days: 7, lastDay: "2026-10-09", multiplier: 1.5 })
    expect(summary.cooldowns.fed).toBe(1000)
    expect(summary.cooldowns.slept).toBe(0)
    expect(summary.cooldowns.talked).toBe(0)
    // The PII-safe projection: no fingerprint, no bones, no personality.
    expect(JSON.stringify(summary)).not.toContain("acct-1")
    expect(JSON.stringify(summary)).not.toContain("curious")
  })
})

describe("projectPetPresentation", () => {
  it("offers chat only with LLM speak on and a hatched pet", () => {
    const withSpeak: PetSettings = {
      ...enabled,
      skinId: "live2d",
      desktopPet: { ...(enabled.desktopPet ?? {}), enabled: true } as PetSettings["desktopPet"],
      llmSpeak: { enabled: true } as PetSettings["llmSpeak"],
    }
    expect(projectPetPresentation(withSpeak, true)).toEqual({
      requestedSkinId: "live2d",
      desktopVisible: true,
      llmSpeakEnabled: true,
      chatEnabled: true,
    })
    expect(projectPetPresentation(withSpeak, false).chatEnabled).toBe(false)
    expect(projectPetPresentation(enabled, true)).toMatchObject({
      requestedSkinId: "svg",
      desktopVisible: false,
      llmSpeakEnabled: false,
      chatEnabled: false,
    })
  })
})

describe("buildPetRemoteSnapshot", () => {
  it("answers a pet-less snapshot on a headless brain", async () => {
    const getProfile = jest.fn()
    await expect(
      buildPetRemoteSnapshot({ platform: "headless", now: () => NOW, getProfile })
    ).resolves.toEqual({
      availability: { available: false, reason: "headless-host" },
      summary: null,
      presentation: null,
      hostTime: NOW,
    })
    expect(getProfile).not.toHaveBeenCalled()
  })

  it("reads the desktop pet", async () => {
    const snapshot = await buildPetRemoteSnapshot({
      platform: "tauri",
      role: "main",
      now: () => NOW,
      getPetSettings: () => enabled,
      isControllerPresent: () => true,
      getProfile: async () => hatchedProfile(),
    })
    expect(snapshot.availability).toEqual({ available: true })
    expect(snapshot.summary?.hatched).toBe(true)
    expect(snapshot.presentation?.requestedSkinId).toBe("svg")
    expect(snapshot.hostTime).toBe(NOW)
  })

  it("has no summary before the host has a profile", async () => {
    const snapshot = await buildPetRemoteSnapshot({
      platform: "tauri",
      role: "main",
      now: () => NOW,
      getPetSettings: () => enabled,
      isControllerPresent: () => true,
      getProfile: async () => undefined,
    })
    expect(snapshot.summary).toBeNull()
  })

  it("falls back to the default pet settings when the store has none", () => {
    expect(readHostPetSettings()).toBe(DEFAULT_PET_SETTINGS)
  })
})
