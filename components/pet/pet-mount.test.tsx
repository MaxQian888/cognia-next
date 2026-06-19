import { render } from "@testing-library/react"

const usePetEventBus = jest.fn()
const ensurePetAccountId = jest.fn().mockResolvedValue("acct-1")
const ensurePetProfile = jest.fn().mockResolvedValue(undefined)
const useActiveCharacterId = jest.fn<string | undefined, []>()
const petWidgetProps = jest.fn()
const getPetWindowRole = jest.fn<"main" | "overlay" | "popup" | "web", []>()
const isTauri = jest.fn<boolean, []>()
const startMainPetBridge = jest.fn<() => void, []>()
const mainBridgeDispose = jest.fn()

jest.mock("@/hooks/pet/use-pet-event-bus", () => ({
  usePetEventBus: (e: boolean) => usePetEventBus(e),
}))
jest.mock("@/hooks/pet/use-active-character-id", () => ({
  useActiveCharacterId: () => useActiveCharacterId(),
}))
jest.mock("@/lib/pet/bones/account-id", () => ({ ensurePetAccountId: () => ensurePetAccountId() }))
jest.mock("@/lib/pet/runtime/init-pet", () => ({ ensurePetProfile: () => ensurePetProfile() }))
jest.mock("@/lib/pet/window-role", () => ({ getPetWindowRole: () => getPetWindowRole() }))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => isTauri() }))
jest.mock("@/lib/pet/events/cross-window-bridge", () => ({
  startMainPetBridge: () => startMainPetBridge(),
}))
jest.mock("./pet-widget", () => ({
  PetWidget: (props: unknown) => {
    petWidgetProps(props)
    return <div data-testid="pet-widget" />
  },
}))

let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: settingsValue, save: jest.fn() }),
}))

import { PetMount } from "./pet-mount"

beforeEach(() => {
  usePetEventBus.mockClear()
  ensurePetAccountId.mockClear()
  ensurePetProfile.mockClear()
  useActiveCharacterId.mockReset()
  useActiveCharacterId.mockReturnValue(undefined)
  petWidgetProps.mockClear()
  getPetWindowRole.mockReset()
  getPetWindowRole.mockReturnValue("main")
  isTauri.mockReset()
  isTauri.mockReturnValue(false)
  startMainPetBridge.mockReset()
  mainBridgeDispose.mockReset()
  startMainPetBridge.mockReturnValue(mainBridgeDispose)
})

const ENABLED_SETTINGS = {
  petSettings: {
    enabled: true,
    anchor: "bottom-right",
    motion: "auto",
    mutedBubbles: false,
    size: 96,
  },
}

describe("PetMount", () => {
  it("renders nothing and stays disabled when pet is off", () => {
    settingsValue = {
      petSettings: {
        enabled: false,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    const { container } = render(<PetMount />)
    expect(container.firstChild).toBeNull()
    expect(usePetEventBus).toHaveBeenCalledWith(false)
  })

  it("renders the widget and initializes when enabled", () => {
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    const { getByTestId } = render(<PetMount />)
    expect(getByTestId("pet-widget")).toBeInTheDocument()
    expect(usePetEventBus).toHaveBeenCalledWith(true)
  })

  it("threads the active character id into the widget", () => {
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    useActiveCharacterId.mockReturnValue("char-7")
    render(<PetMount />)
    expect(petWidgetProps).toHaveBeenCalledWith(
      expect.objectContaining({ activeCharacterId: "char-7" })
    )
  })

  it("defaults settings when petSettings is absent", () => {
    settingsValue = {}
    render(<PetMount />)
    expect(usePetEventBus).toHaveBeenCalledWith(true) // DEFAULT_PET_SETTINGS.enabled
  })

  it("renders nothing and disables the controller in the overlay window role", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("overlay")
    const { container } = render(<PetMount />)
    expect(container.firstChild).toBeNull()
    // Controller (event bus) stays off so XP is never double-awarded.
    expect(usePetEventBus).toHaveBeenCalledWith(false)
    expect(ensurePetAccountId).not.toHaveBeenCalled()
    expect(startMainPetBridge).not.toHaveBeenCalled()
  })

  it("renders nothing and disables the controller in the popup window role", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("popup")
    isTauri.mockReturnValue(true)
    const { container } = render(<PetMount />)
    expect(container.firstChild).toBeNull()
    // The click popup is a secondary window: no controller, no second bridge,
    // so XP is never double-awarded.
    expect(usePetEventBus).toHaveBeenCalledWith(false)
    expect(ensurePetAccountId).not.toHaveBeenCalled()
    expect(startMainPetBridge).not.toHaveBeenCalled()
  })

  it("does not start the main bridge off Tauri", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(false)
    render(<PetMount />)
    expect(startMainPetBridge).not.toHaveBeenCalled()
  })

  it("starts the main bridge in the main window under Tauri and disposes on unmount", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    const { unmount } = render(<PetMount />)
    expect(startMainPetBridge).toHaveBeenCalledTimes(1)
    unmount()
    expect(mainBridgeDispose).toHaveBeenCalledTimes(1)
  })

  it("does not start the bridge when pet is disabled", () => {
    settingsValue = {
      petSettings: {
        enabled: false,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    render(<PetMount />)
    expect(startMainPetBridge).not.toHaveBeenCalled()
  })
})
