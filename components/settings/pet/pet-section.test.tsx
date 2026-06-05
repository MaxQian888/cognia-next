import { render, screen, fireEvent } from "@testing-library/react"

const save = jest.fn()
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: settingsValue, save }),
}))
const resetPet = jest.fn()
jest.mock("@/lib/db/pet", () => ({ resetPet: () => resetPet() }))

let coreAvailable: boolean | undefined = true
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useCubismCoreAvailable: () => coreAvailable,
}))

// Desktop-pet block is gated on Tauri. `var` (not `let`): lib/tauri's transport
// picker calls isTauri() while the import graph is still evaluating, so only a
// hoisted `var` is reachable from the mock factory at that point.
// eslint-disable-next-line no-var
var mockTauri = true
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockTauri,
}))

const openPetWindow = jest.fn().mockResolvedValue(true)
const destroyPetWindow = jest.fn().mockResolvedValue(true)
const setPetClickThrough = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  openPetWindow: (...a: unknown[]) => openPetWindow(...a),
  destroyPetWindow: () => destroyPetWindow(),
  setPetClickThrough: (v: boolean) => setPetClickThrough(v),
}))

// Stub the model manager — its own suite covers it; here we only assert it mounts.
jest.mock("./pet-model-manager", () => ({
  PetModelManager: () => <div data-testid="pet-model-manager" />,
}))

import { PetSection } from "./pet-section"

beforeEach(() => {
  save.mockClear()
  resetPet.mockClear()
  openPetWindow.mockClear()
  destroyPetWindow.mockClear()
  setPetClickThrough.mockClear()
  mockTauri = true
  coreAvailable = true
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
})

