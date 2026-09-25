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
  // The access gate resolves availability from the platform too.
  detectPlatform: () => (mockIsTauriValue ? "tauri" : "web"),
}))

const save = jest.fn()
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: settingsValue, save }) },
}))

import {
  openDesktopPetWindow,
  PET_INTERACTION_COMMAND_IDS,
  PET_WINDOW_COMMAND_ID,
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
  openPetWindow.mockReset().mockResolvedValue(true)
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

  it("closing hides the window but never switches the pet off", async () => {
    isPetWindowOpen.mockResolvedValue(true)
    await toggleDesktopPetWindow()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].petSettings.enabled).toBe(true)
  })
})

describe("openDesktopPetWindow (summon ⇒ enable, ADR-0058 D9)", () => {
  // `save` mirrors the real store: the next `getState()` sees what was saved.
  beforeEach(() => {
    save.mockImplementation(async (patch: { petSettings: unknown }) => {
      settingsValue = { ...(settingsValue as object), petSettings: patch.petSettings }
    })
  })

  it("switches a disabled pet on BEFORE opening, without touching desktopPet yet", async () => {
    isPetWindowOpen.mockResolvedValue(false)
    settingsValue = {
      petSettings: { enabled: false, desktopPet: { enabled: false, clickThrough: false } },
    }
    const result = await openDesktopPetWindow()
    expect(result).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    // Phase 1: only the master switch, so PetMount's cold-start reconcile
    // cannot race this call into a second open.
    expect(save.mock.calls[0][0].petSettings).toMatchObject({
      enabled: true,
      desktopPet: { enabled: false },
    })
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(openPetWindow.mock.invocationCallOrder[0])
    // Phase 2: both flags, after the window exists.
    expect(save.mock.calls[1][0].petSettings).toMatchObject({
      enabled: true,
      desktopPet: { enabled: true },
    })
    expect(openPetWindow.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[1])
  })

  it("saves once when the pet is already on", async () => {
    isPetWindowOpen.mockResolvedValue(false)
    await openDesktopPetWindow()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].petSettings).toMatchObject({
      enabled: true,
      desktopPet: { enabled: true },
    })
  })

  it("switches the pet on without re-opening a window that is already there", async () => {
    isPetWindowOpen.mockResolvedValue(true)
    settingsValue = { petSettings: { enabled: false } }
    expect(await openDesktopPetWindow()).toBe(true)
    expect(openPetWindow).not.toHaveBeenCalled()
    expect((settingsValue as { petSettings: { enabled: boolean } }).petSettings.enabled).toBe(true)
  })

  it("does not persist desktopPet.enabled for a window that failed to open", async () => {
    isPetWindowOpen.mockResolvedValue(false)
    openPetWindow.mockResolvedValue(false)
    settingsValue = { petSettings: { enabled: false, desktopPet: { enabled: false } } }
    expect(await openDesktopPetWindow()).toBe(false)
    const saved = (settingsValue as { petSettings: { desktopPet: { enabled: boolean } } })
      .petSettings
    expect(saved.desktopPet.enabled).toBe(false)
  })

  it("persists from the store's latest state, not the snapshot it started with", async () => {
    // The native `pet://state-changed` echo lands between the two phases and
    // saves its own patch; phase 2 must build on it rather than clobber it.
    isPetWindowOpen.mockResolvedValue(false)
    settingsValue = { petSettings: { enabled: true, mutedBubbles: false } }
    openPetWindow.mockImplementation(async () => {
      settingsValue = { petSettings: { enabled: true, mutedBubbles: true } }
      return true
    })
    await openDesktopPetWindow()
    expect(save.mock.calls.at(-1)![0].petSettings).toMatchObject({
      mutedBubbles: true,
      desktopPet: { enabled: true },
    })
  })

  it("is a no-op off Tauri", async () => {
    mockIsTauriValue = false
    expect(await openDesktopPetWindow()).toBe(false)
    expect(save).not.toHaveBeenCalled()
  })
})

