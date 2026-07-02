import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("@/hooks/pet/use-pet")
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (s: (x: unknown) => unknown) => s({ settings: settingsValue }),
}))

// Live2D model probe — default: no model, core not ready → effective skin "svg".
const useActiveLive2dModel = jest.fn(() => ({
  modelId: undefined as string | undefined,
  row: undefined,
  coreReady: false as boolean | undefined,
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Capture renderer props (also intercepts NurtureTab's hero renderer — same module).
const rendererProps = jest.fn()
jest.mock("../pet-renderer", () => ({
  PetRenderer: (props: unknown) => {
    rendererProps(props)
    return <div data-testid="pet-renderer-stub" />
  },
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: () => null }))
const hatchPet = jest.fn().mockResolvedValue(undefined)
const emitPetEvent = jest.fn()
const renamePet = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/pet/runtime/init-pet", () => ({ hatchPet: () => hatchPet() }))
jest.mock("@/lib/pet/events/pet-event-bus", () => ({ emitPetEvent: () => emitPetEvent() }))
jest.mock("@/lib/pet/runtime/rename-pet", () => ({
  renamePet: (name: string) => renamePet(name),
  sanitizePetName: (s: string) => s.trim(),
  isValidPetName: (s: string) => s.trim().length > 0,
  MAX_PET_NAME: 24,
}))
jest.mock("./dex-tab", () => ({ DexTab: () => <div data-testid="tab-dex" /> }))
jest.mock("./shop-tab", () => ({ ShopTab: () => <div data-testid="tab-shop" /> }))

// Plugin slot host — controllable "has extensions" flag + a stub mount.
let hasPluginExtensions = false
const slotProps = jest.fn()
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  usePluginSlotHasExtensions: () => hasPluginExtensions,
  PluginExtensionSlot: (props: unknown) => {
    slotProps(props)
    return <div data-testid="pet-plugin-slot" />
  },
}))
jest.mock("./achievements-tab", () => ({ AchievementsTab: () => <div data-testid="tab-ach" /> }))
jest.mock("./binding-tab", () => ({ BindingTab: () => <div data-testid="tab-bind" /> }))

import { usePet } from "@/hooks/pet/use-pet"
import { PetConsole } from "./pet-console"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"

const mockUsePet = usePet as jest.Mock

function petResult(soul: PetProfile["soul"]) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul,
    stage: soul ? "baby" : "egg",
  }
  return {
    profile,
    view: computePetView(profile, null, 0),
    loading: false,
    feed: jest.fn(),
    play: jest.fn(),
    petStroke: jest.fn(),
    talk: jest.fn(),
  }
}

beforeEach(() => {
  mockUsePet.mockReset()
  hatchPet.mockClear()
  emitPetEvent.mockClear()
  renamePet.mockClear()
  rendererProps.mockClear()
  slotProps.mockClear()
  hasPluginExtensions = false
  settingsValue = {}
  useActiveLive2dModel.mockReset()
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
})

describe("PetConsole", () => {
  it("shows loading until the pet is ready", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toBeInTheDocument()
  })

  it("offers a hatch action for an unhatched egg", async () => {
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-hatch")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch|console\.hatch/i }))
    })
    expect(hatchPet).toHaveBeenCalled()
    expect(emitPetEvent).toHaveBeenCalled()
  })

  it("shows the nurture layout for a hatched pet and switches tabs", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-nurture-tab")).toBeInTheDocument()
    const clickTab = (id: string) =>
      fireEvent.click(document.querySelector(`[data-tab="${id}"]`) as Element)
    clickTab("shop")
    expect(screen.getByTestId("tab-shop")).toBeInTheDocument()
    clickTab("dex")
    expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
    clickTab("achievements")
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
    clickTab("binding")
    expect(screen.getByTestId("tab-bind")).toBeInTheDocument()
  })

  it("resolves the effective skin and passes it to the header renderer and nurture tab", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    // Header hero + nurture-tab hero both go through the mocked renderer.
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "live2d" }))
    expect(rendererProps).not.toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
  })

  it("falls back to the svg skin when the Live2D core is not ready", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    settingsValue = { petSettings: { skinId: "live2d" } }
    render(<PetConsole />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ skinId: "svg" }))
  })

  it("hides the plugins tab until a pet.console.tab extension registers", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(document.querySelector('[data-tab="plugins"]')).toBeNull()
  })

  it("shows the plugins tab and mounts the slot with the safe context bag", () => {
    hasPluginExtensions = true
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.click(document.querySelector('[data-tab="plugins"]') as Element)
    expect(screen.getByTestId("pet-plugin-slot")).toBeInTheDocument()
    expect(slotProps).toHaveBeenCalledWith(
      expect.objectContaining({
        point: "pet.console.tab",
        context: expect.objectContaining({
          level: expect.any(Number),
          stage: "baby",
          mood: expect.any(String),
          condition: expect.any(String),
        }),
      })
    )
  })

  it("renames the pet from the header editor", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    fireEvent.click(screen.getByLabelText(/rename|pet\.rename\.edit/i))
    const input = screen.getByLabelText(/pet name|pet\.rename\.label/i)
    fireEvent.change(input, { target: { value: "Mochi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(renamePet).toHaveBeenCalledWith("Mochi")
  })
})
