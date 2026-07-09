import { render, screen, fireEvent } from "@testing-library/react"

const save = jest.fn()
let settingsValue: unknown = { petSettings: { enabled: true, anchor: "bottom-right", size: 96 } }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: settingsValue, save }),
}))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => true }))

// Live2D probe drives the effective-skin resolution + the Look-card branch.
const useActiveLive2dModel = jest.fn(() => ({
  modelId: undefined as string | undefined,
  row: undefined,
  coreReady: undefined as boolean | undefined,
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Mock the leaf controls; the customize tab's job is composition + the shared
// save() path, which we assert via the appearance control's injected patch.
jest.mock("../settings/pet-appearance-controls", () => ({
  PetAppearanceControls: ({ patch }: { patch: (n: unknown) => void }) => (
    <button data-testid="appearance" onClick={() => patch({ anchor: "top-left" })} />
  ),
}))
jest.mock("../settings/pet-cosmetic-controls", () => ({
  PetCosmeticControls: () => <div data-testid="cosmetic" />,
}))
jest.mock("../settings/pet-live2d-look-controls", () => ({
  PetLive2dLookControls: () => <div data-testid="live2d-look" />,
}))
jest.mock("../settings/pet-interaction-controls", () => ({
  PetInteractionControls: () => <div data-testid="interaction" />,
}))
jest.mock("../settings/pet-sound-controls", () => ({
  PetSoundControls: () => <div data-testid="sound" />,
}))
jest.mock("../settings/pet-care-controls", () => ({
  PetCareControls: () => <div data-testid="care" />,
}))
jest.mock("../settings/pet-desktop-controls", () => ({
  PetDesktopControls: () => <div data-testid="desktop" />,
}))

import { CustomizeTab } from "./customize-tab"

beforeEach(() => {
  save.mockClear()
  settingsValue = { petSettings: { enabled: true, anchor: "bottom-right", size: 96 } }
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: undefined })
})

describe("CustomizeTab", () => {
  it("composes every control group and links to full settings", () => {
    render(<CustomizeTab />)
    for (const id of ["cosmetic", "appearance", "interaction", "sound", "care", "desktop"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.getByRole("link", { name: /full pet settings/i })).toHaveAttribute(
      "href",
      "/settings?section=pet"
    )
  })

  it("swaps the Look card for the Live2D panel when the Live2D skin is chosen", () => {
    settingsValue = { petSettings: { enabled: true, skinId: "live2d" } }
    render(<CustomizeTab />)
    expect(screen.getByTestId("live2d-look")).toBeInTheDocument()
    expect(screen.queryByTestId("cosmetic")).toBeNull()
  })

  it("routes a control patch through save({ petSettings }) merged over current", () => {
    render(<CustomizeTab />)
    fireEvent.click(screen.getByTestId("appearance"))
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ enabled: true, anchor: "top-left" }),
    })
  })

  it("falls back to default settings when petSettings is absent", () => {
    settingsValue = {}
    render(<CustomizeTab />)
    fireEvent.click(screen.getByTestId("appearance"))
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ anchor: "top-left" }),
    })
  })
})