describe("registerPetCommands", () => {
  it("registers the seven pet commands under the Pet category", () => {
    registerPetCommands()
    const ids = registerCommand.mock.calls.map(([reg]) => reg.id)
    expect(ids).toEqual([
      "pet.toggle-window",
      "pet.feed",
      "pet.play",
      "pet.pet",
      "pet.sleep",
      "pet.clean",
      "pet.treat",
    ])
    for (const [reg] of registerCommand.mock.calls) {
      expect(reg.pluginId).toBeNull()
      expect(reg.category).toBe("Pet")
    }
  })

  it("interaction command handlers emit the matching interaction event", () => {
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
    byId["pet.sleep"]()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "slept" })
    byId["pet.clean"]()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "cleaned" })
    byId["pet.treat"]()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "treated" })
  })

  it("refuses the interaction when the pet is switched off", async () => {
    // The regression pin: a chord bound to pet.feed used to reach the bus with
    // no checks at all, so a hotkey could nurture a pet the user had disabled.
    settingsValue = { petSettings: { enabled: false } }
    registerPetCommands()
    const feed = registerCommand.mock.calls.find((c) => c[0].id === "pet.feed")![0]
    await feed.handler()
    expect(emitPetEvent).not.toHaveBeenCalled()
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

  it("forwards localized titles to both registrations", () => {
    registerPetCommands({ windowTitle: "切换桌宠", titles: { "pet.feed": "喂宠物" } })
    const byId = Object.fromEntries(registerCommand.mock.calls.map(([reg]) => [reg.id, reg.title]))
    expect(byId["pet.toggle-window"]).toBe("切换桌宠")
    expect(byId["pet.feed"]).toBe("喂宠物")
  })

  it("returns a dispose function that unregisters all seven commands", () => {
    const disposeFns = Array.from({ length: 7 }, () => jest.fn())
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

  it("takes a localized title, falling back to English without one", () => {
    registerPetWindowCommand({ title: "切换桌宠" })
    registerPetWindowCommand()
    expect(registerCommand.mock.calls.map(([reg]) => reg.title)).toEqual([
      "切换桌宠",
      "Toggle desktop pet",
    ])
    expect(registerCommand.mock.calls[0][0].id).toBe(PET_WINDOW_COMMAND_ID)
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
  it("registers all six interaction commands, without the window toggle", () => {
    registerPetInteractionCommands()
    const ids = registerCommand.mock.calls.map(([reg]) => reg.id)
    expect(ids).toEqual(["pet.feed", "pet.play", "pet.pet", "pet.sleep", "pet.clean", "pet.treat"])
    // The exported id list is what the shortcut sheet offers; it must be the
    // exact set that is registered, in the same order.
    expect(ids).toEqual([...PET_INTERACTION_COMMAND_IDS])
  })

  it("uses the localized titles it is given and English for the rest", () => {
    registerPetInteractionCommands({ titles: { "pet.feed": "喂宠物" } })
    const byId = Object.fromEntries(registerCommand.mock.calls.map(([reg]) => [reg.id, reg.title]))
    expect(byId["pet.feed"]).toBe("喂宠物")
    expect(byId["pet.play"]).toBe("Play with the pet")
  })

  it("reports a refusal, so a chord pressed while the pet is off gets an answer", async () => {
    settingsValue = { petSettings: { enabled: false } }
    const onRefused = jest.fn()
    registerPetInteractionCommands({ onRefused })
    const feed = registerCommand.mock.calls.find(([reg]) => reg.id === "pet.feed")![0]
    const result = await feed.handler()
    expect(result).toEqual({ ok: false, refusal: { code: "unavailable", reason: "disabled" } })
    expect(onRefused).toHaveBeenCalledWith("fed", { code: "unavailable", reason: "disabled" })
    expect(emitPetEvent).not.toHaveBeenCalled()
  })

  it("stays quiet on success", async () => {
    const onRefused = jest.fn()
    registerPetInteractionCommands({ onRefused })
    const play = registerCommand.mock.calls.find(([reg]) => reg.id === "pet.play")![0]
    const result = await play.handler()
    expect(result).toMatchObject({ ok: true })
    expect(onRefused).not.toHaveBeenCalled()
    expect(emitPetEvent).toHaveBeenCalledWith({ source: "user", kind: "played" })
  })

  it("returns a dispose function that unregisters the six commands", () => {
    const disposeFns = Array.from({ length: 6 }, () => jest.fn())
    let call = 0
    registerCommand.mockImplementation(() => disposeFns[call++])
    registerPetInteractionCommands()()
    for (const fn of disposeFns) expect(fn).toHaveBeenCalledTimes(1)
  })
})
