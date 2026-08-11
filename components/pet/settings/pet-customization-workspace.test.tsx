import { fireEvent, render, screen } from "@testing-library/react"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

const save = jest.fn()
let mockLive2dValue: Record<string, unknown> = {
  modelId: undefined,
  row: undefined,
  coreReady: false,
}
let mockSpriteValue: Record<string, unknown> = { packId: undefined, row: undefined }
let mockPetValue: Record<string, unknown> = { profile: null, view: null }
let settingsValue: unknown = {
  petSettings: {
    enabled: true,
    anchor: "bottom-right",
    motion: "auto",
    mutedBubbles: false,
    size: 96,
    skinId: "svg",
  },
}

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: settingsValue, save }),
}))

const resetPet = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/db/pet", () => ({ resetPet: () => resetPet() }))

jest.mock("@/hooks/pet/use-pet", () => ({
  usePet: () => mockPetValue,
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => mockLive2dValue,
  useCubismCoreAvailable: () => false,
}))
jest.mock("@/hooks/pet/use-active-sprite-pack", () => ({
  useActiveSpritePack: () => mockSpriteValue,
}))

jest.mock("./pet-cosmetic-controls", () => ({
  PetCosmeticControls: () => <div data-testid="cosmetic-controls" />,
}))
jest.mock("./pet-live2d-look-controls", () => ({
  PetLive2dLookControls: () => <div data-testid="live2d-look-controls" />,
}))
jest.mock("./pet-appearance-controls", () => ({
  PetAppearanceControls: ({ patch }: { patch: (next: unknown) => void }) => (
    <button type="button" data-testid="appearance-controls" onClick={() => patch({ size: 112 })} />
  ),
}))
jest.mock("./pet-interaction-controls", () => ({
  PetInteractionControls: () => <div data-testid="interaction-controls" />,
}))
jest.mock("./pet-sound-controls", () => ({
  PetSoundControls: () => <div data-testid="sound-controls" />,
}))
jest.mock("./pet-care-controls", () => ({
  PetCareControls: () => <div data-testid="care-controls" />,
}))
jest.mock("./pet-twin-awareness-controls", () => ({
  PetTwinAwarenessControls: () => <div data-testid="twin-controls" />,
}))
jest.mock("./pet-desktop-controls", () => ({
  PetDesktopControls: () => <div data-testid="desktop-controls" />,
}))
jest.mock("@/components/platform/capability-gate", () => ({
  CapabilityGate: ({ children }: { children: React.ReactNode }) => children,
}))

import { PetCustomizationWorkspace } from "./pet-customization-workspace"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"

describe("PetCustomizationWorkspace", () => {
  beforeEach(() => {
    save.mockClear()
    resetPet.mockClear()
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        skinId: "svg",
      },
    }
    mockLive2dValue = { modelId: undefined, row: undefined, coreReady: false }
    mockSpriteValue = { packId: undefined, row: undefined }
    mockPetValue = { profile: null, view: null }
    getPetSkinRuntime().invalidateAsset("live2d:m1")
  })

  it("renders every existing customization capability in one flat workspace", () => {
    render(<PetCustomizationWorkspace />)

    expect(screen.getByTestId("pet-customization-workspace")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: /enabled\.label|enable/i })).toBeInTheDocument()
    for (const testId of [
      "cosmetic-controls",
      "appearance-controls",
      "interaction-controls",
      "sound-controls",
      "care-controls",
      "twin-controls",
      "desktop-controls",
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
  })

  it("merges patches over current settings through the shared save path", () => {
    render(<PetCustomizationWorkspace />)
    fireEvent.click(screen.getByTestId("appearance-controls"))
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ enabled: true, size: 112 }),
    })
  })

  it("requires confirmation before resetting the pet profile", () => {
    render(<PetCustomizationWorkspace />)
    fireEvent.click(screen.getByRole("button", { name: /reset\.action|reset/i }))
    expect(resetPet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /reset pet profile|reset\.confirm/i }))
    expect(resetPet).toHaveBeenCalledTimes(1)
  })

  it("offers a working retry for a recoverable preview runtime failure", () => {
    settingsValue = { petSettings: { ...DEFAULT_PET_SETTINGS, skinId: "live2d" } }
    mockLive2dValue = {
      modelId: "m1",
      row: { id: "m1", compatibility: { status: "valid", diagnostics: [] } },
      coreReady: true,
    }
    const runtime = getPetSkinRuntime()
    runtime.recordContextLoss("live2d:m1")
    runtime.recordContextLoss("live2d:m1")

    render(<PetCustomizationWorkspace />)
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(runtime.assetDiagnostic("live2d:m1")).toBeUndefined()
  })
})
