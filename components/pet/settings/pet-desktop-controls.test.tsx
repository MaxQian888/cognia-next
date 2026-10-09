import { render, screen, fireEvent } from "@testing-library/react"

const openPetWindow = jest.fn().mockResolvedValue(true)
const destroyPetWindow = jest.fn().mockResolvedValue(true)
const setPetClickThrough = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  openPetWindow: (...a: unknown[]) => openPetWindow(...a),
  destroyPetWindow: () => destroyPetWindow(),
  setPetClickThrough: (v: boolean) => setPetClickThrough(v),
}))

// The summon path owns geometry, the master switch and persistence; its own
// suite (`lib/pet/commands.test.ts`) pins those. Here it only has to be THE
// path the switch takes.
const openDesktopPetWindow = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/pet/commands", () => ({
  openDesktopPetWindow: () => openDesktopPetWindow(),
}))

let mockIsLinux = false
jest.mock("@/lib/tauri/os", () => ({ isLinuxPlatform: () => mockIsLinux }))

// The cross-window writer, reduced to its contract: each nested patch is
// computed against the latest persisted desktop record (`persistedDesktop`
// stands in for Dexie) and the merged record is what gets written.
let persistedDesktop: Record<string, unknown> = {}
const desktopWrites: Record<string, unknown>[] = []
jest.mock("@/lib/pet/settings-sync", () => ({
  updateDesktopPetSettings: async (
    patch: (latest: Record<string, unknown>) => Record<string, unknown>
  ) => {
    persistedDesktop = { ...persistedDesktop, ...patch(persistedDesktop) }
    desktopWrites.push(persistedDesktop)
    return persistedDesktop
  },
}))

import { PetDesktopControls } from "./pet-desktop-controls"
import { DEFAULT_PET_SETTINGS, type PetSettings } from "@/types/pet"

beforeEach(() => {
  openPetWindow.mockClear()
  openDesktopPetWindow.mockClear()
  destroyPetWindow.mockClear()
  setPetClickThrough.mockClear()
  mockIsLinux = false
  persistedDesktop = {}
  desktopWrites.length = 0
})

/** Props AND the persisted record start from the same desktop settings. */
const withDesktop = (desktopPet: PetSettings["desktopPet"]): PetSettings => {
  persistedDesktop = { ...(desktopPet as unknown as Record<string, unknown>) }
  return { ...DEFAULT_PET_SETTINGS, desktopPet }
}

const WANDER = {
  enabled: true,
  frequency: "normal" as const,
  range: "full" as const,
  onlyAfterInteraction: false,
  climbWindows: false,
}

describe("PetDesktopControls", () => {
  it("links to the shortcuts settings section to configure the toggle hotkey", () => {
    render(<PetDesktopControls pet={DEFAULT_PET_SETTINGS} patch={jest.fn()} />)
    const link = screen.getByRole("link", { name: /configure a global hotkey/i })
    expect(link).toHaveAttribute("href", "/settings?section=shortcuts")
  })

  it("enabling summons through the single summon path, not a second opener", () => {
    const patch = jest.fn()
    render(<PetDesktopControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.click(document.getElementById("pet-desktop-enabled") as HTMLButtonElement)
    expect(openDesktopPetWindow).toHaveBeenCalledTimes(1)
    // A second persist here would race the summon's own ordered writes.
    expect(patch).not.toHaveBeenCalled()
    expect(desktopWrites).toHaveLength(0)
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("says which pet the desktop size slider sizes", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={jest.fn()}
      />
    )
    expect(screen.getByText(/floating desktop pet/i)).toBeInTheDocument()
  })

  it("disabling destroys the overlay window and records the intent", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={jest.fn()}
      />
    )
    fireEvent.click(document.getElementById("pet-desktop-enabled") as HTMLButtonElement)
    expect(destroyPetWindow).toHaveBeenCalledTimes(1)
    expect(desktopWrites.at(-1)).toEqual(expect.objectContaining({ enabled: false }))
  })

  it("click-through toggles the OS flag; wander block shows when enabled", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={jest.fn()}
      />
    )
    fireEvent.click(document.getElementById("pet-desktop-clickthrough") as HTMLButtonElement)
    expect(setPetClickThrough).toHaveBeenCalledWith(true)
    expect(desktopWrites.at(-1)).toEqual(expect.objectContaining({ clickThrough: true }))
    fireEvent.click(document.getElementById("pet-wander-enabled") as HTMLButtonElement)
    expect(desktopWrites.at(-1)).toEqual(
      expect.objectContaining({ wander: expect.objectContaining({ enabled: true }) })
    )
  })

  it("never reverts a position the overlay saved after this panel rendered", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={jest.fn()}
      />
    )
    // The overlay persisted its resting spot from its own window meanwhile.
    persistedDesktop = { ...persistedDesktop, position: { x: 640, y: 900 } }
    fireEvent.click(document.getElementById("pet-desktop-clickthrough") as HTMLButtonElement)
    expect(desktopWrites.at(-1)).toEqual(
      expect.objectContaining({ clickThrough: true, position: { x: 640, y: 900 } })
    )
  })

  it("edits the overlay size and every wander control, each on the fresh record", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({
          enabled: true,
          clickThrough: false,
          size: 128,
          position: null,
          wander: WANDER,
        })}
        patch={jest.fn()}
      />
    )
    // A keyboard step commits at once (Radix fires change + commit).
    fireEvent.keyDown(screen.getAllByRole("slider")[0], { key: "ArrowRight" })
    expect(desktopWrites.at(-1)).toEqual(expect.objectContaining({ size: 144 }))
    fireEvent.click(screen.getByRole("radio", { name: /lively/i }))
    fireEvent.click(screen.getByRole("radio", { name: /nearby|near/i }))
    fireEvent.click(document.getElementById("pet-wander-after-interaction") as HTMLButtonElement)
    fireEvent.click(document.getElementById("pet-wander-climb") as HTMLButtonElement)
    expect(desktopWrites.at(-1)).toEqual(
      expect.objectContaining({
        size: 144,
        wander: expect.objectContaining({
          frequency: "lively",
          range: "near",
          onlyAfterInteraction: true,
          climbWindows: true,
        }),
      })
    )
  })

  it("shows the size while dragging but persists only on release", () => {
    render(
      <PetDesktopControls
        pet={withDesktop({ enabled: true, clickThrough: false, size: 128, position: null })}
        patch={jest.fn()}
      />
    )
    const slider = screen.getAllByRole("slider")[0]
    // Pointer drags fire change per step and commit once on pointer-up; the
    // label follows the draft immediately.
    fireEvent.keyDown(slider, { key: "End" })
    expect(screen.getByText(/256px/)).toBeInTheDocument()
    expect(desktopWrites).toHaveLength(1)
    expect(desktopWrites[0]).toEqual(expect.objectContaining({ size: 256 }))
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
          wander: { ...WANDER, climbWindows: true },
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
          wander: WANDER,
        })}
        patch={jest.fn()}
      />
    )
    const toggle = document.getElementById("pet-wander-climb") as HTMLButtonElement
    expect(toggle).not.toBeDisabled()
    expect(screen.queryByText(/not available on linux/i)).toBeNull()
  })
})
