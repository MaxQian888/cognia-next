import { render, screen, fireEvent } from "@testing-library/react"

const openPetWindow = jest.fn().mockResolvedValue(true)
const destroyPetWindow = jest.fn().mockResolvedValue(true)
const setPetClickThrough = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  openPetWindow: (...a: unknown[]) => openPetWindow(...a),
  destroyPetWindow: () => destroyPetWindow(),
  setPetClickThrough: (v: boolean) => setPetClickThrough(v),
}))

import { PetDesktopControls } from "./pet-desktop-controls"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

beforeEach(() => {
  openPetWindow.mockClear()
  destroyPetWindow.mockClear()
  setPetClickThrough.mockClear()
})

const withDesktop = (desktopPet: PetSettings["desktopPet"]): PetSettings => ({
  ...DEFAULT_PET_SETTINGS,
  desktopPet,
})

describe("PetDesktopControls", () => {
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
})
