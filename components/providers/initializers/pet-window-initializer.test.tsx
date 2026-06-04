/**
 * @jest-environment jsdom
 */
import { render, act } from "@testing-library/react"

// Window role + platform gates. `var` (not `let`): lib/tauri's transport picker
// calls isTauri() while the import graph is still evaluating (logging → tauri),
// before a `let` would initialize, so only a hoisted `var` is reachable.
/* eslint-disable no-var */
var mockTauri = true
var mockRole: "main" | "overlay" | "web" = "main"
/* eslint-enable no-var */
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockTauri,
}))
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockRole,
}))

const openPetWindow = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  openPetWindow: (...a: unknown[]) => openPetWindow(...a),
}))

// In-memory settings store with a real subscribe/getState surface. The factory
// reads these lazily (inside getState/subscribe), so plain `let`s are fine.
type Settings = { petSettings?: { desktopPet?: Record<string, unknown> } } | null
let mockSettings: Settings = null
const mockListeners = new Set<(s: { settings: Settings }) => void>()
function setSettings(next: Settings) {
  mockSettings = next
  for (const fn of mockListeners) fn({ settings: mockSettings })
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: () => ({ settings: mockSettings }),
    subscribe: (fn: (s: { settings: Settings }) => void) => {
      mockListeners.add(fn)
      return () => mockListeners.delete(fn)
    },
  },
}))

import { PetWindowInitializer } from "./pet-window-initializer"

beforeEach(() => {
  openPetWindow.mockClear()
  mockTauri = true
  mockRole = "main"
  mockSettings = null
  mockListeners.clear()
})

describe("PetWindowInitializer", () => {
  it("opens the overlay when settings already have it enabled", () => {
    mockSettings = {
      petSettings: {
        desktopPet: { enabled: true, clickThrough: true, size: 128, position: { x: 5, y: 6 } },
      },
    }
    render(<PetWindowInitializer />)
    expect(openPetWindow).toHaveBeenCalledWith({
      width: 128 + 96,
      height: 128 + 160,
      x: 5,
      y: 6,
      clickThrough: true,
    })
  })

  it("waits for async hydration and opens on the first enabled snapshot", () => {
    render(<PetWindowInitializer />)
    expect(openPetWindow).not.toHaveBeenCalled()
    act(() => {
      setSettings({
        petSettings: {
          desktopPet: { enabled: true, clickThrough: false, size: 160, position: null },
        },
      })
    })
    expect(openPetWindow).toHaveBeenCalledWith(
      expect.objectContaining({ width: 160 + 96, height: 160 + 160, clickThrough: false })
    )
  })

  it("opens at most once even on repeated enabled snapshots", () => {
    mockSettings = {
      petSettings: { desktopPet: { enabled: true, clickThrough: false, size: 128 } },
    }
    render(<PetWindowInitializer />)
    act(() => {
      setSettings({
        petSettings: { desktopPet: { enabled: true, clickThrough: false, size: 128 } },
      })
    })
    expect(openPetWindow).toHaveBeenCalledTimes(1)
  })

  it("does nothing when desktopPet is disabled", () => {
    mockSettings = {
      petSettings: { desktopPet: { enabled: false, clickThrough: false, size: 128 } },
    }
    render(<PetWindowInitializer />)
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("does nothing when petSettings has no desktopPet block", () => {
    mockSettings = { petSettings: {} }
    render(<PetWindowInitializer />)
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("is inert off Tauri", () => {
    mockTauri = false
    mockSettings = {
      petSettings: { desktopPet: { enabled: true, clickThrough: false, size: 128 } },
    }
    render(<PetWindowInitializer />)
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("is inert in the overlay window itself", () => {
    mockRole = "overlay"
    mockSettings = {
      petSettings: { desktopPet: { enabled: true, clickThrough: false, size: 128 } },
    }
    render(<PetWindowInitializer />)
    expect(openPetWindow).not.toHaveBeenCalled()
  })

  it("falls back to the default overlay size when size is absent", () => {
    mockSettings = { petSettings: { desktopPet: { enabled: true, clickThrough: false } } }
    render(<PetWindowInitializer />)
    // DEFAULT_PET_DESKTOP_OVERLAY.size === 128
    expect(openPetWindow).toHaveBeenCalledWith(
      expect.objectContaining({ width: 128 + 96, height: 128 + 160 })
    )
  })

  it("defaults clickThrough to false when it is absent", () => {
    mockSettings = { petSettings: { desktopPet: { enabled: true, size: 128 } } }
    render(<PetWindowInitializer />)
    expect(openPetWindow).toHaveBeenCalledWith(
      expect.objectContaining({ clickThrough: false, x: undefined, y: undefined })
    )
  })
})
