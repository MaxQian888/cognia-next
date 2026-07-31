import { render, screen, fireEvent } from "@testing-library/react"

const openPetWindow = jest.fn().mockResolvedValue(true)
const destroyPetWindow = jest.fn().mockResolvedValue(true)
const setPetClickThrough = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  openPetWindow: (...a: unknown[]) => openPetWindow(...a),
  destroyPetWindow: () => destroyPetWindow(),
  setPetClickThrough: (v: boolean) => setPetClickThrough(v),
}))

let mockIsLinux = false
jest.mock("@/lib/tauri/os", () => ({ isLinuxPlatform: () => mockIsLinux }))

import { PetDesktopControls } from "./pet-desktop-controls"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

beforeEach(() => {
  openPetWindow.mockClear()
  destroyPetWindow.mockClear()
  setPetClickThrough.mockClear()
  mockIsLinux = false
})

const withDesktop = (desktopPet: PetSettings["desktopPet"]): PetSettings => ({
  ...DEFAULT_PET_SETTINGS,
  desktopPet,
})

describe("PetDesktopControls", () => {
  it("links to the shortcuts settings section to configure the toggle hotkey", () => {
    render(<PetDesktopControls pet={DEFAULT_PET_SETTINGS} patch={jest.fn()} />)
    const link = screen.getByRole("link", { name: /configure a global hotkey/i })
    expect(link).toHaveAttribute("href", "/settings?section=shortcuts")
  })

  it("enabling opens the overlay window and persists the flag", () => {
    const patch = jest.fn()
    render(<PetDesktopControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.click(document.getElementById("pet-desktop-enabled") as HTMLButtonElement)
    expect(openPetWindow).toHaveBeenCalled()
    expect(patch).toHaveBeenCalledWith({
      desktopPet: expect.objectContaining({ enabled: true }),
    })
  })

  it("opens the overlay at the saved position when one exists", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({
          enabled: false,
          clickThrough: true,
          size: 160,
          position: { x: 40, y: 60 },
        })}
        patch={jest.fn()}
      />
    )
    fireEvent.click(document.getElementById("pet-desktop-enabled") as HTMLButtonElement)
    expect(openPetWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 40, y: 60, clickThrough: true })
    )
  })

  it("disabling destroys the overlay window", () => {
    const patch = jest.fn()
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={patch}
      />
    )
    fireEvent.click(document.getElementById("pet-desktop-enabled") as HTMLButtonElement)
    expect(destroyPetWindow).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith({
      desktopPet: expect.objectContaining({ enabled: false }),
    })
  })

  it("click-through toggles the OS flag; wander block shows when enabled", () => {
    const patch = jest.fn()
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={patch}
      />
    )
    fireEvent.click(document.getElementById("pet-desktop-clickthrough") as HTMLButtonElement)
    expect(setPetClickThrough).toHaveBeenCalledWith(true)
    fireEvent.click(document.getElementById("pet-wander-enabled") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({
      desktopPet: expect.objectContaining({
        wander: expect.objectContaining({ enabled: true }),
      }),
    })
  })

  it("edits the overlay size and every wander control", () => {
    const patch = jest.fn()
    render(
      <PetDesktopControls
        pet={withDesktop({
          enabled: true,
          clickThrough: false,
          size: 128,
          position: null,
          wander: {
            enabled: true,
            frequency: "normal",
            range: "full",
            onlyAfterInteraction: false,
            climbWindows: false,
          },
        })}
        patch={patch}
      />
    )
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "ArrowRight" })
    expect(patch).toHaveBeenCalledWith({
      desktopPet: expect.objectContaining({ size: expect.any(Number) }),
    })
    fireEvent.change(document.getElementById("pet-wander-frequency") as HTMLSelectElement, {
      target: { value: "lively" },
    })
    fireEvent.change(document.getElementById("pet-wander-range") as HTMLSelectElement, {
      target: { value: "near" },
    })
    fireEvent.click(document.getElementById("pet-wander-after-interaction") as HTMLButtonElement)
    fireEvent.click(document.getElementById("pet-wander-climb") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({
      desktopPet: expect.objectContaining({
        wander: expect.objectContaining({ frequency: "lively" }),
      }),
    })
    expect(patch).toHaveBeenCalledWith({
      desktopPet: expect.objectContaining({
        wander: expect.objectContaining({ climbWindows: true }),
      }),
    })
  })

  it("disables the climb-windows toggle on Linux with an explanatory hint", () => {
    mockIsLinux = true
    render(
      <PetDesktopControls
        pet={withDesktop({
          enabled: true,
          clickThrough: false,
          size: 128,
          position: null,
          wander: {
            enabled: true,
            frequency: "normal",
            range: "full",
            onlyAfterInteraction: false,
            climbWindows: true,
          },
        })}
        patch={jest.fn()}
      />
    )
    const toggle = document.getElementById("pet-wander-climb") as HTMLButtonElement
    expect(toggle).toBeDisabled()
    // Forced off in the UI regardless of the persisted value, since it can't
    // actually run on this platform.
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    expect(screen.getByText(/not available on linux/i)).toBeInTheDocument()
  })

  it("enables the climb-windows toggle on Windows/macOS", () => {
    mockIsLinux = false
    render(
      <PetDesktopControls
        pet={withDesktop({
          enabled: true,
          clickThrough: false,
          size: 128,
          position: null,
          wander: {
            enabled: true,
            frequency: "normal",
            range: "full",
            onlyAfterInteraction: false,
            climbWindows: false,
          },
        })}
        patch={jest.fn()}
      />
    )
    const toggle = document.getElementById("pet-wander-climb") as HTMLButtonElement
    expect(toggle).not.toBeDisabled()
    expect(screen.queryByText(/not available on linux/i)).toBeNull()
  })
})
