const registerCommand = jest.fn()
jest.mock("@/lib/plugin/commands/registry", () => ({
  registerCommand: (reg: unknown) => registerCommand(reg),
}))

const emitPetEvent = jest.fn()
jest.mock("@/lib/pet/events/pet-event-bus", () => ({
  emitPetEvent: (e: unknown) => emitPetEvent(e),
}))

const closePetWindow = jest.fn()
const isPetWindowOpen = jest.fn()
const openPetWindow = jest.fn()
jest.mock("@/lib/tauri/pet-window", () => ({
  closePetWindow: () => closePetWindow(),
  isPetWindowOpen: () => isPetWindowOpen(),
  openPetWindow: (opts: unknown) => openPetWindow(opts),
}))

let mockIsTauriValue = true
jest.mock("@/lib/platform/detect", () => ({
  isTauri: () => mockIsTauriValue,
}))

const save = jest.fn()
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: settingsValue, save }) },
}))

import {
  registerPetCommands,
  registerPetInteractionCommands,
  registerPetWindowCommand,
  toggleDesktopPetWindow,
} from "./commands"

beforeEach(() => {
  registerCommand.mockReset()
  registerCommand.mockImplementation(() => jest.fn())
  emitPetEvent.mockClear()
  closePetWindow.mockReset()
  isPetWindowOpen.mockReset()
  openPetWindow.mockReset()
  mockIsTauriValue = true
  save.mockReset().mockResolvedValue(undefined)
  settingsValue = { petSettings: { enabled: true, anchor: "bottom-right", size: 96 } }
})

describe("toggleDesktopPetWindow", () => {
  it("is a no-op off Tauri", async () => {
    mockIsTauriValue = false
    const result = await toggleDesktopPetWindow()
    expect(result).toBe(false)
    expect(isPetWindowOpen).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it("closes and persists disabled when the window is open", async () => {
    isPetWindowOpen.mockResolvedValue(true)
    const result = await toggleDesktopPetWindow()
    expect(result).toBe(false)
    expect(closePetWindow).toHaveBeenCalledTimes(1)
    expect(openPetWindow).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ enabled: false }),
        }),
      })
    )
  })

  it("opens with the desktop-pet size/position/click-through and persists enabled", async () => {
    isPetWindowOpen.mockResolvedValue(false)
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        size: 96,
        desktopPet: { enabled: false, clickThrough: true, size: 160, position: { x: 5, y: 9 } },
      },
    }
    const result = await toggleDesktopPetWindow()
    expect(result).toBe(true)
    expect(openPetWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 5, y: 9, clickThrough: true })
    )
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ enabled: true }),
        }),
      })
    )
  })

  it("falls back to DEFAULT_PET_SETTINGS/DEFAULT_PET_DESKTOP_OVERLAY when unset", async () => {
    settingsValue = {}
    isPetWindowOpen.mockResolvedValue(false)
    await toggleDesktopPetWindow()
    expect(openPetWindow).toHaveBeenCalled()
  })
})

describe("registerPetCommands", () => {
  it("registers the four pet commands under the Pet category", () => {
    registerPetCommands()
    const ids = registerCommand.mock.calls.map(([reg]) => reg.id)
    expect(ids).toEqual(["pet.toggle-window", "pet.feed", "pet.play", "pet.pet"])
    for (const [reg] of registerCommand.mock.calls) {
      expect(reg.pluginId).toBeNull()
      expect(reg.category).toBe("Pet")
    }
  })

  it("pet.feed/play/pet handlers emit the matching interaction event", () => {
    registerPetCommands()
    const byId = Object.fromEntries(
      registerCommand.mock.calls.map(([reg]) => [reg.id, reg.handler])
    ) as Record<string, () => void>

    byId["pet.feed"]()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "fed" })
    byId["pet.play"]()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "played" })
    byId["pet.pet"]()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "petted" })
  })

  it("pet.toggle-window handler delegates to toggleDesktopPetWindow", async () => {
    isPetWindowOpen.mockResolvedValue(false)
    registerPetCommands()
    const toggleHandler = registerCommand.mock.calls.find(
      ([reg]) => reg.id === "pet.toggle-window"
    )![0].handler
    await toggleHandler()
    expect(openPetWindow).toHaveBeenCalledTimes(1)
  })

  it("returns a dispose function that unregisters all four commands", () => {
    const disposeFns = [jest.fn(), jest.fn(), jest.fn(), jest.fn()]
    let call = 0
    registerCommand.mockImplementation(() => disposeFns[call++])
    const disposeAll = registerPetCommands()
    disposeAll()
    for (const fn of disposeFns) expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe("registerPetWindowCommand", () => {
  it("registers only pet.toggle-window and disposes it", () => {
    const dispose = jest.fn()
    registerCommand.mockImplementation(() => dispose)
    const disposeWindow = registerPetWindowCommand()
    const ids = registerCommand.mock.calls.map(([reg]) => reg.id)
    expect(ids).toEqual(["pet.toggle-window"])
    disposeWindow()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("delegates to toggleDesktopPetWindow", async () => {
    isPetWindowOpen.mockResolvedValue(false)
    registerPetWindowCommand()
    const handler = registerCommand.mock.calls[0][0].handler as () => Promise<unknown>
    await handler()
    expect(openPetWindow).toHaveBeenCalledTimes(1)
  })
})

describe("registerPetInteractionCommands", () => {
  it("registers only feed/play/pet, without the window toggle", () => {
    registerPetInteractionCommands()
    const ids = registerCommand.mock.calls.map(([reg]) => reg.id)
    expect(ids).toEqual(["pet.feed", "pet.play", "pet.pet"])
  })

  it("returns a dispose function that unregisters the three commands", () => {
    const disposeFns = [jest.fn(), jest.fn(), jest.fn()]
    let call = 0
    registerCommand.mockImplementation(() => disposeFns[call++])
    registerPetInteractionCommands()()
    for (const fn of disposeFns) expect(fn).toHaveBeenCalledTimes(1)
  })
})
