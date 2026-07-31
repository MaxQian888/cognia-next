import { render, screen, fireEvent } from "@testing-library/react"
import { DexTab } from "./dex-tab"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import type { PetBones } from "@/types/pet"

// Live2D model list (reactive) + settings store + core-readiness probe.
let mockModels: Array<{ id: string; name: string }> = []
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mockModels }))

const save = jest.fn()
let settingsValue: unknown = { petSettings: { skinId: "svg" } }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: settingsValue, save }),
}))

const useActiveLive2dModel = jest.fn(() => ({
  modelId: undefined as string | undefined,
  row: undefined,
  coreReady: undefined as boolean | undefined,
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Stub the renderer — this tab's job is the gallery layout + picker wiring, not
// pixel output (and it keeps the in-use card from pulling the live2d lazy chunk).
jest.mock("../pet-renderer", () => ({
  PetRenderer: () => <div data-testid="pet-renderer-stub" />,
}))

const bones: PetBones = {
  species: "cat",
  rarity: "rare",
  stars: 3,
  eyes: "dot",
  hat: "beanie",
  shiny: false,
  bodyType: "round",
  palette: { primary: "#a", secondary: "#b", accent: "#c" },
  stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
}

beforeEach(() => {
  save.mockClear()
  mockModels = []
  settingsValue = { petSettings: { skinId: "svg" } }
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: undefined })
})

describe("DexTab", () => {
  it("renders every species and marks the owned one", () => {
    render(<DexTab bones={bones} />)
    expect(screen.getByTestId("pet-dex").querySelectorAll("[data-owned]")).toHaveLength(
      ALL_PET_SPECIES.length
    )
    expect(document.querySelector('[data-owned][data-species="cat"]')).toHaveAttribute(
      "data-owned",
      "true"
    )
    expect(document.querySelector('[data-owned][data-species="owl"]')).toHaveAttribute(
      "data-owned",
      "false"
    )
  })

  it("shows an empty state when no Live2D models are imported", () => {
    render(<DexTab bones={bones} />)
    expect(screen.getByTestId("pet-dex-live2d")).toHaveTextContent(/no live2d models yet/i)
  })

  it("lists imported models and picks one as the active pet on tap", () => {
    mockModels = [
      { id: "m1", name: "Mochi" },
      { id: "m2", name: "Hiyori" },
    ]
    render(<DexTab bones={bones} />)
    expect(document.querySelectorAll("[data-model]")).toHaveLength(2)
    fireEvent.click(document.querySelector('[data-model="m2"]') as Element)
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ skinId: "live2d", activeLive2dModelId: "m2" }),
    })
  })

  it("marks the in-use model and reverts to the built-in mascot", () => {
    mockModels = [{ id: "m1", name: "Mochi" }]
    settingsValue = { petSettings: { skinId: "live2d", activeLive2dModelId: "m1" } }
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    render(<DexTab bones={bones} />)
    expect(document.querySelector('[data-model="m1"]')).toHaveAttribute("data-in-use", "true")
    fireEvent.click(screen.getByRole("button", { name: /use built-in mascot/i }))
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ skinId: "svg" }),
    })
  })
})