describe("PetSection", () => {
  it("toggles the enabled switch through save()", () => {
    render(<PetSection />)
    fireEvent.click(screen.getByRole("switch", { name: /enable|enabled\.label/i }))
    expect(save).toHaveBeenCalledWith({ petSettings: expect.objectContaining({ enabled: false }) })
  })

  it("changes the anchor", () => {
    render(<PetSection />)
    const anchor = document.getElementById("pet-anchor") as HTMLSelectElement
    fireEvent.change(anchor, { target: { value: "top-left" } })
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ anchor: "top-left" }),
    })
  })

  it("resets the pet", () => {
    render(<PetSection />)
    fireEvent.click(screen.getByRole("button", { name: /reset|reset\.action/i }))
    expect(resetPet).toHaveBeenCalled()
  })

  it("falls back to defaults when petSettings is absent", () => {
    settingsValue = {}
    render(<PetSection />)
    // default enabled=true → toggling sends enabled:false
    fireEvent.click(screen.getByRole("switch", { name: /enable|enabled\.label/i }))
    expect(save).toHaveBeenCalledWith({ petSettings: expect.objectContaining({ enabled: false }) })
  })

  it("changes the skin and mounts the model manager for live2d", () => {
    render(<PetSection />)
    const skin = document.getElementById("pet-skin") as HTMLSelectElement
    fireEvent.change(skin, { target: { value: "live2d" } })
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ skinId: "live2d" }),
    })
  })

  it("shows the model manager when the live2d skin is selected", () => {
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        skinId: "live2d",
      },
    }
    render(<PetSection />)
    expect(screen.getByTestId("pet-model-manager")).toBeInTheDocument()
  })

  it("warns when the live2d skin is selected but the core is missing", () => {
    coreAvailable = false
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        skinId: "live2d",
      },
    }
    render(<PetSection />)
    expect(screen.getByText(/runtime isn't ready/i)).toBeInTheDocument()
  })

  it("hides the manager for the svg skin", () => {
    render(<PetSection />)
    expect(screen.queryByTestId("pet-model-manager")).toBeNull()
  })

  describe("desktop pet block", () => {
    it("is hidden off Tauri", () => {
      mockTauri = false
      render(<PetSection />)
      expect(screen.queryByLabelText(/Desktop pet/i)).toBeNull()
    })

    it("enabling opens the overlay window and persists desktopPet.enabled", () => {
      render(<PetSection />)
      const sw = document.getElementById("pet-desktop-enabled") as HTMLButtonElement
      fireEvent.click(sw)
      expect(openPetWindow).toHaveBeenCalledWith(
        expect.objectContaining({ width: 128 + 96, height: 128 + 160, clickThrough: false })
      )
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ enabled: true }),
        }),
      })
    })

    it("disabling destroys the overlay window and persists disabled", () => {
      settingsValue = {
        petSettings: {
          enabled: true,
          anchor: "bottom-right",
          motion: "auto",
          mutedBubbles: false,
          size: 96,
          skinId: "svg",
          desktopPet: { enabled: true, clickThrough: false, size: 128, position: null },
        },
      }
      render(<PetSection />)
      const sw = document.getElementById("pet-desktop-enabled") as HTMLButtonElement
      fireEvent.click(sw)
      expect(destroyPetWindow).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ enabled: false }),
        }),
      })
    })

    it("click-through switch toggles the OS flag and persists", () => {
      render(<PetSection />)
      const sw = document.getElementById("pet-desktop-clickthrough") as HTMLButtonElement
      fireEvent.click(sw)
      expect(setPetClickThrough).toHaveBeenCalledWith(true)
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ clickThrough: true }),
        }),
      })
    })

    it("the overlay size slider patches desktopPet.size", () => {
      render(<PetSection />)
      // The desktop-pet block renders a second slider after the widget size one.
      const sliders = screen.getAllByRole("slider")
      fireEvent.keyDown(sliders[sliders.length - 1], { key: "ArrowRight" })
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ size: expect.any(Number) }),
        }),
      })
    })
  })

  it("toggles low-power mode through save()", () => {
    render(<PetSection />)
    fireEvent.click(document.getElementById("pet-low-power") as HTMLButtonElement)
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ lowPower: true }),
    })
  })

  describe("wander block", () => {
    const withDesktopEnabled = (wander?: unknown) => {
      settingsValue = {
        petSettings: {
          enabled: true,
          anchor: "bottom-right",
          motion: "auto",
          mutedBubbles: false,
          size: 96,
          skinId: "svg",
          desktopPet: { enabled: true, clickThrough: false, size: 128, position: null, wander },
        },
      }
    }

    it("is hidden while the desktop pet is disabled", () => {
      render(<PetSection />)
      expect(screen.queryByTestId("pet-wander-block")).toBeNull()
    })

    it("enables wandering (defaults applied for legacy settings without a wander block)", () => {
      withDesktopEnabled(undefined)
      render(<PetSection />)
      fireEvent.click(document.getElementById("pet-wander-enabled") as HTMLButtonElement)
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({
            wander: expect.objectContaining({
              enabled: true,
              frequency: "normal",
              range: "full",
              onlyAfterInteraction: false,
            }),
          }),
        }),
      })
    })

    it("changes the frequency and range", () => {
      withDesktopEnabled({
        enabled: true,
        frequency: "normal",
        onlyAfterInteraction: false,
        range: "full",
      })
      render(<PetSection />)
      fireEvent.change(document.getElementById("pet-wander-frequency") as HTMLSelectElement, {
        target: { value: "lively" },
      })
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({
            wander: expect.objectContaining({ frequency: "lively" }),
          }),
        }),
      })
      fireEvent.change(document.getElementById("pet-wander-range") as HTMLSelectElement, {
        target: { value: "near" },
      })
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({
            wander: expect.objectContaining({ range: "near" }),
          }),
        }),
      })
    })

    it("toggles only-after-interaction", () => {
      withDesktopEnabled({
        enabled: true,
        frequency: "normal",
        onlyAfterInteraction: false,
        range: "full",
      })
      render(<PetSection />)
      fireEvent.click(document.getElementById("pet-wander-after-interaction") as HTMLButtonElement)
      expect(save).toHaveBeenCalledWith({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({
            wander: expect.objectContaining({ onlyAfterInteraction: true }),
          }),
        }),
      })
    })
  })
})
