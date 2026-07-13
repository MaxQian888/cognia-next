import { render, act } from "@testing-library/react"

import { DesktopOnlyInitializers } from "./desktop-only-initializers"

// Replace every `next/dynamic(...)` call with the same lightweight stub so we
// can assert how many gated children get rendered without pulling the real
// desktop subsystem graphs into the test.
jest.mock("next/dynamic", () => () => {
  const Stub = () => <span data-testid="desktop-child" />
  Stub.displayName = "MockDesktopChild"
  return Stub
})

const isTauriMock = jest.fn()
jest.mock("@/lib/native/utils", () => ({
  isTauri: () => isTauriMock(),
}))

let mockPetRole: "main" | "web" | "overlay" | "popup" = "main"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockPetRole,
  isSecondaryOverlayRole: (role: string) =>
    role === "overlay" || role === "popup" || role === "island",
}))

describe("DesktopOnlyInitializers", () => {
  beforeEach(() => {
    isTauriMock.mockReset()
    mockPetRole = "main"
  })

  it("renders nothing on web (isTauri() === false)", async () => {
    isTauriMock.mockReturnValue(false)
    let container!: HTMLElement
    await act(async () => {
      container = render(<DesktopOnlyInitializers />).container
    })
    expect(container.querySelectorAll('[data-testid="desktop-child"]')).toHaveLength(0)
  })

  it("renders every desktop child once mounted on Tauri", async () => {
    isTauriMock.mockReturnValue(true)
    let container!: HTMLElement
    await act(async () => {
      container = render(<DesktopOnlyInitializers />).container
    })
    // Mirrors the count of gated children in the component — a guard against
    // silently dropping one when the list changes.
    expect(container.querySelectorAll('[data-testid="desktop-child"]')).toHaveLength(17)
  })

  it.each(["overlay", "popup"] as const)(
    "renders nothing in the %s pet window even on Tauri",
    async (role) => {
      isTauriMock.mockReturnValue(true)
      mockPetRole = role
      let container!: HTMLElement
      await act(async () => {
        container = render(<DesktopOnlyInitializers />).container
      })
      // The bundled initializers are all main-window concerns; the pet windows
      // must not run them (e.g. the character-pack fs scan the caps deny).
      expect(container.querySelectorAll('[data-testid="desktop-child"]')).toHaveLength(0)
    }
  )
})
