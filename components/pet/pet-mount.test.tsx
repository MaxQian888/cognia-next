import { render, waitFor } from "@testing-library/react"

const usePetEventBus = jest.fn()
const ensurePetAccountId = jest.fn().mockResolvedValue("acct-1")
const ensurePetProfile = jest.fn().mockResolvedValue(undefined)
const useActiveCharacterId = jest.fn<string | undefined, []>()
const petWidgetProps = jest.fn()
const getPetWindowRole = jest.fn<"main" | "overlay" | "popup" | "web", []>()
const isTauri = jest.fn<boolean, []>()
const usePlatform = jest.fn<"tauri" | "mobile" | "web", []>()
const startMainPetBridge = jest.fn<() => void, [unknown?]>()
const mainBridgeDispose = jest.fn()
const registerPetWindowCommand = jest.fn<() => void, []>()
const registerPetInteractionCommands = jest.fn<() => void, []>()
const windowCommandDispose = jest.fn()
const interactionCommandsDispose = jest.fn()
const openPetWindow = jest.fn().mockResolvedValue(true)
const isPetWindowOpen = jest.fn().mockResolvedValue(false)
const setPetClickThrough = jest.fn().mockResolvedValue(true)

jest.mock("@/hooks/pet/use-pet-event-bus", () => ({
  usePetEventBus: (e: boolean, twinAwareness: unknown) => usePetEventBus(e, twinAwareness),
}))
jest.mock("@/lib/pet/commands", () => ({
  registerPetWindowCommand: () => registerPetWindowCommand(),
  registerPetInteractionCommands: () => registerPetInteractionCommands(),
}))
jest.mock("@/hooks/pet/use-active-character-id", () => ({
  useActiveCharacterId: () => useActiveCharacterId(),
}))
jest.mock("@/lib/pet/bones/account-id", () => ({ ensurePetAccountId: () => ensurePetAccountId() }))
jest.mock("@/lib/pet/runtime/init-pet", () => ({ ensurePetProfile: () => ensurePetProfile() }))
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => getPetWindowRole(),
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island",
}))
jest.mock("@/lib/platform/detect", () => ({ isTauri: () => isTauri() }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => usePlatform() }))
// Mocked at the module boundary: the real module pulls in `@/lib/tauri`,
// whose transport probe calls the mocked `isTauri()` at import time (TDZ).
const onPetNativeStateChanged = jest.fn((_handler: unknown) => () => {})
jest.mock("@/lib/tauri/pet-window", () => ({
  onPetNativeStateChanged: (handler: unknown) => onPetNativeStateChanged(handler),
  openPetWindow: (opts: unknown) => openPetWindow(opts),
  isPetWindowOpen: () => isPetWindowOpen(),
  setPetClickThrough: (ignore: boolean) => setPetClickThrough(ignore),
}))
jest.mock("@/lib/pet/events/cross-window-bridge", () => ({
  startMainPetBridge: (deps: unknown) => startMainPetBridge(deps),
}))
const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))
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
  usePlatform.mockReset()
  usePlatform.mockReturnValue("web")
  startMainPetBridge.mockReset()
  mainBridgeDispose.mockReset()
  startMainPetBridge.mockReturnValue(mainBridgeDispose)
  registerPetWindowCommand.mockReset()
  registerPetInteractionCommands.mockReset()
  windowCommandDispose.mockReset()
  interactionCommandsDispose.mockReset()
  openPetWindow.mockClear()
  setPetClickThrough.mockClear()
  isPetWindowOpen.mockReset()
  isPetWindowOpen.mockResolvedValue(false)
  registerPetWindowCommand.mockReturnValue(windowCommandDispose)
  registerPetInteractionCommands.mockReturnValue(interactionCommandsDispose)
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
    expect(usePetEventBus).toHaveBeenCalledWith(false, undefined)
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
    expect(usePetEventBus).toHaveBeenCalledWith(true, undefined)
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
    expect(usePetEventBus).toHaveBeenCalledWith(true, undefined) // DEFAULT_PET_SETTINGS.enabled
  })

  it("renders nothing and disables the controller in the overlay window role", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("overlay")
    const { container } = render(<PetMount />)
    expect(container.firstChild).toBeNull()
    // Controller (event bus) stays off so XP is never double-awarded.
    expect(usePetEventBus).toHaveBeenCalledWith(false, undefined)
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
    expect(usePetEventBus).toHaveBeenCalledWith(false, undefined)
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

  it("restores a persisted desktop-pet window when the Tauri main window starts", async () => {
    settingsValue = {
      petSettings: {
        ...ENABLED_SETTINGS.petSettings,
        desktopPet: {
          enabled: true,
          clickThrough: true,
          size: 160,
          position: { x: 120, y: 240 },
        },
      },
    }
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)

    render(<PetMount />)

    await waitFor(() => {
      expect(isPetWindowOpen).toHaveBeenCalled()
      expect(openPetWindow).toHaveBeenCalledWith({
        width: 256,
        height: 320,
        x: 120,
        y: 240,
        clickThrough: true,
      })
    })
  })

  it("never re-opens an already-visible desktop-pet window", async () => {
    // The native existing-window branch reveals + raises the panel, so
    // re-opening on a settings write would order the overlay to the front and
    // restart its animation loops for no reason.
    settingsValue = {
      petSettings: {
        ...ENABLED_SETTINGS.petSettings,
        desktopPet: { enabled: true, clickThrough: false, size: 128, position: null },
      },
    }
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    isPetWindowOpen.mockResolvedValue(true)

    render(<PetMount />)

    await waitFor(() => expect(isPetWindowOpen).toHaveBeenCalled())
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("reconciles click-through on an already-visible window without raising it", async () => {
    settingsValue = {
      petSettings: {
        ...ENABLED_SETTINGS.petSettings,
        desktopPet: { enabled: true, clickThrough: true, size: 128, position: null },
      },
    }
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    isPetWindowOpen.mockResolvedValue(true)

    render(<PetMount />)

    await waitFor(() => expect(setPetClickThrough).toHaveBeenCalledWith(true))
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("does not restore the desktop-pet window after the mount is disposed", async () => {
    settingsValue = {
      petSettings: {
        ...ENABLED_SETTINGS.petSettings,
        desktopPet: { enabled: true, clickThrough: false, size: 128, position: null },
      },
    }
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    let resolveProbe!: (open: boolean) => void
    isPetWindowOpen.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve
      })
    )

    const { unmount } = render(<PetMount />)
    await waitFor(() => expect(isPetWindowOpen).toHaveBeenCalled())
    unmount()
    resolveProbe(false)
    await Promise.resolve()

    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("routes the popup's open-console request to /pet?tab=…", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    render(<PetMount />)
    const deps = startMainPetBridge.mock.calls[0][0] as {
      onOpenConsole?: (tab: string) => void
    }
    expect(deps.onOpenConsole).toBeDefined()
    deps.onOpenConsole?.("shop")
    expect(routerPush).toHaveBeenCalledWith("/pet?tab=shop")
  })

  it("registers the window + interaction commands while enabled on the main desktop window, disposing on unmount", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("main")
    isTauri.mockReturnValue(true)
    const { unmount } = render(<PetMount />)
    expect(registerPetWindowCommand).toHaveBeenCalledTimes(1)
    expect(registerPetInteractionCommands).toHaveBeenCalledTimes(1)
    unmount()
    expect(windowCommandDispose).toHaveBeenCalledTimes(1)
    expect(interactionCommandsDispose).toHaveBeenCalledTimes(1)
  })

  it("keeps the toggle-window command registered while disabled so its hotkey stays live", () => {
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
    // The window toggle stays reachable (the fix) but the interaction commands,
    // which need the running controller, do not register while disabled.
    expect(registerPetWindowCommand).toHaveBeenCalledTimes(1)
    expect(registerPetInteractionCommands).not.toHaveBeenCalled()
  })

  it("registers no pet commands on a secondary window or mobile", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("overlay")
    isTauri.mockReturnValue(true)
    render(<PetMount />)
    expect(registerPetWindowCommand).not.toHaveBeenCalled()
    expect(registerPetInteractionCommands).not.toHaveBeenCalled()
  })

  it("renders nothing and disables the controller on the Capacitor mobile shell", () => {
    settingsValue = ENABLED_SETTINGS
    getPetWindowRole.mockReturnValue("main")
    usePlatform.mockReturnValue("mobile")
    const { container } = render(<PetMount />)
    // The floating widget would cover bottom-right action buttons on mobile, so
    // the whole subsystem is excluded there (mirrors the Perf HUD).
    expect(container.firstChild).toBeNull()
    expect(usePetEventBus).toHaveBeenCalledWith(false, undefined)
    expect(ensurePetAccountId).not.toHaveBeenCalled()
    expect(startMainPetBridge).not.toHaveBeenCalled()
  })

  it("passes petSettings.twinAwareness through to the event bus", () => {
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        twinAwareness: { enabled: true, twinId: "tw_1" },
      },
    }
    render(<PetMount />)
    expect(usePetEventBus).toHaveBeenCalledWith(true, { enabled: true, twinId: "tw_1" })
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
